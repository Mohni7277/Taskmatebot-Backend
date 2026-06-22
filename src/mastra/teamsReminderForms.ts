/**
 * Teams Reminder Forms - Admin Reminder UI Components
 * Based on Telegram Bot's reminder implementation pattern
 */

import { 
  TurnContext, 
  MessageFactory, 
  CardFactory,
  ActivityTypes 
} from "botbuilder";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { hasReminderBeenSentRecently, storeNotificationLog } from "../botManager";

dotenv.config();

// Create a Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Interface for reminder session state
interface TeamsReminderSessionState {
  step: 'reminder_type' | 'reminder_user' | 'reminder_task' | 'reminder_custom_message' | 'reminder_schedule' | 'reminder_confirm';
  reminderData: {
    reminderType?: 'task' | 'custom';
    reminderUserId?: string;
    reminderUserName?: string;
    reminderUserEmail?: string;
    reminderTaskId?: string;
    reminderTaskTitle?: string;
    reminderCustomMessage?: string;
    reminderSchedule?: string;
    createdAt?: string;
    availableUsers?: any[];
    availableTasks?: any[];
    processing?: boolean; // Add processing flag to prevent duplicate submissions
  };
  userId?: string;
}

// Store user session data (in production, consider using Redis or database)
const teamsReminderSessions: Record<string, TeamsReminderSessionState> = {};

// Track last session expired messages to prevent spam
const lastSessionExpiredMessages: Record<string, number> = {};

// Track sessions that are processing a request to prevent duplicates
const sessionsInProgress = new Set<string>();

// Create more robust session cleanup
let sessionCleanupInterval: NodeJS.Timeout | null = null;

// Function to clean up expired sessions
function cleanupExpiredSessions() {
  try {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    const warningAge = 25 * 60 * 1000; // 25 minutes - warn before expiring
    
    let cleanedCount = 0;
    let warnedCount = 0;
    
    for (const [sessionKey, session] of Object.entries(teamsReminderSessions)) {
      if (session.reminderData.createdAt) {
        const sessionAge = now - new Date(session.reminderData.createdAt).getTime();
        
        // If session is about to expire but still active, log a warning
        if (sessionAge > warningAge && sessionAge < maxAge) {
          console.log(`⚠️ Session for user ${sessionKey} will expire soon (${Math.round((maxAge - sessionAge)/1000)}s remaining)`);
          warnedCount++;
        }
        
        // If session has expired, clean it up
        if (sessionAge > maxAge) {
          delete teamsReminderSessions[sessionKey];
          cleanedCount++;
          
          // Also remove from in-progress tracking if it's there
          if (sessionsInProgress.has(sessionKey)) {
            sessionsInProgress.delete(sessionKey);
          }
        }
      }
    }
    
    // Clean up old expired message timestamps
    for (const [userId, timestamp] of Object.entries(lastSessionExpiredMessages)) {
      if (now - timestamp > maxAge) {
        delete lastSessionExpiredMessages[userId];
      }
    }
    
    // Clean up the sessionExpiredNotified set
    for (const userId of sessionExpiredNotified) {
      // If user is not in an active session, remove from notified set
      if (!teamsReminderSessions[userId]) {
        sessionExpiredNotified.delete(userId);
      }
    }
    
    // Log cleanup summary
    if (cleanedCount > 0 || warnedCount > 0) {
      console.log(`🧹 Session maintenance: Cleaned ${cleanedCount} expired sessions, ${warnedCount} approaching expiration`);
      console.log(`   Active sessions: ${Object.keys(teamsReminderSessions).length}, In-progress: ${sessionsInProgress.size}`);
    }
  } catch (error) {
    console.error("Error cleaning up reminder sessions:", error);
  }
}

// Start the cleanup interval
if (!sessionCleanupInterval) {
  // Run every 5 minutes for more responsive cleanup
  sessionCleanupInterval = setInterval(cleanupExpiredSessions, 5 * 60 * 1000);
  console.log("⏱️ Teams reminder session cleanup scheduled every 5 minutes");
  
  // Run once immediately in case we're restarting and have stale sessions
  cleanupExpiredSessions();
}

/**
 * Helper function to handle session expiration with better user experience
 * @param context The turn context
 * @param userId The user ID
 */
async function handleSessionExpired(context: TurnContext, userId: string) {
  // Check if we already sent a session expired message recently
  const lastExpiredTime = lastSessionExpiredMessages[userId] || 0;
  const now = Date.now();
  
  // Only send message if we haven't sent one in the last 10 seconds
  if (now - lastExpiredTime > 10000) {
    // Remember when we sent this message to prevent spam
    lastSessionExpiredMessages[userId] = now;
    
    // Send a friendly error message with adaptive card for better UX
    const sessionExpiredCard = CardFactory.adaptiveCard({
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "type": "AdaptiveCard",
      "version": "1.3",
      "body": [
        {
          "type": "TextBlock",
          "size": "Medium",
          "weight": "Bolder",
          "text": "⏰ Session Expired",
          "color": "Warning"
        },
        {
          "type": "TextBlock",
          "text": "Your reminder session has expired due to inactivity.",
          "wrap": true,
          "spacing": "Medium"
        },
        {
          "type": "TextBlock",
          "text": "Sessions automatically expire after 30 minutes to maintain system security and performance.",
          "wrap": true,
          "spacing": "Small",
          "isSubtle": true
        }
      ],
      "actions": [
        {
          "type": "Action.Submit",
          "title": "Start New Reminder",
          "data": {
            "actionType": "startNewReminder"
          }
        }
      ]
    });
    
    const message = MessageFactory.attachment(sessionExpiredCard);
    await context.sendActivity(message);
  }
}

// Track users who have already been notified about session expiration to prevent spam
const sessionExpiredNotified: Set<string> = new Set();

/**
 * Helper function to refresh/extend a session's expiration time
 * @param userId The user ID whose session should be extended
 */
function refreshSessionExpiration(userId: string) {
  const session = teamsReminderSessions[userId];
  if (session) {
    // Update the creation timestamp to extend the session
    session.reminderData.createdAt = new Date().toISOString();
    console.log(`⏱️ Extended session timeout for user ${userId}`);
    
    // Remove from the expired notification tracking if they were there
    if (sessionExpiredNotified.has(userId)) {
      sessionExpiredNotified.delete(userId);
    }
  }
}

/**
 * Helper function to check if user is an admin or manager
 */
async function isUserAdmin(userId: string): Promise<boolean> {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("role")
      .eq("id", userId)
      .single();

    if (error || !user) {
      console.error("Error checking admin status:", error);
      return false;
    }

    return user.role === 'admin' || user.role === 'manager';
  } catch (error) {
    console.error("Error checking admin status:", error);
    return false;
  }
}

/**
 * Helper function to handle session expiration with deduplication
 */
/**
 * Start the send reminder form for administrators and managers
 */
export async function startSendReminderForm(context: TurnContext, user: any) {
  console.log(`🎯 startSendReminderForm called for user ${user.id} - ${new Date().toISOString()}`);
  
  try {
    // Check if user is admin or manager
    const isAdmin = await isUserAdmin(user.id);
    if (!isAdmin) {
      await context.sendActivity("❌ Only administrators and managers can send reminders.");
      return;
    }

    // Initialize session
    const sessionKey = user.id;
    teamsReminderSessions[sessionKey] = {
      step: 'reminder_type',
      reminderData: {
        createdAt: new Date().toISOString()
      },
      userId: user.id
    };

    // Show reminder type selection card
    const reminderTypeCard = CardFactory.adaptiveCard({
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "type": "AdaptiveCard",
      "version": "1.3",
      "body": [
        {
          "type": "TextBlock",
          "size": "Medium",
          "weight": "Bolder",
          "text": "📢 Send Reminder",
          "color": "Accent"
        },
        {
          "type": "TextBlock",
          "text": "What type of reminder would you like to send?",
          "wrap": true,
          "spacing": "Medium"
        }
      ],
      "actions": [
        {
          "type": "Action.Submit",
          "title": "📋 Task Reminder",
          "data": {
            "actionType": "reminderType",
            "reminderType": "task"
          }
        },
        {
          "type": "Action.Submit",
          "title": "📝 Custom Message",
          "data": {
            "actionType": "reminderType",
            "reminderType": "custom"
          }
        },
        {
          "type": "Action.Submit",
          "title": "❌ Cancel",
          "data": {
            "actionType": "cancelReminder"
          }
        }
      ]
    });

    const message = MessageFactory.attachment(reminderTypeCard);
    await context.sendActivity(message);

  } catch (error) {
    console.error("Error in startSendReminderForm:", error);
    await context.sendActivity("❌ Error starting reminder form. Please try again later.");
  }
}

/**
 * Handle reminder type selection
 */
export async function handleReminderTypeSelection(context: TurnContext, action: any, user: any) {
  try {
    // Show typing indicator immediately
    await context.sendActivity({ type: 'typing' });
    
    const sessionKey = user.id;
    const session = teamsReminderSessions[sessionKey];

    if (!session) {
      await handleSessionExpired(context, user.id);
      return;
    }

    // Prevent duplicate processing
    if (session.reminderData.processing) {
      console.log(`⏳ Already processing reminder type selection for user ${user.id}`);
      return;
    }
    session.reminderData.processing = true;

    const reminderType = action.reminderType;
    session.reminderData.reminderType = reminderType;
    session.step = 'reminder_user';

    console.log(`📋 Processing reminder type selection: ${reminderType} for user ${user.id}`);

    // Get available users
    const { data: users, error } = await supabase
      .from("users")
      .select("id, name, email")
      .eq("organization_id", user.organization_id)
      .order("name");

    if (error) {
      console.error("Error fetching users:", error);
      session.reminderData.processing = false; // Reset processing flag
      await context.sendActivity("❌ Error fetching users. Please try again.");
      return;
    }

    session.reminderData.availableUsers = users || [];

    // Create user selection card
    const userChoices = (users || []).slice(0, 20).map(u => ({
      "title": `${u.name} (${u.email})`,
      "value": JSON.stringify({ userId: u.id, userName: u.name, userEmail: u.email })
    }));

    const userSelectionCard = CardFactory.adaptiveCard({
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "type": "AdaptiveCard",
      "version": "1.3",
      "body": [
        {
          "type": "TextBlock",
          "size": "Medium",
          "weight": "Bolder",
          "text": reminderType === 'task' ? "📋 Task Reminder" : "📝 Custom Message",
          "color": "Accent"
        },
        {
          "type": "TextBlock",
          "text": "Select the user to send the reminder to:",
          "wrap": true,
          "spacing": "Medium"
        },
        {
          "type": "Input.ChoiceSet",
          "id": "selectedUser",
          "placeholder": "Choose a user...",
          "choices": userChoices,
          "style": "compact"
        }
      ],
      "actions": [
        {
          "type": "Action.Submit",
          "title": "✅ Continue",
          "data": {
            "actionType": "userSelected"
          }
        },
        {
          "type": "Action.Submit",
          "title": "🔙 Back",
          "data": {
            "actionType": "backToReminderType"
          }
        },
        {
          "type": "Action.Submit",
          "title": "❌ Cancel",
          "data": {
            "actionType": "cancelReminder"
          }
        }
      ]
    });    const message = MessageFactory.attachment(userSelectionCard);
    await context.sendActivity(message);
    
    // Reset processing flag after successful completion
    session.reminderData.processing = false;

  } catch (error) {
    console.error("Error in handleReminderTypeSelection:", error);
    
    // Reset processing flag on error
    const sessionKey = user.id;
    const session = teamsReminderSessions[sessionKey];
    if (session) {
      session.reminderData.processing = false;
    }
    
    await context.sendActivity("❌ Error processing reminder type selection.");
  }
}

/**
 * Handle user selection
 */
export async function handleUserSelection(context: TurnContext, action: any, user: any) {
  try {
    // Show typing indicator immediately
    await context.sendActivity({ type: 'typing' });
    
    const sessionKey = user.id;
    const session = teamsReminderSessions[sessionKey];

    if (!session) {
      await handleSessionExpired(context, user.id);
      return;
    }

    // Prevent duplicate processing
    if (session.reminderData.processing) {
      console.log(`⏳ Already processing user selection for user ${user.id}`);
      return;
    }
    
    if (!action.selectedUser) {
      await context.sendActivity("❌ No user selected. Please select a user from the dropdown.");
      return;
    }

    session.reminderData.processing = true;

    const selectedUserData = JSON.parse(action.selectedUser);
    session.reminderData.reminderUserId = selectedUserData.userId;
    session.reminderData.reminderUserName = selectedUserData.userName;
    session.reminderData.reminderUserEmail = selectedUserData.userEmail;

    console.log(`👤 Selected user: ${selectedUserData.userName} (${selectedUserData.userId})`);

    if (session.reminderData.reminderType === 'task') {
      session.step = 'reminder_task';

      // Get user's tasks
      const { data: tasks, error } = await supabase
        .from("tasks")
        .select(`
          id, 
          title, 
          description, 
          status, 
          priority, 
          deadline,
          projects(name)
        `)
        .filter('assigned_to', 'cs', `["${selectedUserData.userId}"]`)
        .in("status", ["pending", "in_progress"])
        .order("created_at", { ascending: false });        if (error) {
          console.error("Error fetching tasks:", error);
          session.reminderData.processing = false; // Reset processing flag
          await context.sendActivity("❌ Error fetching user's tasks. Please try again.");
          return;
        }

        session.reminderData.availableTasks = tasks || [];

        if (!tasks || tasks.length === 0) {
          session.reminderData.processing = false; // Reset processing flag
          await context.sendActivity(`❌ ${selectedUserData.userName} has no active tasks to remind about.`);
          return;
        }

      // Create task selection card
      const taskChoices = tasks.slice(0, 20).map(task => ({
        "title": `${task.title} (${task.status.toUpperCase()}) - ${task.projects?.[0]?.name || 'No Project'}`,
        "value": JSON.stringify({ taskId: task.id, taskTitle: task.title })
      }));

      const taskSelectionCard = CardFactory.adaptiveCard({
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.3",
        "body": [
          {
            "type": "TextBlock",
            "size": "Medium",
            "weight": "Bolder",
            "text": "📋 Select Task",
            "color": "Accent"
          },
          {
            "type": "TextBlock",
            "text": `Select a task to remind ${selectedUserData.userName} about:`,
            "wrap": true,
            "spacing": "Medium"
          },
          {
            "type": "Input.ChoiceSet",
            "id": "selectedTask",
            "placeholder": "Choose a task...",
            "choices": taskChoices,
            "style": "compact"
          }
        ],
        "actions": [
          {
            "type": "Action.Submit",
            "title": "✅ Continue",
            "data": {
              "actionType": "taskSelected"
            }
          },
          {
            "type": "Action.Submit",
            "title": "🔙 Back",
            "data": {
              "actionType": "backToUserSelection"
            }
          },
          {
            "type": "Action.Submit",
            "title": "❌ Cancel",
            "data": {
              "actionType": "cancelReminder"
            }
          }
        ]
      });        const message = MessageFactory.attachment(taskSelectionCard);
        await context.sendActivity(message);
        
        // Reset processing flag after successful completion
        session.reminderData.processing = false;

      } else {
        // Custom message type
        session.step = 'reminder_custom_message';

        const customMessageCard = CardFactory.adaptiveCard({
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.3",
        "body": [
          {
            "type": "TextBlock",
            "size": "Medium",
            "weight": "Bolder",
            "text": "📝 Custom Message",
            "color": "Accent"
          },
          {
            "type": "TextBlock",
            "text": `Enter a custom message to send to ${selectedUserData.userName}:`,
            "wrap": true,
            "spacing": "Medium"
          },
          {
            "type": "Input.Text",
            "id": "customMessage",
            "placeholder": "Enter your message here...",
            "isMultiline": true,
            "maxLength": 500
          }
        ],
        "actions": [
          {
            "type": "Action.Submit",
            "title": "✅ Continue",
            "data": {
              "actionType": "customMessageEntered"
            }
          },
          {
            "type": "Action.Submit",
            "title": "🔙 Back",
            "data": {
              "actionType": "backToUserSelection"
            }
          },
          {
            "type": "Action.Submit",
            "title": "❌ Cancel",
            "data": {
              "actionType": "cancelReminder"
            }
          }
        ]
      });        const message = MessageFactory.attachment(customMessageCard);
        await context.sendActivity(message);
        
        // Reset processing flag after successful completion
        session.reminderData.processing = false;
      }

    } catch (error) {
      console.error("Error in handleUserSelection:", error);
      
      // Reset processing flag on error
      const sessionKey = user.id;
      const session = teamsReminderSessions[sessionKey];
      if (session) {
        session.reminderData.processing = false;
      }
      
      await context.sendActivity("❌ Error processing user selection.");
    }
  }

/**
 * Handle task selection
 */
export async function handleTaskSelection(context: TurnContext, action: any, user: any) {
  try {
    const sessionKey = user.id;
    const session = teamsReminderSessions[sessionKey];

    if (!session) {
      await handleSessionExpired(context, user.id);
      return;
    }

    const selectedTaskData = JSON.parse(action.selectedTask);
    session.reminderData.reminderTaskId = selectedTaskData.taskId;
    session.reminderData.reminderTaskTitle = selectedTaskData.taskTitle;
    session.step = 'reminder_schedule';

    // Show schedule options
    const scheduleCard = CardFactory.adaptiveCard({
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "type": "AdaptiveCard",
      "version": "1.3",
      "body": [
        {
          "type": "TextBlock",
          "size": "Medium",
          "weight": "Bolder",
          "text": "⏰ Schedule Reminder",
          "color": "Accent"
        },
        {
          "type": "TextBlock",
          "text": "When should this reminder be sent?",
          "wrap": true,
          "spacing": "Medium"
        }
      ],
      "actions": [
        {
          "type": "Action.Submit",
          "title": "📨 Send Now",
          "data": {
            "actionType": "scheduleSelected",
            "schedule": "now"
          }
        },
        {
          "type": "Action.Submit",
          "title": "🔙 Back",
          "data": {
            "actionType": "backToTaskSelection"
          }
        },
        {
          "type": "Action.Submit",
          "title": "❌ Cancel",
          "data": {
            "actionType": "cancelReminder"
          }
        }
      ]
    });

    const message = MessageFactory.attachment(scheduleCard);
    await context.sendActivity(message);

  } catch (error) {
    console.error("Error in handleTaskSelection:", error);
    await context.sendActivity("❌ Error processing task selection.");
  }
}

/**
 * Handle custom message entry
 */
export async function handleCustomMessageEntry(context: TurnContext, action: any, user: any) {
  try {
    const sessionKey = user.id;
    const session = teamsReminderSessions[sessionKey];

    if (!session) {
      await handleSessionExpired(context, user.id);
      return;
    }

    const customMessage = action.customMessage?.trim();
    if (!customMessage) {
      await context.sendActivity("❌ Please enter a message.");
      return;
    }

    session.reminderData.reminderCustomMessage = customMessage;
    session.step = 'reminder_schedule';

    // Show schedule options for custom message
    const scheduleCard = CardFactory.adaptiveCard({
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "type": "AdaptiveCard",
      "version": "1.3",
      "body": [
        {
          "type": "TextBlock",
          "size": "Medium",
          "weight": "Bolder",
          "text": "⏰ Schedule Reminder",
          "color": "Accent"
        },
        {
          "type": "TextBlock",
          "text": "When should this reminder be sent?",
          "wrap": true,
          "spacing": "Medium"
        }
      ],
      "actions": [
        {
          "type": "Action.Submit",
          "title": "📨 Send Now",
          "data": {
            "actionType": "scheduleSelected",
            "schedule": "now"
          }
        },
        {
          "type": "Action.Submit",
          "title": "🔙 Back",
          "data": {
            "actionType": "backToCustomMessage"
          }
        },
        {
          "type": "Action.Submit",
          "title": "❌ Cancel",
          "data": {
            "actionType": "cancelReminder"
          }
        }
      ]
    });

    const message = MessageFactory.attachment(scheduleCard);
    await context.sendActivity(message);

  } catch (error) {
    console.error("Error in handleCustomMessageEntry:", error);
    await context.sendActivity("❌ Error processing custom message.");
  }
}

/**
 * Handle schedule selection
 */
export async function handleScheduleSelection(context: TurnContext, action: any, user: any) {
  try {
    const sessionKey = user.id;
    const session = teamsReminderSessions[sessionKey];

    if (!session) {
      await handleSessionExpired(context, user.id);
      return;
    }

    session.reminderData.reminderSchedule = action.schedule;
    session.step = 'reminder_confirm';

    // Show confirmation
    const reminderData = session.reminderData;
    let confirmationText = "**Reminder Summary**\n\n";
    
    if (reminderData.reminderType === 'task') {
      confirmationText += `**Type:** Task Reminder\n`;
      confirmationText += `**Recipient:** ${reminderData.reminderUserName} (${reminderData.reminderUserEmail})\n`;
      confirmationText += `**Task:** ${reminderData.reminderTaskTitle}\n`;
      confirmationText += `**Schedule:** ${action.schedule === 'now' ? 'Send immediately' : action.schedule}\n`;
    } else {
      confirmationText += `**Type:** Custom Message\n`;
      confirmationText += `**Recipient:** ${reminderData.reminderUserName} (${reminderData.reminderUserEmail})\n`;
      confirmationText += `**Message:** ${reminderData.reminderCustomMessage}\n`;
      confirmationText += `**Schedule:** ${action.schedule === 'now' ? 'Send immediately' : action.schedule}\n`;
    }

    const confirmationCard = CardFactory.adaptiveCard({
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "type": "AdaptiveCard",
      "version": "1.3",
      "body": [
        {
          "type": "TextBlock",
          "size": "Medium",
          "weight": "Bolder",
          "text": "✅ Confirm Reminder",
          "color": "Accent"
        },
        {
          "type": "TextBlock",
          "text": confirmationText,
          "wrap": true,
          "spacing": "Medium"
        }
      ],
      "actions": [
        {
          "type": "Action.Submit",
          "title": "📨 Send Reminder",
          "data": {
            "actionType": "confirmSendReminder"
          }
        },
        {
          "type": "Action.Submit",
          "title": "🔙 Back",
          "data": {
            "actionType": "backToSchedule"
          }
        },
        {
          "type": "Action.Submit",
          "title": "❌ Cancel",
          "data": {
            "actionType": "cancelReminder"
          }
        }
      ]
    });

    const message = MessageFactory.attachment(confirmationCard);
    await context.sendActivity(message);

  } catch (error) {
    console.error("Error in handleScheduleSelection:", error);
    await context.sendActivity("❌ Error processing schedule selection.");
  }
}

/**
 * Confirm and send reminder with improved deduplication and error handling
 */
export async function confirmSendReminder(context: TurnContext, user: any) {
  // Generate a unique request ID for this submission to prevent duplicates
  const requestId = `${user.id}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  
  try {
    // Show typing indicator immediately
    await context.sendActivity({ type: 'typing' });
    
    const sessionKey = user.id;
    const session = teamsReminderSessions[sessionKey];
    
    if (!session) {
      await handleSessionExpired(context, user.id);
      return;
    }

    // Global duplicate submission prevention - check if this user has a submission in progress
    if (sessionsInProgress.has(sessionKey)) {
      console.log(`⚠️ Duplicate submission attempt detected for user ${user.id} - request ${requestId}`);
      await context.sendActivity("⏳ A reminder is already being processed. Please wait...");
      return;
    }
    
    // Session-specific duplicate submission prevention
    if (session.reminderData.processing) {
      console.log(`⏳ Reminder submission already in progress for user ${user.id} - request ${requestId}`);
      await context.sendActivity("⏳ This reminder is already being processed. Please wait for confirmation...");
      return;
    }
    
    // Mark as processing at both levels
    sessionsInProgress.add(sessionKey);
    session.reminderData.processing = true;
    
    console.log(`🔄 Processing reminder submission for user ${user.id} - request ${requestId}`);
      // Refresh the session expiration time to prevent timeout during processing
    refreshSessionExpiration(user.id);
    
    const reminderData = session.reminderData;
    
    // Generate a consistent task ID for deduplication
    let taskIdForDeduplication = '';
    if (reminderData.reminderType === 'task') {
      taskIdForDeduplication = reminderData.reminderTaskId!;
    } else {
      taskIdForDeduplication = `custom_${reminderData.reminderUserId}`;
    }
    
    console.log(`🔍 Checking deduplication for user ${reminderData.reminderUserId}, taskId: ${taskIdForDeduplication}`);
    
    // Check if this reminder was already sent recently to prevent duplicates
    let reminderMessage = '';
    if (reminderData.reminderType === 'task') {
      reminderMessage = `📋 Task Reminder: "${reminderData.reminderTaskTitle}"\n\n🎯 Don't forget to work on this task!\n\n⏰ Reminder from: Admin`;
    } else {
      reminderMessage = `📝 Custom Reminder\n\n${reminderData.reminderCustomMessage}\n\n⏰ From: Admin`;
    }
    
    // Only check for immediate reminders, as scheduled ones should be handled by the reminder service
    if (reminderData.reminderSchedule === 'now') {
      const alreadySent = await hasReminderBeenSentRecently(
        reminderData.reminderUserId!,
        taskIdForDeduplication,
        reminderMessage
      );
      
      if (alreadySent) {
        console.log(`🚫 DEDUPLICATION: Reminder already sent recently for user ${reminderData.reminderUserId}, task ${taskIdForDeduplication}`);
        
        // Clean up session
        delete teamsReminderSessions[sessionKey];
        if (sessionsInProgress.has(sessionKey)) {
          sessionsInProgress.delete(sessionKey);
        }
        
        await context.sendActivity("⚠️ This reminder was already sent recently. To avoid spam, duplicate reminders are prevented for a short period.");
        return;
      }
    }if (reminderData.reminderType === 'task') {
      // First verify the task exists and get its details
      const { data: taskData, error: taskError } = await supabase
        .from("tasks")
        .select("id, title")
        .eq("id", reminderData.reminderTaskId)
        .single();

      if (taskError || !taskData) {
        console.error("Error fetching task for reminder:", taskError);
        await context.sendActivity("❌ Task not found. Please try again.");
        return;
      }      // Create task reminder in custom_reminder table with type 'task'
      const scheduleTime = reminderData.reminderSchedule === 'now' ? new Date().toISOString() : reminderData.reminderSchedule;
      
      console.log(`📋 Creating task reminder for user ${reminderData.reminderUserId} about task ${taskData.id}`);
      console.log(`⏰ Schedule time: ${scheduleTime} (current time: ${new Date().toISOString()})`);
      
      // Save task reminder in custom_reminder table with type 'task'
      // Note: custom_reminder table doesn't have a task_id column, so we include the task ID in the message
      const taskReminderPayload = {
        id: undefined, // Let the database generate this
        user_id: reminderData.reminderUserId,
        message: reminderMessage,
        scheduled_for: scheduleTime,
        sent: false,
        type: 'task',  // Type is 'task' for task reminders
        created_at: new Date().toISOString(),
        reminder_time: scheduleTime,
        organization_id: user.organization_id,
        user_email: reminderData.reminderUserEmail,
        sent_at: null
      };console.log("📝 Creating task reminder in custom_reminder table with payload:", JSON.stringify(taskReminderPayload, null, 2));
      
      const { error: reminderError } = await supabase
        .from("custom_reminder")
        .insert(taskReminderPayload);

      if (reminderError) {
        console.error("Error creating task reminder:", reminderError);
        await context.sendActivity("❌ Error creating task reminder. Please try again.");
        return;
      }      console.log("✅ Task reminder created successfully in custom_reminder table");
      
      // Store notification log for deduplication tracking (for immediate reminders)
      if (reminderData.reminderSchedule === 'now') {
        await storeNotificationLog(
          reminderData.reminderUserId!,
          taskIdForDeduplication,
          reminderMessage,
          'teams'
        );
        console.log(`📝 Stored notification log for immediate task reminder to prevent duplicates`);
      }
      
      // Send completion card instead of just a message
      const completionCard = {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.3",
        "body": [
          {
            "type": "TextBlock",
            "size": "Medium",
            "weight": "Bolder",
            "text": "✅ Task Reminder Sent Successfully!",
            "color": "Good"
          },
          {
            "type": "Container",
            "style": "emphasis",
            "items": [
              {
                "type": "TextBlock",
                "text": `**👤 Recipient:** ${reminderData.reminderUserName} (${reminderData.reminderUserEmail})`,
                "wrap": true
              },
              {
                "type": "TextBlock",
                "text": `**📋 Task:** ${taskData.title}`,
                "wrap": true
              },
              {
                "type": "TextBlock",
                "text": `**⏰ Schedule:** ${reminderData.reminderSchedule === 'now' ? 'Sent immediately' : reminderData.reminderSchedule}`,
                "wrap": true
              }
            ]
          },
          {
            "type": "TextBlock",
            "text": "🎯 The reminder has been sent to all available platforms (Teams, Slack, Telegram, WhatsApp) where the user is reachable.",
            "wrap": true,
            "isSubtle": true,
            "spacing": "Medium"
          },
          {
            "type": "TextBlock",
            "text": "To send another reminder, use the /sendreminder command again.",
            "wrap": true,
            "isSubtle": true,
            "size": "Small"
          }
        ]
      };
      
      const completionMessage = MessageFactory.attachment(CardFactory.adaptiveCard(completionCard));
      await context.sendActivity(completionMessage);      // Clean up all session data to prevent duplicate submissions
      delete teamsReminderSessions[sessionKey];
      
      // Also remove from in-progress tracking
      if (sessionsInProgress.has(sessionKey)) {
        sessionsInProgress.delete(sessionKey);
      }

    } else {      // Create custom reminder in custom_reminder table with type 'custom'
      const customReminderPayload = {
        id: undefined, // Let the database generate this
        user_id: reminderData.reminderUserId,
        message: reminderMessage, // Use the formatted message
        scheduled_for: reminderData.reminderSchedule === 'now' ? new Date().toISOString() : reminderData.reminderSchedule,
        sent: false,
        type: 'custom',  // Type is 'custom' for custom reminders
        created_at: new Date().toISOString(),
        reminder_time: reminderData.reminderSchedule === 'now' ? new Date().toISOString() : reminderData.reminderSchedule,
        organization_id: user.organization_id,
        user_email: reminderData.reminderUserEmail,
        sent_at: null
      };

      console.log("📝 Creating custom reminder in custom_reminder table with payload:", JSON.stringify(customReminderPayload, null, 2));
      
      const { error: customError } = await supabase
        .from("custom_reminder")
        .insert(customReminderPayload);

      if (customError) {
        console.error("Error creating custom reminder:", customError);
        await context.sendActivity("❌ Error creating custom reminder. Please try again.");
        return;
      }      console.log("✅ Custom reminder created successfully in custom_reminder table");
      
      // Store notification log for deduplication tracking (for immediate reminders)
      if (reminderData.reminderSchedule === 'now') {
        await storeNotificationLog(
          reminderData.reminderUserId!,
          taskIdForDeduplication,
          reminderMessage,
          'teams'
        );
        console.log(`📝 Stored notification log for immediate custom reminder to prevent duplicates`);
      }
      
      // Send completion card instead of just a message
      const completionCard = {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.3",
        "body": [
          {
            "type": "TextBlock",
            "size": "Medium",
            "weight": "Bolder",
            "text": "✅ Custom Reminder Sent!",
            "color": "Good"
          },
          {
            "type": "TextBlock",
            "text": `**Recipient:** ${reminderData.reminderUserName}`,
            "wrap": true
          },
          {
            "type": "TextBlock",
            "text": `**Message:** ${(reminderData.reminderCustomMessage || '').substring(0, 100)}${(reminderData.reminderCustomMessage || '').length > 100 ? '...' : ''}`,
            "wrap": true
          },
          {
            "type": "TextBlock",
            "text": `**Schedule:** ${reminderData.reminderSchedule === 'now' ? 'Immediately' : reminderData.reminderSchedule}`,
            "wrap": true
          },
          {
            "type": "TextBlock",
            "text": "🎯 The reminder has been queued and will be sent to all available platforms.",
            "wrap": true,
            "isSubtle": true
          }
        ]
      };
      
      const completionMessage = MessageFactory.attachment(CardFactory.adaptiveCard(completionCard));
      await context.sendActivity(completionMessage);      // Clean up all session data to prevent duplicate submissions
      delete teamsReminderSessions[sessionKey];
      
      // Also remove from in-progress tracking
      if (sessionsInProgress.has(sessionKey)) {
        sessionsInProgress.delete(sessionKey);
      }
    }
  } catch (error) {
    console.error("Error in confirmSendReminder:", error);
    
    // Clean up session on error
    const sessionKey = user.id;
    delete teamsReminderSessions[sessionKey];
    
    await context.sendActivity("❌ Error sending reminder. Please try again.");
  } finally {
    // Always clean up the processing locks
    const sessionKey = user.id;
    if (sessionsInProgress.has(sessionKey)) {
      sessionsInProgress.delete(sessionKey);
    }
    
    const session = teamsReminderSessions[sessionKey];
    if (session && session.reminderData) {
      session.reminderData.processing = false;
    }
  }
}

/**
 * Cancel reminder process with proper cleanup
 */
export async function cancelReminder(context: TurnContext, user: any) {
  const sessionKey = user.id;
  
  // Clean up all tracking data for this user
  delete teamsReminderSessions[sessionKey];
  
  if (sessionsInProgress.has(sessionKey)) {
    sessionsInProgress.delete(sessionKey);
  }
  
  if (sessionExpiredNotified.has(sessionKey)) {
    sessionExpiredNotified.delete(sessionKey);
  }
  
  // Send a friendly cancellation message
  const cancelCard = CardFactory.adaptiveCard({
    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
    "type": "AdaptiveCard",
    "version": "1.3",
    "body": [
      {
        "type": "TextBlock",
        "size": "Medium",
        "weight": "Bolder",
        "text": "❌ Reminder Cancelled",
        "color": "Attention"
      },
      {
        "type": "TextBlock",
        "text": "The reminder process has been cancelled. No reminder has been sent.",
        "wrap": true
      }
    ],
    "actions": [
      {
        "type": "Action.Submit",
        "title": "Start New Reminder",
        "data": {
          "actionType": "startNewReminder"
        }
      }
    ]
  });
  
  const message = MessageFactory.attachment(cancelCard);
  await context.sendActivity(message);
}

/**
 * Handle navigation back to reminder type selection
 */
export async function backToReminderType(context: TurnContext, user: any) {
  const sessionKey = user.id;
  const session = teamsReminderSessions[sessionKey];
  
  if (session) {
    session.step = 'reminder_type';
    
    // Reset reminder data but keep session and creation timestamp
    const createdAt = session.reminderData.createdAt;
    
    // Clear all data but preserve creation time
    session.reminderData = {
      createdAt: createdAt
    };
    
    // Clear processing flag
    if (sessionsInProgress.has(sessionKey)) {
      sessionsInProgress.delete(sessionKey);
    }
    
    // Refresh session expiration time
    refreshSessionExpiration(user.id);
  }
  
  // Start the form from the beginning
  await startSendReminderForm(context, user);
}

/**
 * Handle action for starting a new reminder after session expiration
 */
export async function startNewReminderFlow(context: TurnContext, user: any) {
  const sessionKey = user.id;
  
  // Clean up any existing session data
  delete teamsReminderSessions[sessionKey];
  
  if (sessionsInProgress.has(sessionKey)) {
    sessionsInProgress.delete(sessionKey);
  }
  
  // Start a new reminder flow
  await startSendReminderForm(context, user);
}

// Export the sessions for debugging and management purposes
export { 
  teamsReminderSessions,
  sessionsInProgress,
  refreshSessionExpiration,
  cleanupExpiredSessions
};

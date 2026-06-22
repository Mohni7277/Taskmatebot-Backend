/**
 * WhatsApp Reminder Forms - Admin Reminder UI Components
 * Based on Telegram Bot's reminder implementation pattern
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

dotenv.config();

// Create a Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Interface for reminder session state
interface WhatsAppReminderSessionState {
  step: 'reminder_type' | 'reminder_user' | 'reminder_task' | 'reminder_custom_message';
  reminderData: {
    reminderType?: 'task' | 'custom';
    reminderUserId?: string;
    reminderUserName?: string;
    reminderUserEmail?: string;
    reminderTaskId?: string;
    reminderTaskTitle?: string;
    reminderCustomMessage?: string;
    createdAt?: string;
    availableUsers?: any[];
    availableTasks?: any[];
  };
  whatsappId?: string;
}

// Store user session data (in production, consider using Redis or database)
const whatsappReminderSessions: Record<string, WhatsAppReminderSessionState> = {};

/**
 * Helper function to check if user is an admin
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
    console.error("Error in isUserAdmin:", error);
    return false;
  }
}

/**
 * Start the send reminder form for admin users
 */
export async function startSendReminderForm(whatsappId: string, user: any, sendMessage: Function) {
  console.log(`🎯 WhatsApp startSendReminderForm called for user: ${user.name} (${user.id})`);
    try {
    // Only allow admins and managers
    console.log(`🔐 Checking if user ${user.name} (${user.id}) is admin or manager...`);
    const isAdmin = await isUserAdmin(user.id);
    console.log(`🔐 Admin/Manager check completed - Result: ${isAdmin ? 'IS ADMIN/MANAGER ✓' : 'NOT ADMIN/MANAGER ✗'}`);
    
    if (!isAdmin) {
      console.log(`❌ User ${user.name} is not admin or manager - Access denied to reminder form`);
      await sendMessage(whatsappId, "❌ Only admins and managers can send reminders. If you need this feature, please contact your administrator.");
      return;
    }
    
    console.log(`✅ Admin/Manager verified - Preparing reminder form UI...`);
    
    // Clear any existing session for this user
    const sessionKey = whatsappId;
    if (whatsappReminderSessions[sessionKey]) {
      console.log(`🧹 Clearing existing session for user ${whatsappId}`);
      delete whatsappReminderSessions[sessionKey];
    }
    
    // Setup new session
    whatsappReminderSessions[sessionKey] = {
      step: 'reminder_type',
      reminderData: {
        createdAt: new Date().toISOString()
      },
      whatsappId: whatsappId
    };
    
    console.log(`📝 Session created: ${JSON.stringify(whatsappReminderSessions[sessionKey])}`);
    
    // Step 1: Choose reminder type
    const message = `📬 *Send Reminder*\n\nWhat type of reminder do you want to send?\n\n` +
      `1. 📋 Task Reminder - Remind user about existing task\n` +
      `2. ✏️ Custom Reminder - Send custom message\n` +
      `3. ❌ Cancel\n\n` +
      `Reply with the number (1, 2, or 3):`;
    
    await sendMessage(whatsappId, message);
    
    console.log(`✅ Reminder form initiated successfully for admin user ${user.name} (${user.email})`);
    
  } catch (error) {
    console.error(`❌ ERROR in startSendReminderForm:`, error);
    await sendMessage(whatsappId, "Sorry, there was an error setting up the reminder form. Please try again later.");
  }
}

/**
 * Handle reminder type selection
 */
export async function handleReminderTypeSelection(whatsappId: string, selection: string, user: any, sendMessage: Function) {
  try {
    const sessionKey = whatsappId;
    const session = whatsappReminderSessions[sessionKey];
    
    if (!session) {
      console.log("No active session found for user", whatsappId);
      return false;
    }

    let reminderType: 'task' | 'custom' | null = null;

    // Parse selection
    switch (selection.trim()) {
      case '1':
        reminderType = 'task';
        break;
      case '2':
        reminderType = 'custom';
        break;
      case '3':
        delete whatsappReminderSessions[sessionKey];
        await sendMessage(whatsappId, "❌ Reminder cancelled.");
        return true;
      default:
        await sendMessage(whatsappId, "❌ Invalid selection. Please choose 1, 2, or 3:");
        return true;
    }

    // Save reminder type
    session.reminderData.reminderType = reminderType;
    session.step = 'reminder_user';

    // Fetch all users in the same organization
    const { data: users, error } = await supabase
      .from("users")
      .select("id, name, email")
      .eq("organization_id", user.organization_id)
      .order("name")
      .limit(20); // Limit to prevent message overflow

    if (error || !users || users.length === 0) {
      await sendMessage(whatsappId, "❌ No users found in your organization.");
      return true;
    }

    // Create user selection message
    let message = `*Select User for ${reminderType === 'task' ? 'Task' : 'Custom'} Reminder:*\n\n` +
      `Choose the user to send the reminder to (reply with the number):\n\n`;

    users.forEach((u: any, index) => {
      message += `${index + 1}. ${u.name} (${u.email})\n`;
    });

    message += `\n${users.length + 1}. ❌ Cancel\n\n` +
      `Reply with the number:`;

    // Store users for selection
    session.reminderData = {
      ...session.reminderData,
      availableUsers: users
    };

    await sendMessage(whatsappId, message);
    
    console.log(`✅ User selection form displayed for ${reminderType} reminder`);
    return true;
    
  } catch (error) {
    console.error("Error handling reminder type selection:", error);
    await sendMessage(whatsappId, "❌ Sorry, there was an error processing your selection. Please try again.");
    return true;
  }
}

/**
 * Handle user selection for reminder
 */
export async function handleReminderUserSelection(whatsappId: string, selection: string, user: any, sendMessage: Function) {
  try {
    const sessionKey = whatsappId;
    const session = whatsappReminderSessions[sessionKey];
    
    if (!session) {
      console.log("No active session found for user", whatsappId);
      return false;
    }

    const users = (session.reminderData as any).availableUsers || [];
    const selectionIndex = parseInt(selection) - 1;

    // Check for cancel
    if (selectionIndex === users.length) {
      delete whatsappReminderSessions[sessionKey];
      await sendMessage(whatsappId, "❌ Reminder cancelled.");
      return true;
    }

    // Validate selection
    if (selectionIndex < 0 || selectionIndex >= users.length) {
      await sendMessage(whatsappId, "❌ Invalid selection. Please choose a valid user number:");
      return true;
    }

    const selectedUser = users[selectionIndex];

    // Store user selection
    session.reminderData.reminderUserId = selectedUser.id;
    session.reminderData.reminderUserName = selectedUser.name;
    session.reminderData.reminderUserEmail = selectedUser.email;

    if (session.reminderData.reminderType === 'task') {
      session.step = 'reminder_task';
      
      // Get tasks assigned to the selected user
      const { data: tasks, error: taskError } = await supabase
        .from("tasks")
        .select("id, title, status, deadline")
        .filter('assigned_to', 'cs', `["${selectedUser.id}"]`)
        .in("status", ["pending", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(10);

      if (taskError || !tasks || tasks.length === 0) {
        await sendMessage(whatsappId, `❌ No active tasks found for ${selectedUser.name}.`);
        return true;
      }

      // Create task selection message
      let message = `*Select Task for ${selectedUser.name}:*\n\n` +
        `Choose the task to remind about (reply with the number):\n\n`;

      tasks.forEach((task: any, index) => {
        const statusEmoji = task.status === 'pending' ? '⏳' : '🚧';
        const deadlineText = task.deadline ? ` (Due: ${new Date(task.deadline).toLocaleDateString()})` : '';
        message += `${index + 1}. ${statusEmoji} ${task.title}${deadlineText}\n`;
      });

      message += `\n${tasks.length + 1}. ❌ Cancel\n\n` +
        `Reply with the number:`;

      // Store tasks for selection
      (session.reminderData as any).availableTasks = tasks;

      await sendMessage(whatsappId, message);
      
    } else if (session.reminderData.reminderType === 'custom') {
      session.step = 'reminder_custom_message';
      
      await sendMessage(whatsappId, `📝 *Custom Reminder for ${selectedUser.name}*\n\n` +
        `Please type your custom reminder message:\n\n` +
        `(Or type "cancel" to cancel the reminder)`);
    }
    
    return true;
    
  } catch (error) {
    console.error("Error handling user selection:", error);
    await sendMessage(whatsappId, "❌ Sorry, there was an error processing the user selection. Please try again.");
    return true;
  }
}

/**
 * Handle task selection for reminder
 */
export async function handleReminderTaskSelection(whatsappId: string, selection: string, user: any, sendMessage: Function) {
  try {
    const sessionKey = whatsappId;
    const session = whatsappReminderSessions[sessionKey];
    
    if (!session) {
      console.log("No active session found for user", whatsappId);
      return false;
    }

    const tasks = (session.reminderData as any).availableTasks || [];
    const selectionIndex = parseInt(selection) - 1;

    // Check for cancel
    if (selectionIndex === tasks.length) {
      delete whatsappReminderSessions[sessionKey];
      await sendMessage(whatsappId, "❌ Reminder cancelled.");
      return true;
    }

    // Validate selection
    if (selectionIndex < 0 || selectionIndex >= tasks.length) {
      await sendMessage(whatsappId, "❌ Invalid selection. Please choose a valid task number:");
      return true;
    }

    const selectedTask = tasks[selectionIndex];

    // Store task selection
    session.reminderData.reminderTaskId = selectedTask.id;
    session.reminderData.reminderTaskTitle = selectedTask.title;

    // Create the reminder message
    let reminderMessage = `⏰ Reminder about your task: "${selectedTask.title}"`;
    
    if (selectedTask.deadline) {
      const deadline = new Date(selectedTask.deadline).toLocaleDateString();
      reminderMessage += `\nDeadline: ${deadline}`;
    }
    
    if (selectedTask.priority) {
      reminderMessage += `\nPriority: ${selectedTask.priority}`;
    }    try {
      // Send the reminder immediately using the existing sendReminder function
      const { sendReminder } = await import('./whatsappBot');
      
      await sendReminder({
        taskId: `${selectedTask.id}_${session.reminderData.reminderUserId!}`, // Target specific user
        message: reminderMessage
      });

      await sendMessage(whatsappId, 
        `✅ *Task reminder sent successfully!*\n\n` +
        `*To:* ${session.reminderData.reminderUserName}\n` +
        `*Task:* ${selectedTask.title}\n` +
        `*Message:* ${reminderMessage}`
      );

      console.log(`✅ Task reminder sent to ${session.reminderData.reminderUserName} about task "${selectedTask.title}"`);
      
      // Clear session
      delete whatsappReminderSessions[sessionKey];
      
    } catch (error) {
      console.error("Error sending task reminder:", error);
      await sendMessage(whatsappId, "❌ Error sending reminder. Please try again.");
    }
    
    return true;
    
  } catch (error) {
    console.error("Error handling task selection:", error);
    await sendMessage(whatsappId, "❌ Sorry, there was an error processing the task selection. Please try again.");
    return true;
  }
}

/**
 * Handle custom reminder message submission
 */
export async function handleCustomReminderMessage(whatsappId: string, customMessage: string, user: any, sendMessage: Function) {
  try {
    const sessionKey = whatsappId;
    const session = whatsappReminderSessions[sessionKey];
    
    if (!session || session.step !== 'reminder_custom_message') {
      console.log("No active custom reminder session found for user", whatsappId);
      return false;
    }

    // Check for cancel
    if (customMessage.toLowerCase().trim() === 'cancel') {
      delete whatsappReminderSessions[sessionKey];
      await sendMessage(whatsappId, "❌ Reminder cancelled.");
      return true;
    }

    // Validate message
    if (!customMessage || customMessage.trim().length < 5) {
      await sendMessage(whatsappId, "❌ Please enter a longer reminder message (at least 5 characters).");
      return true;
    }

    if (customMessage.trim().length > 500) {
      await sendMessage(whatsappId, "❌ Reminder message is too long. Please keep it under 500 characters.");
      return true;
    }

    // Store the message
    session.reminderData.reminderCustomMessage = customMessage.trim();

    const finalMessage = `⏰ Reminder from admin: ${customMessage.trim()}`;

    try {
      // Send the custom reminder immediately using the existing sendReminder function
      const { sendReminder } = await import('./whatsappBot');
      
      await sendReminder({
        taskId: `custom_${session.reminderData.reminderUserId}`,
        message: finalMessage
      });

      await sendMessage(whatsappId, 
        `✅ *Custom reminder sent successfully!*\n\n` +
        `*To:* ${session.reminderData.reminderUserName}\n` +
        `*Message:* ${finalMessage}`
      );

      console.log(`✅ Custom reminder sent to ${session.reminderData.reminderUserName}`);
      
      // Clear session
      delete whatsappReminderSessions[sessionKey];
      
    } catch (error) {
      console.error("Error sending custom reminder:", error);
      await sendMessage(whatsappId, "❌ Error sending reminder. Please try again.");
    }
    
    return true;
    
  } catch (error) {
    console.error("Error handling custom reminder message:", error);
    await sendMessage(whatsappId, "❌ Sorry, there was an error processing your message. Please try again.");
    return true;
  }
}

/**
 * Handle reminder cancellation
 */
export async function handleReminderCancellation(whatsappId: string, sendMessage: Function) {
  try {
    const sessionKey = whatsappId;
    
    // Clear session
    if (whatsappReminderSessions[sessionKey]) {
      delete whatsappReminderSessions[sessionKey];
    }

    await sendMessage(whatsappId, "❌ *Reminder cancelled.*");
    
    console.log(`Reminder session cancelled for user ${whatsappId}`);
    return true;
    
  } catch (error) {
    console.error("Error handling reminder cancellation:", error);
    await sendMessage(whatsappId, "❌ Sorry, there was an error cancelling the reminder.");
    return true;
  }
}

/**
 * Get current reminder session for a user
 */
export function getReminderSession(whatsappId: string): WhatsAppReminderSessionState | null {
  return whatsappReminderSessions[whatsappId] || null;
}

/**
 * Check if user has an active reminder session
 */
export function hasActiveReminderSession(whatsappId: string): boolean {
  return !!whatsappReminderSessions[whatsappId];
}

/**
 * Clear reminder session for a user
 */
export function clearReminderSession(whatsappId: string): void {
  if (whatsappReminderSessions[whatsappId]) {
    delete whatsappReminderSessions[whatsappId];
  }
}

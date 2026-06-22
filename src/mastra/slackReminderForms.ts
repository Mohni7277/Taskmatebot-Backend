/**
 * Slack Reminder Forms - Admin Reminder UI Components
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
interface ReminderSessionState {
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
  };
  channelId?: string;
  messageTs?: string;
}

// Store user session data (in production, consider using Redis or database)
const reminderSessions: Record<string, ReminderSessionState> = {};

/**
 * Helper function to check if user is an admin
 */
async function isUserAdmin(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("role")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("Error checking admin status:", error);
      return false;
    }

    return data && (data.role === "admin" || data.role === "manager");
  } catch (error) {
    console.error("Error checking if user is admin:", error);
    return false;
  }
}

/**
 * Start the send reminder form for admin users
 */
export async function startSendReminderForm(client: any, user: any, channelId: string, threadTs?: string) {
  console.log(`🎯 startSendReminderForm called for user: ${user.name} (${user.id})`);
    try {
    // Only allow admins and managers
    console.log(`🔐 Checking if user ${user.name} (${user.id}) is admin or manager...`);
    const isAdmin = await isUserAdmin(user.id);
    console.log(`🔐 Admin/Manager check completed - Result: ${isAdmin ? 'IS ADMIN/MANAGER ✓' : 'NOT ADMIN/MANAGER ✗'}`);
    
    if (!isAdmin) {
      console.log(`❌ User ${user.name} is not admin or manager - Access denied to reminder form`);
      await client.chat.postMessage({
        channel: channelId,
        text: "❌ Only admins and managers can send reminders. If you need this feature, please contact your administrator.",
        thread_ts: threadTs
      });
      return;
    }
    
    console.log(`✅ Admin verified - Preparing reminder form UI...`);
    
    // Clear any existing session for this user
    const sessionKey = user.id;
    if (reminderSessions[sessionKey]) {
      console.log(`🧹 Clearing existing session for user ${user.id}`);
      delete reminderSessions[sessionKey];
    }
    
    // Setup new session
    reminderSessions[sessionKey] = {
      step: 'reminder_type',
      reminderData: {
        createdAt: new Date().toISOString()
      },
      channelId: channelId
    };
    
    console.log(`📝 Session created: ${JSON.stringify(reminderSessions[sessionKey])}`);
    
    // Step 1: Choose reminder type with Slack Block Kit UI
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "📬 *Send Reminder*\n\nWhat type of reminder do you want to send?"
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "📋 Task Reminder",
              emoji: true
            },
            action_id: "reminder_type_task",
            style: "primary"
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "✏️ Custom Reminder",
              emoji: true
            },
            action_id: "reminder_type_custom"
          }
        ]
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "❌ Cancel",
              emoji: true
            },
            action_id: "cancel_send_reminder"
          }
        ]
      }
    ];
    
    const response = await client.chat.postMessage({
      channel: channelId,
      blocks: blocks,
      thread_ts: threadTs
    });
    
    console.log(`✅ Reminder form UI displayed successfully (message ts: ${response.ts})`);
    
    // Store the message timestamp in session for potential cleanup later
    reminderSessions[sessionKey].messageTs = response.ts;
    
    console.log(`✅ Reminder form initiated successfully for admin user ${user.name} (${user.email})`);
    
  } catch (error) {
    console.error(`❌ ERROR in startSendReminderForm:`, error);
    await client.chat.postMessage({
      channel: channelId,
      text: "Sorry, there was an error setting up the reminder form. Please try again later.",
      thread_ts: threadTs
    });
  }
}

/**
 * Handle reminder type selection
 */
export async function handleReminderTypeSelection(client: any, user: any, actionId: string, channelId: string, messageTs: string, threadTs?: string) {
  try {
    const sessionKey = user.id;
    const session = reminderSessions[sessionKey];
    
    if (!session) {
      console.log("No active session found for user", user.id);
      return;
    }

    // Save reminder type
    if (actionId === "reminder_type_task") {
      session.reminderData.reminderType = 'task';
    } else if (actionId === "reminder_type_custom") {
      session.reminderData.reminderType = 'custom';
    } else {
      await client.chat.postMessage({
        channel: channelId,
        text: "❌ Invalid reminder type.",
        thread_ts: threadTs
      });
      return;
    }
    session.step = 'reminder_user';

    // Fetch all users in the same organization
    const { data: users, error } = await supabase
      .from("users")
      .select("id, name, email")
      .eq("organization_id", user.organization_id)
      .order("name")
      .limit(20); // Limit to prevent UI overflow

    if (error || !users || users.length === 0) {
      await client.chat.postMessage({
        channel: channelId,
        text: "❌ No users found in your organization.",
        thread_ts: threadTs
      });
      return;
    }

    // Create user selection dropdown
    const userOptions = users.map((u: any) => ({
      text: {
        type: "plain_text",
        text: `${u.name} (${u.email})`.substring(0, 75) // Slack text limit
      },
      value: u.id
    }));

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Select the user to send the ${session.reminderData.reminderType} reminder to:`
        },
        accessory: {
          type: "static_select",
          placeholder: {
            type: "plain_text",
            text: "Choose a user..."
          },
          action_id: "reminder_user_select",
          options: userOptions
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "❌ Cancel",
              emoji: true
            },
            action_id: "cancel_send_reminder"
          }
        ]
      }
    ];

    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      blocks: blocks
    });
    
  } catch (error) {
    console.error("Error handling reminder type selection:", error);
    await client.chat.postMessage({
      channel: channelId,
      text: "❌ Sorry, there was an error processing your selection. Please try again.",
      thread_ts: threadTs
    });
  }
}

/**
 * Handle user selection for reminder
 */
export async function handleReminderUserSelection(client: any, user: any, selectedUserId: string, channelId: string, messageTs: string, threadTs?: string) {
  try {
    const sessionKey = user.id;
    const session = reminderSessions[sessionKey];
    
    if (!session) {
      console.log("No active session found for user", user.id);
      return;
    }

    // Get selected user details
    const { data: selectedUser, error: userError } = await supabase
      .from("users")
      .select("id, name, email")
      .eq("id", selectedUserId)
      .single();

    if (userError || !selectedUser) {
      await client.chat.postMessage({
        channel: channelId,
        text: "❌ Error finding the selected user.",
        thread_ts: threadTs
      });
      return;
    }

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
        await client.chat.postMessage({
          channel: channelId,
          text: `❌ No active tasks found for ${selectedUser.name}.`,
          thread_ts: threadTs
        });
        return;
      }

      // Create task selection dropdown
      const taskOptions = tasks.map((task: any) => {
        const statusEmoji = task.status === 'pending' ? '⏳' : '🚧';
        const deadlineText = task.deadline ? ` (Due: ${new Date(task.deadline).toLocaleDateString()})` : '';
        return {
          text: {
            type: "plain_text",
            text: `${statusEmoji} ${task.title}${deadlineText}`.substring(0, 75)
          },
          value: task.id
        };
      });

      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Select a task to remind *${selectedUser.name}* about:`
          },
          accessory: {
            type: "static_select",
            placeholder: {
              type: "plain_text",
              text: "Choose a task..."
            },
            action_id: "reminder_task_select",
            options: taskOptions
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "❌ Cancel",
                emoji: true
              },
              action_id: "cancel_send_reminder"
            }
          ]
        }
      ];

      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        blocks: blocks
      });
      
    } else if (session.reminderData.reminderType === 'custom') {
      session.step = 'reminder_custom_message';
      
      // Show modal for custom message input
      const modal = {
        type: "modal",
        callback_id: "custom_reminder_modal",
        title: {
          type: "plain_text",
          text: "Custom Reminder"
        },
        submit: {
          type: "plain_text",
          text: "Send Reminder"
        },
        close: {
          type: "plain_text",
          text: "Cancel"
        },
        private_metadata: JSON.stringify({
          channelId: channelId,
          messageTs: messageTs,
          threadTs: threadTs,
          selectedUserId: selectedUser.id,
          selectedUserName: selectedUser.name
        }),
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Sending custom reminder to:* ${selectedUser.name} (${selectedUser.email})`
            }
          },
          {
            type: "input",
            block_id: "custom_message_block",
            element: {
              type: "plain_text_input",
              action_id: "custom_message_input",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: "Enter your custom reminder message here..."
              }
            },
            label: {
              type: "plain_text",
              text: "Reminder Message"
            }
          }
        ]
      };

      // Update the original message to show what's happening
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `📝 Opening custom reminder form for *${selectedUser.name}*...`
            }
          }
        ]
      });      // Use a more structured UI approach with a message containing an input field
      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `📝 *Send Custom Reminder to ${selectedUser.name}*`
          }
        },
        {
          type: "input",
          block_id: "custom_reminder_message_block",
          element: {
            type: "plain_text_input",
            action_id: "custom_reminder_message_input",
            multiline: true,
            placeholder: {
              type: "plain_text",
              text: "Enter your custom reminder message here..."
            }
          },
          label: {
            type: "plain_text",
            text: "Reminder Message"
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "✅ Send Reminder",
                emoji: true
              },
              action_id: "send_custom_reminder_message",
              style: "primary"
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "❌ Cancel",
                emoji: true
              },
              action_id: "cancel_send_reminder"
            }
          ]
        }
      ];
      
      const response = await client.chat.postMessage({
        channel: channelId,
        blocks: blocks,
        thread_ts: threadTs
      });
      
      // Store the message timestamp in session for potential cleanup later
      session.messageTs = response.ts;
    }
    
  } catch (error) {
    console.error("Error handling user selection:", error);
    await client.chat.postMessage({
      channel: channelId,
      text: "❌ Sorry, there was an error processing the user selection. Please try again.",
      thread_ts: threadTs
    });
  }
}

/**
 * Handle task selection for reminder
 */
export async function handleReminderTaskSelection(client: any, user: any, selectedTaskId: string, channelId: string, messageTs: string, threadTs?: string) {
  try {
    const sessionKey = user.id;
    const session = reminderSessions[sessionKey];
    
    if (!session) {
      console.log("No active session found for user", user.id);
      return;
    }

    // Get selected task details
    const { data: selectedTask, error: taskError } = await supabase
      .from("tasks")
      .select("id, title, description, deadline, priority")
      .eq("id", selectedTaskId)
      .single();

    if (taskError || !selectedTask) {
      await client.chat.postMessage({
        channel: channelId,
        text: "❌ Error finding the selected task.",
        thread_ts: threadTs
      });
      return;
    }

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
      // Use composite task ID format to target specific user: taskId_userId
      const { sendReminder } = await import('./slackBot');
      
      await sendReminder({
        id: `admin_reminder_${Date.now()}`,
        message: reminderMessage,
        user_id: session.reminderData.reminderUserId!,
        task_id: `${selectedTask.id}_${session.reminderData.reminderUserId!}` // Target specific user
      });

      // Update the original message with success confirmation
      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ *Task reminder sent successfully!*\n\n*To:* ${session.reminderData.reminderUserName}\n*Task:* ${selectedTask.title}\n*Message:* ${reminderMessage}`
          }
        }
      ];

      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        blocks: blocks
      });

      console.log(`✅ Task reminder sent to ${session.reminderData.reminderUserName} about task "${selectedTask.title}"`);
      
      // Clear session
      delete reminderSessions[sessionKey];
      
    } catch (error) {
      console.error("Error sending task reminder:", error);
      await client.chat.postMessage({
        channel: channelId,
        text: "❌ Error sending reminder. Please try again.",
        thread_ts: threadTs
      });
    }
    
  } catch (error) {
    console.error("Error handling task selection:", error);
    await client.chat.postMessage({
      channel: channelId,
      text: "❌ Sorry, there was an error processing the task selection. Please try again.",
      thread_ts: threadTs
    });
  }
}

/**
 * Handle custom reminder message submission
 */
export async function handleCustomReminderMessage(client: any, user: any, customMessage: string, channelId: string, threadTs?: string) {
  try {
    const sessionKey = user.id;
    const session = reminderSessions[sessionKey];
    
    if (!session || session.step !== 'reminder_custom_message') {
      console.log("No active custom reminder session found for user", user.id);
      return;
    }

    // Validate message
    if (!customMessage || customMessage.trim().length < 5) {
      await client.chat.postMessage({
        channel: channelId,
        text: "❌ Please enter a longer reminder message (at least 5 characters).",
        thread_ts: threadTs
      });
      return;
    }

    if (customMessage.trim().length > 500) {
      await client.chat.postMessage({
        channel: channelId,
        text: "❌ Reminder message is too long. Please keep it under 500 characters.",
        thread_ts: threadTs
      });
      return;
    }

    const finalMessage = `⏰ Reminder from admin: ${customMessage.trim()}`;    try {
      // First send a processing message to give user feedback
      const processingMsg = await client.chat.postMessage({
        channel: channelId,
        text: `⏳ Sending custom reminder to ${session.reminderData.reminderUserName}...`,
        thread_ts: threadTs
      });
      
      // Send the custom reminder through the cross-platform system
      const { sendReminder } = await import('./slackBot');
      
      await sendReminder({
        id: `admin_custom_reminder_${Date.now()}`,
        message: finalMessage,
        user_id: session.reminderData.reminderUserId!,
        task_id: `custom_${session.reminderData.reminderUserId}`
      });

      // Update the processing message with success confirmation
      if (processingMsg.ts) {
        await client.chat.update({
          channel: channelId,
          ts: processingMsg.ts,
          text: `✅ *Custom reminder sent successfully!*\n\n*To:* ${session.reminderData.reminderUserName}\n*Message:* ${finalMessage}`
        });
      } else {
        // Fallback if we can't update the processing message
        await client.chat.postMessage({
          channel: channelId,
          text: `✅ *Custom reminder sent successfully!*\n\n*To:* ${session.reminderData.reminderUserName}\n*Message:* ${finalMessage}`,
          thread_ts: threadTs
        });
      }

      console.log(`✅ Custom reminder sent to ${session.reminderData.reminderUserName}`);
      
      // Clear session
      delete reminderSessions[sessionKey];
      
    } catch (error) {
      console.error("Error sending custom reminder:", error);
      await client.chat.postMessage({
        channel: channelId,
        text: "❌ Error sending reminder. Please try again.",
        thread_ts: threadTs
      });
    }
    
  } catch (error) {
    console.error("Error handling custom reminder message:", error);
    await client.chat.postMessage({
      channel: channelId,
      text: "❌ Sorry, there was an error processing your message. Please try again.",
      thread_ts: threadTs
    });
  }
}

/**
 * Handle reminder cancellation
 */
export async function handleReminderCancellation(client: any, user: any, channelId: string, messageTs: string, threadTs?: string) {
  try {
    const sessionKey = user.id;
    
    // Clear session
    if (reminderSessions[sessionKey]) {
      delete reminderSessions[sessionKey];
    }

    // Update the message with cancellation
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "❌ *Reminder cancelled.*"
        }
      }
    ];

    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      blocks: blocks
    });
    
    console.log(`Reminder session cancelled for user ${user.name}`);
    
  } catch (error) {
    console.error("Error handling reminder cancellation:", error);
    await client.chat.postMessage({
      channel: channelId,
      text: "❌ Sorry, there was an error cancelling the reminder.",
      thread_ts: threadTs
    });
  }
}

/**
 * Check if user has active reminder session
 */
export function hasActiveReminderSession(userId: string): boolean {
  return reminderSessions[userId] !== undefined;
}

/**
 * Get active reminder session for user
 */
export function getReminderSession(userId: string): ReminderSessionState | undefined {
  return reminderSessions[userId];
}

/**
 * Clear reminder session for user
 */
export function clearReminderSession(userId: string): void {
  if (reminderSessions[userId]) {
    delete reminderSessions[userId];
  }
}

export { reminderSessions };

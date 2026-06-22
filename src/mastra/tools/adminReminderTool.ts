import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { hasReminderBeenSentRecently, storeNotificationLog } from "../../botManager";

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export function createAdminReminderTool(db: any) {
  return createTool({
    id: "admin_reminder",
    description: "Admin tool to send reminders to any user for their tasks or create custom reminders",
    inputSchema: z.object({
      adminEmail: z.string().describe("Admin's email address"),
      targetUserEmail: z.string().describe("Email of the user to send reminder to"),
      reminderType: z.enum(["task", "custom"]).describe("Type of reminder - 'task' for existing task reminder or 'custom' for new reminder"),
      taskName: z.string().optional().describe("Name of the task (required if reminderType is 'task')"),
      customMessage: z.string().optional().describe("Custom reminder message (required if reminderType is 'custom')"),
      reminderDateTime: z.string().describe("When to send the reminder (ISO datetime string)")
    }),
    execute: async ({ context }) => {
      const { adminEmail, targetUserEmail, reminderType, taskName, customMessage, reminderDateTime } = context;
      try {
        console.log(`Admin reminder request: ${adminEmail} -> ${targetUserEmail}`);

        // 1. Verify the requester is an admin
        const { data: adminUser, error: adminError } = await supabase
          .from("users")
          .select("id, role, organization_id")
          .eq("email", adminEmail)
          .single();

        if (adminError || !adminUser) {
          return {
            success: false,
            message: "Admin user not found"
          };
        }        if (adminUser.role !== 'admin' && adminUser.role !== 'manager') {
          return {
            success: false,
            message: "Only admins and managers can send reminders to other users"
          };
        }

        // 2. Find the target user
        const { data: targetUser, error: targetUserError } = await supabase
          .from("users")
          .select("id, name, email, organization_id")
          .eq("email", targetUserEmail)
          .single();

        if (targetUserError || !targetUser) {
          return {
            success: false,
            message: `User with email ${targetUserEmail} not found`
          };
        }

        // 3. Check if both users are in the same organization
        if (adminUser.organization_id !== targetUser.organization_id) {
          return {
            success: false,
            message: "You can only send reminders to users in your organization"
          };
        }

        let taskId = null;
        let reminderMessage = "";

        if (reminderType === "task") {
          if (!taskName) {
            return {
              success: false,
              message: "Task name is required for task reminders"
            };
          }          // 4. Find the task assigned to the target user
          const { data: task, error: taskError } = await supabase
            .from("tasks")
            .select("id, title, description, deadline, priority")
            .filter('assigned_to', 'cs', `["${targetUser.id}"]`)
            .ilike("title", `%${taskName}%`)
            .eq("status", "pending")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

          if (taskError || !task) {
            return {
              success: false,
              message: `No pending task found with name "${taskName}" for user ${targetUser.name}`
            };
          }

          taskId = task.id;
          reminderMessage = `⏰ Reminder from admin: Don't forget about your task "${task.title}"`;
          
          if (task.deadline) {
            const deadline = new Date(task.deadline).toLocaleDateString();
            reminderMessage += `\nDeadline: ${deadline}`;
          }
          
          if (task.priority) {
            reminderMessage += `\nPriority: ${task.priority}`;
          }
        } else {
          // Custom reminder
          if (!customMessage) {
            return {
              success: false,
              message: "Custom message is required for custom reminders"
            };
          }
          reminderMessage = `⏰ Reminder from admin: ${customMessage}`;        }
        
        // Generate a consistent task ID for deduplication
        let taskIdForDeduplication = '';
        if (reminderType === 'task' && taskId) {
          taskIdForDeduplication = taskId;
        } else {
          taskIdForDeduplication = `custom_${targetUser.id}`;
        }
        
        console.log(`🔍 Checking deduplication for user ${targetUser.id}, taskId: ${taskIdForDeduplication}`);
        
        // Check if this reminder was already sent recently to prevent duplicates
        // Only check for immediate reminders (within next 5 minutes)
        const reminderTime = new Date(reminderDateTime);
        const now = new Date();
        const isImmediate = (reminderTime.getTime() - now.getTime()) < 5 * 60 * 1000; // Within 5 minutes
        
        if (isImmediate) {
          const alreadySent = await hasReminderBeenSentRecently(
            targetUser.id,
            taskIdForDeduplication,
            reminderMessage
          );
          
          if (alreadySent) {
            console.log(`🚫 DEDUPLICATION: Reminder already sent recently for user ${targetUser.id}, task ${taskIdForDeduplication}`);
            return {
              success: false,
              message: "⚠️ This reminder was already sent recently. To avoid spam, duplicate reminders are prevented for a short period."
            };
          }
        }
        
        // 5. Create the reminder in the database
        const reminderData: any = {
          user_id: targetUser.id,
          message: reminderMessage,
          scheduled_for: new Date(reminderDateTime).toISOString(),
          created_at: new Date().toISOString(),
          sent: false,
          type: reminderType,
          reminder_time: new Date(reminderDateTime).toISOString(),
          organization_id: targetUser.organization_id,
          user_email: targetUser.email
        };

        // For task reminders, create a composite task ID (taskId_userId) to ensure targeted delivery
        if (taskId) {
          const compositeTaskId = `${taskId}_${targetUser.id}`;
          console.log(`📝 Creating targeted reminder with composite task ID: ${compositeTaskId}`);
          reminderData.task_id = compositeTaskId;
          reminderData.original_task_id = taskId; // Store the original task ID for reference
        }

        const { data: reminder, error: reminderError } = await supabase
          .from("reminders")
          .insert(reminderData)
          .select()
          .single();        if (reminderError) {
          console.error("Error creating reminder:", reminderError);
          return {
            success: false,
            message: `Error creating reminder: ${reminderError.message}`
          };
        }

        // Store notification log for deduplication tracking (for immediate reminders)
        if (isImmediate) {
          await storeNotificationLog(
            targetUser.id,
            taskIdForDeduplication,
            reminderMessage,
            'admin-tool'
          );
          console.log(`📝 Stored notification log for immediate reminder to prevent duplicates`);
        }

        return {
          success: true,
          message: `✅ Reminder scheduled successfully for ${targetUser.name} (${targetUser.email})`,
          reminderDetails: {
            targetUser: targetUser.name,
            targetEmail: targetUser.email,
            scheduledTime: new Date(reminderDateTime).toLocaleString(),
            message: reminderMessage,
            type: reminderType
          }
        };

      } catch (error) {
        console.error("Error in admin reminder tool:", error);
        return {
          success: false,
          message: "An unexpected error occurred while creating the reminder"
        };
      }
    }
  });
}

export function createGetUsersForAdminTool(db: any) {
  return createTool({
    id: "get_users_for_admin",
    description: "Admin tool to get list of all users in the organization for reminder purposes",
    inputSchema: z.object({
      adminEmail: z.string().describe("Admin's email address")
    }),
    execute: async ({ context }) => {
      const { adminEmail } = context;
      try {
        // 1. Verify the requester is an admin
        const { data: adminUser, error: adminError } = await supabase
          .from("users")
          .select("id, role, organization_id")
          .eq("email", adminEmail)
          .single();

        if (adminError || !adminUser) {
          return {
            success: false,
            message: "Admin user not found"
          };
        }        if (adminUser.role !== 'admin' && adminUser.role !== 'manager') {
          return {
            success: false,
            message: "Only admins and managers can view all users"
          };
        }

        // 2. Get all users in the same organization
        const { data: users, error: usersError } = await supabase
          .from("users")
          .select("id, name, email, role")
          .eq("organization_id", adminUser.organization_id)
          .order("name");

        if (usersError) {
          return {
            success: false,
            message: `Error fetching users: ${usersError.message}`
          };
        }

        return {
          success: true,
          users: users || [],
          message: `Found ${users?.length || 0} users in your organization`
        };

      } catch (error) {
        console.error("Error in get users for admin tool:", error);
        return {
          success: false,
          message: "An unexpected error occurred while fetching users"
        };
      }
    }
  });
}

export function createGetUserTasksForAdminTool(db: any) {
  return createTool({
    id: "get_user_tasks_for_admin",
    description: "Admin tool to get tasks for a specific user to send reminders about",
    inputSchema: z.object({
      adminEmail: z.string().describe("Admin's email address"),
      targetUserEmail: z.string().describe("Email of the user whose tasks to fetch")
    }),
    execute: async ({ context }) => {
      const { adminEmail, targetUserEmail } = context;
      try {
        // 1. Verify the requester is an admin
        const { data: adminUser, error: adminError } = await supabase
          .from("users")
          .select("id, role, organization_id")
          .eq("email", adminEmail)
          .single();

        if (adminError || !adminUser) {
          return {
            success: false,
            message: "Admin user not found"
          };
        }        if (adminUser.role !== 'admin' && adminUser.role !== 'manager') {
          return {
            success: false,
            message: "Only admins and managers can view other users' tasks"
          };
        }

        // 2. Find the target user
        const { data: targetUser, error: targetUserError } = await supabase
          .from("users")
          .select("id, name, email, organization_id")
          .eq("email", targetUserEmail)
          .single();

        if (targetUserError || !targetUser) {
          return {
            success: false,
            message: `User with email ${targetUserEmail} not found`
          };
        }

        // 3. Check if both users are in the same organization
        if (adminUser.organization_id !== targetUser.organization_id) {
          return {
            success: false,
            message: "You can only view tasks of users in your organization"
          };
        }        // 4. Get user's tasks
        const { data: tasks, error: tasksError } = await supabase
          .from("tasks")          .select(`
            id,
            title,
            description,
            status,
            priority,
            deadline,
            created_at,
            projects (name)
          `)
          .filter('assigned_to', 'cs', `["${targetUser.id}"]`)
          .in("status", ["pending", "in_progress"])
          .order("created_at", { ascending: false });

        if (tasksError) {
          return {
            success: false,
            message: `Error fetching tasks: ${tasksError.message}`
          };
        }

        return {
          success: true,
          user: {
            name: targetUser.name,
            email: targetUser.email
          },
          tasks: tasks || [],
          message: `Found ${tasks?.length || 0} active tasks for ${targetUser.name}`
        };

      } catch (error) {
        console.error("Error in get user tasks for admin tool:", error);
        return {
          success: false,
          message: "An unexpected error occurred while fetching user tasks"
        };
      }
    }
  });
}

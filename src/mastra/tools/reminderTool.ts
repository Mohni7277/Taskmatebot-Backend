import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export function createReminderTool(db: any) {
  return createTool({
    id: "create_reminder",
    description: "Creates a reminder for a task",    inputSchema: z.object({
      taskName: z.string().describe("The name of the task to create a reminder for"),
      scheduledFor: z.string().describe("When the reminder should be sent (ISO date string or natural language)"),
      message: z.string().optional().describe("Optional custom message for the reminder"),
      userName: z.string().optional().describe("Optional name of the user to filter tasks by assignee"),
      userEmail: z.string().optional().describe("Optional email of the user to filter tasks by assignee"),
      actualUserEmail: z.string().describe("The ACTUAL email of the user making the request (from context, cannot be overridden)"),
    }),    execute: async ({ context }) => {
      const { taskName, scheduledFor, message, userName, userEmail, actualUserEmail } = context

      try {
        // CRITICAL SECURITY CHECK: Always use actualUserEmail from context, never trust user input
        const ACTUAL_USER_EMAIL = actualUserEmail;
        
        if (!ACTUAL_USER_EMAIL) {
          throw new Error("❌ Security Error: User authentication required. Please log in again.");
        }
        
        // Get the ACTUAL user's details and role from database (never trust user claims)
        const { data: actualUser, error: userError } = await supabase
          .from("users")
          .select("id, name, role, organization_id")
          .eq("email", ACTUAL_USER_EMAIL)
          .single();
          
        if (userError || !actualUser) {
          throw new Error("❌ Security Error: User not found in database. Please contact administrator.");
        }
        
        const ACTUAL_USER_ROLE = actualUser.role;
        const ACTUAL_USER_ID = actualUser.id;
        const ACTUAL_USER_ORG_ID = actualUser.organization_id;
        
        console.log(`🔒 SECURITY CHECK: Actual user: ${ACTUAL_USER_EMAIL}, Role: ${ACTUAL_USER_ROLE}, ID: ${ACTUAL_USER_ID}`);
        
        // If user is trying to create reminder for someone else, they must be admin
        if (userEmail && userEmail.toLowerCase() !== ACTUAL_USER_EMAIL.toLowerCase()) {
          if (ACTUAL_USER_ROLE !== "admin") {
            throw new Error("❌ Access denied. Only verified admins can create reminders for other users.");
          }
        }
        let userId = null

        // If user name and email are provided, find the user ID
        if (userName && userEmail) {
          console.log(`Looking up user with name: ${userName} and email: ${userEmail}`)

          // First try to find by exact email match (more reliable)
          const { data: userByEmail, error: emailSearchError } = await supabase
            .from("users")
            .select("id, name, email")
            .eq("email", userEmail)
            .single()

          if (!emailSearchError && userByEmail) {
            userId = userByEmail.id
            console.log(`Found user by email: ${userByEmail.name} (ID: ${userId})`)
          } else {
            // If not found by email, try to find by name
            console.log(`User not found by email, trying to find by name: ${userName}`)
            const { data: usersByName, error: nameSearchError } = await supabase
              .from("users")
              .select("id, name, email")
              .ilike("name", `%${userName}%`)

            if (!nameSearchError && usersByName && usersByName.length > 0) {
              // If multiple users found, try to find the best match
              const exactMatch = usersByName.find(
                (u) =>
                  u.name.toLowerCase() === userName.toLowerCase() || u.email.toLowerCase() === userEmail.toLowerCase(),
              )

              if (exactMatch) {
                userId = exactMatch.id
                console.log(`Found user by name: ${exactMatch.name} (ID: ${userId})`)
              } else {
                // Just use the first one if no exact match
                userId = usersByName[0].id
                console.log(`Using first matching user: ${usersByName[0].name} (ID: ${userId})`)
              }
            } else {
              console.log(`No user found with name: ${userName}`)
            }
          }
        }

        // Find tasks matching the name
        let query = supabase
          .from("tasks")
          .select("*")
          .ilike("title", `%${taskName}%`)
          .order("created_at", { ascending: false })        // Filter by user ID if found
        if (userId) {
          query = query.filter('assigned_to', 'cs', `["${userId}"]`) // Fix: properly format user ID for JSONB containment
          console.log(`Filtering tasks by user ID: ${userId}`)
        }

        const { data: tasks, error: searchError } = await query

        if (searchError) {
          console.error("Error searching for tasks:", searchError)
          throw searchError
        }

        if (!tasks || tasks.length === 0) {
          const message = userId
            ? `No task found with name "${taskName}" assigned to ${userName} (${userEmail})`
            : `No task found with name "${taskName}"`

          console.log(message)
          return {
            success: false,
            message,
          }
        }

        // If multiple tasks match, use the most recent one
        const task = tasks[0]

        // Parse the scheduled time
        let scheduledTime: Date
        try {
          // Try to parse as ISO date first
          scheduledTime = new Date(scheduledFor)

          // Check if the date is valid
          if (isNaN(scheduledTime.getTime())) {
            throw new Error("Invalid date")
          }
        } catch (e) {
          console.error("Error parsing scheduled time:", e)
          return {
            success: false,
            message: "Invalid date format for scheduledFor. Please use ISO date string.",
          }
        }

        console.log(
          `Creating reminder for task "${task.title}" (ID: ${task.id}) scheduled for ${scheduledTime.toISOString()}`,
        )

        // Create the reminder
        const { data: reminder, error: createError } = await supabase
          .from("reminders")
          .insert({
            task_id: task.id,
            scheduled_for: scheduledTime.toISOString(),
            message: message || `Reminder for task: ${task.title}`,
            sent: false,
            created_at: new Date().toISOString(),
          })
          .select()
          .single()

        if (createError) {
          console.error("Error creating reminder:", createError)
          throw createError
        }

        console.log(`Successfully created reminder with ID: ${reminder.id}`)
        return {
          success: true,
          reminderId: reminder.id,
          taskId: task.id,
          taskName: task.title,
          scheduledFor: scheduledTime.toISOString(),
          message: `Reminder set for task "${task.title}" at ${scheduledTime.toLocaleString()}`,
        }
      } catch (error) {
        console.error("Error in create_reminder tool:", error)
        return {
          success: false,
          message: "An unexpected error occurred",
          error: error instanceof Error ? error.message : "Unknown error",
        }
      }
    },
  })
}

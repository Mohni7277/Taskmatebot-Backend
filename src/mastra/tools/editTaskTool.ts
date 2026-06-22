import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"
import { parseWeekName } from "../../utils/dateUtils"
import dotenv from "dotenv"

dotenv.config()

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export function createEditTaskTool(db: any) {
  return createTool({
    id: "edit_task",
    description: "Edit and update various properties of an existing task including title, description, priority, deadline, assignee, project, etc.",
    inputSchema: z.object({
      taskIdentifier: z.string().describe("The task ID, title, or partial title to identify the task to edit"),
      userEmail: z.string().email().describe("Email address of the user requesting the edit"),
      newTitle: z.string().optional().describe("New title for the task"),
      newDescription: z.string().optional().describe("New description for the task"),
      newStatus: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional().describe("New status for the task"),
      newPriority: z.enum(["low", "medium", "high", "urgent"]).optional().describe("New priority level for the task"),
      newDeadline: z.string().optional().describe("New due date in DD/MM/YYYY format, day number (e.g., '12'), or relative terms like 'tomorrow', 'next week'"),
      newAssigneeEmail: z.string().email().optional().describe("Email of the new person to assign the task to"),
      newProjectName: z.string().optional().describe("Name of the new project to assign this task to"),
      organizationId: z.string().optional().describe("Organization ID if specified directly"),
    }),
    execute: async ({ context }) => {
      const { 
        taskIdentifier,
        userEmail,
        newTitle,
        newDescription,
        newStatus,
        newPriority,
        newDeadline,
        newAssigneeEmail,
        newProjectName,
        organizationId: directOrganizationId
      } = context

      try {
        console.log(`🔧 Editing task "${taskIdentifier}" requested by ${userEmail}`)
        
        // Find the user first and get their organization
        const { data: user, error: userError } = await supabase
          .from("users")
          .select("id, name, email, organization_id, role")
          .eq("email", userEmail)
          .single()

        if (userError || !user) {
          console.error("❌ User not found:", userError)
          return {
            success: false,
            error: "User not found",
            message: `User with email ${userEmail} not found in the system`,
          }
        }

        const organizationId = directOrganizationId || user.organization_id

        if (!organizationId) {
          return {
            success: false,
            error: "No organization",
            message: "User must be associated with an organization to edit tasks",
          }
        }

        console.log(`👤 User found: ${user.name} (${user.email}) in organization ${organizationId}`)        // Find the task to edit
        let taskQuery = supabase
          .from("tasks")
          .select(`
            id,
            title,
            description,
            status,
            priority,
            deadline,
            assigned_to,
            project_id,
            organization_id,
            created_by,
            projects (
              id,
              name,
              team_id
            )
          `)
          .eq("organization_id", organizationId)

        // Try to find task by ID first, then by title
        let task = null
        let taskError = null

        // Check if taskIdentifier looks like a UUID (task ID)
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        
        if (uuidRegex.test(taskIdentifier)) {
          // Search by ID
          const { data, error } = await taskQuery.eq("id", taskIdentifier).single()
          task = data
          taskError = error
        } else {
          // Search by title (exact match first, then partial)
          const { data: exactMatch, error: exactError } = await taskQuery.ilike("title", taskIdentifier).single()
          
          if (exactMatch) {
            task = exactMatch
          } else {
            // Try partial match
            const { data: partialMatches, error: partialError } = await taskQuery.ilike("title", `%${taskIdentifier}%`)
            
            if (partialMatches && partialMatches.length === 1) {
              task = partialMatches[0]
            } else if (partialMatches && partialMatches.length > 1) {
              return {
                success: false,
                error: "Multiple tasks found",
                message: `Multiple tasks found matching "${taskIdentifier}". Please be more specific or use the task ID.`,
                suggestions: partialMatches.slice(0, 5).map(t => `"${t.title}" (ID: ${t.id})`),
              }
            } else {
              taskError = partialError || { message: "Task not found" }
            }
          }
        }

        if (taskError || !task) {
          console.error("❌ Task not found:", taskError)
          return {
            success: false,
            error: "Task not found",
            message: `Task "${taskIdentifier}" not found in your organization`,
          }
        }        console.log(`📋 Found task: ${task.title} (${task.id})`)

        // Check permissions - user must be assigned to the task, be the creator, or be an admin/team lead
        // FIXED: Handle assigned_to as JSONB array
        const assignedToIds = Array.isArray(task.assigned_to) ? task.assigned_to : [task.assigned_to]
        const isAssigned = assignedToIds.includes(user.id)
        const isCreator = task.created_by === user.id
        const isAdmin = user.role === "admin"
          // Check if user is team lead for the task's project team
        let isTeamLead = false
        const projectData = Array.isArray(task.projects) ? task.projects[0] : task.projects
        if (projectData && projectData.team_id) {
          const { data: teamLead } = await supabase
            .from("teams")
            .select("team_lead")
            .eq("id", projectData.team_id)
            .single()
          
          isTeamLead = teamLead?.team_lead === user.id
        }

        const hasPermission = isAssigned || isCreator || isAdmin || isTeamLead

        if (!hasPermission) {
          return {
            success: false,
            error: "Permission denied",
            message: "You can only edit tasks that are assigned to you, created by you, or if you are an admin/team lead",
          }
        }

        // Prepare update data
        const updateData: any = {
          updated_at: new Date().toISOString()
        }
        let changes: string[] = []

        // Update title
        if (newTitle && newTitle !== task.title) {
          updateData.title = newTitle
          changes.push(`Title: "${task.title}" → "${newTitle}"`)
        }

        // Update description
        if (newDescription && newDescription !== task.description) {
          updateData.description = newDescription
          changes.push(`Description updated`)
        }

        // Update status
        if (newStatus && newStatus !== task.status) {
          updateData.status = newStatus
          changes.push(`Status: "${task.status}" → "${newStatus}"`)
        }

        // Update priority
        if (newPriority && newPriority !== task.priority) {
          updateData.priority = newPriority
          changes.push(`Priority: "${task.priority}" → "${newPriority}"`)
        }        // Update deadline
        if (newDeadline) {
          let formattedDeadline = null
          
          // Handle relative terms like "tomorrow", "next week"
          if (newDeadline.toLowerCase().includes('week')) {
            formattedDeadline = parseWeekName(newDeadline)
          } else if (/^\d{1,2}$/.test(newDeadline)) {
            // Handle single day number (e.g., "12") - use current month/year
            const day = parseInt(newDeadline);
            const now = new Date();
            const currentMonth = now.getMonth(); // 0-based
            const currentYear = now.getFullYear();
            
            if (day >= 1 && day <= 31) {
              const targetDate = new Date(currentYear, currentMonth, day);
              formattedDeadline = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD format for DB
            }
          } else if (newDeadline.includes('/')) {
            // Handle DD/MM/YYYY format
            const [day, month, year] = newDeadline.split("/")
            formattedDeadline = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
          } else if (newDeadline.includes('-')) {
            // Handle DD-MM-YYYY format
            const [day, month, year] = newDeadline.split("-")
            formattedDeadline = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
          } else {
            // Handle relative terms
            const now = new Date()
            const tomorrow = new Date(now)
            tomorrow.setDate(now.getDate() + 1)
            
            switch (newDeadline.toLowerCase()) {
              case 'today':
                formattedDeadline = now.toISOString().split('T')[0]
                break
              case 'tomorrow':
                formattedDeadline = tomorrow.toISOString().split('T')[0]
                break
              default:
                formattedDeadline = newDeadline // Keep as is and let DB handle it
            }
          }

          if (formattedDeadline !== task.deadline) {
            updateData.deadline = formattedDeadline
            const oldDeadline = task.deadline ? new Date(task.deadline).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '/') : "No deadline"
            const newDeadlineDisplay = formattedDeadline ? new Date(formattedDeadline).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '/') : "No deadline"
            changes.push(`Deadline: ${oldDeadline} → ${newDeadlineDisplay}`)
          }
        }

        // Update assignee
        if (newAssigneeEmail) {
          const { data: newAssignee, error: assigneeError } = await supabase
            .from("users")
            .select("id, name, email, organization_id")
            .eq("email", newAssigneeEmail)
            .eq("organization_id", organizationId)
            .single()

          if (assigneeError || !newAssignee) {
            return {
              success: false,
              error: "Assignee not found",
              message: `User with email ${newAssigneeEmail} not found in your organization`,
            }
          }          if (!assignedToIds.includes(newAssignee.id)) {
            updateData.assigned_to = [newAssignee.id] // Store as JSONB array
            changes.push(`Assigned to: Previous assignees → ${newAssignee.name}`)
          }
        }

        // Update project
        if (newProjectName) {
          const { data: newProject, error: projectError } = await supabase
            .from("projects")
            .select("id, name, team_id")
            .ilike("name", newProjectName)
            .eq("organization_id", organizationId)
            .single()

          if (projectError || !newProject) {
            return {
              success: false,
              error: "Project not found",
              message: `Project "${newProjectName}" not found in your organization`,
            }
          }          if (newProject.id !== task.project_id) {
            updateData.project_id = newProject.id
            const projectData = Array.isArray(task.projects) ? task.projects[0] : task.projects
            const oldProject = projectData?.name || "No project"
            changes.push(`Project: ${oldProject} → ${newProject.name}`)
          }
        }

        // If no changes were made
        if (changes.length === 0) {
          return {
            success: true,
            message: "No changes were made - all provided values are the same as current values",
            taskId: task.id,
            taskTitle: task.title,
          }
        }        // Apply the updates
        const { data: updatedTask, error: updateError } = await supabase
          .from("tasks")
          .update(updateData)
          .eq("id", task.id)
          .select(`
            id,
            title,
            description,
            status,
            priority,
            deadline,
            assigned_to,
            projects (
              name
            )
          `)
          .single()

        if (updateError) {
          console.error("❌ Error updating task:", updateError)
          return {
            success: false,
            error: "Update failed",
            message: `Error updating task: ${updateError.message}`,
          }
        }        console.log(`✅ Task updated successfully: ${updatedTask.title}`);
          return {
          success: true,
          message: `Task "${updatedTask.title}" has been updated successfully`,
          taskId: updatedTask.id,
          taskTitle: updatedTask.title,
          changes: changes,          updatedTask: {
            title: updatedTask.title,
            project: Array.isArray(updatedTask.projects) 
              ? (updatedTask.projects[0] as any)?.name 
              : (updatedTask.projects as any)?.name,
            status: updatedTask.status,
            priority: updatedTask.priority,
            deadline: updatedTask.deadline,
            assignedTo: Array.isArray(updatedTask.assigned_to) && updatedTask.assigned_to.length > 0
              ? `${updatedTask.assigned_to.length} user(s) assigned`
              : "No assignees"
          }
        }

      } catch (error) {
        console.error("❌ Error in edit_task tool:", error)
        return {
          success: false,
          error: "Internal error",
          message: `Error editing task: ${error instanceof Error ? error.message : "Unknown error"}`,
        }
      }
    },
  })
}

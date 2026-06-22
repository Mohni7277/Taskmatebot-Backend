import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export function createStatusTool(db: any) {
  return createTool({
    id: "update_status",
    description: "Updates the status of a task for a specific user",
    inputSchema: z.object({
      taskName: z.string().describe("Name or title of the task to update"),
      status: z.string().describe("New status for the task (pending, in_progress, completed, cancelled)"),
      userName: z.string().describe("Full name of the user"),
      userEmail: z.string().email().describe("Email address of the user"),
      organizationId: z.string().optional().describe("Organization ID if specified directly")
    }),
    execute: async ({ context }) => {
      const { taskName, status, userName, userEmail, organizationId: directOrganizationId } = context

      try {
        console.log(`🔄 Updating task "${taskName}" to status "${status}" for ${userName} (${userEmail})`)
        
        // Find the user first and get their organization
        const { data: user, error: userError } = await supabase
          .from("users")
          .select("id, name, email, organization_id")
          .eq("email", userEmail)
          .single()
        
        if (userError || !user) {
          console.log(`❌ User not found: ${userEmail}`)
          return {
            success: false,
            message: `User not found with email: ${userEmail}`,
            taskName,
            status
          }
        }
        
        // Use directly provided organization ID or fall back to user's organization
        const organizationId = directOrganizationId || user.organization_id
        
        if (!organizationId) {
          console.log(`❌ No organization found for user: ${userEmail}`)
          return {
            success: false,
            message: `No organization associated with user: ${userEmail}`,
            taskName,
            status
          }
        }
        
        console.log(`✅ Found user: ${user.name} (${user.id}) in organization: ${organizationId}`)
        
        // Get organization name for reference
        const { data: organization } = await supabase
          .from("organizations")
          .select("name")
          .eq("id", organizationId)
          .single()
        
        const organizationName = organization?.name || "Unknown Organization"
        
        // Normalize the status - convert 'done' to 'completed' if needed
        let normalizedStatus = status.toLowerCase().trim()
        if (normalizedStatus === 'done' || normalizedStatus === 'complete' || normalizedStatus === 'finished') {
          normalizedStatus = 'completed'
        }
        
        // Validate status
        const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled']
        if (!validStatuses.includes(normalizedStatus)) {
          return {
            success: false,
            message: `Invalid status "${status}". Please use one of: ${validStatuses.join(', ')}`,
            taskName,
            status,
            organizationName
          }
        }
          // Find the task by name for this user within their organization        console.log(`🔍 Looking for task: ${taskName} in organization: ${organizationId}`)
        const { data: tasks, error: searchError } = await supabase
          .from("tasks")
          .select(`
            id,            title,
            status,
            assigned_to,
            organization_id,
            projects (
              name
            )          `)          .eq("organization_id", organizationId) // Filter by organization
          .filter('assigned_to', 'cs', `["${user.id}"]`) // Fix: properly format user ID for JSONB containment
          .ilike("title", `%${taskName}%`)
        
        if (searchError) {
          console.error("❌ Error searching for task:", searchError)
          return {
            success: false,
            message: `Error searching for task: ${searchError.message}`,
            taskName,
            status,
            organizationName
          }
        }
        
        if (!tasks || tasks.length === 0) {
          console.log(`❌ No tasks found matching: ${taskName} in organization: ${organizationId}`)
          return {
            success: false,
            message: `No tasks found matching "${taskName}" for ${userName} in ${organizationName}`,
            taskName,
            status,
            organizationName
          }
        }
        
        // If multiple tasks found, use the first exact match or the first partial match
        let selectedTask = tasks.find(task => task.title.toLowerCase() === taskName.toLowerCase())
        if (!selectedTask) {
          selectedTask = tasks[0]
        }
        
        console.log(`✅ Found task: ${selectedTask.title} (current status: ${selectedTask.status})`)
        
        // Verify the task belongs to the correct organization
        if (selectedTask.organization_id !== organizationId) {
          console.log(`⚠️ Task ${selectedTask.id} belongs to organization ${selectedTask.organization_id}, but user is in ${organizationId}`)
          return {
            success: false,
            message: `You don't have permission to update this task as it belongs to a different organization`,
            taskName,
            status,
            organizationName
          }
        }
        
        // Check if the task is already in the requested status
        if (selectedTask.status === normalizedStatus) {
          return {
            success: true,
            message: `Task "${selectedTask.title}" is already ${normalizedStatus}`,
            taskName: selectedTask.title,
            status: normalizedStatus,
            noChange: true,
            organizationName,
            organizationId
          }
        }
          // Update the task status
        console.log(`🔄 Updating task status from ${selectedTask.status} to ${normalizedStatus}`)
        
        const { data: updatedTask, error: updateError } = await supabase
          .from("tasks")          .update({ 
            status: normalizedStatus,
            updated_at: new Date().toISOString()
          })
          .eq("id", selectedTask.id)
          .filter('assigned_to', 'cs', `["${user.id}"]`) // Fix: properly format user ID for JSONB containment
          .eq("organization_id", organizationId) // Ensure organization match
          .select("id, title, status, organization_id")
          .single()
        
        if (updateError) {
          console.error("❌ Error updating task:", updateError)
          return {
            success: false,
            message: `Error updating task: ${updateError.message}`,
            taskName,
            status,
            organizationName
          }
        }
        
        if (!updatedTask) {
          return {
            success: false,
            message: `Task not found or you don't have permission to update it`,
            taskName,
            status,
            organizationName
          }
        }
        
        console.log(`✅ Task updated successfully: ${updatedTask.title} -> ${updatedTask.status} in organization ${organizationId}`)
        
        return {
          success: true,
          message: `Task "${updatedTask.title}" has been updated to ${updatedTask.status}`,
          taskName: updatedTask.title,
          status: updatedTask.status,
          userName: user.name,
          userEmail: user.email,
          organizationName,
          organizationId
        }
      } catch (error) {
        console.error("❌ Error in update_status tool:", error)
        return {
          success: false,
          message: "An unexpected error occurred while updating task status",
          error: error instanceof Error ? error.message : "Unknown error",
          taskName,
          status
        }
      }
    }
  })
}
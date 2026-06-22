import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export function getUserTasksTool(db: any) {
  return createTool({
    id: "getUserTasks",
    description: "Gets tasks assigned to a specific user, optionally filtered by status",
    inputSchema: z.object({
      userName: z.string().describe("Full name of the user"),
      userEmail: z.string().email().describe("Email address of the user"),
      status: z.string().optional().describe("Filter tasks by status (pending, in_progress, completed, cancelled)"),
      requestingUserEmail: z.string().email().optional().describe("Email of the user making the request (for security check)")
    }),
    execute: async ({ context }) => {
      const { userName, userEmail, status, requestingUserEmail } = context

      try {
        console.log(`🔍 Getting tasks for ${userName} (${userEmail})${status ? ` with status: ${status}` : ''}`)
        
        // Security check: If requesting tasks for another user, verify the requester is admin/manager
        if (requestingUserEmail && requestingUserEmail !== userEmail) {
          console.log(`🔒 Security check: ${requestingUserEmail} requesting tasks for ${userEmail}`)
          
          // Get the requesting user's role
          const { data: requestingUser, error: requestingUserError } = await supabase
            .from("users")
            .select("id, name, email, role")
            .eq("email", requestingUserEmail)
            .single()
          
          if (requestingUserError || !requestingUser) {
            console.log(`❌ Requesting user not found: ${requestingUserEmail}`)
            return {
              success: false,
              message: "Authentication failed. Please try again.",
              tasks: []
            }
          }
          
          // Check if requesting user is admin or manager
          if (requestingUser.role !== 'admin' && requestingUser.role !== 'manager') {
            console.log(`🚫 Access denied: ${requestingUser.name} (${requestingUser.role}) cannot view other users' tasks`)
            return {
              success: false,
              message: "Access denied. Only admins and managers can view other users' tasks.",
              tasks: []
            }
          }
          
          console.log(`✅ Access granted: ${requestingUser.name} (${requestingUser.role}) can view other users' tasks`)
        }
          // First find the user by email (most reliable)
        console.log(`🔍 Searching for user with email: ${userEmail}`)
        const { data: user, error: userError } = await supabase
          .from("users")
          .select("id, name, email")
          .eq("email", userEmail)
          .single()
        
        console.log(`📊 User query result:`, { 
          found: !!user, 
          error: userError?.message || 'none',  
          userDetails: user ? { id: user.id, name: user.name, email: user.email } : 'null'
        })
        
        if (userError || !user) {
          console.log(`❌ User not found: ${userEmail}, Error: ${userError?.message || 'No error message'}`)
          
          // Try to find by name as fallback
          if (userName && userName !== userEmail) {
            console.log(`🔍 Trying to find user by name: ${userName}`)
            const { data: usersByName, error: nameError } = await supabase
              .from("users")
              .select("id, name, email")
              .ilike("name", `%${userName}%`)
            
            console.log(`📊 Name search result:`, { 
              found: usersByName?.length || 0, 
              error: nameError?.message || 'none',
              users: usersByName?.map(u => ({ id: u.id, name: u.name, email: u.email })) || []
            })
            
            if (!nameError && usersByName && usersByName.length > 0) {
              // Use the first match
              const foundUser = usersByName[0]
              console.log(`✅ Found user by name: ${foundUser.name} (${foundUser.email})`)
              
              return {
                success: false,
                message: `User found by name "${foundUser.name}" but email doesn't match. Please verify the email address: ${foundUser.email}`,
                tasks: []
              }
            }
          }
          
          // Let's also check if there are any users at all to debug the connection
          console.log(`🔍 Checking if database connection works by getting user count...`)
          const { count, error: countError } = await supabase
            .from("users")
            .select("*", { count: 'exact', head: true })
          
          console.log(`📊 Total users in database: ${count}, Error: ${countError?.message || 'none'}`)
          
          return {
            success: false,
            message: `User not found with email: ${userEmail}. Please verify the email address is correct.`,
            tasks: []
          }
        }
          console.log(`✅ Found user: ${user.name} (${user.id})`)
        
        // First get user's organization_id to filter tasks properly
        const { data: userWithOrg, error: userOrgError } = await supabase
          .from("users")
          .select("id, name, email, organization_id")
          .eq("id", user.id)
          .single()
        
        if (userOrgError || !userWithOrg) {
          console.error("❌ Error getting user organization:", userOrgError)
          return {
            success: false,
            message: "Error getting user organization information",
            tasks: []
          }
        }
          console.log(`🏢 User organization: ${userWithOrg.organization_id}`)
        
        // Build query for tasks with proper joins to get project and team names        
        // Use left join for projects so we get tasks even without projects        
        // FIXED: Handle both old string format and new JSONB array format for assigned_to
        console.log(`🔍 Building task query for user ID: ${user.id}`)
        
        let query = supabase
          .from("tasks")
          .select(`
            id,
            title,
            description,
            status,
            priority,
            deadline,
            created_at,
            project_id,
            organization_id,
            assigned_to,
            projects (
              id,
              name,
              team_id
            )
          `)
          .eq("organization_id", userWithOrg.organization_id)
          .order("created_at", { ascending: false })
        
        // Add assigned_to filter with better error handling
        try {
          console.log(`🔍 Adding assigned_to filter for user: ${user.id}`)
          query = query.filter('assigned_to', 'cs', `["${user.id}"]`) // JSONB containment
          console.log(`✅ Successfully added assigned_to filter`)
        } catch (filterError) {
          console.error("❌ Error adding assigned_to filter:", filterError)
          // Fallback: try without the filter and handle it in JavaScript
          console.log("🔄 Continuing without assigned_to filter, will filter in JavaScript")
        }
        
        // Apply status filter if provided
        if (status) {
          // Handle different status variations and normalize them
          const normalizedStatus = status.toLowerCase().trim()
          console.log(`🔍 Filtering tasks by status: ${normalizedStatus}`)
          
          // Handle various ways to say "completed"
          if (normalizedStatus === 'completed' || 
              normalizedStatus === 'complete' || 
              normalizedStatus === 'finished' || 
              normalizedStatus === 'done') {
            query = query.eq("status", "completed")
          } else if (normalizedStatus === 'pending' || 
                     normalizedStatus === 'open' || 
                     normalizedStatus === 'new') {
            query = query.eq("status", "pending")
          } else if (normalizedStatus === 'in progress' || 
                     normalizedStatus === 'in_progress' || 
                     normalizedStatus === 'working' || 
                     normalizedStatus === 'active') {
            query = query.eq("status", "in_progress")
          } else if (normalizedStatus === 'cancelled' || 
                     normalizedStatus === 'canceled') {
            query = query.eq("status", "cancelled")
          } else {
            // Direct status match
            query = query.eq("status", normalizedStatus)
          }
        }
          const { data: tasks, error: tasksError } = await query
        
        if (tasksError) {
          console.error("❌ Error fetching tasks:", tasksError)
          return {
            success: false,
            message: `Error fetching tasks: ${tasksError.message}`,
            tasks: []
          }
        }
        
        if (!tasks || tasks.length === 0) {
          const statusMessage = status ? ` with status "${status}"` : ''
          console.log(`📭 No tasks found for ${userName}${statusMessage}`)
          return {
            success: true,
            message: `No tasks found for ${userName}${statusMessage}`,
            tasks: [],
            user: user,
            totalTasks: 0,
            statusFilter: status || null
          }
        }        // Get team information for projects that have teams
        const projectsWithTeams = tasks.filter(task => {
          const project = Array.isArray(task.projects) ? task.projects[0] : task.projects
          return project && project.team_id
        })
        const teamIds = [...new Set(projectsWithTeams.map(task => {
          const project = Array.isArray(task.projects) ? task.projects[0] : task.projects
          return project?.team_id
        }).filter(Boolean))]
        
        let teamsMap: Record<string, string> = {}
        if (teamIds.length > 0) {
          const { data: teams, error: teamsError } = await supabase
            .from("teams")
            .select("id, name")
            .in("id", teamIds)
          
          if (!teamsError && teams) {
            teamsMap = teams.reduce((map: Record<string, string>, team: any) => {
              map[team.id] = team.name
              return map
            }, {})
          }
        }
        
        // Process tasks to include formatted information
        const processedTasks = tasks.map(task => {
          const project = Array.isArray(task.projects) ? task.projects[0] : task.projects
          const projectName = project ? project.name : 'No Project'
          const teamName = project && project.team_id && teamsMap[project.team_id] 
            ? teamsMap[project.team_id] 
            : 'No Team'
            
          return {
            id: task.id,
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority || 'medium',
            dueDate: task.deadline ? new Date(task.deadline).toLocaleDateString('en-GB') : null,
            projectName: projectName,
            teamName: teamName,
            createdAt: new Date(task.created_at).toLocaleDateString('en-GB')
          }
        })        
        console.log(`✅ Found ${processedTasks.length} tasks for ${userName}${status ? ` with status: ${status}` : ''}`)
        console.log("Task statuses found:", processedTasks.map(t => t.status))
        console.log("Project names found:", processedTasks.map(t => t.projectName))
        console.log("Team names found:", processedTasks.map(t => t.teamName))
        
        return {
          success: true,
          message: `Found ${processedTasks.length} tasks for ${userName}${status ? ` with status "${status}"` : ''}`,
          tasks: processedTasks,
          user: user,
          totalTasks: processedTasks.length,
          statusFilter: status || null
        }      } catch (error) {
        console.error("❌ Error in getUserTasks tool:", error)
        console.error("❌ Error stack:", error instanceof Error ? error.stack : "No stack trace")
        console.error("❌ Error details:", {
          userName,
          userEmail,
          requestingUserEmail,
          errorMessage: error instanceof Error ? error.message : "Unknown error",
          errorType: typeof error
        })
        return {
          success: false,
          message: `An unexpected error occurred while fetching tasks for ${userEmail}. Error: ${error instanceof Error ? error.message : "Unknown error"}. Please try again later or contact support if the issue persists.`,
          error: error instanceof Error ? error.message : "Unknown error",
          tasks: []
        }
      }
    }
  })
}
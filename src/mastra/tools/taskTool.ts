import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"
import { parseWeekName } from "../../utils/dateUtils"
import { sendNewTaskAssignmentNotification } from "../../health"
import dotenv from "dotenv"

dotenv.config()

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export function createTaskTool(db: any) {
  return createTool({
    id: "create_task",
    description: "Creates a new task from the user request",    inputSchema: z.object({
      title: z.string().describe("A clear, concise title for the task"),
      description: z.string().describe("A detailed description of what the task involves"),
      dueDate: z.string().optional().describe("The due date for the task in DD/MM/YYYY or DD-MM-YYYY format, if specified"),
      priority: z
        .enum(["low", "medium", "high", "urgent"])
        .optional()
        .default("medium")
        .describe("The priority level of the task"),
      assigneeNames: z.array(z.string()).optional().describe("Array of names of people the task is assigned to"),
      assigneeEmails: z.array(z.string()).optional().describe("Array of email addresses of people the task is assigned to"),
      assigneeName: z.string().optional().describe("The name of the person the task is assigned to (single assignee case)"),
      emailAddress: z.string().optional().describe("The email address of the person the task is assigned to (single assignee case)"),
      projectName: z.string().optional().describe("The name of the project this task belongs to"),
      teamName: z.string().optional().describe("The name of the team this project belongs to"),
      weekName: z.string().optional().describe('Week name like "this week", "next week", etc. if mentioned'),
      CreatedBy: z.string().optional().describe("The name of the person creating the task"),
      CreatedByEmail: z.string().optional().describe("The email of the person creating the task"),
      organizationId: z.string().optional().describe("The organization ID if specified directly"),
      actualUserEmail: z.string().describe("The ACTUAL email of the user making the request (from context, cannot be overridden)"),
      AUTHENTICATED_USER_EMAIL: z.string().optional().describe("SECURITY: Authenticated user email from secure context"),
      AUTHENTICATED_USER_NAME: z.string().optional().describe("SECURITY: Authenticated user name from secure context"),
      AUTHENTICATED_USER_ID: z.string().optional().describe("SECURITY: Authenticated user ID from secure context"),
      AUTHENTICATED_USER_ORG_ID: z.string().optional().describe("SECURITY: Authenticated user organization ID from secure context"),
    }),    execute: async ({ context }) => {
      const { 
        title, 
        description, 
        dueDate, 
        priority, 
        assigneeName, 
        emailAddress,
        assigneeNames,
        assigneeEmails, 
        projectName, 
        weekName,        CreatedBy, 
        CreatedByEmail,
        organizationId: directOrganizationId,
        actualUserEmail,
        AUTHENTICATED_USER_EMAIL,
        AUTHENTICATED_USER_NAME,
        AUTHENTICATED_USER_ID,
        AUTHENTICATED_USER_ORG_ID
      } = context
      
      let teamName = context.teamName // Make teamName mutable
      
      try {
        // ULTIMATE SECURITY CHECK: Use AUTHENTICATED_* parameters if available, fallback to actualUserEmail
        const ACTUAL_USER_EMAIL = AUTHENTICATED_USER_EMAIL || actualUserEmail;
        
        if (!ACTUAL_USER_EMAIL) {
          throw new Error("❌ Security Error: User authentication required. Please log in again.");
        }
        
        console.log(`🔒 ULTIMATE SECURITY: Using authenticated email: ${ACTUAL_USER_EMAIL}`);
        console.log(`🔒 SECURITY DEBUG: AUTHENTICATED_USER_EMAIL: ${AUTHENTICATED_USER_EMAIL}, actualUserEmail: ${actualUserEmail}`);
        
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
        
        // Ignore any CreatedBy/CreatedByEmail from user input - use actual user details
        const creatorRole = ACTUAL_USER_ROLE;
        const creatorId = ACTUAL_USER_ID;
        const creatorEmail = ACTUAL_USER_EMAIL;
        const creatorName = actualUser.name;
        
        // Handle multiple assignees
        const isMultipleAssignees = assigneeNames && assigneeNames.length > 0 && assigneeEmails && assigneeEmails.length > 0
        const singleAssigneeName = assigneeName || (assigneeNames && assigneeNames.length > 0 ? assigneeNames[0] : "")
        const singleAssigneeEmail = emailAddress || (assigneeEmails && assigneeEmails.length > 0 ? assigneeEmails[0] : "")
        
        // CRITICAL SECURITY CHECK: Check if user is trying to assign task to someone else
        const assigneesToProcess = isMultipleAssignees ? 
          assigneeEmails.map((email, idx) => ({
            email: email,
            name: assigneeNames[idx] || email.split('@')[0]
          })) : 
          [{ email: singleAssigneeEmail, name: singleAssigneeName }];
          
        // Check if user is trying to assign to others (not themselves)
        const isAssigningToOthers = assigneesToProcess.some(assignee => 
          assignee.email && assignee.email.toLowerCase() !== ACTUAL_USER_EMAIL.toLowerCase()
        );
        
        if (isAssigningToOthers && ACTUAL_USER_ROLE !== "admin" && ACTUAL_USER_ROLE !== "manager") {
          throw new Error("❌ Access denied. Only admins and managers can assign tasks to other users. You can only create tasks for yourself.");
        }
          console.log(`🔒 SECURITY: Assignment check passed. User can assign to: ${assigneesToProcess.map(a => a.email).join(", ")}`);
        
        // Use actual user's organization ID, not any provided organizationId
        let organizationId = ACTUAL_USER_ORG_ID;

        // Process each assignee
        let assigneeIds: string[] = [];
        let assigneeDetails: Array<{id: string, name: string, email: string}> = [];
        let userCreated = false;

        // Process each assignee
        for (const assignee of assigneesToProcess) {
          // Check if the user already exists
          const { data: existingUser, error: userSearchError } = await supabase
            .from("users")
            .select("id, name, organization_id")
            .eq("email", assignee.email)
            .single();

          let userId;          if (userSearchError || !existingUser) {
            // SECURITY: Only verified admin/manager can create new users
            if (ACTUAL_USER_ROLE !== "admin" && ACTUAL_USER_ROLE !== "manager") {
              throw new Error(`❌ Access denied. User '${assignee.email}' doesn't exist. Only admins and managers can assign tasks to new users. Please ask an administrator to add this user first.`);
            }
            
            // Use the actual user's organization for new user creation
            const creatorOrganizationId = organizationId; // This is already set to ACTUAL_USER_ORG_ID
            
            // Create a new user if not found
            console.log(`🔒 SECURITY: Admin/Manager ${ACTUAL_USER_EMAIL} creating new user: ${assignee.email}`)

            const { data: newUser, error: createUserError } = await supabase
              .from("users")
              .insert({
                name: assignee.name,
                email: assignee.email,
                role: "user",
                organization_id: creatorOrganizationId,
                created_at: new Date().toISOString(),
              })              .select()
              .single()

          if (createUserError) {
            throw new Error(`Failed to create user: ${createUserError.message}`)
          }

          userId = newUser.id
          userCreated = true
          console.log(`🔒 Created new user with ID: ${userId} in organization: ${organizationId}`)
          
          assigneeIds.push(userId);
          assigneeDetails.push({
            id: userId,
            name: assignee.name,
            email: assignee.email
          });
        } else {
          // Existing user found - verify they're in the same organization
          if (existingUser.organization_id !== organizationId) {
            throw new Error(`❌ Access denied. User '${assignee.email}' belongs to a different organization. You can only assign tasks to users in your organization.`);
          }
          
          userId = existingUser.id
          console.log(`Found existing user with ID: ${userId}, name: ${existingUser.name}, organization: ${organizationId}`)
          
          assigneeIds.push(userId);
          assigneeDetails.push({
            id: userId,
            name: existingUser.name,
            email: assignee.email
          });
        }
        }

        // Permission check will be done after we process the assignees
        // since we need the assignee IDs first

        // Handle team if provided
        let teamId = null
        let teamCreated = false

        if (teamName) {
          console.log(`Looking up team with name: ${teamName}`)

          // Check if team exists in the same organization - improved matching
          const { data: existingTeams, error: teamSearchError } = await supabase
            .from("teams")
            .select("id, name")
            .eq("organization_id", organizationId)

          if (teamSearchError) {
            console.error("Error searching for team:", teamSearchError)
          } else {
            // Improve team name matching with more flexible comparison
            // First check for exact match (case insensitive)
            let exactTeamMatch = existingTeams?.find(
              t => teamName && t.name.toLowerCase() === teamName.toLowerCase()
            )
            
            // If no exact match, try with trimmed whitespace
            if (!exactTeamMatch) {
              exactTeamMatch = existingTeams?.find(
                t => teamName && t.name.toLowerCase().trim() === teamName.toLowerCase().trim()
              )
            }
            
            // If still no match, try partial matching
            if (!exactTeamMatch) {
              exactTeamMatch = existingTeams?.find(
                t => teamName && (t.name.toLowerCase().includes(teamName.toLowerCase()) || 
                    teamName.toLowerCase().includes(t.name.toLowerCase()))
              )
            }

            if (exactTeamMatch) {
              teamId = exactTeamMatch.id
              console.log(`Found existing team: ${exactTeamMatch.name} (ID: ${teamId})`)
            } else {
              // If no exact match, fetch all available teams for this organization
              const availableTeams = existingTeams?.map(t => t.name) || []
                // Check if user has permission to create a team
              if (creatorRole !== "admin" && creatorRole !== "manager") {
                const teamsListText = availableTeams.length > 0 
                  ? `Available teams are: ${availableTeams.join(", ")}` 
                  : "There are no teams available yet."
                throw new Error(`Team "${teamName}" doesn't exist. Only administrators and managers can create new teams. ${teamsListText}`)
              }
              
              // Create new team
              console.log(`Creating new team: ${teamName}`)

              const { data: newTeam, error: createTeamError } = await supabase
                .from("teams")
                .insert({
                  name: teamName,
                  description: `Team created for task: ${title}`,
                  organization_id: organizationId,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .select()
                .single()

              if (createTeamError) {
                console.error("Error creating team:", createTeamError)
              } else if (newTeam) {
                teamId = newTeam.id
                teamCreated = true
                console.log(`Created new team with ID: ${teamId}`)
              }
            }
          }
        }

        // Handle project
        let projectId = null
        let projectCreated = false

        if (projectName) {
          // Check if project exists within the same organization - improved matching
          const { data: existingProjects, error: projectSearchError } = await supabase
            .from("projects")
            .select("id, name, team_id")
            .eq("organization_id", organizationId)

          // Improve project name matching with more flexible comparison
          let existingProject = null
          if (!projectSearchError && existingProjects) {
            // First check for exact match (case insensitive)
            existingProject = existingProjects.find(
              p => p.name.toLowerCase() === projectName.toLowerCase()
            )
            
            // If no exact match, try with trimmed whitespace
            if (!existingProject) {
              existingProject = existingProjects.find(
                p => p.name.toLowerCase().trim() === projectName.toLowerCase().trim()
              )
            }
            
            // If still no match, try partial matching
            if (!existingProject) {
              existingProject = existingProjects.find(
                p => p.name.toLowerCase().includes(projectName.toLowerCase()) || 
                    projectName.toLowerCase().includes(p.name.toLowerCase())
              )
            }
          }

          if (!existingProject) {
            // Fetch all available projects for this organization
            const availableProjects = existingProjects?.map(p => p.name) || []
              // Check if user has permission to create a project
            if (creatorRole !== "admin" && creatorRole !== "manager") {
              const projectsListText = availableProjects.length > 0 
                ? `Available projects are: ${availableProjects.join(", ")}` 
                : "There are no projects available yet."
              throw new Error(`Project "${projectName}" doesn't exist. Only administrators and managers can create new projects. ${projectsListText}`)
            }
            
            // Create a new project if not found
            console.log(`Project "${projectName}" not found in organization ${organizationId}. Creating new project.`)

            const { data: newProject, error: createProjectError } = await supabase
              .from("projects")
              .insert({
                name: projectName,
                description: `Project created by ${creatorName} (${creatorEmail}) for task: ${title}`,
                team_id: teamId,
                organization_id: organizationId,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .select()
              .single()

            if (createProjectError) {
              console.error(`Failed to create project: ${createProjectError.message}`)
              // Continue without project if creation fails
            } else {
              projectId = newProject.id
              projectCreated = true
              console.log(`Created new project with ID: ${projectId}`)
            }
          } else {
            projectId = existingProject.id
            console.log(`Found existing project with ID: ${projectId}, name: ${existingProject.name}`)

            // If team is different and a team was specified, handle according to user permissions
            if (teamId && existingProject.team_id !== teamId) {
              if (creatorRole !== "admin") {
                // Instead of throwing an error, use the project's existing team
                console.log(`User is not an admin. Using project's existing team instead of updating it.`)
                
                // Get the project's current team name for the response message
                const { data: projectTeam } = await supabase
                  .from("teams")
                  .select("name")
                  .eq("id", existingProject.team_id)
                  .single()
                
                // Set teamId to the project's existing team_id
                teamId = existingProject.team_id
                
                // Don't throw an error here, just make a note for the response
                if (projectTeam) {
                  teamName = projectTeam.name // Update teamName to match actual team being used
                }
              } else {
                // Admin can update the project team
                console.log(`Updating project team from ${existingProject.team_id} to ${teamId}`)

                const { error: updateError } = await supabase
                  .from("projects")
                  .update({
                    team_id: teamId,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", existingProject.id)

                if (updateError) {
                  console.error("Error updating project team:", updateError)
                }
              }
            }
          }
        }

        // Parse the due date if provided, or use week name if available
        let formattedDueDate = null

        if (weekName) {
          // Convert week name to actual date
          formattedDueDate = parseWeekName(weekName)
          console.log(`Converted week name "${weekName}" to date: ${formattedDueDate}`)        } else if (dueDate) {
          // Handle both DD-MM-YYYY and DD/MM/YYYY formats
          let day, month, year;
          
          if (dueDate.includes('/')) {
            // Handle DD/MM/YYYY format
            [day, month, year] = dueDate.split('/');
          } else if (dueDate.includes('-')) {
            // Handle DD-MM-YYYY format
            [day, month, year] = dueDate.split('-');
          } else {
            console.error(`Invalid date format: ${dueDate}. Expected DD/MM/YYYY or DD-MM-YYYY`);
            throw new Error(`Invalid date format: ${dueDate}. Expected DD/MM/YYYY or DD-MM-YYYY`);
          }
          
          // Validate date components
          if (!day || !month || !year) {
            console.error(`Invalid date components: day=${day}, month=${month}, year=${year} from date=${dueDate}`);
            throw new Error(`Invalid date format: ${dueDate}. Could not parse day, month, and year.`);
          }
          
          // Pad with zeros if needed and convert to YYYY-MM-DD format
          const paddedDay = day.padStart(2, '0');
          const paddedMonth = month.padStart(2, '0');
          formattedDueDate = `${year}-${paddedMonth}-${paddedDay}`;
          
          console.log(`Converted date "${dueDate}" to database format: ${formattedDueDate}`);
        }console.log(`Creating task "${title}" assigned to ${assigneeIds.length} user(s), project ID: ${projectId}, organization ID: ${organizationId}`)

        // Create the task in the database with assigned_to as JSONB array of user IDs
        const { data: task, error } = await supabase
          .from("tasks")
          .insert({
            title,
            description,
            deadline: formattedDueDate,
            priority: priority || "medium",
            assigned_to: assigneeIds, // Store as JSONB array
            project_id: projectId,
            organization_id: organizationId,
            status: "pending",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            created_by: creatorId, // Add creator ID for tracking who created the task
          })
          .select()
          .single()

        if (error) {
          console.error("Error inserting task:", error)
          throw error
        }        if (!task) {
          throw new Error("Failed to create task - no task returned")
        }        // Send immediate notification for new task assignment - send all assignees at once
        const notificationCreatorName = creatorName || 'Someone';
        console.log(`📋 Sending single notification for task "${task.title}" to ${assigneeIds.length} assignee(s)`);
        await sendNewTaskAssignmentNotification(task.id, assigneeIds, notificationCreatorName);

        // Get organization name for the response
        let organizationName = "Unknown Organization"
        if (organizationId) {
          const { data: org } = await supabase
            .from("organizations")
            .select("name")
            .eq("id", organizationId)
            .single()
            
          if (org) {
            organizationName = org.name
          }
        }        // Create assignee message based on number of assignees
        let assigneeMessage = '';
        if (assigneeIds.length === 1) {
          assigneeMessage = `assigned to ${assigneeDetails[0].name} (${assigneeDetails[0].email})`;
        } else {
          assigneeMessage = `assigned to ${assigneeIds.length} people: ` + 
            assigneeDetails.map(a => `${a.name} (${a.email})`).join(', ');
        }
        
        return {
          taskName: task.title,
          assignedTo: assigneeDetails.map(a => a.name).join(', '),
          emailAddress: assigneeDetails.map(a => a.email).join(', '),
          assigneeDetails: assigneeDetails, // Include full details
          dueDate: task.deadline,
          priority: task.priority,
          status: task.status,
          project: projectName || "No project",
          team: teamName || "No team",
          organization: organizationName,
          organizationId: organizationId,
          success: true,
          userCreated: userCreated,
          projectCreated: projectCreated,
          teamCreated: teamCreated,
          message: `Task "${title}" created successfully and ${assigneeMessage}${
            projectName ? ` in project "${projectName}"` : ""
          }${teamName ? ` under team "${teamName}"` : ""}${
            organizationName ? ` within "${organizationName}"` : ""
          }`,
        }
      } catch (error) {
        console.error("Error creating task:", error)
        return {
          success: false,
          error: "Failed to create task",
          message: `Error creating task: ${error instanceof Error ? error.message : "Unknown error"}`,
        }
      }
    },
  })
}
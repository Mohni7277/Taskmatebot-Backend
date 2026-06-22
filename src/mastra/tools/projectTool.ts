import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export function createProjectTool(db: any) {
  return createTool({
    id: "create_project",
    description: "Creates a new project in the database if it doesn't already exist, with optional deadline and project lead",    inputSchema: z.object({
      name: z.string().describe("The name of the project to create"),
      description: z.string().optional().describe("Optional description of the project"),
      teamName: z.string().optional().describe("Name of the team this project belongs to"),
      creatorName: z.string().optional().describe("Name of the person creating the project"),
      creatorEmail: z.string().optional().describe("Email of the person creating the project"),
      deadline: z.string().optional().describe("Project deadline in YYYY-MM-DD format"),
      projectLeadId: z.string().optional().describe("User ID of the project lead"),
      projectLeadEmail: z.string().optional().describe("Email of the project lead if ID not available"),
      projectLeadName: z.string().optional().describe("Name of the project lead if ID/email not available"),
      actualUserEmail: z.string().describe("The ACTUAL email of the user making the request (from context, cannot be overridden)"),
    }),    execute: async ({ context }) => {
      const { 
        name, 
        description, 
        teamName, 
        creatorName, 
        creatorEmail,
        deadline,
        projectLeadId,
        projectLeadEmail,
        projectLeadName,
        actualUserEmail
      } = context

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
        
        // CRITICAL: Only verified admin/manager can create projects
        if (ACTUAL_USER_ROLE !== "admin" && ACTUAL_USER_ROLE !== "manager") {
          throw new Error("❌ Access denied. Only verified admins and managers can create projects.");
        }
        
        // Use actual user's organization, not any provided organizationId
        const organizationId = ACTUAL_USER_ORG_ID;
        // Find or create team by name
        let teamId = null
        let teamCreated = false

        if (teamName) {
          console.log(`Looking up team with name: ${teamName}`)

          // Check if team exists
          const { data: existingTeams, error: teamSearchError } = await supabase
            .from("teams")
            .select("id, name")
            .ilike("name", `%${teamName}%`)

          if (teamSearchError) {
            console.error("Error searching for team:", teamSearchError)
          } else {
            // Look for exact match
            const exactTeamMatch = existingTeams?.find((t) => t.name.toLowerCase() === teamName.toLowerCase())

            if (exactTeamMatch) {
              teamId = exactTeamMatch.id
              console.log(`Found existing team: ${exactTeamMatch.name} (ID: ${teamId})`)
            } else {
              // Create new team
              console.log(`Creating new team: ${teamName}`)

              const { data: newTeam, error: createTeamError } = await supabase
                .from("teams")
                .insert({
                  name: teamName,
                  description: `Team created for project: ${name}`,
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

        // Resolve project lead ID if needed
        let finalProjectLeadId = projectLeadId
        let projectLeadUser = null

        if (!projectLeadId && (projectLeadEmail || projectLeadName)) {
          console.log(`🔍 Looking up project lead...`)
          
          // Try to find by email first
          if (projectLeadEmail) {
            console.log(`   Looking up by email: ${projectLeadEmail}`)
            const { data: leadUser, error: leadError } = await supabase
              .from("users")
              .select("id, name, email")
              .eq("email", projectLeadEmail)
              .single()
            
            if (!leadError && leadUser) {
              finalProjectLeadId = leadUser.id
              projectLeadUser = leadUser
              console.log(`✅ Found project lead by email: ${leadUser.name} (${finalProjectLeadId})`)
            }
          }
          
          // If not found by email, try by name
          if (!finalProjectLeadId && projectLeadName) {
            console.log(`   Looking up by name: ${projectLeadName}`)
            const { data: leadUsers, error: leadError } = await supabase
              .from("users")
              .select("id, name, email")
              .ilike("name", `%${projectLeadName}%`)
            
            if (!leadError && leadUsers?.length) {
              // Look for exact match or closest match
              const exactMatch = leadUsers.find(u => u.name.toLowerCase() === projectLeadName.toLowerCase())
              if (exactMatch) {
                finalProjectLeadId = exactMatch.id
                projectLeadUser = exactMatch
                console.log(`✅ Found project lead by name: ${exactMatch.name} (${finalProjectLeadId})`)
              } else if (leadUsers.length === 1) {
                finalProjectLeadId = leadUsers[0].id
                projectLeadUser = leadUsers[0]
                console.log(`✅ Found project lead (closest match): ${leadUsers[0].name} (${finalProjectLeadId})`)
              }
            }
          }
          
          if (!finalProjectLeadId) {
            console.log(`⚠️ Could not find project lead with provided information`)
          }
        } else if (projectLeadId) {
          // Get project lead user info if we have ID
          const { data: leadUser } = await supabase
            .from("users")
            .select("id, name, email")
            .eq("id", projectLeadId)
            .single()
          
          if (leadUser) {
            projectLeadUser = leadUser
            console.log(`✅ Found project lead: ${leadUser.name}`)
          }
        }

        // Check if project already exists
        const { data: existingProjects, error: searchError } = await supabase
          .from("projects")
          .select("id, name, team_id, deadline, project_lead")
          .ilike("name", name)

        if (searchError) {
          console.error("Error searching for existing project:", searchError)
          throw searchError
        }

        // If we found an exact match, return it
        const exactMatch = existingProjects?.find((p) => p.name.toLowerCase() === name.toLowerCase())

        if (exactMatch) {
          console.log(`Project "${name}" already exists with ID: ${exactMatch.id}`)

          // Check if we need to update the project
          let updateNeeded = false
          const updateData: any = { updated_at: new Date().toISOString() }

          // Update team if different
          if (teamId && exactMatch.team_id !== teamId) {
            console.log(`Updating project team from ${exactMatch.team_id} to ${teamId}`)
            updateData.team_id = teamId
            updateNeeded = true
          }

          // Update deadline if provided and different
          if (deadline) {
            const newDeadline = new Date(deadline).toISOString()
            if (!exactMatch.deadline || exactMatch.deadline !== newDeadline) {
              console.log(`Updating project deadline to ${deadline}`)
              updateData.deadline = newDeadline
              updateNeeded = true
            }
          }

          // Update project lead if provided and different
          if (finalProjectLeadId && exactMatch.project_lead !== finalProjectLeadId) {
            console.log(`Updating project lead to ${finalProjectLeadId}`)
            updateData.project_lead = finalProjectLeadId
            updateNeeded = true
          }

          if (updateNeeded) {
            const { error: updateError } = await supabase
              .from("projects")
              .update(updateData)
              .eq("id", exactMatch.id)

            if (updateError) {
              console.error("Error updating project:", updateError)
            } else {
              console.log("✅ Project updated successfully")
            }
          }

          return {
            success: true,
            projectId: exactMatch.id,
            projectName: exactMatch.name,
            teamName: teamName || "No team",
            teamId: teamId,
            deadline: deadline || null,
            projectLead: projectLeadUser?.name || null,
            projectLeadEmail: projectLeadUser?.email || null,
            message: "Project already exists" + (updateNeeded ? " (updated with new information)" : ""),
            created: false,
            teamCreated: teamCreated,
          }
        }

        // Create new project with all details
        console.log(`Creating new project "${name}"${teamId ? ` with team ID: ${teamId}` : ""}`)
        console.log(`   Deadline: ${deadline || 'None'}`)
        console.log(`   Project Lead: ${projectLeadUser?.name || 'None'}`)

        const projectData: any = {
          name,
          description: description || `Project created via Slack bot`,
          team_id: teamId,
          deadline: deadline ? new Date(deadline).toISOString() : null,
          project_lead: finalProjectLeadId || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }

        const { data: newProject, error: createError } = await supabase
          .from("projects")
          .insert(projectData)
          .select()
          .single()

        if (createError) {
          console.error("Error creating project:", createError)
          throw createError
        }

        console.log(`✅ Created new project with ID: ${newProject.id}`)

        // If we have a team and project lead, add them as team lead if not already
        if (teamId && finalProjectLeadId && teamCreated) {
          console.log(`👨‍💼 Adding project lead as team lead...`)
          const { error: memberError } = await supabase
            .from("team_members")
            .insert({
              team_id: teamId,
              user_id: finalProjectLeadId,
              role: "team_lead"
            })
            .single()

          if (memberError) {
            console.error("Error adding project lead as team lead:", memberError)
          } else {
            console.log(`✅ Added project lead as team lead`)
          }
        }

        return {
          success: true,
          projectId: newProject.id,
          projectName: newProject.name,
          teamName: teamName || "No team",
          teamId: teamId,
          deadline: deadline || null,
          projectLead: projectLeadUser?.name || null,
          projectLeadEmail: projectLeadUser?.email || null,
          message: "Project created successfully" + (teamCreated ? " with a new team" : ""),
          created: true,
          teamCreated: teamCreated,
          creatorName: creatorName || "Unknown",
          creatorEmail: creatorEmail || "Unknown",
        }
      } catch (error) {
        console.error("Error in create_project tool:", error)
        return {
          success: false,
          message: "An unexpected error occurred",
          error: error instanceof Error ? error.message : "Unknown error",
        }
      }
    },
  })
}
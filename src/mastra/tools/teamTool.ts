import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export function createTeamTool(db: any) {
  return createTool({
    id: "create_team",
    description: "Creates a new team in the database if it doesn't already exist, with optional team lead",    inputSchema: z.object({
      name: z.string().describe("The name of the team to create"),
      description: z.string().optional().describe("Optional description of the team"),
      creatorName: z.string().optional().describe("Name of the person creating the team"),
      creatorEmail: z.string().optional().describe("Email of the person creating the team"),
      teamLeadId: z.string().optional().describe("User ID of the team lead"),
      teamLeadEmail: z.string().optional().describe("Email of the team lead if ID not available"),
      teamLeadName: z.string().optional().describe("Name of the team lead if ID/email not available"),
      organizationId: z.string().optional().describe("Organization ID for the team"),
      actualUserEmail: z.string().describe("The ACTUAL email of the user making the request (from context, cannot be overridden)"),
    }),    execute: async ({ context }) => {
      const { 
        name, 
        description, 
        creatorName, 
        creatorEmail,
        teamLeadId,
        teamLeadEmail,
        teamLeadName,
        organizationId,
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
        
        // CRITICAL: Only verified admin/manager can create teams
        if (ACTUAL_USER_ROLE !== "admin" && ACTUAL_USER_ROLE !== "manager") {
          throw new Error("❌ Access denied. Only verified admins and managers can create teams.");
        }
        
        // Use actual user's organization, not any provided organizationId
        const actualOrganizationId = ACTUAL_USER_ORG_ID;
        
        console.log(`🏢 Creating team: ${name}`);

        // First check if team already exists with the same name in the same organization
        const { data: existingTeams, error: existingTeamError } = await supabase
          .from("teams")
          .select("id, name, organization_id")
          .eq("organization_id", actualOrganizationId)
          .ilike("name", name);

        if (existingTeamError) {
          console.error("Error checking for existing teams:", existingTeamError);
          return {
            success: false,
            message: `Error checking for existing teams: ${existingTeamError.message}`
          };
        }

        if (existingTeams && existingTeams.length > 0) {
          console.log(`✅ Team "${name}" already exists`);
          return {
            success: true,
            message: `Team "${name}" already exists`,
            team: existingTeams[0],
            teamId: existingTeams[0].id,
            teamName: existingTeams[0].name
          };
        }

        // Get creator information
        let creatorId = null;
        let actualCreatorName = creatorName;
        let actualOrgId = organizationId;

        if (creatorEmail) {
          const { data: creator, error: creatorError } = await supabase
            .from("users")
            .select("id, name, organization_id")
            .eq("email", creatorEmail)
            .single();

          if (!creatorError && creator) {
            creatorId = creator.id;
            actualCreatorName = creator.name;
            actualOrgId = actualOrgId || creator.organization_id;
          }
        }

        // Find team lead if specified
        let teamLeadUserId = teamLeadId;
        if (!teamLeadUserId && teamLeadEmail) {
          const { data: teamLeadUser, error: teamLeadError } = await supabase
            .from("users")
            .select("id, name, email")
            .eq("email", teamLeadEmail)
            .single();

          if (!teamLeadError && teamLeadUser) {
            teamLeadUserId = teamLeadUser.id;
            console.log(`✅ Found team lead: ${teamLeadUser.name} (${teamLeadUser.email})`);
          } else if (teamLeadEmail) {
            console.log(`⚠️ Team lead not found with email: ${teamLeadEmail}`);
          }
        }

        // Create the team
        const teamData = {
          name: name,
          description: description || null,
          organization_id: actualOrgId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        const { data: newTeam, error: teamError } = await supabase
          .from("teams")
          .insert(teamData)
          .select()
          .single();

        if (teamError) {
          console.error("Error creating team:", teamError);
          return {
            success: false,
            message: `Error creating team: ${teamError.message}`
          };
        }

        console.log(`✅ Created team: ${newTeam.name} (ID: ${newTeam.id})`);

        // Add team lead as a member with team_lead role if specified
        if (teamLeadUserId) {
          const { error: memberError } = await supabase
            .from("team_members")
            .insert({
              team_id: newTeam.id,
              user_id: teamLeadUserId,
              role: "team_lead",
              joined_at: new Date().toISOString()
            });

          if (memberError) {
            console.error("Error adding team lead as member:", memberError);
            // Don't fail the entire operation for this
          } else {
            console.log(`✅ Added team lead to team as member`);
          }
        }

        // Add creator as a member if they're not the team lead
        if (creatorId && creatorId !== teamLeadUserId) {
          const { error: creatorMemberError } = await supabase
            .from("team_members")
            .insert({
              team_id: newTeam.id,
              user_id: creatorId,
              role: "member",
              joined_at: new Date().toISOString()
            });

          if (creatorMemberError) {
            console.error("Error adding creator as member:", creatorMemberError);
            // Don't fail the entire operation for this
          } else {
            console.log(`✅ Added creator to team as member`);
          }
        }

        return {
          success: true,
          message: `Successfully created team "${newTeam.name}"${teamLeadUserId ? ` with team lead` : ''}`,
          team: newTeam,
          teamId: newTeam.id,
          teamName: newTeam.name,
          teamLeadId: teamLeadUserId,
          createdBy: actualCreatorName || 'Unknown'
        };

      } catch (error) {
        console.error("Error in createTeam tool:", error);
        return {
          success: false,
          message: "An unexpected error occurred while creating the team",
          error: error instanceof Error ? error.message : "Unknown error"
        };
      }
    }
  })
}

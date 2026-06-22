import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export function listTeamsTool(db: any) {
  return createTool({
    id: "list_teams",
    description: "Lists all available teams with team leads",
    inputSchema: z.object({
      userName: z.string().optional().describe("Full name of the user requesting teams"),
      userEmail: z.string().optional().describe("Email address of the user requesting teams")
    }),
    execute: async ({ context }) => {
      const { userName, userEmail } = context

      try {
        console.log(`🔍 Fetching all teams`)
        
        // Get user's organization if user info is provided
        let organizationId = null
        if (userEmail) {
          const { data: user, error: userError } = await supabase
            .from("users")
            .select("organization_id")
            .eq("email", userEmail)
            .single()
          
          if (user && user.organization_id) {
            organizationId = user.organization_id
            console.log(`🏢 Filtering teams by organization: ${organizationId}`)
          }
        }
        
        // Build query for teams with organization filtering
        let teamsQuery = supabase
          .from("teams")
          .select(`
            id,
            name,
            organization_id,
            team_members!inner (
              user_id,
              role,
              users (
                name
              )
            )
          `)
          .order("name")
        
        // Build query for all teams with organization filtering
        let allTeamsQuery = supabase
          .from("teams")
          .select("id, name, organization_id")
          .order("name")

        // Filter by organization if we have user info
        if (organizationId) {
          teamsQuery = teamsQuery.eq("organization_id", organizationId)
          allTeamsQuery = allTeamsQuery.eq("organization_id", organizationId)
        }
        
        // Get teams with their team leads from team_members table
        const { data: teamsWithLeads, error } = await teamsQuery
        
        if (error) {
          console.error("❌ Error fetching teams:", error)
          return {
            success: false,
            message: `Error fetching teams: ${error.message}`,
            totalTeams: 0,
            teams: []
          }
        }
        
        // Also get teams without members
        const { data: allTeams, error: allTeamsError } = await allTeamsQuery
        
        if (allTeamsError) {
          console.error("❌ Error fetching all teams:", allTeamsError)
          return {
            success: false,
            message: `Error fetching teams: ${allTeamsError.message}`,
            totalTeams: 0,
            teams: []
          }
        }
        
        if (!allTeams || allTeams.length === 0) {
          console.log("📭 No teams found")
          return {
            success: true,
            message: "No teams found",
            totalTeams: 0,
            teams: []
          }
        }
        
        // Process teams to include team lead information
        const formattedTeams = allTeams.map(team => {
          // Find team lead from the teams with leads query
          const teamWithLead = teamsWithLeads?.find(t => t.id === team.id)
          const teamLead = teamWithLead?.team_members?.find(member => member.role === 'team_lead')
          
          return {
            id: team.id,
            name: team.name,
            team_lead: teamLead?.users?.[0]?.name || null
          }
        })
        
        console.log(`✅ Found ${allTeams.length} teams`)
        console.log(`   - Teams with leads: ${formattedTeams.filter(t => t.team_lead).length}`)
        console.log(`   - Teams without leads: ${formattedTeams.filter(t => !t.team_lead).length}`)
        
        return {
          success: true,
          message: `Found ${allTeams.length} teams`,
          totalTeams: allTeams.length,
          teams: formattedTeams
        }
      } catch (error) {
        console.error("❌ Error in list_teams tool:", error)
        return {
          success: false,
          message: "An unexpected error occurred while fetching teams",
          error: error instanceof Error ? error.message : "Unknown error",
          totalTeams: 0,
          teams: []
        }
      }
    }
  })
}
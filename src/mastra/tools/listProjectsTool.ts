import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export function listProjectsTool(db: any) {
  return createTool({
    id: "list_projects",
    description: "Lists all available projects organized by teams with team leads",
    inputSchema: z.object({
      teamId: z.string().optional().describe("Filter projects by specific team ID"),
      userName: z.string().optional().describe("Full name of the user requesting projects"),
      userEmail: z.string().optional().describe("Email address of the user requesting projects")
    }),
    execute: async ({ context }) => {
      const { teamId, userName, userEmail } = context

      try {
        console.log(`🔍 Fetching all projects${teamId ? ` for team: ${teamId}` : ''}`)
        
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
            console.log(`🏢 Filtering projects by organization: ${organizationId}`)
          }
        }
        
        // Build query for projects with team information
        let query = supabase
          .from("projects")
          .select(`
            id,
            name,
            team_id,
            organization_id,
            teams (
              id,
              name
            )
          `)
          .order("name")

        // Filter by organization if we have user info
        if (organizationId) {
          query = query.eq("organization_id", organizationId)
        }

        // Filter by team if specified
        if (teamId) {
          query = query.eq("team_id", teamId)
        }

        const { data: projects, error } = await query

        if (error) {
          console.error("❌ Error fetching projects:", error)
          return {
            success: false,
            message: `Error fetching projects: ${error.message}`,
            totalProjects: 0,
            projectsByTeam: {},
            projectsWithoutTeam: []
          }
        }

        if (!projects || projects.length === 0) {
          console.log("📭 No projects found")
          return {
            success: true,
            message: "No projects found",
            totalProjects: 0,
            projectsByTeam: {},
            projectsWithoutTeam: []
          }
        }

        // Get team leads separately for all teams
        const teamIds = [...new Set(projects.filter(p => p.team_id).map(p => p.team_id))]
        const teamLeadPromises = teamIds.map(async (teamId) => {
          const { data: teamLead } = await supabase
            .from("team_members")
            .select(`
              users (
                name
              )
            `)
            .eq("team_id", teamId)
            .eq("role", "team_lead")
            .single()
          
          return {
            teamId,
            leadName: teamLead?.users?.[0]?.name || null
          }
        })

        const teamLeads = await Promise.all(teamLeadPromises)
        const teamLeadMap = teamLeads.reduce((acc, tl) => {
          acc[tl.teamId] = tl.leadName
          return acc
        }, {} as Record<string, string | null>)

        // Group projects by team
        const projectsByTeam: Record<string, any[]> = {}
        const projectsWithoutTeam: any[] = []

        projects.forEach(project => {
          if (project.team_id && project.teams?.[0]) {
            const teamName = project.teams[0].name
            const teamLead = teamLeadMap[project.team_id]
            const teamKey = `${teamName}${teamLead ? ` (Lead: ${teamLead})` : ''}`
            
            if (!projectsByTeam[teamKey]) {
              projectsByTeam[teamKey] = []
            }
            
            projectsByTeam[teamKey].push({
              id: project.id,
              name: project.name,
              team_lead: null // Projects don't have leads in this schema
            })
          } else {
            projectsWithoutTeam.push({
              id: project.id,
              name: project.name,
              team_lead: null
            })
          }
        })

        console.log(`✅ Found ${projects.length} projects`)
        console.log(`   - ${Object.keys(projectsByTeam).length} teams with projects`)
        console.log(`   - ${projectsWithoutTeam.length} projects without teams`)

        return {
          success: true,
          message: `Found ${projects.length} projects`,
          totalProjects: projects.length,
          projectsByTeam,
          projectsWithoutTeam,
          teamCount: Object.keys(projectsByTeam).length
        }
      } catch (error) {
        console.error("❌ Error in list_projects tool:", error)
        return {
          success: false,
          message: "An unexpected error occurred while fetching projects",
          error: error instanceof Error ? error.message : "Unknown error",
          totalProjects: 0,
          projectsByTeam: {},
          projectsWithoutTeam: []
        }
      }
    }
  })
}
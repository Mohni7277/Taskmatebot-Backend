import { createClient } from "@supabase/supabase-js"

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

// Helper function to get user by Telegram ID
export async function getUserByTelegramId(telegramId: string) {
  try {
    const { data: integration, error: integrationError } = await supabase
      .from("integration_settings")
      .select("user_id")
      .eq("integration_type", "telegram")
      .eq("integration_id", telegramId)
      .single()

    if (integrationError || !integration) return null

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("id", integration.user_id)
      .single()

    if (userError || !user) return null

    return user
  } catch (error) {
    console.error("Error getting user by Telegram ID:", error)
    return null
  }
}

// Helper function to get available projects
export async function getAvailableProjects() {
  try {
    const { data, error } = await supabase.from("projects").select("id, name, team_id").order("name")

    if (error) throw error

    return data || []
  } catch (error) {
    console.error("Error fetching projects:", error)
    return []
  }
}

// Helper function to get available teams
export async function getAvailableTeams() {
  try {
    const { data, error } = await supabase.from("teams").select("id, name").order("name")

    if (error) throw error

    return data || []
  } catch (error) {
    console.error("Error fetching teams:", error)
    return []
  }
}

// Helper function to get teams for a specific user
export async function getUserTeams(userId: string) {
  try {
    // First check if the team_members table exists
    const { data: tableExists, error: tableCheckError } = await supabase
      .from("information_schema.tables")
      .select("table_name")
      .eq("table_name", "team_members")
      .single()

    // If team_members table doesn't exist, fall back to projects created by the user
    if (tableCheckError || !tableExists) {
      console.log("team_members table not found, falling back to projects")

      // Get projects associated with the user (assuming there's some relationship)
      const { data: userProjects, error: projectsError } = await supabase
        .from("projects")
        .select("team_id")
        .not("team_id", "is", null)

      if (projectsError || !userProjects || userProjects.length === 0) {
        return []
      }

      // Get unique team IDs
      const teamIds = [...new Set(userProjects.map((p) => p.team_id).filter(Boolean))]

      if (teamIds.length === 0) {
        return []
      }

      // Get team details
      const { data: teams, error: teamsError } = await supabase
        .from("teams")
        .select("id, name, description")
        .in("id", teamIds)
        .order("name")

      if (teamsError) throw teamsError

      // Add a default role since we don't have actual roles
      return teams.map((team) => ({
        ...team,
        role: "member",
      }))
    }

    // If team_members table exists, use it as before
    const { data: memberships, error: membershipError } = await supabase
      .from("team_members")
      .select("team_id, role")
      .eq("user_id", userId)

    if (membershipError) throw membershipError

    if (!memberships || memberships.length === 0) {
      return []
    }

    // Get the team details for each membership
    const teamIds = memberships.map((m) => m.team_id)

    const { data: teams, error: teamsError } = await supabase
      .from("teams")
      .select("id, name, description")
      .in("id", teamIds)
      .order("name")

    if (teamsError) throw teamsError

    // Combine team data with role information
    return teams.map((team) => {
      const membership = memberships.find((m) => m.team_id === team.id)
      return {
        ...team,
        role: membership ? membership.role : "member",
      }
    })
  } catch (error) {
    console.error("Error fetching user teams:", error)
    return []
  }
}

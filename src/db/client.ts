import { createClient } from "@supabase/supabase-js"
import dotenv from "dotenv"

dotenv.config()

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ""
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || ""

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials. Please check your .env file.")
  process.exit(1)
}

export const supabase = createClient(supabaseUrl, supabaseKey)

// Database interface adapted to your schema
export const db = {
  // User operations
  users: {
    async getAll() {
      const { data, error } = await supabase.from("users").select("*")
      if (error) throw error
      return data
    },

    async getById(id: any) {
      const { data, error } = await supabase.from("users").select("*").eq("id", id).single()
      if (error) return null
      return data
    },

    async getByTelegramId(telegramId: any) {
      // Look up the user via the integrations_notification table
      const { data: integration, error: integrationError } = await supabase
        .from("integrations_notification")
        .select("user_id")
        .eq("integration_id", telegramId)
        .single()

      if (integrationError || !integration) return null

      // Get the user with the found user_id
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("*")
        .eq("id", integration.user_id)
        .single()

      if (userError) return null
      return user
    },

    async create(userData: { name: any; email: any; role: any; telegramId: any }) {
      // Create the user
      const { data: user, error: userError } = await supabase
        .from("users")
        .insert({
          name: userData.name,
          email: userData.email || null,
          role: userData.role || "user",
        })
        .select()
        .single()

      if (userError) throw userError

      // If telegramId is provided, create the integration record
      if (userData.telegramId) {
        const { error: integrationError } = await supabase.from("integrations_notification").insert({
          user_id: user.id,
          integration_id: userData.telegramId,
        })

        if (integrationError) {
          console.error("Error creating integration record:", integrationError)
          // Continue anyway, as the user was created successfully
        }
      }

      return user
    },

    async update(id: any, userData: any) {
      const { data, error } = await supabase.from("users").update(userData).eq("id", id).select().single()

      if (error) throw error
      return data
    },

    async updateTelegramId(userId: any, telegramId: any) {
      // Check if an integration record already exists
      const { data: existing, error: checkError } = await supabase
        .from("integrations_notification")
        .select("*")
        .eq("user_id", userId)
        .eq("integration_id", telegramId)

      if (checkError) throw checkError

      // If record exists, we're done
      if (existing && existing.length > 0) return

      // Otherwise, create a new integration record
      const { error } = await supabase.from("integrations_notification").insert({
        user_id: userId,
        integration_id: telegramId,
      })

      if (error) throw error
    },

    async updateTeamsConversationId(userId: any, conversationId: string) {
      // Update the user record with the Teams conversation ID
      const { error } = await supabase
        .from("users")
        .update({ teams_conversation_id: conversationId })
        .eq("id", userId)

      if (error) {
        console.error("Error updating Teams conversation ID:", error)
        throw error
      }

      console.log(`✅ Updated Teams conversation ID for user ${userId}: ${conversationId}`)
    },

    async getTeamsConversationId(teamsEmail: string): Promise<string | null> {
      const { data: user, error } = await supabase
        .from("users")
        .select("teams_conversation_id")
        .eq("teams_email", teamsEmail)
        .single()

      if (error || !user || !user.teams_conversation_id) {
        return null
      }

      return user.teams_conversation_id
    },
  },

  // Task operations would go here
  tasks: {
    // Placeholder for task operations
    async getByAssignee(userId: any) {
      // This is a placeholder - implement according to your schema
      return []
    },
  },

  // Reminder operations would go here
  reminders: {
    // Placeholder for reminder operations
  },
}

export default db

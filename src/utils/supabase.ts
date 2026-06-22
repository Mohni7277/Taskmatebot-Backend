import { createClient } from "@supabase/supabase-js"
import dotenv from "dotenv"

dotenv.config()

// Get environment variables
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Supabase credentials are not defined in the environment variables")
  process.exit(1)
}

// Create Supabase client for direct operations
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

export default supabase

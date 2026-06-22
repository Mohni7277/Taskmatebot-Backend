import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Interface for model pricing data
 */
export interface ModelPricing {
  id?: string;
  model_name: string;
  prompt_price_per_million: number;
  completion_price_per_million: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * Interface for token usage data
 */
export interface TokenUsageData {
  user_id: string;
  platform_type: 'slack' | 'teams' | 'whatsapp' | 'telegram';
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  finish_reason?: string;
  model?: string;
  timestamp?: string;
  conversation_id?: string;
  organization_id?: string;
  prompt_price?: number;
  completion_price?: number;
  total_price?: number;
}

/**
 * Store token usage data in the database
 * @param supabase Supabase client
 * @param data Token usage data
 * @returns Promise with the result of the operation
 */
export async function storeTokenUsage(
  supabase: SupabaseClient,
  data: TokenUsageData
): Promise<boolean> {
  try {
    // Set timestamp if not provided
    if (!data.timestamp) {
      data.timestamp = new Date().toISOString();
    }

    // Note: We don't need to calculate pricing here as it's handled by the database trigger
    // Insert data into the token_usage table
    const { error } = await supabase.from("token_usage").insert([data]);

    if (error) {
      console.error("Error storing token usage data:", error);
      return false;
    }

    console.log(`✅ Token usage data stored for user ${data.user_id} on ${data.platform_type}`);
    return true;
  } catch (error) {
    console.error("Error in storeTokenUsage:", error);
    return false;
  }
}

/**
 * Get model pricing information
 * @param supabase Supabase client
 * @param modelName Name of the model
 * @returns Promise with the model pricing data
 */
export async function getModelPricing(
  supabase: SupabaseClient,
  modelName: string
): Promise<ModelPricing | null> {
  try {
    const { data, error } = await supabase
      .from('model_pricing')
      .select('*')
      .eq('model_name', modelName)
      .single();

    if (error) {
      console.error(`Error fetching pricing for model ${modelName}:`, error);
      return null;
    }

    return data;
  } catch (error) {
    console.error(`Error in getModelPricing for ${modelName}:`, error);
    return null;
  }
}

/**
 * Update or insert model pricing information
 * @param supabase Supabase client
 * @param pricing Model pricing data
 * @returns Promise with the result of the operation
 */
export async function upsertModelPricing(
  supabase: SupabaseClient,
  pricing: ModelPricing
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('model_pricing')
      .upsert([
        {
          model_name: pricing.model_name,
          prompt_price_per_million: pricing.prompt_price_per_million,
          completion_price_per_million: pricing.completion_price_per_million
        }
      ]);

    if (error) {
      console.error(`Error updating pricing for model ${pricing.model_name}:`, error);
      return false;
    }

    console.log(`✅ Pricing updated for model ${pricing.model_name}`);
    return true;
  } catch (error) {
    console.error(`Error in upsertModelPricing for ${pricing.model_name}:`, error);
    return false;
  }
}

/**
 * Calculate price for token usage
 * @param promptTokens Number of prompt tokens
 * @param completionTokens Number of completion tokens
 * @param pricing Model pricing data
 * @returns Object with calculated prices
 */
export function calculateTokenPrice(
  promptTokens: number,
  completionTokens: number,
  pricing: ModelPricing
): { promptPrice: number; completionPrice: number; totalPrice: number } {
  const promptPrice = (promptTokens * pricing.prompt_price_per_million) / 1000000;
  const completionPrice = (completionTokens * pricing.completion_price_per_million) / 1000000;
  const totalPrice = promptPrice + completionPrice;
  
  return {
    promptPrice,
    completionPrice,
    totalPrice
  };
}

/**
 * Get token usage statistics for a specific user
 * @param supabase Supabase client
 * @param userId User ID
 * @param platformType Optional platform type filter
 * @param startDate Optional start date for filtering
 * @param endDate Optional end date for filtering
 * @returns Promise with the token usage statistics
 */
export async function getUserTokenUsageStats(
  supabase: SupabaseClient,
  userId: string,
  platformType?: string,
  startDate?: string,
  endDate?: string
) {
  try {
    let query = supabase
      .from("token_usage")
      .select("*")
      .eq("user_id", userId);

    // Apply optional filters
    if (platformType) {
      query = query.eq("platform_type", platformType);
    }

    if (startDate) {
      query = query.gte("timestamp", startDate);
    }

    if (endDate) {
      query = query.lte("timestamp", endDate);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error fetching token usage stats:", error);
      return null;
    }

    return data;
  } catch (error) {
    console.error("Error in getUserTokenUsageStats:", error);
    return null;
  }
}

/**
 * Get aggregated token usage statistics for an organization
 * @param supabase Supabase client
 * @param organizationId Organization ID
 * @param startDate Optional start date for filtering
 * @param endDate Optional end date for filtering
 * @returns Promise with the aggregated token usage statistics
 */
export async function getOrganizationTokenUsageStats(
  supabase: SupabaseClient,
  organizationId: string,
  startDate?: string,
  endDate?: string
) {
  try {
    let query = supabase
      .from("token_usage")
      .select("*")
      .eq("organization_id", organizationId);

    // Apply optional date filters
    if (startDate) {
      query = query.gte("timestamp", startDate);
    }

    if (endDate) {
      query = query.lte("timestamp", endDate);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error fetching organization token usage stats:", error);
      return null;
    }

    return data;
  } catch (error) {
    console.error("Error in getOrganizationTokenUsageStats:", error);
    return null;
  }
}

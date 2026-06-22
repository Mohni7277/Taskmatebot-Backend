import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Interface for token usage with pricing data
 */
export interface TokenUsagePriceData {
  date?: string;
  platform_type?: string;
  user_id?: string;
  user_name?: string;
  model?: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_price: number;
  completion_price: number;
  total_price: number;
}

/**
 * Get daily token usage with pricing information for an organization
 * @param supabase Supabase client
 * @param organizationId Organization ID
 * @param days Number of days to include (default: 30)
 * @returns Promise with daily token usage and pricing data
 */
export async function getDailyTokenUsageWithPricing(
  supabase: SupabaseClient,
  organizationId: string,
  days: number = 30
): Promise<TokenUsagePriceData[] | null> {
  try {
    // Calculate the start date
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString();

    // Query to get daily aggregated data with pricing
    const { data, error } = await supabase.rpc('get_daily_token_usage_with_pricing', {
      org_id: organizationId,
      start_date: startDateStr
    });

    if (error) {
      console.error("Error fetching daily token usage with pricing:", error);
      return null;
    }

    return data;
  } catch (error) {
    console.error("Error in getDailyTokenUsageWithPricing:", error);
    return null;
  }
}

/**
 * Get token usage with pricing by platform for an organization
 * @param supabase Supabase client
 * @param organizationId Organization ID
 * @param days Number of days to include (default: 30)
 * @returns Promise with token usage and pricing data by platform
 */
export async function getTokenUsageWithPricingByPlatform(
  supabase: SupabaseClient,
  organizationId: string,
  days: number = 30
): Promise<TokenUsagePriceData[] | null> {
  try {
    // Calculate the start date
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString();

    // Query to get aggregated data by platform with pricing
    const { data, error } = await supabase.rpc('get_token_usage_with_pricing_by_platform', {
      org_id: organizationId,
      start_date: startDateStr
    });

    if (error) {
      console.error("Error fetching token usage with pricing by platform:", error);
      return null;
    }

    return data;
  } catch (error) {
    console.error("Error in getTokenUsageWithPricingByPlatform:", error);
    return null;
  }
}

/**
 * Get token usage with pricing by user for an organization
 * @param supabase Supabase client
 * @param organizationId Organization ID
 * @param days Number of days to include (default: 30)
 * @param limit Maximum number of users to include (default: 10)
 * @returns Promise with token usage and pricing data by user
 */
export async function getTokenUsageWithPricingByUser(
  supabase: SupabaseClient,
  organizationId: string,
  days: number = 30,
  limit: number = 10
): Promise<TokenUsagePriceData[] | null> {
  try {
    // Calculate the start date
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString();

    // Query to get aggregated data by user with pricing
    const { data, error } = await supabase.rpc('get_token_usage_with_pricing_by_user', {
      org_id: organizationId,
      start_date: startDateStr,
      user_limit: limit
    });

    if (error) {
      console.error("Error fetching token usage with pricing by user:", error);
      return null;
    }

    // Get user details for each user_id
    if (data && data.length > 0) {
      const userIds = data.map((item: { user_id: string }) => item.user_id);
      const { data: users, error: userError } = await supabase
        .from('users')
        .select('id, name, email')
        .in('id', userIds);

      if (userError) {
        console.error("Error fetching user details:", userError);
      } else if (users) {
        // Merge user details with token usage data
        return data.map((item: { user_id: string; total_tokens: number; total_price: number }) => {
          const user = users.find(u => u.id === item.user_id);
          return {
            ...item,
            user_name: user ? user.name : 'Unknown User',
            user_email: user ? user.email : 'Unknown Email'
          };
        });
      }
    }

    return data;
  } catch (error) {
    console.error("Error in getTokenUsageWithPricingByUser:", error);
    return null;
  }
}

/**
 * Get token usage with pricing by model for an organization
 * @param supabase Supabase client
 * @param organizationId Organization ID
 * @param days Number of days to include (default: 30)
 * @returns Promise with token usage and pricing data by model
 */
export async function getTokenUsageWithPricingByModel(
  supabase: SupabaseClient,
  organizationId: string,
  days: number = 30
): Promise<TokenUsagePriceData[] | null> {
  try {
    // Calculate the start date
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString();

    // Query to get aggregated data by model with pricing
    const { data, error } = await supabase.rpc('get_token_usage_with_pricing_by_model', {
      org_id: organizationId,
      start_date: startDateStr
    });

    if (error) {
      console.error("Error fetching token usage with pricing by model:", error);
      return null;
    }

    return data;
  } catch (error) {
    console.error("Error in getTokenUsageWithPricingByModel:", error);
    return null;
  }
}

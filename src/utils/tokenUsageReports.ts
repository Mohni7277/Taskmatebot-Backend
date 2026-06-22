import { supabase } from './supabase';

/**
 * Get token usage statistics for a specific user
 * @param userId User ID
 * @param platformType Optional platform type filter
 * @param startDate Optional start date for filtering (ISO string)
 * @param endDate Optional end date for filtering (ISO string)
 * @returns Promise with the token usage statistics
 */
export async function getUserTokenUsageStats(
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

    const { data, error } = await query.order('timestamp', { ascending: false });

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
 * @param organizationId Organization ID
 * @param startDate Optional start date for filtering (ISO string)
 * @param endDate Optional end date for filtering (ISO string)
 * @returns Promise with the aggregated token usage statistics
 */
export async function getOrganizationTokenUsageStats(
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

    const { data, error } = await query.order('timestamp', { ascending: false });

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

/**
 * Get daily token usage summary for an organization
 * @param organizationId Organization ID
 * @param days Number of days to include in the summary (default: 30)
 * @returns Promise with daily token usage summary
 */
export async function getDailyTokenUsageSummary(
  organizationId: string,
  days: number = 30
) {
  try {
    // Calculate the start date
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString();

    // SQL query to get daily aggregated data
    const { data, error } = await supabase.rpc('get_daily_token_usage', {
      org_id: organizationId,
      start_date: startDateStr
    });

    if (error) {
      console.error("Error fetching daily token usage summary:", error);
      return null;
    }

    return data;
  } catch (error) {
    console.error("Error in getDailyTokenUsageSummary:", error);
    return null;
  }
}

/**
 * Get token usage by platform for an organization
 * @param organizationId Organization ID
 * @param days Number of days to include (default: 30)
 * @returns Promise with token usage by platform
 */
export async function getTokenUsageByPlatform(
  organizationId: string,
  days: number = 30
) {
  try {
    // Calculate the start date
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString();

    // Query to get aggregated data by platform using raw SQL
    const { data, error } = await supabase
      .rpc('get_token_usage_by_platform', {
        org_id: organizationId,
        start_date: startDateStr
      });

    if (error) {
      console.error("Error fetching token usage by platform:", error);
      return null;
    }

    return data;
  } catch (error) {
    console.error("Error in getTokenUsageByPlatform:", error);
    return null;
  }
}

/**
 * Get token usage by user for an organization
 * @param organizationId Organization ID
 * @param days Number of days to include (default: 30)
 * @param limit Maximum number of users to include (default: 10)
 * @returns Promise with token usage by user
 */
export async function getTokenUsageByUser(
  organizationId: string,
  days: number = 30,
  limit: number = 10
) {
  try {
    // Calculate the start date
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString();

    // Query to get aggregated data by user using raw SQL
    const { data, error } = await supabase
      .rpc('get_token_usage_by_user', {
        org_id: organizationId,
        start_date: startDateStr,
        user_limit: limit
      });

    if (error) {
      console.error("Error fetching token usage by user:", error);
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
        return data.map((item: { user_id: string; total_tokens: number }) => {
          const user = users.find(u => u.id === item.user_id);
          return {
            ...item,
            user_name: user ? user.name : 'Unknown User',
            user_email: user ? user.email : null
          };
        });
      }
    }

    return data;
  } catch (error) {
    console.error("Error in getTokenUsageByUser:", error);
    return null;
  }
}

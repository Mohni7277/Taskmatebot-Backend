-- Create function to get token usage by platform
CREATE OR REPLACE FUNCTION get_token_usage_by_platform(org_id UUID, start_date TIMESTAMPTZ)
RETURNS TABLE (
  platform_type TEXT,
  prompt_tokens BIGINT,
  completion_tokens BIGINT,
  total_tokens BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    token_usage.platform_type,
    SUM(token_usage.prompt_tokens)::BIGINT AS prompt_tokens,
    SUM(token_usage.completion_tokens)::BIGINT AS completion_tokens,
    SUM(token_usage.total_tokens)::BIGINT AS total_tokens
  FROM
    token_usage
  WHERE
    organization_id = org_id
    AND timestamp >= start_date
  GROUP BY
    platform_type
  ORDER BY
    total_tokens DESC;
END;
$$ LANGUAGE plpgsql;

-- Create function to get token usage by user
CREATE OR REPLACE FUNCTION get_token_usage_by_user(org_id UUID, start_date TIMESTAMPTZ, user_limit INT)
RETURNS TABLE (
  user_id UUID,
  total_tokens BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    token_usage.user_id,
    SUM(token_usage.total_tokens)::BIGINT AS total_tokens
  FROM
    token_usage
  WHERE
    organization_id = org_id
    AND timestamp >= start_date
  GROUP BY
    user_id
  ORDER BY
    total_tokens DESC
  LIMIT user_limit;
END;
$$ LANGUAGE plpgsql;

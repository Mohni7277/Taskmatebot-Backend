-- Create function to get daily token usage summary
CREATE OR REPLACE FUNCTION get_daily_token_usage(org_id UUID, start_date TIMESTAMPTZ)
RETURNS TABLE (
  date DATE,
  prompt_tokens BIGINT,
  completion_tokens BIGINT,
  total_tokens BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    DATE_TRUNC('day', timestamp)::DATE AS date,
    SUM(prompt_tokens)::BIGINT AS prompt_tokens,
    SUM(completion_tokens)::BIGINT AS completion_tokens,
    SUM(total_tokens)::BIGINT AS total_tokens
  FROM
    token_usage
  WHERE
    organization_id = org_id
    AND timestamp >= start_date
  GROUP BY
    DATE_TRUNC('day', timestamp)::DATE
  ORDER BY
    date DESC;
END;
$$ LANGUAGE plpgsql;

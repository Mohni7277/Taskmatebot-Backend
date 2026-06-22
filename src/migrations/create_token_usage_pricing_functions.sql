-- Create function to get daily token usage with pricing
CREATE OR REPLACE FUNCTION get_daily_token_usage_with_pricing(org_id UUID, start_date TIMESTAMPTZ)
RETURNS TABLE (
  date DATE,
  prompt_tokens BIGINT,
  completion_tokens BIGINT,
  total_tokens BIGINT,
  prompt_price DECIMAL(10, 6),
  completion_price DECIMAL(10, 6),
  total_price DECIMAL(10, 6)
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    DATE_TRUNC('day', timestamp)::DATE AS date,
    SUM(prompt_tokens)::BIGINT AS prompt_tokens,
    SUM(completion_tokens)::BIGINT AS completion_tokens,
    SUM(total_tokens)::BIGINT AS total_tokens,
    SUM(prompt_price)::DECIMAL(10, 6) AS prompt_price,
    SUM(completion_price)::DECIMAL(10, 6) AS completion_price,
    SUM(total_price)::DECIMAL(10, 6) AS total_price
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

-- Create function to get token usage with pricing by platform
CREATE OR REPLACE FUNCTION get_token_usage_with_pricing_by_platform(org_id UUID, start_date TIMESTAMPTZ)
RETURNS TABLE (
  platform_type TEXT,
  prompt_tokens BIGINT,
  completion_tokens BIGINT,
  total_tokens BIGINT,
  prompt_price DECIMAL(10, 6),
  completion_price DECIMAL(10, 6),
  total_price DECIMAL(10, 6)
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    token_usage.platform_type,
    SUM(token_usage.prompt_tokens)::BIGINT AS prompt_tokens,
    SUM(token_usage.completion_tokens)::BIGINT AS completion_tokens,
    SUM(token_usage.total_tokens)::BIGINT AS total_tokens,
    SUM(token_usage.prompt_price)::DECIMAL(10, 6) AS prompt_price,
    SUM(token_usage.completion_price)::DECIMAL(10, 6) AS completion_price,
    SUM(token_usage.total_price)::DECIMAL(10, 6) AS total_price
  FROM
    token_usage
  WHERE
    organization_id = org_id
    AND timestamp >= start_date
  GROUP BY
    platform_type
  ORDER BY
    total_price DESC;
END;
$$ LANGUAGE plpgsql;

-- Create function to get token usage with pricing by user
CREATE OR REPLACE FUNCTION get_token_usage_with_pricing_by_user(org_id UUID, start_date TIMESTAMPTZ, user_limit INT)
RETURNS TABLE (
  user_id UUID,
  prompt_tokens BIGINT,
  completion_tokens BIGINT,
  total_tokens BIGINT,
  prompt_price DECIMAL(10, 6),
  completion_price DECIMAL(10, 6),
  total_price DECIMAL(10, 6)
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    token_usage.user_id,
    SUM(token_usage.prompt_tokens)::BIGINT AS prompt_tokens,
    SUM(token_usage.completion_tokens)::BIGINT AS completion_tokens,
    SUM(token_usage.total_tokens)::BIGINT AS total_tokens,
    SUM(token_usage.prompt_price)::DECIMAL(10, 6) AS prompt_price,
    SUM(token_usage.completion_price)::DECIMAL(10, 6) AS completion_price,
    SUM(token_usage.total_price)::DECIMAL(10, 6) AS total_price
  FROM
    token_usage
  WHERE
    organization_id = org_id
    AND timestamp >= start_date
  GROUP BY
    user_id
  ORDER BY
    total_price DESC
  LIMIT user_limit;
END;
$$ LANGUAGE plpgsql;

-- Create function to get token usage with pricing by model
CREATE OR REPLACE FUNCTION get_token_usage_with_pricing_by_model(org_id UUID, start_date TIMESTAMPTZ)
RETURNS TABLE (
  model TEXT,
  prompt_tokens BIGINT,
  completion_tokens BIGINT,
  total_tokens BIGINT,
  prompt_price DECIMAL(10, 6),
  completion_price DECIMAL(10, 6),
  total_price DECIMAL(10, 6)
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    token_usage.model,
    SUM(token_usage.prompt_tokens)::BIGINT AS prompt_tokens,
    SUM(token_usage.completion_tokens)::BIGINT AS completion_tokens,
    SUM(token_usage.total_tokens)::BIGINT AS total_tokens,
    SUM(token_usage.prompt_price)::DECIMAL(10, 6) AS prompt_price,
    SUM(token_usage.completion_price)::DECIMAL(10, 6) AS completion_price,
    SUM(token_usage.total_price)::DECIMAL(10, 6) AS total_price
  FROM
    token_usage
  WHERE
    organization_id = org_id
    AND timestamp >= start_date
    AND model IS NOT NULL
  GROUP BY
    model
  ORDER BY
    total_price DESC;
END;
$$ LANGUAGE plpgsql;

-- Create token_usage table to track AI token usage across all platforms
CREATE TABLE IF NOT EXISTS token_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  platform_type VARCHAR(20) NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  finish_reason VARCHAR(50),
  model VARCHAR(50),
  conversation_id TEXT,
  organization_id UUID,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Add foreign key constraints
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_organization FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_token_usage_user_id ON token_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_platform_type ON token_usage(platform_type);
CREATE INDEX IF NOT EXISTS idx_token_usage_organization_id ON token_usage(organization_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);

-- Add comment to the table
COMMENT ON TABLE token_usage IS 'Tracks AI token usage across different platforms (Slack, Teams, WhatsApp, Telegram)';

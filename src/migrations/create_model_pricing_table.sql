-- Create model_pricing table to store pricing information for different models
CREATE TABLE IF NOT EXISTS model_pricing (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  model_name TEXT NOT NULL UNIQUE,
  prompt_price_per_million DECIMAL(10, 4) NOT NULL,  -- Price per 1M prompt tokens
  completion_price_per_million DECIMAL(10, 4) NOT NULL,  -- Price per 1M completion tokens
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add comment to the table
COMMENT ON TABLE model_pricing IS 'Stores pricing information for different AI models';

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_model_pricing_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_model_pricing_updated_at
BEFORE UPDATE ON model_pricing
FOR EACH ROW
EXECUTE FUNCTION update_model_pricing_updated_at();

-- Insert initial pricing data for GPT-4o models
INSERT INTO model_pricing (model_name, prompt_price_per_million, completion_price_per_million)
VALUES 
  ('gpt-4o', 2.50, 10.00),
  ('gpt-4o-2024-08-06', 1.25, 2.50)
ON CONFLICT (model_name) 
DO UPDATE SET 
  prompt_price_per_million = EXCLUDED.prompt_price_per_million,
  completion_price_per_million = EXCLUDED.completion_price_per_million,
  updated_at = NOW();

-- Add price columns to token_usage table
ALTER TABLE token_usage 
ADD COLUMN IF NOT EXISTS prompt_price DECIMAL(10, 6) DEFAULT 0,
ADD COLUMN IF NOT EXISTS completion_price DECIMAL(10, 6) DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_price DECIMAL(10, 6) DEFAULT 0;

-- Create function to calculate token price based on model
CREATE OR REPLACE FUNCTION calculate_token_price()
RETURNS TRIGGER AS $$
DECLARE
  p_price DECIMAL(10, 6);
  c_price DECIMAL(10, 6);
  pricing_record RECORD;
BEGIN
  -- Get pricing for the model
  SELECT * INTO pricing_record FROM model_pricing WHERE model_name = NEW.model;
  
  IF FOUND THEN
    -- Calculate prices (convert from per million to per token)
    p_price := (NEW.prompt_tokens * pricing_record.prompt_price_per_million / 1000000);
    c_price := (NEW.completion_tokens * pricing_record.completion_price_per_million / 1000000);
    
    -- Update the price fields
    NEW.prompt_price := p_price;
    NEW.completion_price := c_price;
    NEW.total_price := p_price + c_price;
  ELSE
    -- Default pricing if model not found (can be adjusted as needed)
    NEW.prompt_price := 0;
    NEW.completion_price := 0;
    NEW.total_price := 0;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically calculate price on insert/update
CREATE TRIGGER calculate_token_price_trigger
BEFORE INSERT OR UPDATE OF prompt_tokens, completion_tokens, model ON token_usage
FOR EACH ROW
EXECUTE FUNCTION calculate_token_price();

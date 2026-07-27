-- Add total_premium column to commercial_quotes
-- Allows agents to record the total premium across all policies on a sold card.

ALTER TABLE public.commercial_quotes
  ADD COLUMN IF NOT EXISTS total_premium numeric DEFAULT NULL;

COMMENT ON COLUMN public.commercial_quotes.total_premium
  IS 'Total premium across all policies on this commercial quote card, entered by the agent once sold.';

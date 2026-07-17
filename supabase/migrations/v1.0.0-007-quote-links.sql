-- New Hope Work Desk v1.0.0
-- Migration: Create quote_links table
-- Part of: Customer Intake, Claim, and Duplicate Quote feature
-- Requirements: 14.3, 25.4
--
-- This table stores bidirectional links between operational quotes.
-- Links are created when a Manager resolves a duplicate review with
-- "keep_both_link" or "merge" decisions. The link_type distinguishes
-- whether both quotes remain active or one was merged into the other.

begin;

-- -----------------------------------------------------------------------------
-- Preflight: Ensure required dependency tables exist
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.operational_quotes') is null then
    raise exception 'quote_links migration requires the operational_quotes table. Run the operational_quotes migration first.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'quote_links migration requires the profiles table. Run base schema first.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- Create quote_links table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quote_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_a_id UUID NOT NULL REFERENCES operational_quotes(id),
  quote_b_id UUID NOT NULL REFERENCES operational_quotes(id),
  link_type TEXT NOT NULL CHECK (link_type IN ('keep_both', 'merged_source')),
  created_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Prevent a quote from being linked to itself
  CONSTRAINT no_self_link CHECK (quote_a_id != quote_b_id),

  -- Ensure only one link exists between any ordered pair of quotes
  CONSTRAINT unique_link UNIQUE (quote_a_id, quote_b_id)
);

commit;

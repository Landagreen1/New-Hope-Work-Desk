-- New Hope Work Desk v1.0.0
-- Migration: Create notifications table
-- Part of: Customer Intake, Claim, and Duplicate Quote feature
-- Requirements: 19.3, 20.3, 21.3
--
-- This table stores user notifications for claim events, duplicate flags,
-- duplicate resolutions, intake updates, and quote reassignments.
-- Notifications are delivered in real-time via Supabase Realtime and
-- persisted for page-load fallback queries.

begin;

-- -----------------------------------------------------------------------------
-- Preflight: Ensure the profiles table exists (notifications reference it)
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'notifications migration requires the profiles table. Run base schema first.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- Create notifications table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES profiles(id),

  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'quote_assigned',
    'intake_claimed',
    'duplicate_flagged',
    'duplicate_resolved',
    'intake_updated',
    'quote_reassigned'
  )),

  -- Payload (type-specific content)
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  action_url TEXT,

  -- Read/dismiss state
  is_read BOOLEAN NOT NULL DEFAULT false,
  is_dismissed BOOLEAN NOT NULL DEFAULT false,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ
);

-- -----------------------------------------------------------------------------
-- Index: Efficiently query unread, undismissed notifications for a recipient
-- sorted by newest first.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread
  ON notifications(recipient_id, created_at DESC)
  WHERE NOT is_read AND NOT is_dismissed;

commit;

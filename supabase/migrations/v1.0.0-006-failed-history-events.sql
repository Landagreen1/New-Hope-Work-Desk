-- New Hope Work Desk v1.0.0
-- Migration: Create failed_history_events recovery table
-- Part of: Customer Intake, Claim, and Duplicate Quote feature
-- Requirements: 17.4
--
-- This table stores history events that failed to persist so they can be
-- retried later. Per Requirement 17.4: "IF persistence of a History_Event
-- fails, THEN THE Work_Desk SHALL retry 3 times, then log for recovery
-- without blocking the originating action."
--
-- Dependencies: profiles table (for actor_id reference validation).

begin;

-- ---------------------------------------------------------------------------
-- Preflight: verify required tables exist before creating the recovery table.
-- ---------------------------------------------------------------------------
do $preflight$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.profiles') is null then
    v_missing := array_append(v_missing, 'profiles');
  end if;
  if to_regclass('public.intake_history_events') is null then
    v_missing := array_append(v_missing, 'intake_history_events');
  end if;
  if to_regclass('public.quote_history_events') is null then
    v_missing := array_append(v_missing, 'quote_history_events');
  end if;

  if cardinality(v_missing) > 0 then
    raise exception 'failed_history_events migration requires: %. Run prerequisite migrations first.',
      array_to_string(v_missing, ', ');
  end if;
end
$preflight$;

-- ---------------------------------------------------------------------------
-- Table: failed_history_events (recovery queue for failed history inserts)
-- ---------------------------------------------------------------------------
create table if not exists public.failed_history_events (
  id uuid primary key default gen_random_uuid(),

  -- Which history table the event was destined for
  target_table text not null check (target_table in (
    'intake_history_events',
    'quote_history_events'
  )),

  -- Original event data stored as JSONB payload
  -- Contains: intake_id or quote_id, actor_id, actor_display_name,
  -- event_type, details, changed_fields, reason, note_log_content, etc.
  payload jsonb not null,

  -- Retry tracking
  retry_count smallint not null default 0 check (retry_count between 0 and 3),
  error_message text,

  -- Recovery status
  status text not null default 'pending' check (status in (
    'pending',    -- awaiting retry
    'retried',    -- successfully retried and inserted into target table
    'recovered',  -- manually recovered by admin/support
    'abandoned'   -- exceeded retries, logged for manual review
  )),

  -- Timestamps
  created_at timestamptz not null default now(),
  last_retry_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Index: efficiently find pending events that need retry processing
-- ---------------------------------------------------------------------------
create index if not exists idx_failed_history_events_pending
  on public.failed_history_events(status, created_at asc)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- Index: lookup by target table for admin recovery workflows
-- ---------------------------------------------------------------------------
create index if not exists idx_failed_history_events_target
  on public.failed_history_events(target_table, status);

-- ---------------------------------------------------------------------------
-- Verification: confirm table, constraints, and indexes exist
-- ---------------------------------------------------------------------------
do $verify$
begin
  if to_regclass('public.failed_history_events') is null then
    raise exception 'failed_history_events table was not created.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'failed_history_events_target_table_check'
      and conrelid = 'public.failed_history_events'::regclass
  ) then
    -- Check constraints may have auto-generated names; verify via pg_check_constraints
    if not exists (
      select 1 from information_schema.check_constraints
      where constraint_schema = 'public'
        and check_clause like '%intake_history_events%'
        and check_clause like '%quote_history_events%'
    ) then
      raise exception 'target_table CHECK constraint is missing.';
    end if;
  end if;

  if not exists (
    select 1 from pg_indexes
    where indexname = 'idx_failed_history_events_pending'
  ) then
    raise exception 'idx_failed_history_events_pending index is missing.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where indexname = 'idx_failed_history_events_target'
  ) then
    raise exception 'idx_failed_history_events_target index is missing.';
  end if;
end
$verify$;

commit;

select 'failed_history_events recovery table created successfully' as status;

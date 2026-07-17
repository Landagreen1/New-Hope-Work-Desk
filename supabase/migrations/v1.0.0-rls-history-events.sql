-- New Hope Work Desk v1.0.0 — RLS policies for history event tables
-- Enables Row Level Security on intake_history_events and quote_history_events.
-- Both tables are immutable (append-only): SELECT-only policies, no UPDATE/DELETE.
-- Visibility is linked to the parent record — if a user can see the intake/quote,
-- they can see its history events.
--
-- Requirements: 17.5, 27.4
-- Depends on: intake_history_events, quote_history_events, customer_intakes, operational_quotes

begin;

-- ---------------------------------------------------------------------------
-- Preflight: verify required tables exist
-- ---------------------------------------------------------------------------
do $preflight$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.intake_history_events') is null then
    v_missing := array_append(v_missing, 'intake_history_events');
  end if;
  if to_regclass('public.quote_history_events') is null then
    v_missing := array_append(v_missing, 'quote_history_events');
  end if;
  if to_regclass('public.customer_intakes') is null then
    v_missing := array_append(v_missing, 'customer_intakes');
  end if;
  if to_regclass('public.operational_quotes') is null then
    v_missing := array_append(v_missing, 'operational_quotes');
  end if;

  if cardinality(v_missing) > 0 then
    raise exception 'RLS history-events migration requires: %. Run prerequisite migrations first.',
      array_to_string(v_missing, ', ');
  end if;
end
$preflight$;

-- ---------------------------------------------------------------------------
-- intake_history_events RLS (SELECT only — immutable by design)
-- ---------------------------------------------------------------------------
alter table public.intake_history_events enable row level security;

-- Users can read history events for intakes they have visibility on.
-- The EXISTS subquery leverages the parent table's RLS policies:
--   - CS users see history for their own intakes (cs_select_own policy)
--   - Agents see history for non-draft/non-deleted intakes (agent_select_queue policy)
--   - Managers see all history (manager_select_all policy)
drop policy if exists "read_intake_history" on public.intake_history_events;
create policy "read_intake_history"
  on public.intake_history_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.customer_intakes ci
      where ci.id = intake_history_events.intake_id
    )
  );

-- No INSERT policy for regular users — inserts happen via SECURITY DEFINER RPC functions.
-- No UPDATE policy — history events are immutable.
-- No DELETE policy — history events are immutable.

-- ---------------------------------------------------------------------------
-- quote_history_events RLS (SELECT only — immutable by design)
-- ---------------------------------------------------------------------------
alter table public.quote_history_events enable row level security;

-- Users can read history events for quotes they have visibility on.
-- The EXISTS subquery leverages the parent table's RLS policies:
--   - Agents see history for non-merged quotes (agent_select policy)
--   - Managers see all history (manager_all_quotes policy)
drop policy if exists "read_quote_history" on public.quote_history_events;
create policy "read_quote_history"
  on public.quote_history_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.operational_quotes q
      where q.id = quote_history_events.quote_id
    )
  );

-- No INSERT policy for regular users — inserts happen via SECURITY DEFINER RPC functions.
-- No UPDATE policy — history events are immutable.
-- No DELETE policy — history events are immutable.

-- ---------------------------------------------------------------------------
-- Verification: confirm RLS is enabled and policies exist
-- ---------------------------------------------------------------------------
do $verify$
begin
  -- Check RLS is enabled on intake_history_events
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'intake_history_events'
      and c.relrowsecurity = true
  ) then
    raise exception 'RLS is not enabled on intake_history_events.';
  end if;

  -- Check RLS is enabled on quote_history_events
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'quote_history_events'
      and c.relrowsecurity = true
  ) then
    raise exception 'RLS is not enabled on quote_history_events.';
  end if;

  -- Check read_intake_history policy exists
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'intake_history_events'
      and policyname = 'read_intake_history'
  ) then
    raise exception 'read_intake_history policy is missing.';
  end if;

  -- Check read_quote_history policy exists
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'quote_history_events'
      and policyname = 'read_quote_history'
  ) then
    raise exception 'read_quote_history policy is missing.';
  end if;
end
$verify$;

commit;

select 'RLS policies for intake_history_events and quote_history_events applied successfully' as status;

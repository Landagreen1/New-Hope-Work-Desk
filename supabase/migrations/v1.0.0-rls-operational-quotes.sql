-- New Hope Work Desk v1.0.0 — RLS policies for operational_quotes
-- Implements row-level security for Agents, Customer Service, and Managers.
-- Requirements: 27.2, 27.3, 15.3
--
-- Policies:
--   agent_select        — Agents can see team quotes excluding merged_duplicate
--   agent_update_own    — Agents can update quotes assigned to them
--   manager_all_quotes  — Managers get full CRUD access
--   cs_select_linked    — CS users can see quotes linked to intakes they created

begin;

-- -----------------------------------------------------------------------------
-- 1. Enable Row Level Security on the operational_quotes table.
-- -----------------------------------------------------------------------------
alter table public.operational_quotes enable row level security;

-- -----------------------------------------------------------------------------
-- 2. Drop existing policies if re-running (idempotent).
-- -----------------------------------------------------------------------------
drop policy if exists "agent_select" on public.operational_quotes;
drop policy if exists "agent_update_own" on public.operational_quotes;
drop policy if exists "manager_all_quotes" on public.operational_quotes;
drop policy if exists "cs_select_linked" on public.operational_quotes;

-- -----------------------------------------------------------------------------
-- 3. Agent SELECT policy
--    Agents can see all non-merged quotes (own + team), but merged_duplicate
--    records are excluded from their view. Managers also pass through this
--    policy for SELECT, but they have broader access via manager_all_quotes.
-- -----------------------------------------------------------------------------
create policy "agent_select" on public.operational_quotes
  for select
  to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'agent'
    and status != 'merged_duplicate'
  );

-- -----------------------------------------------------------------------------
-- 4. Agent UPDATE policy
--    Agents can only update quotes that are assigned to them.
--    This covers status changes, notes, attachments, etc.
-- -----------------------------------------------------------------------------
create policy "agent_update_own" on public.operational_quotes
  for update
  to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'agent'
    and assigned_to = auth.uid()
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'agent'
    and assigned_to = auth.uid()
  );

-- -----------------------------------------------------------------------------
-- 5. Manager full access policy
--    Managers can read, insert, update, and delete all quotes including
--    merged_duplicate records (for audit/review purposes).
-- -----------------------------------------------------------------------------
create policy "manager_all_quotes" on public.operational_quotes
  for all
  to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- -----------------------------------------------------------------------------
-- 6. Customer Service SELECT policy
--    CS users can view quotes that are linked to intakes they created.
--    This supports notification links and tracking downstream progress.
-- -----------------------------------------------------------------------------
create policy "cs_select_linked" on public.operational_quotes
  for select
  to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'customer_service'
    and exists (
      select 1
      from public.customer_intakes ci
      where ci.converted_quote_id = operational_quotes.id
        and ci.created_by = auth.uid()
    )
  );

commit;

-- -----------------------------------------------------------------------------
-- Verification: confirm policies are in place.
-- -----------------------------------------------------------------------------
select
  policyname,
  cmd,
  permissive
from pg_policies
where tablename = 'operational_quotes'
order by policyname;

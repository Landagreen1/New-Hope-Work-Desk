-- New Hope Work Desk v1.0.0
-- Row Level Security policies for customer_intakes table.
-- Enforces role-based access at the database layer:
--   - CS_User: own intakes only (create, read, update)
--   - Agent: queue view (non-draft, non-deleted)
--   - Manager: full read/write access including deleted (audit view)
--
-- Requirements: 27.1, 27.2, 27.3, 27.4
-- Spec: customer-intake-claim-duplicate-quote

begin;

-- -----------------------------------------------------------------------------
-- 0. Preflight: Confirm customer_intakes table exists.
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.customer_intakes') is null then
    raise exception 'customer_intakes table does not exist. Run v1.0.0-customer-intakes.sql first.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- 1. Enable Row Level Security on customer_intakes.
-- -----------------------------------------------------------------------------
alter table public.customer_intakes enable row level security;

-- -----------------------------------------------------------------------------
-- 2. CS_User policies: can see, insert, and update own intakes only.
-- -----------------------------------------------------------------------------

-- cs_select_own: CS_User can see own intakes only (created_by = auth.uid())
create policy "cs_select_own" on public.customer_intakes
  for select
  to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'customer_service'
    and created_by = auth.uid()
  );

-- cs_insert: CS_User can insert new intakes (created_by must be self)
create policy "cs_insert" on public.customer_intakes
  for insert
  to authenticated
  with check (
    (select role from public.profiles where id = auth.uid()) = 'customer_service'
    and created_by = auth.uid()
  );

-- cs_update_own: CS_User can update own intakes (status-dependent logic enforced in RPC)
create policy "cs_update_own" on public.customer_intakes
  for update
  to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'customer_service'
    and created_by = auth.uid()
  );

-- -----------------------------------------------------------------------------
-- 3. Agent policy: can view submitted/claimed/converted intakes (queue view).
--    Excludes drafts and deleted records from agent visibility.
-- -----------------------------------------------------------------------------

create policy "agent_select_queue" on public.customer_intakes
  for select
  to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'agent'
    and status not in ('draft', 'deleted')
  );

-- -----------------------------------------------------------------------------
-- 4. Manager policies: full read and update access including deleted (audit view).
-- -----------------------------------------------------------------------------

-- manager_select_all: Manager full read access including deleted
create policy "manager_select_all" on public.customer_intakes
  for select
  to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- manager_update_all: Manager can update any intake
create policy "manager_update_all" on public.customer_intakes
  for update
  to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- -----------------------------------------------------------------------------
-- 5. Verification: confirm RLS is enabled and all policies exist.
-- -----------------------------------------------------------------------------
do $verify$
declare
  v_rls_enabled boolean;
  v_missing text[] := array[]::text[];
begin
  -- Check RLS is enabled
  select relrowsecurity into v_rls_enabled
  from pg_class
  where oid = 'public.customer_intakes'::regclass;

  if not v_rls_enabled then
    raise exception 'RLS is not enabled on customer_intakes.';
  end if;

  -- Check each policy exists
  if not exists (
    select 1 from pg_policies
    where tablename = 'customer_intakes' and policyname = 'cs_select_own'
  ) then
    v_missing := array_append(v_missing, 'cs_select_own');
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'customer_intakes' and policyname = 'cs_insert'
  ) then
    v_missing := array_append(v_missing, 'cs_insert');
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'customer_intakes' and policyname = 'cs_update_own'
  ) then
    v_missing := array_append(v_missing, 'cs_update_own');
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'customer_intakes' and policyname = 'agent_select_queue'
  ) then
    v_missing := array_append(v_missing, 'agent_select_queue');
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'customer_intakes' and policyname = 'manager_select_all'
  ) then
    v_missing := array_append(v_missing, 'manager_select_all');
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'customer_intakes' and policyname = 'manager_update_all'
  ) then
    v_missing := array_append(v_missing, 'manager_update_all');
  end if;

  if cardinality(v_missing) > 0 then
    raise exception 'Missing RLS policies: %', array_to_string(v_missing, ', ');
  end if;
end
$verify$;

commit;

select 'New Hope Work Desk v1.0.0 customer_intakes RLS policies installed' as status;

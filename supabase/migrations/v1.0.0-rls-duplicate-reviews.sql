-- New Hope Work Desk v1.0.0
-- Migration: Row Level Security policies for duplicate_reviews table
-- Part of: Customer Intake, Claim, and Duplicate Quote feature
-- Requirements: 27.2, 27.3
--
-- Agents can see reviews they flagged and insert new flags.
-- Managers can see all reviews and update them (resolve).
-- No DELETE policy — duplicate reviews are never deleted.

begin;

-- ---------------------------------------------------------------------------
-- Preflight: Ensure the duplicate_reviews table exists
-- ---------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.duplicate_reviews') is null then
    raise exception 'RLS migration requires the duplicate_reviews table. Run v1.0.0-006-duplicate-reviews.sql first.';
  end if;
end
$preflight$;

-- ---------------------------------------------------------------------------
-- Enable Row Level Security
-- ---------------------------------------------------------------------------
alter table public.duplicate_reviews enable row level security;

-- ---------------------------------------------------------------------------
-- Policy: agent_own_reviews
-- Agents can SELECT only reviews they personally flagged.
-- ---------------------------------------------------------------------------
create policy "agent_own_reviews"
  on public.duplicate_reviews
  for select
  to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'agent'
    and flagged_by = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- Policy: manager_all_reviews
-- Managers can SELECT all duplicate reviews (review queue).
-- ---------------------------------------------------------------------------
create policy "manager_all_reviews"
  on public.duplicate_reviews
  for select
  to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- ---------------------------------------------------------------------------
-- Policy: agent_insert_review
-- Agents can INSERT duplicate review records (flag a quote as duplicate).
-- ---------------------------------------------------------------------------
create policy "agent_insert_review"
  on public.duplicate_reviews
  for insert
  to authenticated
  with check (
    (select role from public.profiles where id = auth.uid()) = 'agent'
    and flagged_by = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- Policy: manager_update_review
-- Managers can UPDATE duplicate reviews (resolve them).
-- ---------------------------------------------------------------------------
create policy "manager_update_review"
  on public.duplicate_reviews
  for update
  to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- ---------------------------------------------------------------------------
-- Verification: Confirm RLS is enabled and all policies exist
-- ---------------------------------------------------------------------------
do $verify$
begin
  -- Check RLS is enabled
  if not exists (
    select 1 from pg_class
    where relname = 'duplicate_reviews'
      and relnamespace = 'public'::regnamespace
      and relrowsecurity = true
  ) then
    raise exception 'RLS is not enabled on duplicate_reviews.';
  end if;

  -- Check agent_own_reviews policy
  if not exists (
    select 1 from pg_policies
    where tablename = 'duplicate_reviews'
      and schemaname = 'public'
      and policyname = 'agent_own_reviews'
  ) then
    raise exception 'Policy agent_own_reviews is missing.';
  end if;

  -- Check manager_all_reviews policy
  if not exists (
    select 1 from pg_policies
    where tablename = 'duplicate_reviews'
      and schemaname = 'public'
      and policyname = 'manager_all_reviews'
  ) then
    raise exception 'Policy manager_all_reviews is missing.';
  end if;

  -- Check agent_insert_review policy
  if not exists (
    select 1 from pg_policies
    where tablename = 'duplicate_reviews'
      and schemaname = 'public'
      and policyname = 'agent_insert_review'
  ) then
    raise exception 'Policy agent_insert_review is missing.';
  end if;

  -- Check manager_update_review policy
  if not exists (
    select 1 from pg_policies
    where tablename = 'duplicate_reviews'
      and schemaname = 'public'
      and policyname = 'manager_update_review'
  ) then
    raise exception 'Policy manager_update_review is missing.';
  end if;
end
$verify$;

commit;

select 'duplicate_reviews RLS policies created successfully' as status;

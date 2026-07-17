-- New Hope Work Desk v1.0.0
-- Migration: RLS policies for notifications table
-- Part of: Customer Intake, Claim, and Duplicate Quote feature
-- Requirements: 19.3, 27.1, 27.2, 27.3
--
-- Policies:
--   own_notifications  (SELECT) — any authenticated user can read their own notifications
--   mark_own_read      (UPDATE) — any authenticated user can mark their own notifications as read/dismissed

begin;

-- -----------------------------------------------------------------------------
-- Enable Row Level Security
-- -----------------------------------------------------------------------------
alter table public.notifications enable row level security;

-- -----------------------------------------------------------------------------
-- Policy: own_notifications (SELECT)
-- Any authenticated user can see only their own notifications.
-- No role-specific logic — all roles get the same filter (recipient_id = auth.uid()).
-- -----------------------------------------------------------------------------
drop policy if exists "own_notifications" on public.notifications;

create policy "own_notifications" on public.notifications
  for select
  to authenticated
  using (recipient_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Policy: mark_own_read (UPDATE)
-- Any authenticated user can update their own notifications (mark read/dismissed).
-- The WITH CHECK ensures they cannot reassign a notification to another user.
-- -----------------------------------------------------------------------------
drop policy if exists "mark_own_read" on public.notifications;

create policy "mark_own_read" on public.notifications
  for update
  to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Verification: Confirm RLS is enabled and both policies exist
-- -----------------------------------------------------------------------------
do $verify$
declare
  v_rls_enabled boolean;
  v_select_policy_exists boolean;
  v_update_policy_exists boolean;
begin
  -- Check RLS is enabled on notifications
  select relrowsecurity into v_rls_enabled
  from pg_class
  where relname = 'notifications' and relnamespace = 'public'::regnamespace;

  if not v_rls_enabled then
    raise exception 'VERIFICATION FAILED: RLS is not enabled on notifications table.';
  end if;

  -- Check own_notifications policy exists
  select exists(
    select 1 from pg_policies
    where tablename = 'notifications'
      and schemaname = 'public'
      and policyname = 'own_notifications'
  ) into v_select_policy_exists;

  if not v_select_policy_exists then
    raise exception 'VERIFICATION FAILED: own_notifications policy does not exist.';
  end if;

  -- Check mark_own_read policy exists
  select exists(
    select 1 from pg_policies
    where tablename = 'notifications'
      and schemaname = 'public'
      and policyname = 'mark_own_read'
  ) into v_update_policy_exists;

  if not v_update_policy_exists then
    raise exception 'VERIFICATION FAILED: mark_own_read policy does not exist.';
  end if;

  raise notice 'VERIFICATION PASSED: notifications RLS enabled with own_notifications (SELECT) and mark_own_read (UPDATE) policies.';
end
$verify$;

commit;

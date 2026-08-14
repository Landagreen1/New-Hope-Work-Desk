-- New Hope Work Desk v1.14.0 — Bulk renewal assignment (forward-only)
--
-- Adds `renewal_assign_bulk`, and repairs `renewal_assign` to the provenance v0.9.13 intended.
-- Creates no table, no column, and no constraint.
--
-- ── WHY THIS EXISTS
--
-- The consolidated renewals collector export carries no agent column. It carries `Productor`,
-- which is the producer on the policy and not the Work Desk employee who owns the follow-up work.
-- `renewal_import_collector_batch` resolves an owner per row through the Requirement 3.3
-- precedence (manager lock, existing shared owner, domain owner bootstrap, producer mapping,
-- weighted balancing, manager review), and its last branch is deliberately *manager review*: a
-- record it cannot place stays visible and unowned. Clearing that bucket was a one-at-a-time job,
-- because `renewal_assign` takes a single record id. This function is the missing bulk primitive.
--
-- ── THE DRIFT THIS ALSO FIXES
--
-- The live `renewal_assign` is the pre-v0.9.13 body. It sets `assigned_to`, `assigned_at`, and
-- `status`, but *not* `assignment_source`. `v0.9.13-reconcile-renewal-security.sql` added
-- `assignment_source = 'manager'` under the comment "Manager assignments must carry explicit
-- provenance so a later source import cannot silently replace a manager's decision", and that
-- change never reached the database — v0.9.7 and v0.9.8 both define the function without it, and
-- one of those is what is running.
--
-- It matters because `policy_followup_sync_domain_owner` protects a renewal from an automatic
-- ownership decision with exactly one test:
--
--     and (v_manager_decision or coalesce(record.assignment_source, '') <> 'manager')
--
-- A manager's hand assignment that is not stamped `manager` therefore has no protection from a
-- shared-owner decision arriving through the other domain. The exposure is narrower than it first
-- looks — `policy_followup_resolve_owner` step 3 bootstraps the shared owner *from* a present
-- `assigned_to` rather than reassigning it, so an ordinary reimport preserves the choice — but a
-- cancellation for the same (carrier, policy) resolving to a different employee will move the
-- renewal, and that is the case the stamp exists to prevent.
--
-- Repairing it here rather than separately is deliberate: a bulk assign that sticks and a single
-- assign that does not would be a worse inconsistency than either bug alone.
--
-- ── SCOPE: RENEWALS ONLY, ON PURPOSE
--
-- `renewal_assign_bulk` is exactly `renewal_assign` applied to N records. It does **not** write
-- `policy_followup_policy_owners` and does **not** set `assignment_locked`, so it does not pull
-- the matching cancellation cases along with it. That mirrors the existing single-record Reassign
-- action, which is renewal-only. `policy_followup_assign_policy` remains the deliberate
-- cross-domain, lock-setting path for a manager who wants one owner for the whole policy.
--
-- ── ROLLBACK
--   drop function if exists public.renewal_assign_bulk(uuid[], uuid);
--   -- and, to restore the pre-v1.14.0 renewal_assign, reapply the body from
--   -- v0.9.8-stabilize-integrations.sql (the one currently live). Not recommended: it is the
--   -- version missing the manager provenance stamp.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. renewal_assign — add the manager provenance stamp v0.9.13 intended
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.renewal_assign(p_record_id uuid, p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_name text;
  v_role text;
begin
  if public.nhwd_role() <> 'manager' then
    raise exception 'Manager access required.';
  end if;

  select profile.display_name, profile.role::text
    into v_name, v_role
    from public.profiles profile
   where profile.id = p_agent_id
     and profile.is_active;

  if not found or v_role not in ('agent', 'customer_service') then
    raise exception 'Choose an active Sales Agent or Customer Service employee.';
  end if;

  update public.renewal_records
     set assigned_to = p_agent_id,
         assigned_at = now(),
         -- v1.14.0: the provenance stamp. Without it
         -- policy_followup_sync_domain_owner will move this row for a shared-owner
         -- decision made elsewhere.
         assignment_source = 'manager',
         status = case when status::text = 'imported' then 'assigned' else status end,
         updated_at = now()
   where id = p_record_id;

  if not found then
    raise exception 'Renewal not found.';
  end if;

  insert into public.renewal_events(record_id, actor_id, event_type, detail)
  values (
    p_record_id,
    auth.uid(),
    'assigned',
    jsonb_build_object(
      'assigned_to', p_agent_id,
      'assigned_name', v_name,
      'role', v_role,
      'assignment_source', 'manager'));

  insert into public.user_notifications(
    recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (
    p_agent_id,
    'assignment',
    'Renewal assigned to you',
    'A Manager assigned a renewal record. Begin contact within the 30-day window.',
    'renewal',
    p_record_id);
end;
$function$;

comment on function public.renewal_assign(uuid, uuid) is
  'Assigns one renewal to an active Sales Agent or Customer Service employee, stamping assignment_source = manager so a later automatic ownership decision cannot replace it. Manager and super_admin only, through nhwd_role(). v1.14.0 restored the provenance stamp v0.9.13 specified.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. renewal_assign_bulk — the same decision over many records, in one transaction
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.renewal_assign_bulk(
  p_record_ids uuid[],
  p_agent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_name text;
  v_role text;
  v_ids uuid[];
  v_requested integer;
  v_record record;

  v_assigned integer := 0;   -- owner changed
  v_confirmed integer := 0;  -- already this employee; provenance stamped, nobody notified
  v_closed integer := 0;     -- renewed / lost / cancelled: an outcome is a human decision
  v_found integer := 0;
begin
  -- Manager_Role, which nhwd_role() reports for super_admin too.
  if public.nhwd_role() <> 'manager' then
    raise exception 'Manager access required.';
  end if;

  if p_record_ids is null or cardinality(p_record_ids) = 0 then
    raise exception 'Choose at least one renewal to assign.'
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  -- Distinct, so a repeated id is one assignment and one notification rather than several.
  select array_agg(distinct value)
    into v_ids
    from unnest(p_record_ids) as t(value)
   where value is not null;

  if v_ids is null or cardinality(v_ids) = 0 then
    raise exception 'Choose at least one renewal to assign.'
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  v_requested := cardinality(v_ids);

  -- A bound, not a business expectation. It keeps one call from locking an unbounded number of
  -- rows and from writing an unbounded number of notifications inside one transaction.
  if v_requested > 500 then
    raise exception 'Assign at most 500 renewals in one action (received %).', v_requested
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  select profile.display_name, profile.role::text
    into v_name, v_role
    from public.profiles profile
   where profile.id = p_agent_id
     and profile.is_active;

  if not found or v_role not in ('agent', 'customer_service') then
    raise exception 'Choose an active Sales Agent or Customer Service employee.';
  end if;

  -- Ordered by id so two concurrent bulk assigns over overlapping sets take the row locks in the
  -- same order and cannot deadlock against each other.
  for v_record in
    select record.id, record.status::text as status, record.assigned_to
      from public.renewal_records record
     where record.id = any(v_ids)
     order by record.id
     for update
  loop
    v_found := v_found + 1;

    -- A recorded outcome is a human decision; assignment does not reopen it.
    if v_record.status in ('renewed', 'lost', 'cancelled') then
      v_closed := v_closed + 1;
      continue;
    end if;

    -- Already this employee. The owner does not change, so nobody is notified, but the
    -- provenance stamp is still applied: that is the point of selecting the row.
    if v_record.assigned_to = p_agent_id then
      update public.renewal_records
         set assignment_source = 'manager',
             updated_at = now()
       where id = v_record.id
         and coalesce(assignment_source, '') <> 'manager';

      v_confirmed := v_confirmed + 1;
      continue;
    end if;

    update public.renewal_records
       set assigned_to = p_agent_id,
           assigned_at = now(),
           assignment_source = 'manager',
           status = case when status::text = 'imported' then 'assigned' else status end,
           updated_at = now()
     where id = v_record.id;

    v_assigned := v_assigned + 1;

    insert into public.renewal_events(record_id, actor_id, event_type, detail)
    values (
      v_record.id,
      auth.uid(),
      'assigned',
      jsonb_build_object(
        'assigned_to', p_agent_id,
        'assigned_name', v_name,
        'role', v_role,
        'assignment_source', 'manager',
        'previous_assigned_to', v_record.assigned_to,
        'bulk', true,
        'bulk_size', v_requested));

    insert into public.user_notifications(
      recipient_profile_id, notification_type, title, message, entity_type, entity_id)
    values (
      p_agent_id,
      'assignment',
      'Renewal assigned to you',
      'A Manager assigned a renewal record. Begin contact within the 30-day window.',
      'renewal',
      v_record.id);
  end loop;

  return jsonb_build_object(
    'requested', v_requested,
    'assigned', v_assigned,
    'confirmed', v_confirmed,
    'closed_skipped', v_closed,
    -- An id the manager could not read under row level security, or one already deleted. Counted
    -- rather than raised, so one stale row in a selection does not discard the rest of the work.
    'not_found', v_requested - v_found,
    'assigned_to', p_agent_id,
    'assigned_name', v_name);
end;
$function$;

comment on function public.renewal_assign_bulk(uuid[], uuid) is
  'Assigns many renewals to one active Sales Agent or Customer Service employee in a single transaction, stamping assignment_source = manager on each. Manager and super_admin only. Leaves a renewed, lost, or cancelled renewal untouched, stamps provenance without notifying when the employee already owns the row, and reports requested/assigned/confirmed/closed_skipped/not_found. Renewals only: it does not write policy_followup_policy_owners, so it never moves the matching cancellation cases — policy_followup_assign_policy remains the cross-domain path.';

grant execute on function public.renewal_assign_bulk(uuid[], uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Post-conditions
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Structural rather than behavioural: both functions are `security definer` and gate on
-- `nhwd_role()`, which reads `auth.uid()`. A migration runs with no authenticated session, so
-- calling either one here would fail the gate and prove nothing. The client contract and the
-- interface are covered by src/features/renewals/__tests__/bulk-assign.test.tsx; the function's own
-- behaviour was proven by a rolled-back probe against live, recorded in the deploy notes.

do $$
declare
  v_bulk text;
  v_single text;
begin
  select pg_get_functiondef(p.oid) into v_bulk
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'renewal_assign_bulk';

  if v_bulk is null then
    raise exception 'v1.14.0 did not create renewal_assign_bulk' using hint = 'Rolling back.';
  end if;

  if pg_get_function_identity_arguments(
       (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'renewal_assign_bulk'))
     <> 'p_record_ids uuid[], p_agent_id uuid' then
    raise exception 'v1.14.0 created renewal_assign_bulk with unexpected parameters: %',
      pg_get_function_identity_arguments(
        (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'renewal_assign_bulk'))
      using hint = 'Rolling back.';
  end if;

  -- The manager gate, the role check, the closed-status guard, and the provenance stamp are the
  -- four properties this function must not lose.
  if v_bulk not like '%nhwd_role() <> ''manager''%' then
    raise exception 'renewal_assign_bulk is missing the manager gate' using hint = 'Rolling back.';
  end if;
  if v_bulk not like '%''agent'', ''customer_service''%' then
    raise exception 'renewal_assign_bulk is missing the assignable-role check' using hint = 'Rolling back.';
  end if;
  if v_bulk not like '%''renewed'', ''lost'', ''cancelled''%' then
    raise exception 'renewal_assign_bulk is missing the closed-outcome guard' using hint = 'Rolling back.';
  end if;
  if v_bulk not like '%assignment_source = ''manager''%' then
    raise exception 'renewal_assign_bulk does not stamp assignment_source = manager'
      using detail = 'Without it policy_followup_sync_domain_owner can move the row.',
            hint = 'Rolling back.';
  end if;
  if v_bulk not like '%security definer%' and v_bulk not like '%SECURITY DEFINER%' then
    raise exception 'renewal_assign_bulk is not security definer' using hint = 'Rolling back.';
  end if;

  -- Cross-domain scope: it must not have grown a shared-owner write.
  if v_bulk like '%policy_followup_policy_owners%'
     or v_bulk like '%policy_followup_sync_domain_owner%'
     or v_bulk like '%assignment_locked%' then
    raise exception 'renewal_assign_bulk reaches into the shared owner tables'
      using detail = 'v1.14.0 is renewals-only; policy_followup_assign_policy is the cross-domain path.',
            hint = 'Rolling back.';
  end if;

  -- The repair.
  select pg_get_functiondef(p.oid) into v_single
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'renewal_assign';

  if v_single not like '%assignment_source = ''manager''%' then
    raise exception 'v1.14.0 left renewal_assign without the manager provenance stamp'
      using detail = 'v0.9.13 specified it and the live body was missing it.',
            hint = 'Rolling back.';
  end if;

  -- Execute must be available to the client role, or the surface cannot call it.
  if not has_function_privilege('authenticated',
        'public.renewal_assign_bulk(uuid[], uuid)', 'EXECUTE') then
    raise exception 'v1.14.0 did not grant execute on renewal_assign_bulk to authenticated'
      using hint = 'Rolling back.';
  end if;

  raise notice 'v1.14.0: renewal_assign_bulk created, renewal_assign provenance restored.';
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Verification — run after commit.
-- ═══════════════════════════════════════════════════════════════════════════════

select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
       pg_get_functiondef(p.oid) like '%assignment_source = ''manager''%' as stamps_manager
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('renewal_assign', 'renewal_assign_bulk')
 order by p.proname;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.13.4 — Bootstrap the shared owner from the assignments that already exist
--
-- Spec: .kiro/specs/policy-follow-up-assignment-workflow
-- Requirements: 3.3.3, 10.3, 13.2
-- Design: 4.4
--
-- Forward-only. This migration creates two functions and runs the bootstrap once.
--
-- ── The one rule that matters here
--
-- Every current manual assignment must survive. Design 4.4 gives three cases and forbids
-- guessing at the third:
--
--   * both domains agree, or only one domain has an owner -> bootstrap that owner
--   * the two domains name different employees            -> record a conflict, own nothing,
--                                                            and wait for a manager
--   * neither domain has an owner                          -> record the policy as unowned so
--                                                            the manager surface can list it
--
-- A conflict is never resolved by workload balancing. `policy_followup_resolve_owner`
-- already returns `ownership_conflict` and assigns nobody when it meets one, so an import
-- landing on a conflicted policy cannot quietly pick a side either.
--
-- ── What it does not do
--
-- It clears no `assigned_to` on any renewal or cancellation, changes no status, and writes
-- no customer-facing anything. A conflicted policy keeps both of its differing domain
-- owners exactly as they are — the conflict is a *manager question*, not a data repair, and
-- taking work away from either employee before the manager answers would be worse than the
-- inconsistency.
--
-- Re-running is safe: the upsert never overwrites an existing shared-owner row, so a second
-- run only picks up identities that appeared since the first.
-- ═══════════════════════════════════════════════════════════════════════════════

do $pre$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'policy_followup_resolve_owner'
  ) then
    raise exception 'v1.13.4 requires v1.13.3' using hint = 'Nothing was changed.';
  end if;
end;
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE BOOTSTRAP
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_bootstrap_owners_internal(
  p_actor_profile_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_identity record;
  v_bootstrapped integer := 0;
  v_conflicts integer := 0;
  v_unowned integer := 0;
  v_skipped integer := 0;
  v_conflict_list jsonb := '[]'::jsonb;
begin
  for v_identity in
    with renewal_owners as (
      select record.carrier_key,
             record.policy_number_normalized,
             array_agg(distinct record.assigned_to)
               filter (where record.assigned_to is not null) as owners,
             count(*) as rows_total
        from public.renewal_records record
       where record.carrier_key is not null
         and record.policy_number_normalized is not null
         and record.status::text = any(public.policy_followup_open_renewal_statuses())
       group by record.carrier_key, record.policy_number_normalized
    ),
    case_owners as (
      select kase.carrier_key,
             kase.policy_number_normalized,
             array_agg(distinct kase.assigned_to)
               filter (where kase.assigned_to is not null) as owners,
             count(*) as rows_total
        from public.cancellation_cases kase
       where kase.carrier_key is not null
         and kase.policy_number_normalized is not null
         and kase.case_status = any(public.policy_followup_active_case_statuses())
       group by kase.carrier_key, kase.policy_number_normalized
    )
    select coalesce(renewals.carrier_key, cases.carrier_key) as carrier_key,
           coalesce(renewals.policy_number_normalized, cases.policy_number_normalized) as policy_number_normalized,
           coalesce(renewals.owners, array[]::uuid[]) as renewal_owners,
           coalesce(cases.owners, array[]::uuid[]) as case_owners,
           -- The union of every distinct owner across both domains. One element is an
           -- agreement; two or more is the conflict design 4.4 refuses to guess at.
           (select array_agg(distinct owner)
              from unnest(coalesce(renewals.owners, array[]::uuid[])
                          || coalesce(cases.owners, array[]::uuid[])) as owner) as all_owners,
           coalesce(renewals.rows_total, 0) as renewal_rows,
           coalesce(cases.rows_total, 0) as case_rows
      from renewal_owners renewals
      full outer join case_owners cases
        on cases.carrier_key = renewals.carrier_key
       and cases.policy_number_normalized = renewals.policy_number_normalized
  loop
    -- Never disturb a shared-owner row that already exists: a decision recorded after this
    -- migration first ran outranks anything the domain rows still say.
    if exists (
      select 1 from public.policy_followup_policy_owners
       where carrier_key = v_identity.carrier_key
         and policy_number_normalized = v_identity.policy_number_normalized
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if v_identity.all_owners is null or cardinality(v_identity.all_owners) = 0 then
      -- Unowned. Recorded so the manager surface can list it and so the first import to
      -- reach it finds a row to lock.
      insert into public.policy_followup_policy_owners
        (carrier_key, policy_number_normalized, assignment_source)
      values (v_identity.carrier_key, v_identity.policy_number_normalized, 'migration')
      on conflict (carrier_key, policy_number_normalized) do nothing;
      v_unowned := v_unowned + 1;

    elsif cardinality(v_identity.all_owners) = 1 then
      -- Both domains agree, or only one has an owner. Bootstrap it.
      insert into public.policy_followup_policy_owners
        (carrier_key, policy_number_normalized, assigned_to, assignment_source,
         assigned_by, assigned_at)
      values (v_identity.carrier_key, v_identity.policy_number_normalized,
              v_identity.all_owners[1], 'migration', p_actor_profile_id, now())
      on conflict (carrier_key, policy_number_normalized) do nothing;

      insert into public.policy_followup_assignment_events
        (carrier_key, policy_number_normalized, event_type,
         previous_profile_id, next_profile_id, actor_profile_id, detail)
      values (v_identity.carrier_key, v_identity.policy_number_normalized, 'bootstrap',
              null, v_identity.all_owners[1], p_actor_profile_id,
              jsonb_build_object(
                'reason', 'bootstrap_from_domain_assignment',
                'renewal_rows', v_identity.renewal_rows,
                'cancellation_rows', v_identity.case_rows,
                'renewal_owners', to_jsonb(v_identity.renewal_owners),
                'cancellation_owners', to_jsonb(v_identity.case_owners)));

      -- Requirement 10.3: the domain that had no owner picks this one up. The domain that
      -- did already agrees, so the mirror is a no-op there.
      perform public.policy_followup_sync_domain_owner(
        v_identity.carrier_key, v_identity.policy_number_normalized,
        v_identity.all_owners[1], 'migration', p_actor_profile_id);

      v_bootstrapped := v_bootstrapped + 1;

    else
      -- design 4.4: differing owners. Own nothing, surface the question, leave both domain
      -- assignments exactly as they are.
      insert into public.policy_followup_policy_owners
        (carrier_key, policy_number_normalized, assignment_source, conflict, conflict_detail)
      values (v_identity.carrier_key, v_identity.policy_number_normalized, 'migration', true,
              jsonb_build_object(
                'renewal_owners', to_jsonb(v_identity.renewal_owners),
                'cancellation_owners', to_jsonb(v_identity.case_owners),
                'detected_at', now()))
      on conflict (carrier_key, policy_number_normalized) do nothing;

      insert into public.policy_followup_assignment_events
        (carrier_key, policy_number_normalized, event_type,
         previous_profile_id, next_profile_id, actor_profile_id, detail)
      values (v_identity.carrier_key, v_identity.policy_number_normalized, 'conflict',
              null, null, p_actor_profile_id,
              jsonb_build_object(
                'reason', 'bootstrap_owner_conflict',
                'renewal_owners', to_jsonb(v_identity.renewal_owners),
                'cancellation_owners', to_jsonb(v_identity.case_owners)));

      v_conflicts := v_conflicts + 1;
      v_conflict_list := v_conflict_list || jsonb_build_object(
        'carrier_key', v_identity.carrier_key,
        'policy_number_normalized', v_identity.policy_number_normalized,
        'renewal_owners', to_jsonb(v_identity.renewal_owners),
        'cancellation_owners', to_jsonb(v_identity.case_owners));
    end if;
  end loop;

  return jsonb_build_object(
    'bootstrapped', v_bootstrapped,
    'conflicts', v_conflicts,
    'unowned', v_unowned,
    'already_recorded', v_skipped,
    'conflict_detail', v_conflict_list);
end;
$fn$;

comment on function public.policy_followup_bootstrap_owners_internal(uuid) is
  'Backfills public.policy_followup_policy_owners from the assignments already stored on open renewals and active cancellations. Agreement bootstraps; disagreement records a manager-review conflict and owns nothing; neither records the policy as unowned. Never overwrites an existing shared-owner row, so re-running is safe. Requirement 3.3.3, design 4.4.';

revoke execute on function public.policy_followup_bootstrap_owners_internal(uuid)
  from public, anon, authenticated;

create or replace function public.policy_followup_bootstrap_owners()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.policy_followup_is_manager() then
    raise exception 'Manager access is required to bootstrap Policy Follow-up ownership.'
      using errcode = 'insufficient_privilege', hint = 'Nothing was written.';
  end if;

  return public.policy_followup_bootstrap_owners_internal(auth.uid());
end;
$fn$;

comment on function public.policy_followup_bootstrap_owners() is
  'Manager-gated re-run of the ownership bootstrap, for policies that appeared after the v1.13.4 deployment. Idempotent. Requirement 3.3.3.';

grant execute on function public.policy_followup_bootstrap_owners() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. RUN IT ONCE
--
--    Deliberately before any collector import and before automatic balancing is used, so
--    every policy that already had an owner keeps it and step 5 of the precedence never
--    sees a policy whose owner was merely unrecorded (design 16 step 3).
-- ═══════════════════════════════════════════════════════════════════════════════
do $bootstrap$
declare
  v_summary jsonb;
begin
  v_summary := public.policy_followup_bootstrap_owners_internal(null);

  raise notice 'v1.13.4 bootstrap: % owners bootstrapped, % conflicts for manager review, % unowned policies recorded, % already recorded.',
    v_summary ->> 'bootstrapped', v_summary ->> 'conflicts',
    v_summary ->> 'unowned', v_summary ->> 'already_recorded';

  if (v_summary ->> 'conflicts')::integer > 0 then
    raise notice 'v1.13.4 conflict detail: %', v_summary -> 'conflict_detail';
  end if;
end;
$bootstrap$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_conflicts_with_owner bigint;
  v_owned_open_renewals bigint;
  v_unrecorded bigint;
begin
  -- No conflict row may claim an owner, and the table CHECK should already guarantee it.
  select count(*) into v_conflicts_with_owner
    from public.policy_followup_policy_owners where conflict and assigned_to is not null;
  if v_conflicts_with_owner > 0 then
    raise exception 'v1.13.4 recorded % conflicts that also name an owner', v_conflicts_with_owner
      using detail = 'Design 4.4.', hint = 'Rolling back.';
  end if;

  -- Every open renewal that has an owner and a full identity now has a shared-owner row —
  -- either its own owner, or a conflict a manager will settle. Requirement 3.3.3: an
  -- existing assignment is bootstrapped, never dropped.
  select count(*) into v_unrecorded
    from public.renewal_records record
   where record.assigned_to is not null
     and record.carrier_key is not null
     and record.policy_number_normalized is not null
     and record.status::text = any(public.policy_followup_open_renewal_statuses())
     and not exists (
       select 1 from public.policy_followup_policy_owners owner
        where owner.carrier_key = record.carrier_key
          and owner.policy_number_normalized = record.policy_number_normalized);
  if v_unrecorded > 0 then
    raise exception 'v1.13.4 left % assigned open renewals with no shared-owner row', v_unrecorded
      using detail = 'Requirement 3.3.3.', hint = 'Rolling back.';
  end if;

  select count(*) into v_unrecorded
    from public.cancellation_cases kase
   where kase.assigned_to is not null
     and kase.carrier_key is not null
     and kase.policy_number_normalized is not null
     and kase.case_status = any(public.policy_followup_active_case_statuses())
     and not exists (
       select 1 from public.policy_followup_policy_owners owner
        where owner.carrier_key = kase.carrier_key
          and owner.policy_number_normalized = kase.policy_number_normalized);
  if v_unrecorded > 0 then
    raise exception 'v1.13.4 left % assigned active cancellations with no shared-owner row', v_unrecorded
      using detail = 'Requirement 3.3.3.', hint = 'Rolling back.';
  end if;

  -- Nothing was taken away from anybody: every open renewal that had an owner still has one.
  select count(*) into v_owned_open_renewals
    from public.renewal_records
   where status::text = any(public.policy_followup_open_renewal_statuses())
     and assigned_to is null
     and assignment_source is not null;
  if v_owned_open_renewals > 0 then
    raise exception 'v1.13.4 cleared the owner of % open renewals', v_owned_open_renewals
      using detail = 'Requirement 13.1 protects human-owned assignment.', hint = 'Rolling back.';
  end if;

  raise notice 'v1.13.4 applied: shared ownership is bootstrapped and every pre-existing assignment survived.';
end;
$post$;

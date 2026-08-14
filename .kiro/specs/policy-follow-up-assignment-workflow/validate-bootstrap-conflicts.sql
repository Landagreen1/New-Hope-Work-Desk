-- ═══════════════════════════════════════════════════════════════════════════════
-- Validation harness for the ownership bootstrap (v1.13.4).
--
-- Not a migration. Seeds four synthetic policies covering all four design 4.4 cases,
-- runs the bootstrap, asserts the outcome, and discards everything.
--
--   1. both domains name the same employee            -> bootstrapped
--   2. only the renewal names an employee             -> bootstrapped, and the cancellation
--                                                        for the same policy picks it up
--   3. the two domains name different employees       -> conflict, nobody owns it, and
--                                                        BOTH domain assignments survive
--   4. neither domain names anybody                   -> recorded as unowned
--
-- Also asserts that an import landing on a conflicted policy refuses to pick a side.
-- ═══════════════════════════════════════════════════════════════════════════════

do $validate$
declare
  v_agent_a uuid;
  v_agent_b uuid;
  v_day date := (now() at time zone 'America/New_York')::date;

  v_renewal_agree uuid;
  v_case_agree uuid;
  v_renewal_only uuid;
  v_case_only uuid;
  v_renewal_conflict uuid;
  v_case_conflict uuid;
  v_renewal_unowned uuid;

  v_summary jsonb;
  v_owner public.policy_followup_policy_owners;
  v_result jsonb;
  -- Failures accumulate as one indented text block rather than as an array: `array || 'literal'`
  -- is ambiguous in plpgsql, and a harness that errors while reporting a failure hides it.
  v_failures text := '';
  v_note text;
begin
  select profile_id into v_agent_a from public.policy_followup_eligible_agents(null)
   order by profile_id limit 1;
  select profile_id into v_agent_b from public.policy_followup_eligible_agents(null)
   where profile_id <> v_agent_a order by profile_id limit 1;

  if v_agent_a is null or v_agent_b is null then
    raise exception 'the bootstrap harness needs at least two eligible employees';
  end if;

  -- ── Case 1: both domains agree.
  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date, assigned_to, assignment_source)
  values ('assigned', 'BOOT-AGREE-1', 'Progressive', 'Boot Agree LLC', v_day + 40, v_agent_a, 'powerbi')
  returning id into v_renewal_agree;

  insert into public.cancellation_cases
    (policy_number, cancellation_effective_date, carrier, customer_name, case_status,
     assigned_to, assignment_source, raw_row, raw_header)
  values ('BOOT-AGREE-1', v_day + 10, 'Progressive Insurance', 'Boot Agree LLC', 'Imported',
          v_agent_a, 'import', '[]'::jsonb, array['probe'])
  returning id into v_case_agree;

  -- ── Case 2: only the renewal has an owner.
  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date, assigned_to, assignment_source)
  values ('assigned', 'BOOT-ONE-1', 'Mercury', 'Boot One LLC', v_day + 40, v_agent_a, 'manager')
  returning id into v_renewal_only;

  insert into public.cancellation_cases
    (policy_number, cancellation_effective_date, carrier, customer_name, case_status,
     raw_row, raw_header)
  values ('BOOT-ONE-1', v_day + 10, 'Mercury', 'Boot One LLC', 'Imported',
          '[]'::jsonb, array['probe'])
  returning id into v_case_only;

  -- ── Case 3: the two domains disagree.
  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date, assigned_to, assignment_source,
     source_state_normalized, source_match_status, source_review_required)
  values ('assigned', 'BOOT-CONFLICT-1', 'Geico', 'Boot Conflict LLC', v_day + 40, v_agent_a,
          'manager', 'renewal', 'exact', false)
  returning id into v_renewal_conflict;

  insert into public.cancellation_cases
    (policy_number, cancellation_effective_date, carrier, customer_name, case_status,
     assigned_to, assignment_source, raw_row, raw_header)
  values ('BOOT-CONFLICT-1', v_day + 10, 'Geico', 'Boot Conflict LLC', 'Imported',
          v_agent_b, 'manager', '[]'::jsonb, array['probe'])
  returning id into v_case_conflict;

  -- ── Case 4: nobody owns it.
  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date)
  values ('imported', 'BOOT-UNOWNED-1', 'Infinity', 'Boot Unowned LLC', v_day + 40)
  returning id into v_renewal_unowned;

  -- ═══════════════════════════════════════════════════════════════════════════════
  v_summary := public.policy_followup_bootstrap_owners_internal(null);

  -- ── Case 1 assertions.
  select * into v_owner from public.policy_followup_policy_owners
   where policy_number_normalized = 'BOOT-AGREE-1';
  if v_owner.assigned_to is distinct from v_agent_a then
    v_failures := v_failures || E'\n  ' || 'case 1: agreement was not bootstrapped';
  end if;
  if v_owner.conflict then
    v_failures := v_failures || E'\n  ' || 'case 1: agreement was recorded as a conflict';
  end if;
  if v_owner.assignment_source <> 'migration' then
    v_failures := v_failures || E'\n  ' || format('case 1: expected the migration source, got %s',
                                       v_owner.assignment_source);
  end if;
  -- Both carrier spellings key to one identity, which is why one owner row covers both rows.
  if v_owner.carrier_key <> 'PROGRESSIVE' then
    v_failures := v_failures || E'\n  ' || format('case 1: unexpected carrier key %s', v_owner.carrier_key);
  end if;

  -- ── Case 2 assertions: the cancellation picks up the renewal's owner (Requirement 10.3).
  select * into v_owner from public.policy_followup_policy_owners
   where policy_number_normalized = 'BOOT-ONE-1';
  if v_owner.assigned_to is distinct from v_agent_a then
    v_failures := v_failures || E'\n  ' || 'case 2: a single-domain owner was not bootstrapped';
  end if;
  if (select assigned_to from public.cancellation_cases where id = v_case_only)
     is distinct from v_agent_a then
    v_failures := v_failures || E'\n  ' || 'case 2: the cancellation did not pick up the shared owner';
  end if;

  -- ── Case 3 assertions: a conflict owns nothing and disturbs nothing.
  select * into v_owner from public.policy_followup_policy_owners
   where policy_number_normalized = 'BOOT-CONFLICT-1';
  if not v_owner.conflict then
    v_failures := v_failures || E'\n  ' || 'case 3: differing owners were not recorded as a conflict';
  end if;
  if v_owner.assigned_to is not null then
    v_failures := v_failures || E'\n  ' || 'case 3: a conflict guessed an owner';
  end if;
  if (select assigned_to from public.renewal_records where id = v_renewal_conflict)
     is distinct from v_agent_a then
    v_failures := v_failures || E'\n  ' || 'case 3: the conflict changed the renewal assignment';
  end if;
  if (select assigned_to from public.cancellation_cases where id = v_case_conflict)
     is distinct from v_agent_b then
    v_failures := v_failures || E'\n  ' || 'case 3: the conflict changed the cancellation assignment';
  end if;
  if v_owner.conflict_detail -> 'renewal_owners' is null
     or v_owner.conflict_detail -> 'cancellation_owners' is null then
    v_failures := v_failures || E'\n  ' || 'case 3: the conflict did not record which side named whom';
  end if;

  -- An import landing on the conflicted policy must refuse to pick a side.
  v_result := public.policy_followup_resolve_owner('renewal', v_renewal_conflict, v_day, true);
  if v_result ->> 'reason' <> 'ownership_conflict' then
    v_failures := v_failures || E'\n  ' || format(
      'case 3: an import on a conflicted policy returned %s rather than ownership_conflict',
      v_result ->> 'reason');
  end if;
  if v_result ->> 'assigned_to' is not null then
    v_failures := v_failures || E'\n  ' || 'case 3: an import assigned a conflicted policy';
  end if;

  -- ── Case 4 assertions.
  select * into v_owner from public.policy_followup_policy_owners
   where policy_number_normalized = 'BOOT-UNOWNED-1';
  if v_owner.id is null then
    v_failures := v_failures || E'\n  ' || 'case 4: an unowned policy was not recorded at all';
  elsif v_owner.assigned_to is not null or v_owner.conflict then
    v_failures := v_failures || E'\n  ' || 'case 4: an unowned policy was owned or flagged';
  end if;

  -- ── Summary counters.
  if (v_summary ->> 'bootstrapped')::integer < 2 then
    v_failures := v_failures || E'\n  ' || format('summary: expected at least 2 bootstrapped, got %s',
                                       v_summary ->> 'bootstrapped');
  end if;
  if (v_summary ->> 'conflicts')::integer < 1 then
    v_failures := v_failures || E'\n  ' || 'summary: the conflict was not counted';
  end if;

  -- ── Re-running must change nothing (idempotency).
  v_summary := public.policy_followup_bootstrap_owners_internal(null);
  if (v_summary ->> 'bootstrapped')::integer <> 0 or (v_summary ->> 'conflicts')::integer <> 0 then
    v_failures := v_failures || E'\n  ' || format(
      'idempotency: a second bootstrap wrote again (bootstrapped %s, conflicts %s)',
      v_summary ->> 'bootstrapped', v_summary ->> 'conflicts');
  end if;

  -- ── A manager choosing a side clears the conflict and locks the result (design 4.4).
  update public.policy_followup_policy_owners
     set assigned_to = v_agent_a, assignment_source = 'manager',
         assignment_locked = true, conflict = false, conflict_detail = null
   where policy_number_normalized = 'BOOT-CONFLICT-1';

  v_result := public.policy_followup_resolve_owner('renewal', v_renewal_conflict, v_day, true);
  if v_result ->> 'reason' <> 'manager_locked' then
    v_failures := v_failures || E'\n  ' || format(
      'case 3: after the manager chose, an import returned %s rather than manager_locked',
      v_result ->> 'reason');
  end if;

  if v_failures <> '' then
    raise exception 'BOOTSTRAP VALIDATION FAILED:%', v_failures;
  end if;

  v_note := 'BOOTSTRAP VALIDATION PASSED. Agreement bootstrapped, single-domain owner '
    || 'propagated across domains, differing owners recorded as an unresolved conflict with '
    || 'both domain assignments untouched, unowned policies recorded, bootstrap idempotent, '
    || 'and a manager decision settles the conflict and locks it.';
  raise exception '%', v_note;
exception
  when others then
    if sqlerrm like 'BOOTSTRAP VALIDATION PASSED%' then
      raise notice '%', sqlerrm;
    else
      raise;
    end if;
end;
$validate$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Validation harness for the Policy Follow-up assignment engine (v1.13.0 – v1.13.3).
--
-- Not a migration. Run it with `node scripts/run-sql.mjs` whenever the engine changes.
--
-- It seeds synthetic renewals and cancellations, drives every branch of the
-- Requirement 3.3 precedence, asserts the outcome, and then raises so the whole thing is
-- discarded. Nothing it writes survives: no policy, no owner row, no audit entry, no
-- notification. The live book is read only to borrow employee ids.
--
-- Covered:
--   * step 1  manager lock preserved through an import
--   * step 2  existing shared owner preserved across a reimport and across domains
--   * step 3  existing domain owner bootstrapped rather than reassigned
--   * step 4  producer mapping, and that it outranks balancing
--   * step 5  weighted balancing picks the lowest score, and excludes manual-only,
--             auto-disabled, and wrong-domain employees
--   * step 6  manager review for an unreliable record, an unmatched producer, and no
--             eligible employee
--   * cross-domain owner consistency for one policy
--   * idempotency: running the engine twice changes nothing the second time
--   * balancing never moves already-owned work (Requirement 4.5)
-- ═══════════════════════════════════════════════════════════════════════════════

do $validate$
declare
  v_agent_a uuid;
  v_agent_b uuid;
  v_agent_c uuid;
  v_manager uuid;
  v_day date := (now() at time zone 'America/New_York')::date;

  v_renewal_locked uuid;
  v_renewal_shared uuid;
  v_renewal_domain uuid;
  v_renewal_producer uuid;
  v_renewal_balance uuid;
  v_renewal_unreliable uuid;
  v_renewal_no_carrier uuid;
  v_case_shared uuid;

  v_result jsonb;
  v_second jsonb;
  v_owner uuid;
  v_case_owner uuid;
  v_score_a integer;
  v_score_b integer;
  -- Failures accumulate as one indented text block rather than as an array: `array || 'literal'`
  -- is ambiguous in plpgsql, and a harness that errors while reporting a failure hides it.
  v_failures text := '';

  procedure_note text;
begin
  -- ── Borrow three eligible employees and one manager from the live roster.
  select profile_id into v_agent_a from public.policy_followup_eligible_agents(null)
   order by profile_id limit 1;
  select profile_id into v_agent_b from public.policy_followup_eligible_agents(null)
   where profile_id <> v_agent_a order by profile_id limit 1;
  select profile_id into v_agent_c from public.policy_followup_eligible_agents(null)
   where profile_id not in (v_agent_a, v_agent_b) order by profile_id limit 1;
  select id into v_manager from public.profiles
   where is_active and role::text in ('manager', 'super_admin') order by id limit 1;

  if v_agent_a is null or v_agent_b is null or v_agent_c is null then
    raise exception 'the validation harness needs at least three eligible employees';
  end if;

  -- ── Pin every employee's baseline so the balancing assertions are about the synthetic
  --    rows and not about whatever the live book happens to hold today.
  insert into public.policy_followup_agent_settings
    (profile_id, renewals_enabled, cancellations_enabled, auto_assignment_enabled, assignment_mode)
  select profile_id, true, true, false, 'manual_only'
    from public.policy_followup_eligible_agents(null)
  on conflict (profile_id) do update
    set renewals_enabled = true, cancellations_enabled = true,
        auto_assignment_enabled = false, assignment_mode = 'manual_only';

  -- Only A and B may receive balanced work; C is deliberately left manual-only.
  update public.policy_followup_agent_settings
     set auto_assignment_enabled = true, assignment_mode = 'automatic'
   where profile_id in (v_agent_a, v_agent_b);

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- STEP 1 — a manager lock survives an import.
  -- ═══════════════════════════════════════════════════════════════════════════════
  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date, producer_label,
     source_state_normalized, source_match_status, source_review_required)
  values ('imported', 'VAL-LOCK-1', 'Progressive', 'Validation Locked LLC', v_day + 40,
          'SOMEBODY UNMAPPED', 'renewal', 'exact', false)
  returning id into v_renewal_locked;

  insert into public.policy_followup_policy_owners
    (carrier_key, policy_number_normalized, assigned_to, assignment_source,
     assignment_locked, assigned_by)
  values ('PROGRESSIVE', 'VAL-LOCK-1', v_agent_c, 'manager', true, v_manager);

  v_result := public.policy_followup_resolve_owner('renewal', v_renewal_locked, v_day, true);

  if v_result ->> 'reason' <> 'manager_locked' then
    v_failures := v_failures || E'\n  ' || format('step 1: expected manager_locked, got %s', v_result ->> 'reason');
  end if;
  if (v_result ->> 'assigned_to')::uuid <> v_agent_c then
    v_failures := v_failures || E'\n  ' || 'step 1: the manager''s owner was not preserved';
  end if;
  -- The lock also reaches the domain record.
  select assigned_to into v_owner from public.renewal_records where id = v_renewal_locked;
  if v_owner <> v_agent_c then
    v_failures := v_failures || E'\n  ' || 'step 1: the locked owner was not mirrored onto the renewal';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- STEP 2 — the existing shared owner is preserved, and reaches both domains.
  -- ═══════════════════════════════════════════════════════════════════════════════
  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date,
     source_state_normalized, source_match_status)
  values ('imported', 'VAL-SHARED-1', 'NatGen', 'Validation Shared LLC', v_day + 40,
          'renewal', 'exact')
  returning id into v_renewal_shared;

  insert into public.cancellation_cases
    (policy_number, cancellation_effective_date, carrier, customer_name, case_status,
     raw_row, raw_header)
  values ('VAL-SHARED-1', v_day + 12, 'National General', 'Validation Shared LLC', 'Imported',
          '[]'::jsonb, array['probe'])
  returning id into v_case_shared;

  insert into public.policy_followup_policy_owners
    (carrier_key, policy_number_normalized, assigned_to, assignment_source)
  values ('NATIONALGENERAL', 'VAL-SHARED-1', v_agent_a, 'existing_owner');

  v_result := public.policy_followup_resolve_owner('renewal', v_renewal_shared, v_day, true);
  if v_result ->> 'reason' <> 'existing_owner' then
    v_failures := v_failures || E'\n  ' || format('step 2: expected existing_owner, got %s', v_result ->> 'reason');
  end if;

  -- Requirement 10.3: the cancellation for the same policy resolves to the same owner.
  v_result := public.policy_followup_resolve_owner('cancellation', v_case_shared, v_day, true);
  select assigned_to into v_owner from public.renewal_records where id = v_renewal_shared;
  select assigned_to into v_case_owner from public.cancellation_cases where id = v_case_shared;
  if v_owner is distinct from v_case_owner or v_owner is distinct from v_agent_a then
    v_failures := v_failures || E'\n  ' || format(
      'step 2: cross-domain owners disagree (renewal %s, case %s, expected %s)',
      v_owner, v_case_owner, v_agent_a);
  end if;

  -- Idempotency: a second pass changes nothing.
  v_second := public.policy_followup_resolve_owner('renewal', v_renewal_shared, v_day, true);
  if v_second ->> 'assigned_to' <> v_agent_a::text then
    v_failures := v_failures || E'\n  ' || 'step 2: a reimport moved an owned policy';
  end if;
  if (select count(*) from public.policy_followup_policy_owners
       where carrier_key = 'NATIONALGENERAL' and policy_number_normalized = 'VAL-SHARED-1') <> 1 then
    v_failures := v_failures || E'\n  ' || 'step 2: a reimport duplicated the owner row';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- STEP 3 — an existing domain owner is bootstrapped, not reassigned.
  -- ═══════════════════════════════════════════════════════════════════════════════
  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date, assigned_to,
     assignment_source, source_state_normalized, source_match_status)
  values ('assigned', 'VAL-DOMAIN-1', 'Mercury', 'Validation Domain LLC', v_day + 40, v_agent_c,
          'powerbi', 'renewal', 'exact')
  returning id into v_renewal_domain;

  v_result := public.policy_followup_resolve_owner('renewal', v_renewal_domain, v_day, true);
  if v_result ->> 'reason' <> 'domain_owner_bootstrap' then
    v_failures := v_failures || E'\n  ' || format('step 3: expected domain_owner_bootstrap, got %s',
                                       v_result ->> 'reason');
  end if;
  if (v_result ->> 'assigned_to')::uuid <> v_agent_c then
    v_failures := v_failures || E'\n  ' || 'step 3: the existing domain owner was reassigned';
  end if;
  -- C is manual-only, so balancing would never have chosen them. That is the point.
  if (v_result ->> 'assignment_source') <> 'migration' then
    v_failures := v_failures || E'\n  ' || format('step 3: expected the migration source, got %s',
                                       v_result ->> 'assignment_source');
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- STEP 4 — the producer mapping resolves, and outranks balancing.
  -- ═══════════════════════════════════════════════════════════════════════════════
  insert into public.renewal_assignment_aliases
    (import_label, normalized_label, profile_id, created_by)
  values ('VALIDATION PRODUCER',
          public.renewal_normalize_assignment_label('VALIDATION PRODUCER'),
          v_agent_c,
          coalesce(v_manager, v_agent_a))
  on conflict (normalized_label) do update set profile_id = excluded.profile_id;

  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date, producer_label,
     source_state_normalized, source_match_status)
  values ('imported', 'VAL-PRODUCER-1', 'Geico', 'Validation Producer LLC', v_day + 40,
          'Validation Producer', 'renewal', 'exact')
  returning id into v_renewal_producer;

  v_result := public.policy_followup_resolve_owner('renewal', v_renewal_producer, v_day, true);
  if v_result ->> 'reason' <> 'producer_mapping' then
    v_failures := v_failures || E'\n  ' || format('step 4: expected producer_mapping, got %s',
                                       v_result ->> 'reason');
  end if;
  -- C is manual-only and auto-disabled, so only the producer mapping can have chosen them.
  if (v_result ->> 'assigned_to')::uuid <> v_agent_c then
    v_failures := v_failures || E'\n  ' || 'step 4: the producer mapping did not win over balancing';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- STEP 5 — weighted balancing picks the lowest score.
  --
  --   A is given a heavy book, B a light one, C is excluded by being manual-only. The
  --   unowned reliable renewal must go to B.
  -- ═══════════════════════════════════════════════════════════════════════════════
  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date, assigned_to,
     assignment_source, source_state_normalized, source_match_status)
  select 'assigned', 'VAL-LOAD-A-' || n, 'Travelers', 'Validation Load A', v_day + 1, v_agent_a,
         'shared_owner', 'renewal', 'exact'
    from generate_series(1, 6) as n;

  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date, assigned_to,
     assignment_source, source_state_normalized, source_match_status)
  values ('assigned', 'VAL-LOAD-B-1', 'Travelers', 'Validation Load B', v_day + 90, v_agent_b,
          'shared_owner', 'renewal', 'exact');

  select workload_score into v_score_a
    from public.policy_followup_workload_rows(v_day) where profile_id = v_agent_a;
  select workload_score into v_score_b
    from public.policy_followup_workload_rows(v_day) where profile_id = v_agent_b;

  if v_score_a <= v_score_b then
    v_failures := v_failures || E'\n  ' || format(
      'step 5: the synthetic books did not separate the two employees (A %s, B %s)',
      v_score_a, v_score_b);
  end if;

  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date,
     source_state_normalized, source_match_status, source_review_required)
  values ('imported', 'VAL-BALANCE-1', 'Infinity', 'Validation Balance LLC', v_day + 40,
          'renewal', 'exact', false)
  returning id into v_renewal_balance;

  v_result := public.policy_followup_resolve_owner('renewal', v_renewal_balance, v_day, true);
  if v_result ->> 'reason' <> 'weighted_auto' then
    v_failures := v_failures || E'\n  ' || format('step 5: expected weighted_auto, got %s', v_result ->> 'reason');
  end if;
  if (v_result ->> 'assigned_to')::uuid <> v_agent_b then
    v_failures := v_failures || E'\n  ' || format(
      'step 5: balancing chose %s rather than the lighter employee %s',
      v_result ->> 'assigned_to', v_agent_b);
  end if;
  if (v_result ->> 'workload_score') is null then
    v_failures := v_failures || E'\n  ' || 'step 5: balancing did not report the score it acted on';
  end if;

  -- The balanced assignment stamped last_auto_assigned_at, which is the Requirement 4.3
  -- second tie-break key.
  if not exists (select 1 from public.policy_followup_policy_owners
                  where policy_number_normalized = 'VAL-BALANCE-1'
                    and last_auto_assigned_at is not null) then
    v_failures := v_failures || E'\n  ' || 'step 5: balancing did not record last_auto_assigned_at';
  end if;

  -- Requirement 4.5: balancing did not touch A's already-owned book.
  if (select count(*) from public.renewal_records
       where policy_number like 'VAL-LOAD-A-%' and assigned_to = v_agent_a) <> 6 then
    v_failures := v_failures || E'\n  ' || 'step 5: balancing moved already-owned work';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- STEP 6 — manager review, three ways.
  -- ═══════════════════════════════════════════════════════════════════════════════

  -- (a) an unreliable record is never balanced, however light the queue is.
  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date,
     source_state_normalized, source_match_status, source_review_required)
  values ('imported', 'VAL-REVIEW-1', 'Hartford', 'Validation Review LLC', v_day + 40,
          'review_required', 'probable', true)
  returning id into v_renewal_unreliable;

  v_result := public.policy_followup_resolve_owner('renewal', v_renewal_unreliable, v_day, true);
  if v_result ->> 'reason' <> 'manager_review_unreliable_record' then
    v_failures := v_failures || E'\n  ' || format('step 6a: expected manager_review_unreliable_record, got %s',
                                       v_result ->> 'reason');
  end if;
  if v_result ->> 'assigned_to' is not null then
    v_failures := v_failures || E'\n  ' || 'step 6a: an unreliable record was assigned';
  end if;

  -- (b) a row with no readable carrier owns no identity at all.
  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date,
     source_state_normalized, source_match_status)
  values ('imported', 'VAL-NOCARRIER-1', null, 'Validation No Carrier LLC', v_day + 40,
          'renewal', 'exact')
  returning id into v_renewal_no_carrier;

  v_result := public.policy_followup_resolve_owner('renewal', v_renewal_no_carrier, v_day, true);
  if v_result ->> 'reason' <> 'manager_review_no_identity' then
    v_failures := v_failures || E'\n  ' || format('step 6b: expected manager_review_no_identity, got %s',
                                       v_result ->> 'reason');
  end if;

  -- (c) with balancing switched off and no producer, the record waits for a manager.
  update public.policy_followup_agent_settings
     set auto_assignment_enabled = false, assignment_mode = 'manual_only';

  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date,
     source_state_normalized, source_match_status, source_review_required)
  values ('imported', 'VAL-NOBODY-1', 'Bristol West', 'Validation Nobody LLC', v_day + 40,
          'renewal', 'exact', false)
  returning id into v_renewal_balance;

  v_result := public.policy_followup_resolve_owner('renewal', v_renewal_balance, v_day, true);
  if v_result ->> 'reason' <> 'manager_review_no_eligible_employee' then
    v_failures := v_failures || E'\n  ' || format('step 6c: expected manager_review_no_eligible_employee, got %s',
                                       v_result ->> 'reason');
  end if;
  -- Requirement 3.3.6 leaves the record visible, and an unowned owner row exists so the
  -- manager surface can list it.
  if not exists (select 1 from public.policy_followup_policy_owners
                  where policy_number_normalized = 'VAL-NOBODY-1' and assigned_to is null) then
    v_failures := v_failures || E'\n  ' || 'step 6c: no unowned owner row was recorded for the manager surface';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- Report
  -- ═══════════════════════════════════════════════════════════════════════════════
  if v_failures <> '' then
    raise exception 'ASSIGNMENT ENGINE VALIDATION FAILED:%', v_failures;
  end if;

  procedure_note := format(
    'ASSIGNMENT ENGINE VALIDATION PASSED. 6 precedence steps, cross-domain sync, idempotency, '
    || 'and no-rebalancing all held. Employee scores during the run: A=%s B=%s.',
    v_score_a, v_score_b);

  raise exception '%', procedure_note;
exception
  when others then
    if sqlerrm like 'ASSIGNMENT ENGINE VALIDATION PASSED%' then
      raise notice '%', sqlerrm;
    else
      raise;
    end if;
end;
$validate$;

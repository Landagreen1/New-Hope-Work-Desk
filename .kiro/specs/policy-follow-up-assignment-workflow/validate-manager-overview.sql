-- ═══════════════════════════════════════════════════════════════════════════════
-- Validation harness for the Policy Follow-up reads (v1.13.5).
--
-- Not a migration. Seeds a synthetic book **larger than one rendered page** — 120
-- cancellation cases and 70 renewals, against a page size of 50 and a client load cap of
-- 1,000 — drives the Manager Overview, the bulk contact summaries, and the cross-domain
-- search, asserts the outcome, and discards everything.
--
-- The point of the volume is Requirement 9.5 / task 9.9: the numbers must come from the full
-- population, not from a loaded window. A counter computed client-side over the first 50 rows
-- would fail these assertions.
--
-- The harness impersonates a real manager by setting `request.jwt.claims`, which is what
-- `auth.uid()` reads, so the role gates are exercised rather than bypassed.
-- ═══════════════════════════════════════════════════════════════════════════════

do $validate$
declare
  v_manager uuid;
  v_agent_a uuid;
  v_agent_b uuid;
  v_day date := (now() at time zone 'America/New_York')::date;

  v_overview jsonb;
  v_renewals jsonb;
  v_cancellations jsonb;
  v_attention jsonb;
  v_record_id uuid;
  v_case_id uuid;
  v_summary record;
  v_search record;
  v_search_rows integer;
  -- Failures accumulate as one indented text block rather than as an array: `array || 'literal'`
  -- is ambiguous in plpgsql — Postgres tries to read the untyped literal as an array — and a
  -- harness that errors while reporting a failure hides the failure it found.
  v_failures text := '';
  v_note text;

  -- Baselines, so the assertions are about the synthetic rows rather than the live book.
  v_base_renewals integer;
  v_base_cases integer;
begin
  select id into v_manager from public.profiles
   where is_active and role::text in ('manager', 'super_admin') order by id limit 1;
  select profile_id into v_agent_a from public.policy_followup_eligible_agents(null)
   order by profile_id limit 1;
  select profile_id into v_agent_b from public.policy_followup_eligible_agents(null)
   where profile_id <> v_agent_a order by profile_id limit 1;

  if v_manager is null then
    raise exception 'the overview harness needs an active manager or super_admin profile';
  end if;

  -- Impersonate the manager for the rest of the transaction.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_manager::text)::text, true);

  if not public.policy_followup_is_manager() then
    raise exception 'the harness could not impersonate a manager; auth.uid() returned %', auth.uid();
  end if;

  select (v_overview -> 'renewals' ->> 'active')::integer into v_base_renewals from (select 1) t;
  v_overview := public.policy_followup_manager_overview(v_day);
  v_base_renewals := (v_overview -> 'renewals' ->> 'active')::integer;
  v_base_cases := (v_overview -> 'cancellations' ->> 'active')::integer;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- Seed 70 open renewals, well past one page.
  --
  --   30 assigned to A, 20 to B, 20 unassigned.
  --   10 with an overdue follow-up, 7 due today.
  --   6 Carrier Non-Renewal with no requote started.
  --   5 review-required with a probable match.
  -- ═══════════════════════════════════════════════════════════════════════════════
  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date, assigned_to, assignment_source,
     next_follow_up_at, source_system, source_state_normalized, source_match_status,
     source_review_required, producer_label)
  select 'assigned',
         'OVW-R-' || lpad(n::text, 3, '0'),
         'Progressive',
         'Overview Renewal ' || n,
         v_day + ((n % 60) + 1),
         case when n <= 30 then v_agent_a when n <= 50 then v_agent_b else null end,
         case when n <= 50 then 'shared_owner' else null end,
         case
           when n <= 10 then (v_day - 2)::timestamptz          -- overdue
           when n <= 17 then v_day::timestamptz                -- due today
           else null
         end,
         'renewal_collector',
         case
           when n between 18 and 23 then 'carrier_nonrenewal'  -- 6 non-renewals
           when n between 24 and 28 then 'review_required'      -- 5 review-required
           else 'renewal'
         end,
         case when n between 24 and 28 then 'probable' else 'exact' end,
         (n between 24 and 28),
         case when n between 60 and 64 then 'OVW UNMAPPED PRODUCER' else null end
    from generate_series(1, 70) as n;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- Seed 120 active cancellation cases — more than twice the 50-row page.
  --
  --   50 assigned to A, 30 to B, 40 unassigned.
  --   8 with an overdue follow-up deadline.
  --   12 whose effective date is exactly a touchpoint due date (15/10/5/1 days out).
  --   9 in payment verification, 6 with a failed communication status.
  -- ═══════════════════════════════════════════════════════════════════════════════
  insert into public.cancellation_cases
    (policy_number, cancellation_effective_date, carrier, customer_name, case_status,
     communication_status, assigned_to, assignment_source, follow_up_deadline,
     raw_row, raw_header)
  select 'OVW-C-' || lpad(n::text, 3, '0'),
         case
           when n <= 3  then v_day + 15
           when n <= 6  then v_day + 10
           when n <= 9  then v_day + 5
           when n <= 12 then v_day + 1
           else v_day + 20 + (n % 30)
         end,
         'Mercury',
         'Overview Case ' || n,
         case
           when n between 13 and 18 then 'Payment Reported'
           when n between 19 and 21 then 'Verification Pending'
           else 'Imported'
         end,
         case when n between 22 and 27 then 'Failed' else 'Not Scheduled' end,
         case when n <= 50 then v_agent_a when n <= 80 then v_agent_b else null end,
         case when n <= 80 then 'import' else null end,
         case when n between 28 and 35 then (v_day - 1)::timestamptz else null end,
         '[]'::jsonb,
         array['probe']
    from generate_series(1, 120) as n;

  -- ── One policy present in both domains, for the cross-domain assertions.
  insert into public.renewal_records
    (status, policy_number, carrier, customer_name, renewal_date, assigned_to, assignment_source,
     customer_phone, customer_email)
  values ('assigned', 'OVW-BOTH-1', 'Geico', 'Overview Both LLC', v_day + 30, v_agent_a,
          'shared_owner', '(305) 555-0199', 'both@example.invalid')
  returning id into v_record_id;

  insert into public.cancellation_cases
    (policy_number, cancellation_effective_date, carrier, customer_name, case_status,
     assigned_to, assignment_source, raw_row, raw_header)
  values ('OVW-BOTH-1', v_day + 8, 'Geico', 'Overview Both LLC', 'Imported',
          v_agent_a, 'import', '[]'::jsonb, array['probe'])
  returning id into v_case_id;

  insert into public.policy_followup_policy_owners
    (carrier_key, policy_number_normalized, assigned_to, assignment_source, assignment_locked,
     assigned_by)
  values ('GEICO', 'OVW-BOTH-1', v_agent_a, 'manager', true, v_manager);

  -- ── Contacts for the bulk-summary assertions.
  -- `renewal_contact_before_insert_v097` requires proof on a call, SMS, or email, so the
  -- harness supplies a reference exactly as the composer does.
  insert into public.renewal_contacts
    (record_id, contacted_by, channel, direction, outcome, notes, occurred_at, entry_source,
     evidence_reference)
  values (v_record_id, v_agent_a, 'call', 'outbound', 'Left voicemail', 'First attempt',
          (v_day - 4)::timestamptz, 'manual', 'OVW-PROBE-CALL-1'),
         (v_record_id, v_agent_a, 'call', 'outbound', 'Spoke with customer', 'Second attempt',
          (v_day - 1)::timestamptz, 'manual', 'OVW-PROBE-CALL-2');

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- Manager Overview (Requirements 9.2, 9.5)
  -- ═══════════════════════════════════════════════════════════════════════════════
  v_overview := public.policy_followup_manager_overview(v_day);
  v_renewals := v_overview -> 'renewals';
  v_cancellations := v_overview -> 'cancellations';
  v_attention := v_overview -> 'attention';

  if (v_overview ->> 'fullPopulation')::boolean is not true then
    v_failures := v_failures || E'\n  ' || 'the overview did not claim full-population counts';
  end if;
  if (v_overview ->> 'businessDate')::date <> v_day then
    v_failures := v_failures || E'\n  ' || 'the overview did not echo the business date it was asked for';
  end if;

  -- 71 synthetic open renewals: 70 plus the cross-domain one.
  if (v_renewals ->> 'active')::integer <> v_base_renewals + 71 then
    v_failures := v_failures || E'\n  ' || format('renewals.active expected %s, got %s',
                                       v_base_renewals + 71, v_renewals ->> 'active');
  end if;
  if (v_renewals ->> 'overdue')::integer < 10 then
    v_failures := v_failures || E'\n  ' || format('renewals.overdue expected at least 10, got %s',
                                       v_renewals ->> 'overdue');
  end if;
  if (v_renewals ->> 'needActionToday')::integer < 7 then
    v_failures := v_failures || E'\n  ' || format('renewals.needActionToday expected at least 7, got %s',
                                       v_renewals ->> 'needActionToday');
  end if;
  if (v_renewals ->> 'unassigned')::integer < 20 then
    v_failures := v_failures || E'\n  ' || format('renewals.unassigned expected at least 20, got %s',
                                       v_renewals ->> 'unassigned');
  end if;
  if (v_renewals ->> 'reviewRequired')::integer < 5 then
    v_failures := v_failures || E'\n  ' || format('renewals.reviewRequired expected at least 5, got %s',
                                       v_renewals ->> 'reviewRequired');
  end if;
  -- 70 of the 71 synthetic renewals have no contact at all.
  if (v_renewals ->> 'neverContacted')::integer < 70 then
    v_failures := v_failures || E'\n  ' || format('renewals.neverContacted expected at least 70, got %s',
                                       v_renewals ->> 'neverContacted');
  end if;

  -- 121 synthetic active cases: 120 plus the cross-domain one. This is the assertion that
  -- fails if anything computes over a 50-row page or a 1,000-row window.
  if (v_cancellations ->> 'active')::integer <> v_base_cases + 121 then
    v_failures := v_failures || E'\n  ' || format('cancellations.active expected %s, got %s',
                                       v_base_cases + 121, v_cancellations ->> 'active');
  end if;
  if (v_cancellations ->> 'unassigned')::integer < 40 then
    v_failures := v_failures || E'\n  ' || format('cancellations.unassigned expected at least 40, got %s',
                                       v_cancellations ->> 'unassigned');
  end if;
  if (v_cancellations ->> 'overdue')::integer < 8 then
    v_failures := v_failures || E'\n  ' || format('cancellations.overdue expected at least 8, got %s',
                                       v_cancellations ->> 'overdue');
  end if;
  -- The twelve touchpoint-dated cases, plus the eight whose deadline is past but whose
  -- effective date is not a touchpoint day, are the "need action today" population.
  if (v_cancellations ->> 'needActionToday')::integer < 12 then
    v_failures := v_failures || E'\n  ' || format('cancellations.needActionToday expected at least 12, got %s',
                                       v_cancellations ->> 'needActionToday');
  end if;
  if (v_cancellations ->> 'waiting')::integer < 9 then
    v_failures := v_failures || E'\n  ' || format('cancellations.waiting expected at least 9, got %s',
                                       v_cancellations ->> 'waiting');
  end if;

  if (v_attention ->> 'carrierNonRenewalAwaitingRequote')::integer < 6 then
    v_failures := v_failures || E'\n  ' || format('attention.carrierNonRenewalAwaitingRequote expected at least 6, got %s',
                                       v_attention ->> 'carrierNonRenewalAwaitingRequote');
  end if;
  if (v_attention ->> 'paymentVerificationRequired')::integer < 9 then
    v_failures := v_failures || E'\n  ' || format('attention.paymentVerificationRequired expected at least 9, got %s',
                                       v_attention ->> 'paymentVerificationRequired');
  end if;
  if (v_attention ->> 'failedCommunications')::integer < 6 then
    v_failures := v_failures || E'\n  ' || format('attention.failedCommunications expected at least 6, got %s',
                                       v_attention ->> 'failedCommunications');
  end if;
  if (v_attention ->> 'matchReviewRows')::integer < 5 then
    v_failures := v_failures || E'\n  ' || format('attention.matchReviewRows expected at least 5, got %s',
                                       v_attention ->> 'matchReviewRows');
  end if;
  if (v_attention ->> 'unmatchedProducerLabels')::integer < 1 then
    v_failures := v_failures || E'\n  ' || 'attention.unmatchedProducerLabels did not count the unmapped label';
  end if;
  -- 120 of the 121 synthetic cases have no contact row at all.
  if (v_attention ->> 'missingValidContact')::integer < 120 then
    v_failures := v_failures || E'\n  ' || format('attention.missingValidContact expected at least 120, got %s',
                                       v_attention ->> 'missingValidContact');
  end if;

  -- ── Team workload (Requirement 9.4): A carries more than B, and both are listed.
  if jsonb_array_length(v_overview -> 'agents') < 2 then
    v_failures := v_failures || E'\n  ' || 'the overview listed fewer than two employees';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_overview -> 'agents') agent
     where (agent ->> 'profile_id')::uuid = v_agent_a
       and (agent ->> 'active_renewals')::integer >= 30
       and (agent ->> 'active_cancellations')::integer >= 50
  ) then
    v_failures := v_failures || E'\n  ' || 'the team table did not report the seeded book for employee A';
  end if;
  if (select (agent ->> 'workload_score')::integer
        from jsonb_array_elements(v_overview -> 'agents') agent
       where (agent ->> 'profile_id')::uuid = v_agent_a)
     <= (select (agent ->> 'workload_score')::integer
           from jsonb_array_elements(v_overview -> 'agents') agent
          where (agent ->> 'profile_id')::uuid = v_agent_b) then
    v_failures := v_failures || E'\n  ' || 'the team table did not separate the two employees by score';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- Bulk contact summaries (Requirements 5.4, 15.1)
  -- ═══════════════════════════════════════════════════════════════════════════════
  select * into v_summary from public.renewal_contact_summaries(array[v_record_id]);
  if v_summary.record_id is null then
    v_failures := v_failures || E'\n  ' || 'the bulk contact summary returned nothing for a record with contacts';
  else
    if v_summary.contact_count <> 2 then
      v_failures := v_failures || E'\n  ' || format('the contact summary counted %s rather than 2',
                                         v_summary.contact_count);
    end if;
    if v_summary.last_contact_at::date <> (v_day - 1) then
      v_failures := v_failures || E'\n  ' || 'the contact summary reported the wrong latest occurrence';
    end if;
    if v_summary.last_outcome <> 'Spoke with customer' then
      v_failures := v_failures || E'\n  ' || format('the contact summary reported the outcome %s rather than the latest',
                                         coalesce(v_summary.last_outcome, 'null'));
    end if;
  end if;

  -- A record with no contacts is absent rather than returned as a zero row.
  if exists (select 1 from public.renewal_contact_summaries(
               array[(select id from public.renewal_records where policy_number = 'OVW-R-001')])) then
    v_failures := v_failures || E'\n  ' || 'the contact summary returned a row for a record with no contacts';
  end if;

  -- One call covers the whole page: 71 ids in, one round trip.
  if (select count(*) from public.renewal_contact_summaries(
        array(select id from public.renewal_records where policy_number like 'OVW-%'))) <> 1 then
    v_failures := v_failures || E'\n  ' || 'the bulk summary did not aggregate a whole page in one call';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- Cross-domain search (Requirements 10.2, 10.3)
  -- ═══════════════════════════════════════════════════════════════════════════════
  select count(*) into v_search_rows from public.policy_followup_policy_search('Overview Both', 25);
  if v_search_rows <> 1 then
    v_failures := v_failures || E'\n  ' || format('the search returned %s rows for one policy present in both domains',
                                       v_search_rows);
  end if;

  select * into v_search from public.policy_followup_policy_search('Overview Both', 25) limit 1;
  if not v_search.has_active_renewal or not v_search.has_active_cancellation then
    v_failures := v_failures || E'\n  ' || 'the search did not report the policy as active in both domains';
  end if;
  if v_search.owner_profile_id is distinct from v_agent_a then
    v_failures := v_failures || E'\n  ' || 'the search reported the wrong shared owner';
  end if;
  if not v_search.assignment_locked then
    v_failures := v_failures || E'\n  ' || 'the search did not report the manager lock';
  end if;
  if v_search.renewal_record_id is distinct from v_record_id
     or v_search.cancellation_case_id is distinct from v_case_id then
    v_failures := v_failures || E'\n  ' || 'the search did not name both domain records to open';
  end if;
  if v_search.carrier_key <> 'GEICO' then
    v_failures := v_failures || E'\n  ' || format('the search reported the carrier key %s', v_search.carrier_key);
  end if;

  -- Search by policy number, and by phone digits typed any way at all.
  if (select count(*) from public.policy_followup_policy_search('OVW-BOTH-1', 25)) <> 1 then
    v_failures := v_failures || E'\n  ' || 'the search did not find the policy by its number';
  end if;
  if (select count(*) from public.policy_followup_policy_search('3055550199', 25)) < 1 then
    v_failures := v_failures || E'\n  ' || 'the search did not find the policy by unformatted phone digits';
  end if;
  if (select count(*) from public.policy_followup_policy_search('', 25)) <> 0 then
    v_failures := v_failures || E'\n  ' || 'an empty search returned rows';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- Ownership exceptions (Requirement 9.3)
  -- ═══════════════════════════════════════════════════════════════════════════════
  perform public.policy_followup_bootstrap_owners_internal(v_manager);

  if (select count(*) from public.policy_followup_ownership_exceptions('unassigned', 1000)) < 40 then
    v_failures := v_failures || E'\n  ' || format(
      'the unassigned exception list returned %s rows for at least 60 unassigned policies',
      (select count(*) from public.policy_followup_ownership_exceptions('unassigned', 1000)));
  end if;

  if v_failures <> '' then
    raise exception 'MANAGER OVERVIEW VALIDATION FAILED:%', v_failures;
  end if;

  v_note := format(
    'MANAGER OVERVIEW VALIDATION PASSED over %s open renewals and %s active cancellations — '
    || 'both well past the 50-row page and the 1,000-row client window. Bulk contact summaries, '
    || 'cross-domain search, and the ownership exception list all held.',
    (v_renewals ->> 'active'), (v_cancellations ->> 'active'));
  raise exception '%', v_note;
exception
  when others then
    if sqlerrm like 'MANAGER OVERVIEW VALIDATION PASSED%' then
      raise notice '%', sqlerrm;
    else
      raise;
    end if;
end;
$validate$;

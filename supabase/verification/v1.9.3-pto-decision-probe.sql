-- New Hope Work Desk — v1.9.3 time-off decision probe
--
-- Spec: .kiro/specs/time-attendance-ui-redesign
-- Requirements: 10.11, 10.13, 10.14, 10.15, 10.16, 10.17, 10.18, 10.19, 21.10, 21.12
-- Companion to: supabase/migrations/v1.9.3-pto-decisions.sql
--
-- WHAT THIS ANSWERS, AND WHY THE MIGRATION CANNOT ANSWER IT
--
-- The migration's own verification block reports structure: the constraint carries
-- seven values, the two tables exist, the two unique constraints exist, the function
-- is security definer. None of that is behaviour. A unique constraint that exists is
-- not a replay that was refused, and a role test that compiles is not a manager who
-- was turned away.
--
-- This script exercises the behaviour: it gives pto_decide() real requests to decide,
-- decides them as four different signed-in users, replays a decision, feeds it a
-- payload that disagrees with the stored rows, and reads back the balance, the ledger,
-- and the audit row each time.
--
-- HOW IT IMPERSONATES
--
-- `set local role authenticated` drops out of the table-owning role so that the role
-- test inside pto_decide() is answered by a real caller, and
-- `set local request.jwt.claims` supplies the subject auth.uid() reads. pto_decide()
-- is `security definer`, so it still writes what it is entitled to write; what changes
-- with the impersonation is only who it believes is calling.
--
-- SAFETY
--
-- Every statement runs inside a single transaction that ends in ROLLBACK — including
-- the fixtures, the helper function, and every row pto_decide() writes. Nothing is
-- committed, so the counts in supabase/verification/row-retention/stage-4-pre.json
-- stay exact and Requirement 23, criterion 3 is unaffected. No row that existed before
-- the probe is read for anything other than a profile identifier. Fixture dates are in
-- 2099, so no real schedule, closed date, or balance year is involved. Re-runnable any
-- number of times.
--
-- USAGE
--
--   node scripts/run-sql.mjs supabase/verification/v1.9.3-pto-decision-probe.sql
--
-- Every row of the report must read PASS. The concurrent case is a separate script,
-- because two transactions cannot be arranged from one session:
--
--   supabase/verification/v1.9.3-pto-decide-lock-race.sql

begin;

-- ─────────────────────────────────────────────────────────────────────────────────
-- ACTORS
--
-- Drawn from live profiles rather than named, so the probe does not hard-code a
-- person. The manager is here because Requirement 21, criterion 12 withholds time-off
-- approval from `manager`: a manager must be refused exactly as an employee is.
-- ─────────────────────────────────────────────────────────────────────────────────
create temporary table probe_actors on commit drop as
select (select p.id from public.profiles p
         where p.is_active and p.role = 'super_admin'
         order by p.created_at, p.id limit 1)                    as decider,
       (select p.id from public.profiles p
         where p.is_active and p.role not in ('super_admin', 'manager')
         order by p.created_at, p.id limit 1)                    as employee,
       (select p.id from public.profiles p
         where p.is_active and p.role = 'manager'
         order by p.created_at, p.id limit 1)                    as a_manager;

create temporary table probe_results (
  ord      integer,
  section  text,
  probe    text,
  observed text,
  expected text
) on commit drop;

-- ─────────────────────────────────────────────────────────────────────────────────
-- CALLING PTO_DECIDE AS SOMEBODY
--
-- Created inside the transaction, so it rolls back with everything else. Returns the
-- function's envelope, or an envelope of its own describing the raise — every guard
-- rejection raises, and a raise that escaped would abort the probe rather than be
-- reported by it. The inner block is a subtransaction, so a rejected call leaves
-- nothing behind, which is what the "unchanged" assertions after each rejection read.
-- ─────────────────────────────────────────────────────────────────────────────────
create function public._probe_decide(
  p_actor uuid,
  p_request uuid,
  p_decision text,
  p_deltas jsonb default '[]'::jsonb,
  p_reason text default null,
  p_key text default null,
  p_approved jsonb default '[]'::jsonb,
  p_declined jsonb default '[]'::jsonb,
  p_suggested jsonb default '[]'::jsonb,
  p_expected_status text default null
) returns jsonb language plpgsql as $probe$
declare
  v_out jsonb;
begin
  begin
    execute 'set local role authenticated';
    execute format('set local request.jwt.claims = %L',
                   json_build_object('sub', p_actor, 'role', 'authenticated')::text);

    v_out := public.pto_decide(
      p_request, p_decision, null,
      p_approved, p_declined, p_suggested,
      p_deltas, p_reason, null, false,
      coalesce(p_key, 'probe-' || gen_random_uuid()::text),
      p_expected_status);

    execute 'reset role';
  exception
    when others then
      -- The subtransaction is already undone; the role setting went with it.
      v_out := jsonb_build_object(
        'ok', false, 'applied', false, 'raised', true,
        'code', split_part(sqlerrm, ':', 1),
        'sqlstate', sqlstate, 'error', sqlerrm);
  end;
  return v_out;
end
$probe$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 1. THE STATUS VOCABULARY (the constraint this stage widened)
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_employee uuid;
  v_monday   date := date_trunc('week', date '2099-01-15')::date;  -- a Monday
  v_status   text;
  v_ok       integer := 0;
  v_refused  text := 'accepted';
begin
  select employee into v_employee from probe_actors;
  if v_employee is null then
    raise exception 'probe needs an active non-administrator profile';
  end if;

  -- All seven values must be storable, the three new ones included.
  foreach v_status in array array['pending', 'approved', 'denied', 'cancelled',
                                 'waitlisted', 'information_requested', 'partially_approved']
  loop
    insert into public.pto_requests (profile_id, pto_type, start_date, end_date, total_days, status)
    values (v_employee, 'vacation', v_monday, v_monday, 1.0, v_status);
    v_ok := v_ok + 1;
  end loop;

  -- And nothing else may be.
  begin
    insert into public.pto_requests (profile_id, pto_type, start_date, end_date, total_days, status)
    values (v_employee, 'vacation', v_monday, v_monday, 1.0, 'not_a_status');
  exception
    when check_violation then v_refused := 'refused';
  end;

  insert into probe_results values
    (10, '1. status vocabulary', 'statuses the check accepts (was 4, now 7)', v_ok::text, '7'),
    (11, '1. status vocabulary', 'a status outside the vocabulary', v_refused, 'refused');

  -- Clear them: the decision fixtures below assert on exact request counts.
  delete from public.pto_requests where profile_id = v_employee and start_date = v_monday;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 2. GUARDS — who may decide, and what they may say (Requirements 10.19, 21.12)
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_decider  uuid;
  v_employee uuid;
  v_manager  uuid;
  v_monday   date := date_trunc('week', date '2099-02-16')::date;
  v_theirs   uuid := gen_random_uuid();
  v_own      uuid := gen_random_uuid();
  v_out      jsonb;
  v_status   text;
begin
  select decider, employee, a_manager into v_decider, v_employee, v_manager from probe_actors;

  -- An employee's request, and one the decider owns themselves.
  insert into public.pto_requests (id, profile_id, pto_type, start_date, end_date, total_days, status)
  values (v_theirs, v_employee, 'vacation', v_monday, v_monday + 4, 5.0, 'pending'),
         (v_own,    v_decider,  'vacation', v_monday, v_monday + 4, 5.0, 'pending');

  -- The employee whose request it is.
  v_out := public._probe_decide(v_employee, v_theirs, 'approve_full',
             jsonb_build_array(jsonb_build_object('year', 2099, 'balance_field', 'vacation_used', 'delta_days', 5)));
  insert into probe_results values
    (20, '2. guards', 'employee deciding their own request', v_out->>'code', 'NOT_AUTHORISED');

  -- A manager. Requirement 21, criterion 12 keeps time-off approval away from the role.
  if v_manager is not null then
    v_out := public._probe_decide(v_manager, v_theirs, 'approve_full',
               jsonb_build_array(jsonb_build_object('year', 2099, 'balance_field', 'vacation_used', 'delta_days', 5)));
    insert into probe_results values
      (21, '2. guards', 'manager deciding an employee request', v_out->>'code', 'NOT_AUTHORISED');
  end if;

  -- The administrator, on their own request. Requirement 10, criterion 19.
  v_out := public._probe_decide(v_decider, v_own, 'approve_full',
             jsonb_build_array(jsonb_build_object('year', 2099, 'balance_field', 'vacation_used', 'delta_days', 5)));
  insert into probe_results values
    (22, '2. guards', 'administrator deciding their OWN request', v_out->>'code', 'OWNER_CANNOT_DECIDE');

  -- Nothing moved on either request.
  select string_agg(r.status, ',' order by r.id) into v_status
    from public.pto_requests r where r.id in (v_theirs, v_own);
  insert into probe_results values
    (23, '2. guards', 'requests still pending after three refusals', v_status, 'pending,pending'),
    (24, '2. guards', 'decisions recorded by a refused call',
      (select count(*)::text from public.pto_request_decisions
        where request_id in (v_theirs, v_own)), '0'),
    (25, '2. guards', 'ledger movements recorded by a refused call',
      (select count(*)::text from public.pto_balance_ledger
        where request_id in (v_theirs, v_own)), '0');

  -- Payloads that contradict the stored rows, all from a legitimate administrator.
  v_out := public._probe_decide(v_decider, v_theirs, 'approve_full',
             jsonb_build_array(jsonb_build_object('year', 2099, 'balance_field', 'vacation_used', 'delta_days', 3)));
  insert into probe_results values
    (26, '2. guards', 'approval claiming 3 days for a 5-working-day range', v_out->>'code', 'DELTA_MISMATCH');

  v_out := public._probe_decide(v_decider, v_theirs, 'approve_full',
             jsonb_build_array(jsonb_build_object('year', 2099, 'balance_field', 'sick_used', 'delta_days', 5)));
  insert into probe_results values
    (27, '2. guards', 'vacation request debiting sick_used', v_out->>'code', 'BALANCE_FIELD_MISMATCH');

  v_out := public._probe_decide(v_decider, v_theirs, 'deny', '[]'::jsonb, '   ');
  insert into probe_results values
    (28, '2. guards', 'denial with a whitespace-only reason', v_out->>'code', 'REASON_REQUIRED');

  v_out := public._probe_decide(v_decider, v_theirs, 'waitlist',
             jsonb_build_array(jsonb_build_object('year', 2099, 'balance_field', 'vacation_used', 'delta_days', 5)));
  insert into probe_results values
    (29, '2. guards', 'waitlist carrying a balance movement', v_out->>'code', 'UNEXPECTED_BALANCE_DELTAS');

  v_out := public._probe_decide(v_decider, v_theirs, 'approve_full',
             jsonb_build_array(jsonb_build_object('year', 2099, 'balance_field', 'vacation_used', 'delta_days', 5)),
             null, null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'approved');
  insert into probe_results values
    (30, '2. guards', 'decision composed against a status the request no longer holds',
      v_out->>'code', 'stale_request_state');

  select string_agg(distinct r.status, ',') into v_status
    from public.pto_requests r where r.id in (v_theirs, v_own);
  insert into probe_results values
    (31, '2. guards', 'requests still pending after every refusal', v_status, 'pending');

  delete from public.pto_requests where id in (v_theirs, v_own);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 3. AN APPLIED DECISION, AND ITS REPLAY (Requirements 10.11, 10.13, 10.17)
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_decider  uuid;
  v_employee uuid;
  v_monday   date := date_trunc('week', date '2099-03-16')::date;
  v_request  uuid := gen_random_uuid();
  v_key      text := 'probe-apply-once';
  v_first    jsonb;
  v_second   jsonb;
  v_used     numeric;
begin
  select decider, employee into v_decider, v_employee from probe_actors;

  insert into public.pto_requests (id, profile_id, pto_type, start_date, end_date, total_days, status)
  values (v_request, v_employee, 'vacation', v_monday, v_monday + 4, 5.0, 'pending');

  -- A balance row with a known starting figure, so the increment is measurable.
  insert into public.pto_balances (profile_id, year, vacation_days, vacation_used)
  values (v_employee, 2099, 10, 2)
  on conflict (profile_id, year) do update set vacation_used = 2;

  v_first := public._probe_decide(v_decider, v_request, 'approve_full',
               jsonb_build_array(jsonb_build_object('year', 2099, 'balance_field', 'vacation_used', 'delta_days', 5)),
               'Cover is arranged', v_key);

  insert into probe_results values
    (40, '3. apply once', 'first submission applied', (v_first->>'applied'), 'true'),
    (41, '3. apply once', 'status the decision set', (v_first->>'new_status'), 'approved'),
    -- numeric(5,1) throughout, matching pto_balances and the ledger, so half days stay
    -- expressible: five whole working days serialise as 5.0.
    (42, '3. apply once', 'working days it counted (Mon-Fri)', (v_first->>'working_days'), '5.0'),
    (43, '3. apply once', 'pto_requests.status now',
      (select r.status from public.pto_requests r where r.id = v_request), 'approved'),
    (44, '3. apply once', 'reviewer recorded',
      (select case when r.reviewed_by = v_decider and r.reviewed_at is not null
                   then 'recorded' else 'missing' end
         from public.pto_requests r where r.id = v_request), 'recorded'),
    (45, '3. apply once', 'vacation_used, from 2 + 5 days',
      (select b.vacation_used::text from public.pto_balances b
        where b.profile_id = v_employee and b.year = 2099), '7.0'),
    (46, '3. apply once', 'ledger movements written',
      (select count(*)::text from public.pto_balance_ledger where request_id = v_request), '1'),
    (47, '3. apply once', 'ledger sum equals the balance movement',
      (select sum(l.delta_days)::text from public.pto_balance_ledger l where l.request_id = v_request), '5.0'),
    (48, '3. apply once', 'audit row written, carrying the nine fields of R10.11',
      (select case when count(*) = 1 then 'complete' else 'incomplete' end
         from public.attendance_audit_log a
        where a.entity_id = v_request
          and a.entity_type = 'pto_request'
          and a.action = 'pto_decision'
          and a.profile_id = v_employee
          and a.actor_profile_id = v_decider
          and a.reason = 'Cover is arranged'
          and a.old_value->>'status' = 'pending'
          and a.new_value->>'status' = 'approved'
          and a.new_value->>'decision' = 'approve_full'
          and jsonb_array_length(a.new_value->'affected_dates') = 5
          and a.created_at is not null), 'complete');

  -- The same decision again, same key.
  v_second := public._probe_decide(v_decider, v_request, 'approve_full',
                jsonb_build_array(jsonb_build_object('year', 2099, 'balance_field', 'vacation_used', 'delta_days', 5)),
                'Cover is arranged', v_key);

  select b.vacation_used into v_used from public.pto_balances b
   where b.profile_id = v_employee and b.year = 2099;

  insert into probe_results values
    (50, '4. replay', 'second submission applied', (v_second->>'applied'), 'false'),
    (51, '4. replay', 'code it answered with', (v_second->>'code'), 'already_applied'),
    (52, '4. replay', 'it reported the first decision',
      (case when v_second->>'decision_id' = v_first->>'decision_id' then 'same' else 'different' end), 'same'),
    (53, '4. replay', 'vacation_used after the replay (R10.17)', v_used::text, '7.0'),
    (54, '4. replay', 'decisions recorded for the request',
      (select count(*)::text from public.pto_request_decisions where request_id = v_request), '1'),
    (55, '4. replay', 'ledger movements after the replay',
      (select count(*)::text from public.pto_balance_ledger where request_id = v_request), '1');

  -- The constraints themselves, reached directly rather than through the function.
  -- The probe runs as the table owner here, so row level security is not what refuses.
  declare
    v_dup_decision text := 'accepted';
    v_dup_ledger   text := 'accepted';
    v_decision_id  uuid := (v_first->>'decision_id')::uuid;
  begin
    begin
      insert into public.pto_request_decisions
        (request_id, idempotency_key, decision, previous_status, new_status, actor_profile_id)
      values (v_request, v_key, 'approve_full', 'pending', 'approved', v_decider);
    exception when unique_violation then v_dup_decision := 'refused';
    end;

    begin
      insert into public.pto_balance_ledger
        (profile_id, request_id, decision_id, year, balance_field, delta_days)
      values (v_employee, v_request, v_decision_id, 2099, 'vacation_used', 5);
    exception when unique_violation then v_dup_ledger := 'refused';
    end;

    insert into probe_results values
      (56, '4. replay', 'unique (request_id, idempotency_key) on a repeat', v_dup_decision, 'refused'),
      (57, '4. replay', 'unique (decision_id, year, balance_field) on a repeat', v_dup_ledger, 'refused');
  end;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 5. THE INCREMENT ACCUMULATES, AND A REVERSAL RETURNS IT
--    (Requirements 10.13, 10.14, Correctness Property 29)
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_decider  uuid;
  v_employee uuid;
  v_monday   date := date_trunc('week', date '2099-05-11')::date;
  v_first    uuid := gen_random_uuid();
  v_second   uuid := gen_random_uuid();
  v_out      jsonb;
begin
  select decider, employee into v_decider, v_employee from probe_actors;

  -- Two requests, same employee, same year: one of five working days, one of three.
  insert into public.pto_requests (id, profile_id, pto_type, start_date, end_date, total_days, status)
  values (v_first,  v_employee, 'vacation', v_monday,      v_monday + 4,  5.0, 'pending'),
         (v_second, v_employee, 'vacation', v_monday + 14, v_monday + 16, 3.0, 'pending');

  insert into public.pto_balances (profile_id, year, vacation_days, vacation_used)
  values (v_employee, 2099, 10, 0)
  on conflict (profile_id, year) do update set vacation_used = 0;

  v_out := public._probe_decide(v_decider, v_first, 'approve_full',
             jsonb_build_array(jsonb_build_object('year', 2099, 'balance_field', 'vacation_used', 'delta_days', 5)));
  insert into probe_results values
    (60, '5. accumulation', 'after approving 5 days',
      (select b.vacation_used::text from public.pto_balances b
        where b.profile_id = v_employee and b.year = 2099), '5.0');

  v_out := public._probe_decide(v_decider, v_second, 'approve_full',
             jsonb_build_array(jsonb_build_object('year', 2099, 'balance_field', 'vacation_used', 'delta_days', 3)));
  insert into probe_results values
    (61, '5. accumulation', 'after approving 3 more, in place rather than overwritten',
      (select b.vacation_used::text from public.pto_balances b
        where b.profile_id = v_employee and b.year = 2099), '8.0');

  -- Requirement 10, criterion 14: denying what was approved returns the days.
  v_out := public._probe_decide(v_decider, v_first, 'deny',
             jsonb_build_array(jsonb_build_object('year', 2099, 'balance_field', 'vacation_used', 'delta_days', -5)),
             'Coverage could not be arranged after all');
  insert into probe_results values
    (62, '5. accumulation', 'denying the approved request credits it back',
      (select b.vacation_used::text from public.pto_balances b
        where b.profile_id = v_employee and b.year = 2099), '3.0'),
    (63, '5. accumulation', 'the credit is derived from the ledger, not guessed',
      (select sum(l.delta_days)::text from public.pto_balance_ledger l where l.request_id = v_first), '0.0'),
    (64, '5. accumulation', 'ledger rows for the reversed request', 
      (select count(*)::text from public.pto_balance_ledger l where l.request_id = v_first), '2'),
    (65, '5. accumulation', 'status after the denial',
      (select r.status from public.pto_requests r where r.id = v_first), 'denied');

  -- A decision that leaves the balance alone (Requirement 10, criteria 5, 6, and 7).
  v_out := public._probe_decide(v_decider, v_second, 'waitlist');
  insert into probe_results values
    (66, '5. accumulation', 'waitlisting moves the status',
      (select r.status from public.pto_requests r where r.id = v_second), 'waitlisted'),
    (67, '5. accumulation', 'waitlisting leaves the balance where it was',
      (select b.vacation_used::text from public.pto_balances b
        where b.profile_id = v_employee and b.year = 2099), '3.0');
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 6. A RANGE CROSSING 31 DECEMBER (Requirements 10.15, 10.16)
--    Each date is attributed to the calendar year containing it, so the request debits
--    two years. Expected counts are computed here from the rule rather than taken from
--    the function, so agreement means something.
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_decider  uuid;
  v_employee uuid;
  v_from     date := date '2099-12-28';
  v_to       date := date '2100-01-08';
  v_request  uuid := gen_random_uuid();
  v_expect   jsonb;
  v_out      jsonb;
  v_ledger   jsonb;
begin
  select decider, employee into v_decider, v_employee from probe_actors;

  insert into public.pto_requests (id, profile_id, pto_type, start_date, end_date, total_days, status)
  values (v_request, v_employee, 'personal', v_from, v_to, 12.0, 'pending');

  -- The working days per year, counted independently of pto_decide.
  select jsonb_agg(jsonb_build_object('year', s.year, 'balance_field', 'personal_used', 'delta_days', s.days)
                   order by s.year)
    into v_expect
    from (
      select extract(year from g)::int as year, count(*)::numeric as days
        from generate_series(v_from, v_to, interval '1 day') as g
       where extract(isodow from g) between 1 and 5
         and not exists (select 1 from public.attendance_closed_dates c where c.closed_date = g::date)
       group by 1
    ) s;

  v_out := public._probe_decide(v_decider, v_request, 'approve_full', v_expect);

  select jsonb_agg(jsonb_build_object('year', l.year, 'balance_field', l.balance_field,
                                      'delta_days', l.delta_days::numeric) order by l.year)
    into v_ledger
    from public.pto_balance_ledger l
   where l.request_id = v_request;

  insert into probe_results values
    (70, '6. year attribution', 'the approval was applied', (v_out->>'applied'), 'true'),
    (71, '6. year attribution', 'ledger rows, one per calendar year',
      (select count(*)::text from public.pto_balance_ledger where request_id = v_request), '2'),
    (72, '6. year attribution', 'the movement matches the independent count',
      (case when v_ledger = v_expect then 'matches' else v_ledger::text end), 'matches'),
    (73, '6. year attribution', 'balance rows created for both years',
      (select count(*)::text from public.pto_balances b
        where b.profile_id = v_employee and b.year in (2099, 2100)), '2'),
    (74, '6. year attribution', 'personal_used in 2100 equals that year''s working days',
      (select b.personal_used::text from public.pto_balances b
        where b.profile_id = v_employee and b.year = 2100),
      (select (e.value->>'delta_days')::numeric(5,1)::text from jsonb_array_elements(v_expect) e
        where (e.value->>'year')::int = 2100));
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- REPORT
-- ─────────────────────────────────────────────────────────────────────────────────
select section,
       probe,
       observed,
       expected,
       case when observed is not distinct from expected then 'PASS' else 'FAIL' end as verdict
  from probe_results
 order by ord;

rollback;

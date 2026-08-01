-- New Hope Work Desk — v1.9.2 read-policy probe
--
-- Spec: .kiro/specs/time-attendance-ui-redesign
-- Requirements: 21.10 (enforce at the API layer AND in row level security), 21.13, 21.14
-- Companion to: supabase/migrations/v1.9.2-attendance-reads.sql
--
-- WHAT THIS ANSWERS, AND WHY THE MIGRATION CANNOT ANSWER IT
--
-- payroll_summaries and staffing_thresholds are empty (v1.7.0-purge-test-data.sql
-- deleted the summaries; no migration has ever seeded a threshold — that is stage 6).
-- employee_payment_settings holds exactly one row and it belongs to a super_admin, who
-- could already read it through payment_settings_admin_all.
--
-- So a permitted read returns zero rows today, which looks identical to a refused read.
-- "The policy permits" and "the table has data" are different claims, and only the
-- first is v1.9.2's responsibility. This script proves the first by giving each table
-- rows to return, then reading them as four specific signed-in users.
--
-- HOW IT IMPERSONATES
--
-- `set local role authenticated` drops out of the table-owning role, so row level
-- security is actually evaluated — public.payroll_summaries has relforcerowsecurity =
-- false, meaning the owner would otherwise bypass every policy and every probe would
-- read everything. `set local request.jwt.claims` supplies the subject that auth.uid()
-- reads (it coalesces request.jwt.claim.sub with request.jwt.claims ->> 'sub').
--
-- SAFETY
--
-- Every statement runs inside a single transaction that ends in ROLLBACK. The fixtures
-- exist only for the length of the probe and are never committed, so the counts in
-- supabase/verification/row-retention/stage-3-pre.json stay exact and Requirement 23,
-- criterion 3 is unaffected. Re-runnable any number of times.
--
-- USAGE
--
--   node scripts/run-sql.mjs supabase/verification/v1.9.2-attendance-read-policies.sql
--
-- The `expected` column encodes the POST-migration position. Run this before applying
-- v1.9.2 and the three self-read probes report FAIL with observed 0 — that is the
-- v1.6.2 position the migration exists to correct, and it is worth capturing. Run it
-- after and every row must read PASS.

begin;

-- ─────────────────────────────────────────────────────────────────────────────────
-- ACTORS
--
-- Chosen from live profiles rather than hard-coded, so the probe does not name a
-- person. Employee A is the reader; employee B is the other employee whose row must
-- stay hidden from A. The manager is included because Requirement 21, criterion 12
-- withholds administration from `manager`: a manager must read their own rows and no
-- more, exactly like any other employee.
-- ─────────────────────────────────────────────────────────────────────────────────
create temporary table probe_actors on commit drop as
with employees as (
  select p.id, row_number() over (order by p.created_at, p.id) as rn
    from public.profiles p
   where p.is_active
     and p.role not in ('super_admin', 'manager')
)
select (select id from employees where rn = 1)                as employee_a,
       (select id from employees where rn = 2)                as employee_b,
       (select p.id from public.profiles p
         where p.role = 'manager' and p.is_active
         order by p.created_at, p.id limit 1)                 as a_manager,
       (select p.id from public.profiles p
         where p.role = 'super_admin' and p.is_active
         order by p.created_at, p.id limit 1)                 as a_super_admin;

create temporary table probe_fixtures on commit drop as
select gen_random_uuid() as period_id,
       gen_random_uuid() as summary_a_id,
       gen_random_uuid() as summary_b_id,
       gen_random_uuid() as threshold_id;

create temporary table probe_results (
  actor    text,
  probe    text,
  observed bigint,
  expected bigint
) on commit drop;

-- ─────────────────────────────────────────────────────────────────────────────────
-- FIXTURES (rolled back with everything else)
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  a uuid; b uuid; sa uuid;
  f record;
begin
  select employee_a, employee_b, a_super_admin into a, b, sa from probe_actors;
  select * into f from probe_fixtures;

  if a is null or b is null then
    raise exception 'probe needs two active non-administrator profiles; found a=%, b=%', a, b;
  end if;
  if sa is null then
    raise exception 'probe needs an active super_admin to confirm administrator reads still work';
  end if;

  -- A period to hang the summaries on. Its own readability is not what is under test;
  -- see decision 1 in the migration header.
  insert into public.payroll_periods (id, period_start, period_end, pay_date, payment_template, status)
  values (f.period_id, date '2000-01-01', date '2000-01-15', date '2000-01-20', 'biweekly', 'open');

  -- One summary each, so "reads own" and "cannot read another's" are distinguishable
  -- rather than both being zero.
  insert into public.payroll_summaries (id, payroll_period_id, profile_id, total_hours, gross_pay)
  values (f.summary_a_id, f.period_id, a, 80.00, 1000.00),
         (f.summary_b_id, f.period_id, b, 80.00, 2000.00);

  -- Pay settings for employee A. The one pre-existing real row belongs to the
  -- super_admin, which is why the administrator expectation below is 2 and A's is 1.
  insert into public.employee_payment_settings (profile_id, payment_template, hourly_rate, pay_type)
  values (a, 'biweekly', 12.50, 'hourly');

  -- One threshold, because the table is empty until stage 6.
  insert into public.staffing_thresholds (id, department, day_of_week, time_slot, minimum_staff, warning_threshold)
  values (f.threshold_id, 'sales', 1, 'full_day', 3, 4);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- THE PROBE
--
-- One block per actor, driven by a loop. Every read is taken while impersonating, into
-- a local variable; the results are recorded after `reset role`, so the temp table is
-- only ever written by the owning role and needs no grant.
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  act               record;
  f                 record;
  a                 uuid;
  b                 uuid;
  sa                uuid;
  v_uid             uuid;
  v_own_summaries   bigint;
  v_a_summary       bigint;
  v_all_summaries   bigint;
  v_settings        bigint;
  v_thresholds      bigint;
  v_periods         bigint;
  v_threshold_write bigint;
begin
  select employee_a, employee_b, a_super_admin into a, b, sa from probe_actors;
  select * into f from probe_fixtures;

  for act in
    select 1 as ord, '1. employee A (has own rows)'          as label, employee_a     as id from probe_actors
    union all
    select 2,        '2. employee B (the other employee)',        employee_b          from probe_actors
    union all
    select 3,        '3. manager (not an administrator)',         a_manager            from probe_actors
    union all
    select 4,        '4. super_admin (administrator)',            a_super_admin        from probe_actors
    order by ord
  loop
    continue when act.id is null;

    -- Become that signed-in user. Row level security applies from here.
    execute 'set local role authenticated';
    execute format('set local request.jwt.claims = %L',
                   json_build_object('sub', act.id, 'role', 'authenticated')::text);

    v_uid := auth.uid();

    -- Requirement 21.13 — own payroll summaries.
    select count(*) into v_own_summaries from public.payroll_summaries where profile_id = act.id;

    -- The negative case: employee A's row, read by each actor in turn.
    select count(*) into v_a_summary     from public.payroll_summaries where id = f.summary_a_id;

    -- Unfiltered read. Two fixture rows exist; a non-administrator must see at most one.
    select count(*) into v_all_summaries from public.payroll_summaries;

    -- Requirement 21.13 — own pay settings.
    select count(*) into v_settings      from public.employee_payment_settings;

    -- Requirement 21.14 — every signed-in user reads the thresholds.
    select count(*) into v_thresholds    from public.staffing_thresholds;

    -- Not granted by this stage, deliberately: payroll_periods stays administrator-only
    -- (decision 1 in the migration header).
    select count(*) into v_periods       from public.payroll_periods;

    -- Not granted by this stage either: the new policies are `for select`, so they
    -- confer no write. A blocked UPDATE affects zero rows rather than raising.
    update public.staffing_thresholds set minimum_staff = 99 where id = f.threshold_id;
    get diagnostics v_threshold_write = row_count;

    execute 'reset role';

    -- Undo the administrator's successful write so the next actor reads the original.
    update public.staffing_thresholds set minimum_staff = 3 where id = f.threshold_id;

    if v_uid is distinct from act.id then
      raise exception 'impersonation failed for %: auth.uid() = %, expected %', act.label, v_uid, act.id;
    end if;

    insert into probe_results values
      (act.label, 'payroll_summaries: own rows readable (R21.13)',
        v_own_summaries,   case when act.id in (a, b) then 1 else 0 end),
      (act.label, 'payroll_summaries: employee A''s row readable',
        v_a_summary,       case when act.id = a or act.id = sa then 1 else 0 end),
      (act.label, 'payroll_summaries: rows visible unfiltered',
        v_all_summaries,   case when act.id = sa then 2
                                when act.id in (a, b) then 1
                                else 0 end),
      (act.label, 'employee_payment_settings: rows visible (R21.13)',
        v_settings,        case when act.id = sa then 2
                                when act.id = a then 1
                                else 0 end),
      (act.label, 'staffing_thresholds: rows visible (R21.14)',
        v_thresholds,      1),
      (act.label, 'staffing_thresholds: rows the actor could UPDATE',
        v_threshold_write, case when act.id = sa then 1 else 0 end),
      (act.label, 'payroll_periods: rows visible (not granted by v1.9.2)',
        v_periods,         case when act.id = sa then 1 else 0 end);
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- REPORT
-- ─────────────────────────────────────────────────────────────────────────────────
select actor,
       probe,
       observed,
       expected,
       case when observed = expected then 'PASS' else 'FAIL' end as verdict
  from probe_results
 order by actor, probe;

rollback;

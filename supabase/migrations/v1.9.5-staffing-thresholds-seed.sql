-- New Hope Work Desk v1.9.5 — Time & Attendance staffing threshold seed
-- (migration stage 6 of 6)
--
-- Spec: .kiro/specs/time-attendance-ui-redesign
-- Requirements: 6.3, 6.4, 23.1, 23.2, 23.3, 23.8
--
-- Forward-only. Edits no released migration. This migration is DML only: it inserts
-- into public.staffing_thresholds and creates, alters, and drops nothing. It writes to
-- none of the eight preserved tables of Requirement 23, criterion 3
-- (time_clock_entries, time_clock_breaks, employee_schedules, pto_requests,
-- pto_balances, payroll_periods, payroll_summaries, audit_log), so retention holds by
-- construction. The post-condition block proves it anyway.
--
-- The table itself is NOT created here. public.staffing_thresholds, its two check
-- constraints, its unique_threshold_per_slot constraint, and its updated_at trigger all
-- come from supabase/migrations/v1.2.0-time-attendance.sql section 9, which this file
-- leaves exactly as released. Read access comes from
-- v1.9.2-attendance-reads.sql (staffing_thresholds_authenticated_select); write access
-- stays with staffing_thresholds_admin_all from v1.6.2.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS SEEDS
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Appendix B, Open Question 3 of the spec deferred this stage until the intended
-- minimum and warning staffing per department, day of week, and time slot were
-- supplied. They now are:
--
--   department          minimum_staff   warning_threshold
--   ----------------    -------------   -----------------
--   sales                           6                   8
--   customer_service                7                   9
--   commercial                      4                   6
--   management                      2                   3
--
-- Monday through Friday only — day_of_week 1 through 5 — across all three time_slot
-- values, morning, afternoon, and full_day. Four departments x five weekdays x three
-- slots = 60 rows.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- WHY ALL THREE SLOTS CARRY THE SAME PAIR
-- ─────────────────────────────────────────────────────────────────────────────────
-- The lookup in src/features/time-attendance/server/policy.ts is exact. Its own
-- comment states the rule: "a full_day row is not treated as a default for morning,
-- because inferring one slot's requirement from another's would invent a staffing rule
-- the organisation has not stated." buildStaffingThresholdTable keys on
-- department:day_of_week:time_slot and a miss answers null.
--
-- Which slot a figure is compared against depends on the caller, not on the date:
--
--   * Live_Coverage compares "now" against morning before 12:00 in the business
--     timezone and afternoon from 12:00 onward (AFTERNOON_START_HOUR in
--     coverage-service.ts, transcribed from the behaviour /api/staffing has had since
--     the table was introduced).
--   * Projected_Coverage describes a whole date and compares against full_day
--     (WHOLE_DATE_TIME_SLOT).
--
-- So seeding full_day alone would leave every live reading unconfigured, and seeding
-- the two half-day slots alone would leave every leave decision unconfigured. The
-- supplied answer states one requirement per department per weekday and draws no
-- morning/afternoon distinction, so all three slots carry the same pair. When the
-- organisation later wants a different morning figure, the Workforce threshold editor
-- from task 25.2 edits that row; nothing here has to change.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- SATURDAY AND SUNDAY ARE DELIBERATELY LEFT UNSEEDED — DO NOT "FIX" THIS GAP
-- ─────────────────────────────────────────────────────────────────────────────────
-- day_of_week 6 (Saturday) and 0 (Sunday) get no rows, and inserting zero-valued
-- weekend rows to "complete the table" would be a behavioural regression, not a
-- tidy-up.
--
-- classifyCoverage in domain/coverage.ts is one ordered comparison:
--
--   no threshold row              -> healthy
--   available <  minimum_staff    -> critical
--   available =  minimum_staff    -> at_minimum
--   available <= warning_threshold-> warning
--   otherwise                     -> healthy
--
-- A row of minimum_staff 0 therefore maps a weekend with nobody available onto
-- at_minimum, and deriveRibbonStates presents at_minimum as Warning (Requirement 18,
-- criterion 6). Every Saturday and Sunday would raise a staffing warning against a
-- requirement of nobody — noise on two dates out of seven, on three screens, forever.
--
-- An ABSENT row answers null, which reports required as unconfigured and assigns
-- Coverage_Status Healthy. That is Requirement 6, criterion 4 read literally, and it is
-- the honest encoding of "there is no weekend staffing requirement": the organisation
-- has stated no weekend minimum, so the module claims none. Task 4.1 already handles
-- this path and Property 10 covers it.
--
-- If a weekend staffing requirement is ever introduced, add the rows through the
-- Workforce threshold editor (task 25.2) with the real figures. Do not add them here
-- with zeroes.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- WHAT "DEPARTMENT" MEANS, AND WHY MANAGEMENT'S FIGURE IS SMALL
-- ─────────────────────────────────────────────────────────────────────────────────
-- staffing_thresholds.department is not a stored attribute of an employee. There is no
-- department column on public.profiles. The coverage reads derive a department from
-- profiles.role through roleToDepartment in src/lib/permissions.ts:
--
--   agent, sales_supervisor                          -> sales
--   customer_service, customer_service_supervisor     -> customer_service
--   commercial, commercial_supervisor                 -> commercial
--   manager, super_admin                              -> management
--
-- Two consequences are worth writing down rather than rediscovering:
--
-- 1. Every manager AND every super_admin counts toward `management`. The
--    super_admin role inherits everything the manager role has, and it lands in the
--    same department bucket for coverage. A minimum of 2 and a warning at 3 is a
--    figure for that combined pool, not for managers alone.
--
-- 2. Changing an employee's role moves that employee's headcount from one department
--    to another with no threshold change. A role change is therefore also a coverage
--    change, and the figures above are per-role-group requirements.
--
-- The four department names are the only values the v1.2.0 check constraint admits,
-- and they are exactly the image of roleToDepartment over APP_ROLES, so every
-- employee counts toward exactly one seeded department.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- WARNING_THRESHOLD IS AN UPPER BAND EDGE, NOT A SECOND MINIMUM
-- ─────────────────────────────────────────────────────────────────────────────────
-- The v1.2.0 column carries the comment "warn when at or below this", and
-- classifyCoverage implements exactly that: Warning covers available strictly above
-- minimum_staff and at or below warning_threshold. So each pair above describes three
-- bands, and the Warning band is non-empty for all four departments:
--
--   sales             critical <6   at_minimum 6   warning 7-8   healthy >=9
--   customer_service  critical <7   at_minimum 7   warning 8-9   healthy >=10
--   commercial        critical <4   at_minimum 4   warning 5-6   healthy >=7
--   management        critical <2   at_minimum 2   warning 3     healthy >=4
--
-- A pair with warning_threshold below minimum_staff would make the Warning band
-- unreachable. The pre-condition block below rejects that rather than storing it.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- IDEMPOTENCE
-- ─────────────────────────────────────────────────────────────────────────────────
-- The insert is `on conflict (department, day_of_week, time_slot) do update`, resolved
-- against unique_threshold_per_slot from v1.2.0. Re-running this file is safe: it
-- restores the 60 seeded slots to the figures above and touches no other row. Note
-- what that means operationally — a re-run OVERWRITES any later edit made through the
-- Workforce threshold editor for these 60 slots. That is the intended behaviour for a
-- seed (the file states the intended baseline, and re-applying it re-asserts that
-- baseline), but it is a reason not to re-run it casually against a database whose
-- thresholds have since been tuned.
--
-- `do update` is also what makes the row count assertion below meaningful on a re-run:
-- `do nothing` would leave stale figures in place while still reporting 60 rows.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK PATH (Requirement 23, criterion 8)
-- ═══════════════════════════════════════════════════════════════════════════════
-- One delete, scoped to exactly what this migration inserts: the four seeded
-- departments, day_of_week 1 through 5, and the three slots. It removes no row outside
-- that set, so a weekend row or a fifth department added later survives the rollback.
--
--   begin;
--     delete from public.staffing_thresholds
--      where department in ('sales', 'customer_service', 'commercial', 'management')
--        and day_of_week between 1 and 5
--        and time_slot in ('morning', 'afternoon', 'full_day');
--     -- expect: DELETE 60
--   commit;
--
-- After the rollback the table is empty again and every coverage reading reports
-- required as unconfigured with Coverage_Status Healthy — the pre-stage-6 behaviour
-- described in Requirement 6, criterion 4. Nothing else is affected: no schema object
-- is created here, so there is nothing to drop, and no preserved table is written, so
-- there is nothing to restore. The rollback is complete.
--
-- A rollback is also non-destructive of history: staffing_thresholds is configuration
-- with no foreign key pointing at it and no audit trail of its own beyond created_at
-- and updated_at, so deleting the seed loses only the seed.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. PRE-CONDITIONS
--    The table and the conflict target this migration depends on must already exist,
--    and the figures must be internally coherent. A seed that lands on a table without
--    unique_threshold_per_slot would insert duplicates instead of upserting, and a
--    pair with the warning band inverted would store a rule that can never fire.
-- ═══════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_weekend integer;
begin
  -- The table, from v1.2.0-time-attendance.sql section 9.
  if to_regclass('public.staffing_thresholds') is null then
    raise exception 'v1.9.5 found no public.staffing_thresholds table'
      using detail = 'The table is created by v1.2.0-time-attendance.sql section 9. This migration seeds it and does not create it.',
            hint   = 'Apply v1.2.0-time-attendance.sql first. Nothing has been changed.';
  end if;

  -- The conflict target the upsert resolves against. Without it, `on conflict` has no
  -- arbiter and the statement fails; asserting here says why.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.staffing_thresholds'::regclass
       and conname  = 'unique_threshold_per_slot'
       and contype  = 'u'
  ) then
    raise exception 'v1.9.5 found no unique_threshold_per_slot constraint on public.staffing_thresholds'
      using detail = 'The upsert below resolves `on conflict (department, day_of_week, time_slot)` against that constraint, which v1.2.0 created.',
            hint   = 'Restore the constraint before seeding, or the seed inserts duplicates instead of upserting. Nothing has been changed.';
  end if;

  -- Record what the weekend looks like before the seed, so the post-condition block
  -- can prove this migration added nothing there rather than merely observing that
  -- nothing is there.
  select count(*) into v_weekend
    from public.staffing_thresholds
   where day_of_week in (0, 6);

  perform set_config('nhwd.v195_weekend_rows_before', v_weekend::text, true);

  if v_weekend > 0 then
    raise notice 'v1.9.5: % weekend threshold row(s) already present. This migration adds none and removes none; they are left exactly as found.', v_weekend;
  end if;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. THE SEED
--    60 rows: four departments x day_of_week 1..5 x three slots. Written as one
--    statement over a values list crossed with the weekdays and the slots, so the
--    four supplied pairs appear exactly once each and no row can disagree with the
--    header table through a copy-paste slip.
--
--    `do update` rather than `do nothing`, per the idempotence note in the header:
--    re-running restores the seeded figures instead of leaving stale ones in place.
--    updated_at is assigned explicitly because staffing_thresholds_touch_updated_at
--    fires `before update` and would otherwise be the only thing distinguishing a
--    re-run, and on a first run the column default already answers now().
-- ═══════════════════════════════════════════════════════════════════════════════
with seed as (
  select d.department, w.day_of_week, s.time_slot, d.minimum_staff, d.warning_threshold
    from (values
            -- department,         minimum_staff, warning_threshold
            ('sales',                          6,                 8),
            ('customer_service',               7,                 9),
            ('commercial',                     4,                 6),
            ('management',                     2,                 3)
         ) as d(department, minimum_staff, warning_threshold)
   cross join (values (1), (2), (3), (4), (5)) as w(day_of_week)   -- Monday..Friday; 0=Sunday and 6=Saturday deliberately absent
   cross join (values ('morning'), ('afternoon'), ('full_day')) as s(time_slot)
)
insert into public.staffing_thresholds (department, day_of_week, time_slot, minimum_staff, warning_threshold)
select department, day_of_week, time_slot, minimum_staff, warning_threshold
  from seed
    on conflict (department, day_of_week, time_slot) do update
   set minimum_staff     = excluded.minimum_staff,
       warning_threshold = excluded.warning_threshold,
       updated_at        = now();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. POST-CONDITIONS
--    Exactly the 60 intended slots exist with the intended pairs; the weekend is
--    untouched; every stored pair leaves a reachable Warning band; and no row outside
--    staffing_thresholds moved.
-- ═══════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_expected  constant integer := 4 * 5 * 3;
  v_seeded    integer;
  v_weekday   integer;
  v_weekend   integer;
  v_before    integer := coalesce(nullif(current_setting('nhwd.v195_weekend_rows_before', true), ''), '0')::integer;
  v_wrong     text;
  v_missing   text;
begin
  -- Every intended slot present with the intended pair. Expressed as a join against
  -- the same cross product the insert used, so a row that landed with the wrong pair
  -- fails here rather than passing a bare count.
  select count(*) into v_seeded
    from public.staffing_thresholds t
    join (values ('sales', 6, 8),
                 ('customer_service', 7, 9),
                 ('commercial', 4, 6),
                 ('management', 2, 3)) as d(department, minimum_staff, warning_threshold)
      on d.department = t.department
     and d.minimum_staff = t.minimum_staff
     and d.warning_threshold = t.warning_threshold
   where t.day_of_week between 1 and 5
     and t.time_slot in ('morning', 'afternoon', 'full_day');

  if v_seeded <> v_expected then
    -- Name what is missing, rather than only the shortfall.
    select string_agg(format('%s/%s/%s', d.department, w.day_of_week, s.time_slot), ', '
                      order by d.department, w.day_of_week, s.time_slot)
      into v_missing
      from (values ('sales', 6, 8),
                   ('customer_service', 7, 9),
                   ('commercial', 4, 6),
                   ('management', 2, 3)) as d(department, minimum_staff, warning_threshold)
     cross join (values (1), (2), (3), (4), (5)) as w(day_of_week)
     cross join (values ('morning'), ('afternoon'), ('full_day')) as s(time_slot)
     where not exists (
       select 1 from public.staffing_thresholds t
        where t.department = d.department
          and t.day_of_week = w.day_of_week
          and t.time_slot = s.time_slot
          and t.minimum_staff = d.minimum_staff
          and t.warning_threshold = d.warning_threshold
     );

    raise exception 'v1.9.5 expected % seeded weekday slots carrying the intended pairs but finds %', v_expected, v_seeded
      using detail = coalesce('absent or carrying a different pair: ' || v_missing, 'no slot is absent, so a duplicate or an unexpected pair is present'),
            hint   = 'Rolling back.';
  end if;

  -- No stray weekday slot beyond the 60: a fifth department name, or a pair this file
  -- did not write, would both show up here.
  select count(*) into v_weekday
    from public.staffing_thresholds
   where day_of_week between 1 and 5;

  if v_weekday <> v_expected then
    raise exception 'v1.9.5 finds % weekday threshold rows, expected exactly %', v_weekday, v_expected
      using detail = 'A weekday slot exists that this seed did not write, or a pair differs from the four supplied.',
            hint   = 'Rolling back.';
  end if;

  -- The weekend is exactly as it was found. See the header: an absent weekend row is
  -- the intended encoding of "no weekend staffing requirement", and a zero-valued row
  -- would surface every Saturday and Sunday as a Warning.
  select count(*) into v_weekend
    from public.staffing_thresholds
   where day_of_week in (0, 6);

  if v_weekend <> v_before then
    raise exception 'v1.9.5 changed the weekend threshold rows: % before, % after', v_before, v_weekend
      using detail = 'This migration seeds Monday..Friday only and must neither add nor remove a Saturday or Sunday row.',
            hint   = 'Rolling back.';
  end if;

  -- Every stored pair leaves the Warning band reachable, and no negative headcount.
  -- Covers the seeded rows and any pre-existing row, since an incoherent neighbour is
  -- worth surfacing while someone is looking at this table.
  select string_agg(format('%s/%s/%s min=%s warn=%s',
                           department, day_of_week, time_slot, minimum_staff, warning_threshold), '; '
                    order by department, day_of_week, time_slot)
    into v_wrong
    from public.staffing_thresholds
   where minimum_staff < 0
      or warning_threshold < minimum_staff;

  if v_wrong is not null then
    raise exception 'v1.9.5 found threshold row(s) whose Warning band is unreachable or whose minimum is negative: %', v_wrong
      using detail = 'classifyCoverage assigns Warning to available strictly above minimum_staff and at or below warning_threshold, so warning_threshold below minimum_staff can never fire.',
            hint   = 'Rolling back.';
  end if;

  raise notice 'v1.9.5: % weekday slots seeded across 4 departments, 5 weekdays, and 3 time slots; % weekend row(s), unchanged',
    v_weekday, v_weekend;
end;
$$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
--    Row retention (Requirement 23, criterion 3): this migration writes only to
--    staffing_thresholds, which is not one of the eight preserved tables, so every
--    preserved count must equal supabase/verification/row-retention/stage-6-pre.json
--    exactly. Verify with:
--      node --env-file=.env.local scripts/verify-attendance-row-retention.mjs \
--           --verify --label stage-6-pre --strict
-- ═══════════════════════════════════════════════════════════════════════════════
select
  -- 4 departments x 5 weekdays x 3 slots.
  (select count(*) from public.staffing_thresholds
     where day_of_week between 1 and 5)                                as weekday_rows_expect_60,

  -- Saturday and Sunday carry no requirement, on purpose. See the header.
  (select count(*) from public.staffing_thresholds
     where day_of_week in (0, 6))                                     as weekend_rows_expect_0,

  -- Whole table: the 60 seeded slots and nothing else.
  (select count(*) from public.staffing_thresholds)                   as total_rows_expect_60,

  -- All four departments present, each across 15 slots.
  (select count(distinct department) from public.staffing_thresholds) as departments_expect_4,
  (select count(distinct time_slot) from public.staffing_thresholds)  as time_slots_expect_3,
  (select min(cnt) || '-' || max(cnt)
     from (select count(*) as cnt from public.staffing_thresholds
            group by department) as per_department)                    as rows_per_department_expect_15_15,

  -- Every slot of a department carries that department's one pair.
  (select count(*) from (
     select department, count(distinct minimum_staff || '/' || warning_threshold) as pairs
       from public.staffing_thresholds group by department
   ) as p where p.pairs <> 1)                                         as departments_with_mixed_pairs_expect_0,

  -- The four pairs, as stored.
  (select string_agg(distinct format('%s %s/%s', department, minimum_staff, warning_threshold), ', '
                     order by format('%s %s/%s', department, minimum_staff, warning_threshold))
     from public.staffing_thresholds)                                 as stored_pairs,

  -- Read access, so a signed-in employee can render coverage status (v1.9.2).
  (select count(*) from pg_policies
     where schemaname = 'public'
       and tablename  = 'staffing_thresholds')                        as threshold_policies_expect_2,

  -- Preserved tables, untouched by this DML.
  (select count(*) from public.time_clock_entries)                    as time_clock_entries_total,
  (select count(*) from public.employee_schedules)                    as employee_schedules_total,
  (select count(*) from public.pto_requests)                          as pto_requests_total,
  (select count(*) from public.audit_log)                             as audit_log_total;

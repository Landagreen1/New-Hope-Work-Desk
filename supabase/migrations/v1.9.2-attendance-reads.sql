-- New Hope Work Desk v1.9.2 — Time & Attendance additive read policies
-- (migration stage 3 of 6)
--
-- Spec: .kiro/specs/time-attendance-ui-redesign
-- Requirements: 21.13, 21.14, 23.1, 23.2, 23.3, 23.8
--
-- Forward-only. Edits no released migration. This migration is DDL only: it creates
-- three row level security policies and writes to no table. No row in any of the eight
-- preserved tables of Requirement 23, criterion 3 is read, updated, inserted, or
-- deleted, so retention holds by construction. The assertions below prove it anyway.
--
-- WHAT THIS RESTORES
--
-- v1.2.0-time-attendance.sql granted a self-select on payroll_summaries and
-- employee_payment_settings and a public select on staffing_thresholds.
-- v1.6.2-enforce-scoped-supervisor-access.sql removed all three when it collapsed the
-- module onto "every role is an employee, only super_admin administers". The removal
-- was wider than intended: PayrollDashboard is written as an employee self-service
-- view and cannot return a row for anyone, and coverage status cannot be rendered by a
-- signed-in employee because the thresholds it compares against are unreadable.
--
-- Requirement 21, criterion 13 restores an Employee reading that Employee's own
-- payroll summaries and pay settings. Requirement 21, criterion 14 restores every
-- signed-in user reading staffing_thresholds. This migration adds exactly those three
-- select policies and nothing else.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS PURELY ADDITIVE
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- Postgres policies are PERMISSIVE by default and permissive policies for the same
-- command are OR'd together. Adding a `for select` policy can therefore only widen
-- what SELECT returns; it cannot remove a row any existing policy already returned,
-- and it cannot affect INSERT, UPDATE, or DELETE at all. The three
-- `..._admin_all` policies from v1.6.2 keep every capability they hold today.
--
-- No administrator capability moves. super_admin remains the only attendance
-- administrator (Requirement 21, criteria 1 and 2), and `manager` is granted nothing
-- here: pay rates, hourly pay, payroll settings, clock-entry corrections, time-off
-- approvals, and work schedules stay super_admin-exclusive per Requirement 21,
-- criterion 12. Note that the two policies below are scoped by `profile_id =
-- auth.uid()`, not by role, so a manager gains read access to the manager's OWN
-- payroll summaries and OWN pay settings and to nobody else's — the same access every
-- other employee gains. That is Requirement 21, criterion 13 applied uniformly, not a
-- widening of the manager role.
--
-- The three `drop policy if exists` statements name only the three policies this
-- migration creates. Those names have never existed in this database, so on a first
-- run each drop is a no-op; on a re-run each drops only this migration's own work.
-- No pre-existing policy is dropped, replaced, or narrowed. The post-condition block
-- fingerprints every other policy on the four affected tables before and after and
-- fails the transaction if any of them changed.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- FOUR DECISIONS THIS FILE MAKES, AND WHY
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- 1. payroll_periods is deliberately NOT granted a self-read.
--    Appendix A.2 records that v1.6.2 also removed the `using (true)` select
--    v1.2.0 had granted on payroll_periods. It is not restored here, for two reasons.
--
--    First, it is not required for the read Requirement 21, criterion 13 describes. A
--    row level security policy is evaluated against the columns of the row it guards.
--    payroll_summaries_own_select tests payroll_summaries.profile_id and consults no
--    other table, so `select * from payroll_summaries where profile_id = auth.uid()`
--    returns the employee's rows whether or not the referenced payroll_periods row is
--    readable. The foreign key constrains what may be written, not what a policy may
--    return. An employee can read their own summaries without reading any period.
--
--    Second, the spec restricts it. Requirement 21, criterion 6 lists payroll periods
--    among the objects restricted to an Attendance_Administrator, and criterion 13
--    carves out exactly two things from that restriction: own payroll summaries and
--    own pay settings. Periods are not in the carve-out. Granting one would exceed the
--    requirement, and the design's stage 3 row lists three policies, not four.
--
--    One consequence is worth recording rather than discovering later. GET /api/payroll
--    selects payroll_summaries with an embedded
--    `payroll_periods!payroll_summaries_payroll_period_id_fkey(*)`. PostgREST applies
--    row level security to an embedded resource independently, so for a
--    non-administrator the summary rows return and the embedded period object resolves
--    to null. The employee sees their own hours and pay and no period label. That is a
--    presentation gap in a screen this stage does not wire and does not regress
--    anything that works today (today the employee sees no summary at all). Closing it
--    needs either a period label the summary carries itself or a decision to widen
--    Requirement 21, criterion 6, and either is a spec change rather than a migration.
--
-- 2. `to authenticated`, matching every other policy in the module.
--    An anonymous caller is granted nothing. Requirement 21, criterion 14 says "every
--    signed-in user", which `to authenticated` states exactly. The service role
--    bypasses row level security and is unaffected either way.
--
-- 3. Bare `auth.uid()` rather than `(select auth.uid())`.
--    The subselect form turns the call into a once-per-query InitPlan, which matters on
--    a large scan. It is not used here, for consistency: every self-scoped policy in
--    this schema since v1.2.0 is written `profile_id = auth.uid()`, and both tables are
--    small and indexed on profile_id (`idx_payroll_summaries_profile`, and the unique
--    constraint on employee_payment_settings.profile_id). Matching the surrounding
--    convention is worth more here than an InitPlan on a single-row lookup.
--
-- 4. `using (true)` on staffing_thresholds, not a role test.
--    The table holds configuration — department, day of week, time slot, minimum staff,
--    warning threshold — and no personal data. Every signed-in user needs it to render
--    coverage status (Requirement 6, criterion 4 and Requirement 18, criterion 7), and
--    withholding it is what forces /api/staffing to substitute
--    `{ minimum_staff: 1, warning_threshold: 2 }` for every department today. Write
--    access stays with staffing_thresholds_admin_all.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- READING THE VERIFICATION: "PERMITS" IS NOT "RETURNS ROWS"
-- ─────────────────────────────────────────────────────────────────────────────────
-- staffing_thresholds is empty until migration stage 6 seeds it, and payroll_summaries
-- is empty because v1.7.0-purge-test-data.sql deleted every row. A permitted read of
-- either therefore returns zero rows right now, which is indistinguishable from a
-- refused read if you only look at the row count.
--
-- The verification block below reports what the POLICIES say — presence, command,
-- roles, and predicate — which is the part this migration is responsible for. Proving
-- that a read actually succeeds and that another employee's row stays hidden requires
-- impersonating a specific employee against rows that exist, which the companion probe
-- does inside a transaction it rolls back:
--
--   supabase/verification/v1.9.2-attendance-read-policies.sql
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- ROLLBACK PATH (Requirement 23, criterion 8)
-- ─────────────────────────────────────────────────────────────────────────────────
-- Three drops, in any order. This is a complete reversal: the migration creates
-- nothing else, changes no existing policy, and writes no row, so removing the three
-- policies returns the database to its v1.9.1 state exactly.
--
--   begin;
--     drop policy if exists "staffing_thresholds_authenticated_select" on public.staffing_thresholds;
--     drop policy if exists "payment_settings_own_select"              on public.employee_payment_settings;
--     drop policy if exists "payroll_summaries_own_select"             on public.payroll_summaries;
--   commit;
--
-- After the rollback, payroll_summaries, employee_payment_settings, and
-- staffing_thresholds are readable by super_admin only, which is the v1.6.2 position.
-- Task 8.2 makes /api/payroll/settings return an authorisation failure instead of a
-- hardcoded default object, so the rollback surfaces as an honest 403 rather than as
-- plausible-looking empty settings.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. PRE-CONDITIONS
--    A policy on a table whose row level security is disabled enforces nothing and
--    grants nothing, so confirm RLS is on before adding to it. Also confirm the three
--    administrator policies are present, and fingerprint every policy on the four
--    affected tables so the post-condition block can prove none of them moved.
-- ═══════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_new_names constant text[] := array[
    'payroll_summaries_own_select',
    'payment_settings_own_select',
    'staffing_thresholds_authenticated_select'
  ];
  v_tables    constant text[] := array[
    'payroll_summaries',
    'employee_payment_settings',
    'staffing_thresholds',
    'payroll_periods'
  ];
  v_rls_off   text;
  v_missing   text;
  v_before    text;
begin
  -- Row level security must already be enabled on the three tables being widened.
  -- This migration asserts rather than re-enables: enabling RLS where it is off would
  -- be a capability change, and this stage makes none.
  select string_agg(c.relname, ', ' order by c.relname)
    into v_rls_off
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('payroll_summaries', 'employee_payment_settings', 'staffing_thresholds')
     and not c.relrowsecurity;

  if v_rls_off is not null then
    raise exception 'v1.9.2 found row level security disabled on: %', v_rls_off
      using detail = 'A select policy on a table without RLS grants nothing and hides nothing.',
            hint   = 'Investigate why v1.6.2''s enable was reverted before widening reads. Nothing has been changed.';
  end if;

  -- The administrator policies this stage must leave alone.
  select string_agg(expected, ', ' order by expected)
    into v_missing
    from (values ('payroll_summaries_admin_all'),
                 ('payment_settings_admin_all'),
                 ('staffing_thresholds_admin_all')) as e(expected)
   where not exists (
     select 1 from pg_policies p
      where p.schemaname = 'public'
        and p.policyname = e.expected
   );

  if v_missing is not null then
    raise exception 'v1.9.2 expected the v1.6.2 administrator policies but these are absent: %', v_missing
      using detail = 'This stage is additive and assumes the v1.6.2 baseline is in place.',
            hint   = 'Confirm v1.6.2-enforce-scoped-supervisor-access.sql is applied. Nothing has been changed.';
  end if;

  -- Fingerprint every policy on the four affected tables EXCEPT the three this
  -- migration creates. Anything that differs afterwards means this file narrowed or
  -- replaced something, which it must not.
  select md5(coalesce(string_agg(
           format('%s|%s|%s|%s|%s|%s',
                  p.tablename, p.policyname, p.cmd, p.roles::text,
                  coalesce(p.qual, ''), coalesce(p.with_check, '')),
           E'\n' order by p.tablename, p.policyname), ''))
    into v_before
    from pg_policies p
   where p.schemaname = 'public'
     and p.tablename = any (v_tables)
     and not (p.policyname = any (v_new_names));

  perform set_config('nhwd.v192_policy_fingerprint', v_before, true);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. REQUIREMENT 21, CRITERION 13 — an Employee reads their own payroll summaries
--    Scoped by profile_id, so it returns the caller's own rows and no others.
--    OR'd with payroll_summaries_admin_all, which keeps super_admin's full access.
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "payroll_summaries_own_select" on public.payroll_summaries;
create policy "payroll_summaries_own_select" on public.payroll_summaries
  for select to authenticated
  using (profile_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. REQUIREMENT 21, CRITERION 13 — an Employee reads their own pay settings
--    employee_payment_settings holds one row per employee (profile_id is unique), so
--    this returns at most the caller's own row. Rate EDITING remains super_admin-only
--    through payment_settings_admin_all: this policy is `for select`, so it confers no
--    insert, update, or delete.
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "payment_settings_own_select" on public.employee_payment_settings;
create policy "payment_settings_own_select" on public.employee_payment_settings
  for select to authenticated
  using (profile_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. REQUIREMENT 21, CRITERION 14 — every signed-in user reads staffing_thresholds
--    Configuration, not personal data. Needed to render coverage status on every
--    screen that shows it. Writes stay with staffing_thresholds_admin_all.
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "staffing_thresholds_authenticated_select" on public.staffing_thresholds;
create policy "staffing_thresholds_authenticated_select" on public.staffing_thresholds
  for select to authenticated
  using (true);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. POST-CONDITIONS
--    Three policies added, each a SELECT policy granted to authenticated; every other
--    policy on the four affected tables byte-identical to the fingerprint taken above;
--    payroll_periods still administrator-only, per decision 1.
-- ═══════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_new_names constant text[] := array[
    'payroll_summaries_own_select',
    'payment_settings_own_select',
    'staffing_thresholds_authenticated_select'
  ];
  v_tables    constant text[] := array[
    'payroll_summaries',
    'employee_payment_settings',
    'staffing_thresholds',
    'payroll_periods'
  ];
  v_added     integer;
  v_wrong     text;
  v_before    text := coalesce(current_setting('nhwd.v192_policy_fingerprint', true), '');
  v_after     text;
begin
  -- All three exist.
  select count(*) into v_added
    from pg_policies p
   where p.schemaname = 'public'
     and p.policyname = any (v_new_names);

  if v_added <> 3 then
    raise exception 'v1.9.2 expected to add 3 policies but finds %', v_added
      using hint = 'Rolling back.';
  end if;

  -- Each is a SELECT policy, permissive, granted to authenticated only. A policy that
  -- landed as `for all` or reached a wider role would be a capability change.
  select string_agg(format('%s (cmd=%s, permissive=%s, roles=%s)',
                           p.policyname, p.cmd, p.permissive, p.roles::text), '; '
                    order by p.policyname)
    into v_wrong
    from pg_policies p
   where p.schemaname = 'public'
     and p.policyname = any (v_new_names)
     and (p.cmd <> 'SELECT'
          or p.permissive <> 'PERMISSIVE'
          or p.roles::text <> '{authenticated}');

  if v_wrong is not null then
    raise exception 'v1.9.2 created a policy wider than a permissive SELECT for authenticated: %', v_wrong
      using hint = 'Rolling back.';
  end if;

  -- Nothing else moved.
  select md5(coalesce(string_agg(
           format('%s|%s|%s|%s|%s|%s',
                  p.tablename, p.policyname, p.cmd, p.roles::text,
                  coalesce(p.qual, ''), coalesce(p.with_check, '')),
           E'\n' order by p.tablename, p.policyname), ''))
    into v_after
    from pg_policies p
   where p.schemaname = 'public'
     and p.tablename = any (v_tables)
     and not (p.policyname = any (v_new_names));

  if v_after <> v_before then
    raise exception 'v1.9.2 changed a pre-existing policy on one of the four affected tables'
      using detail = format('fingerprint before %s, after %s', v_before, v_after),
            hint   = 'This stage must be purely additive. Rolling back.';
  end if;

  -- payroll_periods stays administrator-only. See decision 1 in the header.
  if exists (
    select 1 from pg_policies p
     where p.schemaname = 'public'
       and p.tablename = 'payroll_periods'
       and p.policyname <> 'payroll_periods_admin_all'
  ) then
    raise exception 'v1.9.2 found an unexpected policy on payroll_periods'
      using detail = 'Requirement 21, criterion 6 keeps payroll periods administrator-only; criterion 13 carves out summaries and pay settings only.',
            hint   = 'Rolling back.';
  end if;

  raise notice 'v1.9.2: 3 select policies added; % pre-existing policies on the four affected tables unchanged',
    (select count(*) from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = any (v_tables)
        and not (p.policyname = any (v_new_names)));
end;
$$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
--    What the policies say. See "READING THE VERIFICATION" in the header: these
--    columns are the migration's own responsibility. Whether a read then returns a row
--    depends on the tables holding data, which they do not yet, and is probed
--    separately in supabase/verification/v1.9.2-attendance-read-policies.sql.
-- ═══════════════════════════════════════════════════════════════════════════════
select
  -- The three policies this migration adds.
  (select count(*) from pg_policies
     where schemaname = 'public'
       and policyname in ('payroll_summaries_own_select',
                          'payment_settings_own_select',
                          'staffing_thresholds_authenticated_select'))     as policies_added_expect_3,

  -- All three permissive SELECT, authenticated only.
  (select count(*) from pg_policies
     where schemaname = 'public'
       and policyname in ('payroll_summaries_own_select',
                          'payment_settings_own_select',
                          'staffing_thresholds_authenticated_select')
       and cmd = 'SELECT'
       and permissive = 'PERMISSIVE'
       and roles::text = '{authenticated}')                                as permissive_select_authenticated_expect_3,

  -- The v1.6.2 administrator policies, untouched.
  (select count(*) from pg_policies
     where schemaname = 'public'
       and policyname in ('payroll_summaries_admin_all',
                          'payment_settings_admin_all',
                          'staffing_thresholds_admin_all',
                          'payroll_periods_admin_all')
       and cmd = 'ALL')                                                    as admin_all_policies_expect_4,

  -- payroll_periods carries exactly the one administrator policy, per decision 1.
  (select count(*) from pg_policies
     where schemaname = 'public'
       and tablename = 'payroll_periods')                                  as payroll_periods_policies_expect_1,

  -- Row level security still enabled on all three widened tables.
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('payroll_summaries', 'employee_payment_settings', 'staffing_thresholds')
      and c.relrowsecurity)                                                as rls_enabled_expect_3,

  -- Row retention (Requirement 23, criterion 3). This migration is DDL only, so every
  -- count must equal supabase/verification/row-retention/stage-3-pre.json exactly.
  -- Verify with: node --env-file=.env.local scripts/verify-attendance-row-retention.mjs
  --              --verify --label stage-3-pre --strict
  (select count(*) from public.payroll_summaries)                          as payroll_summaries_total,
  (select count(*) from public.payroll_periods)                            as payroll_periods_total,
  (select count(*) from public.employee_payment_settings)                  as payment_settings_total,
  (select count(*) from public.staffing_thresholds)                        as staffing_thresholds_total_empty_until_stage_6;

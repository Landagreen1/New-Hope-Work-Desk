-- New Hope Work Desk v1.9.3 — Time & Attendance time-off decisions
-- (migration stage 4 of 6)
--
-- Spec: .kiro/specs/time-attendance-ui-redesign
-- Requirements: 10.8, 10.11, 10.13, 10.14, 10.15, 10.16, 10.17, 10.18, 10.19,
--               11.2, 11.5, 21.10, 21.12, 21.15, 23.1, 23.2, 23.3, 23.8
--
-- Forward-only. Edits no released migration. Applies on top of v1.9.2.
--
-- This stage writes no row to any of the eight preserved tables of Requirement 23,
-- criterion 3. It widens a check constraint, adds three columns, creates two tables,
-- one index, and one function, and grants row level security on the new tables.
-- `alter table ... add constraint` re-validates the five existing pto_requests rows
-- against the wider vocabulary; validation reads rows and never changes them. The
-- post-condition block asserts no preserved table lost a row before the transaction
-- is allowed to commit, and scripts/verify-attendance-row-retention.mjs confirms it
-- from outside against the stage-4-pre snapshot.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES
-- ─────────────────────────────────────────────────────────────────────────────────
-- Appendix A.5 records how the inherited approval path maintains a balance: the
-- PATCH handler in /api/pto reads pto_balances, adds the recounted weekdays in
-- JavaScript, and writes the sum back. Two approvals landing together read the same
-- figure and the second write discards the first increment. The failure is also
-- silent — the read-then-write pair is not checked, its error goes to console.error,
-- and the endpoint still answers success, so the request shows as approved with no
-- balance movement behind it.
--
-- Everything a decision touches now moves inside one database transaction:
--
--   * the increment is `set vacation_used = vacation_used + delta` evaluated by the
--     server against the row it locks, so two concurrent decisions sum rather than
--     overwrite (Correctness Property 29);
--   * pto_balance_ledger records every movement, and its
--     unique (decision_id, year, balance_field) makes a replayed decision apply once
--     (Requirement 10, criterion 17);
--   * pto_request_decisions carries unique (request_id, idempotency_key), so the
--     replay is recognised before any movement is attempted;
--   * a failure anywhere rolls the whole decision back and returns the reason, so the
--     status never moves without its balance movement (Requirement 10, criterion 18);
--   * the year each movement lands in comes from the calendar year of each affected
--     date rather than from the year the decision is taken, which is Requirement 10,
--     criteria 15 and 16 and the December-approves-January bug in Appendix A.5.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- CONTENTS
-- ─────────────────────────────────────────────────────────────────────────────────
--   1. Pre-conditions: earlier stages present, every existing status inside the new
--      vocabulary, preserved-row fingerprint captured
--   2. pto_requests: status check widened to seven values; short_notice and
--      working_days added
--   3. pto_request_decisions
--   4. pto_balance_ledger, idx_pto_ledger_profile_year, and idx_pto_ledger_request
--   5. employee_schedules.coverage_for_request_id (Requirement 10, criterion 8)
--   6. Row level security and privileges on the two new tables
--   7. pto_decide()
--   8. Function privileges
--   9. Post-conditions
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- NINE DECISIONS THIS FILE MAKES, AND WHY
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- 1. super_admin is the only caller pto_decide() accepts.
--    The function is `security definer`, so it runs with the owner's rights and row
--    level security does not constrain it. The role test therefore has to be inside
--    the function, and it is the same test the v1.9.0 attendance policies use:
--    `(select role from public.profiles where id = auth.uid()) = 'super_admin'`.
--    Requirement 21, criterion 12 withholds time-off approval from `manager`, so
--    `manager` is granted nothing here. Written as one predicate against profiles
--    rather than a second opinion about who administers attendance, because a
--    function that disagreed with the RLS policies beside it would be its own bug.
--
-- 2. The owner of a request can never decide it, whatever their role.
--    Requirement 10, criterion 19 and Requirement 21, criterion 7. A super_admin
--    submitting their own leave is an ordinary case, and it is exactly the case the
--    check exists for. Tested after the row is locked, so the profile_id it reads is
--    the committed one.
--
-- 3. The lock comes before every validation that reads the request.
--    `select ... for update` on the pto_requests row serialises two administrators
--    deciding the same request: the second waits, then re-reads the status the first
--    committed. Without it both would validate against `pending` and both would
--    debit. The lock is also what makes the idempotency pre-check sound — a
--    concurrent replay cannot pass the check between our read and our insert,
--    because it cannot get past the lock.
--
-- 4. The balance movement is validated against the ledger, not just the ranges.
--    The requirement the task states is that the supplied deltas sum to the working
--    days the approved ranges imply. That is the pending → approved case, and it is
--    the case the arithmetic reduces to whenever nothing has been debited yet. The
--    general statement, which criterion 14 needs, is:
--
--      required movement = working days of this decision's approved ranges
--                          − everything already recorded in the ledger for this request
--
--    per calendar year. Approving a pending request gives + W (criterion 13).
--    Denying a request that was approved gives − W, the credit of criterion 14, from
--    the same expression rather than from a second reversal rule that could disagree
--    with it. Approving a narrower range after a wider one gives the difference.
--    The supplied payload must equal that figure exactly, year by year, or the call
--    is refused: the deltas are computed in the domain layer from the same rule
--    (`decisionBalanceDeltas`, `workingDaysByYear`), so a mismatch means the payload
--    and the stored rows disagree about the request, and the database is the side
--    that knows.
--
--    Requirement 10, criteria 5, 6, and 7 say suggest-dates, waitlist, and
--    request-information leave the balance unchanged, so those three — and
--    assign-coverage, which does not decide the request at all — must arrive with no
--    deltas whatever the ledger holds. Only an approving decision and `deny`
--    reconcile against the ledger.
--
-- 5. The working-day rule is Monday-to-Friday minus attendance_closed_dates, over the
--    distinct dates the approved ranges cover.
--    The same rule as `countWorkingDays` in domain/pto.ts, which is the single
--    implementation Requirement 19, criterion 8 asks for, restated here in the one
--    place that must not trust a browser's arithmetic. Dates are de-duplicated before
--    they are counted, so overlapping ranges cannot debit a day twice, and each date
--    is attributed to its own calendar year. `extract(isodow from date)` reads the
--    weekday of a calendar date with no instant and no timezone involved, which is
--    why it agrees with the domain's UTC-anchored weekday.
--
-- 6. Guard rejections raise; recoverable outcomes return.
--    Three outcomes are ordinary traffic rather than faults, and the design's failure
--    taxonomy has the function return them so the route can answer without parsing
--    prose: a replayed idempotency key returns the prior decision with
--    `applied: false`, a status that moved under the caller returns
--    `stale_request_state` with the current row, and a balance movement that cannot
--    be recorded returns `balance_write_failed` with the reason and leaves the status
--    where it was (Requirement 10, criterion 18). Everything else — an unauthorised
--    caller, the request's owner, a payload that contradicts the stored rows — raises
--    with the repo's `CODE: message` convention and a SQLSTATE that already carries
--    the right HTTP meaning: 42501 for the two authorisation refusals, 22023 for an
--    invalid payload, P0002 for a request that does not exist. Task 12.3 maps the
--    codes; the SQLSTATEs mean an unmapped path still cannot answer 200.
--
-- 7. p_new_status is validated, not applied.
--    The status is derived here from the decision, using the same eight-option table
--    the domain layer holds (`DECISION_RULES`). `p_new_status` is kept in the
--    signature the design published and treated as the caller's assertion about what
--    it believes the decision means: if it disagrees with the derived status the call
--    is refused rather than quietly stored. `assign_coverage` derives the status the
--    request already holds, because Requirement 10, criterion 8 has it create a
--    schedule link and says nothing about deciding the request.
--
-- 8. p_expected_status is additive, defaulted, and present from the start.
--    The design's concurrent-modification contract needs the caller's seen status
--    compared inside the lock, which the eleven published parameters cannot express.
--    Adding it later would mean a second overload or a drop-and-recreate; adding it
--    now with `default null` leaves every call the design describes valid and makes
--    `stale_request_state` reachable for task 12.2 without another migration.
--
-- 9. The two new tables are readable and nothing more.
--    Both are written only through pto_decide(), which bypasses row level security as
--    the owner, so neither table needs an insert policy and neither gets one; insert,
--    update, and delete are revoked from anon and authenticated as well, so a direct
--    attempt fails on privilege rather than matching zero rows. super_admin reads
--    both. An employee reads the decisions on their own requests, which is what
--    Requirement 11, criterion 7 needs to show the reviewer response, and nothing
--    else: the ledger stays administrator-only, because an employee's balance is
--    Requirement 21, criterion 1's `pto_balances` read and no criterion asks them to
--    read individual movements.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS STAGE DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────────
-- Cancellation (Requirement 11, criterion 9) is the employee's own path and is not a
-- decision; it does not go through pto_decide(). The credit criterion 14 requires
-- when a previously approved request is cancelled belongs with that path in task
-- 12.2, and it has the same ledger to reconcile against.
--
-- Coverage assignment (criterion 8) writes an employee_schedules row. This stage adds
-- the column that links it to the request; the write itself is the service's, because
-- it needs the covering employee's shift times and a published status.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- ROLLBACK PATH (Requirement 23, criterion 8)
-- ─────────────────────────────────────────────────────────────────────────────────
-- Step A — keep the history, if it matters. The decision rows are the only record of
-- which status each request held before step C flattens it, and they are dropped in
-- step D. Export first, or skip this only when the two tables are empty.
--
--   \copy (select * from public.pto_request_decisions) to 'pto_request_decisions.csv' csv header
--   \copy (select * from public.pto_balance_ledger)    to 'pto_balance_ledger.csv'    csv header
--
-- Step B — reverse every balance movement the ledger recorded, so pto_balances
-- returns to the figures it held before this stage. Derived from the ledger rather
-- than recomputed, so it reverses exactly what was applied.
--
--   begin;
--     update public.pto_balances b
--        set vacation_used = b.vacation_used - m.vacation,
--            sick_used     = b.sick_used     - m.sick,
--            personal_used = b.personal_used - m.personal
--       from (select profile_id, year,
--                    sum(case when balance_field = 'vacation_used' then delta_days else 0 end) as vacation,
--                    sum(case when balance_field = 'sick_used'     then delta_days else 0 end) as sick,
--                    sum(case when balance_field = 'personal_used' then delta_days else 0 end) as personal
--               from public.pto_balance_ledger
--              group by 1, 2) m
--      where b.profile_id = m.profile_id and b.year = m.year;
--   commit;
--
-- Step C — map the three new statuses back to `pending`, so the restored constraint
-- validates. A request that was denied, approved, or cancelled keeps its status;
-- only the three values this stage introduced have nowhere to go.
--
--   begin;
--     update public.pto_requests set status = 'pending'
--      where status in ('waitlisted', 'information_requested', 'partially_approved');
--
-- Step D — restore the four-value constraint, drop the function, then the two tables.
-- The ledger references the decisions, so it goes first.
--
--     alter table public.pto_requests drop constraint if exists pto_requests_status_check;
--     alter table public.pto_requests add constraint pto_requests_status_check
--       check (status in ('pending', 'approved', 'denied', 'cancelled'));
--
--     drop function if exists public.pto_decide(uuid, text, text, jsonb, jsonb, jsonb,
--                                               jsonb, text, text, boolean, text, text);
--     drop table if exists public.pto_balance_ledger;
--     drop table if exists public.pto_request_decisions;
--   commit;
--
-- Step E — the three added columns, only if the rollback has to be total. They are
-- additive and nothing outside this feature reads them, so leaving them in place is
-- the safer default; dropping employee_schedules.coverage_for_request_id discards the
-- link between a covering shift and the absence it covers.
--
--   begin;
--     alter table public.employee_schedules drop column if exists coverage_for_request_id;
--     alter table public.pto_requests
--       drop column if exists short_notice,
--       drop column if exists working_days;
--   commit;
--
-- The attendance_audit_log rows pto_decide() wrote stay where they are. The table is
-- append-only by construction (Requirement 16, criterion 5) and its trigger refuses a
-- delete even on a `security definer` path, so no rollback step may attempt one. The
-- decisions they describe are gone; the record that they were taken remains, which is
-- the point of an audit log.
--
-- Then confirm nothing was lost, from outside the database:
--
--   node --env-file=.env.local scripts/verify-attendance-row-retention.mjs --verify --label stage-4-pre
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- ROW RETENTION (Requirement 23, criterion 3)
-- ─────────────────────────────────────────────────────────────────────────────────
--   node --env-file=.env.local scripts/verify-attendance-row-retention.mjs --snapshot --label stage-4-pre
--   ... apply this file ...
--   node --env-file=.env.local scripts/verify-attendance-row-retention.mjs --verify --label stage-4-pre
--
-- `--strict` will report a gain on audit_log on the live project, because Quotes
-- activity writes that table continuously and a migration cannot pause it. A gain
-- there is ordinary application traffic; this migration issues no insert, update, or
-- delete against any preserved table, and the post-condition block below fails the
-- transaction if any of the eight lost a row while it ran. Read the two runs the way
-- the stage-3 run was read: losses are the failure, gains on audit_log are the
-- application.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. PRE-CONDITIONS
--    Earlier stages present, the constraint this stage widens is where it should be,
--    every existing status already inside the wider vocabulary, and a fingerprint of
--    the eight preserved tables for the post-condition block to compare against.
-- ═══════════════════════════════════════════════════════════════════════════════
do $pre$
declare
  v_missing  text;
  v_old_def  text;
  v_outside  text;
  v_counts   jsonb;
begin
  -- Objects this stage builds on. attendance_closed_dates and attendance_audit_log
  -- are v1.9.0's; the rest are v1.2.0's.
  select string_agg(e.name, ', ' order by e.name)
    into v_missing
    from (values ('public.profiles'),
                 ('public.pto_requests'),
                 ('public.pto_balances'),
                 ('public.employee_schedules'),
                 ('public.attendance_closed_dates'),
                 ('public.attendance_audit_log')) as e(name)
   where to_regclass(e.name) is null;

  if v_missing is not null then
    raise exception 'v1.9.3 requires these objects and they are absent: %', v_missing
      using detail = 'Stage 4 builds on v1.2.0-time-attendance.sql and v1.9.0-attendance-foundations.sql.',
            hint   = 'Apply the earlier migrations first. Nothing has been changed.';
  end if;

  -- The status check must exist. If a manual change removed it, stop rather than
  -- invent a vocabulary: this migration widens a constraint, it does not restore one.
  select pg_get_constraintdef(c.oid)
    into v_old_def
    from pg_constraint c
   where c.conrelid = 'public.pto_requests'::regclass
     and c.conname  = 'pto_requests_status_check';

  if v_old_def is null then
    raise exception 'v1.9.3 found no pto_requests_status_check to widen'
      using detail = 'v1.2.0-time-attendance.sql created it over pending, approved, denied, cancelled.',
            hint   = 'Investigate why it is missing before widening it. Nothing has been changed.';
  end if;

  -- `add constraint` validates every existing row. A status outside the seven values
  -- would abort the transaction with a constraint-violation error naming no row, so
  -- name it here instead.
  select string_agg(distinct r.status, ', ' order by r.status)
    into v_outside
    from public.pto_requests r
   where r.status not in ('pending', 'approved', 'denied', 'cancelled',
                          'waitlisted', 'information_requested', 'partially_approved');

  if v_outside is not null then
    raise exception 'v1.9.3 found pto_requests rows holding statuses outside the new vocabulary: %', v_outside
      using detail = 'The widened check accepts pending, approved, denied, cancelled, waitlisted, information_requested, partially_approved.',
            hint   = 'Reconcile those rows first. Nothing has been changed.';
  end if;

  select jsonb_build_object(
           'time_clock_entries',  (select count(*) from public.time_clock_entries),
           'time_clock_breaks',   (select count(*) from public.time_clock_breaks),
           'employee_schedules',  (select count(*) from public.employee_schedules),
           'pto_requests',        (select count(*) from public.pto_requests),
           'pto_balances',        (select count(*) from public.pto_balances),
           'payroll_periods',     (select count(*) from public.payroll_periods),
           'payroll_summaries',   (select count(*) from public.payroll_summaries),
           'audit_log',           (select count(*) from public.audit_log)
         )
    into v_counts;

  perform set_config('nhwd.v193_row_counts', v_counts::text, true);
  perform set_config('nhwd.v193_old_status_check', v_old_def, true);

  raise notice 'v1.9.3 pre-conditions met. Widening: %', v_old_def;
end
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. PTO_REQUESTS — the wider status vocabulary, and the two columns submission
--    computes (Requirement 11, criteria 2 and 5)
--
--    Dropped and re-added rather than altered, because a check constraint has no
--    `alter ... check` form. The drop and the add are in one transaction, so no
--    window exists in which pto_requests carries no status check at all. Existing
--    rows are re-validated, which reads them and changes none.
--
--    working_days is the count computed at submission — the figure the employee was
--    shown and the figure Correctness Property 18 says a later decision recomputes
--    to. pto_decide() never overwrites it: a partial approval's approved days are
--    the decision's, recorded on the decision row, and flattening the submitted
--    count onto them would lose what was asked for. numeric(5,1) matches
--    pto_requests.total_days and pto_balances, so half days remain expressible.
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.pto_requests drop constraint if exists pto_requests_status_check;
alter table public.pto_requests add constraint pto_requests_status_check
  check (status in ('pending', 'approved', 'denied', 'cancelled',
                    'waitlisted', 'information_requested', 'partially_approved'));

alter table public.pto_requests
  add column if not exists short_notice boolean not null default false,
  add column if not exists working_days numeric(5,1);

comment on column public.pto_requests.short_notice is
  'True when the request was submitted fewer than 14 calendar days before its start date. Computed at submission by domain/pto.ts buildSubmissionDisclosure (Requirement 11, criterion 5).';
comment on column public.pto_requests.working_days is
  'Working days the request covers, computed on the server at submission by domain/pto.ts countWorkingDays (Requirement 11, criterion 2). Never rewritten by a decision.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. PTO_REQUEST_DECISIONS — one row per committed decision
--
--    Carries what the four legacy columns on pto_requests cannot hold: which of the
--    eight options was taken, the status it moved from and to, the approved,
--    declined, and suggested ranges, and the two reasons. Eight options collapse
--    onto five statuses, so the decision is recorded beside the status: the status
--    says what the request now is, the decision says how it got there.
--
--    unique (request_id, idempotency_key) is the mechanism behind Requirement 10,
--    criterion 17. Its index leads on request_id, so it also serves every
--    "decisions for this request" read and no second index is needed.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.pto_request_decisions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.pto_requests(id) on delete cascade,
  idempotency_key text not null,
  decision text not null check (decision in (
    'approve_full', 'deny', 'approve_partial', 'suggest_dates',
    'assign_coverage', 'approve_with_coverage', 'waitlist', 'request_info'
  )),
  previous_status text not null,
  new_status text not null,
  approved_ranges jsonb not null default '[]'::jsonb,
  declined_ranges jsonb not null default '[]'::jsonb,
  suggested_ranges jsonb not null default '[]'::jsonb,
  reason text,
  override_reason text,
  acknowledged_shortfall boolean not null default false,
  actor_profile_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint unique_decision_idempotency unique (request_id, idempotency_key)
);

comment on table public.pto_request_decisions is
  'One row per committed leave decision. Written only by public.pto_decide(). unique (request_id, idempotency_key) makes a resubmitted decision a no-op (Requirement 10, criterion 17).';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. PTO_BALANCE_LEDGER — append-only balance movements
--
--    pto_balances.*_used stays the column Payroll and every screen read, so nothing
--    downstream changes shape. The ledger is the audit of how it got there and the
--    reconciliation source pto_decide() measures the next movement against:
--    `pto_balances.<field>_used = coalesce(sum(ledger.delta_days), 0)` per profile,
--    year, and field is the invariant the tests assert.
--
--    unique (decision_id, year, balance_field) is what makes a replayed decision
--    apply once even if the replay check above it were bypassed.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.pto_balance_ledger (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  request_id uuid references public.pto_requests(id) on delete set null,
  decision_id uuid references public.pto_request_decisions(id) on delete set null,
  year integer not null,
  balance_field text not null check (balance_field in ('vacation_used', 'sick_used', 'personal_used')),
  delta_days numeric(5,1) not null,
  created_at timestamptz not null default now(),
  constraint unique_ledger_movement unique (decision_id, year, balance_field)
);

create index if not exists idx_pto_ledger_profile_year
  on public.pto_balance_ledger(profile_id, year);

-- Every reconciliation pto_decide() performs reads the ledger by request. Without
-- this the read is a sequential scan of the whole ledger inside the request's lock.
create index if not exists idx_pto_ledger_request
  on public.pto_balance_ledger(request_id);

comment on table public.pto_balance_ledger is
  'Append-only record of every pto_balances movement, attributed to the calendar year of the affected dates (Requirement 10, criteria 15 and 16). Written only by public.pto_decide().';
comment on column public.pto_balance_ledger.delta_days is
  'Signed as pto_balances.*_used accumulates: positive consumes balance (a debit), negative returns it (a credit).';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. EMPLOYEE_SCHEDULES.COVERAGE_FOR_REQUEST_ID (Requirement 10, criterion 8)
--    Links a shift created or amended to cover an absence back to the request that
--    caused it. Nullable, unconstrained by any default: an ordinary shift carries
--    null, which is every row that exists today.
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.employee_schedules
  add column if not exists coverage_for_request_id uuid references public.pto_requests(id);

comment on column public.employee_schedules.coverage_for_request_id is
  'The time-off request this shift was created or amended to cover (Requirement 10, criterion 8). Null for an ordinary shift.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. ROW LEVEL SECURITY AND PRIVILEGES ON THE TWO NEW TABLES
--    Read-only to every client. Both tables are written by pto_decide() alone, which
--    runs as the owner and is not constrained by these policies. See decision 9.
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.pto_request_decisions enable row level security;
alter table public.pto_balance_ledger    enable row level security;

-- ── Administrators read every decision.
drop policy if exists "pto_decisions_admin_select" on public.pto_request_decisions;
create policy "pto_decisions_admin_select" on public.pto_request_decisions
  for select to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'super_admin');

-- ── An employee reads the decisions on their own requests, which is the reviewer
--    response text Requirement 11, criterion 7 displays. Scoped through the request
--    rather than by a profile column, because a decision belongs to a request.
drop policy if exists "pto_decisions_own_select" on public.pto_request_decisions;
create policy "pto_decisions_own_select" on public.pto_request_decisions
  for select to authenticated
  using (exists (
    select 1 from public.pto_requests r
     where r.id = pto_request_decisions.request_id
       and r.profile_id = auth.uid()
  ));

-- ── The ledger is administrator-only. An employee's balance is pto_balances, which
--    Requirement 21, criterion 1 already grants them; no criterion asks them to read
--    individual movements.
drop policy if exists "pto_ledger_admin_select" on public.pto_balance_ledger;
create policy "pto_ledger_admin_select" on public.pto_balance_ledger
  for select to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'super_admin');

-- Neither table has an insert, update, or delete policy, so row level security
-- refuses all three. The privilege revoke is the second layer: a direct attempt then
-- fails on permission rather than silently matching no row, which is the same
-- two-layer shape v1.9.0 gave attendance_audit_log.
revoke insert, update, delete on public.pto_request_decisions from authenticated, anon;
revoke insert, update, delete on public.pto_balance_ledger    from authenticated, anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. PTO_DECIDE() — one transaction per decision
--
--    Order matters and is the order below:
--      a. resolve the caller and refuse anyone who does not administer attendance
--      b. refuse a decision outside the eight options
--      c. lock the request row, so everything after this reads committed state and
--         no second decision can interleave
--      d. refuse the request's owner
--      e. return stale_request_state if the caller's seen status no longer holds
--      f. return the prior decision if this idempotency key was already applied
--      g. derive the status, validate the payload against the stored rows, and
--         compute the movement the ledger and the approved ranges imply
--      h. apply everything inside a block whose failure returns the reason and
--         leaves the request exactly as it was
--
--    Returns one jsonb envelope in every case. `ok` says whether the call was
--    honoured, `applied` whether anything moved, `code` names the outcome when it is
--    not a plain success. Callers must read `ok`; the raises in a through d and g
--    carry SQLSTATEs that already answer 403, 400, or 404, so a caller that forgets
--    still cannot report success.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.pto_decide(
  p_request_id uuid,
  p_decision text,
  p_new_status text,
  p_approved_ranges jsonb,
  p_declined_ranges jsonb,
  p_suggested_ranges jsonb,
  p_balance_deltas jsonb,
  p_reason text,
  p_override_reason text,
  p_acknowledged_shortfall boolean,
  p_idempotency_key text,
  p_expected_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '15s'
as $fn$
declare
  -- The caller.
  v_actor        uuid := auth.uid();
  v_actor_role   text;

  -- The request, as locked.
  v_request      public.pto_requests%rowtype;

  -- What the decision means.
  v_approves     boolean;
  v_reconciles   boolean;
  v_status       text;
  v_balance_field text;

  -- Normalised payload.
  v_approved     jsonb := coalesce(p_approved_ranges,  '[]'::jsonb);
  v_declined     jsonb := coalesce(p_declined_ranges,  '[]'::jsonb);
  v_suggested    jsonb := coalesce(p_suggested_ranges, '[]'::jsonb);
  v_deltas       jsonb := coalesce(p_balance_deltas,   '[]'::jsonb);
  v_reason       text  := nullif(btrim(coalesce(p_reason, '')), '');
  v_override     text  := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_ack          boolean := coalesce(p_acknowledged_shortfall, false);
  v_key          text  := nullif(btrim(coalesce(p_idempotency_key, '')), '');

  -- Derived.
  v_dates        date[];
  v_working_days numeric(5,1);
  v_required     jsonb;
  v_supplied     jsonb;
  v_mismatches   integer;
  v_bad_field    text;
  v_duplicates   integer;

  -- Applied.
  v_prior        public.pto_request_decisions%rowtype;
  v_decision_id  uuid;
  v_decided_at   timestamptz;
  v_audit_id     uuid;
  v_balances     jsonb;

  v_iso_date constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
begin
  -- ── a. The caller administers attendance, or nothing happens ────────────────
  if v_actor is null then
    raise exception 'NOT_AUTHENTICATED: pto_decide requires a signed-in caller.'
      using errcode = '42501',
            detail  = 'auth.uid() resolved to null, so the request carried no user session.',
            hint    = 'Call through a user-scoped Supabase client. Nothing has been changed.';
  end if;

  select p.role::text into v_actor_role from public.profiles p where p.id = v_actor;

  if v_actor_role is distinct from 'super_admin' then
    raise exception 'NOT_AUTHORISED: only super_admin may decide a time-off request.'
      using errcode = '42501',
            detail  = format('Caller %s holds role %s.', v_actor, coalesce(v_actor_role, 'none')),
            hint    = 'Requirement 21, criterion 12 withholds time-off approval from manager. Nothing has been changed.';
  end if;

  if v_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED: a decision must carry a non-blank idempotency key.'
      using errcode = '22023',
            hint    = 'Requirement 10, criterion 17 is enforced by unique (request_id, idempotency_key). Nothing has been changed.';
  end if;

  -- ── b. The decision is one of the eight options ─────────────────────────────
  if p_decision is null or p_decision not in (
       'approve_full', 'deny', 'approve_partial', 'suggest_dates',
       'assign_coverage', 'approve_with_coverage', 'waitlist', 'request_info') then
    raise exception 'UNKNOWN_DECISION: "%" is not one of the eight decision options.', coalesce(p_decision, 'null')
      using errcode = '22023',
            detail  = 'approve_full, deny, approve_partial, suggest_dates, assign_coverage, approve_with_coverage, waitlist, request_info.',
            hint    = 'Nothing has been changed.';
  end if;

  -- Payload shapes, before anything is read from them.
  if jsonb_typeof(v_approved) <> 'array' or jsonb_typeof(v_declined) <> 'array'
     or jsonb_typeof(v_suggested) <> 'array' or jsonb_typeof(v_deltas) <> 'array' then
    raise exception 'INVALID_PAYLOAD: approved, declined, and suggested ranges and the balance deltas must each be a JSON array.'
      using errcode = '22023', hint = 'Nothing has been changed.';
  end if;

  if exists (
    select 1
      from (values ('approved', v_approved), ('declined', v_declined), ('suggested', v_suggested)) as a(label, arr),
           lateral jsonb_array_elements(a.arr) as r
     where jsonb_typeof(r.value) <> 'object'
        or r.value->>'from' is null
        or r.value->>'to'   is null
        or r.value->>'from' !~ v_iso_date
        or r.value->>'to'   !~ v_iso_date
  ) then
    raise exception 'INVALID_RANGES: every range must be an object carrying "from" and "to" as YYYY-MM-DD.'
      using errcode = '22023',
            detail  = 'The shape is domain/pto.ts DateRange. A missing bound would silently approve nothing.',
            hint    = 'Nothing has been changed.';
  end if;

  -- A bound can match the shape and still name no date — 2026-02-30. Cast every bound
  -- once, here, so that this is an invalid payload rather than a cast failure surfacing
  -- from the middle of the arithmetic. Every cast below this line is safe.
  begin
    perform (r.value->>'from')::date, (r.value->>'to')::date
       from (values (v_approved), (v_declined), (v_suggested)) as a(arr),
            lateral jsonb_array_elements(a.arr) as r;
  exception
    when others then
      raise exception 'INVALID_RANGES: a range bound names no real calendar date (%).', sqlerrm
        using errcode = '22023', hint = 'Nothing has been changed.';
  end;

  -- ── c. Lock the request. Everything below reads committed state ─────────────
  select * into v_request from public.pto_requests where id = p_request_id for update;

  if not found then
    raise exception 'REQUEST_NOT_FOUND: no time-off request with id %.', p_request_id
      using errcode = 'P0002', hint = 'Nothing has been changed.';
  end if;

  -- ── d. The owner of a request may never decide it ───────────────────────────
  if v_request.profile_id = v_actor then
    raise exception 'OWNER_CANNOT_DECIDE: the employee who owns a request may not decide it.'
      using errcode = '42501',
            detail  = format('Request %s belongs to %s, who is the caller.', v_request.id, v_request.profile_id),
            hint    = 'Requirement 10, criterion 19. Nothing has been changed.';
  end if;

  -- ── e. The status the caller saw still holds ────────────────────────────────
  if p_expected_status is not null and p_expected_status <> v_request.status then
    return jsonb_build_object(
      'ok', false,
      'applied', false,
      'code', 'stale_request_state',
      'error', format('The request moved to %s while the decision was being composed.', v_request.status),
      'current', jsonb_build_object(
        'request_id',   v_request.id,
        'profile_id',   v_request.profile_id,
        'pto_type',     v_request.pto_type,
        'status',       v_request.status,
        'start_date',   v_request.start_date,
        'end_date',     v_request.end_date,
        'total_days',   v_request.total_days,
        'working_days', v_request.working_days,
        'short_notice', v_request.short_notice,
        'reviewed_by',  v_request.reviewed_by,
        'reviewed_at',  v_request.reviewed_at
      )
    );
  end if;

  -- ── f. This key was already applied: the prior result, and nothing moves ────
  select * into v_prior
    from public.pto_request_decisions d
   where d.request_id = v_request.id
     and d.idempotency_key = v_key;

  if found then
    select coalesce(jsonb_agg(jsonb_build_object(
             'year', l.year, 'balance_field', l.balance_field, 'delta_days', l.delta_days)
             order by l.year, l.balance_field), '[]'::jsonb)
      into v_supplied
      from public.pto_balance_ledger l
     where l.decision_id = v_prior.id;

    return jsonb_build_object(
      'ok', true,
      'applied', false,
      'code', 'already_applied',
      'request_id', v_request.id,
      'decision_id', v_prior.id,
      'decision', v_prior.decision,
      'profile_id', v_request.profile_id,
      'pto_type', v_request.pto_type,
      'previous_status', v_prior.previous_status,
      'new_status', v_prior.new_status,
      'current_status', v_request.status,
      'actor_profile_id', v_prior.actor_profile_id,
      'decided_at', v_prior.created_at,
      'idempotency_key', v_prior.idempotency_key,
      'approved_ranges', v_prior.approved_ranges,
      'declined_ranges', v_prior.declined_ranges,
      'suggested_ranges', v_prior.suggested_ranges,
      'reason', v_prior.reason,
      'override_reason', v_prior.override_reason,
      'acknowledged_shortfall', v_prior.acknowledged_shortfall,
      'balance_deltas', v_supplied
    );
  end if;

  -- ── g. What the decision means, and whether the payload agrees ──────────────
  case p_decision
    when 'approve_full', 'approve_with_coverage' then
      v_status := 'approved';      v_approves := true;
    when 'approve_partial' then
      v_status := 'partially_approved'; v_approves := true;
    when 'deny' then
      v_status := 'denied';        v_approves := false;
    when 'suggest_dates', 'request_info' then
      v_status := 'information_requested'; v_approves := false;
    when 'waitlist' then
      v_status := 'waitlisted';    v_approves := false;
    when 'assign_coverage' then
      -- Records a coverage assignment without deciding the request.
      v_status := v_request.status; v_approves := false;
    else
      raise exception 'UNKNOWN_DECISION: "%" has no status mapping.', p_decision
        using errcode = '22023', hint = 'Nothing has been changed.';
  end case;

  -- p_new_status is the caller's assertion, not the source of the status.
  if p_new_status is not null and p_new_status <> v_status then
    raise exception 'STATUS_MISMATCH: decision "%" sets status "%", not "%".', p_decision, v_status, p_new_status
      using errcode = '22023',
            detail  = 'The eight options map onto five statuses; assign_coverage leaves the status as it stands.',
            hint    = 'Nothing has been changed.';
  end if;

  -- Reasons the requirements make mandatory.
  if p_decision = 'deny' and v_reason is null then
    raise exception 'REASON_REQUIRED: a denial carries a reason of at least one non-whitespace character.'
      using errcode = '22023',
            hint    = 'Requirement 10, criterion 3. Nothing has been changed.';
  end if;

  if p_decision = 'request_info' and v_reason is null then
    raise exception 'REASON_REQUIRED: requesting additional information carries the question.'
      using errcode = '22023',
            hint    = 'Requirement 10, criterion 7. Nothing has been changed.';
  end if;

  if p_decision = 'suggest_dates' and jsonb_array_length(v_suggested) = 0 then
    raise exception 'SUGGESTED_RANGES_REQUIRED: suggesting different dates carries the suggested range.'
      using errcode = '22023',
            hint    = 'Requirement 10, criterion 5. Nothing has been changed.';
  end if;

  if p_decision = 'approve_partial'
     and (jsonb_array_length(v_approved) = 0 or jsonb_array_length(v_declined) = 0) then
    raise exception 'PARTIAL_RANGES_REQUIRED: approving part of a request records both the approved and the declined range.'
      using errcode = '22023',
            hint    = 'Requirement 10, criterion 4. Nothing has been changed.';
  end if;

  -- An approve-everything decision approves the requested range. Defaulted rather
  -- than required, matching approvedRangesForDecision in domain/pto.ts.
  if v_approves and p_decision <> 'approve_partial' and jsonb_array_length(v_approved) = 0 then
    v_approved := jsonb_build_array(
      jsonb_build_object('from', v_request.start_date, 'to', v_request.end_date));
  end if;

  -- A decision that approves nothing approves no dates.
  if not v_approves and jsonb_array_length(v_approved) > 0 then
    raise exception 'UNEXPECTED_APPROVED_RANGES: decision "%" approves nothing, so it may name no approved range.', p_decision
      using errcode = '22023', hint = 'Nothing has been changed.';
  end if;

  -- Approving more than was asked for is not a decision on this request.
  if exists (
    select 1 from jsonb_array_elements(v_approved) as r
     where (r.value->>'from')::date < v_request.start_date
        or (r.value->>'to')::date   > v_request.end_date
  ) then
    raise exception 'RANGES_OUTSIDE_REQUEST: an approved range must fall inside % .. %.',
                    v_request.start_date, v_request.end_date
      using errcode = '22023', hint = 'Nothing has been changed.';
  end if;

  -- Bounded work. A leave request longer than a year is a data fault, and generating
  -- its dates inside a row lock is not the way to discover that.
  if exists (
    select 1 from jsonb_array_elements(v_approved) as r
     where (r.value->>'to')::date - (r.value->>'from')::date > 366
  ) then
    raise exception 'RANGE_TOO_LONG: an approved range may not span more than 366 days.'
      using errcode = '22023', hint = 'Nothing has been changed.';
  end if;

  -- The working dates the approved ranges cover: Monday to Friday, excluding the
  -- dates the organisation is closed, de-duplicated across overlapping ranges. The
  -- same rule as countWorkingDays in domain/pto.ts. An inverted range covers no
  -- dates, which is the reading the domain gives it too.
  select coalesce(array_agg(candidates.d order by candidates.d), array[]::date[])
    into v_dates
    from (
      select distinct g::date as d
        from jsonb_array_elements(v_approved) as r,
             lateral generate_series((r.value->>'from')::date,
                                     (r.value->>'to')::date,
                                     interval '1 day') as g
    ) as candidates
   where extract(isodow from candidates.d) between 1 and 5
     and not exists (
       select 1 from public.attendance_closed_dates c where c.closed_date = candidates.d);

  v_working_days := coalesce(array_length(v_dates, 1), 0);
  v_balance_field := case v_request.pto_type
                       when 'vacation' then 'vacation_used'
                       when 'sick'     then 'sick_used'
                       else 'personal_used'   -- personal, bereavement, unpaid
                     end;

  -- Only an approval and a denial reconcile the balance. Requirement 10, criteria 5,
  -- 6, and 7 leave it untouched for the other three, and assign_coverage does not
  -- decide the request at all.
  v_reconciles := v_approves or p_decision = 'deny';

  -- Each supplied delta names one year, one balance column, and one signed number.
  -- Both the snake_case the ledger uses and the camelCase domain/pto.ts produces are
  -- accepted, so the payload cannot fail on a naming convention.
  if exists (
    select 1 from jsonb_array_elements(v_deltas) as e
     where jsonb_typeof(e.value) <> 'object'
        or coalesce(e.value->>'year', e.value->>'Year') is null
        or coalesce(e.value->>'balance_field', e.value->>'balanceField') is null
        or coalesce(e.value->>'delta_days', e.value->>'deltaDays') is null
        or coalesce(e.value->>'year', e.value->>'Year') !~ '^-?[0-9]+$'
        or coalesce(e.value->>'delta_days', e.value->>'deltaDays') !~ '^-?[0-9]+(\.[0-9]+)?$'
  ) then
    raise exception 'INVALID_BALANCE_DELTAS: every delta carries year, balance_field, and delta_days.'
      using errcode = '22023',
            detail  = 'The shape is domain/pto.ts BalanceDelta, in either snake_case or camelCase.',
            hint    = 'Nothing has been changed.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'year', s.year, 'balance_field', s.balance_field, 'delta_days', s.delta_days)
           order by s.year, s.balance_field), '[]'::jsonb),
         count(*) - count(distinct format('%s|%s', s.year, s.balance_field))
    into v_supplied, v_duplicates
    from (
      select (coalesce(e.value->>'year', e.value->>'Year'))::int                       as year,
             coalesce(e.value->>'balance_field', e.value->>'balanceField')             as balance_field,
             (coalesce(e.value->>'delta_days', e.value->>'deltaDays'))::numeric(5,1)   as delta_days
        from jsonb_array_elements(v_deltas) as e
    ) as s;

  if v_duplicates > 0 then
    raise exception 'DUPLICATE_BALANCE_DELTAS: a decision may carry at most one delta per year and balance column.'
      using errcode = '22023',
            detail  = 'unique (decision_id, year, balance_field) on pto_balance_ledger would refuse the second.',
            hint    = 'Nothing has been changed.';
  end if;

  select string_agg(distinct e.value->>'balance_field', ', ')
    into v_bad_field
    from jsonb_array_elements(v_supplied) as e
   where e.value->>'balance_field' <> v_balance_field;

  if v_bad_field is not null then
    raise exception 'BALANCE_FIELD_MISMATCH: a % request moves %, not %.',
                    v_request.pto_type, v_balance_field, v_bad_field
      using errcode = '22023',
            detail  = 'PTO_TYPE_TO_BALANCE_FIELD in domain/pto.ts is the only mapping from request type to balance column.',
            hint    = 'Nothing has been changed.';
  end if;

  if not v_reconciles then
    -- Requirement 10, criteria 5, 6, and 7: the balance is left alone.
    if jsonb_array_length(v_supplied) > 0 then
      raise exception 'UNEXPECTED_BALANCE_DELTAS: decision "%" leaves the balance unchanged.', p_decision
        using errcode = '22023', hint = 'Nothing has been changed.';
    end if;
    v_required := '[]'::jsonb;
  else
    -- The movement this decision implies: the working days its approved ranges
    -- cover, less everything already recorded for this request, per calendar year.
    -- Approving a pending request is + W (criterion 13); denying an approved one is
    -- − W (criterion 14); re-approving a narrower range is the difference.
    with target as (
      select extract(year from t.d)::int as year, count(*)::numeric(5,1) as days
        from unnest(v_dates) as t(d)
       group by 1
    ),
    prior as (
      select l.year, sum(l.delta_days)::numeric(5,1) as days
        from public.pto_balance_ledger l
       where l.request_id = v_request.id
         and l.balance_field = v_balance_field
       group by 1
    ),
    movement as (
      select coalesce(t.year, p.year) as year,
             coalesce(t.days, 0) - coalesce(p.days, 0) as delta_days
        from target t
        full outer join prior p on p.year = t.year
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'year', m.year, 'balance_field', v_balance_field, 'delta_days', m.delta_days)
             order by m.year), '[]'::jsonb)
      into v_required
      from movement m
     where m.delta_days <> 0;

    -- Exact agreement, year by year. Compared relationally rather than as jsonb,
    -- because 3 and 3.0 are the same number and different jsonb.
    select count(*)
      into v_mismatches
      from (select (e.value->>'year')::int as year,
                   (e.value->>'delta_days')::numeric as delta_days
              from jsonb_array_elements(v_required) as e) r
      full outer join
           (select (e.value->>'year')::int as year,
                   (e.value->>'delta_days')::numeric as delta_days
              from jsonb_array_elements(v_supplied) as e) s
        on s.year = r.year
     where r.year is null or s.year is null or r.delta_days <> s.delta_days;

    if v_mismatches > 0 then
      raise exception 'DELTA_MISMATCH: the supplied balance deltas do not equal the movement the approved ranges imply.'
        using errcode = '22023',
              detail  = format('required %s, supplied %s, over working days %s in %s',
                               v_required, v_supplied, v_working_days, to_jsonb(v_dates)),
              hint    = 'Recompute with decisionBalanceDeltas over the stored request. Nothing has been changed.';
    end if;
  end if;

  -- ── h. Apply. A failure anywhere below leaves the request exactly as it was ──
  begin
    insert into public.pto_request_decisions (
      request_id, idempotency_key, decision, previous_status, new_status,
      approved_ranges, declined_ranges, suggested_ranges,
      reason, override_reason, acknowledged_shortfall, actor_profile_id
    ) values (
      v_request.id, v_key, p_decision, v_request.status, v_status,
      v_approved, v_declined, v_suggested,
      v_reason, v_override, v_ack, v_actor
    )
    returning id, created_at into v_decision_id, v_decided_at;

    if jsonb_array_length(v_required) > 0 then
      -- The movements, as the audit of what is about to change.
      insert into public.pto_balance_ledger (
        profile_id, request_id, decision_id, year, balance_field, delta_days
      )
      select v_request.profile_id, v_request.id, v_decision_id,
             (e.value->>'year')::int,
             e.value->>'balance_field',
             (e.value->>'delta_days')::numeric(5,1)
        from jsonb_array_elements(v_required) as e;

      -- A balance row for every affected year, then the increment in place. The
      -- upsert claims the row without reading it; the update adds to the value the
      -- server finds there, so two concurrent decisions sum rather than overwrite
      -- (Correctness Property 29).
      insert into public.pto_balances (profile_id, year, vacation_used, sick_used, personal_used)
      select distinct v_request.profile_id, (e.value->>'year')::int, 0, 0, 0
        from jsonb_array_elements(v_required) as e
      on conflict (profile_id, year) do nothing;

      update public.pto_balances b
         set vacation_used = b.vacation_used + m.vacation_delta,
             sick_used     = b.sick_used     + m.sick_delta,
             personal_used = b.personal_used + m.personal_delta
        from (
          select (e.value->>'year')::int as year,
                 sum(case when e.value->>'balance_field' = 'vacation_used'
                          then (e.value->>'delta_days')::numeric else 0 end) as vacation_delta,
                 sum(case when e.value->>'balance_field' = 'sick_used'
                          then (e.value->>'delta_days')::numeric else 0 end) as sick_delta,
                 sum(case when e.value->>'balance_field' = 'personal_used'
                          then (e.value->>'delta_days')::numeric else 0 end) as personal_delta
            from jsonb_array_elements(v_required) as e
           group by 1
        ) as m
       where b.profile_id = v_request.profile_id
         and b.year = m.year;
    end if;

    -- The status, the reviewer, and the decision timestamp. Skipped for
    -- assign_coverage, which records a coverage assignment rather than a review.
    if p_decision <> 'assign_coverage' then
      update public.pto_requests r
         set status        = v_status,
             reviewed_by   = v_actor,
             reviewed_at   = now(),
             denial_reason = case when p_decision = 'deny' then v_reason else r.denial_reason end
       where r.id = v_request.id;
    end if;

    -- The audit entry. Requirement 10, criterion 11: request, employee, decision,
    -- previous status, new status, actor, reason, affected dates, timestamp.
    insert into public.attendance_audit_log (
      profile_id, work_date, entity_type, entity_id, action, field,
      old_value, new_value, actor_profile_id, reason
    ) values (
      v_request.profile_id,
      coalesce(v_dates[1], v_request.start_date),
      'pto_request',
      v_request.id,
      'pto_decision',
      'status',
      jsonb_build_object(
        'status', v_request.status,
        'reviewed_by', v_request.reviewed_by,
        'reviewed_at', v_request.reviewed_at
      ),
      jsonb_build_object(
        'status', v_status,
        'decision', p_decision,
        'decision_id', v_decision_id,
        'idempotency_key', v_key,
        'employee_profile_id', v_request.profile_id,
        'pto_type', v_request.pto_type,
        'requested_range', jsonb_build_object('from', v_request.start_date, 'to', v_request.end_date),
        'approved_ranges', v_approved,
        'declined_ranges', v_declined,
        'suggested_ranges', v_suggested,
        'affected_dates', to_jsonb(v_dates),
        'working_days', v_working_days,
        'balance_deltas', v_required,
        'override_reason', v_override,
        'acknowledged_shortfall', v_ack
      ),
      v_actor,
      v_reason
    )
    returning id into v_audit_id;

  exception
    when unique_violation then
      -- A replay that arrived between the check above and this insert. It cannot,
      -- while the request row is locked, but the constraint is the guarantee and this
      -- is what honouring it looks like: report the prior decision, apply nothing.
      select * into v_prior
        from public.pto_request_decisions d
       where d.request_id = v_request.id
         and d.idempotency_key = v_key;

      if found then
        return jsonb_build_object(
          'ok', true, 'applied', false, 'code', 'already_applied',
          'request_id', v_request.id, 'decision_id', v_prior.id,
          'decision', v_prior.decision, 'profile_id', v_request.profile_id,
          'previous_status', v_prior.previous_status, 'new_status', v_prior.new_status,
          'current_status', v_request.status, 'decided_at', v_prior.created_at,
          'idempotency_key', v_prior.idempotency_key
        );
      end if;

      return jsonb_build_object(
        'ok', false, 'applied', false, 'code', 'balance_write_failed',
        'error', sqlerrm, 'sqlstate', sqlstate,
        'request_id', v_request.id, 'status', v_request.status,
        'attempted_status', v_status, 'balance_deltas', v_required
      );

    when others then
      -- Requirement 10, criterion 18. The block is a subtransaction, so every write
      -- above is already undone: the status is where it was and the balance has not
      -- moved. Return the reason rather than raising, so the route can answer with it.
      return jsonb_build_object(
        'ok', false, 'applied', false, 'code', 'balance_write_failed',
        'error', sqlerrm, 'sqlstate', sqlstate,
        'request_id', v_request.id, 'status', v_request.status,
        'attempted_status', v_status, 'balance_deltas', v_required
      );
  end;

  -- The balances as they now stand, for the years this decision touched.
  select coalesce(jsonb_agg(jsonb_build_object(
           'year', b.year,
           'vacation_days', b.vacation_days, 'sick_days', b.sick_days, 'personal_days', b.personal_days,
           'vacation_used', b.vacation_used, 'sick_used', b.sick_used, 'personal_used', b.personal_used)
           order by b.year), '[]'::jsonb)
    into v_balances
    from public.pto_balances b
   where b.profile_id = v_request.profile_id
     and b.year in (select (e.value->>'year')::int from jsonb_array_elements(v_required) as e);

  return jsonb_build_object(
    'ok', true,
    'applied', true,
    'code', null,
    'request_id', v_request.id,
    'decision_id', v_decision_id,
    'decision', p_decision,
    'profile_id', v_request.profile_id,
    'pto_type', v_request.pto_type,
    'previous_status', v_request.status,
    'new_status', v_status,
    'current_status', v_status,
    'actor_profile_id', v_actor,
    'decided_at', v_decided_at,
    'idempotency_key', v_key,
    'approved_ranges', v_approved,
    'declined_ranges', v_declined,
    'suggested_ranges', v_suggested,
    'affected_dates', to_jsonb(v_dates),
    'working_days', v_working_days,
    'balance_deltas', v_required,
    'balances', v_balances,
    'reason', v_reason,
    'override_reason', v_override,
    'acknowledged_shortfall', v_ack,
    'audit_id', v_audit_id
  );
end
$fn$;

comment on function public.pto_decide(uuid, text, text, jsonb, jsonb, jsonb, jsonb, text, text, boolean, text, text) is
  'Commits one leave decision as a single transaction: asserts the caller administers attendance, locks the request, refuses its owner, validates the supplied balance deltas against the working days the approved ranges imply and the movements already recorded, increments pto_balances in place, writes the ledger and the audit row, and returns the applied state. Requirements 10.11, 10.13 through 10.19, 21.12.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. FUNCTION PRIVILEGES
--    Execute is granted to PUBLIC by default, which on a `security definer` function
--    is wider than intended. Signed-in callers may call it; the function refuses
--    anyone who is not a super_admin, so the grant is a door and the guard is the
--    lock.
-- ═══════════════════════════════════════════════════════════════════════════════
revoke all on function public.pto_decide(uuid, text, text, jsonb, jsonb, jsonb, jsonb, text, text, boolean, text, text) from public;
revoke all on function public.pto_decide(uuid, text, text, jsonb, jsonb, jsonb, jsonb, text, text, boolean, text, text) from anon;
grant execute on function public.pto_decide(uuid, text, text, jsonb, jsonb, jsonb, jsonb, text, text, boolean, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_new_def   text;
  v_before    jsonb := coalesce(current_setting('nhwd.v193_row_counts', true), '{}')::jsonb;
  v_lost      text;
  v_missing   text;
  v_writeable text;
  v_secdef    boolean;
begin
  -- The three new statuses are accepted, and the four legacy ones survive.
  select pg_get_constraintdef(c.oid) into v_new_def
    from pg_constraint c
   where c.conrelid = 'public.pto_requests'::regclass
     and c.conname  = 'pto_requests_status_check';

  select string_agg(e.value, ', ' order by e.value)
    into v_missing
    from (values ('pending'), ('approved'), ('denied'), ('cancelled'),
                 ('waitlisted'), ('information_requested'), ('partially_approved')) as e(value)
   where v_new_def is null or strpos(v_new_def, e.value) = 0;

  if v_missing is not null then
    raise exception 'v1.9.3 left pto_requests_status_check without: %', v_missing
      using detail = format('definition is now %s', coalesce(v_new_def, 'absent')),
            hint   = 'Rolling back.';
  end if;

  -- Columns, tables, constraints, index, and function.
  select string_agg(e.what, ', ' order by e.what)
    into v_missing
    from (values
      ('pto_requests.short_notice'),
      ('pto_requests.working_days'),
      ('employee_schedules.coverage_for_request_id'),
      ('table pto_request_decisions'),
      ('table pto_balance_ledger'),
      ('constraint unique_decision_idempotency'),
      ('constraint unique_ledger_movement'),
      ('index idx_pto_ledger_profile_year'),
      ('function pto_decide')
    ) as e(what)
   where case e.what
           when 'pto_requests.short_notice' then not exists (
             select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'pto_requests' and column_name = 'short_notice')
           when 'pto_requests.working_days' then not exists (
             select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'pto_requests' and column_name = 'working_days')
           when 'employee_schedules.coverage_for_request_id' then not exists (
             select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'employee_schedules'
                and column_name = 'coverage_for_request_id')
           when 'table pto_request_decisions' then to_regclass('public.pto_request_decisions') is null
           when 'table pto_balance_ledger'    then to_regclass('public.pto_balance_ledger') is null
           when 'constraint unique_decision_idempotency' then not exists (
             select 1 from pg_constraint
              where conrelid = 'public.pto_request_decisions'::regclass
                and conname = 'unique_decision_idempotency' and contype = 'u')
           when 'constraint unique_ledger_movement' then not exists (
             select 1 from pg_constraint
              where conrelid = 'public.pto_balance_ledger'::regclass
                and conname = 'unique_ledger_movement' and contype = 'u')
           when 'index idx_pto_ledger_profile_year' then not exists (
             select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'idx_pto_ledger_profile_year')
           when 'function pto_decide' then not exists (
             select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'pto_decide')
         end;

  if v_missing is not null then
    raise exception 'v1.9.3 did not create: %', v_missing using hint = 'Rolling back.';
  end if;

  -- The function must be security definer, or the role assertion inside it guards a
  -- path that row level security was already refusing for a different reason.
  select p.prosecdef into v_secdef
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'pto_decide';

  if not coalesce(v_secdef, false) then
    raise exception 'v1.9.3 created pto_decide without security definer'
      using hint = 'Rolling back.';
  end if;

  -- Both new tables carry row level security, and neither has a policy that writes.
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('pto_request_decisions', 'pto_balance_ledger')
       and not c.relrowsecurity
  ) then
    raise exception 'v1.9.3 left row level security disabled on one of the two new tables'
      using hint = 'Rolling back.';
  end if;

  select string_agg(format('%s.%s (%s)', p.tablename, p.policyname, p.cmd), '; '
                    order by p.tablename, p.policyname)
    into v_writeable
    from pg_policies p
   where p.schemaname = 'public'
     and p.tablename in ('pto_request_decisions', 'pto_balance_ledger')
     and p.cmd <> 'SELECT';

  if v_writeable is not null then
    raise exception 'v1.9.3 created a non-select policy on a table only pto_decide may write: %', v_writeable
      using hint = 'Rolling back.';
  end if;

  -- Row retention (Requirement 23, criterion 3). Compared as "lost nothing" rather
  -- than "unchanged", because audit_log is written continuously by Quotes activity
  -- and a concurrent commit between the two counts is application traffic, not this
  -- migration. This migration issues no insert, update, or delete against any
  -- preserved table, so a loss would mean something here did.
  select string_agg(format('%s %s -> %s', e.key, e.value, e.current), ', ' order by e.key)
    into v_lost
    from (
      select b.key,
             (b.value)::bigint as value,
             case b.key
               when 'time_clock_entries' then (select count(*) from public.time_clock_entries)
               when 'time_clock_breaks'  then (select count(*) from public.time_clock_breaks)
               when 'employee_schedules' then (select count(*) from public.employee_schedules)
               when 'pto_requests'       then (select count(*) from public.pto_requests)
               when 'pto_balances'       then (select count(*) from public.pto_balances)
               when 'payroll_periods'    then (select count(*) from public.payroll_periods)
               when 'payroll_summaries'  then (select count(*) from public.payroll_summaries)
               when 'audit_log'          then (select count(*) from public.audit_log)
             end as current
        from jsonb_each_text(v_before) as b
    ) as e
   where e.current < e.value;

  if v_lost is not null then
    raise exception 'v1.9.3 lost rows in: %', v_lost
      using detail = 'Requirement 23, criterion 3 retains every existing row in the eight preserved tables.',
            hint   = 'Rolling back.';
  end if;

  raise notice 'v1.9.3: status vocabulary widened to 7, 2 tables + 3 columns + 1 function added, % preserved tables intact',
    (select count(*) from jsonb_each(v_before));
end
$post$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
--    Structure only. Behaviour is probed inside rolled-back transactions by two
--    companion scripts:
--
--      supabase/verification/v1.9.3-pto-decision-probe.sql
--        the constraint accepts the three new statuses and refuses anything else, each
--        unique constraint refuses a replay, pto_decide refuses an employee, a manager,
--        and the request's own owner, a mismatched payload is refused with the request
--        left where it was, the increment accumulates, a denial credits back what was
--        debited, and a range crossing 31 December debits each year its own days
--
--      supabase/verification/v1.9.3-pto-decide-lock-race.sql
--        run twice in parallel: the request lock serialises two concurrent decisions,
--        so each applies exactly its own movement and neither is lost
-- ═══════════════════════════════════════════════════════════════════════════════
with status_check as (
  select pg_get_constraintdef(c.oid) as definition
    from pg_constraint c
   where c.conrelid = 'public.pto_requests'::regclass
     and c.conname  = 'pto_requests_status_check'
)
select
  -- Seven accepted statuses.
  (select count(*)
     from (values ('pending'), ('approved'), ('denied'), ('cancelled'),
                  ('waitlisted'), ('information_requested'), ('partially_approved')) as e(value),
          status_check
    where strpos(status_check.definition, e.value) > 0)                 as accepted_statuses_expect_7,

  -- The three added columns.
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and (   (table_name = 'pto_requests'       and column_name in ('short_notice', 'working_days'))
           or (table_name = 'employee_schedules' and column_name = 'coverage_for_request_id')))
                                                                        as columns_added_expect_3,

  -- The two tables.
  (select count(*) from pg_tables
    where schemaname = 'public'
      and tablename in ('pto_request_decisions', 'pto_balance_ledger'))  as tables_created_expect_2,

  -- The two unique constraints that make a replay a no-op.
  (select count(*) from pg_constraint
    where contype = 'u'
      and conname in ('unique_decision_idempotency', 'unique_ledger_movement'))
                                                                        as unique_constraints_expect_2,

  -- The ledger indexes.
  (select count(*) from pg_indexes
    where schemaname = 'public'
      and indexname in ('idx_pto_ledger_profile_year', 'idx_pto_ledger_request'))
                                                                        as ledger_indexes_expect_2,

  -- The function, security definer, returning jsonb.
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'pto_decide'
      and p.prosecdef and pg_get_function_result(p.oid) = 'jsonb')       as pto_decide_expect_1,

  -- Read-only to clients: three select policies, no policy that writes.
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('pto_request_decisions', 'pto_balance_ledger')
      and cmd = 'SELECT')                                               as select_policies_expect_3,
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('pto_request_decisions', 'pto_balance_ledger')
      and cmd <> 'SELECT')                                              as write_policies_expect_0,

  -- Row retention (Requirement 23, criterion 3). Every count must equal
  -- supabase/verification/row-retention/stage-4-pre.json, except audit_log, which
  -- ordinary Quotes activity may have added to. Verify with:
  --   node --env-file=.env.local scripts/verify-attendance-row-retention.mjs --verify --label stage-4-pre
  (select count(*) from public.pto_requests)                            as pto_requests_total,
  (select count(*) from public.pto_balances)                            as pto_balances_total,
  (select count(*) from public.employee_schedules)                      as employee_schedules_total,
  (select count(*) from public.pto_request_decisions)                   as decisions_total_expect_0,
  (select count(*) from public.pto_balance_ledger)                      as ledger_total_expect_0;

-- New Hope Work Desk v1.9.4 — Time & Attendance mutations (migration stage 5 of 6)
--
-- Spec: .kiro/specs/time-attendance-ui-redesign
-- Requirements: 5.15, 5.16, 5.17, 5.18, 11.8, 11.9, 12.12, 12.13, 12.14, 12.15,
--               12.16, 16.1, 16.2, 16.6, 21.4, 21.7, 21.9, 21.10, 21.12,
--               23.1, 23.2, 23.3, 23.5, 23.8
--
-- Forward-only. Edits no released migration. Applies on top of v1.9.3.
--
-- This stage creates two functions and replaces one row level security policy. It
-- creates no table, adds no column, and writes no row to any of the eight preserved
-- tables of Requirement 23, criterion 3. The post-condition block asserts no
-- preserved table lost a row before the transaction is allowed to commit, and
-- scripts/verify-attendance-row-retention.mjs confirms it from outside against the
-- stage-5-pre snapshot.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- THE STAGE-5 GATE (Requirement 23, criterion 5)
-- ─────────────────────────────────────────────────────────────────────────────────
-- This file may not be applied while scripts/verify-payroll-parity.mjs reports a
-- differing field on any payroll period with status `processed` or `paid`. At the
-- time of application the harness exited 0 with no such period on the live project,
-- so parity holds vacuously: there is no stored payroll figure for a correction to
-- contradict. That is the gate the plan sets, and it is why this file ships now
-- rather than after the payroll periods exist.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────────────────────────
-- Every attendance mutation an administrator can make from the Team Today drawer and
-- the Exception drawer arrives here, and each one is one database transaction:
--
--   public.attendance_apply_correction(...)  corrections, added punches, manager
--                                            notes, and unscheduled-work approvals
--   public.attendance_mark_reviewed(...)     marking one employee-date reviewed
--
-- Both are `security definer`, so row level security does not constrain them and the
-- role test lives inside the function — the same test the v1.9.0 policies and
-- v1.9.3's pto_decide() use: super_admin, and no other role. Requirement 21,
-- criteria 4 and 12 restrict clock-entry correction to super_admin and withhold it
-- from `manager`, so `manager` is granted nothing here.
--
-- The shape both functions share, in this order:
--
--   a. resolve the caller and refuse anyone who does not administer attendance
--   b. refuse a call whose vocabulary or payload is not one this function accepts,
--      including an empty reason where a reason is required — refused before any
--      lock is taken, which is the same refusal one statement earlier than the
--      design's sequence diagram draws it and takes no lock to reach
--   c. lock the target row `for update`, so everything after this reads committed
--      state and no second administrator can interleave
--   d. recognise a replay of the same idempotency key and apply nothing
--   e. apply the change
--   f. insert the attendance_audit_log row AS THE LAST STATEMENT
--
-- Step f is the point of the file. The audit insert and the field change share one
-- transaction, so a failed audit write leaves the attempted change uncommitted and
-- returns the reason (Requirement 16, criterion 6). The apply phase runs inside a
-- block whose exception handler is a subtransaction rollback: by the time the handler
-- runs, the change is already undone, and the handler's only job is to say which
-- statement failed and why. Nothing recomputes a derived value here — the recompute
-- Requirements 5.18 and 12.14 display happens in the service after this transaction
-- commits, reading the same source rows this function wrote.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- THE CORRECTION VOCABULARY
-- ─────────────────────────────────────────────────────────────────────────────────
-- `p_field` is the operation selector. `p_entity_type` is the caller's assertion
-- about what it believes it is correcting and is validated against the field rather
-- than trusted, in the same way v1.9.3 treats `p_new_status`. Eight fields, four
-- targets, five audit actions:
--
--   p_field            target                      p_new_value            audit action
--   ─────────────────  ──────────────────────────  ─────────────────────  ──────────────────
--   clock_in           time_clock_entries row      instant, as a string   correct_punch
--   clock_out          time_clock_entries row      instant, as a string   correct_punch,
--                                                                         add_punch when the
--                                                                         previous value was
--                                                                         null
--   break_minutes      time_clock_entries row      integer 0..1440        correct_punch
--   session            new time_clock_entries row  {clock_in, clock_out?, add_punch
--                                                   break_minutes?}
--   break_start        time_clock_breaks row       instant, as a string   correct_punch
--   break_end          time_clock_breaks row       instant, as a string   correct_punch
--   duration_minutes   time_clock_breaks row       integer 0..1440        correct_punch
--   note               new attendance_notes row    non-blank string       add_note
--   unscheduled_work   audit entry only            true                   approve_unscheduled
--
-- The four controls Requirement 12, criterion 12 names are clock-in instant,
-- clock-out instant, break minutes, and manager note. Break minutes appears twice
-- because the two figures behind it live in two places and mean two different things:
--
--   * time_clock_entries.break_minutes is the accumulated column the inherited
--     payroll path reads as break hours (Appendix A.5, and `legacy_parity` in
--     server/attendance-service.ts). Correcting it moves the payroll-visible figure.
--   * time_clock_breaks.duration_minutes is what the redesigned derivation reads:
--     `toSessionInput` maps it to `durationMinutes`, and the domain prefers it over
--     the break's own bounds. Correcting it moves the derived paid and unpaid break
--     minutes, and therefore worked hours and the status.
--
-- A correction changes exactly the field it is asked to change and nothing else. It
-- does not quietly re-derive the other figure from the one it was given: the audit row
-- names one field and one previous value, and a function that moved a second
-- payroll-visible column behind that row would make the audit entry a lie. An
-- administrator who needs the payroll figure corrected corrects `break_minutes`; one
-- who needs the timeline corrected corrects the break row. Both are offered, both are
-- audited, neither is guessed at.
--
-- The one exception is total_hours, and it is not a second field: it is the stored
-- result of clock_in, clock_out, and break_minutes, and the inherited edit path in
-- /api/time-clock already recomputes it on every adjustment. This function reproduces
-- that arithmetic exactly —
--   total_hours = round(((clock_out - clock_in) in minutes − break_minutes) / 60, 2)
-- — and only when the entry has a clock_out, which is the same condition the route
-- applies. Leaving it stale would make the payroll figure disagree with the punches it
-- is derived from. Both the previous and the recomputed value are recorded on the
-- audit row, so the change is stated rather than implied. Correcting a break row does
-- not touch it, because the inherited path does not either.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- SEVEN DECISIONS THIS FILE MAKES, AND WHY
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- 1. A correction requires a reason; marking a day reviewed does not.
--    Requirements 5.16, 12.13, and 21.9 require a stored reason of at least one
--    non-whitespace character for every correction, and the function refuses a blank
--    one rather than storing an empty string that would satisfy `not null` and mean
--    nothing. `note` is the one field where the reason may be omitted: the note text
--    is itself the stated reason and is copied into the audit row's reason, so the
--    caller is not made to send the same sentence twice. Marking reviewed overrides
--    no derived value and Requirement 12, criterion 15 asks only for the actor and
--    the timestamp, so it takes no reason and the design's two-parameter signature
--    stands.
--
-- 2. The payroll period is resolved here, not supplied.
--    Requirement 16, criterion 2 records the related payroll period when one covers
--    the work date. The database owns the mapping from a date to a period, so
--    resolving it inside the function means a caller cannot mis-attribute a
--    correction, and it keeps the design's published eight-parameter signature
--    unchanged. Where overlapping templates cover one date — monthly and biweekly
--    both exist in payroll_periods — a period whose status is `processed` or `paid`
--    wins, then the latest starting one, because that is the period a correction has
--    to be traceable against. The function reads payroll_periods and writes nothing
--    to it: a correction inside a processed or paid period is permitted and never
--    recomputes a stored summary (task 14.2), so payroll_summaries is not touched
--    here at all.
--
-- 3. A replayed correction applies nothing and is still recorded.
--    The idempotency key is required and non-blank. A key already seen for this
--    employee and work date means the change was applied by an earlier call, so the
--    change is not applied again; the call returns the prior result with
--    `applied: false`, and a second audit row records the replay and points at the
--    first through `replay_of`. An audit log that showed one entry for two submitted
--    corrections would understate what happened. The key is stored inside
--    new_value — the same place v1.9.3 keeps it — rather than in a new column,
--    because this stage adds no schema. Detection reads it through
--    idx_attendance_audit_profile_date, which leads on (profile_id, work_date), so
--    the lookup is an index scan of one employee-date rather than a scan of the log.
--
-- 4. Guard rejections raise; a failed write returns.
--    An unauthorised caller, an unknown field, a payload that contradicts the stored
--    row: all raise, with the repo's `CODE: message` convention and a SQLSTATE that
--    already carries the right HTTP meaning — 42501 for authorisation, 22023 for an
--    invalid payload, P0002 for a target that does not exist. A failure inside the
--    apply block is different: it is the outcome Requirement 16, criterion 6
--    describes, and the function returns `change_write_failed` or
--    `audit_write_failed` with the reason so the route can answer with it rather than
--    parse prose. The distinction is which statement failed, and the returned code
--    says which.
--
-- 5. The lock is on the row the correction changes.
--    `select ... for update` on the clock entry, or on the break's parent entry and
--    then the break row, in that order, so two paths that touch both cannot deadlock.
--    Three fields have no existing row to lock: `session` locks the employee's open
--    entry when there is one, which is the row that decides whether the insert would
--    create a second open session; `note` and `unscheduled_work` append, and an
--    append has no lost-update to prevent. Marking reviewed locks the existing review
--    row when there is one and relies on the composite primary key when there is not.
--
-- 6. attendance_mark_reviewed retains the first reviewer through the primary key.
--    `insert ... on conflict (profile_id, work_date) do nothing` is the whole
--    mechanism behind Requirement 12, criterion 16: the first review's actor and
--    timestamp are never overwritten, because the second insert writes nothing. A
--    repeat returns `already_reviewed` with the retained reviewer and
--    `applied: false`, and writes no audit row — Requirement 16, criterion 1 records
--    review status changes, and a repeat changes nothing. That is the opposite of
--    the correction replay above, and deliberately so: a replayed correction is a
--    resubmitted change, while a repeated review is a request for a state the day is
--    already in.
--
-- 7. The pto_requests_update policy is widened here, with its own rollback.
--    Not part of stage 5's subject, but found while building task 12.2 and fixed in
--    the first forward-only migration to follow it. `v1.6.2-enforce-scoped-supervisor
--    -access.sql` grants an employee an update on their own request only while its
--    status is `pending`, so cancelling a `waitlisted` request — which Requirement 11,
--    criterion 8 offers and criterion 9 accepts — matched no row under row level
--    security and was refused. The `using` clause becomes
--    `status in ('pending', 'waitlisted')`.
--
--    The `with check` clause is tightened in the same statement, from
--    `profile_id = auth.uid()` to that plus
--    `status in ('pending', 'waitlisted', 'cancelled')`. The old clause constrained
--    only the row's owner, so an employee reaching the table directly could set their
--    own pending request to `approved`. Requirement 21, criterion 7 rejects an
--    employee approving their own request and criterion 10 requires that rule in row
--    level security as well as at the API layer; widening the `using` clause without
--    this would have extended the hole to waitlisted rows too. The three statuses
--    left are the three an employee's own write may produce: `cancelled` is
--    Requirement 11, criterion 9's withdrawal, and the other two are a row the
--    employee edits without deciding it. Administrator writes are unaffected —
--    `pto_requests_admin_all` is a separate permissive policy — and pto_decide()
--    bypasses row level security entirely as the owner.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS STAGE DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────────
-- It does not delete anything. There is no path here that removes a clock entry, a
-- break, a note, or a review, and no criterion asks for one; an entry recorded in
-- error is corrected and audited, not erased.
--
-- It does not withdraw an unscheduled-work approval. `unscheduled_work` accepts
-- `true` only. Requirement 12, criterion 8 makes unapproved unscheduled work
-- payroll-blocking and the approval clears it; nothing describes un-approving it, and
-- inventing that path would mean inventing what an already-processed payroll period
-- should do about it.
--
-- It does not recompute a Daily_Attendance_Record. That is the service's, after this
-- transaction commits, from the source rows this function wrote (Requirement 3,
-- criteria 14 and 15 keep the derivation in one place, and it is not this file).
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- ROLLBACK PATH (Requirement 23, criterion 8)
-- ─────────────────────────────────────────────────────────────────────────────────
-- Step A — drop the two functions. Their callers are the three routes of task 14.3,
-- which ship with this stage, so dropping the functions must be accompanied by
-- reverting those routes: with the functions gone the correction, note, and review
-- endpoints have nothing to call and will answer with the failure the missing
-- function raises. Nothing else in the module depends on them, and no read path does.
--
--   begin;
--     drop function if exists public.attendance_apply_correction(
--       text, uuid, uuid, date, text, jsonb, text, text);
--     drop function if exists public.attendance_mark_reviewed(uuid, date);
--   commit;
--
-- Step B — restore the pto_requests_update policy exactly as
-- v1.6.2-enforce-scoped-supervisor-access.sql left it. Only needed if decision 7 is
-- being reversed as well; the two changes are independent.
--
--   begin;
--     drop policy if exists "pto_requests_update" on public.pto_requests;
--     create policy "pto_requests_update" on public.pto_requests
--       for update to authenticated
--       using (profile_id = auth.uid() and status = 'pending')
--       with check (profile_id = auth.uid());
--   commit;
--
--   Reversing it re-refuses an employee's cancellation of a waitlisted request and
--   re-opens the self-approval hole described in decision 7. CANCEL_REFUSED_BY_POLICY
--   in server/pto-service.ts is the message that path answers with, and it remains
--   the honest answer while the narrower policy is in force.
--
-- The rows written by the two functions stay where they are. Corrections applied to
-- time_clock_entries and time_clock_breaks are ordinary attendance data by the time
-- the functions are dropped, each one carrying its own audit entry with the previous
-- value, so any individual correction can be reversed from its audit row by hand.
-- attendance_audit_log itself is append-only by construction (Requirement 16,
-- criterion 5) and its trigger refuses a delete even on a `security definer` path, so
-- no rollback step may attempt one.
--
-- Then confirm nothing was lost, from outside the database:
--
--   node --env-file=.env.local scripts/verify-attendance-row-retention.mjs --verify --label stage-5-pre
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- ROW RETENTION (Requirement 23, criterion 3)
-- ─────────────────────────────────────────────────────────────────────────────────
--   node --env-file=.env.local scripts/verify-attendance-row-retention.mjs --snapshot --label stage-5-pre
--   ... apply this file ...
--   node --env-file=.env.local scripts/verify-attendance-row-retention.mjs --verify --label stage-5-pre
--
-- `--strict` will report a gain on audit_log on the live project, because Quotes
-- activity writes that table continuously and a migration cannot pause it. A gain
-- there is ordinary application traffic; this migration issues no insert, update, or
-- delete against any preserved table, and the post-condition block below fails the
-- transaction if any of the eight lost a row while it ran. Read the two runs the way
-- the stage-3 and stage-4 runs were read: losses are the failure, gains on audit_log
-- are the application.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. PRE-CONDITIONS
--    Earlier stages present, the policy this stage replaces is the one v1.6.2 left,
--    and a fingerprint of the eight preserved tables for the post-condition block to
--    compare against.
-- ═══════════════════════════════════════════════════════════════════════════════
do $pre$
declare
  v_missing text;
  v_using   text;
  v_check   text;
  v_counts  jsonb;
begin
  -- Objects the two functions read or write. attendance_notes,
  -- attendance_day_reviews, and attendance_audit_log are v1.9.0's; the rest are
  -- v1.2.0's.
  select string_agg(e.name, ', ' order by e.name)
    into v_missing
    from (values ('public.profiles'),
                 ('public.time_clock_entries'),
                 ('public.time_clock_breaks'),
                 ('public.payroll_periods'),
                 ('public.pto_requests'),
                 ('public.attendance_notes'),
                 ('public.attendance_day_reviews'),
                 ('public.attendance_audit_log')) as e(name)
   where to_regclass(e.name) is null;

  if v_missing is not null then
    raise exception 'v1.9.4 requires these objects and they are absent: %', v_missing
      using detail = 'Stage 5 builds on v1.2.0-time-attendance.sql and v1.9.0-attendance-foundations.sql.',
            hint   = 'Apply the earlier migrations first. Nothing has been changed.';
  end if;

  -- attendance_day_reviews must carry the composite primary key, because
  -- `on conflict (profile_id, work_date) do nothing` is the whole of Requirement 12,
  -- criterion 16 and there is nothing to conflict on without it.
  if not exists (
    select 1
      from pg_constraint c
     where c.conrelid = 'public.attendance_day_reviews'::regclass
       and c.contype = 'p'
       and (select array_agg(a.attname::text order by a.attname)
              from unnest(c.conkey) as k(attnum)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
           = array['profile_id', 'work_date']
  ) then
    raise exception 'v1.9.4 found no (profile_id, work_date) primary key on attendance_day_reviews'
      using detail = 'attendance_mark_reviewed relies on it for idempotence (Requirement 12, criterion 16).',
            hint   = 'Reapply v1.9.0-attendance-foundations.sql. Nothing has been changed.';
  end if;

  -- The audit log must still refuse a rewrite. If a later change gave it an update or
  -- delete policy, the atomicity this stage relies on would be enforcing an integrity
  -- rule that no longer holds.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'attendance_audit_log'
       and cmd in ('UPDATE', 'DELETE')
  ) then
    raise exception 'v1.9.4 found a write policy on attendance_audit_log'
      using detail = 'Requirement 16, criterion 5 makes the log append-only.',
            hint   = 'Investigate before adding mutation paths that depend on it. Nothing has been changed.';
  end if;

  -- The policy decision 7 replaces. Absent means something removed it, and this
  -- migration widens a policy rather than restoring one.
  select pg_get_expr(pol.polqual, pol.polrelid),
         pg_get_expr(pol.polwithcheck, pol.polrelid)
    into v_using, v_check
    from pg_policy pol
   where pol.polrelid = 'public.pto_requests'::regclass
     and pol.polname  = 'pto_requests_update';

  if v_using is null then
    raise exception 'v1.9.4 found no pto_requests_update policy to widen'
      using detail = 'v1.6.2-enforce-scoped-supervisor-access.sql created it over status = pending.',
            hint   = 'Investigate why it is missing before widening it. Nothing has been changed.';
  end if;

  if strpos(v_using, 'waitlisted') > 0 then
    raise notice 'v1.9.4: pto_requests_update already names waitlisted; recreating it to the stage-5 definition.';
  elsif strpos(v_using, 'auth.uid()') = 0 or strpos(v_using, '''pending''') = 0 or strpos(v_using, 'role') > 0 then
    -- Not the shape v1.6.2 left. Something else has edited this policy, and
    -- overwriting an unknown rule with ours would discard whatever it was protecting.
    raise exception 'v1.9.4 found pto_requests_update in an unexpected shape: using %, with check %',
                    v_using, coalesce(v_check, 'null')
      using detail = 'v1.6.2 left `using (profile_id = auth.uid() and status = ''pending'')` with `with check (profile_id = auth.uid())`.',
            hint   = 'Reconcile the drift before widening. Nothing has been changed.';
  end if;

  raise notice 'v1.9.4: widening pto_requests_update from using % / with check %',
    v_using, coalesce(v_check, 'null');

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

  perform set_config('nhwd.v194_row_counts', v_counts::text, true);

  raise notice 'v1.9.4 pre-conditions met.';
end
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ATTENDANCE_APPLY_CORRECTION() — one transaction per correction
--
--    Order matters and is the order below:
--      a. resolve the caller and refuse anyone who does not administer attendance
--      b. resolve the field, refuse an unknown one, refuse a blank reason, refuse a
--         payload that is the wrong JSON shape
--      c. lock the row the correction changes
--      d. return the prior result if this idempotency key was already applied
--      e. validate the new value against the row as locked
--      f. apply the change, then insert the audit row as the last statement
--
--    Returns one jsonb envelope in every case. `ok` says whether the call was
--    honoured, `applied` whether anything moved, `code` names the outcome when it is
--    not a plain success. The raises in a through e carry SQLSTATEs that already
--    answer 403, 400, or 404, so a caller that forgets to read `ok` still cannot
--    report success.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.attendance_apply_correction(
  p_entity_type text,
  p_entity_id uuid,
  p_profile_id uuid,
  p_work_date date,
  p_field text,
  p_new_value jsonb,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '15s'
as $fn$
declare
  -- The caller.
  v_actor      uuid := auth.uid();
  v_actor_role text;

  -- Normalised payload.
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key    text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_value  jsonb := coalesce(p_new_value, 'null'::jsonb);

  -- What the field means.
  v_entity text;          -- audit entity_type this field targets
  v_action text;          -- audit action this field records
  v_needs_entity boolean; -- whether p_entity_id names an existing row

  -- The rows, as locked.
  v_entry public.time_clock_entries%rowtype;
  v_brk   public.time_clock_breaks%rowtype;
  v_open  uuid;

  -- Values.
  v_instant    timestamptz;
  v_minutes    integer;
  v_note       text;
  v_final_in   timestamptz;
  v_final_out  timestamptz;
  v_final_brk  integer;
  v_hours_old  numeric(6,2);
  v_hours_new  numeric(6,2);
  v_old_value  jsonb := 'null'::jsonb;
  v_new_value  jsonb;
  v_entity_id  uuid := p_entity_id;

  -- Context.
  v_period        uuid;
  v_period_status text;

  -- Applied.
  v_prior      public.attendance_audit_log%rowtype;
  v_audit_id   uuid;
  v_applied_at timestamptz;
  v_stage      text := 'change';
begin
  -- ── a. The caller administers attendance, or nothing happens ────────────────
  if v_actor is null then
    raise exception 'NOT_AUTHENTICATED: attendance_apply_correction requires a signed-in caller.'
      using errcode = '42501',
            detail  = 'auth.uid() resolved to null, so the request carried no user session.',
            hint    = 'Call through a user-scoped Supabase client. Nothing has been changed.';
  end if;

  select p.role::text into v_actor_role from public.profiles p where p.id = v_actor;

  if v_actor_role is distinct from 'super_admin' then
    raise exception 'NOT_AUTHORISED: only super_admin may correct attendance.'
      using errcode = '42501',
            detail  = format('Caller %s holds role %s.', v_actor, coalesce(v_actor_role, 'none')),
            hint    = 'Requirement 21, criteria 4 and 12 withhold clock-entry correction from manager. Nothing has been changed.';
  end if;

  -- ── b. The field, the reason, and the payload shape ─────────────────────────
  if p_profile_id is null or p_work_date is null then
    raise exception 'SUBJECT_REQUIRED: a correction names the employee and the work date it applies to.'
      using errcode = '22023',
            detail  = 'attendance_audit_log carries both (Requirement 16, criterion 2).',
            hint    = 'Nothing has been changed.';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then
    raise exception 'PROFILE_NOT_FOUND: no profile with id %.', p_profile_id
      using errcode = 'P0002', hint = 'Nothing has been changed.';
  end if;

  if v_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED: a correction must carry a non-blank idempotency key.'
      using errcode = '22023',
            detail  = 'It is what makes a resubmitted correction apply once (task 14.2).',
            hint    = 'Nothing has been changed.';
  end if;

  case p_field
    when 'clock_in', 'clock_out', 'break_minutes' then
      v_entity := 'clock_entry'; v_action := 'correct_punch'; v_needs_entity := true;
    when 'session' then
      v_entity := 'clock_entry'; v_action := 'add_punch';     v_needs_entity := false;
    when 'break_start', 'break_end', 'duration_minutes' then
      v_entity := 'break';       v_action := 'correct_punch'; v_needs_entity := true;
    when 'note' then
      v_entity := 'note';        v_action := 'add_note';      v_needs_entity := false;
    when 'unscheduled_work' then
      v_entity := 'clock_entry'; v_action := 'approve_unscheduled'; v_needs_entity := false;
    else
      raise exception 'UNKNOWN_FIELD: "%" is not a correctable field.', coalesce(p_field, 'null')
        using errcode = '22023',
              detail  = 'clock_in, clock_out, break_minutes, session, break_start, break_end, duration_minutes, note, unscheduled_work.',
              hint    = 'Nothing has been changed.';
  end case;

  -- p_entity_type is the caller's assertion, not the source of the target.
  if p_entity_type is not null and p_entity_type <> v_entity then
    raise exception 'ENTITY_TYPE_MISMATCH: field "%" corrects a %, not a %.', p_field, v_entity, p_entity_type
      using errcode = '22023', hint = 'Nothing has been changed.';
  end if;

  -- Requirements 5.16, 12.13, 21.9. A note carries its own text as the reason, so it
  -- is the one field a caller may leave blank.
  if v_reason is null and p_field <> 'note' then
    raise exception 'REASON_REQUIRED: a correction carries a reason of at least one non-whitespace character.'
      using errcode = '22023',
            hint    = 'Requirements 5.16, 12.13, and 21.9. Nothing has been changed.';
  end if;

  if v_needs_entity and p_entity_id is null then
    raise exception 'ENTITY_ID_REQUIRED: correcting % names the row it changes.', p_field
      using errcode = '22023', hint = 'Nothing has been changed.';
  end if;

  if p_field in ('session', 'note') and p_entity_id is not null then
    raise exception 'UNEXPECTED_ENTITY_ID: "%" creates a row, so it names none.', p_field
      using errcode = '22023', hint = 'Nothing has been changed.';
  end if;

  -- ── c. Lock the row the correction changes ──────────────────────────────────
  if v_entity = 'break' then
    -- Parent entry first, then the break, so no two callers can take the two locks
    -- in opposite orders. The unlocked read is only to learn which entry to lock.
    select * into v_brk from public.time_clock_breaks where id = p_entity_id;

    if not found then
      raise exception 'BREAK_NOT_FOUND: no break entry with id %.', p_entity_id
        using errcode = 'P0002', hint = 'Nothing has been changed.';
    end if;

    select * into v_entry from public.time_clock_entries
     where id = v_brk.clock_entry_id for update;

    if not found then
      raise exception 'CLOCK_ENTRY_NOT_FOUND: break % names clock entry %, which does not exist.',
                      p_entity_id, v_brk.clock_entry_id
        using errcode = 'P0002', hint = 'Nothing has been changed.';
    end if;

    select * into v_brk from public.time_clock_breaks where id = p_entity_id for update;

    if not found then
      raise exception 'BREAK_NOT_FOUND: break % disappeared while it was being locked.', p_entity_id
        using errcode = 'P0002', hint = 'Nothing has been changed.';
    end if;

  elsif p_field in ('clock_in', 'clock_out', 'break_minutes') then
    select * into v_entry from public.time_clock_entries where id = p_entity_id for update;

    if not found then
      raise exception 'CLOCK_ENTRY_NOT_FOUND: no clock entry with id %.', p_entity_id
        using errcode = 'P0002', hint = 'Nothing has been changed.';
    end if;

  elsif p_field = 'session' then
    -- The row that decides whether this insert may proceed: an open entry for the
    -- same employee is what uniq_time_clock_open_entry refuses a second of.
    select id into v_open from public.time_clock_entries
     where profile_id = p_profile_id and clock_out is null
     for update;

  elsif p_field = 'unscheduled_work' and p_entity_id is not null then
    select * into v_entry from public.time_clock_entries where id = p_entity_id for update;

    if not found then
      raise exception 'CLOCK_ENTRY_NOT_FOUND: no clock entry with id %.', p_entity_id
        using errcode = 'P0002', hint = 'Nothing has been changed.';
    end if;
  end if;

  -- The locked row must belong to the employee the correction names, or the audit
  -- entry would attribute one employee's change to another.
  if v_entry.id is not null and v_entry.profile_id <> p_profile_id then
    raise exception 'PROFILE_MISMATCH: clock entry % belongs to %, not to %.',
                    v_entry.id, v_entry.profile_id, p_profile_id
      using errcode = '22023', hint = 'Nothing has been changed.';
  end if;

  -- ── d. This key was already applied: the prior result, and nothing moves ────
  -- Read through idx_attendance_audit_profile_date, so this is one employee-date.
  select * into v_prior
    from public.attendance_audit_log a
   where a.profile_id = p_profile_id
     and a.work_date  = p_work_date
     and a.new_value ->> 'idempotency_key' = v_key
   order by a.created_at, a.id
   limit 1;

  if found then
    select pp.id, pp.status into v_period, v_period_status
      from public.payroll_periods pp
     where p_work_date between pp.period_start and pp.period_end
     order by (pp.status in ('processed', 'paid')) desc, pp.period_start desc
     limit 1;

    -- A replay applies nothing and is recorded anyway (decision 3). This insert is
    -- the only statement, so its failure rolls back the whole call and returns
    -- nothing but the reason — Requirement 16, criterion 6 with no change to undo.
    begin
      insert into public.attendance_audit_log (
        profile_id, work_date, entity_type, entity_id, action, field,
        old_value, new_value, actor_profile_id, reason, payroll_period_id
      ) values (
        p_profile_id, p_work_date, v_prior.entity_type, v_prior.entity_id,
        v_prior.action, v_prior.field,
        v_prior.new_value,
        jsonb_build_object(
          'idempotency_key', v_key,
          'applied', false,
          'replay_of', v_prior.id,
          'replayed_at', now()
        ),
        v_actor,
        coalesce(v_reason, v_prior.reason),
        v_period
      )
      returning id, created_at into v_audit_id, v_applied_at;
    exception
      when others then
        return jsonb_build_object(
          'ok', false, 'applied', false, 'code', 'audit_write_failed',
          'error', sqlerrm, 'sqlstate', sqlstate,
          'profile_id', p_profile_id, 'work_date', p_work_date, 'field', p_field);
    end;

    return jsonb_build_object(
      'ok', true,
      'applied', false,
      'code', 'already_applied',
      'profile_id', p_profile_id,
      'work_date', p_work_date,
      'entity_type', v_prior.entity_type,
      'entity_id', v_prior.entity_id,
      'field', v_prior.field,
      'action', v_prior.action,
      'old_value', v_prior.old_value,
      'new_value', v_prior.new_value,
      'reason', v_prior.reason,
      'idempotency_key', v_key,
      'actor_profile_id', v_prior.actor_profile_id,
      'applied_at', v_prior.created_at,
      'payroll_period_id', v_prior.payroll_period_id,
      'payroll_period_status', v_period_status,
      'audit_id', v_prior.id,
      'replay_audit_id', v_audit_id,
      'replayed_at', v_applied_at
    );
  end if;

  -- ── e. The new value, against the row as locked ─────────────────────────────
  -- Every instant and every integer is read here, once, so a cast failure is an
  -- invalid payload rather than an error surfacing from the middle of the apply.
  if p_field in ('clock_in', 'clock_out', 'break_start', 'break_end') then
    if jsonb_typeof(v_value) <> 'string' then
      raise exception 'INVALID_VALUE: % is an instant, supplied as a JSON string.', p_field
        using errcode = '22023',
              detail  = format('Received %s.', jsonb_typeof(v_value)),
              hint    = 'Nothing has been changed.';
    end if;
    begin
      v_instant := (v_value #>> '{}')::timestamptz;
    exception
      when others then
        raise exception 'INVALID_VALUE: "%" is not an instant (%).', v_value #>> '{}', sqlerrm
          using errcode = '22023', hint = 'Nothing has been changed.';
    end;
  end if;

  if p_field in ('break_minutes', 'duration_minutes') then
    if jsonb_typeof(v_value) <> 'number' then
      raise exception 'INVALID_VALUE: % is a whole number of minutes.', p_field
        using errcode = '22023',
              detail  = format('Received %s.', jsonb_typeof(v_value)),
              hint    = 'Nothing has been changed.';
    end if;
    v_minutes := round((v_value #>> '{}')::numeric)::integer;
    if v_minutes < 0 or v_minutes > 1440 then
      raise exception 'INVALID_VALUE: % must be between 0 and 1440 minutes, not %.', p_field, v_minutes
        using errcode = '22023',
              detail  = 'A break longer than a day is a data fault, not a correction.',
              hint    = 'Nothing has been changed.';
    end if;
  end if;

  -- The covering payroll period, for the audit entry (Requirement 16, criterion 2).
  -- Read, never written: a correction inside a processed or paid period is permitted
  -- and recomputes no stored summary.
  select pp.id, pp.status into v_period, v_period_status
    from public.payroll_periods pp
   where p_work_date between pp.period_start and pp.period_end
   order by (pp.status in ('processed', 'paid')) desc, pp.period_start desc
   limit 1;

  -- Every refusal below happens before the apply block opens, so a rejected
  -- correction never reaches a write and its SQLSTATE reaches the caller instead of
  -- being absorbed by the block's own handler.
  if p_field = 'clock_in' then
    if v_entry.clock_out is not null and v_instant > v_entry.clock_out then
      raise exception 'NEGATIVE_DURATION: a clock-in of % is later than the clock-out at %.',
                      v_instant, v_entry.clock_out
        using errcode = '22023', hint = 'Correct the clock-out first. Nothing has been changed.';
    end if;

    v_final_in  := v_instant;
    v_final_out := v_entry.clock_out;
    v_final_brk := coalesce(v_entry.break_minutes, 0);
    v_hours_old := v_entry.total_hours;
    v_hours_new := case
                     when v_final_out is null then v_entry.total_hours
                     else round((((extract(epoch from (v_final_out - v_final_in)) / 60.0)
                                  - v_final_brk) / 60.0)::numeric, 2)
                   end;

    v_old_value := jsonb_build_object('clock_in', v_entry.clock_in, 'total_hours', v_hours_old);
    v_new_value := jsonb_build_object('clock_in', v_final_in,       'total_hours', v_hours_new);

  elsif p_field = 'clock_out' then
    if v_instant < v_entry.clock_in then
      raise exception 'NEGATIVE_DURATION: a clock-out of % is earlier than the clock-in at %.',
                      v_instant, v_entry.clock_in
        using errcode = '22023', hint = 'Nothing has been changed.';
    end if;

    if exists (
      select 1 from public.time_clock_breaks b
       where b.clock_entry_id = v_entry.id and b.break_end > v_instant
    ) then
      raise exception 'BREAK_OUTSIDE_SESSION: a break on this entry ends after the clock-out at %.', v_instant
        using errcode = '22023',
              detail  = 'Correct the break first, or move the clock-out past it.',
              hint    = 'Nothing has been changed.';
    end if;

    -- An entry that had no clock-out is being given one: that is Add Missing Punch
    -- rather than a correction, and the audit action says so (Requirement 5,
    -- criterion 15).
    if v_entry.clock_out is null then v_action := 'add_punch'; end if;

    v_final_in  := v_entry.clock_in;
    v_final_out := v_instant;
    v_final_brk := coalesce(v_entry.break_minutes, 0);
    v_hours_old := v_entry.total_hours;
    v_hours_new := round((((extract(epoch from (v_final_out - v_final_in)) / 60.0)
                           - v_final_brk) / 60.0)::numeric, 2);

    v_old_value := jsonb_build_object('clock_out', v_entry.clock_out, 'total_hours', v_hours_old);
    v_new_value := jsonb_build_object('clock_out', v_final_out,       'total_hours', v_hours_new);

  elsif p_field = 'break_minutes' then
    v_final_in  := v_entry.clock_in;
    v_final_out := v_entry.clock_out;
    v_final_brk := v_minutes;
    v_hours_old := v_entry.total_hours;
    v_hours_new := case
                     when v_final_out is null then v_entry.total_hours
                     else round((((extract(epoch from (v_final_out - v_final_in)) / 60.0)
                                  - v_final_brk) / 60.0)::numeric, 2)
                   end;

    v_old_value := jsonb_build_object('break_minutes', v_entry.break_minutes, 'total_hours', v_hours_old);
    v_new_value := jsonb_build_object('break_minutes', v_final_brk,           'total_hours', v_hours_new);

  elsif p_field = 'session' then
    if jsonb_typeof(v_value) <> 'object' or v_value ->> 'clock_in' is null then
      raise exception 'INVALID_VALUE: adding a session carries {"clock_in": instant, "clock_out": instant or null, "break_minutes": integer}.'
        using errcode = '22023', hint = 'Nothing has been changed.';
    end if;

    begin
      v_final_in  := (v_value ->> 'clock_in')::timestamptz;
      v_final_out := case when v_value ->> 'clock_out' is null then null
                          else (v_value ->> 'clock_out')::timestamptz end;
      v_final_brk := coalesce(round((v_value ->> 'break_minutes')::numeric)::integer, 0);
    exception
      when others then
        raise exception 'INVALID_VALUE: a session field is not the type it must be (%).', sqlerrm
          using errcode = '22023',
                detail  = 'clock_in and clock_out are instants; break_minutes is a whole number.',
                hint    = 'Nothing has been changed.';
    end;

    if v_final_brk < 0 or v_final_brk > 1440 then
      raise exception 'INVALID_VALUE: break_minutes must be between 0 and 1440, not %.', v_final_brk
        using errcode = '22023', hint = 'Nothing has been changed.';
    end if;

    if v_final_out is not null and v_final_out < v_final_in then
      raise exception 'NEGATIVE_DURATION: the clock-out at % is earlier than the clock-in at %.',
                      v_final_out, v_final_in
        using errcode = '22023', hint = 'Nothing has been changed.';
    end if;

    if v_final_out is null and v_open is not null then
      raise exception 'ALREADY_OPEN_ENTRY: employee % already has an open clock entry (%).', p_profile_id, v_open
        using errcode = '23505',
              detail  = 'uniq_time_clock_open_entry permits one open entry per employee (Requirement 4, criterion 21).',
              hint    = 'Close it, or add the session with a clock-out. Nothing has been changed.';
    end if;

    v_hours_new := case
                     when v_final_out is null then null
                     else round((((extract(epoch from (v_final_out - v_final_in)) / 60.0)
                                  - v_final_brk) / 60.0)::numeric, 2)
                   end;

    v_old_value := 'null'::jsonb;
    v_new_value := jsonb_build_object(
      'session', jsonb_build_object(
        'clock_in', v_final_in, 'clock_out', v_final_out,
        'break_minutes', v_final_brk, 'total_hours', v_hours_new));

  elsif p_field = 'break_start' then
    if v_instant < v_entry.clock_in then
      raise exception 'BREAK_OUTSIDE_SESSION: a break start of % is earlier than the clock-in at %.',
                      v_instant, v_entry.clock_in
        using errcode = '22023', hint = 'Nothing has been changed.';
    end if;
    if v_brk.break_end is not null and v_instant > v_brk.break_end then
      raise exception 'NEGATIVE_DURATION: a break start of % is later than its end at %.',
                      v_instant, v_brk.break_end
        using errcode = '22023', hint = 'Nothing has been changed.';
    end if;

    -- The derivation prefers duration_minutes over the bounds, so a corrected bound
    -- with a stale duration would leave the stale figure winning. Recomputed with the
    -- same arithmetic /api/time-clock/breaks uses when it ends a break.
    v_minutes := case when v_brk.break_end is null then null
                      else round(extract(epoch from (v_brk.break_end - v_instant)) / 60.0)::integer end;

    v_old_value := jsonb_build_object('break_start', v_brk.break_start, 'duration_minutes', v_brk.duration_minutes);
    v_new_value := jsonb_build_object('break_start', v_instant,         'duration_minutes', v_minutes);

  elsif p_field = 'break_end' then
    if v_instant < v_brk.break_start then
      raise exception 'NEGATIVE_DURATION: a break end of % is earlier than its start at %.',
                      v_instant, v_brk.break_start
        using errcode = '22023', hint = 'Nothing has been changed.';
    end if;
    if v_entry.clock_out is not null and v_instant > v_entry.clock_out then
      raise exception 'BREAK_OUTSIDE_SESSION: a break end of % is later than the clock-out at %.',
                      v_instant, v_entry.clock_out
        using errcode = '22023', hint = 'Nothing has been changed.';
    end if;

    v_minutes := round(extract(epoch from (v_instant - v_brk.break_start)) / 60.0)::integer;

    v_old_value := jsonb_build_object('break_end', v_brk.break_end, 'duration_minutes', v_brk.duration_minutes);
    v_new_value := jsonb_build_object('break_end', v_instant,       'duration_minutes', v_minutes);

  elsif p_field = 'duration_minutes' then
    -- The break-minutes control of Requirement 12, criterion 12, as the derivation
    -- reads it. The bounds are left where they are: the administrator is asserting how
    -- many minutes the break cost, not when it happened.
    v_old_value := jsonb_build_object('duration_minutes', v_brk.duration_minutes);
    v_new_value := jsonb_build_object('duration_minutes', v_minutes);

  elsif p_field = 'note' then
    if jsonb_typeof(v_value) <> 'string' then
      raise exception 'INVALID_VALUE: a manager note is a JSON string.'
        using errcode = '22023',
              detail  = format('Received %s.', jsonb_typeof(v_value)),
              hint    = 'Nothing has been changed.';
    end if;

    v_note := nullif(btrim(v_value #>> '{}'), '');

    if v_note is null then
      raise exception 'NOTE_REQUIRED: a manager note carries at least one non-whitespace character.'
        using errcode = '22023',
              detail  = 'attendance_notes.note enforces the same rule (v1.9.0).',
              hint    = 'Nothing has been changed.';
    end if;

    -- The note is its own stated reason when the caller supplied none (decision 1).
    v_reason := coalesce(v_reason, v_note);

    v_old_value := 'null'::jsonb;
    v_new_value := jsonb_build_object('note', v_note);

  elsif p_field = 'unscheduled_work' then
    if v_value <> 'true'::jsonb then
      raise exception 'INVALID_VALUE: unscheduled_work accepts true, which approves the work.'
        using errcode = '22023',
              detail  = 'There is no un-approve path in this stage.',
              hint    = 'Nothing has been changed.';
    end if;

    -- Audit-only. The approval is the audit row: attendance-service reads
    -- attendance_audit_log for action = 'approve_unscheduled' over the employee and
    -- work date, which is what clears the payroll-blocking exception of Requirement
    -- 12, criterion 8.
    v_old_value := jsonb_build_object('unscheduled_work_approved', false);
    v_new_value := jsonb_build_object('unscheduled_work_approved', true);
  end if;

  -- ── f. Apply, then audit. A failure below leaves nothing changed ────────────
  -- Nothing in this block validates. Every refusal happened above it, so the only
  -- exceptions reachable here are write failures, which is what its handler reports.
  begin
    v_stage := 'change';

    if p_field = 'clock_in' then
      update public.time_clock_entries e
         set clock_in          = v_final_in,
             total_hours       = v_hours_new,
             adjusted_by       = v_actor,
             adjustment_reason = v_reason
       where e.id = v_entry.id;

    elsif p_field = 'clock_out' then
      update public.time_clock_entries e
         set clock_out         = v_final_out,
             total_hours       = v_hours_new,
             adjusted_by       = v_actor,
             adjustment_reason = v_reason
       where e.id = v_entry.id;

    elsif p_field = 'break_minutes' then
      update public.time_clock_entries e
         set break_minutes     = v_final_brk,
             total_hours       = v_hours_new,
             adjusted_by       = v_actor,
             adjustment_reason = v_reason
       where e.id = v_entry.id;

    elsif p_field = 'session' then
      insert into public.time_clock_entries (
        profile_id, clock_in, clock_out, break_minutes, total_hours,
        adjusted_by, adjustment_reason
      ) values (
        p_profile_id, v_final_in, v_final_out, v_final_brk, v_hours_new,
        v_actor, v_reason
      )
      returning id into v_entity_id;

      v_new_value := v_new_value || jsonb_build_object('clock_entry_id', v_entity_id);

    elsif p_field = 'break_start' then
      update public.time_clock_breaks b
         set break_start      = v_instant,
             duration_minutes = v_minutes
       where b.id = v_brk.id;

    elsif p_field = 'break_end' then
      update public.time_clock_breaks b
         set break_end        = v_instant,
             duration_minutes = v_minutes
       where b.id = v_brk.id;

    elsif p_field = 'duration_minutes' then
      update public.time_clock_breaks b
         set duration_minutes = v_minutes
       where b.id = v_brk.id;

    elsif p_field = 'note' then
      insert into public.attendance_notes (profile_id, work_date, note, author_profile_id)
      values (p_profile_id, p_work_date, v_note, v_actor)
      returning id into v_entity_id;

      v_new_value := v_new_value || jsonb_build_object('note_id', v_entity_id);

    end if;
    -- unscheduled_work has no row to write. Its audit entry below is the approval.

    v_new_value := v_new_value || jsonb_build_object('idempotency_key', v_key, 'applied', true);

    -- The audit row, last. Requirements 5.17 and 16.2: employee, work date, field,
    -- previous value, new value, action, actor, reason, timestamp, and the payroll
    -- period covering the work date. Its failure aborts this block, which rolls back
    -- every write above it (Requirement 16, criterion 6).
    v_stage := 'audit';

    insert into public.attendance_audit_log (
      profile_id, work_date, entity_type, entity_id, action, field,
      old_value, new_value, actor_profile_id, reason, payroll_period_id
    ) values (
      p_profile_id, p_work_date, v_entity, v_entity_id, v_action, p_field,
      v_old_value, v_new_value, v_actor, v_reason, v_period
    )
    returning id, created_at into v_audit_id, v_applied_at;

  exception
    when others then
      -- The block is a subtransaction, so every write above is already undone: the
      -- source row is exactly as it was. Return the reason rather than raising, so
      -- the route can answer with it (Requirement 16, criterion 6).
      return jsonb_build_object(
        'ok', false,
        'applied', false,
        'code', case when v_stage = 'audit' then 'audit_write_failed' else 'change_write_failed' end,
        'failed_statement', v_stage,
        'error', sqlerrm,
        'sqlstate', sqlstate,
        'profile_id', p_profile_id,
        'work_date', p_work_date,
        'entity_type', v_entity,
        'entity_id', p_entity_id,
        'field', p_field,
        'action', v_action,
        'attempted_value', v_value);
  end;

  return jsonb_build_object(
    'ok', true,
    'applied', true,
    'code', null,
    'profile_id', p_profile_id,
    'work_date', p_work_date,
    'entity_type', v_entity,
    'entity_id', v_entity_id,
    'field', p_field,
    'action', v_action,
    'old_value', v_old_value,
    'new_value', v_new_value,
    'reason', v_reason,
    'idempotency_key', v_key,
    'actor_profile_id', v_actor,
    'applied_at', v_applied_at,
    'payroll_period_id', v_period,
    'payroll_period_status', v_period_status,
    'audit_id', v_audit_id
  );
end
$fn$;

comment on function public.attendance_apply_correction(text, uuid, uuid, date, text, jsonb, text, text) is
  'Commits one attendance correction as a single transaction: asserts the caller administers attendance, locks the row it changes, refuses a blank reason, applies the change, and inserts the attendance_audit_log row as the last statement so a failed audit write leaves the change uncommitted. Fields: clock_in, clock_out, break_minutes, session, break_start, break_end, duration_minutes, note, unscheduled_work. Requirements 5.15 through 5.18, 12.12, 12.13, 16.1, 16.2, 16.6, 21.4, 21.9.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. ATTENDANCE_MARK_REVIEWED() — first reviewer wins
--
--    Requirement 12, criterion 15 records the actor and timestamp in the audit log.
--    Criterion 16 retains the first review's actor and timestamp when the same row is
--    marked reviewed more than once, and the composite primary key on
--    attendance_day_reviews is what enforces it: `on conflict do nothing` writes
--    nothing the second time, so there is nothing to overwrite.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.attendance_mark_reviewed(
  p_profile_id uuid,
  p_work_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '15s'
as $fn$
declare
  v_actor      uuid := auth.uid();
  v_actor_role text;

  v_existing public.attendance_day_reviews%rowtype;
  v_inserted public.attendance_day_reviews%rowtype;

  v_period        uuid;
  v_period_status text;
  v_audit_id      uuid;
begin
  -- ── a. The caller administers attendance, or nothing happens ────────────────
  if v_actor is null then
    raise exception 'NOT_AUTHENTICATED: attendance_mark_reviewed requires a signed-in caller.'
      using errcode = '42501',
            detail  = 'auth.uid() resolved to null, so the request carried no user session.',
            hint    = 'Call through a user-scoped Supabase client. Nothing has been changed.';
  end if;

  select p.role::text into v_actor_role from public.profiles p where p.id = v_actor;

  if v_actor_role is distinct from 'super_admin' then
    raise exception 'NOT_AUTHORISED: only super_admin may mark an attendance day reviewed.'
      using errcode = '42501',
            detail  = format('Caller %s holds role %s.', v_actor, coalesce(v_actor_role, 'none')),
            hint    = 'Requirement 21, criterion 8 also refuses an employee resolving an exception recorded against them. Nothing has been changed.';
  end if;

  if p_profile_id is null or p_work_date is null then
    raise exception 'SUBJECT_REQUIRED: marking a day reviewed names the employee and the work date.'
      using errcode = '22023', hint = 'Nothing has been changed.';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then
    raise exception 'PROFILE_NOT_FOUND: no profile with id %.', p_profile_id
      using errcode = 'P0002', hint = 'Nothing has been changed.';
  end if;

  -- ── b. Lock the review row when there is one ────────────────────────────────
  select * into v_existing
    from public.attendance_day_reviews r
   where r.profile_id = p_profile_id and r.work_date = p_work_date
   for update;

  if found then
    -- Requirement 12, criterion 16. Nothing moves and nothing is audited: a repeat is
    -- not a review status change (Requirement 16, criterion 1).
    return jsonb_build_object(
      'ok', true,
      'applied', false,
      'code', 'already_reviewed',
      'profile_id', v_existing.profile_id,
      'work_date', v_existing.work_date,
      'review_status', 'reviewed',
      'reviewed_by', v_existing.reviewed_by,
      'reviewed_at', v_existing.reviewed_at,
      'retained_reviewer', v_existing.reviewed_by,
      'audit_id', null
    );
  end if;

  select pp.id, pp.status into v_period, v_period_status
    from public.payroll_periods pp
   where p_work_date between pp.period_start and pp.period_end
   order by (pp.status in ('processed', 'paid')) desc, pp.period_start desc
   limit 1;

  -- ── c. Apply, then audit. A failure below leaves nothing changed ────────────
  begin
    insert into public.attendance_day_reviews (profile_id, work_date, reviewed_by)
    values (p_profile_id, p_work_date, v_actor)
    on conflict (profile_id, work_date) do nothing
    returning * into v_inserted;

    if v_inserted.profile_id is null then
      -- A concurrent call committed between the locking read and this insert. The
      -- conflict clause waited for it, so the committed row is readable now, and its
      -- reviewer is the one that stands.
      select * into v_existing
        from public.attendance_day_reviews r
       where r.profile_id = p_profile_id and r.work_date = p_work_date;

      return jsonb_build_object(
        'ok', true,
        'applied', false,
        'code', 'already_reviewed',
        'profile_id', p_profile_id,
        'work_date', p_work_date,
        'review_status', 'reviewed',
        'reviewed_by', v_existing.reviewed_by,
        'reviewed_at', v_existing.reviewed_at,
        'retained_reviewer', v_existing.reviewed_by,
        'audit_id', null
      );
    end if;

    -- The audit row, last (Requirement 12, criterion 15).
    insert into public.attendance_audit_log (
      profile_id, work_date, entity_type, entity_id, action, field,
      old_value, new_value, actor_profile_id, reason, payroll_period_id
    ) values (
      p_profile_id, p_work_date, 'review', null, 'mark_reviewed', 'review_status',
      jsonb_build_object('review_status', 'unreviewed'),
      jsonb_build_object(
        'review_status', 'reviewed',
        'reviewed_by', v_inserted.reviewed_by,
        'reviewed_at', v_inserted.reviewed_at),
      v_actor, null, v_period
    )
    returning id into v_audit_id;

  exception
    when others then
      -- The subtransaction is already rolled back, so the day is unreviewed again.
      return jsonb_build_object(
        'ok', false, 'applied', false, 'code', 'audit_write_failed',
        'error', sqlerrm, 'sqlstate', sqlstate,
        'profile_id', p_profile_id, 'work_date', p_work_date,
        'review_status', 'unreviewed');
  end;

  return jsonb_build_object(
    'ok', true,
    'applied', true,
    'code', null,
    'profile_id', v_inserted.profile_id,
    'work_date', v_inserted.work_date,
    'review_status', 'reviewed',
    'reviewed_by', v_inserted.reviewed_by,
    'reviewed_at', v_inserted.reviewed_at,
    'retained_reviewer', v_inserted.reviewed_by,
    'payroll_period_id', v_period,
    'payroll_period_status', v_period_status,
    'audit_id', v_audit_id
  );
end
$fn$;

comment on function public.attendance_mark_reviewed(uuid, date) is
  'Marks one employee-date reviewed as a single transaction: asserts the caller administers attendance, locks the review row, inserts with on conflict (profile_id, work_date) do nothing so the first reviewer and timestamp are retained, and inserts the attendance_audit_log row as the last statement. Requirements 12.15, 12.16, 16.2, 16.6.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. FUNCTION PRIVILEGES
--    Execute is granted to PUBLIC by default, which on a `security definer` function
--    is wider than intended. Signed-in callers may call them; each refuses anyone who
--    is not a super_admin, so the grant is a door and the guard is the lock.
-- ═══════════════════════════════════════════════════════════════════════════════
revoke all on function public.attendance_apply_correction(text, uuid, uuid, date, text, jsonb, text, text) from public;
revoke all on function public.attendance_apply_correction(text, uuid, uuid, date, text, jsonb, text, text) from anon;
grant execute on function public.attendance_apply_correction(text, uuid, uuid, date, text, jsonb, text, text) to authenticated;

revoke all on function public.attendance_mark_reviewed(uuid, date) from public;
revoke all on function public.attendance_mark_reviewed(uuid, date) from anon;
grant execute on function public.attendance_mark_reviewed(uuid, date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. PTO_REQUESTS_UPDATE — the cancellation a waitlisted request was refused
--    (decision 7). Requirement 11, criteria 8 and 9 offer and accept the
--    cancellation; Requirement 21, criteria 7 and 10 keep an employee from approving
--    their own request in row level security as well as at the API layer.
--
--    Dropped and recreated because a policy has no `alter ... using` form. Both
--    statements are in this transaction, so no window exists in which pto_requests
--    carries no update policy for its owners.
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "pto_requests_update" on public.pto_requests;
create policy "pto_requests_update" on public.pto_requests
  for update to authenticated
  using (
    profile_id = auth.uid()
    and status in ('pending', 'waitlisted')
  )
  with check (
    profile_id = auth.uid()
    and status in ('pending', 'waitlisted', 'cancelled')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing text;
  v_before  jsonb := coalesce(current_setting('nhwd.v194_row_counts', true), '{}')::jsonb;
  v_lost    text;
  v_using   text;
  v_check   text;
  v_secdef  integer;
begin
  -- Both functions exist, return jsonb, and are security definer. Without
  -- security definer the role assertion inside each would be guarding a path row
  -- level security was already refusing for a different reason.
  select string_agg(e.name, ', ' order by e.name)
    into v_missing
    from (values ('attendance_apply_correction'), ('attendance_mark_reviewed')) as e(name)
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = e.name
        and pg_get_function_result(p.oid) = 'jsonb');

  if v_missing is not null then
    raise exception 'v1.9.4 did not create: %', v_missing using hint = 'Rolling back.';
  end if;

  select count(*) into v_secdef
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('attendance_apply_correction', 'attendance_mark_reviewed')
     and p.prosecdef;

  if v_secdef <> 2 then
    raise exception 'v1.9.4 created % of 2 mutation functions with security definer', v_secdef
      using hint = 'Rolling back.';
  end if;

  -- The widened policy, and the tightened check beside it.
  select pg_get_expr(pol.polqual, pol.polrelid),
         pg_get_expr(pol.polwithcheck, pol.polrelid)
    into v_using, v_check
    from pg_policy pol
   where pol.polrelid = 'public.pto_requests'::regclass
     and pol.polname  = 'pto_requests_update';

  if v_using is null or strpos(v_using, 'waitlisted') = 0 then
    raise exception 'v1.9.4 left pto_requests_update without waitlisted: %', coalesce(v_using, 'absent')
      using detail = 'Requirement 11, criteria 8 and 9.', hint = 'Rolling back.';
  end if;

  if v_check is null or strpos(v_check, 'cancelled') = 0 then
    raise exception 'v1.9.4 left pto_requests_update with check unable to record a cancellation: %',
                    coalesce(v_check, 'absent')
      using detail = 'Requirement 11, criterion 9 stores status cancelled on the employee''s own write.',
            hint   = 'Rolling back.';
  end if;

  if strpos(v_check, 'approved') > 0 then
    raise exception 'v1.9.4 left pto_requests_update with check permitting a self-approval: %', v_check
      using detail = 'Requirement 21, criteria 7 and 10.', hint = 'Rolling back.';
  end if;

  -- The audit log is still append-only.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'attendance_audit_log'
       and cmd in ('UPDATE', 'DELETE')
  ) then
    raise exception 'v1.9.4 left a write policy on attendance_audit_log'
      using detail = 'Requirement 16, criterion 5.', hint = 'Rolling back.';
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
    raise exception 'v1.9.4 lost rows in: %', v_lost
      using detail = 'Requirement 23, criterion 3 retains every existing row in the eight preserved tables.',
            hint   = 'Rolling back.';
  end if;

  raise notice 'v1.9.4: 2 mutation functions added, pto_requests_update widened, % preserved tables intact',
    (select count(*) from jsonb_each(v_before));
end
$post$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
--    Structure only. Behaviour is probed inside rolled-back transactions by the
--    companion script:
--
--      supabase/verification/v1.9.4-attendance-mutation-probe.sql
--        each function refuses an unauthenticated caller, an employee, and a manager;
--        a blank reason is refused and nothing moves; a corrected clock-out moves
--        total_hours by the inherited arithmetic; a replayed correction applies
--        nothing and records a second audit row pointing at the first; a failed audit
--        insert leaves the source row unchanged; marking a day reviewed twice retains
--        the first reviewer and writes one audit row; and an employee may cancel a
--        waitlisted request but may not approve their own
-- ═══════════════════════════════════════════════════════════════════════════════
select
  -- The two functions, security definer, returning jsonb.
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('attendance_apply_correction', 'attendance_mark_reviewed')
      and p.prosecdef and pg_get_function_result(p.oid) = 'jsonb')  as mutation_functions_expect_2,

  -- Both carry `set search_path = public`, so a definer function cannot be steered
  -- at an attacker's schema.
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('attendance_apply_correction', 'attendance_mark_reviewed')
      and p.proconfig @> array['search_path=public'])               as search_path_pinned_expect_2,

  -- Execute for signed-in callers, not for anon.
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('attendance_apply_correction', 'attendance_mark_reviewed')
      and has_function_privilege('authenticated', p.oid, 'execute')) as authenticated_execute_expect_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('attendance_apply_correction', 'attendance_mark_reviewed')
      and has_function_privilege('anon', p.oid, 'execute'))          as anon_execute_expect_0,

  -- The widened policy.
  (select count(*) from pg_policy pol
    where pol.polrelid = 'public.pto_requests'::regclass
      and pol.polname = 'pto_requests_update'
      and strpos(pg_get_expr(pol.polqual, pol.polrelid), 'waitlisted') > 0)
                                                                     as pto_update_widened_expect_1,
  (select count(*) from pg_policy pol
    where pol.polrelid = 'public.pto_requests'::regclass
      and pol.polname = 'pto_requests_update'
      and strpos(pg_get_expr(pol.polwithcheck, pol.polrelid), 'approved') > 0)
                                                                     as pto_update_self_approval_expect_0,

  -- The audit log is still append-only (Requirement 16, criterion 5).
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'attendance_audit_log'
      and cmd in ('UPDATE', 'DELETE'))                               as audit_write_policies_expect_0,

  -- Row retention (Requirement 23, criterion 3). Every count must equal
  -- supabase/verification/row-retention/stage-5-pre.json, except audit_log, which
  -- ordinary Quotes activity may have added to. Verify with:
  --   node --env-file=.env.local scripts/verify-attendance-row-retention.mjs --verify --label stage-5-pre
  (select count(*) from public.time_clock_entries)                   as time_clock_entries_total,
  (select count(*) from public.time_clock_breaks)                    as time_clock_breaks_total,
  (select count(*) from public.employee_schedules)                   as employee_schedules_total,
  (select count(*) from public.pto_requests)                         as pto_requests_total,
  (select count(*) from public.attendance_day_reviews)               as day_reviews_total,
  (select count(*) from public.attendance_notes)                     as notes_total,
  (select count(*) from public.attendance_audit_log)                 as attendance_audit_total;

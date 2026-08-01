-- New Hope Work Desk v1.9.1 — Time & Attendance range indexes and open-record
-- integrity (migration stage 2 of 6)
--
-- Spec: .kiro/specs/time-attendance-ui-redesign
-- Requirements: 20.10, 20.11, 20.12, 23.1, 23.2, 23.3, 23.8
--
-- Forward-only. Edits no released migration. This is the ONLY stage of the six that
-- writes to a pre-existing row, and the only write it performs is an UPDATE. Nothing
-- here deletes a row from any table, so the eight preserved tables of Requirement 23,
-- criterion 3 keep every row they hold. The repair block asserts that itself before
-- the transaction is allowed to commit.
--
-- Contents, in the order they must run:
--   1. Table locks, so the repair and the constraints that depend on it cannot be
--      raced by a clock-in arriving between them
--   2. Three range indexes (Requirement 20, criteria 10 and 12)
--   3. A guard on duplicate open breaks, which changes nothing and fails loudly
--   4. The repair reducing any set of two or more open clock entries per profile to
--      one, with one attendance_audit_log row per closure
--   5. uniq_time_clock_open_entry and uniq_time_clock_open_break
--
-- Requirement 20, criterion 11 (a date-range index on employee_schedules) is already
-- satisfied by idx_employee_schedules_date (schedule_date, profile_id) from
-- v1.2.0-time-attendance.sql. This migration adds nothing for it and confirms its
-- presence in the verification block below.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- FIVE DECISIONS THIS FILE MAKES, AND WHY
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- 1. idx_pto_requests_approved_range names a status the check constraint does not yet
--    permit, deliberately.
--    Today pto_requests_status_check allows only pending, approved, denied, and
--    cancelled. 'partially_approved' becomes valid in stage 4 (v1.9.3). A partial
--    index predicate is an ordinary boolean expression evaluated per row; Postgres
--    does not check its literals against the table's check constraints, so the
--    predicate builds today and the 'partially_approved' branch simply matches no row
--    until stage 4 widens the constraint. Writing the final predicate now is the
--    forward-only choice: stage 4 then needs no index rebuild, and rows that arrive
--    with the new status are indexed the moment they exist. Planner use is unaffected,
--    because status = 'approved' implies the predicate.
--
-- 2. The repair keeps the EARLIEST open entry and closes every later one, per the
--    design. Each closed entry gets clock_out = its own clock_in, which is a
--    zero-length session. That invents no hours and removes none: the genuine session
--    is the one left open, and the duplicate is retained as an auditable
--    zero-duration row rather than deleted. Ordering is (clock_in, id), so "earliest"
--    is deterministic even when two entries share a clock_in to the microsecond.
--
-- 3. total_hours is set to 0 on each closed entry. It is the value the new clock_out
--    implies, and leaving it null would leave a closed entry that the legacy payroll
--    sum treats as absent rather than as zero. The audit row records it alongside
--    clock_out so the change is fully described.
--
-- 4. The repair is attributed to the longest-standing active super_admin, because
--    attendance_audit_log.actor_profile_id is NOT NULL and a migration has no
--    auth.uid(). If no super_admin exists AND there is something to repair, the
--    migration aborts rather than change a row without an audit trail.
--
-- 5. Indexes are built without CONCURRENTLY. CONCURRENTLY cannot run inside a
--    transaction block, and the repair must be atomic with the unique indexes that
--    depend on it: if the repair somehow left a duplicate, the unique index fails and
--    the whole stage rolls back. The tables are small (tens of clock rows), so the
--    SHARE lock a plain CREATE INDEX takes is held for milliseconds.
--
-- Note for stage 6.2 (query plans): idx_time_clock_active from v1.2.0 is a NON-unique
-- partial index on the same (profile_id) where clock_out is null shape as the new
-- uniq_time_clock_open_entry, so the two are redundant for lookup. Dropping a
-- released index is not part of this task and is not done here.
--
-- ─────────────────────────────────────────────────────────────────────────────────
-- ROLLBACK PATH (Requirement 23, criterion 8)
-- ─────────────────────────────────────────────────────────────────────────────────
-- Step A — drop the five indexes. This alone fully reverses the migration whenever
-- the repair closed nothing, which is the expected case.
--
--   begin;
--     drop index if exists public.uniq_time_clock_open_break;
--     drop index if exists public.uniq_time_clock_open_entry;
--     drop index if exists public.idx_pto_requests_approved_range;
--     drop index if exists public.idx_pto_requests_range;
--     drop index if exists public.idx_time_clock_clock_in;
--   commit;
--
-- Step B — only if the repair closed at least one entry, reopen them. Every closed
-- entry's prior state is carried in its audit row, so the reversal is derived from
-- the log rather than guessed. Step A must run first: reopening the entries
-- re-creates the duplicate open rows that uniq_time_clock_open_entry forbids.
--
--   begin;
--     update public.time_clock_entries e
--        set clock_out         = (a.old_value->>'clock_out')::timestamptz,
--            total_hours       = (a.old_value->>'total_hours')::numeric,
--            adjusted_by       = (a.old_value->>'adjusted_by')::uuid,
--            adjustment_reason = a.old_value->>'adjustment_reason'
--       from public.attendance_audit_log a
--      where a.entity_id = e.id
--        and a.entity_type = 'clock_entry'
--        and a.reason = 'v1.9.1 duplicate open entry repair';
--   commit;
--
-- The audit rows are not removed by the rollback and cannot be: attendance_audit_log
-- is append-only, protected by attendance_audit_immutable() from v1.9.0. That is the
-- intended outcome. The record that the repair ran, and the record that it was
-- reversed, both stand.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. LOCKS
--    SHARE mode blocks writes and allows reads. Held for the length of this short
--    transaction, it closes the window in which a clock-in arriving after the repair
--    but before uniq_time_clock_open_entry would fail the migration. CREATE INDEX
--    takes the same lock level on time_clock_entries anyway, so this only moves the
--    lock earlier; it does not escalate it.
-- ═══════════════════════════════════════════════════════════════════════════════
lock table public.time_clock_entries, public.time_clock_breaks in share mode;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. RANGE INDEXES
--    The access pattern behind all three is a date range spanning every employee,
--    which is what Today, Review, and Coverage each need and which no existing index
--    serves (Requirement 20, criteria 10 and 12).
-- ═══════════════════════════════════════════════════════════════════════════════

-- Clock entries by instant, across all employees.
create index if not exists idx_time_clock_clock_in
  on public.time_clock_entries(clock_in);

-- Time-off range overlap, across all employees and every status.
create index if not exists idx_pto_requests_range
  on public.pto_requests(start_date, end_date);

-- The same overlap restricted to the statuses that remove an employee from coverage.
-- See decision 1 in the header regarding 'partially_approved'.
create index if not exists idx_pto_requests_approved_range
  on public.pto_requests(start_date, end_date)
  where status in ('approved', 'partially_approved');

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3 and 4. OPEN-BREAK GUARD, THEN THE OPEN-ENTRY REPAIR
--    One block, so the row-count assertion at the end covers everything written.
-- ═══════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_entries_before   bigint;
  v_breaks_before    bigint;
  v_entries_after    bigint;
  v_breaks_after     bigint;
  v_duplicate_breaks text;
  v_actor            uuid;
  v_closed           integer := 0;
  v_audited          integer := 0;
  v_reason           constant text := 'v1.9.1 duplicate open entry repair';
  r                  record;
begin
  select count(*) into v_entries_before from public.time_clock_entries;
  select count(*) into v_breaks_before  from public.time_clock_breaks;

  -- ── 3. Duplicate open breaks. No repair is specified for these, because closing a
  --      break means inventing a break end, and this migration does not guess one.
  --      Without this guard the failure would surface as a bare "could not create
  --      unique index" naming no row. Reads nothing but break rows; changes nothing.
  select string_agg(clock_entry_id::text, ', ' order by clock_entry_id::text)
    into v_duplicate_breaks
    from (
      select clock_entry_id
        from public.time_clock_breaks
       where break_end is null
       group by clock_entry_id
      having count(*) > 1
    ) d;

  if v_duplicate_breaks is not null then
    raise exception 'v1.9.1 cannot create uniq_time_clock_open_break'
      using detail = format('These clock entries hold more than one open break: %s', v_duplicate_breaks),
            hint   = 'Close the surplus breaks (set break_end and duration_minutes) from the application, then re-run this migration. Nothing has been changed.';
  end if;

  -- ── 4. Reduce every set of two or more open clock entries per profile to one.
  if exists (
    select 1
      from public.time_clock_entries
     where clock_out is null
     group by profile_id
    having count(*) > 1
  ) then
    -- Attribute the repair. Longest-standing active super_admin, deterministically.
    select p.id into v_actor
      from public.profiles p
     where p.role = 'super_admin'
       and p.is_active
     order by p.created_at, p.id
     limit 1;

    if v_actor is null then
      select p.id into v_actor
        from public.profiles p
       where p.role = 'super_admin'
       order by p.created_at, p.id
       limit 1;
    end if;

    if v_actor is null then
      raise exception 'v1.9.1 found duplicate open clock entries but no super_admin to attribute the repair to'
        using detail = 'attendance_audit_log.actor_profile_id is NOT NULL, so the repair cannot be logged.',
              hint   = 'Promote a super_admin, then re-run. This migration will not change a clock entry it cannot audit.';
    end if;

    for r in
      with open_entries as (
        select e.id,
               e.profile_id,
               e.clock_in,
               e.total_hours,
               e.adjusted_by,
               e.adjustment_reason,
               row_number() over (partition by e.profile_id order by e.clock_in, e.id) as rn
          from public.time_clock_entries e
         where e.clock_out is null
      )
      select o.id,
             o.profile_id,
             o.clock_in,
             o.total_hours,
             o.adjusted_by,
             o.adjustment_reason,
             -- Work date in the employee's own zone, matching the derivation the
             -- Attendance_Service uses (design: clock instants map to work dates in
             -- profiles.timezone). Falls back to the business timezone.
             (o.clock_in at time zone coalesce(nullif(btrim(p.timezone), ''),
                                               pol.business_timezone,
                                               'America/New_York'))::date as work_date
        from open_entries o
        join public.profiles p on p.id = o.profile_id
        left join public.attendance_policy pol on pol.singleton_key
       where o.rn > 1
       order by o.profile_id, o.clock_in, o.id
    loop
      -- Close the duplicate at its own clock_in: a zero-length session. UPDATE only.
      update public.time_clock_entries
         set clock_out         = r.clock_in,
             total_hours       = 0,
             adjusted_by       = v_actor,
             adjustment_reason = v_reason
       where id = r.id
         and clock_out is null;

      if not found then
        raise exception 'v1.9.1 repair could not close clock entry %', r.id
          using hint = 'The row was closed by another session despite the SHARE lock. Nothing has been committed.';
      end if;

      v_closed := v_closed + 1;

      -- One audit row per closure. old_value carries everything the rollback in the
      -- header needs to reopen the entry.
      insert into public.attendance_audit_log (
        profile_id, work_date, entity_type, entity_id, action, field,
        old_value, new_value, actor_profile_id, reason, payroll_period_id
      ) values (
        r.profile_id,
        r.work_date,
        'clock_entry',
        r.id,
        'correct_punch',
        'clock_out',
        jsonb_build_object(
          'clock_out',         null,
          'total_hours',       r.total_hours,
          'adjusted_by',       r.adjusted_by,
          'adjustment_reason', r.adjustment_reason
        ),
        jsonb_build_object(
          'clock_out',         r.clock_in,
          'total_hours',       0,
          'adjusted_by',       v_actor,
          'adjustment_reason', v_reason
        ),
        v_actor,
        v_reason,
        (select pp.id
           from public.payroll_periods pp
          where r.work_date between pp.period_start and pp.period_end
          order by pp.period_start
          limit 1)
      );

      v_audited := v_audited + 1;
    end loop;
  end if;

  -- ── Post-conditions. The repair issues UPDATE only, so these cannot fail; they are
  --    asserted anyway because this is the one stage that touches existing rows, and
  --    a silent deletion here would be the worst outcome the spec contemplates.
  select count(*) into v_entries_after from public.time_clock_entries;
  select count(*) into v_breaks_after  from public.time_clock_breaks;

  if v_entries_after <> v_entries_before then
    raise exception 'v1.9.1 changed the time_clock_entries row count: % -> %',
      v_entries_before, v_entries_after
      using hint = 'Requirement 23, criterion 3 forbids this. Rolling back.';
  end if;

  if v_breaks_after <> v_breaks_before then
    raise exception 'v1.9.1 changed the time_clock_breaks row count: % -> %',
      v_breaks_before, v_breaks_after
      using hint = 'Requirement 23, criterion 3 forbids this. Rolling back.';
  end if;

  if v_closed <> v_audited then
    raise exception 'v1.9.1 closed % entr(ies) but wrote % audit row(s)', v_closed, v_audited
      using hint = 'The design requires one attendance_audit_log row per closure. Rolling back.';
  end if;

  if exists (
    select 1
      from public.time_clock_entries
     where clock_out is null
     group by profile_id
    having count(*) > 1
  ) then
    raise exception 'v1.9.1 repair left a profile holding more than one open clock entry'
      using hint = 'uniq_time_clock_open_entry would fail below. Rolling back.';
  end if;

  raise notice 'v1.9.1 repair: % duplicate open entr(ies) closed, % audit row(s) written; entries % (unchanged), breaks % (unchanged)',
    v_closed, v_audited, v_entries_after, v_breaks_after;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. OPEN-RECORD INTEGRITY
--    At most one open clock entry per employee, and at most one open break per entry.
--    This is the enforcement behind Requirement 4, criterion 21: a double-clicked
--    clock-in loses the second insert to a unique violation, which task 6.3 turns
--    into a success response describing the session that is already open.
--
--    These come last on purpose. If the repair above had left a duplicate, the first
--    index would fail here and the whole transaction — repair, audit rows, and range
--    indexes — would roll back together.
-- ═══════════════════════════════════════════════════════════════════════════════
create unique index if not exists uniq_time_clock_open_entry
  on public.time_clock_entries(profile_id)
  where clock_out is null;

create unique index if not exists uniq_time_clock_open_break
  on public.time_clock_breaks(clock_entry_id)
  where break_end is null;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
select
  -- The five indexes this migration creates.
  (select count(*) from pg_indexes
     where schemaname = 'public'
       and indexname in ('idx_time_clock_clock_in',
                         'idx_pto_requests_range',
                         'idx_pto_requests_approved_range',
                         'uniq_time_clock_open_entry',
                         'uniq_time_clock_open_break'))               as indexes_created_expect_5,

  -- Both open-record indexes must be UNIQUE, or they enforce nothing.
  (select count(*) from pg_index i
     join pg_class c on c.oid = i.indexrelid
    where c.relname in ('uniq_time_clock_open_entry', 'uniq_time_clock_open_break')
      and i.indisunique
      and i.indpred is not null)                                      as unique_partial_indexes_expect_2,

  -- Requirement 20, criterion 11, already satisfied by v1.2.0.
  (select count(*) from pg_indexes
     where schemaname = 'public'
       and indexname = 'idx_employee_schedules_date')                  as schedules_range_index_expect_1,

  -- Integrity now holds.
  (select count(*) from (
     select profile_id from public.time_clock_entries
      where clock_out is null group by profile_id having count(*) > 1) d)
                                                                      as profiles_with_duplicate_open_entries_expect_0,
  (select count(*) from (
     select clock_entry_id from public.time_clock_breaks
      where break_end is null group by clock_entry_id having count(*) > 1) d)
                                                                      as entries_with_duplicate_open_breaks_expect_0,

  -- What the repair did. Both zero when there was nothing to repair.
  (select count(*) from public.attendance_audit_log
     where reason = 'v1.9.1 duplicate open entry repair')             as repair_audit_rows,
  (select count(*) from public.time_clock_entries
     where adjustment_reason = 'v1.9.1 duplicate open entry repair')  as repaired_clock_entries,

  -- Row retention (Requirement 23, criterion 3). Compare against
  -- supabase/verification/row-retention/stage-2-pre.json.
  (select count(*) from public.time_clock_entries)                    as clock_entries_total,
  (select count(*) from public.time_clock_breaks)                     as breaks_total,
  (select count(*) from public.pto_requests)                          as pto_requests_total;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.11.5 — 2026-08-03: MORNING PUNCHES RESTORED TO 08:30 EASTERN
--
-- A technical fault on Monday 2026-08-03 stopped the roster from clocking in when
-- they arrived. The stored clock-in is when the clock finally accepted the punch,
-- not when the employee started work, so twenty-odd people read as late for a
-- morning they were present for. This sets the morning clock-in to 08:30 Eastern,
-- which is ahead of every morning shift on the roster (08:50 Ecuador, 09:00 US) and
-- so clears the late flag outright rather than nudging each punch inside its own
-- grace period.
--
-- Nothing else about the day moves. Clock-outs, break minutes, and break rows are
-- left exactly as the employees recorded them, which is the "keep the rest of the
-- day as they clocked it" half of the instruction. total_hours is the one derived
-- column that must follow, since it is stored rather than computed on read.
--
-- ── What is repaired, and what is deliberately not ────────────────────────────
--
-- The repair is narrowed by three conditions, because "everyone" on a day that also
-- contains an evening shift and two split sessions cannot mean every row: a blanket
-- 08:30 would pay the evening crew for four hours they did not work and would give
-- one employee two sessions starting at the same instant, which the derivation reads
-- as overlapping data and files under needs_review — a worse outcome than the late
-- flag it set out to remove.
--
--   1. The employee holds a morning shift that day (shift_start before 11:00).
--      This excludes the 11:50-20:30 after-hours crew, who were on time for the
--      shift they actually hold, and anyone with no schedule row at all, who cannot
--      be late because lateness is measured against a schedule.
--
--   2. It is the employee's first session of the day. A second session is a return
--      from an absence mid-shift, not an arrival.
--
--   3. The punch landed before 10:30. Somebody whose first punch of the day was at
--      11:06, 11:45, or 16:28 was working different hours, not fighting a clock at
--      08:30, and moving them would overstate their paid time by hours.
--
-- Twenty-four entries satisfy all three. Four first-punches are left alone by
-- condition 3 and are listed in the notice output at the end, because a silently
-- skipped row is indistinguishable from a row nobody looked at:
--
--   Berenice Bollate  10:59 → 17:55   (US morning shift)
--   Andres Morales    11:06 → 20:30   (holds 08:50, worked the evening)
--   Galo Alfaro       11:45 → 20:31   (holds 08:50, worked the evening)
--   Erick Cruz        16:28 → 17:38   (holds 08:50, worked 1.17h)
--
-- Andres Morales and Galo Alfaro will still read as late. Their punches say they
-- worked 11:00-20:30, so the honest correction for them is to their *schedule* for
-- that date, not to their punches, and which evening shift they were covering is not
-- something this migration can know.
--
-- ── Idempotent ────────────────────────────────────────────────────────────────
--
-- The update requires the stored clock-in to be strictly later than 08:30, so a
-- second run matches nothing and writes no audit entries. Every entry it does move
-- carries an idempotency key in its audit row, in the same shape
-- attendance_apply_correction reads, so a replay is recognisable rather than
-- inferred.
--
-- attendance_apply_correction is the sanctioned path for a single punch and is not
-- usable here: it demands an interactive auth.uid(), and it applies one field to one
-- row per call. This migration does the same work in the same order — lock, capture
-- the old value, write, then audit — for twenty-four rows in one transaction.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

do $repair$
declare
  v_admin       uuid;
  v_work_date   date := '2026-08-03';
  v_target      timestamptz := ('2026-08-03 08:30'::timestamp at time zone 'America/New_York');
  v_repaired    integer := 0;
  v_skipped     text;
begin
  select id into v_admin
    from public.profiles
   where role = 'super_admin' and is_active
   order by display_name
   limit 1;

  if v_admin is null then
    raise exception 'NO_SUPER_ADMIN: attendance_audit_log.actor_profile_id cannot be filled.'
      using hint = 'Nothing has been changed.';
  end if;

  -- ── Lock the rows the repair changes ────────────────────────────────────────
  -- Taken in id order so this transaction cannot deadlock against a concurrent
  -- clock-out taking the same locks.
  create temporary table tmp_aug3_targets on commit drop as
  with day as (
    select
      e.id,
      e.profile_id,
      e.clock_in,
      e.clock_out,
      e.break_minutes,
      e.total_hours,
      (e.clock_in at time zone 'America/New_York') as in_local,
      row_number() over (partition by e.profile_id order by e.clock_in) as seq
    from public.time_clock_entries e
    where (e.clock_in at time zone 'America/New_York')::date = v_work_date
  )
  select
    d.id,
    d.profile_id,
    d.clock_in as old_clock_in,
    d.clock_out,
    d.break_minutes,
    d.total_hours as old_total_hours
  from day d
  join public.employee_schedules s
    on s.profile_id = d.profile_id
   and s.schedule_date = v_work_date
  where d.seq = 1                          -- first session of the day
    and s.shift_start < '11:00'::time      -- a morning shift, not the evening crew
    and d.in_local::time < '10:30'::time   -- arrived in the morning
    and d.clock_in > v_target;             -- still later than 08:30, so not already repaired

  perform 1 from public.time_clock_entries e
    where e.id in (select id from tmp_aug3_targets)
    order by e.id
    for update;

  -- ── Move the punch, and carry total_hours with it ───────────────────────────
  -- total_hours reproduces the arithmetic the clock-out path stores: the span
  -- between the two punches, less the break minutes already recorded against the
  -- entry. Verified against an untouched row before this ran — John Parra's
  -- 08:50:00 to 17:30:57 with 39 break minutes is stored as 8.03, and
  -- (8h40m57s − 39m) rounds to 8.03.
  --
  -- An open entry keeps a null total_hours, because a shift still running has no
  -- total yet. None of the twenty-four are open, but the expression must not
  -- invent a figure if one ever is.
  update public.time_clock_entries e
     set clock_in = v_target,
         total_hours = case
           when t.clock_out is null then null
           else round(
             (extract(epoch from (t.clock_out - v_target)) / 3600.0)
             - (coalesce(t.break_minutes, 0) / 60.0),
             2
           )::numeric(6,2)
         end,
         adjusted_by = v_admin,
         adjustment_reason =
           'Clock-in restored to 08:30 ET. A technical fault on 2026-08-03 delayed the punch, '
           || 'so the recorded time was when the clock accepted it, not when the shift began. '
           || 'Clock-out and breaks left as recorded (migration v1.11.5).'
    from tmp_aug3_targets t
   where e.id = t.id;

  -- ── Audit, as the last statement ───────────────────────────────────────────
  -- attendance_audit_log is append-only and enforced by trigger, so these entries
  -- are the permanent record. If this insert fails, the whole transaction rolls
  -- back and the punches stay as they were: there is no state in which the clock
  -- moved and nothing recorded that it did.
  with logged as (
    insert into public.attendance_audit_log (
      profile_id, work_date, entity_type, entity_id, action, field,
      old_value, new_value, actor_profile_id, reason
    )
    select
      t.profile_id,
      v_work_date,
      'clock_entry',
      t.id,
      'correct_punch',
      'clock_in',
      jsonb_build_object(
        'clock_in', to_char(t.old_clock_in at time zone 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS'),
        'total_hours', t.old_total_hours
      ),
      jsonb_build_object(
        'clock_in', '2026-08-03T08:30:00',
        'total_hours', e.total_hours,
        'timezone', 'America/New_York',
        'idempotency_key', 'v1.11.5-aug3-0830-' || t.id::text,
        'migration', 'v1.11.5'
      ),
      v_admin,
      'Technical fault on 2026-08-03 prevented clock-in at arrival. Morning punch restored to '
      || '08:30 ET, ahead of every morning shift, so the day is not counted late. Clock-out and '
      || 'breaks unchanged.'
    from tmp_aug3_targets t
    join public.time_clock_entries e on e.id = t.id
    returning 1
  )
  select count(*)::integer into v_repaired from logged;

  -- ── What was left alone, named ─────────────────────────────────────────────
  select string_agg(
           format('%s (in %s, out %s)',
                  p.display_name,
                  to_char(e.clock_in at time zone 'America/New_York', 'HH24:MI'),
                  coalesce(to_char(e.clock_out at time zone 'America/New_York', 'HH24:MI'), 'open')),
           '; ' order by e.clock_in)
    into v_skipped
    from public.time_clock_entries e
    join public.profiles p on p.id = e.profile_id
    join public.employee_schedules s
      on s.profile_id = e.profile_id and s.schedule_date = v_work_date
   where (e.clock_in at time zone 'America/New_York')::date = v_work_date
     and s.shift_start < '11:00'::time
     and (e.clock_in at time zone 'America/New_York')::time >= '10:30'::time;

  raise notice 'Clock-ins restored to 08:30 ET: %', v_repaired;
  raise notice 'Morning-shift first punches left alone (arrived after 10:30): %',
               coalesce(v_skipped, 'none');
end;
$repair$;

commit;

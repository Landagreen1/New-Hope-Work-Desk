-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.11.6 — ZAIRA ORTIZ WORKS SATURDAYS ONLY
--
-- The roster spelling is "Zaira Ortiz"; she is the only Ortiz on it, and the only
-- profile the instruction can refer to.
--
-- She was seeded by v1.7.1 into the standing US weekday roster, 09:00-17:30 Monday
-- to Friday, and separately into the Saturday rotation on two of the five Saturdays
-- in the scheduled horizon. Both halves of that are wrong for somebody whose only
-- working day is Saturday: the weekday rows make her read as absent every weekday,
-- and the three Saturdays she is missing from make her read as not working on the
-- one day she does.
--
-- Her punches say the same thing. The only real clock entry she has is Saturday
-- 2026-08-01, 10:43 to 15:21. Her three weekday entries on 2026-07-29 to 07-31 all
-- carry adjustment_reason 'v1.9.6 testing-day repair', were created in one batch at
-- a single instant, and start and end exactly on the scheduled times, because
-- v1.9.6 manufactured them *from* the schedule rows this migration removes.
--
-- ── What changes ──────────────────────────────────────────────────────────────
--
--   1. A "US Saturday" template, Saturday 10:00-17:30, mirroring "Ecuador Saturday"
--      for the roster that starts on the hour rather than ten minutes before it.
--      Zaira is a standing member, because for her Saturday is not a rotation.
--
--   2. Her Monday-to-Friday rows are removed from 2026-07-27 forward, with three
--      exceptions named below.
--
--   3. The template is applied across the horizon, which fills the Saturdays she was
--      missing from: 2026-08-08, 08-22, and 08-29. 08-01 and 08-15 already carry
--      10:00-17:30 from v1.11.4 and are left untouched, notes included.
--
-- ── The three weekdays deliberately left in place ─────────────────────────────
--
-- 2026-07-29, 07-30, and 07-31 keep their schedule rows. Those were testing days,
-- and every employee on the roster carries a synthetic entry for them. Removing her
-- schedule while the synthetic punch remains would turn three completed days into
-- unscheduled work awaiting approval, which is a worse record than the one it
-- replaces; removing the punch as well would delete payroll history and leave her as
-- the one employee missing from a dataset the whole company shares. Making last
-- week's testing data tell a different story than it tells for everybody else is not
-- something this migration should decide on its own.
--
-- Everything else goes: 2026-07-28, which has no punch at all, and every weekday from
-- 2026-08-03 forward.
--
-- ── Queues ────────────────────────────────────────────────────────────────────
--
-- Nothing to do. She is already availability 'unavailable' with whatsapp_active,
-- ringcentral_active, and workload_active all false, so she is ineligible for all
-- three rotations and holds no turn. This migration does not touch rotation_state,
-- turn_events, or any profile flag.
--
-- ── Removal is audited, not silent ────────────────────────────────────────────
--
-- Each deleted row is written to attendance_audit_log with its full previous
-- contents, so a shift removed here can be described, and reinstated, from the log.
-- attendance_audit_log is append-only by trigger and by RLS, and no foreign key
-- anywhere references employee_schedules, so the delete cascades to nothing.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

do $zaira$
declare
  v_admin    uuid;
  v_zaira    uuid;
  v_from     date := '2026-07-27';
  v_to       date := '2026-08-31';
  v_template uuid;
  v_removed  integer := 0;
  v_applied  jsonb;
  v_kept     text;
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

  select id into v_zaira
    from public.profiles
   where display_name = 'Zaira Ortiz' and is_active;

  if v_zaira is null then
    raise exception 'PROFILE_NOT_FOUND: no active profile named "Zaira Ortiz".'
      using hint = 'Nothing has been changed.';
  end if;

  -- ═════════════════════════════════════════════════════════════════════════════
  -- 1. The US Saturday template
  -- ═════════════════════════════════════════════════════════════════════════════
  insert into public.schedule_templates (name, description, created_by)
  values (
    'US Saturday',
    'Saturday only, US roster. Operations open at 10:00 and the US roster starts on the hour, '
    || 'where the Ecuador roster arrives ten minutes early.',
    v_admin
  )
  on conflict (name) do update
     set description = excluded.description,
         is_active = true;

  select id into v_template from public.schedule_templates where name = 'US Saturday';

  delete from public.schedule_template_segments where template_id = v_template;

  insert into public.schedule_template_segments (
    template_id, day_of_week, shift_start, shift_end, shift_type, notes
  )
  values (v_template, 6, '10:00'::time, '17:30'::time, 'regular', 'Saturday only');

  insert into public.schedule_template_members (template_id, profile_id, added_by)
  values (v_template, v_zaira, v_admin)
  on conflict (template_id, profile_id) do nothing;

  -- ═════════════════════════════════════════════════════════════════════════════
  -- 2. Remove the weekday rows, keeping the three testing days
  -- ═════════════════════════════════════════════════════════════════════════════
  with removed as (
    delete from public.employee_schedules
     where profile_id = v_zaira
       and schedule_date >= v_from
       and schedule_date <= v_to
       and extract(dow from schedule_date) between 1 and 5
       and schedule_date not in ('2026-07-29', '2026-07-30', '2026-07-31')
    returning id, profile_id, schedule_date, shift_start, shift_end, shift_type, status, notes
  ),
  logged as (
    insert into public.attendance_audit_log (
      profile_id, work_date, entity_type, entity_id, action, field,
      old_value, new_value, actor_profile_id, reason
    )
    select
      r.profile_id, r.schedule_date, 'schedule', r.id, 'schedule_change', 'shift',
      jsonb_build_object(
        'shift_start', r.shift_start::text,
        'shift_end', r.shift_end::text,
        'shift_type', r.shift_type,
        'status', r.status,
        'notes', r.notes
      ),
      jsonb_build_object('removed', true, 'migration', 'v1.11.6'),
      v_admin,
      'Zaira Ortiz works Saturdays only. Weekday shift removed; she was seeded onto the '
      || 'standing US weekday roster by v1.7.1 in error and read as absent every weekday.'
    from removed r
    returning 1
  )
  select count(*)::integer into v_removed from logged;

  -- ═════════════════════════════════════════════════════════════════════════════
  -- 3. Apply the template, filling the Saturdays she was missing from
  --
  --    Called through apply_schedule_template rather than inserting directly, so the
  --    rows this migration writes come from the same path the UI uses and cannot
  --    disagree with what the template says. The function gates on auth.uid(), which
  --    a migration does not have, so the super_admin's id is put into the
  --    request.jwt.claims GUC that auth.uid() reads. set_config's third argument is
  --    true, making it local to this transaction.
  -- ═════════════════════════════════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);

  select public.apply_schedule_template('US Saturday', v_from, v_to, null, true)
    into v_applied;

  if (v_applied ->> 'ok')::boolean is not true then
    raise exception 'APPLY_FAILED: %', v_applied::text;
  end if;

  -- ═════════════════════════════════════════════════════════════════════════════
  -- What she is left with
  -- ═════════════════════════════════════════════════════════════════════════════
  select string_agg(
           format('%s %s %s-%s',
                  to_char(schedule_date, 'Dy'),
                  schedule_date,
                  shift_start::text,
                  shift_end::text),
           '; ' order by schedule_date)
    into v_kept
    from public.employee_schedules
   where profile_id = v_zaira;

  raise notice 'Weekday rows removed: %', v_removed;
  raise notice 'Template applied: %', v_applied::text;
  raise notice 'Zaira Ortiz now holds: %', coalesce(v_kept, 'no shifts');
end;
$zaira$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.11.4 — SATURDAY OPENS AT 10:00, AND DIANA VAZQUEZ FINISHES AT 15:00
--
-- Two schedule corrections, both effective from last week forward: 2026-07-27, the
-- Monday of the week preceding today (2026-08-03). Nothing before that date is
-- touched, so any week already reconciled stays as it was reconciled.
--
-- ── 1. Saturday operations open at 10:00, not 09:00 ───────────────────────────
--
-- Every Saturday row was seeded by v1.7.1 with the weekday times, which had the
-- office opening an hour before it actually does. The correction keeps the existing
-- ten-minute arrival lead intact:
--
--   Ecuador roster   08:50 → 09:50   (ten minutes before the 10:00 open)
--   US roster        09:00 → 10:00
--   After-hours      11:50 → 11:50   (unchanged; the evening shift is not tied
--                                     to the morning open)
--
-- shift_end stays 17:30. This is not an assumption: on Saturday 2026-08-01 the
-- Ecuador roster clocked in at 09:48-09:50 and the US roster at 10:02, and both
-- clocked out between 17:30 and 17:52. The stored schedule was the only thing
-- describing a 09:00 Saturday, which is why the whole roster read as an hour early
-- on arrival and on time on departure.
--
-- Matching on the current shift_start rather than on a roster list is what keeps
-- this correct for a Saturday whose rotation has not been decided yet: the rule is
-- "whatever this row says the morning shift is, move it to the new open", and it
-- holds for rows that do not exist today. Cancelled rows are moved too, so a
-- reinstated shift carries the right times rather than the old ones.
--
-- ── 2. Diana Vazquez finishes at 15:00 ────────────────────────────────────────
--
-- Applied after the Saturday correction, so her Saturday shift ends up 10:00-15:00
-- rather than being overwritten back to 17:30. Her weekday shift becomes
-- 09:00-15:00, a six-hour day, and she is on the US roster so her start is
-- unchanged.
--
-- Her punches on 2026-08-03 corroborate it: in at 09:07, out at 15:02. Against the
-- stored 17:30 end that reads as a two-and-a-half-hour early departure every single
-- day, which is the shape of a wrong schedule rather than a wrong employee.
--
-- ── Audit ─────────────────────────────────────────────────────────────────────
--
-- Every changed row gets an attendance_audit_log entry with entity_type 'schedule',
-- carrying the old and new times and naming the reason. The log is append-only,
-- enforced by trigger and by RLS, so these entries are the permanent record of a
-- retroactive schedule edit. attendance_apply_correction is not the path here: it
-- corrects punches, not schedules, and it requires an interactive auth.uid() that a
-- migration does not have.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

do $fix$
declare
  v_admin    uuid;
  v_from     date := '2026-07-27';
  v_sat_ec   integer := 0;
  v_sat_us   integer := 0;
  v_diana    integer := 0;
  v_diana_id uuid;
begin
  -- The actor recorded against every audit entry below. attendance_audit_log
  -- requires one, and a schedule edit made by a migration is still made on the
  -- authority of an administrator.
  select id into v_admin
    from public.profiles
   where role = 'super_admin' and is_active
   order by display_name
   limit 1;

  if v_admin is null then
    raise exception 'NO_SUPER_ADMIN: attendance_audit_log.actor_profile_id cannot be filled.'
      using hint = 'Nothing has been changed.';
  end if;

  -- ═════════════════════════════════════════════════════════════════════════════
  -- 1a. Saturday, Ecuador roster: 08:50 → 09:50
  -- ═════════════════════════════════════════════════════════════════════════════
  with moved as (
    update public.employee_schedules
       set shift_start = '09:50'::time
     where schedule_date >= v_from
       and extract(dow from schedule_date) = 6
       and shift_start = '08:50'::time
    returning id, profile_id, schedule_date, shift_end
  ),
  logged as (
    insert into public.attendance_audit_log (
      profile_id, work_date, entity_type, entity_id, action, field,
      old_value, new_value, actor_profile_id, reason
    )
    select
      m.profile_id, m.schedule_date, 'schedule', m.id, 'schedule_change', 'shift_start',
      jsonb_build_object('shift_start', '08:50'),
      jsonb_build_object('shift_start', '09:50', 'migration', 'v1.11.4'),
      v_admin,
      'Saturday operations open at 10:00, not 09:00. Ecuador roster keeps its ten-minute arrival lead.'
    from moved m
    returning 1
  )
  select count(*)::integer into v_sat_ec from logged;

  -- ═════════════════════════════════════════════════════════════════════════════
  -- 1b. Saturday, US roster: 09:00 → 10:00
  -- ═════════════════════════════════════════════════════════════════════════════
  with moved as (
    update public.employee_schedules
       set shift_start = '10:00'::time
     where schedule_date >= v_from
       and extract(dow from schedule_date) = 6
       and shift_start = '09:00'::time
    returning id, profile_id, schedule_date
  ),
  logged as (
    insert into public.attendance_audit_log (
      profile_id, work_date, entity_type, entity_id, action, field,
      old_value, new_value, actor_profile_id, reason
    )
    select
      m.profile_id, m.schedule_date, 'schedule', m.id, 'schedule_change', 'shift_start',
      jsonb_build_object('shift_start', '09:00'),
      jsonb_build_object('shift_start', '10:00', 'migration', 'v1.11.4'),
      v_admin,
      'Saturday operations open at 10:00, not 09:00.'
    from moved m
    returning 1
  )
  select count(*)::integer into v_sat_us from logged;

  -- ═════════════════════════════════════════════════════════════════════════════
  -- 2. Diana Vazquez finishes at 15:00
  --
  --    Resolved by id first so a display_name that matches nobody fails loudly
  --    here rather than silently updating zero rows.
  -- ═════════════════════════════════════════════════════════════════════════════
  select id into v_diana_id
    from public.profiles
   where display_name = 'Diana Vazquez' and is_active;

  if v_diana_id is null then
    raise exception 'PROFILE_NOT_FOUND: no active profile named "Diana Vazquez".'
      using hint = 'Nothing has been changed.';
  end if;

  with moved as (
    update public.employee_schedules
       set shift_end = '15:00'::time
     where profile_id = v_diana_id
       and schedule_date >= v_from
       and shift_end is distinct from '15:00'::time
    returning id, profile_id, schedule_date, shift_start
  ),
  logged as (
    insert into public.attendance_audit_log (
      profile_id, work_date, entity_type, entity_id, action, field,
      old_value, new_value, actor_profile_id, reason
    )
    select
      m.profile_id, m.schedule_date, 'schedule', m.id, 'schedule_change', 'shift_end',
      jsonb_build_object('shift_end', '17:30'),
      jsonb_build_object('shift_end', '15:00', 'shift_start', m.shift_start::text, 'migration', 'v1.11.4'),
      v_admin,
      'Diana Vazquez''s shift ends at 15:00 Eastern. Corrected from last week forward.'
    from moved m
    returning 1
  )
  select count(*)::integer into v_diana from logged;

  raise notice 'Saturday Ecuador rows moved to 09:50: %', v_sat_ec;
  raise notice 'Saturday US rows moved to 10:00: %', v_sat_us;
  raise notice 'Diana Vazquez rows ending at 15:00: %', v_diana;
end;
$fix$;

commit;

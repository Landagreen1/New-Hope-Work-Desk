-- v1.10.12 Two operational fixes:
-- 1. Delete all attendance records for Tuesday 2026-07-28 (tool wasn't ready yet,
--    everyone was incorrectly marked absent).
-- 2. Assign Alvaro Rivadenaira to Elvin Argueta's former queue positions,
--    active ONLY in the RingCentral queue.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. PURGE ALL ATTENDANCE DATA FOR 2026-07-28
--    Tables affected: time_clock_breaks (cascade), time_clock_entries,
--    employee_schedules, attendance_day_reviews, attendance_notes,
--    attendance_audit_log.
--    Business timezone is America/New_York; clock_in is timestamptz.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Delete breaks belonging to clock entries on that date
delete from public.time_clock_breaks
where clock_entry_id in (
  select id from public.time_clock_entries
  where clock_in >= '2026-07-28 00:00:00-04'::timestamptz
    and clock_in <  '2026-07-29 00:00:00-04'::timestamptz
);

-- Delete clock entries for that date
delete from public.time_clock_entries
where clock_in >= '2026-07-28 00:00:00-04'::timestamptz
  and clock_in <  '2026-07-29 00:00:00-04'::timestamptz;

-- Delete attendance day reviews for that date
delete from public.attendance_day_reviews
where work_date = '2026-07-28';

-- Delete attendance notes for that date
delete from public.attendance_notes
where work_date = '2026-07-28';

-- Delete attendance audit log entries for that date
-- (Must temporarily disable the immutability trigger from v1.9.0)
alter table public.attendance_audit_log disable trigger attendance_audit_no_update;

delete from public.attendance_audit_log
where work_date = '2026-07-28';

alter table public.attendance_audit_log enable trigger attendance_audit_no_update;

-- Remove the schedule entries for that date (they were generated but meaningless)
delete from public.employee_schedules
where schedule_date = '2026-07-28';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ASSIGN ALVARO RIVADENAIRA TO ELVIN'S QUEUE POSITIONS (RC ONLY)
--    Elvin was deactivated in v1.10.11. His position values remain on his
--    profile row. Alvaro inherits those positions but is enabled only for
--    RingCentral.
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_elvin_id uuid;
  v_alvaro_id uuid;
  v_elvin_rp integer;
  v_elvin_wp integer;
  v_elvin_rcp integer;
  v_elvin_wlp integer;
  v_alvaro_rp integer;
  v_alvaro_wp integer;
  v_alvaro_rcp integer;
  v_alvaro_wlp integer;
begin
  -- Resolve Elvin (deactivated)
  select id, rotation_position, whatsapp_position, ringcentral_position, workload_position
  into v_elvin_id, v_elvin_rp, v_elvin_wp, v_elvin_rcp, v_elvin_wlp
  from public.profiles
  where display_name = 'Elvin Argueta';

  if v_elvin_id is null then
    raise exception 'Elvin Argueta profile not found';
  end if;

  -- Resolve Alvaro Rivadeneira
  select id, rotation_position, whatsapp_position, ringcentral_position, workload_position
  into v_alvaro_id, v_alvaro_rp, v_alvaro_wp, v_alvaro_rcp, v_alvaro_wlp
  from public.profiles
  where display_name = 'Alvaro Rivadeneira' and is_active = true;

  if v_alvaro_id is null then
    raise exception 'Alvaro Rivadeneira profile not found or not active';
  end if;

  -- Swap rotation_position using a temporary value to avoid unique constraint violation.
  -- (rotation_position has an unconditional unique constraint and check > 0)
  update public.profiles
  set rotation_position = 99999, updated_at = now()
  where id = v_elvin_id;

  update public.profiles
  set rotation_position = v_elvin_rp, updated_at = now()
  where id = v_alvaro_id;

  update public.profiles
  set rotation_position = v_alvaro_rp, updated_at = now()
  where id = v_elvin_id;

  -- Now assign Elvin's queue positions to Alvaro.
  -- The partial unique indexes (where role='agent' and is_active) exclude Elvin
  -- since he is is_active=false, so no conflict for whatsapp/rc/workload positions.
  -- Give Elvin Alvaro's old positions to keep them valid.
  update public.profiles
  set
    whatsapp_position = v_elvin_wp,
    ringcentral_position = v_elvin_rcp,
    workload_position = v_elvin_wlp,
    whatsapp_active = false,
    ringcentral_active = true,
    workload_active = false,
    updated_at = now()
  where id = v_alvaro_id;

  update public.profiles
  set
    whatsapp_position = v_alvaro_wp,
    ringcentral_position = v_alvaro_rcp,
    workload_position = v_alvaro_wlp,
    updated_at = now()
  where id = v_elvin_id;

  raise notice 'Assigned Alvaro Rivadeneira (%) to Elvin positions: RP=%, WA=%, RC=%, WL=% — RC only active',
    v_alvaro_id, v_elvin_rp, v_elvin_wp, v_elvin_rcp, v_elvin_wlp;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.16.7 — 2026-08-17: Maria Trujillo clock correction
--
-- Maria Trujillo was absent from the system Aug 12–14 and missing a clock-in for
-- Aug 17 (today). Per Byron's instruction:
--   • Aug 12, 13, 14 — insert full scheduled shifts (08:50–17:30 ET, 40 min break)
--   • Aug 17 — insert clock-in only at 08:50 ET, leave clocked in (no clock_out)
--
-- No existing entries exist for these dates, so this is purely additive.
-- Idempotent: if the entries already exist (clock_in matches), nothing is inserted.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

do $repair$
declare
  v_maria      uuid := '38dc0842-e29d-44b2-8166-720ef98c8d55';
  v_admin      uuid;
  v_dates      date[] := array['2026-08-12','2026-08-13','2026-08-14']::date[];
  v_today      date := '2026-08-17';
  v_d          date;
  v_clock_in   timestamptz;
  v_clock_out  timestamptz;
  v_entry_id   uuid;
  v_inserted   integer := 0;
begin
  -- Find super_admin for audit
  select id into v_admin
    from public.profiles
   where role = 'super_admin' and is_active
   order by display_name
   limit 1;

  if v_admin is null then
    raise exception 'NO_SUPER_ADMIN: cannot fill actor_profile_id in audit log.';
  end if;

  -- ── Aug 12, 13, 14: full scheduled shifts ──────────────────────────────────
  foreach v_d in array v_dates loop
    v_clock_in  := (v_d::text || ' 08:50')::timestamp at time zone 'America/New_York';
    v_clock_out := (v_d::text || ' 17:30')::timestamp at time zone 'America/New_York';

    -- Idempotency: skip if an entry already exists for this date
    if not exists (
      select 1 from public.time_clock_entries
       where profile_id = v_maria
         and (clock_in at time zone 'America/New_York')::date = v_d
    ) then
      insert into public.time_clock_entries (
        profile_id, clock_in, clock_out, clock_status,
        break_minutes, total_hours, is_overtime,
        adjusted_by, adjustment_reason
      ) values (
        v_maria, v_clock_in, v_clock_out, 'available',
        40, 8.00, false,
        v_admin,
        'Full scheduled shift added by admin correction. Employee worked '
        || to_char(v_d, 'Dy Mon DD') || ' but had no clock record (migration v1.16.7).'
      )
      returning id into v_entry_id;

      -- Audit entry
      insert into public.attendance_audit_log (
        profile_id, work_date, entity_type, entity_id, action, field,
        old_value, new_value, actor_profile_id, reason
      ) values (
        v_maria, v_d, 'clock_entry', v_entry_id, 'add_punch', 'session',
        null,
        jsonb_build_object(
          'clock_in', to_char(v_clock_in at time zone 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS'),
          'clock_out', to_char(v_clock_out at time zone 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS'),
          'break_minutes', 40,
          'total_hours', 8.00,
          'idempotency_key', 'v1.16.7-maria-' || v_d::text,
          'migration', 'v1.16.7'
        ),
        v_admin,
        'Maria Trujillo worked a full scheduled shift on ' || to_char(v_d, 'Dy Mon DD')
        || ' but had no clock record. Added 08:50–17:30 ET with 40 min break per admin instruction.'
      );

      v_inserted := v_inserted + 1;
    end if;
  end loop;

  -- ── Aug 17 (today): clock-in only, still working ───────────────────────────
  v_clock_in := (v_today::text || ' 08:50')::timestamp at time zone 'America/New_York';

  if not exists (
    select 1 from public.time_clock_entries
     where profile_id = v_maria
       and (clock_in at time zone 'America/New_York')::date = v_today
  ) then
    insert into public.time_clock_entries (
      profile_id, clock_in, clock_out, clock_status,
      break_minutes, total_hours, is_overtime,
      adjusted_by, adjustment_reason
    ) values (
      v_maria, v_clock_in, null, 'available',
      0, null, false,
      v_admin,
      'Clock-in added by admin. Employee is working today but was missing clock-in (migration v1.16.7).'
    )
    returning id into v_entry_id;

    -- Audit entry
    insert into public.attendance_audit_log (
      profile_id, work_date, entity_type, entity_id, action, field,
      old_value, new_value, actor_profile_id, reason
    ) values (
      v_maria, v_today, 'clock_entry', v_entry_id, 'add_punch', 'clock_in',
      null,
      jsonb_build_object(
        'clock_in', to_char(v_clock_in at time zone 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS'),
        'clock_out', null,
        'idempotency_key', 'v1.16.7-maria-' || v_today::text,
        'migration', 'v1.16.7'
      ),
      v_admin,
      'Maria Trujillo clock-in added for today (Mon Aug 17). She will clock out when her shift ends.'
    );

    v_inserted := v_inserted + 1;
  end if;

  raise notice 'Maria Trujillo clock correction: % entries inserted.', v_inserted;
end;
$repair$;

commit;

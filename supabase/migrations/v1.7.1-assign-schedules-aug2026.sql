-- v1.7.1 Assign schedules for July 28 - August 31, 2026
-- Regular: 08:50-17:50 Mon-Fri
-- After-hours: 11:50-20:30 Tue-Fri
-- Saturday rotation per the schedule list
-- Only assigns to ACTIVE profiles

begin;

-- Clear any existing schedules from Jul 28 - Aug 31
delete from public.employee_schedules
where schedule_date >= '2026-07-28' and schedule_date <= '2026-08-31';

do $$
declare
  v_admin_id uuid;
begin
  select id into v_admin_id from public.profiles where role = 'super_admin' and is_active = true limit 1;
  if v_admin_id is null then
    select id into v_admin_id from public.profiles where role = 'manager' and is_active = true limit 1;
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- REGULAR SCHEDULE: 08:50-17:50, Mon-Fri
  -- ═══════════════════════════════════════════════════════════════════════════

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, created_by)
  select p.id, d.dt, '08:50'::time, '17:30'::time, 'regular', 'published', v_admin_id
  from (
    select generate_series('2026-07-28'::date, '2026-08-31'::date, '1 day'::interval)::date as dt
  ) d
  cross join (
    select id from public.profiles where is_active = true and display_name in (
      'Galo Alfaro',
      'Berenice Bollate',
      'Maria Trujillo',
      'Maria Zumarraga',
      'Alejandro Barros',
      'Ricardo Chinlle',
      'Erick Cruz',
      'Angelica Hernandez',
      'Micaela Delgado',
      'Osmary MacGregor',
      'Andres Morales',
      'Brenda Morales',
      'Zaira Ortiz',
      'Jose Rosales',
      'Felipe Rueda',
      'Vivian Talavera',
      'Milton Vargas',
      'John Parra',
      'Thalita Revelo',
      'Andrea Rodriguez',
      'Daniel Perez',
      'Santiago Cabezas',
      'Jossue Cardenas',
      'Giovanny Gonzalez',
      'Axel Moreno',
      'Andrea Rueda',
      'Gabriel Zalazar',
      'Diana Vazquez',
      'Daniela Garcia'
    )
  ) p
  where extract(dow from d.dt) between 1 and 5
  on conflict (profile_id, schedule_date) do nothing;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- AFTER-HOURS SCHEDULE: 11:50-20:30, Tue-Fri
  -- ═══════════════════════════════════════════════════════════════════════════

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, created_by)
  select p.id, d.dt, '11:50'::time, '20:30'::time, 'regular', 'published', v_admin_id
  from (
    select generate_series('2026-07-28'::date, '2026-08-31'::date, '1 day'::interval)::date as dt
  ) d
  cross join (
    select id from public.profiles where is_active = true and display_name in (
      'Estefania Bayas',
      'Elvin Argueta',
      'Miguel Leiva',
      'Mauricio Plaza',
      'Pablo Teran'
    )
  ) p
  where extract(dow from d.dt) between 2 and 5
  on conflict (profile_id, schedule_date) do nothing;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- SPECIAL: Juliana Abrego — Mon, Tue, Thu, Fri (08:50-17:50)
  -- ═══════════════════════════════════════════════════════════════════════════

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, created_by)
  select p.id, d.dt, '08:50'::time, '17:30'::time, 'regular', 'published', v_admin_id
  from (
    select generate_series('2026-07-28'::date, '2026-08-31'::date, '1 day'::interval)::date as dt
  ) d
  cross join (
    select id from public.profiles where is_active = true and display_name = 'Juliana Abrego'
  ) p
  where extract(dow from d.dt) in (1, 2, 4, 5)
  on conflict (profile_id, schedule_date) do nothing;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- SPECIAL: Jason Toro — No weekday schedule (Saturday rotation only)
  -- ═══════════════════════════════════════════════════════════════════════════
  -- (nothing to insert for weekdays)

  -- ═══════════════════════════════════════════════════════════════════════════
  -- SATURDAY ROTATION — Aug 1, 2026
  -- ═══════════════════════════════════════════════════════════════════════════

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, notes, created_by)
  select p.id, '2026-08-01'::date, '08:50'::time, '17:30'::time, 'regular', 'published', 'Saturday rotation', v_admin_id
  from public.profiles p
  where p.is_active = true and p.display_name in (
    'Galo Alfaro', 'Berenice Bollate', 'Maria Zumarraga', 'Alejandro Barros',
    'Andres Morales', 'Zaira Ortiz', 'Jose Rosales', 'Vivian Talavera',
    'Thalita Revelo', 'Jossue Cardenas', 'Axel Moreno'
  )
  on conflict (profile_id, schedule_date) do update set shift_start = '08:50'::time, shift_end = '17:30'::time, notes = 'Saturday rotation';

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, notes, created_by)
  select p.id, '2026-08-01'::date, '11:50'::time, '20:30'::time, 'overtime', 'published', 'Saturday after-hours', v_admin_id
  from public.profiles p
  where p.is_active = true and p.display_name in (
    'Estefania Bayas', 'Miguel Leiva', 'Mauricio Plaza', 'Pablo Teran'
  )
  on conflict (profile_id, schedule_date) do update set shift_start = '11:50'::time, shift_end = '20:30'::time, shift_type = 'overtime', notes = 'Saturday after-hours';

  -- ═══════════════════════════════════════════════════════════════════════════
  -- SATURDAY ROTATION — Aug 8, 2026
  -- ═══════════════════════════════════════════════════════════════════════════

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, notes, created_by)
  select p.id, '2026-08-08'::date, '08:50'::time, '17:30'::time, 'regular', 'published', 'Saturday rotation', v_admin_id
  from public.profiles p
  where p.is_active = true and p.display_name in (
    'Galo Alfaro', 'Berenice Bollate', 'Jason Toro', 'Angelica Hernandez',
    'Osmary MacGregor', 'Felipe Rueda', 'Vivian Talavera', 'Milton Vargas',
    'Daniel Perez', 'Diana Vazquez'
  )
  on conflict (profile_id, schedule_date) do update set shift_start = '08:50'::time, shift_end = '17:30'::time, notes = 'Saturday rotation';

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, notes, created_by)
  select p.id, '2026-08-08'::date, '11:50'::time, '20:30'::time, 'overtime', 'published', 'Saturday after-hours', v_admin_id
  from public.profiles p
  where p.is_active = true and p.display_name in (
    'Estefania Bayas', 'Elvin Argueta', 'Miguel Leiva', 'Mauricio Plaza', 'Pablo Teran'
  )
  on conflict (profile_id, schedule_date) do update set shift_start = '11:50'::time, shift_end = '20:30'::time, shift_type = 'overtime', notes = 'Saturday after-hours';

  -- ═══════════════════════════════════════════════════════════════════════════
  -- SATURDAY ROTATION — Aug 15, 2026
  -- ═══════════════════════════════════════════════════════════════════════════

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, notes, created_by)
  select p.id, '2026-08-15'::date, '08:50'::time, '17:30'::time, 'regular', 'published', 'Saturday rotation', v_admin_id
  from public.profiles p
  where p.is_active = true and p.display_name in (
    'Galo Alfaro', 'Juliana Abrego', 'Alejandro Barros',
    'Ricardo Chinlle', 'Micaela Delgado', 'Andres Morales', 'Brenda Morales',
    'Zaira Ortiz', 'John Parra', 'Thalita Revelo', 'Daniel Perez',
    'Giovanny Gonzalez', 'Daniela Garcia'
  )
  on conflict (profile_id, schedule_date) do update set shift_start = '08:50'::time, shift_end = '17:30'::time, notes = 'Saturday rotation';

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, notes, created_by)
  select p.id, '2026-08-15'::date, '11:50'::time, '20:30'::time, 'overtime', 'published', 'Saturday after-hours', v_admin_id
  from public.profiles p
  where p.is_active = true and p.display_name in (
    'Estefania Bayas', 'Miguel Leiva', 'Mauricio Plaza', 'Pablo Teran'
  )
  on conflict (profile_id, schedule_date) do update set shift_start = '11:50'::time, shift_end = '20:30'::time, shift_type = 'overtime', notes = 'Saturday after-hours';

  -- ═══════════════════════════════════════════════════════════════════════════
  -- SATURDAY ROTATION — Aug 22, 2026
  -- ═══════════════════════════════════════════════════════════════════════════

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, notes, created_by)
  select p.id, '2026-08-22'::date, '08:50'::time, '17:30'::time, 'regular', 'published', 'Saturday rotation', v_admin_id
  from public.profiles p
  where p.is_active = true and p.display_name in (
    'Galo Alfaro', 'Juliana Abrego', 'Erick Cruz', 'Angelica Hernandez',
    'Brenda Morales', 'Jose Rosales', 'Vivian Talavera', 'Daniel Perez',
    'Axel Moreno', 'Gabriel Zalazar'
  )
  on conflict (profile_id, schedule_date) do update set shift_start = '08:50'::time, shift_end = '17:30'::time, notes = 'Saturday rotation';

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, notes, created_by)
  select p.id, '2026-08-22'::date, '11:50'::time, '20:30'::time, 'overtime', 'published', 'Saturday after-hours', v_admin_id
  from public.profiles p
  where p.is_active = true and p.display_name in (
    'Estefania Bayas', 'Elvin Argueta', 'Miguel Leiva', 'Mauricio Plaza', 'Pablo Teran'
  )
  on conflict (profile_id, schedule_date) do update set shift_start = '11:50'::time, shift_end = '20:30'::time, shift_type = 'overtime', notes = 'Saturday after-hours';

  -- ═══════════════════════════════════════════════════════════════════════════
  -- SATURDAY ROTATION — Aug 29, 2026
  -- ═══════════════════════════════════════════════════════════════════════════

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, notes, created_by)
  select p.id, '2026-08-29'::date, '08:50'::time, '17:30'::time, 'regular', 'published', 'Saturday rotation', v_admin_id
  from public.profiles p
  where p.is_active = true and p.display_name in (
    'Jason Toro', 'Maria Zumarraga', 'Alejandro Barros', 'Ricardo Chinlle',
    'Angelica Hernandez', 'Osmary MacGregor', 'Andres Morales', 'Thalita Revelo',
    'Daniel Perez', 'Santiago Cabezas', 'Jossue Cardenas', 'Daniela Garcia'
  )
  on conflict (profile_id, schedule_date) do update set shift_start = '08:50'::time, shift_end = '17:30'::time, notes = 'Saturday rotation';

  insert into public.employee_schedules (profile_id, schedule_date, shift_start, shift_end, shift_type, status, notes, created_by)
  select p.id, '2026-08-29'::date, '11:50'::time, '20:30'::time, 'overtime', 'published', 'Saturday after-hours', v_admin_id
  from public.profiles p
  where p.is_active = true and p.display_name in (
    'Estefania Bayas', 'Elvin Argueta', 'Miguel Leiva', 'Mauricio Plaza', 'Pablo Teran'
  )
  on conflict (profile_id, schedule_date) do update set shift_start = '11:50'::time, shift_end = '20:30'::time, shift_type = 'overtime', notes = 'Saturday after-hours';

end $$;

commit;


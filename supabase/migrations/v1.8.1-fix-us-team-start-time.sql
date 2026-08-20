-- v1.8.1 Fix United States team schedule start time
-- US team starts at 09:00 EST (not 08:50 like the other teams).
-- Only affects the regular-shift US employees whose shift_start is currently 08:50.

begin;

-- Update weekday and Saturday schedules for US-based employees
-- who have shift_start = 08:50 to 09:00
update public.employee_schedules
set shift_start = '09:00'::time
where shift_start = '08:50'::time
  and schedule_date >= '2026-07-28'
  and profile_id in (
    select id from public.profiles
    where display_name in (
      'Juliana Abrego',
      'Berenice Bollate',
      'Diana Vazquez',
      'Vivian Talavera',
      'Brenda Morales',
      'Angelica Hernandez',
      'Jason Toro',
      'Zaira Ortiz'
    )
  );

commit;

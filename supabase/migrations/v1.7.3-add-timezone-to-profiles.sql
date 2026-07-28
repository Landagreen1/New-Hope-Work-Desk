-- v1.7.3 Add timezone column to profiles and set employee locations
-- Schedules are stored in US Eastern time (business time).
-- The UI will convert display times based on each employee's timezone.

begin;

-- Add timezone column (default to US Eastern for existing users)
alter table public.profiles
  add column if not exists timezone text not null default 'America/New_York';

-- Fix schedule end times: 17:50 → 17:30
update public.employee_schedules
set shift_end = '17:30'::time
where shift_end = '17:50'::time;

-- Honduras (America/Tegucigalpa, UTC-6)
update public.profiles set timezone = 'America/Tegucigalpa'
where display_name in ('Elvin Argueta', 'Miguel Leiva');

-- Ecuador (America/Guayaquil, UTC-5)
update public.profiles set timezone = 'America/Guayaquil'
where display_name in (
  'Galo Alfaro',
  'Estefania Bayas',
  'Alejandro Barros',
  'Ricardo Chinlle',
  'Erick Cruz',
  'Micaela Delgado',
  'Osmary MacGregor',
  'Andres Morales',
  'Jose Rosales',
  'Felipe Rueda',
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
  'Daniela Garcia',
  'Maria Trujillo',
  'Maria Zumarraga',
  'Mauricio Plaza',
  'Pablo Teran'
);

-- US Eastern (America/New_York) — already the default, but be explicit
update public.profiles set timezone = 'America/New_York'
where display_name in (
  'Juliana Abrego',
  'Berenice Bollate',
  'Diana Vazquez',
  'Vivian Talavera',
  'Brenda Morales',
  'Angelica Hernandez',
  'Jason Toro',
  'Zaira Ortiz',
  'Oscar Landaverde'
);

commit;

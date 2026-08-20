-- New Hope Work Desk v1.4.2 — Promote Jason & Daniel to super_admin, remove inactive dealers
-- Must be applied AFTER v1.3.0-super-admin-role.sql (enum value committed).

begin;

-- 1. Promote Jason and Daniel to super_admin
update public.profiles
set role = 'super_admin'
where username in ('jason', 'daniel');

-- 2. Soft-delete (deactivate) dealers that are no longer used as sources
update public.dealers
set is_active = false
where name in (
  '77 AUTO GROUP KANAPOLIS',
  'ADAMS AUTO GROUP',
  'AFC',
  'AUTO REVOLUTION CLUB',
  'BURNS AUTOMOTIVE',
  'CAPITAL INDIAN TRAIL',
  'CLAUDIA',
  'DADA AUTO',
  'DEAL TIME MOTORS',
  'DELUXE AUTO GROUP',
  'FOUR KING AUTO GROUP',
  'FURST',
  'HONDA',
  'Juan Hernández VA',
  'JULIO GOMEZ',
  'Lifestyle Auto Help',
  'MARLYS',
  'PEDRAZA',
  'PLACAS MULTI EXPRESS',
  'PLACAS TEMPORALES',
  'PLANET MITSUBISHI',
  'PRO AUTO ELITE',
  'SERVICIOS LATINOS',
  'SIGN AND DRIVE',
  'SOUTH CHARLOTTE CHEVY',
  'TAX LADY - MAYRA THOMASON',
  'Tax Service',
  'TAXES LATINOS KANNAPOLIS',
  'TERESA AUTO FINANCE',
  'TOYOTA CHARLOTTE',
  'WEB AUTOS',
  'ZZ AUTO SALES'
);

commit;

select 'v1.4.2 Jason & Daniel promoted; 32 dealers deactivated' as status;

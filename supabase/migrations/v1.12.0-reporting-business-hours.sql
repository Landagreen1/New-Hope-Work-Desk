-- New Hope Work Desk v1.12.0 — configurable business hours for reporting
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 7.1-7.10, 8.2, 17.7
--
-- Until now "after hours" was two integers inside a React function:
-- work-desk-app.tsx lines 11023-11030 return true when the minute of day is below
-- 510 or at or above 1050, Monday through Saturday, with Sunday handled as a
-- separate report mode. Nothing in the database records when the office is open, so
-- nothing could be asked, and a holiday looked like an ordinary working day.
--
-- This migration gives the office hours a row.
--
--   business_hours_days      one row per weekday, with the times
--   business_hours_closures  holidays and special closures
--   business_hours_settings  Sunday handling
--   reporting_is_business_hours(timestamptz)  the single SQL authority
--
-- ── The timezone is not stored here ──────────────────────────────────────────
--
-- attendance_policy.business_timezone already exists and already defaults to
-- America/New_York. Storing a second copy would create a second answer to when the
-- office is open, and the two would drift. This migration reads that column.
--
-- ── The seed reproduces today's behaviour exactly ────────────────────────────
--
-- Monday through Saturday 08:30-17:30, Sunday closed. Byron confirmed on
-- 2026-08-03 that these are the regular business hours, Saturdays included, and
-- that anything outside them is after hours.
--
-- Seeding to parity is deliberate. The Phase 6 comparison against the legacy
-- reports has to start from the same window the old report used, so that any
-- difference it reports is a difference of definition rather than of configuration.
--
-- ── Boundaries ───────────────────────────────────────────────────────────────
--
-- Opening time inclusive, closing time exclusive: 08:30 is open, 17:30 is not.
-- A holiday or special closure is after hours for the whole day, whatever the time.
--
-- ROLLBACK
--   begin;
--     drop function if exists public.reporting_is_business_hours(timestamptz);
--     drop table if exists public.business_hours_settings;
--     drop table if exists public.business_hours_closures;
--     drop table if exists public.business_hours_days;
--   commit;
--   Nothing pre-existing is touched by this migration, so nothing pre-existing is
--   touched by the rollback.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. WEEKDAYS — one row per day of week, matching extract(dow) and getUTCDay()
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.business_hours_days (
  day_of_week    smallint primary key check (day_of_week between 0 and 6),
  is_working_day boolean not null,
  opens_at       time not null,
  closes_at      time not null,
  updated_by     uuid references public.profiles(id),
  updated_at     timestamptz not null default now(),
  constraint business_hours_days_span check (closes_at > opens_at)
);

comment on table public.business_hours_days is
  'One row per weekday. 0 = Sunday through 6 = Saturday, the same numbering as extract(dow from ...) and JavaScript getUTCDay(), so the SQL classifier and the TypeScript classifier index the same way. opens_at is inclusive and closes_at is exclusive. Times are wall clocks in attendance_policy.business_timezone.';

comment on column public.business_hours_days.is_working_day is
  'Whether the office is open on this weekday at all. For day_of_week 0 this column is ignored: Sunday''s working status comes from business_hours_settings.sunday_is_working_day, which is its own setting per Requirement 7.5, and the day 0 row supplies only the hours Sunday would keep if it were opened.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CLOSURES — holidays and one-off closures. After hours for the whole day.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.business_hours_closures (
  closure_date date primary key,
  label        text not null check (length(btrim(label)) > 0),
  closure_kind text not null check (closure_kind in ('holiday', 'special_closure')),
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);

comment on table public.business_hours_closures is
  'Dates the office is closed. A date present here is after hours for its whole span regardless of the weekday configuration (Requirement 7.6). Two kinds so a recurring holiday can be told apart from a one-off closure in reporting. Deliberately separate from attendance_closed_dates: that table drives attendance status derivation and is super_admin-only, and coupling reporting hours to it would mean one edit changing two unrelated things.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. SETTINGS — single row. Sunday handling.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.business_hours_settings (
  singleton_key         boolean primary key default true check (singleton_key),
  sunday_is_working_day boolean not null default false,
  updated_by            uuid references public.profiles(id),
  updated_at            timestamptz not null default now()
);

comment on table public.business_hours_settings is
  'Exactly one row, capped by the boolean primary key with its check. Holds Sunday handling as its own setting per Requirement 7.5 so that opening Sunday is one edit rather than a weekday row change that reads like every other weekday.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. SEED — today's hard-coded window, so the legacy comparison starts at parity
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.business_hours_settings (singleton_key) values (true)
on conflict (singleton_key) do nothing;

insert into public.business_hours_days (day_of_week, is_working_day, opens_at, closes_at)
values
  (0, false, time '08:30', time '17:30'),
  (1, true,  time '08:30', time '17:30'),
  (2, true,  time '08:30', time '17:30'),
  (3, true,  time '08:30', time '17:30'),
  (4, true,  time '08:30', time '17:30'),
  (5, true,  time '08:30', time '17:30'),
  (6, true,  time '08:30', time '17:30')
on conflict (day_of_week) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. THE CLASSIFIER
--
-- security definer so a report can classify an instant without the caller needing
-- read access to attendance_policy, which is super_admin-only for writes and whose
-- read scope is not this feature's business.
--
-- `at time zone` performs the conversion through the IANA database, so daylight
-- saving is handled by the same rules the attendance module already relies on. This
-- is the half of the fix that the TypeScript classifier mirrors: neither side ever
-- re-parses a formatted date string, which is what work-desk-app.tsx getEstTime
-- does today via toLocaleString followed by new Date(...).
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.reporting_is_business_hours(p_at timestamptz)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_zone     text;
  v_local    timestamp;
  v_date     date;
  v_time     time;
  v_dow      smallint;
  v_day      public.business_hours_days;
  v_sunday   boolean;
begin
  if p_at is null then
    return false;
  end if;

  select business_timezone into v_zone
    from public.attendance_policy
   where singleton_key
   limit 1;
  v_zone := coalesce(v_zone, 'America/New_York');

  v_local := p_at at time zone v_zone;
  v_date  := v_local::date;
  v_time  := v_local::time;
  v_dow   := extract(dow from v_local)::smallint;

  -- A closure is after hours for the whole day, whatever the time (Requirement 7.6).
  if exists (
    select 1 from public.business_hours_closures c where c.closure_date = v_date
  ) then
    return false;
  end if;

  select * into v_day from public.business_hours_days d where d.day_of_week = v_dow;
  if not found then
    return false;
  end if;

  if v_dow = 0 then
    select s.sunday_is_working_day into v_sunday
      from public.business_hours_settings s
     where s.singleton_key
     limit 1;
    if not coalesce(v_sunday, false) then
      return false;
    end if;
  elsif not v_day.is_working_day then
    return false;
  end if;

  -- Opening inclusive, closing exclusive (Requirement 7.9).
  return v_time >= v_day.opens_at and v_time < v_day.closes_at;
end;
$$;

comment on function public.reporting_is_business_hours(timestamptz) is
  'The single SQL authority on whether an instant falls inside configured business hours. Mirrors classifyInstant in src/features/reporting/definitions.ts, and the two are held together by the shared fixture corpus in src/features/reporting/__tests__/business-hours.fixtures.ts, which is run against both. Returns false for a null instant so a missing timestamp never reads as inside business hours.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. RLS — any authenticated user may read the hours; only a manager may change them
--
-- Office hours are an agency-wide setting rather than a sales decision, so writes
-- stay at is_manager() (manager, super_admin) rather than the wider
-- can_manage_sales() used for reading reports.
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.business_hours_days enable row level security;
alter table public.business_hours_closures enable row level security;
alter table public.business_hours_settings enable row level security;

drop policy if exists "Authenticated users can read business hours days" on public.business_hours_days;
create policy "Authenticated users can read business hours days"
  on public.business_hours_days for select to authenticated using (true);

drop policy if exists "Managers can manage business hours days" on public.business_hours_days;
create policy "Managers can manage business hours days"
  on public.business_hours_days for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "Authenticated users can read business hours closures" on public.business_hours_closures;
create policy "Authenticated users can read business hours closures"
  on public.business_hours_closures for select to authenticated using (true);

drop policy if exists "Managers can manage business hours closures" on public.business_hours_closures;
create policy "Managers can manage business hours closures"
  on public.business_hours_closures for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "Authenticated users can read business hours settings" on public.business_hours_settings;
create policy "Authenticated users can read business hours settings"
  on public.business_hours_settings for select to authenticated using (true);

drop policy if exists "Managers can manage business hours settings" on public.business_hours_settings;
create policy "Managers can manage business hours settings"
  on public.business_hours_settings for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

grant execute on function public.reporting_is_business_hours(timestamptz) to authenticated;

commit;

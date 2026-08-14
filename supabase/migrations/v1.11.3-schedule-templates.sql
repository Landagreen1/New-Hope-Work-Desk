-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.11.3 — SCHEDULE TEMPLATES
--
-- Until now a shift pattern existed only as prose inside a migration:
-- v1.7.1-assign-schedules-aug2026.sql spells "08:50-17:30, Mon-Fri" as a
-- generate_series plus an inline list of display names, and the next month's
-- schedule needs the whole thing retyped. Nothing in the database records what a
-- pattern *is*, so nothing can be asked "who is on the Ecuador weekday shift" or
-- "what time does Saturday open".
--
-- This migration gives a pattern a row.
--
--   schedule_templates          — the named pattern
--   schedule_template_segments  — one row per weekday it covers, with the times
--   schedule_template_members   — the standing roster the pattern applies to
--   apply_schedule_template()   — materialises the pattern into employee_schedules
--
-- employee_schedules stays exactly what it was: one row per employee per date, the
-- sole record of expected work that the attendance derivation reads (Requirement
-- 19, criterion 1). A template is a generator for those rows, never a substitute
-- for them, so no read path changes and no existing row means anything different
-- than it did before.
--
-- ── Times are business-timezone wall clocks ────────────────────────────────────
--
-- shift_start and shift_end are read in attendance_policy.business_timezone
-- (America/New_York), the same as the employee_schedules columns they populate.
-- A template does not carry a timezone of its own for the same reason a schedule
-- row does not: profiles.timezone is a display concern, applied after the fact by
-- ScheduleManager, and duplicating it here would create a second answer to the
-- question of when a shift starts.
--
-- ── The three seeded templates ────────────────────────────────────────────────
--
-- The Ecuador team arrives ten minutes before the office opens. Operations open at
-- 09:00 on a weekday, so the team starts at 08:50; operations open at 10:00 on a
-- Saturday, so the team starts at 09:50. That ten-minute lead is the rule, not a
-- coincidence of two numbers, and last Saturday's punches bear it out: the Ecuador
-- roster clocked in at 09:48-09:50 on 2026-08-01 while the US roster clocked in at
-- 10:02.
--
--   Ecuador Weekday             Mon-Fri  08:50-17:30
--   Ecuador Weekday + Saturday  Mon-Fri  08:50-17:30, Sat 09:50-17:30
--   Ecuador Saturday            Sat      09:50-17:30
--
-- Only "Ecuador Weekday" is seeded with members, because it is the only one of the
-- three that describes a standing roster. Saturday is a rotation: a different
-- subset of the team works each week, so the two Saturday templates are applied
-- with an explicit profile list and hold no permanent membership. Seeding them with
-- last month's rotation would state a roster that is wrong by the following week.
--
-- The membership is derived from the live schedule rows rather than transcribed
-- from v1.7.1, so it cannot disagree with what employees are actually working.
-- Majority rule on weekday rows is what excludes Alvaro Rivadeneira, a US-roster
-- hire who carries a single stray 08:50 row on 2026-08-07 against four 09:00 rows.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. TEMPLATES — the named pattern
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.schedule_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) > 0),
  description text,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists schedule_templates_touch_updated_at on public.schedule_templates;
create trigger schedule_templates_touch_updated_at
  before update on public.schedule_templates
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. SEGMENTS — one row per day of week the template covers
--
--    day_of_week follows extract(dow): 0 = Sunday through 6 = Saturday, the same
--    convention every schedule migration in this repository already filters on.
--    A day the template does not cover simply has no row, which is how "Mon-Fri"
--    and "Saturday only" are both expressed without a nullable flag per weekday.
--
--    The shift_type and status vocabularies are the employee_schedules ones,
--    repeated rather than referenced because Postgres has no shared domain here.
--    A value this table accepts and that table refuses would fail at apply time
--    instead of at seed time, so the two lists are kept identical deliberately.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.schedule_template_segments (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.schedule_templates(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  shift_start time not null,
  shift_end time not null,
  shift_type text not null default 'regular' check (shift_type in (
    'regular', 'overtime', 'half_day', 'training', 'on_call'
  )),
  notes text,
  constraint unique_segment_per_template_day unique (template_id, day_of_week)
);

create index if not exists idx_schedule_template_segments_template
  on public.schedule_template_segments(template_id, day_of_week);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. MEMBERS — the standing roster
--
--    A template with no members is not broken; it is a pattern applied to an
--    explicit list, which is what a weekly rotation needs.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.schedule_template_members (
  template_id uuid not null references public.schedule_templates(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  added_by uuid references public.profiles(id),
  added_at timestamptz not null default now(),
  primary key (template_id, profile_id)
);

create index if not exists idx_schedule_template_members_profile
  on public.schedule_template_members(profile_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. APPLY — materialise a template into employee_schedules
--
--    Returns a jsonb envelope rather than a bare count, so a caller learns which
--    template ran, over what range, for how many people, and how many rows each
--    of the two outcomes accounts for.
--
--    p_profile_ids null  → the template's standing members
--    p_profile_ids given → exactly those profiles, which is how a Saturday
--                          rotation is applied without storing a roster that
--                          changes every week
--
--    p_overwrite true  → an existing row for that employee and date is replaced
--    p_overwrite false → an existing row is left alone, so the call fills gaps
--                        without disturbing a hand-edited shift
--
--    Inactive profiles are skipped. Scheduling somebody who has left is the
--    mistake v1.7.1 guarded against with `where is_active = true` on every insert,
--    and it belongs in the function rather than in each caller.
--
--    security definer with a super_admin gate: employee_schedules writes are
--    super_admin-only (v1.6.2 narrowed the RLS, canAdministerAttendance mirrors it
--    in the application), and managing work schedules is one of the capabilities
--    reserved to super_admin rather than shared with manager.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.apply_schedule_template(
  p_template_name text,
  p_from date,
  p_to date,
  p_profile_ids uuid[] default null,
  p_overwrite boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '30s'
as $fn$
declare
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_template   public.schedule_templates%rowtype;
  v_targets    uuid[];
  v_inserted   integer := 0;
  v_updated    integer := 0;
begin
  -- ── The caller administers attendance, or nothing happens ───────────────────
  if v_actor is null then
    raise exception 'NOT_AUTHENTICATED: apply_schedule_template requires a signed-in caller.'
      using errcode = '42501',
            hint = 'Call through a user-scoped Supabase client. Nothing has been changed.';
  end if;

  select p.role::text into v_actor_role from public.profiles p where p.id = v_actor;

  if v_actor_role is distinct from 'super_admin' then
    raise exception 'NOT_AUTHORISED: only super_admin may apply a schedule template.'
      using errcode = '42501',
            detail = format('Caller %s holds role %s.', v_actor, coalesce(v_actor_role, 'none')),
            hint   = 'Managing work schedules is reserved to super_admin. Nothing has been changed.';
  end if;

  -- ── The template, the range ─────────────────────────────────────────────────
  select * into v_template
    from public.schedule_templates
   where name = btrim(coalesce(p_template_name, ''));

  if not found then
    raise exception 'TEMPLATE_NOT_FOUND: no schedule template named "%".', coalesce(p_template_name, 'null')
      using errcode = 'P0002', hint = 'Nothing has been changed.';
  end if;

  if not v_template.is_active then
    raise exception 'TEMPLATE_INACTIVE: template "%" is not active.', v_template.name
      using errcode = '22023', hint = 'Nothing has been changed.';
  end if;

  if p_from is null or p_to is null then
    raise exception 'RANGE_REQUIRED: applying a template names the first and last date it covers.'
      using errcode = '22023', hint = 'Nothing has been changed.';
  end if;

  if p_to < p_from then
    raise exception 'RANGE_INVERTED: p_to (%) precedes p_from (%).', p_to, p_from
      using errcode = '22023', hint = 'Nothing has been changed.';
  end if;

  if not exists (select 1 from public.schedule_template_segments where template_id = v_template.id) then
    raise exception 'TEMPLATE_EMPTY: template "%" covers no day of the week.', v_template.name
      using errcode = '22023',
            detail = 'A template with no segments would generate no shifts.',
            hint   = 'Nothing has been changed.';
  end if;

  -- ── Who it applies to ───────────────────────────────────────────────────────
  if p_profile_ids is null then
    select array_agg(m.profile_id)
      into v_targets
      from public.schedule_template_members m
      join public.profiles p on p.id = m.profile_id
     where m.template_id = v_template.id
       and p.is_active;
  else
    select array_agg(p.id)
      into v_targets
      from public.profiles p
     where p.id = any (p_profile_ids)
       and p.is_active;
  end if;

  if v_targets is null or cardinality(v_targets) = 0 then
    return jsonb_build_object(
      'ok', true,
      'template', v_template.name,
      'from', p_from,
      'to', p_to,
      'profiles', 0,
      'inserted', 0,
      'updated', 0,
      'code', 'no_targets'
    );
  end if;

  -- ── The rows ────────────────────────────────────────────────────────────────
  -- One statement per outcome so the two counts are honest: an upsert reports a
  -- single total that cannot say how many shifts were new.
  with candidate as (
    select
      t.profile_id,
      d.dt as schedule_date,
      seg.shift_start,
      seg.shift_end,
      seg.shift_type,
      seg.notes
    from unnest(v_targets) as t(profile_id)
    cross join generate_series(p_from, p_to, interval '1 day') as g(dt_ts)
    cross join lateral (select g.dt_ts::date as dt) d
    join public.schedule_template_segments seg
      on seg.template_id = v_template.id
     and seg.day_of_week = extract(dow from d.dt)::smallint
  ),
  changed as (
    update public.employee_schedules es
       set shift_start = c.shift_start,
           shift_end   = c.shift_end,
           shift_type  = c.shift_type,
           status      = 'published',
           notes       = coalesce(c.notes, es.notes)
      from candidate c
     where p_overwrite
       and es.profile_id = c.profile_id
       and es.schedule_date = c.schedule_date
       and (
         es.shift_start is distinct from c.shift_start
         or es.shift_end is distinct from c.shift_end
         or es.shift_type is distinct from c.shift_type
         or es.status is distinct from 'published'
       )
    returning 1
  )
  select count(*)::integer into v_updated from changed;

  with candidate as (
    select
      t.profile_id,
      d.dt as schedule_date,
      seg.shift_start,
      seg.shift_end,
      seg.shift_type,
      seg.notes
    from unnest(v_targets) as t(profile_id)
    cross join generate_series(p_from, p_to, interval '1 day') as g(dt_ts)
    cross join lateral (select g.dt_ts::date as dt) d
    join public.schedule_template_segments seg
      on seg.template_id = v_template.id
     and seg.day_of_week = extract(dow from d.dt)::smallint
  ),
  added as (
    insert into public.employee_schedules (
      profile_id, schedule_date, shift_start, shift_end,
      shift_type, status, notes, created_by
    )
    select
      c.profile_id, c.schedule_date, c.shift_start, c.shift_end,
      c.shift_type, 'published', c.notes, v_actor
    from candidate c
    on conflict (profile_id, schedule_date) do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from added;

  return jsonb_build_object(
    'ok', true,
    'template', v_template.name,
    'from', p_from,
    'to', p_to,
    'profiles', cardinality(v_targets),
    'inserted', v_inserted,
    'updated', v_updated,
    'overwrite', p_overwrite
  );
end;
$fn$;

comment on function public.apply_schedule_template(text, date, date, uuid[], boolean) is
  'Materialise a named schedule template into employee_schedules over a date range. '
  'super_admin only. p_profile_ids null applies to the template''s standing members; '
  'a non-null list applies to exactly those profiles, which is how a Saturday '
  'rotation is scheduled without storing a roster that changes weekly.';

revoke all on function public.apply_schedule_template(text, date, date, uuid[], boolean) from public;
grant execute on function public.apply_schedule_template(text, date, date, uuid[], boolean) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. ROW LEVEL SECURITY
--
--    Every signed-in user reads: an employee seeing "Ecuador Weekday, 08:50-17:30"
--    next to their own shift is the point of naming the pattern. Writes are
--    super_admin only, matching employee_schedules and canAdministerAttendance.
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.schedule_templates enable row level security;
alter table public.schedule_template_segments enable row level security;
alter table public.schedule_template_members enable row level security;

drop policy if exists "schedule_templates_select" on public.schedule_templates;
create policy "schedule_templates_select" on public.schedule_templates
  for select to authenticated using (true);

drop policy if exists "schedule_templates_admin_all" on public.schedule_templates;
create policy "schedule_templates_admin_all" on public.schedule_templates
  for all to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'super_admin')
  with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "schedule_template_segments_select" on public.schedule_template_segments;
create policy "schedule_template_segments_select" on public.schedule_template_segments
  for select to authenticated using (true);

drop policy if exists "schedule_template_segments_admin_all" on public.schedule_template_segments;
create policy "schedule_template_segments_admin_all" on public.schedule_template_segments
  for all to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'super_admin')
  with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "schedule_template_members_select" on public.schedule_template_members;
create policy "schedule_template_members_select" on public.schedule_template_members
  for select to authenticated using (true);

drop policy if exists "schedule_template_members_admin_all" on public.schedule_template_members;
create policy "schedule_template_members_admin_all" on public.schedule_template_members
  for all to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'super_admin')
  with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. SEED — the three Ecuador templates
-- ═══════════════════════════════════════════════════════════════════════════════
do $seed$
declare
  v_admin uuid;
  v_weekday uuid;
  v_weekday_sat uuid;
  v_saturday uuid;
  v_members integer;
begin
  select id into v_admin
    from public.profiles
   where role = 'super_admin' and is_active
   order by display_name
   limit 1;

  -- ── The three patterns ──────────────────────────────────────────────────────
  insert into public.schedule_templates (name, description, created_by) values
    ('Ecuador Weekday',
     'Ecuador roster, Monday to Friday. Operations open at 09:00; the team arrives ten minutes early at 08:50.',
     v_admin),
    ('Ecuador Weekday + Saturday',
     'Ecuador roster working a six-day week. Monday to Friday 08:50, Saturday 09:50 against the 10:00 Saturday open.',
     v_admin),
    ('Ecuador Saturday',
     'Saturday only, for the weekly Saturday rotation. Operations open at 10:00; the team arrives at 09:50.',
     v_admin)
  on conflict (name) do update
     set description = excluded.description,
         is_active = true;

  select id into v_weekday     from public.schedule_templates where name = 'Ecuador Weekday';
  select id into v_weekday_sat from public.schedule_templates where name = 'Ecuador Weekday + Saturday';
  select id into v_saturday    from public.schedule_templates where name = 'Ecuador Saturday';

  -- ── Segments. Rewritten from scratch on re-run, so the seed is the whole
  --    truth about each pattern rather than a layer over whatever was there.
  delete from public.schedule_template_segments
   where template_id in (v_weekday, v_weekday_sat, v_saturday);

  -- Ecuador Weekday: Mon(1) .. Fri(5), 08:50-17:30
  insert into public.schedule_template_segments (template_id, day_of_week, shift_start, shift_end, shift_type)
  select v_weekday, dow::smallint, '08:50'::time, '17:30'::time, 'regular'
    from generate_series(1, 5) as dow;

  -- Ecuador Weekday + Saturday: the weekday pattern plus Sat(6) 09:50-17:30
  insert into public.schedule_template_segments (template_id, day_of_week, shift_start, shift_end, shift_type)
  select v_weekday_sat, dow::smallint, '08:50'::time, '17:30'::time, 'regular'
    from generate_series(1, 5) as dow;

  insert into public.schedule_template_segments (template_id, day_of_week, shift_start, shift_end, shift_type, notes)
  values (v_weekday_sat, 6, '09:50'::time, '17:30'::time, 'regular', 'Saturday rotation');

  -- Ecuador Saturday: Sat(6) only, 09:50-17:30
  insert into public.schedule_template_segments (template_id, day_of_week, shift_start, shift_end, shift_type, notes)
  values (v_saturday, 6, '09:50'::time, '17:30'::time, 'regular', 'Saturday rotation');

  -- ── Members of the standing weekday pattern ─────────────────────────────────
  -- Derived from the live rows: an active profile whose weekday shifts in the
  -- currently scheduled horizon are mostly 08:50 is on the Ecuador weekday shift.
  -- Majority rather than existence, so one stray row does not enrol a US-roster
  -- employee (Alvaro Rivadeneira, 08:50 once on 2026-08-07 against four 09:00s).
  insert into public.schedule_template_members (template_id, profile_id, added_by)
  select v_weekday, s.profile_id, v_admin
    from public.employee_schedules s
    join public.profiles p on p.id = s.profile_id
   where p.is_active
     and extract(dow from s.schedule_date) between 1 and 5
     and s.schedule_date between '2026-07-27' and '2026-08-31'
   group by s.profile_id
  having count(*) filter (where s.shift_start = '08:50'::time)
       > count(*) filter (where s.shift_start <> '08:50'::time)
  on conflict (template_id, profile_id) do nothing;

  select count(*) into v_members
    from public.schedule_template_members where template_id = v_weekday;

  raise notice 'Ecuador Weekday seeded with % members.', v_members;

  -- The two Saturday templates hold no members on purpose: Saturday is a weekly
  -- rotation, applied with an explicit profile list.
end;
$seed$;

commit;

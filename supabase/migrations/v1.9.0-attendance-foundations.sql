-- New Hope Work Desk v1.9.0 — Time & Attendance foundations (migration stage 1 of 6)
--
-- Spec: .kiro/specs/time-attendance-ui-redesign
-- Requirements: 16.1, 16.2, 16.5, 23.1, 23.2, 23.8
--
-- Forward-only. Adds five new tables and one trigger function. Touches no existing
-- table, no existing column, no existing policy, and no existing row. Nothing in
-- time_clock_entries, time_clock_breaks, employee_schedules, pto_requests,
-- pto_balances, payroll_periods, payroll_summaries, or audit_log is read, written,
-- or deleted by this migration.
--
-- Contents:
--   1. attendance_policy          singleton row owning the Status Rule Matrix tolerances
--   2. attendance_closed_dates    dates the organisation is closed
--   3. attendance_notes           manager notes, one row per note per employee per work date
--   4. attendance_day_reviews     review status, composite primary key (profile_id, work_date)
--   5. attendance_audit_log       append-only attendance audit trail plus three indexes
--   6. attendance_audit_immutable() trigger refusing update and delete on the audit log
--   7. RLS for all five tables. The audit log gets select and insert only; it has no
--      update policy and no delete policy.
--
-- Attendance administration is super_admin only, matching canAdministerAttendance in
-- src/lib/permissions.ts and v1.6.2-enforce-scoped-supervisor-access.sql. No policy in
-- this file checks the role manager, and manager gains no attendance capability here.
--
-- ROLLBACK PATH (Requirement 23, criterion 8)
--   begin;
--     drop trigger if exists attendance_audit_no_update on public.attendance_audit_log;
--     drop function if exists public.attendance_audit_immutable();
--     drop table if exists public.attendance_audit_log;
--     drop table if exists public.attendance_day_reviews;
--     drop table if exists public.attendance_notes;
--     drop table if exists public.attendance_closed_dates;
--     drop table if exists public.attendance_policy;
--   commit;
--   Dropping the five tables drops their indexes, policies, and the audit trigger with
--   them. No pre-existing row is touched by the rollback, because none was touched by
--   the migration.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. ATTENDANCE POLICY — single row. Owns the tolerances the Status Rule Matrix
--    refers to, so the derivation rules have exactly one source of configuration.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.attendance_policy (
  singleton_key boolean primary key default true check (singleton_key),
  business_timezone text not null default 'America/New_York',
  grace_period_minutes integer not null default 5 check (grace_period_minutes >= 0),
  early_departure_tolerance_minutes integer not null default 15 check (early_departure_tolerance_minutes >= 0),
  missing_clock_out_tolerance_minutes integer not null default 120 check (missing_clock_out_tolerance_minutes >= 0),
  break_overrun_minutes integer not null default 60 check (break_overrun_minutes >= 0),
  unpaid_break_types text[] not null default array['lunch'],
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

-- Seed the singleton with the documented defaults so the policy loader always finds a row.
insert into public.attendance_policy (singleton_key) values (true)
on conflict (singleton_key) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CLOSED DATES — dates the organisation is not open. Feeds the Health Ribbon's
--    Closed state and the working-day count used for time-off balances.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.attendance_closed_dates (
  closed_date date primary key,
  label text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. ATTENDANCE NOTES — manager notes, one row per note per employee per work date.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.attendance_notes (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  work_date date not null,
  note text not null check (length(btrim(note)) > 0),
  author_profile_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_attendance_notes_profile_date
  on public.attendance_notes(profile_id, work_date);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. DAY REVIEWS — review status. The composite primary key is what makes marking a
--    day reviewed idempotent and what retains the first reviewer and timestamp.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.attendance_day_reviews (
  profile_id uuid not null references public.profiles(id),
  work_date date not null,
  reviewed_by uuid not null references public.profiles(id),
  reviewed_at timestamptz not null default now(),
  primary key (profile_id, work_date)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. ATTENDANCE AUDIT LOG — append-only. Carries the employee, work date, and
--    payroll period columns that public.audit_log lacks (Requirement 16, criterion 2).
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.attendance_audit_log (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id),        -- affected employee
  work_date date,                                        -- affected work date
  entity_type text not null,                             -- clock_entry | break | schedule | pto_request | review | payroll_period
  entity_id uuid,
  action text not null,                                  -- correct_punch | add_punch | approve_unscheduled | add_note
                                                         -- | mark_reviewed | pto_decision | coverage_override | payroll_process
  field text,                                            -- changed field when the action changes one
  old_value jsonb,
  new_value jsonb,
  actor_profile_id uuid not null references public.profiles(id),
  reason text,
  payroll_period_id uuid references public.payroll_periods(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_attendance_audit_profile_date
  on public.attendance_audit_log(profile_id, work_date desc);

create index if not exists idx_attendance_audit_created
  on public.attendance_audit_log(created_at desc);

create index if not exists idx_attendance_audit_actor
  on public.attendance_audit_log(actor_profile_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. IMMUTABILITY (Requirement 16, criterion 5)
--    Enforced twice. RLS below grants select and insert only, with no update policy
--    and no delete policy. This trigger refuses the operation even on a
--    security definer path, which is what the stage-5 mutation functions run on and
--    which would otherwise bypass RLS entirely.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.attendance_audit_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'attendance_audit_log is append-only';
end;
$$;

drop trigger if exists attendance_audit_no_update on public.attendance_audit_log;
create trigger attendance_audit_no_update
  before update or delete on public.attendance_audit_log
  for each row execute function public.attendance_audit_immutable();

-- A third layer at the privilege level, so a client-role attempt fails loudly rather
-- than matching zero rows under RLS. service_role is left to the trigger above.
revoke update, delete on public.attendance_audit_log from authenticated;
revoke update, delete on public.attendance_audit_log from anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. ROW LEVEL SECURITY
--    Administration is super_admin only. The two configuration tables are readable by
--    every signed-in user because My Day, the Health Ribbon, and the working-day count
--    all need them; the three record tables are administrator-only.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── attendance_policy: everyone reads, super_admin writes. No delete policy: the
--    singleton is edited, never removed.
alter table public.attendance_policy enable row level security;

drop policy if exists "attendance_policy_select" on public.attendance_policy;
create policy "attendance_policy_select" on public.attendance_policy
  for select to authenticated
  using (true);

drop policy if exists "attendance_policy_admin_insert" on public.attendance_policy;
create policy "attendance_policy_admin_insert" on public.attendance_policy
  for insert to authenticated
  with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "attendance_policy_admin_update" on public.attendance_policy;
create policy "attendance_policy_admin_update" on public.attendance_policy
  for update to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'super_admin')
  with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

-- ── attendance_closed_dates: everyone reads, super_admin maintains.
alter table public.attendance_closed_dates enable row level security;

drop policy if exists "attendance_closed_dates_select" on public.attendance_closed_dates;
create policy "attendance_closed_dates_select" on public.attendance_closed_dates
  for select to authenticated
  using (true);

drop policy if exists "attendance_closed_dates_admin_all" on public.attendance_closed_dates;
create policy "attendance_closed_dates_admin_all" on public.attendance_closed_dates
  for all to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'super_admin')
  with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

-- ── attendance_notes: administrator-only, append-only. No update policy and no
--    delete policy; a note is a record of what was observed.
alter table public.attendance_notes enable row level security;

drop policy if exists "attendance_notes_admin_select" on public.attendance_notes;
create policy "attendance_notes_admin_select" on public.attendance_notes
  for select to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "attendance_notes_admin_insert" on public.attendance_notes;
create policy "attendance_notes_admin_insert" on public.attendance_notes
  for insert to authenticated
  with check (
    author_profile_id = auth.uid()
    and (select role from public.profiles where id = auth.uid()) = 'super_admin'
  );

-- ── attendance_day_reviews: administrator-only, append-only. No update policy and no
--    delete policy, so the first reviewer and timestamp stand.
alter table public.attendance_day_reviews enable row level security;

drop policy if exists "attendance_day_reviews_admin_select" on public.attendance_day_reviews;
create policy "attendance_day_reviews_admin_select" on public.attendance_day_reviews
  for select to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "attendance_day_reviews_admin_insert" on public.attendance_day_reviews;
create policy "attendance_day_reviews_admin_insert" on public.attendance_day_reviews
  for insert to authenticated
  with check (
    reviewed_by = auth.uid()
    and (select role from public.profiles where id = auth.uid()) = 'super_admin'
  );

-- ── attendance_audit_log: select and insert only. Deliberately no update policy and
--    no delete policy (Requirement 16, criterion 5).
alter table public.attendance_audit_log enable row level security;

drop policy if exists "attendance_audit_admin_select" on public.attendance_audit_log;
create policy "attendance_audit_admin_select" on public.attendance_audit_log
  for select to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "attendance_audit_admin_insert" on public.attendance_audit_log;
create policy "attendance_audit_admin_insert" on public.attendance_audit_log
  for insert to authenticated
  with check (
    actor_profile_id = auth.uid()
    and (select role from public.profiles where id = auth.uid()) = 'super_admin'
  );

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
select
  (select count(*) from pg_tables
     where schemaname = 'public'
       and tablename in ('attendance_policy', 'attendance_closed_dates',
                         'attendance_notes', 'attendance_day_reviews',
                         'attendance_audit_log')) as tables_created,
  (select count(*) from pg_indexes
     where schemaname = 'public'
       and indexname in ('idx_attendance_audit_profile_date',
                         'idx_attendance_audit_created',
                         'idx_attendance_audit_actor')) as audit_indexes,
  (select count(*) from pg_trigger
     where tgname = 'attendance_audit_no_update' and not tgisinternal) as audit_triggers,
  (select count(*) from pg_policies
     where schemaname = 'public'
       and tablename in ('attendance_policy', 'attendance_closed_dates',
                         'attendance_notes', 'attendance_day_reviews',
                         'attendance_audit_log')) as policies,
  (select count(*) from pg_policies
     where schemaname = 'public'
       and tablename = 'attendance_audit_log'
       and cmd in ('UPDATE', 'DELETE')) as audit_write_policies_must_be_zero;

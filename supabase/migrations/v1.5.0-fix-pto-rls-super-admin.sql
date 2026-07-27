-- v1.5.0 Fix RLS policies for super_admin on time-attendance tables
--
-- Problem: RLS policies in v1.2.0 only check role = 'manager', but super_admin
-- also needs full access to pto_balances, pto_requests, time_clock_entries,
-- employee_schedules, payroll_periods, payroll_summaries, employee_payment_settings.

begin;

-- ─── pto_balances ─────────────────────────────────────────────────────────────
drop policy if exists "pto_balances_select" on public.pto_balances;
drop policy if exists "pto_balances_manager_all" on public.pto_balances;

create policy "pto_balances_select" on public.pto_balances
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

create policy "pto_balances_admin_all" on public.pto_balances
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ─── pto_requests ─────────────────────────────────────────────────────────────
drop policy if exists "pto_requests_select" on public.pto_requests;
drop policy if exists "pto_requests_insert" on public.pto_requests;
drop policy if exists "pto_requests_manager_all" on public.pto_requests;

create policy "pto_requests_select" on public.pto_requests
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

create policy "pto_requests_insert" on public.pto_requests
  for insert to authenticated
  with check (profile_id = auth.uid());

create policy "pto_requests_admin_all" on public.pto_requests
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ─── time_clock_entries ───────────────────────────────────────────────────────
drop policy if exists "time_clock_select" on public.time_clock_entries;
drop policy if exists "time_clock_insert" on public.time_clock_entries;
drop policy if exists "time_clock_update" on public.time_clock_entries;
drop policy if exists "time_clock_manager_all" on public.time_clock_entries;

create policy "time_clock_select" on public.time_clock_entries
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

create policy "time_clock_insert" on public.time_clock_entries
  for insert to authenticated
  with check (profile_id = auth.uid());

create policy "time_clock_admin_all" on public.time_clock_entries
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ─── employee_schedules ───────────────────────────────────────────────────────
drop policy if exists "schedules_select" on public.employee_schedules;
drop policy if exists "schedules_manager_all" on public.employee_schedules;

create policy "schedules_select" on public.employee_schedules
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

create policy "schedules_admin_all" on public.employee_schedules
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ─── payroll_periods ──────────────────────────────────────────────────────────
drop policy if exists "payroll_periods_select" on public.payroll_periods;
drop policy if exists "payroll_periods_manager_all" on public.payroll_periods;

create policy "payroll_periods_select" on public.payroll_periods
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

create policy "payroll_periods_admin_all" on public.payroll_periods
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ─── payroll_summaries ────────────────────────────────────────────────────────
drop policy if exists "payroll_summaries_select" on public.payroll_summaries;
drop policy if exists "payroll_summaries_manager_all" on public.payroll_summaries;

create policy "payroll_summaries_select" on public.payroll_summaries
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

create policy "payroll_summaries_admin_all" on public.payroll_summaries
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ─── employee_payment_settings ────────────────────────────────────────────────
drop policy if exists "payment_settings_select" on public.employee_payment_settings;
drop policy if exists "payment_settings_manager_all" on public.employee_payment_settings;

create policy "payment_settings_select" on public.employee_payment_settings
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

create policy "payment_settings_admin_all" on public.employee_payment_settings
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ─── time_clock_breaks ────────────────────────────────────────────────────────
drop policy if exists "time_clock_breaks_select" on public.time_clock_breaks;
drop policy if exists "time_clock_breaks_insert" on public.time_clock_breaks;
drop policy if exists "time_clock_breaks_update" on public.time_clock_breaks;
drop policy if exists "time_clock_breaks_manager_all" on public.time_clock_breaks;

create policy "time_clock_breaks_select" on public.time_clock_breaks
  for select to authenticated
  using (true);

create policy "time_clock_breaks_insert" on public.time_clock_breaks
  for insert to authenticated
  with check (true);

create policy "time_clock_breaks_admin_all" on public.time_clock_breaks
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

commit;

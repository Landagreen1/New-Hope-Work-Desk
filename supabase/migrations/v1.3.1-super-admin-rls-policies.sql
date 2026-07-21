-- New Hope Work Desk v1.3.1 — Super Admin RLS Policy Updates
-- Grants super_admin the same row-level access as manager on time-attendance tables.
-- Must be applied AFTER v1.3.0-super-admin-role.sql (enum value committed).

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- TIME CLOCK ENTRIES — allow super_admin same access as manager
-- ═══════════════════════════════════════════════════════════════════════════════

drop policy if exists "time_clock_own_select" on public.time_clock_entries;
create policy "time_clock_own_select" on public.time_clock_entries
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

drop policy if exists "time_clock_own_insert" on public.time_clock_entries;
create policy "time_clock_own_insert" on public.time_clock_entries
  for insert to authenticated
  with check (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

drop policy if exists "time_clock_own_update" on public.time_clock_entries;
create policy "time_clock_own_update" on public.time_clock_entries
  for update to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- TIME CLOCK BREAKS — allow super_admin same access as manager
-- ═══════════════════════════════════════════════════════════════════════════════

drop policy if exists "time_clock_breaks_select" on public.time_clock_breaks;
create policy "time_clock_breaks_select" on public.time_clock_breaks
  for select to authenticated
  using (
    exists (
      select 1 from public.time_clock_entries e
      where e.id = time_clock_breaks.clock_entry_id
        and (e.profile_id = auth.uid() or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin'))
    )
  );

drop policy if exists "time_clock_breaks_insert" on public.time_clock_breaks;
create policy "time_clock_breaks_insert" on public.time_clock_breaks
  for insert to authenticated
  with check (
    exists (
      select 1 from public.time_clock_entries e
      where e.id = time_clock_breaks.clock_entry_id
        and (e.profile_id = auth.uid() or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin'))
    )
  );

drop policy if exists "time_clock_breaks_update" on public.time_clock_breaks;
create policy "time_clock_breaks_update" on public.time_clock_breaks
  for update to authenticated
  using (
    exists (
      select 1 from public.time_clock_entries e
      where e.id = time_clock_breaks.clock_entry_id
        and (e.profile_id = auth.uid() or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin'))
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- EMPLOYEE SCHEDULES — allow super_admin same access as manager
-- ═══════════════════════════════════════════════════════════════════════════════

drop policy if exists "schedules_select" on public.employee_schedules;
create policy "schedules_select" on public.employee_schedules
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

drop policy if exists "schedules_insert" on public.employee_schedules;
create policy "schedules_insert" on public.employee_schedules
  for insert to authenticated
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

drop policy if exists "schedules_update" on public.employee_schedules;
create policy "schedules_update" on public.employee_schedules
  for update to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- PTO REQUESTS — allow super_admin to review/manage
-- ═══════════════════════════════════════════════════════════════════════════════

drop policy if exists "pto_requests_select" on public.pto_requests;
create policy "pto_requests_select" on public.pto_requests
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

drop policy if exists "pto_requests_insert" on public.pto_requests;
create policy "pto_requests_insert" on public.pto_requests
  for insert to authenticated
  with check (profile_id = auth.uid());

drop policy if exists "pto_requests_update" on public.pto_requests;
create policy "pto_requests_update" on public.pto_requests
  for update to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- EMPLOYEE PAYMENT SETTINGS — allow super_admin to manage
-- ═══════════════════════════════════════════════════════════════════════════════

drop policy if exists "payment_settings_select" on public.employee_payment_settings;
create policy "payment_settings_select" on public.employee_payment_settings
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

drop policy if exists "payment_settings_upsert" on public.employee_payment_settings;
create policy "payment_settings_upsert" on public.employee_payment_settings
  for insert to authenticated
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

drop policy if exists "payment_settings_update" on public.employee_payment_settings;
create policy "payment_settings_update" on public.employee_payment_settings
  for update to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- PAYROLL PERIODS & SUMMARIES — allow super_admin to manage
-- ═══════════════════════════════════════════════════════════════════════════════

drop policy if exists "payroll_periods_select" on public.payroll_periods;
create policy "payroll_periods_select" on public.payroll_periods
  for select to authenticated
  using (true);

drop policy if exists "payroll_periods_manage" on public.payroll_periods;
create policy "payroll_periods_manage" on public.payroll_periods
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

drop policy if exists "payroll_summaries_select" on public.payroll_summaries;
create policy "payroll_summaries_select" on public.payroll_summaries
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

drop policy if exists "payroll_summaries_manage" on public.payroll_summaries;
create policy "payroll_summaries_manage" on public.payroll_summaries
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- STAFFING THRESHOLDS — allow super_admin to manage
-- ═══════════════════════════════════════════════════════════════════════════════

drop policy if exists "staffing_thresholds_select" on public.staffing_thresholds;
create policy "staffing_thresholds_select" on public.staffing_thresholds
  for select to authenticated
  using (true);

drop policy if exists "staffing_thresholds_manage" on public.staffing_thresholds;
create policy "staffing_thresholds_manage" on public.staffing_thresholds
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

commit;

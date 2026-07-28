-- v1.7.0 Purge all test clock-in, payroll, and PTO data
-- This removes testing data that was generated during development.

begin;

-- Delete payroll summaries first (FK to payroll_periods)
delete from public.payroll_summaries;

-- Delete payroll periods
delete from public.payroll_periods;

-- Delete time clock breaks (FK to time_clock_entries)
delete from public.time_clock_breaks;

-- Delete time clock entries
delete from public.time_clock_entries;

-- Delete PTO requests
delete from public.pto_requests;

-- Reset PTO balances (zero out used counts)
update public.pto_balances
set vacation_used = 0,
    sick_used = 0,
    personal_used = 0;

-- Delete existing schedules (we'll re-create from new data)
delete from public.employee_schedules;

commit;

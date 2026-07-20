-- New Hope Work Desk v1.2.0 — Time & Attendance Module
-- Clock in/out, scheduling, PTO requests, payroll periods, staffing coverage.
--
-- Features:
--   - Clock in/out with status tracking (available, lunch, unavailable)
--   - Manager-assigned work schedules (shifts)
--   - PTO/vacation requests with approval workflow
--   - Payroll period management with multiple payment templates
--   - Department staffing coverage thresholds with real-time warnings
--   - Agent-visible payroll summaries

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. TIME CLOCK ENTRIES — individual clock in/out records
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.time_clock_entries (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),

  -- Clock times
  clock_in timestamptz not null default now(),
  clock_out timestamptz,

  -- Status at clock-in (maps to existing availability_status)
  clock_status text not null default 'available' check (clock_status in (
    'available', 'lunch', 'unavailable'
  )),

  -- Break tracking (accumulated minutes during this entry)
  break_minutes integer not null default 0,

  -- Calculated total hours (set on clock_out, null while clocked in)
  total_hours numeric(6,2),

  -- Overtime flag (calculated)
  is_overtime boolean not null default false,

  -- Notes (late arrival reason, early departure, etc.)
  notes text,

  -- Manager adjustments
  adjusted_by uuid references public.profiles(id),
  adjustment_reason text,

  -- Metadata
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_time_clock_profile_date
  on public.time_clock_entries(profile_id, clock_in desc);

create index if not exists idx_time_clock_active
  on public.time_clock_entries(profile_id)
  where clock_out is null;

drop trigger if exists time_clock_entries_touch_updated_at on public.time_clock_entries;
create trigger time_clock_entries_touch_updated_at
  before update on public.time_clock_entries
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. BREAK LOG — track individual breaks within a clock entry
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.time_clock_breaks (
  id uuid primary key default gen_random_uuid(),
  clock_entry_id uuid not null references public.time_clock_entries(id) on delete cascade,
  break_start timestamptz not null default now(),
  break_end timestamptz,
  break_type text not null default 'lunch' check (break_type in ('lunch', 'short', 'personal')),
  duration_minutes integer  -- calculated on break_end
);

create index if not exists idx_time_clock_breaks_entry
  on public.time_clock_breaks(clock_entry_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. EMPLOYEE SCHEDULES — manager-assigned shifts
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.employee_schedules (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  schedule_date date not null,

  -- Shift times
  shift_start time not null,
  shift_end time not null,

  -- Shift metadata
  shift_type text not null default 'regular' check (shift_type in (
    'regular', 'overtime', 'half_day', 'training', 'on_call'
  )),

  -- Status
  status text not null default 'scheduled' check (status in (
    'scheduled', 'published', 'completed', 'missed', 'cancelled'
  )),

  -- Notes from manager
  notes text,

  -- Who created/modified
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Prevent duplicate shifts per person per day
  constraint unique_schedule_per_person_day unique (profile_id, schedule_date)
);

create index if not exists idx_employee_schedules_date
  on public.employee_schedules(schedule_date, profile_id);

create index if not exists idx_employee_schedules_profile
  on public.employee_schedules(profile_id, schedule_date);

drop trigger if exists employee_schedules_touch_updated_at on public.employee_schedules;
create trigger employee_schedules_touch_updated_at
  before update on public.employee_schedules
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. PTO REQUESTS — vacation, sick, personal time off
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.pto_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),

  -- Request details
  pto_type text not null check (pto_type in (
    'vacation', 'sick', 'personal', 'bereavement', 'unpaid'
  )),
  start_date date not null,
  end_date date not null,
  total_days numeric(4,1) not null,  -- supports half days
  reason text,

  -- Approval workflow
  status text not null default 'pending' check (status in (
    'pending', 'approved', 'denied', 'cancelled'
  )),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  denial_reason text,

  -- Metadata
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Validation
  constraint pto_end_after_start check (end_date >= start_date)
);

create index if not exists idx_pto_requests_profile
  on public.pto_requests(profile_id, start_date);

create index if not exists idx_pto_requests_pending
  on public.pto_requests(status)
  where status = 'pending';

drop trigger if exists pto_requests_touch_updated_at on public.pto_requests;
create trigger pto_requests_touch_updated_at
  before update on public.pto_requests
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. PTO BALANCES — annual allocation and running balance per employee
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.pto_balances (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  year integer not null,

  -- Allocations (set by manager)
  vacation_days numeric(5,1) not null default 10,
  sick_days numeric(5,1) not null default 5,
  personal_days numeric(5,1) not null default 3,

  -- Used (calculated from approved PTO requests)
  vacation_used numeric(5,1) not null default 0,
  sick_used numeric(5,1) not null default 0,
  personal_used numeric(5,1) not null default 0,

  -- Carryover from previous year
  carryover_days numeric(5,1) not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint unique_pto_balance_per_year unique (profile_id, year)
);

drop trigger if exists pto_balances_touch_updated_at on public.pto_balances;
create trigger pto_balances_touch_updated_at
  before update on public.pto_balances
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. PAYROLL PERIODS — configurable pay cycles
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.payroll_periods (
  id uuid primary key default gen_random_uuid(),

  -- Period definition
  period_start date not null,
  period_end date not null,
  pay_date date not null,

  -- Template type this period belongs to
  payment_template text not null check (payment_template in (
    'monthly', 'biweekly', 'semi_monthly'
  )),

  -- Status
  status text not null default 'open' check (status in (
    'open', 'locked', 'processed', 'paid'
  )),

  -- Who finalized
  processed_by uuid references public.profiles(id),
  processed_at timestamptz,

  created_at timestamptz not null default now(),

  constraint payroll_period_valid_dates check (period_end >= period_start and pay_date >= period_end)
);

create index if not exists idx_payroll_periods_dates
  on public.payroll_periods(period_start, period_end);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. EMPLOYEE PAYMENT SETTINGS — per-employee payment method/template
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.employee_payment_settings (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) unique,

  -- Payment template
  payment_template text not null default 'biweekly' check (payment_template in (
    'monthly', 'biweekly', 'semi_monthly'
  )),

  -- Pay rate
  hourly_rate numeric(8,2),
  salary_amount numeric(10,2),
  pay_type text not null default 'hourly' check (pay_type in ('hourly', 'salary')),

  -- Overtime rules
  overtime_multiplier numeric(3,2) not null default 1.50,
  weekly_overtime_threshold integer not null default 40,
  daily_overtime_threshold integer,  -- null means no daily OT rule

  -- Deductions / additions (stored as JSON for flexibility)
  deductions jsonb default '[]'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists employee_payment_settings_touch_updated_at on public.employee_payment_settings;
create trigger employee_payment_settings_touch_updated_at
  before update on public.employee_payment_settings
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. PAYROLL SUMMARIES — per-employee per-period calculated totals
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.payroll_summaries (
  id uuid primary key default gen_random_uuid(),
  payroll_period_id uuid not null references public.payroll_periods(id),
  profile_id uuid not null references public.profiles(id),

  -- Hours
  regular_hours numeric(6,2) not null default 0,
  overtime_hours numeric(6,2) not null default 0,
  break_hours numeric(6,2) not null default 0,
  total_hours numeric(6,2) not null default 0,

  -- PTO used in this period
  pto_days_used numeric(4,1) not null default 0,
  pto_hours_paid numeric(6,2) not null default 0,

  -- Pay calculation
  regular_pay numeric(10,2) not null default 0,
  overtime_pay numeric(10,2) not null default 0,
  pto_pay numeric(10,2) not null default 0,
  gross_pay numeric(10,2) not null default 0,
  deductions_total numeric(10,2) not null default 0,
  net_pay numeric(10,2) not null default 0,

  -- Days worked / missed
  days_worked integer not null default 0,
  days_absent integer not null default 0,
  days_late integer not null default 0,

  -- Status
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'paid')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint unique_payroll_summary unique (payroll_period_id, profile_id)
);

create index if not exists idx_payroll_summaries_period
  on public.payroll_summaries(payroll_period_id);

create index if not exists idx_payroll_summaries_profile
  on public.payroll_summaries(profile_id);

drop trigger if exists payroll_summaries_touch_updated_at on public.payroll_summaries;
create trigger payroll_summaries_touch_updated_at
  before update on public.payroll_summaries
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. STAFFING COVERAGE THRESHOLDS — minimum headcount per department
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.staffing_thresholds (
  id uuid primary key default gen_random_uuid(),
  department text not null check (department in (
    'sales', 'customer_service', 'commercial', 'management'
  )),
  day_of_week integer not null check (day_of_week between 0 and 6),  -- 0=Sunday
  time_slot text not null default 'full_day' check (time_slot in (
    'morning', 'afternoon', 'full_day'
  )),
  minimum_staff integer not null default 1,
  warning_threshold integer not null default 2,  -- warn when at or below this

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint unique_threshold_per_slot unique (department, day_of_week, time_slot)
);

drop trigger if exists staffing_thresholds_touch_updated_at on public.staffing_thresholds;
create trigger staffing_thresholds_touch_updated_at
  before update on public.staffing_thresholds
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════════

-- Time Clock Entries
alter table public.time_clock_entries enable row level security;

create policy "time_clock_own_select" on public.time_clock_entries
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) = 'manager'
  );

create policy "time_clock_own_insert" on public.time_clock_entries
  for insert to authenticated
  with check (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) = 'manager'
  );

create policy "time_clock_own_update" on public.time_clock_entries
  for update to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- Time Clock Breaks
alter table public.time_clock_breaks enable row level security;

create policy "time_clock_breaks_select" on public.time_clock_breaks
  for select to authenticated
  using (
    exists (
      select 1 from public.time_clock_entries e
      where e.id = time_clock_breaks.clock_entry_id
        and (e.profile_id = auth.uid() or (select role from public.profiles where id = auth.uid()) = 'manager')
    )
  );

create policy "time_clock_breaks_insert" on public.time_clock_breaks
  for insert to authenticated
  with check (
    exists (
      select 1 from public.time_clock_entries e
      where e.id = time_clock_breaks.clock_entry_id
        and (e.profile_id = auth.uid() or (select role from public.profiles where id = auth.uid()) = 'manager')
    )
  );

create policy "time_clock_breaks_update" on public.time_clock_breaks
  for update to authenticated
  using (
    exists (
      select 1 from public.time_clock_entries e
      where e.id = time_clock_breaks.clock_entry_id
        and (e.profile_id = auth.uid() or (select role from public.profiles where id = auth.uid()) = 'manager')
    )
  );

-- Employee Schedules
alter table public.employee_schedules enable row level security;

create policy "schedules_select" on public.employee_schedules
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) = 'manager'
  );

create policy "schedules_manager_all" on public.employee_schedules
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- PTO Requests
alter table public.pto_requests enable row level security;

create policy "pto_own_select" on public.pto_requests
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) = 'manager'
  );

create policy "pto_own_insert" on public.pto_requests
  for insert to authenticated
  with check (profile_id = auth.uid());

create policy "pto_own_update" on public.pto_requests
  for update to authenticated
  using (
    (profile_id = auth.uid() and status = 'pending')
    or (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- PTO Balances
alter table public.pto_balances enable row level security;

create policy "pto_balances_select" on public.pto_balances
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) = 'manager'
  );

create policy "pto_balances_manager_all" on public.pto_balances
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- Payroll Periods (manager only)
alter table public.payroll_periods enable row level security;

create policy "payroll_periods_select" on public.payroll_periods
  for select to authenticated
  using (true);  -- everyone can see periods

create policy "payroll_periods_manager_all" on public.payroll_periods
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- Employee Payment Settings
alter table public.employee_payment_settings enable row level security;

create policy "payment_settings_select" on public.employee_payment_settings
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) = 'manager'
  );

create policy "payment_settings_manager_all" on public.employee_payment_settings
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- Payroll Summaries
alter table public.payroll_summaries enable row level security;

create policy "payroll_summaries_select" on public.payroll_summaries
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) = 'manager'
  );

create policy "payroll_summaries_manager_all" on public.payroll_summaries
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- Staffing Thresholds (manager CRUD, everyone reads)
alter table public.staffing_thresholds enable row level security;

create policy "staffing_thresholds_select" on public.staffing_thresholds
  for select to authenticated
  using (true);

create policy "staffing_thresholds_manager_all" on public.staffing_thresholds
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
select 'time_clock_entries' as tbl, count(*) as policies from pg_policies where tablename = 'time_clock_entries'
union all select 'time_clock_breaks', count(*) from pg_policies where tablename = 'time_clock_breaks'
union all select 'employee_schedules', count(*) from pg_policies where tablename = 'employee_schedules'
union all select 'pto_requests', count(*) from pg_policies where tablename = 'pto_requests'
union all select 'pto_balances', count(*) from pg_policies where tablename = 'pto_balances'
union all select 'payroll_periods', count(*) from pg_policies where tablename = 'payroll_periods'
union all select 'employee_payment_settings', count(*) from pg_policies where tablename = 'employee_payment_settings'
union all select 'payroll_summaries', count(*) from pg_policies where tablename = 'payroll_summaries'
union all select 'staffing_thresholds', count(*) from pg_policies where tablename = 'staffing_thresholds';

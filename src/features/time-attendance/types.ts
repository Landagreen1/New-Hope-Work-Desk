// Time & Attendance Module — TypeScript Types

export type ClockStatus = 'available' | 'lunch' | 'unavailable';
export type BreakType = 'lunch' | 'short' | 'personal';
export type ShiftType = 'regular' | 'overtime' | 'half_day' | 'training' | 'on_call';
export type ScheduleStatus = 'scheduled' | 'published' | 'completed' | 'missed' | 'cancelled';
export type PTOType = 'vacation' | 'sick' | 'personal' | 'bereavement' | 'unpaid';
export type PTOStatus = 'pending' | 'approved' | 'denied' | 'cancelled';
export type PaymentTemplate = 'monthly' | 'biweekly' | 'semi_monthly';
export type PayType = 'hourly' | 'salary';
export type PayrollPeriodStatus = 'open' | 'locked' | 'processed' | 'paid';
export type PayrollSummaryStatus = 'draft' | 'confirmed' | 'paid';
export type Department = 'sales' | 'customer_service' | 'commercial' | 'management';
export type TimeSlot = 'morning' | 'afternoon' | 'full_day';

// ─── Clock Entries ────────────────────────────────────────────────────────────

export interface TimeClockEntry {
  id: string;
  profile_id: string;
  clock_in: string;
  clock_out: string | null;
  clock_status: ClockStatus;
  break_minutes: number;
  total_hours: number | null;
  is_overtime: boolean;
  notes: string | null;
  adjusted_by: string | null;
  adjustment_reason: string | null;
  created_at: string;
  updated_at: string;
  // Joined
  profiles?: { display_name: string; initials: string; role: string };
}

export interface TimeClockBreak {
  id: string;
  clock_entry_id: string;
  break_start: string;
  break_end: string | null;
  break_type: BreakType;
  duration_minutes: number | null;
}

// ─── Schedules ────────────────────────────────────────────────────────────────

export interface EmployeeSchedule {
  id: string;
  profile_id: string;
  schedule_date: string;
  shift_start: string;
  shift_end: string;
  shift_type: ShiftType;
  status: ScheduleStatus;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Joined
  profiles?: { display_name: string; initials: string; role: string };
}

// ─── PTO ──────────────────────────────────────────────────────────────────────

export interface PTORequest {
  id: string;
  profile_id: string;
  pto_type: PTOType;
  start_date: string;
  end_date: string;
  total_days: number;
  reason: string | null;
  status: PTOStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  denial_reason: string | null;
  created_at: string;
  updated_at: string;
  // Joined
  profiles?: { display_name: string; initials: string; role: string };
  reviewer?: { display_name: string };
}

export interface PTOBalance {
  id: string;
  profile_id: string;
  year: number;
  vacation_days: number;
  sick_days: number;
  personal_days: number;
  vacation_used: number;
  sick_used: number;
  personal_used: number;
  carryover_days: number;
  created_at: string;
  updated_at: string;
}

// ─── Payroll ──────────────────────────────────────────────────────────────────

export interface PayrollPeriod {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  payment_template: PaymentTemplate;
  status: PayrollPeriodStatus;
  processed_by: string | null;
  processed_at: string | null;
  created_at: string;
}

export interface EmployeePaymentSettings {
  id: string;
  profile_id: string;
  payment_template: PaymentTemplate;
  hourly_rate: number | null;
  salary_amount: number | null;
  pay_type: PayType;
  overtime_multiplier: number;
  weekly_overtime_threshold: number;
  daily_overtime_threshold: number | null;
  deductions: Array<{ label: string; amount: number; type: 'fixed' | 'percentage' }>;
  created_at: string;
  updated_at: string;
}

export interface PayrollSummary {
  id: string;
  payroll_period_id: string;
  profile_id: string;
  regular_hours: number;
  overtime_hours: number;
  break_hours: number;
  total_hours: number;
  pto_days_used: number;
  pto_hours_paid: number;
  regular_pay: number;
  overtime_pay: number;
  pto_pay: number;
  gross_pay: number;
  deductions_total: number;
  net_pay: number;
  days_worked: number;
  days_absent: number;
  days_late: number;
  status: PayrollSummaryStatus;
  created_at: string;
  updated_at: string;
  // Joined
  profiles?: { display_name: string; initials: string; role: string };
  payroll_periods?: PayrollPeriod;
}

// ─── Staffing Coverage ────────────────────────────────────────────────────────

export interface StaffingThreshold {
  id: string;
  department: Department;
  day_of_week: number;
  time_slot: TimeSlot;
  minimum_staff: number;
  warning_threshold: number;
  created_at: string;
  updated_at: string;
}

export interface DepartmentCoverage {
  department: Department;
  label: string;
  clockedIn: number;
  minimum: number;
  warning: number;
  status: 'ok' | 'warning' | 'critical';
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const CLOCK_STATUS_STYLES: Record<ClockStatus, { bg: string; text: string; label: string; dot: string }> = {
  available: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Available', dot: 'bg-emerald-500' },
  lunch: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Lunch', dot: 'bg-amber-500' },
  unavailable: { bg: 'bg-slate-200', text: 'text-slate-700', label: 'Unavailable', dot: 'bg-slate-400' },
};

export const PTO_TYPE_LABELS: Record<PTOType, string> = {
  vacation: 'Vacation',
  sick: 'Sick Leave',
  personal: 'Personal Day',
  bereavement: 'Bereavement',
  unpaid: 'Unpaid Leave',
};

export const PTO_STATUS_STYLES: Record<PTOStatus, { bg: string; text: string; label: string }> = {
  pending: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Pending' },
  approved: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Approved' },
  denied: { bg: 'bg-rose-100', text: 'text-rose-800', label: 'Denied' },
  cancelled: { bg: 'bg-slate-100', text: 'text-slate-600', label: 'Cancelled' },
};

export const SHIFT_TYPE_LABELS: Record<ShiftType, string> = {
  regular: 'Regular',
  overtime: 'Overtime',
  half_day: 'Half Day',
  training: 'Training',
  on_call: 'On Call',
};

export const PAYMENT_TEMPLATE_LABELS: Record<PaymentTemplate, string> = {
  monthly: 'Monthly (1st of month)',
  biweekly: 'Biweekly (every 2 weeks)',
  semi_monthly: 'Semi-Monthly (1st & 15th)',
};

export const DEPARTMENT_LABELS: Record<Department, string> = {
  sales: 'Sales',
  customer_service: 'Customer Service',
  commercial: 'Commercial',
  management: 'Management',
};

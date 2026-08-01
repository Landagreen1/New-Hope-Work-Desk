'use client';

// src/features/time-attendance/WorkforceAdmin.tsx
// Workforce configuration: pay rates, time-off balances, clock-entry edits, the
// attendance policy, and the staffing thresholds.
//
// A preserved screen. Requirement 2, criterion 3 keeps its pay-rate, PTO-balance,
// and clock-entry editing exactly as they were, and Requirement 2, criterion 5
// limits what a redesign may change here to navigation placement, filters, status
// vocabulary, visual styling, and reading from the Attendance_Service. Three
// changes land under that:
//
//   1. **The two roster reads are one request each.** The pay table asked
//      `/api/payroll/settings` once per employee and the balances editor asked
//      `/api/pto/balance` once per employee, so both grew a request per hire.
//      They now read `/api/payroll/settings/roster` and
//      `/api/pto/balance/roster`, which answer the whole roster in one request
//      (Requirement 20, criteria 5 and 6). The editors above them are untouched:
//      the same fields, the same writes, the same confirmations.
//   2. **The attendance-policy editor is new.** `attendance_policy` owns every
//      tolerance the Status Rule Matrix refers to and, until now, nothing could
//      change it. It is edited here because this is the screen that already owns
//      the configuration an administrator sets once and rarely revisits.
//   2a. **The staffing-threshold editor is new, for the same reason.**
//      `staffing_thresholds` states the minimum and warning headcount every
//      Coverage_Status is classified against (Requirement 6, criterion 3). The
//      v1.9.5 seed put the first sixty slots in place and nothing could change
//      them afterwards except re-running a seed that overwrites all sixty.
//   3. **The duplicated time-off approval table is gone.** It read a `requests`
//      field that `/api/pto` no longer answers with and decided through a
//      `PATCH /api/pto` that no longer exists, so it listed nothing and its
//      Approve and Deny controls could not have worked. Time-off decisions belong
//      to the Time Off & Coverage screen, which implements all eight decision
//      options against `/api/pto/decisions` (Requirement 10). Requirement 2,
//      criterion 3 preserves balance editing, which stays here.
//
// Each section's read goes through `useAsyncResource`, so the loading, empty, and
// failed states are the module's three rather than this screen's own — which is
// also what gives a failed read the reason and the retry control it never had
// (Requirement 22, criteria 14 through 16).
//
// Requirements: 2.3, 2.5, 6.3, 6.4, 20.1, 20.2, 20.5, 20.6, 21.6, 22.12, 22.14,
// 22.15, 22.16

import {
  AlertCircle,
  Check,
  Clock,
  DollarSign,
  Edit3,
  PalmtreeIcon,
  RefreshCw,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Undo2,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { canAdministerAttendance } from '@/lib/permissions';

import type { ProfileLite } from '../nhwd-shared/types';
import DatePicker from '../nhwd-shared/DatePicker';
import DateTimePicker from '../nhwd-shared/DateTimePicker';
import { ui } from '../nhwd-shared/ui';
import {
  DEPARTMENT_ORDER,
  MAX_REQUIRED_STAFF,
  slotKey,
  type ThresholdSlot,
} from './domain/coverage';
import type { AttendancePolicySnapshot, StaffingThresholdSnapshot } from './server/policy';
import {
  asApiFailure,
  attendanceJson,
  jsonRequest,
  type ApiFailure,
} from './shared/api-failure';
import { AsyncStateBlock } from './shared/AsyncStateBlock';
import {
  NO_VALUE,
  formatInstantDate,
  formatTimeOfDay,
  formatTimeZoneName,
} from './shared/format';
import { StatusPill } from './shared/StatusPill';
import {
  CLEARED,
  EDITOR_DAYS_OF_WEEK,
  EDITOR_TIME_SLOTS,
  TIME_SLOT_DESCRIPTIONS,
  WEEKDAY_LABELS,
  cellBands,
  cellValue,
  draftEdits,
  isCleared,
  slotLabel,
  storedByKey,
  type DraftCell,
  type ThresholdDraft,
} from './shared/threshold-draft';
import { useAsyncResource } from './shared/useAsyncResource';
import { DEPARTMENT_LABELS, type BreakType, type Department } from './types';

// ─── The shapes the endpoints answer with ────────────────────────────────────

/** One employee, as `/api/admin/users` lists them. */
interface RosterUser {
  id: string;
  display_name: string;
  is_active: boolean;
}

interface AdminUsersResponse {
  users: RosterUser[];
}

/** One `employee_payment_settings` row, as the roster read selects it. */
interface RosterPaySettingsRow {
  profile_id: string;
  pay_type: 'hourly' | 'salary' | null;
  hourly_rate: number | null;
  salary_amount: number | null;
}

interface RosterPaySettingsResponse {
  settings: RosterPaySettingsRow[];
}

/** One `pto_balances` row, as the roster read selects it. */
interface RosterBalanceRow {
  profile_id: string;
  vacation_days: number | null;
  personal_days: number | null;
  vacation_used: number | null;
  personal_used: number | null;
}

interface RosterBalancesResponse {
  year: number;
  balances: RosterBalanceRow[];
}

/** One employee's row in the pay table. */
interface PaySettings {
  profile_id: string;
  display_name: string;
  hourly_rate: number | null;
  salary_amount: number | null;
  pay_type: 'hourly' | 'salary';
}

/** One employee's row in the balances table. */
interface BalanceListing {
  profile_id: string;
  display_name: string;
  vacation_days: number;
  personal_days: number;
  vacation_used: number;
  personal_used: number;
}

interface ClockEntry {
  id: string;
  profile_id: string;
  clock_in: string;
  clock_out: string | null;
  break_minutes: number;
  total_hours: number | null;
  notes: string | null;
  adjusted_by: string | null;
  adjustment_reason: string | null;
  profiles?: { display_name: string; initials: string };
}

/**
 * The allocations shown for an employee with no `pto_balances` row for the year.
 *
 * The roster read answers with stored rows and invents nothing, so an employee who
 * has never had a balance set is absent from it. These are the same figures the
 * editor writes when it creates that row — ten vacation days and one personal day
 * — so what the table shows for an unconfigured employee is what saving without
 * changing anything would store.
 */
const UNCONFIGURED_BALANCE = {
  vacation_days: 10,
  personal_days: 1,
  vacation_used: 0,
  personal_used: 0,
} as const;

type Section = 'pay' | 'timeoff' | 'clock' | 'policy' | 'thresholds';

const SECTIONS: readonly { id: Section; label: string; icon: typeof DollarSign }[] = [
  { id: 'pay', label: 'Pay Rates', icon: DollarSign },
  { id: 'timeoff', label: 'Time Off', icon: PalmtreeIcon },
  { id: 'clock', label: 'Clock Edits', icon: Clock },
  { id: 'policy', label: 'Attendance Policy', icon: SlidersHorizontal },
  { id: 'thresholds', label: 'Staffing Thresholds', icon: Users },
];

interface WorkforceAdminProps {
  initialProfile: ProfileLite;
}

export default function WorkforceAdmin({ initialProfile }: WorkforceAdminProps) {
  const [section, setSection] = useState<Section>('pay');

  // Every read and write behind this screen is reserved to an administrator and
  // every endpoint refuses anything else. The same predicate is read here so a
  // non-administrator is told, rather than shown four editors whose reads all come
  // back refused — the second check `TimeAttendanceWorkspace` already performs
  // before routing here, at the point of rendering (Requirement 21, criteria 6 and
  // 12).
  if (!canAdministerAttendance(initialProfile.role)) {
    return (
      <div className={ui.info} role="status">
        Workforce configuration — pay rates, time-off balances, clock-entry edits,
        the attendance policy, and the staffing thresholds — is reserved to a super
        admin.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Section selector */}
      <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setSection(id)}
            aria-pressed={section === id}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black transition ${
              section === id
                ? 'bg-[#223f7a] text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {section === 'pay' && <PayRatesSection />}
      {section === 'timeoff' && <PTOBalancesSection />}
      {section === 'clock' && <ClockEditSection />}
      {section === 'policy' && <AttendancePolicySection />}
      {section === 'thresholds' && <StaffingThresholdSection />}
    </div>
  );
}

// ─── Pay Rates ────────────────────────────────────────────────────────────────

/**
 * The roster and its pay settings, merged.
 *
 * An employee with no `employee_payment_settings` row keeps a null rate, which the
 * table renders as an em dash beside an Edit button: pay has not been set up yet,
 * which is the common state on this screen and is not the same as a rate of zero.
 */
function mergePaySettings(
  users: readonly RosterUser[],
  settings: readonly RosterPaySettingsRow[],
): PaySettings[] {
  const byProfile = new Map(settings.map((row) => [row.profile_id, row]));

  return users
    .filter((user) => user.is_active)
    .map((user) => {
      const stored = byProfile.get(user.id);
      return {
        profile_id: user.id,
        display_name: user.display_name,
        hourly_rate: stored?.hourly_rate ?? null,
        salary_amount: stored?.salary_amount ?? null,
        pay_type: stored?.pay_type ?? 'hourly',
      };
    });
}

function PayRatesSection() {
  const [editId, setEditId] = useState<string | null>(null);
  const [editRate, setEditRate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Two requests, whatever the roster size: the employee list, and every
  // employee's pay settings (Requirement 20, criteria 1 and 5).
  const roster = useAsyncResource<PaySettings[]>(
    async (signal) => {
      const [users, settings] = await Promise.all([
        attendanceJson<AdminUsersResponse>('/api/admin/users', { signal }),
        attendanceJson<RosterPaySettingsResponse>('/api/payroll/settings/roster', { signal }),
      ]);
      return mergePaySettings(users.users ?? [], settings.settings ?? []);
    },
    { subject: 'employees', isEmpty: (rows) => rows.length === 0 },
  );

  const handleSave = async (profileId: string) => {
    const rate = parseFloat(editRate);
    if (isNaN(rate) || rate < 0) {
      setError('Enter a valid pay rate.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/payroll/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, hourly_rate: rate, pay_type: 'hourly' }),
      });
      if (!res.ok) throw new Error('Save failed.');
      setEditId(null);
      roster.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const employees = roster.data ?? [];

  return (
    <div className="rounded-[28px] border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-slate-100 p-5">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Workforce</p>
        <h3 className="mt-1 text-xl font-black">Employee Pay Rates</h3>
        <p className="mt-1 text-sm text-slate-500">Set hourly rates for each employee. Changes take effect on the next payroll period.</p>
      </div>
      {error && <div className={`${ui.error} mx-5 mt-4`}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}
      <AsyncStateBlock
        status={roster.status}
        failure={roster.failure}
        message={roster.emptyMessage}
        onRetry={roster.retry}
        pending={roster.pending}
        subject="pay rates"
        className="mx-5 mt-4"
      />
      {employees.length > 0 && (
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Employee</th>
                <th className={ui.th}>Pay Type</th>
                <th className={ui.th}>Hourly Rate</th>
                <th className={ui.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => (
                <tr key={emp.profile_id} className="hover:bg-[#f8faff]">
                  <td className={`${ui.td} font-black text-slate-900`}>{emp.display_name}</td>
                  <td className={ui.td}>
                    <span className={`${ui.badge} ${ui.badgeTone.info}`}>{emp.pay_type === 'salary' ? 'Salary' : 'Hourly'}</span>
                  </td>
                  <td className={ui.td}>
                    {editId === emp.profile_id ? (
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editRate}
                        onChange={(e) => setEditRate(e.target.value)}
                        aria-label={`Hourly rate for ${emp.display_name}`}
                        className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-bold outline-none focus:border-[#223f7a]"
                        autoFocus
                      />
                    ) : (
                      <span className="text-lg font-black text-slate-900">
                        {emp.hourly_rate != null ? `$${emp.hourly_rate.toFixed(2)}` : '—'}
                      </span>
                    )}
                  </td>
                  <td className={ui.td}>
                    {editId === emp.profile_id ? (
                      <div className="flex gap-2">
                        <button onClick={() => void handleSave(emp.profile_id)} disabled={saving} className={ui.btnPrimary + ' !px-3 !py-1.5 !text-xs'}>
                          <Save className="h-3.5 w-3.5" />{saving ? '...' : 'Save'}
                        </button>
                        <button onClick={() => setEditId(null)} aria-label={`Cancel editing ${emp.display_name}`} className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}>
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditId(emp.profile_id); setEditRate(emp.hourly_rate?.toString() ?? ''); }}
                        className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}
                      >
                        <Edit3 className="h-3.5 w-3.5" />Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Time-off balances ────────────────────────────────────────────────────────

/**
 * The roster and its balances for one year, merged.
 *
 * Ordered by display name, as the balances editor has always ordered it.
 */
function mergeBalances(
  users: readonly RosterUser[],
  balances: readonly RosterBalanceRow[],
): BalanceListing[] {
  const byProfile = new Map(balances.map((row) => [row.profile_id, row]));

  return users
    .filter((user) => user.is_active)
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
    .map((user) => {
      const stored = byProfile.get(user.id);
      return {
        profile_id: user.id,
        display_name: user.display_name,
        vacation_days: stored?.vacation_days ?? UNCONFIGURED_BALANCE.vacation_days,
        personal_days: stored?.personal_days ?? UNCONFIGURED_BALANCE.personal_days,
        vacation_used: stored?.vacation_used ?? UNCONFIGURED_BALANCE.vacation_used,
        personal_used: stored?.personal_used ?? UNCONFIGURED_BALANCE.personal_used,
      };
    });
}

function PTOBalancesSection() {
  const [editId, setEditId] = useState<string | null>(null);
  const [editVacation, setEditVacation] = useState('');
  // `pto_balances.personal_days`, named for the column it edits. The screen used
  // to label this one "birthday day", which is the retired `birthday` vocabulary
  // the database check constraint never accepted.
  const [editPersonal, setEditPersonal] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The balance year, as the editor has always taken it: the reader's current
  // year. The endpoint would resolve it in the business timezone if it were not
  // sent, and it answers with the year it used either way.
  const year = useMemo(() => new Date().getFullYear(), []);

  // Two requests, whatever the roster size: the employee list, and every
  // employee's balance for the year (Requirement 20, criteria 1 and 6).
  const roster = useAsyncResource<BalanceListing[]>(
    async (signal) => {
      const [users, balances] = await Promise.all([
        attendanceJson<AdminUsersResponse>('/api/admin/users', { signal }),
        attendanceJson<RosterBalancesResponse>(`/api/pto/balance/roster?year=${year}`, { signal }),
      ]);
      return mergeBalances(users.users ?? [], balances.balances ?? []);
    },
    {
      deps: [year],
      filters: [{ label: 'Year', value: String(year) }],
      subject: 'employees',
      isEmpty: (rows) => rows.length === 0,
    },
  );

  const handleSaveBalance = async (profileId: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/pto/balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, vacation_days: Number(editVacation), personal_days: Number(editPersonal) }),
      });
      if (!res.ok) throw new Error('Save failed.');
      setEditId(null);
      roster.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const employees = roster.data ?? [];

  return (
    <div className="rounded-[28px] border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-slate-100 p-5">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Workforce</p>
        <h3 className="mt-1 text-xl font-black">Employee PTO Balances</h3>
        <p className="mt-1 text-sm text-slate-500">Edit vacation days and personal days allocation for each employee ({year}).</p>
      </div>
      {error && <div className={`${ui.error} mx-5 mt-4`}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}
      <AsyncStateBlock
        status={roster.status}
        failure={roster.failure}
        message={roster.emptyMessage}
        onRetry={roster.retry}
        pending={roster.pending}
        subject="time-off balances"
        className="mx-5 mt-4"
      />
      {employees.length > 0 && (
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Employee</th>
                <th className={ui.th}>Vacation Days</th>
                <th className={ui.th}>Vacation Used</th>
                <th className={ui.th}>Personal Days</th>
                <th className={ui.th}>Personal Used</th>
                <th className={ui.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => {
                const isEditing = editId === emp.profile_id;
                return (
                  <tr key={emp.profile_id} className="hover:bg-[#f8faff]">
                    <td className={`${ui.td} font-black text-slate-900`}>{emp.display_name}</td>
                    <td className={ui.td}>
                      {isEditing ? (
                        <input type="number" min="0" step="1" value={editVacation} onChange={e => setEditVacation(e.target.value)} aria-label={`Vacation days for ${emp.display_name}`} className="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-bold outline-none focus:border-[#223f7a]" />
                      ) : (
                        <span className="text-sm font-black">{emp.vacation_days}</span>
                      )}
                    </td>
                    <td className={`${ui.td} text-sm font-bold text-slate-500`}>{emp.vacation_used}</td>
                    <td className={ui.td}>
                      {isEditing ? (
                        <input type="number" min="0" max="5" step="1" value={editPersonal} onChange={e => setEditPersonal(e.target.value)} aria-label={`Personal days for ${emp.display_name}`} className="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-bold outline-none focus:border-[#223f7a]" />
                      ) : (
                        <span className="text-sm font-black">{emp.personal_days}</span>
                      )}
                    </td>
                    <td className={`${ui.td} text-sm font-bold text-slate-500`}>{emp.personal_used}</td>
                    <td className={ui.td}>
                      {isEditing ? (
                        <div className="flex gap-2">
                          <button onClick={() => void handleSaveBalance(emp.profile_id)} disabled={saving} className={ui.btnPrimary + ' !px-3 !py-1.5 !text-xs'}>
                            <Save className="h-3.5 w-3.5" />{saving ? '...' : 'Save'}
                          </button>
                          <button onClick={() => setEditId(null)} aria-label={`Cancel editing ${emp.display_name}`} className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}>
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditId(emp.profile_id); setEditVacation(String(emp.vacation_days)); setEditPersonal(String(emp.personal_days)); }}
                          className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}
                        >
                          <Edit3 className="h-3.5 w-3.5" />Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Attendance policy ────────────────────────────────────────────────────────

/**
 * The four tolerance fields, in the order they are read.
 *
 * A table rather than four hand-written controls, so the form, the change
 * detection, and the request body are all derived from one list and cannot
 * disagree about which fields the editor owns. `body` is the parameter name
 * `PATCH /api/attendance/policy` reads.
 */
const POLICY_MINUTE_FIELDS = [
  {
    key: 'gracePeriodMinutes',
    body: 'grace_period_minutes',
    label: 'Grace period',
    help: 'Minutes after a scheduled start within which a clock-in is still on time.',
  },
  {
    key: 'earlyDepartureToleranceMinutes',
    body: 'early_departure_tolerance_minutes',
    label: 'Early-departure tolerance',
    help: 'Minutes before a scheduled end that a clock-out is not treated as leaving early.',
  },
  {
    key: 'missingClockOutToleranceMinutes',
    body: 'missing_clock_out_tolerance_minutes',
    label: 'Missing clock-out tolerance',
    help: 'Minutes past a scheduled end after which an open session is reported as a missing clock-out.',
  },
  {
    key: 'breakOverrunMinutes',
    body: 'break_overrun_minutes',
    label: 'Break overrun allowance',
    help: 'Minutes of break beyond which the day is reported as a break overrun.',
  },
] as const;

type PolicyMinuteField = (typeof POLICY_MINUTE_FIELDS)[number]['key'];

/**
 * The largest tolerance the editor offers: one day.
 *
 * The endpoint refuses anything outside 0 to 1440 minutes and the column refuses a
 * negative, so this is the same bound stated where the reader can see it rather
 * than a second rule.
 */
const MAX_TOLERANCE_MINUTES = 1440;

/**
 * The break types, with the words the editor calls them.
 *
 * A `Record` over `BreakType` rather than a list, so a break type added to the
 * union does not compile until this editor names it — an unnamed type would
 * otherwise be a break the policy could not mark unpaid.
 */
const BREAK_TYPE_LABELS: Readonly<Record<BreakType, string>> = {
  lunch: 'Lunch',
  short: 'Short break',
  personal: 'Personal break',
};

const BREAK_TYPES = Object.keys(BREAK_TYPE_LABELS) as readonly BreakType[];

/** The form, as text and checkbox state. */
type PolicyDraft = Record<PolicyMinuteField, string> & {
  unpaidBreakTypes: readonly BreakType[];
};

function toDraft(snapshot: AttendancePolicySnapshot): PolicyDraft {
  const { policy } = snapshot;
  return {
    gracePeriodMinutes: String(policy.gracePeriodMinutes),
    earlyDepartureToleranceMinutes: String(policy.earlyDepartureToleranceMinutes),
    missingClockOutToleranceMinutes: String(policy.missingClockOutToleranceMinutes),
    breakOverrunMinutes: String(policy.breakOverrunMinutes),
    unpaidBreakTypes: policy.unpaidBreakTypes,
  };
}

/** Whether two unpaid-break-type selections say the same thing. */
function sameBreakTypes(a: readonly BreakType[], b: readonly BreakType[]): boolean {
  return a.length === b.length && a.every((type) => b.includes(type));
}

/**
 * Whether two drafts are the same form.
 *
 * Compared as text rather than as numbers, so a field the reader has emptied
 * counts as a change and the Save control stays available to report why it cannot
 * be saved. A control that greys itself out over an unreadable field leaves the
 * reader with nothing to press and nothing to read.
 */
function sameDraft(a: PolicyDraft, b: PolicyDraft): boolean {
  return (
    POLICY_MINUTE_FIELDS.every((field) => a[field.key].trim() === b[field.key].trim()) &&
    sameBreakTypes(a.unpaidBreakTypes, b.unpaidBreakTypes)
  );
}

/** A minutes field as a whole number, or null when the text is not one. */
function parseMinutes(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value <= MAX_TOLERANCE_MINUTES ? value : null;
}

/**
 * What the draft would change, as the PATCH body.
 *
 * Only the fields that actually differ from the stored policy are sent, so a save
 * carries the change the administrator made and nothing else — two administrators
 * editing different tolerances do not overwrite each other's field. A field whose
 * text is not a whole number within range is reported by name instead, because a
 * silently dropped field would be a save that did not save what the form showed.
 */
function policyPatch(
  draft: PolicyDraft,
  snapshot: AttendancePolicySnapshot,
): { body: Record<string, unknown> } | { invalid: string } {
  const body: Record<string, unknown> = {};

  for (const field of POLICY_MINUTE_FIELDS) {
    const value = parseMinutes(draft[field.key]);
    if (value === null) {
      return {
        invalid: `${field.label} must be a whole number of minutes between 0 and ${MAX_TOLERANCE_MINUTES}.`,
      };
    }
    if (value !== snapshot.policy[field.key]) body[field.body] = value;
  }

  if (!sameBreakTypes(draft.unpaidBreakTypes, snapshot.policy.unpaidBreakTypes)) {
    body.unpaid_break_types = draft.unpaidBreakTypes;
  }

  return { body };
}

/**
 * The attendance-policy editor.
 *
 * The tolerances the Status Rule Matrix refers to, in one form. `business_timezone`
 * is displayed and not editable: it is the zone every stored shift time is read in
 * and every work date is derived against, so changing it re-derives history and is
 * a deployment decision rather than a form control. The endpoint does not accept
 * it either.
 *
 * No effect seeds the form. The controls read the draft where the administrator has
 * started one and the stored policy otherwise, so a fresh read shows the stored
 * values without a render that copies them into state, and a save clears the draft
 * so the form is showing what the server committed.
 *
 * Requirements: 2.3, 3.10, 3.12, 21.6, 22.12, 22.16
 */
function AttendancePolicySection() {
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<ApiFailure | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const policy = useAsyncResource<AttendancePolicySnapshot>(
    (signal) => attendanceJson<AttendancePolicySnapshot>('/api/attendance/policy', { signal }),
    { subject: 'the attendance policy', isEmpty: () => false },
  );

  const snapshot = policy.data;
  const setPolicyData = policy.setData;
  // The stored values are the form's baseline. A draft exists only once the
  // administrator has typed or toggled something.
  const values = draft ?? (snapshot === null ? null : toDraft(snapshot));

  /**
   * A change starts the draft from the stored values, so the first keystroke does
   * not have to invent the other four fields, and clears whatever the last save
   * said: a stale "saved" or a stale refusal beside a form the reader has since
   * changed is worse than no message.
   */
  const editField = useCallback(
    (key: PolicyMinuteField, text: string) => {
      if (snapshot === null) return;
      const stored = snapshot;
      setSaved(false);
      setInvalid(null);
      setSaveFailure(null);
      setDraft((current) => ({ ...(current ?? toDraft(stored)), [key]: text }));
    },
    [snapshot],
  );

  const toggleBreakType = useCallback(
    (type: BreakType) => {
      if (snapshot === null) return;
      const stored = snapshot;
      setSaved(false);
      setInvalid(null);
      setSaveFailure(null);
      setDraft((current) => {
        const base = current ?? toDraft(stored);
        return {
          ...base,
          unpaidBreakTypes: base.unpaidBreakTypes.includes(type)
            ? base.unpaidBreakTypes.filter((entry) => entry !== type)
            : [...base.unpaidBreakTypes, type],
        };
      });
    },
    [snapshot],
  );

  const changed = draft !== null && snapshot !== null && !sameDraft(draft, toDraft(snapshot));

  const save = useCallback(() => {
    if (values === null || snapshot === null || saving) return;

    const result = policyPatch(values, snapshot);
    if ('invalid' in result) {
      setInvalid(result.invalid);
      return;
    }
    // Nothing to send: the text differs from the stored value without the figure
    // differing — `05` for `5`. Dropping the draft snaps the form back to what is
    // stored rather than leaving a Save control that does nothing.
    if (Object.keys(result.body).length === 0) {
      setDraft(null);
      return;
    }

    setSaving(true);
    setInvalid(null);
    setSaveFailure(null);
    setSaved(false);

    void (async () => {
      try {
        const committed = await attendanceJson<AttendancePolicySnapshot>(
          '/api/attendance/policy',
          jsonRequest('PATCH', result.body),
        );
        // The committed policy, not the submitted form: the response is what the
        // database now holds.
        setPolicyData(committed);
        setDraft(null);
        setSaved(true);
      } catch (error) {
        setSaveFailure(asApiFailure(error));
      } finally {
        setSaving(false);
      }
    })();
  }, [saving, setPolicyData, snapshot, values]);

  const discard = useCallback(() => {
    setDraft(null);
    setInvalid(null);
    setSaveFailure(null);
    setSaved(false);
  }, []);

  const timeZone = snapshot?.policy.businessTimezone ?? 'UTC';

  return (
    <div className="rounded-[28px] border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-slate-100 p-5">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Workforce</p>
        <h3 className="mt-1 text-xl font-black">Attendance Policy</h3>
        <p className="mt-1 text-sm text-slate-500">
          The tolerances every attendance status is derived from. A change applies to
          every screen the next time it reads.
        </p>
      </div>

      <div className="space-y-4 p-5">
        <AsyncStateBlock
          status={policy.status}
          failure={policy.failure}
          message={policy.emptyMessage}
          onRetry={policy.retry}
          pending={policy.pending}
          subject="the attendance policy"
        />

        {saveFailure !== null && (
          <div className={ui.error} role="alert">
            <AlertCircle className="mr-2 inline h-4 w-4" aria-hidden="true" />
            {saveFailure.reason}
          </div>
        )}

        {invalid !== null && (
          <div className={ui.error} role="alert">
            <AlertCircle className="mr-2 inline h-4 w-4" aria-hidden="true" />
            {invalid}
          </div>
        )}

        {saved && (
          <div className={ui.success} role="status">
            <Check className="mr-2 inline h-4 w-4" aria-hidden="true" />
            Attendance policy saved.
          </div>
        )}

        {values !== null && snapshot !== null && (
          <>
            <div className={ui.fieldRow}>
              {POLICY_MINUTE_FIELDS.map((field) => (
                <div key={field.key}>
                  <label className={ui.label} htmlFor={`policy-${field.key}`}>
                    {field.label}
                  </label>
                  <input
                    id={`policy-${field.key}`}
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max={MAX_TOLERANCE_MINUTES}
                    step="1"
                    value={values[field.key]}
                    onChange={(event) => editField(field.key, event.target.value)}
                    aria-describedby={`policy-${field.key}-help`}
                    className={ui.input}
                  />
                  <p id={`policy-${field.key}-help`} className="mt-1.5 text-xs font-semibold text-slate-500">
                    {field.help}
                  </p>
                </div>
              ))}
            </div>

            <fieldset className="rounded-2xl border border-slate-200 p-4">
              <legend className={`${ui.label} px-1`}>Unpaid break types</legend>
              <p className="text-xs font-semibold text-slate-500">
                Breaks of these types are deducted from worked hours. Leave every box
                clear to pay all breaks.
              </p>
              <div className="mt-3 flex flex-wrap gap-4">
                {BREAK_TYPES.map((type) => (
                  <label key={type} className={ui.checkboxRow} htmlFor={`policy-unpaid-${type}`}>
                    <input
                      id={`policy-unpaid-${type}`}
                      type="checkbox"
                      checked={values.unpaidBreakTypes.includes(type)}
                      onChange={() => toggleBreakType(type)}
                      className="h-4 w-4 rounded border-slate-300 text-[#223f7a] focus:ring-[#7890bc]"
                    />
                    {BREAK_TYPE_LABELS[type]}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={save}
                disabled={saving || !changed}
                className={ui.btnPrimary}
              >
                {saving ? (
                  <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="h-4 w-4" aria-hidden="true" />
                )}
                {saving ? 'Saving' : 'Save policy'}
              </button>
              <button
                type="button"
                onClick={discard}
                disabled={saving || draft === null}
                className={ui.btnSecondary}
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Discard changes
              </button>
              <p className="text-xs font-semibold text-slate-500">
                Business timezone {formatTimeZoneName(timeZone)}, set by deployment.
                {snapshot.updatedAt !== null && (
                  <>
                    {' '}Last changed {formatInstantDate(snapshot.updatedAt, timeZone)} at{' '}
                    {formatTimeOfDay(snapshot.updatedAt, timeZone)}.
                  </>
                )}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Staffing thresholds ──────────────────────────────────────────────────────

/**
 * One department's slots, in the order the grid shows them.
 *
 * Built once per department rather than inline in the render, so the save's
 * `order` argument and the rows on screen are the same list and a refusal names
 * the first cell a reader would look at.
 */
function departmentSlots(department: Department): ThresholdSlot[] {
  return EDITOR_DAYS_OF_WEEK.flatMap((dayOfWeek) =>
    EDITOR_TIME_SLOTS.map((timeSlot) => ({ department, dayOfWeek, timeSlot })),
  );
}

/** Every slot the editor can address, all four departments, in display order. */
const ALL_SLOTS: readonly ThresholdSlot[] = DEPARTMENT_ORDER.flatMap(departmentSlots);

/**
 * One cell of the grid: the two figures, the bands they mean, and the controls
 * that set or clear the slot.
 *
 * The three states a cell can be in are told apart in words, not only by an empty
 * box:
 *
 *   * **Unconfigured** — no stored row and no draft. Says "no requirement", which
 *     is what an absent row means to the coverage rules, and is not the same as a
 *     stored zero.
 *   * **Configured** — a pair, with the four bands it produces listed beneath so
 *     the administrator can see that the warning figure is the top of the Warning
 *     band rather than a second minimum.
 *   * **Marked to clear** — a stored row the administrator has asked to remove,
 *     shown as a pending change with an Undo rather than as an empty pair.
 *
 * Requirements: 6.4, 6.9, 6.10, 6.11, 6.12, 22.6, 22.7, 22.12
 */
function ThresholdCell({
  slot,
  cell,
  isStored,
  hasDraft,
  label,
  disabled,
  onEdit,
  onClear,
  onUndo,
}: {
  slot: ThresholdSlot;
  cell: DraftCell | null;
  isStored: boolean;
  hasDraft: boolean;
  label: string;
  disabled: boolean;
  onEdit: (slot: ThresholdSlot, field: 'minimum' | 'warning', text: string) => void;
  onClear: (slot: ThresholdSlot) => void;
  onUndo: (slot: ThresholdSlot) => void;
}) {
  const key = slotKey(slot);
  const bands = cellBands(cell);

  /** Drop this cell's draft, so it shows the stored row again. */
  const undo = (
    <button
      type="button"
      onClick={() => onUndo(slot)}
      disabled={disabled}
      aria-label={`Undo the change to ${label}`}
      className={ui.btnSecondary + ' !px-2.5 !py-1 !text-[11px]'}
    >
      <Undo2 className="h-3 w-3" aria-hidden="true" />
      Undo
    </button>
  );

  if (isCleared(cell)) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] font-black uppercase tracking-wider text-amber-800">
          Will be cleared
        </p>
        <p className="text-[11px] font-semibold text-slate-500">
          Saving removes this slot&apos;s row, so it states no requirement and reads
          Healthy.
        </p>
        {undo}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div>
          <label
            className="block text-[10px] font-black uppercase tracking-wider text-slate-400"
            htmlFor={`threshold-min-${key}`}
          >
            Minimum
          </label>
          <input
            id={`threshold-min-${key}`}
            type="number"
            inputMode="numeric"
            min="0"
            max={MAX_REQUIRED_STAFF}
            step="1"
            value={cell === null ? '' : cell.minimum}
            onChange={(event) => onEdit(slot, 'minimum', event.target.value)}
            disabled={disabled}
            aria-label={`Minimum staff for ${label}`}
            placeholder={NO_VALUE}
            className="mt-1 w-[4.5rem] rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-bold text-slate-900 outline-none transition placeholder:text-slate-300 focus:border-[#7890bc] focus:ring-2 focus:ring-[#eef3fb]"
          />
        </div>
        <div>
          <label
            className="block text-[10px] font-black uppercase tracking-wider text-slate-400"
            htmlFor={`threshold-warn-${key}`}
          >
            Warn to
          </label>
          <input
            id={`threshold-warn-${key}`}
            type="number"
            inputMode="numeric"
            min="0"
            max={MAX_REQUIRED_STAFF}
            step="1"
            value={cell === null ? '' : cell.warning}
            onChange={(event) => onEdit(slot, 'warning', event.target.value)}
            disabled={disabled}
            aria-label={`Warn to, the top of the Warning band, for ${label}`}
            placeholder={NO_VALUE}
            className="mt-1 w-[4.5rem] rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-bold text-slate-900 outline-none transition placeholder:text-slate-300 focus:border-[#7890bc] focus:ring-2 focus:ring-[#eef3fb]"
          />
        </div>
      </div>

      {cell === null ? (
        <p className="text-[11px] font-semibold text-slate-500">
          Unconfigured — no staffing requirement, so coverage reads Healthy.
        </p>
      ) : bands === null ? (
        <p className="text-[11px] font-semibold text-amber-800">
          Fill both figures, with the warning at or above the minimum.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {bands.map((band) => (
            <li key={band.status} className="flex items-center gap-1.5">
              <StatusPill status={band.status} />
              <span className="text-[11px] font-bold text-slate-600">{band.range}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-1.5">
        {isStored && (
          <button
            type="button"
            onClick={() => onClear(slot)}
            disabled={disabled}
            aria-label={`Clear ${label} back to no requirement`}
            className={ui.btnSecondary + ' !px-2.5 !py-1 !text-[11px]'}
          >
            <X className="h-3 w-3" aria-hidden="true" />
            Clear
          </button>
        )}
        {hasDraft && undo}
      </div>
    </div>
  );
}

/**
 * The staffing-threshold editor.
 *
 * `staffing_thresholds` states the minimum and warning headcount per department,
 * day of week, and time slot, and it is what every Coverage_Status is classified
 * against (Requirement 6, criterion 3). The v1.9.5 seed put the first figures in
 * place; this is how they change afterwards without re-running a seed that
 * overwrites all sixty slots.
 *
 * ## Three things the form has to make plain
 *
 * 1. **The warning figure is the top of a band, not a second minimum.** Every
 *    configured cell lists the bands its pair produces, read from
 *    `coverageBands`, so what the form shows and what `classifyCoverage` will
 *    later assign are one statement.
 * 2. **An empty slot is not a zero.** An absent row reports required staffing as
 *    unconfigured and Coverage_Status Healthy (criterion 4); a stored `0 / 0`
 *    requires nobody and warns at nobody, which reads as At Minimum the moment
 *    the department is empty. The cell says which state it is in, and Clear
 *    removes a row rather than zeroing it.
 * 3. **The three slots are separate.** The lookup is exact, so a `full_day` figure
 *    is not a fallback for `morning`. Each column carries the reading that
 *    compares against it.
 *
 * ## Why the draft spans every department
 *
 * The department selector narrows what is on screen; it does not narrow the
 * draft. One Save therefore sends every changed cell in every department in one
 * request (Requirement 20, criteria 1 and 2), and an administrator who edits sales
 * and then commercial cannot lose the first set by switching tabs.
 *
 * Requirements: 2.3, 2.5, 6.3, 6.4, 20.1, 20.2, 21.6, 22.12, 22.14, 22.15, 22.16
 */
function StaffingThresholdSection() {
  const [department, setDepartment] = useState<Department>(DEPARTMENT_ORDER[0]);
  const [draft, setDraft] = useState<ThresholdDraft>({});
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<ApiFailure | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // One request for the whole table: four departments times seven days times three
  // slots is 84 rows at most, so there is nothing to page (Requirement 20,
  // criteria 1 and 2).
  const thresholds = useAsyncResource<StaffingThresholdSnapshot>(
    (signal) =>
      attendanceJson<StaffingThresholdSnapshot>('/api/attendance/thresholds', { signal }),
    { subject: 'staffing thresholds', isEmpty: () => false },
  );

  const snapshot = thresholds.data;
  const setThresholdData = thresholds.setData;
  const stored = useMemo(() => storedByKey(snapshot?.entries ?? []), [snapshot]);

  const labelOf = useCallback(
    (slot: ThresholdSlot) => slotLabel(slot, DEPARTMENT_LABELS[slot.department]),
    [],
  );

  /** Any change clears whatever the last save said: a stale message is worse than none. */
  const forget = useCallback(() => {
    setSaved(false);
    setInvalid(null);
    setSaveFailure(null);
  }, []);

  const editCell = useCallback(
    (slot: ThresholdSlot, field: 'minimum' | 'warning', text: string) => {
      forget();
      setDraft((current) => {
        const key = slotKey(slot);
        const held = current[key];
        // A first keystroke on a stored slot starts from the stored figures, so
        // typing in one box does not blank the other.
        const row = stored.get(key);
        const base =
          held !== undefined && !isCleared(held)
            ? held
            : row === undefined
              ? { minimum: '', warning: '' }
              : { minimum: String(row.minimumStaff), warning: String(row.warningThreshold) };

        return { ...current, [key]: { ...base, [field]: text } };
      });
    },
    [forget, stored],
  );

  const clearCell = useCallback(
    (slot: ThresholdSlot) => {
      forget();
      setDraft((current) => ({ ...current, [slotKey(slot)]: CLEARED }));
    },
    [forget],
  );

  /** Drop the draft for one slot, so the cell shows what is stored again. */
  const undoCell = useCallback(
    (slot: ThresholdSlot) => {
      forget();
      setDraft((current) => {
        const next = { ...current };
        delete next[slotKey(slot)];
        return next;
      });
    },
    [forget],
  );

  const discard = useCallback(() => {
    forget();
    setDraft({});
  }, [forget]);

  const patch = useMemo(
    () => (snapshot === null ? null : draftEdits(draft, stored, ALL_SLOTS, labelOf)),
    [draft, labelOf, snapshot, stored],
  );

  const patchInvalid = patch !== null && 'invalid' in patch;
  const changedCount = patch !== null && 'slots' in patch ? patch.slots.length : 0;
  const drafted = Object.keys(draft).length > 0;

  const save = useCallback(() => {
    if (patch === null || saving) return;

    if ('invalid' in patch) {
      setInvalid(patch.invalid);
      return;
    }
    // Nothing to send: every drafted cell matches what is stored. Dropping the
    // draft snaps the form back rather than leaving a Save that does nothing.
    if (patch.slots.length === 0) {
      discard();
      return;
    }

    setSaving(true);
    forget();

    void (async () => {
      try {
        const committed = await attendanceJson<StaffingThresholdSnapshot>(
          '/api/attendance/thresholds',
          jsonRequest('PATCH', { slots: patch.slots }),
        );
        // What the server committed, not what the form submitted.
        setThresholdData(committed);
        setDraft({});
        setSaved(true);
      } catch (error) {
        setSaveFailure(asApiFailure(error));
      } finally {
        setSaving(false);
      }
    })();
  }, [discard, forget, patch, saving, setThresholdData]);

  return (
    <div className="rounded-[28px] border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-slate-100 p-5">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Workforce</p>
        <h3 className="mt-1 text-xl font-black">Staffing Thresholds</h3>
        <p className="mt-1 text-sm text-slate-500">
          The minimum and warning headcount every coverage status is compared
          against, per department, day of week, and time slot. A change applies to
          every screen the next time it reads.
        </p>
      </div>

      <div className="space-y-4 p-5">
        <AsyncStateBlock
          status={thresholds.status}
          failure={thresholds.failure}
          message={thresholds.emptyMessage}
          onRetry={thresholds.retry}
          pending={thresholds.pending}
          subject="staffing thresholds"
        />

        <div className={ui.info}>
          <p>
            <strong>Warn to</strong> is the top of the Warning band, not a second
            minimum. Below the minimum is Critical, exactly the minimum is At
            Minimum, above the minimum up to and including the warning figure is
            Warning, and anything higher is Healthy. Each cell lists the bands its
            figures produce.
          </p>
          <p className="mt-2">
            A slot with no figures has <strong>no requirement</strong> and reports
            Healthy — which is not the same as storing zero, since a minimum of zero
            reads as At Minimum the moment nobody is available. Saturday and Sunday
            are left unconfigured on purpose. The three time slots are looked up
            exactly, so a full-day figure is not a fallback for the morning.
          </p>
        </div>

        {saveFailure !== null && (
          <div className={ui.error} role="alert">
            <AlertCircle className="mr-2 inline h-4 w-4" aria-hidden="true" />
            {saveFailure.reason}
          </div>
        )}

        {invalid !== null && (
          <div className={ui.error} role="alert">
            <AlertCircle className="mr-2 inline h-4 w-4" aria-hidden="true" />
            {invalid}
          </div>
        )}

        {saved && (
          <div className={ui.success} role="status">
            <Check className="mr-2 inline h-4 w-4" aria-hidden="true" />
            Staffing thresholds saved.
          </div>
        )}

        {snapshot !== null && (
          <>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Department to configure"
            >
              {DEPARTMENT_ORDER.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setDepartment(option)}
                  aria-pressed={department === option}
                  className={`rounded-xl px-3.5 py-2 text-xs font-black transition ${
                    department === option
                      ? 'bg-[#223f7a] text-white shadow-sm'
                      : 'border border-[#c9d5e9] bg-white text-[#223f7a] hover:bg-[#f3f6fb]'
                  }`}
                >
                  {DEPARTMENT_LABELS[option]}
                </button>
              ))}
            </div>

            <div className="overflow-x-auto">
              <table className={ui.table}>
                <caption className="px-4 py-2 text-left text-xs font-semibold text-slate-500">
                  {DEPARTMENT_LABELS[department]} staffing requirement per day of week
                  and time slot. Department comes from each employee&apos;s role, so a
                  role change moves that headcount to another department.
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={ui.th}>
                      Day
                    </th>
                    {EDITOR_TIME_SLOTS.map((timeSlot) => (
                      <th key={timeSlot} scope="col" className={ui.th}>
                        {TIME_SLOT_DESCRIPTIONS[timeSlot].label}
                        <span className="mt-1 block text-[10px] font-semibold normal-case tracking-normal text-slate-400">
                          {TIME_SLOT_DESCRIPTIONS[timeSlot].help}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {EDITOR_DAYS_OF_WEEK.map((dayOfWeek) => (
                    <tr key={dayOfWeek}>
                      <th
                        scope="row"
                        className={`${ui.td} whitespace-nowrap text-sm font-black text-slate-900`}
                      >
                        {WEEKDAY_LABELS[dayOfWeek]}
                      </th>
                      {EDITOR_TIME_SLOTS.map((timeSlot) => {
                        const slot: ThresholdSlot = { department, dayOfWeek, timeSlot };
                        return (
                          <td key={timeSlot} className={ui.td}>
                            <ThresholdCell
                              slot={slot}
                              cell={cellValue(slot, draft, stored)}
                              isStored={stored.has(slotKey(slot))}
                              hasDraft={draft[slotKey(slot)] !== undefined}
                              label={labelOf(slot)}
                              disabled={saving}
                              onEdit={editCell}
                              onClear={clearCell}
                              onUndo={undoCell}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={save}
                disabled={saving || !drafted}
                className={ui.btnPrimary}
              >
                {saving ? (
                  <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="h-4 w-4" aria-hidden="true" />
                )}
                {saving ? 'Saving' : 'Save thresholds'}
              </button>
              <button
                type="button"
                onClick={discard}
                disabled={saving || !drafted}
                className={ui.btnSecondary}
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Discard changes
              </button>
              <p className="text-xs font-semibold text-slate-500">
                {!drafted
                  ? `${snapshot.entries.length} of ${ALL_SLOTS.length} slots configured across all four departments.`
                  : patchInvalid
                    ? 'One edited slot is not yet legible. Save reports which one.'
                    : changedCount === 0
                      ? 'The edited slots already match what is stored.'
                      : `${changedCount} ${changedCount === 1 ? 'slot' : 'slots'} will change, across every department, in one request.`}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Clock Edits ──────────────────────────────────────────────────────────────

function ClockEditSection() {
  const [employees, setEmployees] = useState<Array<{ id: string; display_name: string }>>([]);
  const [selectedProfile, setSelectedProfile] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [entries, setEntries] = useState<ClockEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editClockIn, setEditClockIn] = useState('');
  const [editClockOut, setEditClockOut] = useState('');
  const [editBreakMin, setEditBreakMin] = useState('');
  const [saving, setSaving] = useState(false);

  // Load employee list on mount
  useEffect(() => {
    fetch('/api/admin/users').then(r => r.json()).then((body) => {
      const users = (body.users ?? []) as Array<{ id: string; display_name: string; is_active: boolean }>;
      setEmployees(users.filter(u => u.is_active).sort((a, b) => a.display_name.localeCompare(b.display_name)));
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!selectedProfile) return;
    setLoading(true); setError(null);
    try {
      const dateParam = filterDate || new Date().toISOString().split('T')[0];
      const res = await fetch(`/api/time-clock?profile_id=${selectedProfile}&date=${dateParam}&range=month`);
      const { entries: data } = await res.json();
      let filtered = (data ?? []) as ClockEntry[];
      // If a specific date is selected, filter to just that day
      if (filterDate) {
        filtered = filtered.filter(e => e.clock_in.startsWith(filterDate));
      }
      setEntries(filtered);
      setLoaded(true);
    } catch (err) { setError(err instanceof Error ? err.message : 'Load failed.'); }
    finally { setLoading(false); }
  }, [selectedProfile, filterDate]);

  const handleSave = async (entryId: string) => {
    setSaving(true); setError(null);
    try {
      const reason = window.prompt('Reason for time adjustment:');
      if (!reason?.trim()) { setSaving(false); return; }
      const res = await fetch('/api/time-clock', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'edit',
          entry_id: entryId,
          clock_in: editClockIn || undefined,
          clock_out: editClockOut || undefined,
          break_minutes: editBreakMin !== '' ? Number(editBreakMin) : undefined,
          adjustment_reason: reason.trim(),
        }),
      });
      if (!res.ok) throw new Error('Save failed.');
      setEditId(null);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed.'); }
    finally { setSaving(false); }
  };

  const formatDT = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="rounded-[28px] border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-slate-100 p-5">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Workforce</p>
        <h3 className="mt-1 text-xl font-black">Clock-In/Out Edits</h3>
        <p className="mt-1 text-sm text-slate-500">Select an employee to view and adjust their clock entries. All edits are audited.</p>
      </div>

      {/* Filters */}
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_200px_auto]">
          <div>
            <label className={ui.label} htmlFor="clock-edit-employee">Employee</label>
            <select
              id="clock-edit-employee"
              value={selectedProfile}
              onChange={(e) => { setSelectedProfile(e.target.value); setLoaded(false); setEntries([]); }}
              className={ui.select}
            >
              <option value="">Select an employee...</option>
              {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.display_name}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>Date (optional)</label>
            <DatePicker value={filterDate} onChange={(v) => { setFilterDate(v); setLoaded(false); }} placeholder="All month" className="mt-2" />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => void load()}
              disabled={!selectedProfile || loading}
              className={ui.btnPrimary + ' mt-2'}
            >
              {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : 'Load Entries'}
            </button>
          </div>
        </div>
      </div>

      {error && <div className={`${ui.error} mx-5 mt-4`}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}

      {/* Results */}
      {!loaded && !loading && (
        <div className="px-5 py-10 text-center text-sm font-bold text-slate-400">Select an employee and click &quot;Load Entries&quot; to view their clock data.</div>
      )}

      {loaded && (
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Date</th>
                <th className={ui.th}>Clock In</th>
                <th className={ui.th}>Clock Out</th>
                <th className={ui.th}>Hours</th>
                <th className={ui.th}>Breaks</th>
                <th className={ui.th}>Adjusted</th>
                <th className={ui.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-[#f8faff]">
                  <td className={`${ui.td} text-xs font-bold text-slate-700`}>{new Date(entry.clock_in).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                  <td className={ui.td}>
                    {editId === entry.id ? (
                      <DateTimePicker value={editClockIn} onChange={setEditClockIn} />
                    ) : (
                      <span className="text-xs">{formatDT(entry.clock_in)}</span>
                    )}
                  </td>
                  <td className={ui.td}>
                    {editId === entry.id ? (
                      <DateTimePicker value={editClockOut} onChange={setEditClockOut} />
                    ) : (
                      <span className="text-xs">{formatDT(entry.clock_out)}</span>
                    )}
                  </td>
                  <td className={`${ui.td} font-bold`}>{entry.total_hours != null ? `${entry.total_hours.toFixed(1)}h` : '—'}</td>
                  <td className={ui.td}>
                    {editId === entry.id ? (
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={editBreakMin}
                        onChange={e => setEditBreakMin(e.target.value)}
                        aria-label="Break minutes"
                        className="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-bold outline-none focus:border-[#223f7a]"
                      />
                    ) : (
                      <span className="text-xs font-bold">{entry.break_minutes}m</span>
                    )}
                  </td>
                  <td className={ui.td}>
                    {entry.adjusted_by ? (
                      <span className={`${ui.badge} ${ui.badgeTone.progress}`}>Edited</span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className={ui.td}>
                    {editId === entry.id ? (
                      <div className="flex gap-2">
                        <button onClick={() => void handleSave(entry.id)} disabled={saving} className={ui.btnPrimary + ' !px-3 !py-1.5 !text-xs'}>
                          <Save className="h-3.5 w-3.5" />{saving ? '...' : 'Save'}
                        </button>
                        <button onClick={() => setEditId(null)} aria-label="Cancel editing this entry" className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}>
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setEditId(entry.id);
                          setEditClockIn(entry.clock_in ? new Date(entry.clock_in).toISOString().slice(0, 16) : '');
                          setEditClockOut(entry.clock_out ? new Date(entry.clock_out).toISOString().slice(0, 16) : '');
                          setEditBreakMin(String(entry.break_minutes ?? 0));
                        }}
                        className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}
                      >
                        <Edit3 className="h-3.5 w-3.5" />Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!entries.length && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-sm font-bold text-slate-400">No clock entries found for this selection.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

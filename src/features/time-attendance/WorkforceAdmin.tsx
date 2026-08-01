'use client';

// src/features/time-attendance/WorkforceAdmin.tsx
// Workforce configuration: pay rates, time-off balances, clock-entry edits, and
// the attendance policy.
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
// Requirements: 2.3, 2.5, 20.1, 20.5, 20.6, 21.6, 22.12, 22.14, 22.15, 22.16

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
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { canAdministerAttendance } from '@/lib/permissions';

import type { ProfileLite } from '../nhwd-shared/types';
import DatePicker from '../nhwd-shared/DatePicker';
import DateTimePicker from '../nhwd-shared/DateTimePicker';
import { ui } from '../nhwd-shared/ui';
import type { AttendancePolicySnapshot } from './server/policy';
import {
  asApiFailure,
  attendanceJson,
  jsonRequest,
  type ApiFailure,
} from './shared/api-failure';
import { AsyncStateBlock } from './shared/AsyncStateBlock';
import { formatInstantDate, formatTimeOfDay, formatTimeZoneName } from './shared/format';
import { useAsyncResource } from './shared/useAsyncResource';
import type { BreakType } from './types';

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
 * editor writes when it creates that row — ten vacation days and one birthday day
 * — so what the table shows for an unconfigured employee is what saving without
 * changing anything would store.
 */
const UNCONFIGURED_BALANCE = {
  vacation_days: 10,
  personal_days: 1,
  vacation_used: 0,
  personal_used: 0,
} as const;

type Section = 'pay' | 'timeoff' | 'clock' | 'policy';

const SECTIONS: readonly { id: Section; label: string; icon: typeof DollarSign }[] = [
  { id: 'pay', label: 'Pay Rates', icon: DollarSign },
  { id: 'timeoff', label: 'Time Off', icon: PalmtreeIcon },
  { id: 'clock', label: 'Clock Edits', icon: Clock },
  { id: 'policy', label: 'Attendance Policy', icon: SlidersHorizontal },
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
        and the attendance policy — is reserved to a super admin.
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
  const [editBirthday, setEditBirthday] = useState('');
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
        body: JSON.stringify({ profile_id: profileId, vacation_days: Number(editVacation), personal_days: Number(editBirthday) }),
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
        <p className="mt-1 text-sm text-slate-500">Edit vacation days and birthday day allocation for each employee ({year}).</p>
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
                <th className={ui.th}>Birthday Day</th>
                <th className={ui.th}>Birthday Used</th>
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
                        <input type="number" min="0" max="5" step="1" value={editBirthday} onChange={e => setEditBirthday(e.target.value)} aria-label={`Birthday day for ${emp.display_name}`} className="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-bold outline-none focus:border-[#223f7a]" />
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
                          onClick={() => { setEditId(emp.profile_id); setEditVacation(String(emp.vacation_days)); setEditBirthday(String(emp.personal_days)); }}
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

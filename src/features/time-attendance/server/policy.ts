// src/features/time-attendance/server/policy.ts
// Loads the two configuration tables the derivation depends on:
// `attendance_policy` (the singleton owning every tolerance the Status Rule
// Matrix refers to) and `staffing_thresholds` (the minimum and warning
// headcount per department, day of week, and time slot).
//
// The domain layer takes an `AttendancePolicy` as an argument and never reads
// configuration itself, so this is the only module that turns those rows into
// the shapes `domain/attendance.ts` and `domain/coverage.ts` consume.
//
// ## Reading is separated from mapping
//
// `toAttendancePolicy` and `buildStaffingThresholdTable` are pure functions of
// the rows. The two `load*` functions are thin wrappers that query and then map.
// That split is deliberate: the interesting behaviour — a missing singleton, a
// malformed column, a break type the code does not recognise — is testable
// without a database, and the wrapper has nothing left to get wrong.
//
// ## Malformed configuration falls back rather than throwing
//
// `domain/attendance.ts` throws for a malformed policy, treating it as a
// deployment fault. This loader therefore never hands it one: a missing row, a
// negative tolerance, a non-numeric column, or an unknown timezone falls back
// to the documented default for that field alone. The alternative is a single
// bad column blanking every attendance screen, which is a worse failure than
// running on a default the Workforce policy editor can correct.
//
// ## The editor reads and writes through here too
//
// `loadPolicySnapshot` and `saveAttendancePolicy` serve the Workforce screen's
// policy editor (Requirement 2, criterion 3). They are here rather than in a
// module of their own because the column names, the accepted break types, and the
// per-field fallbacks are already written once in this file, and an editor that
// mapped the same six columns a second time is how a stored value and a displayed
// value come to disagree.
//
// The two reads differ on purpose. `loadAttendancePolicy` swallows a read failure
// and answers with the defaults, because a screen deriving statuses has to render
// something. `loadPolicySnapshot` propagates it, because the editor's next act is
// a write: showing the defaults as though they were the stored values would invite
// an administrator to save a policy they never chose.
//
// Requirements: 2.3 (the Workforce screen's editors), 3.7 (schedules interpreted
// in the business timezone), 3.10 (unpaid break types are configured, not
// assumed), 3.12 (grace period), 6.3 (staffing thresholds per department, day, and
// slot), 6.4 (an unconfigured threshold reports required as unconfigured),
// 21.6 (attendance configuration is an administrator capability).

import type { SupabaseClient } from '@supabase/supabase-js';

import { workDateOf } from '../domain/work-date';
import type { AttendancePolicy, Threshold } from '../domain/types';
import type { BreakType, Department, TimeSlot } from '../types';
import type { ApiFailureCode } from './api-response';

/**
 * Any Supabase client: the cookie-bound server client from
 * `@/lib/supabase/server` in a route, or a service client in a script. Both
 * reads below are permitted to every signed-in user, so the loader never needs
 * elevated credentials.
 */
export type PolicyClient = SupabaseClient;

/**
 * The documented defaults, matching the column defaults in
 * `v1.9.0-attendance-foundations.sql`. Used for a missing singleton row and,
 * field by field, for any column that cannot be read as its declared type.
 */
export const DEFAULT_ATTENDANCE_POLICY: AttendancePolicy = {
  businessTimezone: 'America/New_York',
  gracePeriodMinutes: 5,
  earlyDepartureToleranceMinutes: 15,
  missingClockOutToleranceMinutes: 120,
  breakOverrunMinutes: 60,
  unpaidBreakTypes: ['lunch'],
};

/**
 * The break types `attendance_policy.unpaid_break_types` may name.
 *
 * Exported so the policy editor's write path accepts exactly the names this
 * module will read back. A value the editor could store and the loader would then
 * drop is an unpaid break type that matches no break, which quietly stops
 * deducting lunch (Requirement 3, criterion 10).
 */
export const KNOWN_BREAK_TYPES: readonly BreakType[] = ['lunch', 'short', 'personal'];

/** The departments `staffing_thresholds.department` may name. */
const KNOWN_DEPARTMENTS: readonly Department[] = [
  'sales',
  'customer_service',
  'commercial',
  'management',
];

/** The slots `staffing_thresholds.time_slot` may name. */
const KNOWN_TIME_SLOTS: readonly TimeSlot[] = ['morning', 'afternoon', 'full_day'];

/** A fixed instant, used only to ask whether a zone identifier is usable. */
const TIME_ZONE_PROBE = new Date(0);

// ─── Row shapes ──────────────────────────────────────────────────────────────

/**
 * The `attendance_policy` row as it arrives. Every field is `unknown` because
 * the point of this module is to be the boundary where an untyped row becomes a
 * checked shape; declaring the columns as `number` here would assume the very
 * thing the mapping verifies.
 */
export interface AttendancePolicyRow {
  business_timezone?: unknown;
  grace_period_minutes?: unknown;
  early_departure_tolerance_minutes?: unknown;
  missing_clock_out_tolerance_minutes?: unknown;
  break_overrun_minutes?: unknown;
  unpaid_break_types?: unknown;
}

/** The `staffing_thresholds` row as it arrives, unchecked for the same reason. */
export interface StaffingThresholdRow {
  department?: unknown;
  day_of_week?: unknown;
  time_slot?: unknown;
  minimum_staff?: unknown;
  warning_threshold?: unknown;
}

/**
 * Threshold lookup for one department, day of week, and time slot.
 *
 * `null` means that slot is unconfigured, which the coverage rules report as
 * required-unconfigured and status Healthy (Requirement 6, criterion 4). The
 * lookup is exact: a `full_day` row is not treated as a default for `morning`,
 * because inferring one slot's requirement from another's would invent a
 * staffing rule the organisation has not stated. Migration stage 6 seeds every
 * department, day, and slot; until then most lookups answer `null`, which is
 * the behaviour Open Question 3 defers on.
 */
export interface StaffingThresholdTable {
  /** How many slots are configured. Zero is the current, expected state. */
  readonly size: number;
  thresholdFor(
    department: Department,
    dayOfWeek: number,
    timeSlot: TimeSlot,
  ): Threshold | null;
}

/** Both configuration reads, resolved together for one request. */
export interface AttendanceConfig {
  policy: AttendancePolicy;
  thresholds: StaffingThresholdTable;
}

// ─── Field readers ───────────────────────────────────────────────────────────

/**
 * A whole, non-negative count of minutes, or `null` when the value is not one.
 *
 * Postgres `integer` arrives as a number, but a `numeric` column, a string from
 * a driver quirk, or a hand-edited row can all arrive otherwise, and the
 * derivation's arithmetic would silently produce `NaN` from any of them.
 */
function readMinutes(value: unknown): number | null {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric);
}

/**
 * Whether `timeZone` is a zone identifier this runtime knows.
 *
 * Probed through `workDateOf` rather than through `Intl` directly, so
 * `domain/work-date.ts` remains the only module in the feature that touches
 * zone data (Requirement 19, criteria 9 and 10). The probe instant is fixed, so
 * the answer is a function of the argument alone.
 */
function isUsableTimeZone(timeZone: string): boolean {
  try {
    workDateOf(TIME_ZONE_PROBE, timeZone);
    return true;
  } catch {
    return false;
  }
}

function readTimeZone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || !isUsableTimeZone(trimmed)) return null;
  return trimmed;
}

/**
 * The unpaid break types, filtered to the ones the code recognises and
 * de-duplicated.
 *
 * An unrecognised name is dropped rather than carried through, because
 * `domain/attendance.ts` classifies a break as unpaid by membership in this
 * list: a typo would otherwise become an unpaid break type that matches no
 * break and quietly stops deducting lunch. An empty stored array is honoured as
 * "every break is paid"; only a missing or non-array value falls back.
 */
function readUnpaidBreakTypes(value: unknown): readonly BreakType[] | null {
  if (!Array.isArray(value)) return null;
  const known = value.filter((entry): entry is BreakType =>
    KNOWN_BREAK_TYPES.includes(entry as BreakType),
  );
  return Array.from(new Set(known));
}

function readDepartment(value: unknown): Department | null {
  return KNOWN_DEPARTMENTS.includes(value as Department) ? (value as Department) : null;
}

function readTimeSlot(value: unknown): TimeSlot | null {
  return KNOWN_TIME_SLOTS.includes(value as TimeSlot) ? (value as TimeSlot) : null;
}

/** A day of week as `staffing_thresholds` stores it: 0 is Sunday. */
function readDayOfWeek(value: unknown): number | null {
  const day = readMinutes(value);
  return day === null || day > 6 ? null : day;
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

/**
 * The `attendance_policy` singleton as an `AttendancePolicy`.
 *
 * `null` — no row at all — yields the documented defaults, which is what keeps
 * the module working before the singleton is seeded. Otherwise each field is
 * read independently, so one unreadable column costs that field's configured
 * value and nothing else.
 */
export function toAttendancePolicy(row: AttendancePolicyRow | null | undefined): AttendancePolicy {
  if (row === null || row === undefined) return { ...DEFAULT_ATTENDANCE_POLICY };

  return {
    businessTimezone:
      readTimeZone(row.business_timezone) ?? DEFAULT_ATTENDANCE_POLICY.businessTimezone,
    gracePeriodMinutes:
      readMinutes(row.grace_period_minutes) ?? DEFAULT_ATTENDANCE_POLICY.gracePeriodMinutes,
    earlyDepartureToleranceMinutes:
      readMinutes(row.early_departure_tolerance_minutes) ??
      DEFAULT_ATTENDANCE_POLICY.earlyDepartureToleranceMinutes,
    missingClockOutToleranceMinutes:
      readMinutes(row.missing_clock_out_tolerance_minutes) ??
      DEFAULT_ATTENDANCE_POLICY.missingClockOutToleranceMinutes,
    breakOverrunMinutes:
      readMinutes(row.break_overrun_minutes) ?? DEFAULT_ATTENDANCE_POLICY.breakOverrunMinutes,
    unpaidBreakTypes:
      readUnpaidBreakTypes(row.unpaid_break_types) ??
      DEFAULT_ATTENDANCE_POLICY.unpaidBreakTypes,
  };
}

function thresholdKey(department: Department, dayOfWeek: number, timeSlot: TimeSlot): string {
  return `${department}:${dayOfWeek}:${timeSlot}`;
}

/**
 * A lookup table over `staffing_thresholds` rows.
 *
 * Rows naming an unknown department, an out-of-range day, or an unknown slot
 * are dropped: they cannot describe a slot any caller will ask about, and
 * keeping them would only make `size` misleading. A later row for the same slot
 * wins, matching the arbitrary order a duplicate would arrive in — the
 * `unique_threshold_per_slot` constraint means duplicates cannot occur, so this
 * is a tie-break for a case the database already rules out.
 */
export function buildStaffingThresholdTable(
  rows: readonly StaffingThresholdRow[] | null | undefined,
): StaffingThresholdTable {
  const byKey = new Map<string, Threshold>();

  for (const row of rows ?? []) {
    const department = readDepartment(row.department);
    const dayOfWeek = readDayOfWeek(row.day_of_week);
    const timeSlot = readTimeSlot(row.time_slot);
    const minimumStaff = readMinutes(row.minimum_staff);
    const warningThreshold = readMinutes(row.warning_threshold);

    if (
      department === null ||
      dayOfWeek === null ||
      timeSlot === null ||
      minimumStaff === null ||
      warningThreshold === null
    ) {
      continue;
    }

    byKey.set(thresholdKey(department, dayOfWeek, timeSlot), { minimumStaff, warningThreshold });
  }

  return {
    size: byKey.size,
    thresholdFor(department, dayOfWeek, timeSlot) {
      return byKey.get(thresholdKey(department, dayOfWeek, timeSlot)) ?? null;
    },
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * The six columns `toAttendancePolicy` reads.
 *
 * One list, used by both reads, so a column added to the policy is selected
 * wherever the policy is read rather than in whichever read was remembered.
 */
const POLICY_COLUMNS =
  'business_timezone, grace_period_minutes, early_departure_tolerance_minutes, ' +
  'missing_clock_out_tolerance_minutes, break_overrun_minutes, unpaid_break_types';

/** The policy columns plus the trail the editor displays. */
const POLICY_SNAPSHOT_COLUMNS = `${POLICY_COLUMNS}, updated_at`;

/**
 * The current attendance policy.
 *
 * `attendance_policy` is readable by every signed-in user, because My Day, the
 * Health Ribbon, and the working-day count all need the tolerances to render.
 * A read error is treated the same as a missing row: the defaults are returned
 * rather than propagating a failure that would blank a screen over a
 * configuration read.
 */
export async function loadAttendancePolicy(supabase: PolicyClient): Promise<AttendancePolicy> {
  const { data } = await supabase.from('attendance_policy').select(POLICY_COLUMNS).maybeSingle();

  return toAttendancePolicy(data as AttendancePolicyRow | null);
}

/**
 * Every configured staffing threshold, as one lookup table.
 *
 * One query for the whole table, not one per department or per date: the table
 * has at most four departments times seven days times three slots, and a
 * per-slot read would put a query inside the coverage loop (Requirement 20,
 * criteria 1 and 2).
 */
export async function loadStaffingThresholds(
  supabase: PolicyClient,
): Promise<StaffingThresholdTable> {
  const { data } = await supabase
    .from('staffing_thresholds')
    .select('department, day_of_week, time_slot, minimum_staff, warning_threshold');

  return buildStaffingThresholdTable(data as StaffingThresholdRow[] | null);
}

/**
 * Both configuration reads for one request, issued concurrently.
 *
 * Services call this once per request and pass the result down, so the policy
 * and the thresholds a request derives from are read at one point in time
 * rather than re-read per employee or per date.
 */
export async function loadAttendanceConfig(supabase: PolicyClient): Promise<AttendanceConfig> {
  const [policy, thresholds] = await Promise.all([
    loadAttendancePolicy(supabase),
    loadStaffingThresholds(supabase),
  ]);

  return { policy, thresholds };
}

// ─── The policy editor ───────────────────────────────────────────────────────

/**
 * A configuration read or write that could not be served.
 *
 * The same idea as `AttendanceServiceError` and `PTOServiceError`: a stable
 * `code` the route layer maps onto a status through `serviceFailure`, so the
 * failure contract stays in one place and this module holds no HTTP knowledge.
 * Declared here rather than imported from `attendance-service.ts`, which imports
 * this module.
 */
export class PolicyServiceError extends Error {
  readonly code: Extract<ApiFailureCode, 'read_failed' | 'write_failed'>;

  constructor(
    code: Extract<ApiFailureCode, 'read_failed' | 'write_failed'>,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyServiceError';
    this.code = code;
  }
}

/** Stated when the singleton could not be read for the editor. */
export const POLICY_UNREADABLE_MESSAGE =
  'The attendance policy could not be read, so it cannot be edited right now. Retrying may succeed.';

/** Stated when the singleton could not be written. */
export const POLICY_UNWRITABLE_MESSAGE =
  'The attendance policy could not be saved. Nothing was changed.';

/**
 * The stored policy, and when it was last changed.
 *
 * `updatedAt` is the whole trail this row keeps. A policy change is not one of
 * the events Requirement 16, criterion 1 asks the Attendance_Audit_Log to
 * record — that list is corrections, time-off decisions, coverage overrides,
 * review status changes, and payroll processing, each of which names an employee
 * and a work date, which a configuration change does not — so the row's own
 * `updated_by` and `updated_at` are what say who last touched it and when.
 */
export interface AttendancePolicySnapshot {
  policy: AttendancePolicy;
  /** `attendance_policy.updated_at`, or null when it could not be read. */
  updatedAt: string | null;
}

/**
 * The five fields the policy editor may change.
 *
 * `businessTimezone` is deliberately absent. It is the zone every stored shift
 * time is interpreted in and every work date is derived against, so changing it
 * silently re-derives every historical record; that belongs to a deployment
 * decision rather than to a form control, and no criterion asks the editor for
 * it.
 *
 * Every field is optional and an absent field is left as stored, so two
 * administrators editing different tolerances do not overwrite each other's
 * field.
 */
export interface AttendancePolicyUpdate {
  gracePeriodMinutes?: number;
  earlyDepartureToleranceMinutes?: number;
  missingClockOutToleranceMinutes?: number;
  breakOverrunMinutes?: number;
  unpaidBreakTypes?: readonly BreakType[];
}

/** The `attendance_policy` columns an update assigns, keyed as the table names them. */
export function policyUpdateColumns(
  update: AttendancePolicyUpdate,
): Record<string, number | string[]> {
  const columns: Record<string, number | string[]> = {};

  if (update.gracePeriodMinutes !== undefined) {
    columns.grace_period_minutes = update.gracePeriodMinutes;
  }
  if (update.earlyDepartureToleranceMinutes !== undefined) {
    columns.early_departure_tolerance_minutes = update.earlyDepartureToleranceMinutes;
  }
  if (update.missingClockOutToleranceMinutes !== undefined) {
    columns.missing_clock_out_tolerance_minutes = update.missingClockOutToleranceMinutes;
  }
  if (update.breakOverrunMinutes !== undefined) {
    columns.break_overrun_minutes = update.breakOverrunMinutes;
  }
  if (update.unpaidBreakTypes !== undefined) {
    // De-duplicated on the way in as well as on the way out: the column has no
    // constraint against `['lunch', 'lunch']`, and a stored duplicate would show
    // the editor a list it did not submit.
    columns.unpaid_break_types = Array.from(new Set(update.unpaidBreakTypes));
  }

  return columns;
}

/**
 * The stored policy for the editor, with a read failure reported rather than
 * absorbed.
 *
 * Requirements: 2.3, 22.16
 */
export async function loadPolicySnapshot(
  supabase: PolicyClient,
): Promise<AttendancePolicySnapshot> {
  const { data, error } = await supabase
    .from('attendance_policy')
    .select(POLICY_SNAPSHOT_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error('[time-attendance] attendance policy read failed', error);
    throw new PolicyServiceError('read_failed', POLICY_UNREADABLE_MESSAGE);
  }

  return toPolicySnapshot(data as (AttendancePolicyRow & { updated_at?: unknown }) | null);
}

/**
 * Apply an update to the singleton and answer with the committed row.
 *
 * An upsert rather than an update, because the singleton is addressed by a fixed
 * primary key and an update matching no row would report success while changing
 * nothing — which is exactly what happens on a deployment where the seed insert
 * never ran. `on conflict` assigns only the columns in the payload, so the fields
 * the caller did not send keep their stored values.
 *
 * The committed row is read back in the same statement and mapped through
 * `toAttendancePolicy`, so what the editor displays afterwards is what the
 * database now holds rather than what the form submitted. Row level security
 * grants this update to `super_admin` alone, so an update refused by the policy
 * comes back as no row and is reported as a write failure rather than as a save.
 *
 * Requirements: 2.3, 21.6, 21.12, 22.16
 */
export async function saveAttendancePolicy(
  supabase: PolicyClient,
  actorProfileId: string,
  update: AttendancePolicyUpdate,
): Promise<AttendancePolicySnapshot> {
  const { data, error } = await supabase
    .from('attendance_policy')
    .upsert(
      {
        singleton_key: true,
        ...policyUpdateColumns(update),
        updated_by: actorProfileId,
        // The column defaults to `now()` on insert and has no update trigger, so
        // the stamp is set here or the trail stops moving.
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'singleton_key' },
    )
    .select(POLICY_SNAPSHOT_COLUMNS)
    .maybeSingle();

  if (error !== null || data === null) {
    console.error('[time-attendance] attendance policy write failed', error);
    throw new PolicyServiceError('write_failed', POLICY_UNWRITABLE_MESSAGE);
  }

  return toPolicySnapshot(data as AttendancePolicyRow & { updated_at?: unknown });
}

/** A row as the snapshot the editor renders. */
function toPolicySnapshot(
  row: (AttendancePolicyRow & { updated_at?: unknown }) | null,
): AttendancePolicySnapshot {
  return {
    policy: toAttendancePolicy(row),
    updatedAt: typeof row?.updated_at === 'string' ? row.updated_at : null,
  };
}

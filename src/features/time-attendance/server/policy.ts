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

import { describeSlot, slotKey, type ThresholdSlot } from '../domain/coverage';
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

/**
 * The departments `staffing_thresholds.department` may name.
 *
 * Exported for the same reason as `KNOWN_BREAK_TYPES`: the threshold editor's
 * write path accepts exactly the names this module will read back, so a row the
 * editor could store and `buildStaffingThresholdTable` would then drop — a
 * requirement configured against nothing — cannot be written. These are also the
 * only four values the v1.2.0 check constraint admits.
 */
export const KNOWN_DEPARTMENTS: readonly Department[] = [
  'sales',
  'customer_service',
  'commercial',
  'management',
];

/** The slots `staffing_thresholds.time_slot` may name. */
export const KNOWN_TIME_SLOTS: readonly TimeSlot[] = ['morning', 'afternoon', 'full_day'];

/** The days `staffing_thresholds.day_of_week` may name. 0 is Sunday. */
export const KNOWN_DAYS_OF_WEEK: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

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

/**
 * The lookup key for one slot.
 *
 * Delegates to `slotKey` in the domain layer, so the loader's table, the editor's
 * draft, and the write path's duplicate check are keyed the same way rather than
 * by three functions that happen to agree today.
 */
function thresholdKey(department: Department, dayOfWeek: number, timeSlot: TimeSlot): string {
  return slotKey({ department, dayOfWeek, timeSlot });
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

// ─── The staffing-threshold editor ───────────────────────────────────────────
//
// The Workforce screen's threshold editor (Requirement 2, criterion 3;
// Requirement 6, criterion 3). `staffing_thresholds` states the minimum and
// warning headcount per department, day of week, and time slot, and until now the
// module could only read it — the figures arrived through the v1.9.5 seed and
// nothing could change them afterwards.
//
// The write lives here beside `buildStaffingThresholdTable` for the reason the
// policy editor lives beside `toAttendancePolicy`: the column names, the accepted
// departments, the accepted slots, and the day-of-week range are already written
// once in this file, and an editor that mapped the same five columns a second time
// is how a stored requirement and a displayed requirement come to disagree.
//
// ## An absent row is a statement, so the editor can make one
//
// `thresholdFor` answers null for an unconfigured slot, which reports required
// staffing as unconfigured and Coverage_Status Healthy (Requirement 6,
// criterion 4). That is the honest encoding of "no staffing requirement here",
// and it is what Saturday and Sunday carry on purpose — see the header of
// `v1.9.5-staffing-thresholds-seed.sql`, which explains at length why a
// zero-valued weekend row would raise a warning against a requirement of nobody.
//
// So the editor has to be able to say both things. A `ThresholdEdit` is therefore
// either a pair to store or a `clear`, and the two are different statements: a
// stored pair of `0 / 0` means "this slot requires nobody and warns at nobody",
// while a cleared slot means "this slot has no requirement at all". The editor
// never writes the first when the administrator meant the second.

/**
 * Stated when the thresholds could not be read for the editor.
 *
 * `loadStaffingThresholds` swallows a read failure and answers with an empty
 * table, because a screen deriving coverage has to render something. This read
 * propagates it, because the editor's next act is a write: showing an empty table
 * as though nothing were configured would invite an administrator to re-enter
 * sixty slots that are already stored.
 */
export const THRESHOLDS_UNREADABLE_MESSAGE =
  'The staffing thresholds could not be read, so they cannot be edited right now. Retrying may succeed.';

/** Stated when the thresholds could not be written. */
export const THRESHOLDS_UNWRITABLE_MESSAGE =
  'The staffing thresholds could not be saved. Nothing was changed.';

/**
 * Stated when the edits landed and the read-back did not.
 *
 * Distinct from both of the above on purpose: telling the administrator that
 * nothing was changed would be false, and telling them the thresholds cannot be
 * edited would send them to re-enter a change that is already stored.
 */
export const THRESHOLDS_SAVED_UNREADABLE_MESSAGE =
  'The staffing thresholds were saved but could not be read back, so the figures below may be stale. Reload to see what is stored.';

/** The `staffing_thresholds` columns the editor reads and writes. */
const THRESHOLD_COLUMNS =
  'department, day_of_week, time_slot, minimum_staff, warning_threshold, updated_at';

/** The conflict target, from `unique_threshold_per_slot` in v1.2.0. */
const THRESHOLD_CONFLICT_TARGET = 'department,day_of_week,time_slot';

/**
 * The slot identity, from the domain layer.
 *
 * Re-exported rather than restated so the route and the editor reach one
 * definition of "the same slot".
 */
export { describeSlot, slotKey, type ThresholdSlot };

/**
 * One configured slot, as the editor displays it.
 *
 * Only configured slots appear. An unconfigured slot is absent rather than
 * present with null figures, so the shape says the same thing the table does and
 * the editor cannot mistake "no requirement" for "a requirement of none".
 */
export interface StaffingThresholdEntry extends ThresholdSlot, Threshold {
  /** `staffing_thresholds.updated_at`, or null when it could not be read. */
  updatedAt: string | null;
}

/** Every configured slot, as the editor reads them. */
export interface StaffingThresholdSnapshot {
  entries: StaffingThresholdEntry[];
}

/** A pair to store for one slot. */
export interface ThresholdAssignment extends ThresholdSlot, Threshold {
  clear?: false;
}

/** A slot to return to unconfigured. */
export interface ThresholdClear extends ThresholdSlot {
  clear: true;
}

/**
 * One edit: store a pair, or clear the slot back to unconfigured.
 *
 * A discriminated union rather than a pair of optional figures, so "store zero"
 * and "store nothing" cannot be written the same way by accident.
 */
export type ThresholdEdit = ThresholdAssignment | ThresholdClear;

/** Whether an edit clears its slot. */
export function isThresholdClear(edit: ThresholdEdit): edit is ThresholdClear {
  return edit.clear === true;
}

/** The `staffing_thresholds` rows an assignment set upserts. */
export function thresholdUpsertRows(
  assignments: readonly ThresholdAssignment[],
): Record<string, string | number>[] {
  return assignments.map((assignment) => ({
    department: assignment.department,
    day_of_week: assignment.dayOfWeek,
    time_slot: assignment.timeSlot,
    minimum_staff: assignment.minimumStaff,
    warning_threshold: assignment.warningThreshold,
    updated_at: new Date().toISOString(),
  }));
}

/**
 * The PostgREST filter that matches exactly the slots being cleared.
 *
 * One `or` of `and` groups rather than three `in` filters: `in` on each column
 * would match the cross product of the three lists and delete slots nobody asked
 * to clear. Every value interpolated here has already been checked against a
 * closed set — `KNOWN_DEPARTMENTS`, `KNOWN_TIME_SLOTS`, and a whole number
 * between 0 and 6 — so no caller-supplied text reaches the filter.
 *
 * Empty when there is nothing to clear, which the caller reads as "issue no
 * delete at all" rather than as a filter matching everything.
 */
export function thresholdClearFilter(clears: readonly ThresholdSlot[]): string {
  return clears
    .map(
      (slot) =>
        `and(department.eq.${slot.department},day_of_week.eq.${slot.dayOfWeek},time_slot.eq.${slot.timeSlot})`,
    )
    .join(',');
}

/** A row as one entry of the snapshot, or null when it names a slot no caller asks about. */
function toThresholdEntry(
  row: StaffingThresholdRow & { updated_at?: unknown },
): StaffingThresholdEntry | null {
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
    return null;
  }

  return {
    department,
    dayOfWeek,
    timeSlot,
    minimumStaff,
    warningThreshold,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  };
}

/**
 * The stored slots, ordered department, then day of week, then slot.
 *
 * Ordered here rather than in the query so the editor's grid is filled from a
 * deterministic list whichever order the database returned. Rows that cannot be
 * read are dropped for the same reason `buildStaffingThresholdTable` drops them:
 * they describe no slot a caller will ask about.
 */
export function toThresholdSnapshot(
  rows: readonly (StaffingThresholdRow & { updated_at?: unknown })[] | null | undefined,
): StaffingThresholdSnapshot {
  const entries = (rows ?? [])
    .map(toThresholdEntry)
    .filter((entry): entry is StaffingThresholdEntry => entry !== null)
    .sort(
      (a, b) =>
        KNOWN_DEPARTMENTS.indexOf(a.department) - KNOWN_DEPARTMENTS.indexOf(b.department) ||
        a.dayOfWeek - b.dayOfWeek ||
        KNOWN_TIME_SLOTS.indexOf(a.timeSlot) - KNOWN_TIME_SLOTS.indexOf(b.timeSlot),
    );

  return { entries };
}

/**
 * Every configured slot, with a read failure reported rather than absorbed.
 *
 * One query for the whole table. It holds at most four departments times seven
 * days times three slots, so there is nothing to page and no reason to read a
 * slot at a time (Requirement 20, criteria 1 and 2).
 *
 * Requirements: 2.3, 6.3, 22.16
 */
export async function loadThresholdSnapshot(
  supabase: PolicyClient,
): Promise<StaffingThresholdSnapshot> {
  const { data, error } = await supabase.from('staffing_thresholds').select(THRESHOLD_COLUMNS);

  if (error) {
    console.error('[time-attendance] staffing threshold read failed', error);
    throw new PolicyServiceError('read_failed', THRESHOLDS_UNREADABLE_MESSAGE);
  }

  return toThresholdSnapshot(data as (StaffingThresholdRow & { updated_at?: unknown })[] | null);
}

/**
 * Apply a set of edits and answer with what the table then holds.
 *
 * Two statements at most, whatever the size of the edited set: one upsert for
 * every pair being stored and one delete for every slot being cleared. Not one
 * request per slot, and not one statement per slot — the editor covers 84 cells
 * and a per-cell round trip is what Requirement 20, criteria 1 and 2 rule out.
 *
 * The upsert resolves against `unique_threshold_per_slot`, so an edit to a slot
 * that already has a row replaces its figures and an edit to one that does not
 * inserts it. `staffing_thresholds` carries no `updated_by` column, so who made
 * the change is not recorded on the row; the write is reserved to `super_admin`
 * by `staffing_thresholds_admin_all`, and a threshold change is not one of the
 * five events Requirement 16, criterion 1 asks the Attendance_Audit_Log to record
 * — that list names an employee and a work date, which a configuration change
 * does not.
 *
 * The whole table is read back afterwards rather than the changed rows alone, so
 * what the editor displays is what the database now holds, including the slots
 * that a clear removed and that therefore have nothing to return.
 *
 * Requirements: 2.3, 6.3, 6.4, 20.1, 20.2, 21.6, 21.12, 22.16
 */
export async function saveStaffingThresholds(
  supabase: PolicyClient,
  edits: readonly ThresholdEdit[],
): Promise<StaffingThresholdSnapshot> {
  const clears = edits.filter(isThresholdClear);
  const assignments = edits.filter(
    (edit): edit is ThresholdAssignment => !isThresholdClear(edit),
  );

  if (assignments.length > 0) {
    const { error } = await supabase
      .from('staffing_thresholds')
      .upsert(thresholdUpsertRows(assignments), { onConflict: THRESHOLD_CONFLICT_TARGET });

    if (error) {
      console.error('[time-attendance] staffing threshold write failed', error);
      throw new PolicyServiceError('write_failed', THRESHOLDS_UNWRITABLE_MESSAGE);
    }
  }

  if (clears.length > 0) {
    const { error } = await supabase
      .from('staffing_thresholds')
      .delete()
      .or(thresholdClearFilter(clears));

    if (error) {
      console.error('[time-attendance] staffing threshold clear failed', error);
      throw new PolicyServiceError('write_failed', THRESHOLDS_UNWRITABLE_MESSAGE);
    }
  }

  try {
    return await loadThresholdSnapshot(supabase);
  } catch {
    // The edits are committed. Reporting the read as a failed save would be false.
    throw new PolicyServiceError('read_failed', THRESHOLDS_SAVED_UNREADABLE_MESSAGE);
  }
}

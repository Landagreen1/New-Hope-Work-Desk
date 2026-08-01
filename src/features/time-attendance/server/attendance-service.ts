// src/features/time-attendance/server/attendance-service.ts
// The read paths every attendance surface is served from — the day read behind
// Today, the paged record read behind the Exception_Queue, the metric set behind
// Overview, the single-employee history behind Employee_Trends, and the
// per-employee figures a payroll period is calculated from — and the two write
// paths that correct a recorded day and mark one reviewed.
//
// ## The three-step read
//
// Every function in this module does the same three things, in the same order:
//
//   1. Resolve scope through `visibleProfileIds`. That is the only place a read
//      decides whose data it may touch (Requirements 21.1, 21.2).
//   2. Fetch source rows with a fixed number of set-based range queries. The
//      count is a property of the function, not of the roster size or the range
//      length: no query is issued inside a loop over employees or dates
//      (Requirements 20.1, 20.2, 20.3).
//   3. Hand the rows to `deriveRange` and read the answers off the records.
//
// Step 3 is the whole point. `derivedStatus`, worked hours, scheduled hours,
// late minutes, and break minutes are read from the domain layer and never
// recomputed here (Requirements 3.14, 3.15). This module maps rows to
// `AttendanceInputs`, aggregates already-derived figures, and pages the result.
// It contains no attendance rule.
//
// ## Query counts
//
// | read                          | configuration | range reads | total |
// | ----------------------------- | ------------- | ----------- | ----- |
// | `getDay`                      | 1             | 5           | 6     |
// | `getRecords`                  | 1             | 8           | 9     |
// | `getMetrics`                  | 1             | 8           | 9     |
// | `getTrends`                   | 1             | 8           | 9     |
// | `payrollInputs` legacy_parity | 0             | 4           | 4     |
// | `payrollInputs` recomputed    | 1             | 9           | 10    |
// | `applyCorrection`             | 1             | 8           | 9 + 1 RPC |
// | `markReviewed`                | 1             | 8           | 9 + 1 RPC |
//
// The five range reads are the ones the design names: profiles, published
// schedules over the range, clock entries over the range window, breaks for
// those entries, and approved absences overlapping the range. The three the
// review reads add are `attendance_day_reviews`, `attendance_notes`, and the
// `approve_unscheduled` entries in `attendance_audit_log`, which is where an
// approval of unscheduled work is recorded. Today displays none of those three,
// so the day read does not pay for them.
//
// Every read is issued unconditionally, including the breaks read when no clock
// entry was returned. Skipping a read when its input list happens to be empty
// would make the outbound query count a function of the data, which is exactly
// what Requirement 20, criteria 1 and 2 forbid and what Property 46 measures.
//
// ## Why the read window is wider than the requested range
//
// A clock session belongs to the work date of the shift it was worked against,
// not to the calendar date its clock-in happens to land on (Requirement 3,
// criterion 18). Attribution therefore runs through `shiftAttributionWindows`
// and `attributeSessionWorkDate`, and both need rows the requested range does
// not contain:
//
// - A session clocked in at 01:00 on the range's first date can belong to an
//   overnight shift that started the previous date. Schedules and absences are
//   read one date either side of the requested range so that session is
//   attributed to the date it was worked, and the records for those boundary
//   dates are dropped before the response is built.
// - A session belonging to the range's last date can clock in after that date
//   ends: an overnight shift plus the four-hour attribution margin reaches into
//   the second following date, and an employee timezone up to fourteen hours
//   from UTC moves the boundary again. Clock entries are therefore read from two
//   dates before the range to three dates after it.
//
// Naive date bucketing — `clock_in::date` — would attribute those sessions to
// the wrong date and would report an overnight worker as absent on the date they
// worked and unscheduled on the date they finished.
//
// ## The two write paths
//
// `applyCorrection` and `markReviewed` are four steps each, in this order:
//
//   1. Authorise. `canAdministerAttendance` before anything is read or written,
//      so a call outside the permitted set touches no data (Requirements 21.4,
//      21.15). Each function asserts the same rule again as its owner.
//   2. Check what the call needs to shape its payload: the field, the reason, the
//      idempotency key. Not the value — see below.
//   3. One RPC call. `attendance_apply_correction` and
//      `attendance_mark_reviewed` each lock the target row, apply the change, and
//      insert the `attendance_audit_log` row as the last statement, so a failed
//      audit write leaves the change uncommitted and returns the reason
//      (Requirement 16, criterion 6).
//   4. Recompute the affected `DailyAttendanceRecord` from source rows, through
//      the same read path every screen uses, after the transaction has committed.
//
// Step 4 is why there is nothing to invalidate. A record is computed on read and
// never stored, so the recompute is a read of the rows the function just wrote:
// Requirement 3, criterion 16 and Correctness Property 35 hold structurally
// rather than by a cache-invalidation path remembering to run.
//
// ## Why the previous value and the payroll period are read back rather than
// resolved here
//
// The design's sequence diagram has the service resolve both before the call.
// `v1.9.4` moved both inside the function, deliberately (its decisions 2 and 5):
// the previous value is read from the row *as locked*, and the payroll period is
// resolved from `payroll_periods` by the database that owns the date-to-period
// mapping. A value read here, before the lock, could disagree with the value the
// audit entry records, and a period resolved here could mis-attribute a
// correction. Both come back on the envelope, and this module reports what the
// function committed rather than what it guessed beforehand.
//
// The same reasoning governs the value: every instant and every integer is cast
// once inside the function, before any lock is taken, and a cast failure comes
// back as a named refusal. Re-validating the nine field shapes here would be a
// second implementation of the correction vocabulary, and the two would drift.
// What this module checks is what it needs in order to build the call at all.
//
// ## What a correction never does
//
// It never writes a derived value. It never recomputes a stored payroll summary:
// a correction inside a `processed` or `paid` period is permitted, because an
// administrator may need to fix the record of what happened, and the audit entry
// carries `payroll_period_id` so a later period can carry the adjustment
// deliberately (Requirement 2, criterion 6 governs any change to that, and
// Correctness Property 39 is what it protects). The result reports the period and
// its status so a screen can say so.
//
// Requirements: 3.14 (status and hours read only from the service), 3.15 (no
// second derivation), 12.4 (one row per employee per work date), 12.17 (pages
// of at most 100 rows), 12.19 (the range is the caller's), 13.7 (the metric set
// in one request), 14.2 (the twelve trend values), 14.3 (scheduled versus worked
// per date), 14.6 (the trend set in one request), 20.1 (no request per
// employee), 20.2 (no request per date), 20.3 (the whole team set in one
// request), 20.8 (at most 100 rows per request), 2.4 (payroll output unchanged),
// 19.6 (payroll consumes attendance figures rather than deriving them), 3.16 (a
// correction recomputes the affected record before the next read returns), 5.16,
// 12.13, 21.9 (a correction carries a stored reason), 5.17, 16.1, 16.2 (what an
// audit entry records), 5.18, 12.14 (the recomputed record comes back with the
// correction), 12.15, 12.16 (marking a day reviewed, first reviewer retained),
// 16.6 (a failed audit write leaves the change uncommitted), 21.4, 21.15
// (correction is an administrator capability, and a call outside the permitted
// set changes nothing).

import type { SupabaseClient } from '@supabase/supabase-js';

import { APP_ROLES, roleToDepartment } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import {
  aggregateMetrics,
  attributeSessionWorkDate,
  deriveRange,
  filterRecords,
  mergeRecordQuery,
  recordKey,
  roundToTwoDecimals,
  shiftAttributionWindows,
  type AttendanceMetrics,
  type MetricKey,
  type MetricUnit,
  type RecordQuery,
  type RecordSubject,
  type RecordSubjectIndex,
  type ScheduleInput,
} from '../domain/attendance';
import type { AuditQuery } from '../domain/audit';
// One implementation of "a reason with content", already property-tested against
// Requirements 10.3 and 10.10, so a correction and a leave decision cannot
// disagree about whether a whitespace-only string is a reason.
import { reasonWithContent } from '../domain/pto';
import type {
  AttendanceInputs,
  AttendancePolicy,
  ClockSessionInput,
  DailyAttendanceRecord,
  DateRange,
} from '../domain/types';
import { addCalendarDays, workDateOf } from '../domain/work-date';
import type {
  BreakType,
  PayrollPeriodStatus,
  PTOType,
  ScheduleStatus,
  ShiftType,
} from '../types';
import type { ApiFailureCode } from './api-response';
import { DEFAULT_ATTENDANCE_POLICY, loadAttendancePolicy } from './policy';
import {
  type Actor,
  canAdministerAttendance,
  canReviewTeamAttendance,
  visibleProfileIds,
} from './visibility';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * The most rows one record read returns (Requirements 12.17, 20.8). A caller
 * asking for more gets this; a caller asking for fewer gets what it asked for.
 */
export const RECORDS_PAGE_LIMIT = 100;

/**
 * The most entries one audit read returns (Requirement 16, criterion 7). A
 * caller asking for more gets this; a caller asking for fewer gets what it asked
 * for.
 */
export const AUDIT_PAGE_LIMIT = 100;

/** The range a record or metric read falls back to when the caller names none. */
export const DEFAULT_RANGE_DAYS = 14;

/**
 * The widest range a single read will assemble, in dates.
 *
 * Not a performance tuning knob: it is the point past which an accidental range
 * — a date picker cleared to the epoch, a query string typo — would build
 * millions of records in memory before anything downstream could reject it. A
 * year of history plus a month of slack is more than any view asks for, and
 * exceeding it is reported rather than attempted.
 */
export const MAX_RANGE_DAYS = 400;

/**
 * Dates of schedule and absence context read either side of the requested
 * range, so a session belonging to a boundary date is attributed to the shift it
 * was worked against rather than to the calendar date it clocked in on.
 *
 * One date is enough: an overnight shift ends on the date after it starts, so
 * the earliest shift that can claim a session on the range's first date started
 * one date earlier.
 */
const CONTEXT_DAYS = 1;

/**
 * Dates of clock-entry window read before the requested range.
 *
 * A work date can begin up to fourteen hours before UTC midnight, and the
 * attribution margin reaches four hours before a shift starts. Two dates covers
 * both with room to spare.
 */
const CLOCK_WINDOW_LEAD_DAYS = 2;

/**
 * Dates of clock-entry window read after the requested range.
 *
 * The latest instant attributable to the range's last date is an overnight shift
 * ending on the following date plus the four-hour margin, shifted again by an
 * employee timezone behind UTC. Three dates covers it.
 */
const CLOCK_WINDOW_TRAIL_DAYS = 3;

/** `employee_schedules.status` values a read admits. Published rows only. */
const READ_SCHEDULE_STATUSES: readonly ScheduleStatus[] = ['published'];

/** `pto_requests.status` values that record an absence the employee will take. */
const ABSENCE_STATUSES = ['approved', 'partially_approved'] as const;

/** The `attendance_audit_log.action` that approves unscheduled work. */
const APPROVE_UNSCHEDULED_ACTION = 'approve_unscheduled';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const KNOWN_BREAK_TYPES: readonly BreakType[] = ['lunch', 'short', 'personal'];

const KNOWN_SHIFT_TYPES: readonly ShiftType[] = [
  'regular',
  'overtime',
  'half_day',
  'training',
  'on_call',
];

const KNOWN_SCHEDULE_STATUSES: readonly ScheduleStatus[] = [
  'scheduled',
  'published',
  'completed',
  'missed',
  'cancelled',
];

const KNOWN_PTO_TYPES = [
  'vacation',
  'sick',
  'personal',
  'bereavement',
  'unpaid',
] as const satisfies readonly PTOType[];

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * The failures an attendance call can have.
 *
 * Drawn from `ApiFailureCode` rather than declared independently, so every code
 * this module throws already has a shape in `api-response.ts` and
 * `serviceFailure` can map it without a branch of its own. The same reasoning
 * `PTOServiceErrorCode` follows.
 *
 * The three read codes came first: `read_failed` for a source read that failed,
 * `not_visible` for a record outside the caller's visibility, `invalid_range`
 * for a date or range the module will not read. The mutation paths add
 * `not_authorised`, `invalid_parameter`, `reason_required`, `already_clocked_in`
 * for a second open session, `write_failed` for a change that could not be
 * applied, and `audit_write_failed` for the one Requirement 16, criterion 6
 * describes — the change rolled back because its audit entry could not be
 * recorded.
 */
export type AttendanceServiceErrorCode = Extract<
  ApiFailureCode,
  | 'not_authorised'
  | 'not_visible'
  | 'invalid_parameter'
  | 'invalid_range'
  | 'reason_required'
  | 'already_clocked_in'
  | 'read_failed'
  | 'write_failed'
  | 'audit_write_failed'
>;

/**
 * An attendance call that could not be served.
 *
 * `code` is stable so the route layer can map it to a status without matching on
 * a message, and `detail` carries the supporting facts a log or an inline field
 * message needs — including the `field` an invalid-parameter failure names.
 */
export class AttendanceServiceError extends Error {
  readonly code: AttendanceServiceErrorCode;
  readonly detail: Readonly<Record<string, string>>;

  constructor(
    code: AttendanceServiceErrorCode,
    message: string,
    detail: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'AttendanceServiceError';
    this.code = code;
    this.detail = detail;
  }
}

// ─── Context ─────────────────────────────────────────────────────────────────

/**
 * Any Supabase client. The route layer passes the cookie-bound server client so
 * every read runs under the caller's own row level security, and a script or a
 * test passes its own.
 */
export type AttendanceClient = SupabaseClient;

/**
 * Everything a read needs besides its own arguments.
 *
 * `evaluatedAt` exists because the domain layer will not read the clock: a
 * record is a function of its inputs, and the evaluation instant is one of them.
 * The service is where the clock is read, and a caller that supplies the instant
 * gets a reproducible read — which is what makes these paths testable at all.
 *
 * `policy` lets a composite request that has already loaded the configuration
 * pass it down instead of reading `attendance_policy` a second time.
 */
export interface AttendanceContext {
  client: AttendanceClient;
  /** ISO instant. Defaults to the moment the read starts. */
  evaluatedAt?: string;
  /** A pre-loaded policy, to avoid a second configuration read. */
  policy?: AttendancePolicy;
}

// ─── Response shapes ─────────────────────────────────────────────────────────

/**
 * An employee in scope for a read: the department the record queries filter on,
 * plus the fields a row or a drawer labels them with.
 *
 * Extends the domain's `RecordSubject`, so the same object serves as the
 * department source for `matchesRecordQuery` and as the display row for the
 * screen. Two shapes would let a queue filter by one department and label by
 * another.
 */
export interface AttendanceEmployee extends RecordSubject {
  displayName: string;
  initials: string;
  role: AppRole;
  /** `profiles.timezone`, the zone a clock instant's work date is read in. */
  timezone: string;
  isActive: boolean;
}

/** One manager note on one employee and work date. */
export interface AttendanceNote {
  id: string;
  profileId: string;
  workDate: string;
  note: string;
  authorProfileId: string;
  createdAt: string;
}

/** What one date's read returns. */
export interface DayResponse {
  /** The date read, `YYYY-MM-DD`. */
  date: string;
  /** The instant the records were evaluated at. */
  evaluatedAt: string;
  /**
   * The tolerances the records were derived under.
   *
   * Carried because My Day's alert list is built by `buildMyDayAlerts`, which
   * states the grace period in the words of the late-arrival alert. A screen
   * holding its own copy of that figure would be a second place the policy is
   * configured, and the read already loaded the singleton, so this costs no
   * query.
   *
   * Requirements: 4.13, 19.1
   */
  policy: AttendancePolicy;
  /** True when the read covered employees other than the caller. */
  teamScope: boolean;
  /** The employees in scope, whether or not they carry a record on the date. */
  employees: AttendanceEmployee[];
  /** At most one record per employee, for employees with something recorded. */
  records: DailyAttendanceRecord[];
}

/** One page of rows out of a larger match. */
export interface Paged<T> {
  rows: T[];
  /** 1-based. */
  page: number;
  limit: number;
  /** Rows the query matched before paging. */
  total: number;
  hasMore: boolean;
}

/** A page of Daily_Attendance_Records, with what the rows refer to. */
export interface RecordPage extends Paged<DailyAttendanceRecord> {
  /** The query the rows were selected by, scope and range resolved. */
  query: RecordQuery;
  evaluatedAt: string;
  employees: AttendanceEmployee[];
}

/**
 * The filters an Overview read accepts: the record filters without paging,
 * because a metric is computed over the whole match rather than over a page.
 */
export type MetricQuery = Omit<RecordQuery, 'page' | 'limit'>;

/**
 * Every Daily_Attendance_Record a query matches, unpaged.
 *
 * The read `getRecords` pages and the read the Export_Service consumes whole.
 * One shape for both, because Requirement 15, criteria 2, 3, and 7 say the
 * exported rows are the view's rows: the same filters, in the same order, from
 * the same derivation. Two reads that happened to agree today would be two
 * reads that could disagree tomorrow, which is exactly what Correctness
 * Property 33 measures.
 *
 * `query` carries no paging. It is the caller's filters conjoined with the
 * resolved scope and the resolved range, which is what a file name and an
 * empty-set notice have to name (Requirements 15.6, 15.8).
 */
export interface RecordSet {
  /** Every matched row, in `deriveRange` order: work date, then employee. */
  rows: DailyAttendanceRecord[];
  /** The query the rows were selected by, scope and range resolved, unpaged. */
  query: MetricQuery;
  /** The range the read resolved, both bounds inclusive. */
  range: DateRange;
  evaluatedAt: string;
  employees: AttendanceEmployee[];
  /** The tolerances the records were derived under. */
  policy: AttendancePolicy;
}

/** The Overview metric set, with what the metrics were computed over. */
export interface MetricsResponse extends AttendanceMetrics {
  evaluatedAt: string;
  employees: AttendanceEmployee[];
}

/**
 * The twelve values Requirement 14, criterion 2 lists, in that order.
 *
 * Eight are Overview metrics under a trend-facing name, so a trend figure and
 * the Overview figure for the same employee and range cannot disagree. The other
 * four are counts and sums over the same record set and the notes read.
 */
export type TrendKey =
  | 'scheduled_hours'
  | 'worked_hours'
  | 'attendance_rate'
  | 'late_occurrence_count'
  | 'total_late_minutes'
  | 'absence_count'
  | 'time_off_days_used'
  | 'overtime_hours'
  | 'break_minutes'
  | 'missing_punch_count'
  | 'correction_count'
  | 'manager_note_count';

/** One trend value, with the query that produced it for the drill-down. */
export interface TrendValue {
  key: TrendKey;
  label: string;
  unit: MetricUnit;
  value: number;
  /** Rows the value was computed over: the size of the drill-down set. */
  recordCount: number;
  /** The query that produced the value. Hand this to the Exception_Queue. */
  query: RecordQuery;
}

/** One date of the scheduled-versus-worked comparison. */
export interface TrendDay {
  workDate: string;
  scheduledHours: number;
  workedHours: number;
  derivedStatus: DailyAttendanceRecord['derivedStatus'];
  payrollBlocking: boolean;
  /** The single-date query behind this point. */
  query: RecordQuery;
}

/** One employee's history over one range. */
export interface TrendResponse {
  profileId: string;
  employee: AttendanceEmployee | null;
  range: DateRange;
  evaluatedAt: string;
  /** The twelve values, in Requirement 14, criterion 2 order. */
  values: TrendValue[];
  /** One entry per work date carrying a record, ascending. */
  byDate: TrendDay[];
  /** The manager notes on the employee inside the range, newest first. */
  notes: AttendanceNote[];
  /** Every record in the range, so a drill-down needs no second read. */
  records: DailyAttendanceRecord[];
}

/**
 * One `attendance_audit_log` entry, with every field Requirement 16, criterion 2
 * records.
 *
 * `previousValue` and `newValue` are the stored `jsonb` as it arrived. They are
 * not flattened, not summarised, and not rendered: what a correction changed is
 * evidence, and reshaping evidence in a read is how an audit trail stops being
 * one. The view spells them; this read carries them.
 *
 * Requirements: 16.2, 16.3
 */
export interface AuditEntry {
  id: string;
  /** The affected employee. Null for an entry that names none. */
  profileId: string | null;
  /** The affected work date, `YYYY-MM-DD`. Null for an entry that names none. */
  workDate: string | null;
  /** The object changed: `clock_entry`, `break`, `note`, `review`, and so on. */
  entityType: string;
  /** The row changed, when the action changed a stored row. */
  entityId: string | null;
  /** The recorded action. A value outside `AUDIT_ACTIONS` is carried as given. */
  action: string;
  /** The field changed, when the action changed one. */
  field: string | null;
  previousValue: unknown;
  newValue: unknown;
  /** Who performed it. */
  actorProfileId: string;
  reason: string | null;
  /** The payroll period covering the work date, when one does. */
  payrollPeriodId: string | null;
  /** When the entry was written. */
  createdAt: string;
}

/**
 * A payroll period an audit entry refers to.
 *
 * Read alongside the page so the view can state the period as its dates rather
 * than as an identifier. Requirement 16, criterion 2 records the related period
 * and criterion 3 asks the view to display the recorded fields; a bare uuid
 * displays the field without communicating it.
 */
export interface AuditPayrollPeriod {
  id: string;
  /** `period_start`, inclusive. */
  from: string;
  /** `period_end`, inclusive. */
  to: string;
  status: PayrollPeriodStatus | null;
}

/**
 * One page of audit entries, with what the entries refer to.
 *
 * `employees` is every profile in scope rather than only those the page mentions,
 * because it populates the employee and actor filter controls: a filter offering
 * only the employees on the current page could not be used to find an entry that
 * is not on it.
 *
 * Requirements: 16.3, 16.4, 16.7
 */
export interface AuditPage extends Paged<AuditEntry> {
  /** The query the entries were selected by, with the applied paging. */
  query: AuditQuery;
  employees: AttendanceEmployee[];
  /** The periods the page's entries name, in no particular order. */
  payrollPeriods: AuditPayrollPeriod[];
}

// ─── Source row shapes ───────────────────────────────────────────────────────

/**
 * Rows as they arrive. Fields that a mapping has to check are typed `unknown`,
 * because declaring `role` as `AppRole` here would assume the thing the mapping
 * verifies.
 *
 * Exported because `AttendanceSources` is exported: a caller assembling sources
 * without a database — a test, a script — needs the shapes the reads produce.
 */
export interface ProfileRow {
  id: string;
  display_name?: unknown;
  initials?: unknown;
  role?: unknown;
  timezone?: unknown;
  is_active?: unknown;
}

export interface ScheduleRow {
  profile_id: string;
  schedule_date: string;
  shift_start?: unknown;
  shift_end?: unknown;
  shift_type?: unknown;
  status?: unknown;
}

export interface ClockEntryRow {
  id: string;
  profile_id: string;
  clock_in: string;
  clock_out?: string | null;
  adjusted_by?: string | null;
  adjustment_reason?: string | null;
}

export interface BreakRow {
  id: string;
  clock_entry_id: string;
  break_start: string;
  break_end?: string | null;
  break_type?: unknown;
  duration_minutes?: unknown;
}

export interface AbsenceRow {
  id: string;
  profile_id: string;
  pto_type?: unknown;
  start_date: string;
  end_date: string;
}

export interface ReviewRow {
  profile_id: string;
  work_date: string;
  reviewed_at?: string | null;
}

export interface NoteRow {
  id: string;
  profile_id: string;
  work_date: string;
  note?: unknown;
  author_profile_id?: unknown;
  created_at?: unknown;
}

export interface ApprovalRow {
  profile_id?: string | null;
  work_date?: string | null;
}

/** One `attendance_audit_log` row as it arrives. */
export interface AuditLogRow {
  id: string;
  profile_id?: string | null;
  work_date?: string | null;
  entity_type?: unknown;
  entity_id?: string | null;
  action?: unknown;
  field?: string | null;
  old_value?: unknown;
  new_value?: unknown;
  actor_profile_id?: string | null;
  reason?: string | null;
  payroll_period_id?: string | null;
  created_at?: unknown;
}

/** One `payroll_periods` row, as an audit entry needs it. */
export interface AuditPeriodRow {
  id: string;
  period_start?: unknown;
  period_end?: unknown;
  status?: unknown;
}

/**
 * Everything one read fetched, plus the window it fetched over.
 *
 * Separated from the queries that produce it so that input assembly and record
 * derivation are testable without a database: `buildAttendanceInputs` is a pure
 * function of this shape.
 */
export interface AttendanceSources {
  /** The requested range, inclusive. Records outside it are dropped. */
  range: DateRange;
  /** The range inputs are assembled over: one date wider at each end. */
  contextRange: DateRange;
  evaluatedAt: string;
  policy: AttendancePolicy;
  employees: AttendanceEmployee[];
  schedules: readonly ScheduleRow[];
  entries: readonly ClockEntryRow[];
  breaks: readonly BreakRow[];
  absences: readonly AbsenceRow[];
  reviews: readonly ReviewRow[];
  notes: readonly NoteRow[];
  unscheduledApprovals: readonly ApprovalRow[];
}

// ─── Field readers ───────────────────────────────────────────────────────────

function readText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function readRole(value: unknown): AppRole {
  return APP_ROLES.includes(value as AppRole) ? (value as AppRole) : 'agent';
}

function readBreakType(value: unknown): BreakType {
  return KNOWN_BREAK_TYPES.includes(value as BreakType) ? (value as BreakType) : 'lunch';
}

function readShiftType(value: unknown): ShiftType {
  return KNOWN_SHIFT_TYPES.includes(value as ShiftType) ? (value as ShiftType) : 'regular';
}

/**
 * A schedule row's status.
 *
 * Falls back to `published` rather than to `scheduled`, because the read filters
 * to published rows: a row that reached this mapping was published, and reading
 * an unrecognised value as a draft would silently turn a real shift into
 * unscheduled work.
 */
function readScheduleStatus(value: unknown): ScheduleStatus {
  return KNOWN_SCHEDULE_STATUSES.includes(value as ScheduleStatus)
    ? (value as ScheduleStatus)
    : 'published';
}

/**
 * A request type read from a stored row.
 *
 * `PTOType` names exactly the five values the `pto_requests.pto_type` check
 * constraint accepts, so a value the constraint stored is a value this narrows
 * to. Anything else — a row written before the constraint, or a value added to
 * the constraint without being added to the type — falls back to `vacation`
 * rather than being carried through as a type the rest of the module would
 * reject.
 */
function readPtoType(value: unknown): PTOType {
  return KNOWN_PTO_TYPES.includes(value as PTOType) ? (value as PTOType) : 'vacation';
}

function readNumber(value: unknown): number | null {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : null;
}

function isCalendarDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_PATTERN.test(value);
}

/** A stored `date` column, which can arrive as `YYYY-MM-DD` or as a timestamp. */
function readWorkDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10) return null;
  const candidate = value.slice(0, 10);
  return DATE_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Whether this runtime knows `timeZone`.
 *
 * Probed through `workDateOf` so `domain/work-date.ts` stays the only module in
 * the feature that touches zone data (Requirements 19.9, 19.10). An employee
 * carrying an unusable zone would otherwise throw inside attribution and blank
 * the whole read.
 */
const TIME_ZONE_PROBE = new Date(0);

function isUsableTimeZone(timeZone: string): boolean {
  try {
    workDateOf(TIME_ZONE_PROBE, timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * A profile row as an employee.
 *
 * An unrecognised role reads as `agent` and an unusable timezone falls back to
 * the business timezone, so one bad profile row costs that employee's labels
 * rather than the whole read.
 */
export function toAttendanceEmployee(
  row: ProfileRow,
  policy: AttendancePolicy,
): AttendanceEmployee {
  const role = readRole(row.role);
  const timezone = readText(row.timezone, policy.businessTimezone);

  return {
    profileId: row.id,
    department: roleToDepartment(role),
    displayName: readText(row.display_name, row.id),
    initials: readText(row.initials, '??'),
    role,
    timezone: isUsableTimeZone(timezone) ? timezone : policy.businessTimezone,
    isActive: row.is_active !== false,
  };
}

/** The employee index the record queries filter departments through. */
export function toSubjectIndex(employees: readonly AttendanceEmployee[]): RecordSubjectIndex {
  return new Map(employees.map((employee) => [employee.profileId, employee]));
}

// ─── Range resolution ────────────────────────────────────────────────────────

function assertCalendarDate(value: string, field: string): string {
  // Two checks, because the shape and the date are different mistakes:
  // `2026-2-3` fails the pattern, `2026-02-30` matches it and names no date.
  // `addCalendarDays(value, 0)` is the cheapest way to reject the second, and
  // its `RangeError` is translated so callers see one error type.
  if (isCalendarDate(value)) {
    try {
      return addCalendarDays(value, 0);
    } catch {
      // Falls through to the reported failure below.
    }
  }

  throw new AttendanceServiceError(
    'invalid_range',
    `attendance: ${field} must be a calendar date, received "${value}"`,
    { field, value: String(value) },
  );
}

/** Dates in an inclusive range, or a failure when the range is unusable. */
function rangeLength(range: DateRange): number {
  let days = 1;
  let cursor = range.from;
  while (cursor < range.to) {
    cursor = addCalendarDays(cursor, 1);
    days += 1;
    if (days > MAX_RANGE_DAYS) break;
  }
  return days;
}

/**
 * The range a read will honour: both ends validated, ordered, and inside the
 * width cap.
 */
function resolveRange(from: string, to: string): DateRange {
  const start = assertCalendarDate(from, 'from');
  const end = assertCalendarDate(to, 'to');

  if (start > end) {
    throw new AttendanceServiceError('invalid_range', 'attendance: from must not follow to', {
      from: start,
      to: end,
    });
  }

  const range = { from: start, to: end };
  const days = rangeLength(range);
  if (days > MAX_RANGE_DAYS) {
    throw new AttendanceServiceError(
      'invalid_range',
      `attendance: a range of more than ${MAX_RANGE_DAYS} dates cannot be read in one request`,
      { from: start, to: end, maxDays: String(MAX_RANGE_DAYS) },
    );
  }

  return range;
}

/**
 * The range a record or metric query names, or the fallback fortnight ending
 * today.
 *
 * The Exception_Queue's own default is the current pay period (Requirement 12,
 * criterion 19), which the caller supplies because only the caller knows which
 * period is current. This fallback exists so a query with no range reads
 * something sensible rather than everything.
 */
function resolveQueryRange(
  query: RecordQuery,
  evaluatedAt: string,
  policy: AttendancePolicy,
): DateRange {
  const to = query.to ?? workDateOf(new Date(evaluatedAt), policy.businessTimezone);
  const from =
    query.from ?? addCalendarDays(assertCalendarDate(to, 'to'), -(DEFAULT_RANGE_DAYS - 1));
  return resolveRange(from, to);
}

// ─── The five source reads, plus the three review reads ──────────────────────

type ProfileScope = string[] | 'all';

/**
 * A read that failed is reported rather than absorbed.
 *
 * Row level security answers a read the caller may not make with zero rows, not
 * with an error, so an error here is a fault worth surfacing: a missing table, a
 * dropped column, a lost connection. Absorbing it would show an administrator an
 * empty exception queue and let them conclude there is nothing to fix.
 */
function rowsOf<T>(
  table: string,
  result: { data: unknown; error: { message: string; code?: string } | null },
): T[] {
  if (result.error) {
    throw new AttendanceServiceError(
      'read_failed',
      `attendance: reading ${table} failed: ${result.error.message}`,
      { table, ...(result.error.code === undefined ? {} : { pgCode: result.error.code }) },
    );
  }
  return (result.data as T[] | null) ?? [];
}

async function readProfiles(
  client: AttendanceClient,
  scope: ProfileScope,
): Promise<ProfileRow[]> {
  let query = client
    .from('profiles')
    .select('id, display_name, initials, role, timezone, is_active');
  if (scope !== 'all') query = query.in('id', scope);

  return rowsOf<ProfileRow>('profiles', await query);
}

async function readSchedules(
  client: AttendanceClient,
  scope: ProfileScope,
  range: DateRange,
): Promise<ScheduleRow[]> {
  let query = client
    .from('employee_schedules')
    .select('profile_id, schedule_date, shift_start, shift_end, shift_type, status')
    .in('status', READ_SCHEDULE_STATUSES)
    .gte('schedule_date', range.from)
    .lte('schedule_date', range.to);
  if (scope !== 'all') query = query.in('profile_id', scope);

  return rowsOf<ScheduleRow>('employee_schedules', await query);
}

async function readClockEntries(
  client: AttendanceClient,
  scope: ProfileScope,
  window: { fromInstant: string; toInstant: string },
): Promise<ClockEntryRow[]> {
  let query = client
    .from('time_clock_entries')
    .select('id, profile_id, clock_in, clock_out, adjusted_by, adjustment_reason')
    .gte('clock_in', window.fromInstant)
    .lt('clock_in', window.toInstant);
  if (scope !== 'all') query = query.in('profile_id', scope);

  return rowsOf<ClockEntryRow>('time_clock_entries', await query);
}

/**
 * Breaks for the entries already read, in one query.
 *
 * Issued even when `entryIds` is empty, so the outbound query count does not
 * depend on whether the range happened to contain a clock entry.
 */
async function readBreaks(
  client: AttendanceClient,
  entryIds: readonly string[],
): Promise<BreakRow[]> {
  const query = client
    .from('time_clock_breaks')
    .select('id, clock_entry_id, break_start, break_end, break_type, duration_minutes')
    .in('clock_entry_id', entryIds);

  return rowsOf<BreakRow>('time_clock_breaks', await query);
}

async function readAbsences(
  client: AttendanceClient,
  scope: ProfileScope,
  range: DateRange,
): Promise<AbsenceRow[]> {
  // Overlap, not containment: a request that starts before the range and ends
  // inside it covers dates in the range.
  let query = client
    .from('pto_requests')
    .select('id, profile_id, pto_type, start_date, end_date')
    .in('status', ABSENCE_STATUSES)
    .lte('start_date', range.to)
    .gte('end_date', range.from);
  if (scope !== 'all') query = query.in('profile_id', scope);

  return rowsOf<AbsenceRow>('pto_requests', await query);
}

async function readReviews(
  client: AttendanceClient,
  scope: ProfileScope,
  range: DateRange,
): Promise<ReviewRow[]> {
  let query = client
    .from('attendance_day_reviews')
    .select('profile_id, work_date, reviewed_at')
    .gte('work_date', range.from)
    .lte('work_date', range.to);
  if (scope !== 'all') query = query.in('profile_id', scope);

  return rowsOf<ReviewRow>('attendance_day_reviews', await query);
}

async function readNotes(
  client: AttendanceClient,
  scope: ProfileScope,
  range: DateRange,
): Promise<NoteRow[]> {
  let query = client
    .from('attendance_notes')
    .select('id, profile_id, work_date, note, author_profile_id, created_at')
    .gte('work_date', range.from)
    .lte('work_date', range.to)
    .order('created_at', { ascending: false });
  if (scope !== 'all') query = query.in('profile_id', scope);

  return rowsOf<NoteRow>('attendance_notes', await query);
}

/**
 * The dates on which unscheduled work has been approved.
 *
 * There is no column for this: approving unscheduled work is a correction, and
 * corrections are recorded in `attendance_audit_log`. Reading it here is what
 * keeps `payrollBlocking` honest on the review surfaces, since an approved
 * unscheduled day must stop holding payroll (Requirement 12, criterion 8).
 */
async function readUnscheduledApprovals(
  client: AttendanceClient,
  scope: ProfileScope,
  range: DateRange,
): Promise<ApprovalRow[]> {
  let query = client
    .from('attendance_audit_log')
    .select('profile_id, work_date')
    .eq('action', APPROVE_UNSCHEDULED_ACTION)
    .gte('work_date', range.from)
    .lte('work_date', range.to);
  if (scope !== 'all') query = query.in('profile_id', scope);

  return rowsOf<ApprovalRow>('attendance_audit_log', await query);
}

/**
 * The clock-in window covering every session attributable to `range`.
 *
 * Expressed as instants at UTC midnight of the widened dates. The width is
 * fixed, so the window moves with the range but the query count does not.
 */
function clockWindow(range: DateRange): { fromInstant: string; toInstant: string } {
  return {
    fromInstant: `${addCalendarDays(range.from, -CLOCK_WINDOW_LEAD_DAYS)}T00:00:00.000Z`,
    toInstant: `${addCalendarDays(range.to, CLOCK_WINDOW_TRAIL_DAYS + 1)}T00:00:00.000Z`,
  };
}

/**
 * Step two of the three-step read: the source rows for one range and scope.
 *
 * Five range queries, or eight when `withReviewState` is set. Every query is
 * set-based and issued once, whatever the roster size and however long the
 * range (Requirements 20.1, 20.2, 20.3).
 *
 * They go out in two waves rather than one only because the breaks read needs
 * the clock-entry identifiers. Everything else is independent and concurrent.
 */
export async function readAttendanceSources(
  context: AttendanceContext,
  scope: ProfileScope,
  range: DateRange,
  withReviewState: boolean,
): Promise<AttendanceSources> {
  const evaluatedAt = context.evaluatedAt ?? new Date().toISOString();
  const policy = context.policy ?? (await loadAttendancePolicy(context.client));

  const contextRange: DateRange = {
    from: addCalendarDays(range.from, -CONTEXT_DAYS),
    to: addCalendarDays(range.to, CONTEXT_DAYS),
  };
  const window = clockWindow(range);

  const [profiles, schedules, entries, absences] = await Promise.all([
    readProfiles(context.client, scope),
    readSchedules(context.client, scope, contextRange),
    readClockEntries(context.client, scope, window),
    readAbsences(context.client, scope, contextRange),
  ]);

  const [breaks, reviews, notes, unscheduledApprovals] = await Promise.all([
    readBreaks(
      context.client,
      entries.map((entry) => entry.id),
    ),
    withReviewState ? readReviews(context.client, scope, range) : Promise.resolve([]),
    withReviewState ? readNotes(context.client, scope, range) : Promise.resolve([]),
    withReviewState
      ? readUnscheduledApprovals(context.client, scope, range)
      : Promise.resolve([]),
  ]);

  return {
    range,
    contextRange,
    evaluatedAt,
    policy,
    employees: profiles.map((row) => toAttendanceEmployee(row, policy)),
    schedules,
    entries,
    breaks,
    absences,
    reviews,
    notes,
    unscheduledApprovals,
  };
}

// ─── Input assembly ──────────────────────────────────────────────────────────

/** One (employee, work date) pair's worth of source facts. */
interface InputFacts {
  schedules: ScheduleInput[];
  sessions: ClockSessionInput[];
  absence: { requestId: string; ptoType: PTOType } | null;
  reviewedAt: string | null;
  unscheduledWorkApproved: boolean;
}

function emptyFacts(): InputFacts {
  return {
    schedules: [],
    sessions: [],
    absence: null,
    reviewedAt: null,
    unscheduledWorkApproved: false,
  };
}

function factsFor(byKey: Map<string, InputFacts>, profileId: string, workDate: string): InputFacts {
  const key = recordKey(profileId, workDate);
  const existing = byKey.get(key);
  if (existing !== undefined) return existing;
  const created = emptyFacts();
  byKey.set(key, created);
  return created;
}

function toScheduleInput(row: ScheduleRow): ScheduleInput | null {
  const start = row.shift_start;
  const end = row.shift_end;
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  return {
    start,
    end,
    shiftType: readShiftType(row.shift_type),
    status: readScheduleStatus(row.status),
  };
}

function toSessionInput(row: ClockEntryRow, breaks: readonly BreakRow[]): ClockSessionInput {
  return {
    id: row.id,
    clockIn: row.clock_in,
    clockOut: row.clock_out ?? null,
    breaks: breaks.map((item) => ({
      id: item.id,
      type: readBreakType(item.break_type),
      start: item.break_start,
      end: item.break_end ?? null,
      durationMinutes: readNumber(item.duration_minutes),
    })),
    adjustedBy: row.adjusted_by ?? null,
    adjustmentReason: row.adjustment_reason ?? null,
  };
}

/**
 * The work date a clock entry belongs to.
 *
 * Attribution runs through the domain's `attributeSessionWorkDate` against the
 * employee's own shift windows, so an overnight shift claims the sessions worked
 * against it whichever calendar date they clocked in on (Requirement 3,
 * criterion 18). Naive bucketing on the clock-in date is what this exists to
 * avoid.
 *
 * A `clock_in` that cannot be read as an instant — impossible for a `timestamptz
 * not null` column, but not impossible for a hand-repaired row — falls back to
 * the date portion of the stored text. The domain then reports the row as
 * inconsistent data through the `AX-12` exception rather than dropping it, which
 * is what puts it in front of somebody who can fix it.
 */
function attributeEntry(
  row: ClockEntryRow,
  employee: AttendanceEmployee,
  windows: ReturnType<typeof shiftAttributionWindows>,
): string | null {
  const clockIn = new Date(row.clock_in);
  if (Number.isFinite(clockIn.getTime())) {
    return attributeSessionWorkDate(clockIn, employee.timezone, windows);
  }
  return readWorkDate(row.clock_in);
}

/**
 * Step three's input: one `AttendanceInputs` per (employee, work date) pair
 * carrying a published schedule, a clock session, an approved absence, or a
 * recorded review.
 *
 * Pairs with none of those four produce no input, and therefore no record. A
 * date on which nothing was scheduled, nothing was worked, no leave was
 * approved, and no review was taken has nothing to report, and manufacturing a
 * record for it would fill the queue with rows that describe an ordinary day off
 * as needing review.
 *
 * A pair carrying more than one schedule row emits one input per row.
 * `deriveRange` collapses them with the domain's own preference rules, so the
 * choice between two schedule rows is made in one place rather than here.
 *
 * Pure: a function of `sources` alone, so the assembly and the attribution can
 * be tested without a database.
 *
 * Requirements: 3.1, 3.2, 3.18, 12.4, 12.20
 */
export function buildAttendanceInputs(sources: AttendanceSources): AttendanceInputs[] {
  const { contextRange, policy } = sources;
  const employees = new Map(
    sources.employees.map<[string, AttendanceEmployee]>((row) => [row.profileId, row]),
  );

  const schedulesByProfile = new Map<string, { workDate: string; schedule: ScheduleInput }[]>();
  for (const row of sources.schedules) {
    const workDate = readWorkDate(row.schedule_date);
    const schedule = toScheduleInput(row);
    if (workDate === null || schedule === null) continue;
    if (!employees.has(row.profile_id)) continue;
    const list = schedulesByProfile.get(row.profile_id);
    if (list === undefined) schedulesByProfile.set(row.profile_id, [{ workDate, schedule }]);
    else list.push({ workDate, schedule });
  }

  const breaksByEntry = new Map<string, BreakRow[]>();
  for (const row of sources.breaks) {
    const list = breaksByEntry.get(row.clock_entry_id);
    if (list === undefined) breaksByEntry.set(row.clock_entry_id, [row]);
    else list.push(row);
  }

  const byKey = new Map<string, InputFacts>();

  // Schedules. Attribution windows are built once per employee from the same
  // rows, so the session pass below never resolves a schedule twice.
  const windowsByProfile = new Map<string, ReturnType<typeof shiftAttributionWindows>>();
  for (const [profileId, rows] of schedulesByProfile) {
    windowsByProfile.set(profileId, shiftAttributionWindows(rows, policy));
    for (const row of rows) {
      if (!withinRange(row.workDate, contextRange)) continue;
      factsFor(byKey, profileId, row.workDate).schedules.push(row.schedule);
    }
  }

  // Clock sessions, attributed to the shift they were worked against.
  for (const row of sources.entries) {
    const employee = employees.get(row.profile_id);
    if (employee === undefined) continue;

    const workDate = attributeEntry(row, employee, windowsByProfile.get(row.profile_id) ?? []);
    if (workDate === null || !withinRange(workDate, contextRange)) continue;

    factsFor(byKey, row.profile_id, workDate).sessions.push(
      toSessionInput(row, breaksByEntry.get(row.id) ?? []),
    );
  }

  // Approved absences, one key per covered date inside the assembled range.
  for (const row of sources.absences) {
    if (!employees.has(row.profile_id)) continue;
    const start = readWorkDate(row.start_date);
    const end = readWorkDate(row.end_date);
    if (start === null || end === null || start > end) continue;

    const ptoType = readPtoType(row.pto_type);
    const first = start < contextRange.from ? contextRange.from : start;
    const last = end > contextRange.to ? contextRange.to : end;

    for (let date = first; date <= last; date = addCalendarDays(date, 1)) {
      const facts = factsFor(byKey, row.profile_id, date);
      // Lower request id wins, so a date covered by two approved requests does
      // not depend on which row the query returned first.
      if (facts.absence === null || row.id < facts.absence.requestId) {
        facts.absence = { requestId: row.id, ptoType };
      }
    }
  }

  // Reviews. A reviewed date is carried even when nothing else remains on it, so
  // the review status a caller filters by cannot vanish from the queue.
  for (const row of sources.reviews) {
    if (!employees.has(row.profile_id)) continue;
    const workDate = readWorkDate(row.work_date);
    if (workDate === null || !withinRange(workDate, contextRange)) continue;
    const facts = factsFor(byKey, row.profile_id, workDate);
    const reviewedAt = typeof row.reviewed_at === 'string' ? row.reviewed_at : null;
    facts.reviewedAt = earlier(facts.reviewedAt, reviewedAt);
  }

  // Approvals of unscheduled work. These never create a key: approving work that
  // was not recorded would be approving nothing.
  for (const row of sources.unscheduledApprovals) {
    const profileId = row.profile_id;
    const workDate = readWorkDate(row.work_date);
    if (typeof profileId !== 'string' || workDate === null) continue;
    const facts = byKey.get(recordKey(profileId, workDate));
    if (facts !== undefined) facts.unscheduledWorkApproved = true;
  }

  const inputs: AttendanceInputs[] = [];
  for (const [key, facts] of byKey) {
    const separator = key.lastIndexOf(':');
    const profileId = key.slice(0, separator);
    const workDate = key.slice(separator + 1);
    const employee = employees.get(profileId);
    if (employee === undefined) continue;

    const base = {
      profileId,
      workDate,
      employeeTimezone: employee.timezone,
      sessions: facts.sessions,
      approvedAbsence: facts.absence,
      unscheduledWorkApproved: facts.unscheduledWorkApproved,
      reviewedAt: facts.reviewedAt,
      policy,
      evaluatedAt: sources.evaluatedAt,
    } satisfies Omit<AttendanceInputs, 'schedule'>;

    if (facts.schedules.length === 0) {
      inputs.push({ ...base, schedule: null });
      continue;
    }
    for (const schedule of facts.schedules) inputs.push({ ...base, schedule });
  }

  return inputs;
}

function withinRange(workDate: string, range: DateRange): boolean {
  return workDate >= range.from && workDate <= range.to;
}

function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

/**
 * Step three: the records for one source set, clipped to the requested range.
 *
 * Derivation runs over the wider assembled range so boundary attribution is
 * right, then the boundary dates are dropped. Every read in this module funnels
 * through here, which is what makes a status or an hours figure the same number
 * on Today, in the Exception_Queue, on Overview, and in a trend.
 *
 * Requirements: 3.1, 3.14, 3.15, 3.16
 */
export function deriveRecords(sources: AttendanceSources): DailyAttendanceRecord[] {
  return deriveRange(buildAttendanceInputs(sources)).filter((record) =>
    withinRange(record.workDate, sources.range),
  );
}

// ─── Scope ───────────────────────────────────────────────────────────────────

/**
 * Step one: the employees this read may touch.
 *
 * `visibleProfileIds` is the only scoping decision in the module. Nothing below
 * widens it, and nothing below narrows it except a filter the caller asked for.
 *
 * Requirements: 21.1, 21.2
 */
async function resolveScope(actor: Actor): Promise<ProfileScope> {
  return visibleProfileIds(actor);
}

/** The scope as a query filter: `undefined` when no profile filter belongs. */
function scopeFilter(scope: ProfileScope): RecordQuery {
  return scope === 'all' ? {} : { profileIds: scope };
}

function assertVisible(scope: ProfileScope, profileId: string): void {
  if (scope !== 'all' && !scope.includes(profileId)) {
    throw new AttendanceServiceError(
      'not_visible',
      'attendance: that employee is outside your visibility',
      { profileId },
    );
  }
}

// ─── getDay ──────────────────────────────────────────────────────────────────

/**
 * Every visible employee's Daily_Attendance_Record for one date.
 *
 * Six queries: the policy singleton and the five range reads. The count does not
 * move with the roster, which is Requirement 20, criteria 1 through 3 and what
 * lets Team_Today load the whole team in one request.
 *
 * The review, note, and approval tables are not read. Today displays neither a
 * review stamp nor a payroll-blocking flag, so `reviewedAt` is null on these
 * records and unscheduled work reads as unapproved; the Review_Center reads
 * carry both.
 *
 * Requirements: 3.14, 3.15, 20.1, 20.2, 20.3
 */
export async function getDay(
  actor: Actor,
  date: string,
  context: AttendanceContext,
): Promise<DayResponse> {
  const day = assertCalendarDate(date, 'date');
  const scope = await resolveScope(actor);

  const sources = await readAttendanceSources(context, scope, { from: day, to: day }, false);

  return {
    date: day,
    evaluatedAt: sources.evaluatedAt,
    policy: sources.policy,
    teamScope: canReviewTeamAttendance(actor.role),
    employees: sortEmployees(sources.employees),
    records: deriveRecords(sources),
  };
}

function sortEmployees(employees: readonly AttendanceEmployee[]): AttendanceEmployee[] {
  return [...employees].sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) || a.profileId.localeCompare(b.profileId),
  );
}

// ─── getAllRecords and getRecords ────────────────────────────────────────────

/**
 * Every Daily_Attendance_Record a query matches, in the derivation's order.
 *
 * Nine queries: the policy singleton, the five range reads, and the three review
 * reads. The count does not move with the roster size, the range length, or the
 * number of rows the query matches, so reading the whole match costs what
 * reading one page of it costs.
 *
 * Each row is one employee on one work date however many exceptions it carries
 * (Requirements 12.4, 12.20). The returned `query` is the one the rows were
 * actually selected by — the caller's filters conjoined with the resolved scope
 * and range — so a caller that has to name its own filters, in a file name or in
 * an empty-set notice, names the filters that were applied.
 *
 * `getRecords` is this read plus a page, and the Export_Service is this read
 * without one. Requirements: 12.3, 12.4, 12.19, 12.20, 15.2, 15.3, 15.7
 */
export async function getAllRecords(
  actor: Actor,
  q: MetricQuery,
  context: AttendanceContext,
): Promise<RecordSet> {
  const evaluatedAt = context.evaluatedAt ?? new Date().toISOString();
  const scope = await resolveScope(actor);
  const policy = context.policy ?? (await loadAttendancePolicy(context.client));
  const range = resolveQueryRange(q, evaluatedAt, policy);

  const sources = await readAttendanceSources(
    { ...context, evaluatedAt, policy },
    scope,
    range,
    true,
  );

  const employees = sortEmployees(sources.employees);
  const subjects = toSubjectIndex(employees);
  const query = mergeRecordQuery(q, { ...scopeFilter(scope), ...range });

  return {
    rows: filterRecords(deriveRecords(sources), query, subjects),
    query,
    range,
    evaluatedAt: sources.evaluatedAt,
    employees,
    policy: sources.policy,
  };
}

/**
 * One page of Daily_Attendance_Records for a query.
 *
 * The whole match from `getAllRecords`, sliced. Rows are capped at 100 per
 * request (Requirements 12.17, 20.8) whatever the caller asks for.
 *
 * The paging on the returned query is the paging that was applied, not the
 * paging that was asked for, so a caller replaying the query gets the page it
 * was shown.
 *
 * Requirements: 12.3, 12.4, 12.17, 12.19, 12.20, 20.8
 */
export async function getRecords(
  actor: Actor,
  q: RecordQuery,
  context: AttendanceContext,
): Promise<RecordPage> {
  const limit = clampLimit(q.limit);
  const page = clampPage(q.page);

  // Paging is stripped before the read so the unpaged query it hands back stays
  // unpaged, and re-applied here as clamped. `mergeRecordQuery` keeps the base's
  // paging, so passing `q` whole would carry an uncapped `limit` onto the
  // returned query.
  const set = await getAllRecords(actor, withoutRecordPaging(q), context);

  const offset = (page - 1) * limit;
  const rows = set.rows.slice(offset, offset + limit);

  return {
    rows,
    page,
    limit,
    total: set.rows.length,
    hasMore: offset + rows.length < set.rows.length,
    query: { ...set.query, page, limit },
    evaluatedAt: set.evaluatedAt,
    employees: set.employees,
  };
}

/**
 * The query's filters without its paging.
 *
 * Exported because the Export_Service takes a `RecordQuery` from the requesting
 * view and reads it whole: paging is what an export removes, and removing it in
 * one place keeps the two callers from disagreeing about which fields count as
 * paging.
 */
export function withoutRecordPaging(query: RecordQuery): MetricQuery {
  const filters: RecordQuery = { ...query };
  delete filters.page;
  delete filters.limit;
  return filters;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return RECORDS_PAGE_LIMIT;
  const whole = Math.floor(limit);
  if (whole < 1) return 1;
  return whole > RECORDS_PAGE_LIMIT ? RECORDS_PAGE_LIMIT : whole;
}

function clampPage(page: number | undefined): number {
  if (page === undefined || !Number.isFinite(page)) return 1;
  const whole = Math.floor(page);
  return whole < 1 ? 1 : whole;
}

// ─── getMetrics ──────────────────────────────────────────────────────────────

/**
 * The fourteen Overview metrics for a query, in one request.
 *
 * Aggregation is the domain's `aggregateMetrics`, so each metric is computed
 * over exactly the query its drill-down carries and a figure cannot disagree
 * with the rows behind it (Requirement 13, criteria 3 through 5).
 *
 * Requirements: 13.3, 13.4, 13.5, 13.7
 */
export async function getMetrics(
  actor: Actor,
  q: MetricQuery,
  context: AttendanceContext,
): Promise<MetricsResponse> {
  const evaluatedAt = context.evaluatedAt ?? new Date().toISOString();
  const scope = await resolveScope(actor);
  const policy = context.policy ?? (await loadAttendancePolicy(context.client));
  const range = resolveQueryRange(q, evaluatedAt, policy);

  const sources = await readAttendanceSources(
    { ...context, evaluatedAt, policy },
    scope,
    range,
    true,
  );

  const employees = sortEmployees(sources.employees);
  const subjects = toSubjectIndex(employees);
  const query = mergeRecordQuery(q, { ...scopeFilter(scope), ...range });

  return {
    ...aggregateMetrics(deriveRecords(sources), query, subjects),
    evaluatedAt: sources.evaluatedAt,
    employees,
  };
}

// ─── getTrends ───────────────────────────────────────────────────────────────

/** The eight trend values that are an Overview metric under a trend-facing name. */
const TREND_METRIC_KEYS: ReadonlyArray<{ key: TrendKey; metric: MetricKey; label: string }> = [
  { key: 'scheduled_hours', metric: 'scheduled_hours', label: 'Scheduled hours' },
  { key: 'worked_hours', metric: 'worked_hours', label: 'Worked hours' },
  { key: 'attendance_rate', metric: 'attendance_rate', label: 'Attendance rate' },
  { key: 'late_occurrence_count', metric: 'late_arrival_count', label: 'Late occurrences' },
  { key: 'total_late_minutes', metric: 'total_late_minutes', label: 'Total late minutes' },
  { key: 'absence_count', metric: 'absence_count', label: 'Absences' },
  { key: 'time_off_days_used', metric: 'time_off_days', label: 'Time-off days used' },
  { key: 'overtime_hours', metric: 'overtime_hours', label: 'Overtime hours' },
];

/**
 * One employee's attendance history over one range, in one request.
 *
 * The twelve values of Requirement 14, criterion 2 and the scheduled-versus-
 * worked comparison of criterion 3, each carrying the query that produced it so
 * every displayed value has a drill-down (criterion 4).
 *
 * Eight of the twelve are read straight off `aggregateMetrics`, so a trend
 * figure and the Overview figure for the same employee and range are the same
 * number. The other four are a count of rows a saved filter matches, a sum of
 * the break minutes the domain already computed per record, and the number of
 * manager notes. None of them re-derives a rule (Requirements 3.14, 3.15).
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.6
 */
export async function getTrends(
  actor: Actor,
  profileId: string,
  range: DateRange,
  context: AttendanceContext,
): Promise<TrendResponse> {
  const evaluatedAt = context.evaluatedAt ?? new Date().toISOString();
  const scope = await resolveScope(actor);
  assertVisible(scope, profileId);

  const resolved = resolveRange(range.from, range.to);
  const policy = context.policy ?? (await loadAttendancePolicy(context.client));

  // Narrowed to the one employee even for an administrator: the trend view is
  // about one person, and reading the whole roster to describe one of them would
  // pay for rows nothing displays.
  const sources = await readAttendanceSources(
    { ...context, evaluatedAt, policy },
    [profileId],
    resolved,
    true,
  );

  const employees = sortEmployees(sources.employees);
  const subjects = toSubjectIndex(employees);
  const employee = employees.find((row) => row.profileId === profileId) ?? null;

  const base: RecordQuery = { ...resolved, profileIds: [profileId] };
  const records = filterRecords(deriveRecords(sources), base, subjects);

  const notes = sources.notes
    .filter((row) => row.profile_id === profileId)
    .map(toAttendanceNote)
    .filter((note): note is AttendanceNote => note !== null);

  return {
    profileId,
    employee,
    range: resolved,
    evaluatedAt: sources.evaluatedAt,
    values: buildTrendValues(records, base, subjects, notes.length),
    byDate: records.map((record) => ({
      workDate: record.workDate,
      scheduledHours: record.scheduledHours,
      workedHours: record.workedHours,
      derivedStatus: record.derivedStatus,
      payrollBlocking: record.payrollBlocking,
      query: { ...base, from: record.workDate, to: record.workDate },
    })),
    notes,
    records,
  };
}

function toAttendanceNote(row: NoteRow): AttendanceNote | null {
  const workDate = readWorkDate(row.work_date);
  if (workDate === null || typeof row.note !== 'string') return null;
  return {
    id: row.id,
    profileId: row.profile_id,
    workDate,
    note: row.note,
    authorProfileId: readText(row.author_profile_id, ''),
    createdAt: readText(row.created_at, ''),
  };
}

/**
 * The twelve trend values.
 *
 * Every value is computed over a query, and that same query is returned on the
 * value, so the drill-down opens exactly the rows the figure was taken from.
 */
function buildTrendValues(
  records: readonly DailyAttendanceRecord[],
  base: RecordQuery,
  subjects: RecordSubjectIndex,
  noteCount: number,
): TrendValue[] {
  const metrics = aggregateMetrics(records, base, subjects);
  const byMetricKey = new Map(metrics.metrics.map((metric) => [metric.key, metric]));

  const values: TrendValue[] = TREND_METRIC_KEYS.map(({ key, metric, label }) => {
    const computed = byMetricKey.get(metric);
    if (computed === undefined) {
      throw new AttendanceServiceError(
        'read_failed',
        `attendance: metric "${metric}" is missing from the aggregate`,
        { metric },
      );
    }
    return {
      key,
      label,
      unit: computed.unit,
      value: computed.value,
      recordCount: computed.recordCount,
      query: computed.query,
    };
  });

  // Break minutes: the paid and unpaid figures the domain already computed per
  // record, summed. Rounded once at the boundary, through the domain's rounding.
  values.push({
    key: 'break_minutes',
    label: 'Break minutes',
    unit: 'minutes',
    value: roundToTwoDecimals(
      records.reduce(
        (total, record) => total + record.paidBreakMinutes + record.unpaidBreakMinutes,
        0,
      ),
    ),
    recordCount: records.length,
    query: base,
  });

  values.push(
    countValue(records, base, subjects, {
      key: 'missing_punch_count',
      label: 'Missing punches',
      savedFilter: 'missing_punches',
    }),
  );

  values.push(
    countValue(records, base, subjects, {
      key: 'correction_count',
      label: 'Corrections',
      savedFilter: 'corrected',
    }),
  );

  values.push({
    key: 'manager_note_count',
    label: 'Manager notes',
    unit: 'count',
    value: noteCount,
    recordCount: records.length,
    query: base,
  });

  return values;
}

function countValue(
  records: readonly DailyAttendanceRecord[],
  base: RecordQuery,
  subjects: RecordSubjectIndex,
  spec: { key: TrendKey; label: string; savedFilter: NonNullable<RecordQuery['savedFilter']> },
): TrendValue {
  const query = mergeRecordQuery(base, { savedFilter: spec.savedFilter });
  const rows = filterRecords(records, query, subjects);
  return {
    key: spec.key,
    label: spec.label,
    unit: 'count',
    value: rows.length,
    recordCount: rows.length,
    query,
  };
}

// ─── getAuditEntries ─────────────────────────────────────────────────────────

/** The columns one audit entry carries. Every recorded field, nothing derived. */
const AUDIT_COLUMNS =
  'id, profile_id, work_date, entity_type, entity_id, action, field, old_value, new_value, actor_profile_id, reason, payroll_period_id, created_at';

/**
 * PostgREST's code for a page that starts past the end of the match.
 *
 * A page beyond the last one is not a failure — it is a page with no entries on
 * it — so it is answered as an empty page while the count query still reports the
 * true total. Absorbing it here rather than in `rowsOf` keeps that tolerance to
 * the one read whose offset a caller can move.
 */
const RANGE_NOT_SATISFIABLE = 'PGRST103';

function clampAuditLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return AUDIT_PAGE_LIMIT;
  const whole = Math.floor(limit);
  if (whole < 1) return 1;
  return whole > AUDIT_PAGE_LIMIT ? AUDIT_PAGE_LIMIT : whole;
}

/** The rows of an audit page read, with an over-run page read as empty. */
function auditRowsOf(result: {
  data: unknown;
  error: { message: string; code?: string } | null;
}): AuditLogRow[] {
  if (result.error) {
    if (result.error.code === RANGE_NOT_SATISFIABLE) return [];
    throw new AttendanceServiceError(
      'read_failed',
      `attendance: reading attendance_audit_log failed: ${result.error.message}`,
      {
        table: 'attendance_audit_log',
        ...(result.error.code === undefined ? {} : { pgCode: result.error.code }),
      },
    );
  }
  return (result.data as AuditLogRow[] | null) ?? [];
}

/** One audit row as an entry, or null when it carries no readable action. */
function toAuditEntry(row: AuditLogRow): AuditEntry | null {
  const action = readText(row.action, '');
  if (action === '') return null;

  return {
    id: row.id,
    profileId: row.profile_id ?? null,
    workDate: readWorkDate(row.work_date),
    entityType: readText(row.entity_type, 'unknown'),
    entityId: row.entity_id ?? null,
    action,
    field: row.field ?? null,
    previousValue: row.old_value ?? null,
    newValue: row.new_value ?? null,
    actorProfileId: readText(row.actor_profile_id, ''),
    reason: row.reason ?? null,
    payrollPeriodId: row.payroll_period_id ?? null,
    createdAt: readText(row.created_at, ''),
  };
}

function toAuditPeriod(row: AuditPeriodRow): AuditPayrollPeriod | null {
  const from = readWorkDate(row.period_start);
  const to = readWorkDate(row.period_end);
  if (from === null || to === null) return null;

  return {
    id: row.id,
    from,
    to,
    status: KNOWN_PAYROLL_PERIOD_STATUSES.includes(row.status as PayrollPeriodStatus)
      ? (row.status as PayrollPeriodStatus)
      : null,
  };
}

/**
 * One page of the attendance audit trail, newest first.
 *
 * Four queries, whatever the filters and whatever the page: the roster, the
 * total, the page, and the payroll periods the page's entries name. None of them
 * is per employee and none is per date (Requirements 20.1, 20.2).
 *
 * ## Why this read refuses rather than narrows
 *
 * Every other read in this module resolves a scope and answers within it, because
 * an employee reading their own attendance is a legitimate question. The audit
 * trail is not: `v1.9.0` grants `select` on `attendance_audit_log` to
 * `super_admin` alone, so a non-administrator's read would come back with no rows
 * — and an empty audit trail reads as "nothing was ever recorded against you"
 * rather than as "you may not ask". Requirement 16's user story is an
 * Attendance_Administrator's, so the call is refused and says so.
 *
 * The scope seam is still consulted and still applied to the query. It is
 * `'all'` for every caller who gets past the refusal today; keeping it means that
 * if `visibleProfileIds` ever narrows an administrator to a team, this read
 * narrows with it rather than becoming the one place the roster leaks.
 *
 * ## Paging is the database's, not the derivation's
 *
 * Unlike the record reads, which derive a whole range and slice it, this one
 * orders and pages in Postgres: an audit entry is a stored row rather than a
 * computed one, `idx_attendance_audit_created` serves exactly this ordering, and
 * reading a year of the trail into memory to show a hundred rows would be the
 * per-request cost Requirement 20 exists to avoid.
 *
 * Ordering is `created_at desc` with the identifier as a tie-break, so two entries
 * written in the same statement — a correction and its replay marker — keep a
 * stable order across pages instead of swapping between reads.
 *
 * Requirements: 16.3, 16.4, 16.7, 20.1, 20.2, 21.1, 21.2
 */
export async function getAuditEntries(
  actor: Actor,
  q: AuditQuery,
  context: AttendanceContext,
): Promise<AuditPage> {
  if (!canAdministerAttendance(actor.role)) {
    throw new AttendanceServiceError(
      'not_authorised',
      'attendance: the audit trail is available to attendance administrators',
    );
  }

  const limit = clampAuditLimit(q.limit);
  const page = clampPage(q.page);
  const offset = (page - 1) * limit;

  const from = q.from === undefined ? undefined : assertCalendarDate(q.from, 'from');
  const to = q.to === undefined ? undefined : assertCalendarDate(q.to, 'to');
  if (from !== undefined && to !== undefined && from > to) {
    throw new AttendanceServiceError('invalid_range', 'attendance: from must not follow to', {
      from,
      to,
    });
  }

  const policy = context.policy ?? (await loadAttendancePolicy(context.client));
  const scope = await resolveScope(actor);

  // The filters are applied to both reads by the same sequence of statements
  // rather than by a shared helper: the ordering and paging calls the second read
  // needs return a builder that no longer accepts a filter, so a helper would
  // have to be applied before them and would end up being two functions anyway.
  // Written out, the count and the page are visibly filtered identically.
  let counting = context.client
    .from('attendance_audit_log')
    .select('id', { count: 'exact', head: true });
  if (from !== undefined) counting = counting.gte('work_date', from);
  if (to !== undefined) counting = counting.lte('work_date', to);
  if (q.profileIds !== undefined) counting = counting.in('profile_id', [...q.profileIds]);
  if (q.actions !== undefined) counting = counting.in('action', [...q.actions]);
  if (q.actorProfileIds !== undefined) {
    counting = counting.in('actor_profile_id', [...q.actorProfileIds]);
  }
  if (scope !== 'all') counting = counting.in('profile_id', scope);

  let selecting = context.client.from('attendance_audit_log').select(AUDIT_COLUMNS);
  if (from !== undefined) selecting = selecting.gte('work_date', from);
  if (to !== undefined) selecting = selecting.lte('work_date', to);
  if (q.profileIds !== undefined) selecting = selecting.in('profile_id', [...q.profileIds]);
  if (q.actions !== undefined) selecting = selecting.in('action', [...q.actions]);
  if (q.actorProfileIds !== undefined) {
    selecting = selecting.in('actor_profile_id', [...q.actorProfileIds]);
  }
  if (scope !== 'all') selecting = selecting.in('profile_id', scope);

  const [profiles, counted, paged] = await Promise.all([
    readProfiles(context.client, scope),
    counting,
    selecting
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1),
  ]);

  if (counted.error) {
    throw new AttendanceServiceError(
      'read_failed',
      `attendance: counting attendance_audit_log failed: ${counted.error.message}`,
      { table: 'attendance_audit_log' },
    );
  }

  const rows = auditRowsOf(paged)
    .map(toAuditEntry)
    .filter((entry): entry is AuditEntry => entry !== null);

  // Issued even when no entry names a period, so the outbound query count does
  // not depend on what the page happened to contain.
  const periodIds = [
    ...new Set(
      rows
        .map((entry) => entry.payrollPeriodId)
        .filter((id): id is string => id !== null && id !== ''),
    ),
  ];
  const periods = rowsOf<AuditPeriodRow>(
    'payroll_periods',
    await context.client
      .from('payroll_periods')
      .select('id, period_start, period_end, status')
      .in('id', periodIds),
  );

  const total = counted.count ?? rows.length;

  // The query as applied: the caller's filters, the resolved scope, and the
  // paging that was actually used rather than the paging that was asked for.
  const applied: AuditQuery = { page, limit };
  if (from !== undefined) applied.from = from;
  if (to !== undefined) applied.to = to;
  if (q.actions !== undefined) applied.actions = q.actions;
  if (q.actorProfileIds !== undefined) applied.actorProfileIds = q.actorProfileIds;

  if (scope === 'all') {
    if (q.profileIds !== undefined) applied.profileIds = q.profileIds;
  } else if (q.profileIds === undefined) {
    applied.profileIds = scope;
  } else {
    applied.profileIds = q.profileIds.filter((profileId) => scope.includes(profileId));
  }

  return {
    rows,
    page,
    limit,
    total,
    hasMore: offset + rows.length < total,
    query: applied,
    employees: sortEmployees(
      profiles.map((profile) => toAttendanceEmployee(profile, policy)),
    ),
    payrollPeriods: periods
      .map(toAuditPeriod)
      .filter((period): period is AuditPayrollPeriod => period !== null),
  };
}

// ─── applyCorrection ─────────────────────────────────────────────────────────

/** The `attendance_audit_log.entity_type` a correction targets. */
export type CorrectionEntityType = 'clock_entry' | 'break' | 'note';

/**
 * The fields `attendance_apply_correction` accepts.
 *
 * The four controls Requirement 12, criterion 12 names — clock-in instant,
 * clock-out instant, break minutes, manager note — plus the paths the employee
 * drawer's five actions need (Requirement 5, criterion 15): a whole added
 * session, the two bounds and the stored duration of a break, and the approval of
 * unscheduled work.
 *
 * Break minutes appears twice on purpose, and the two mean different things.
 * `break_minutes` is the accumulated column on `time_clock_entries` that the
 * inherited payroll path reads as break hours, so correcting it moves the
 * payroll-visible figure. `duration_minutes` is the figure on the break row that
 * the redesigned derivation prefers over the break's own bounds, so correcting it
 * moves worked hours and therefore the status. A correction changes exactly the
 * field it names and never quietly re-derives the other, because the audit entry
 * names one field and one previous value.
 */
export type CorrectionField =
  | 'clock_in'
  | 'clock_out'
  | 'break_minutes'
  | 'session'
  | 'break_start'
  | 'break_end'
  | 'duration_minutes'
  | 'note'
  | 'unscheduled_work';

/**
 * The accepted fields, in the order the migration documents them.
 *
 * Exported so the correction route offers exactly this set rather than a second
 * list that could drift from it.
 */
export const CORRECTION_FIELDS = [
  'clock_in',
  'clock_out',
  'break_minutes',
  'session',
  'break_start',
  'break_end',
  'duration_minutes',
  'note',
  'unscheduled_work',
] as const satisfies readonly CorrectionField[];

/**
 * The `attendance_audit_log.action` a correction records.
 *
 * Not derivable from the field alone: giving a clock-out to an entry that had
 * none is Add Missing Punch rather than Correct Punch, and the function decides
 * that from the row as locked (Requirement 5, criterion 15). Read back off the
 * envelope so a drawer can label what happened rather than what was asked for.
 */
export type CorrectionAction =
  | 'correct_punch'
  | 'add_punch'
  | 'add_note'
  | 'approve_unscheduled';

const KNOWN_CORRECTION_ACTIONS = [
  'correct_punch',
  'add_punch',
  'add_note',
  'approve_unscheduled',
] as const satisfies readonly CorrectionAction[];

const KNOWN_PAYROLL_PERIOD_STATUSES = [
  'open',
  'locked',
  'processed',
  'paid',
] as const satisfies readonly PayrollPeriodStatus[];

/**
 * The period statuses that mean a stored `payroll_summaries` row already carries
 * this work date.
 *
 * A correction inside one of them is permitted and recomputes no summary, which
 * is Correctness Property 39. The flag exists so a screen can say so.
 */
const SETTLED_PAYROLL_PERIOD_STATUSES: readonly PayrollPeriodStatus[] = ['processed', 'paid'];

/**
 * The `CODE: message` prefixes the two mutation functions raise, and the failure
 * each one is.
 *
 * Both functions raise with SQLSTATEs that already carry the right HTTP meaning,
 * but the driver hands back a message rather than a status, so the prefix is what
 * the mapping reads. An unlisted prefix falls through to `write_failed`, which is
 * the honest answer for a refusal the service cannot name.
 *
 * `ALREADY_OPEN_ENTRY` is the one conflict: adding an open session while the
 * employee already has one is refused by `uniq_time_clock_open_entry`, and
 * `already_clocked_in` is the code the module's failure contract already names
 * for exactly that race.
 */
const MUTATION_FAILURE_CODES: Readonly<Record<string, AttendanceServiceErrorCode>> = {
  NOT_AUTHENTICATED: 'not_authorised',
  NOT_AUTHORISED: 'not_authorised',
  SUBJECT_REQUIRED: 'invalid_parameter',
  PROFILE_NOT_FOUND: 'not_visible',
  PROFILE_MISMATCH: 'invalid_parameter',
  IDEMPOTENCY_KEY_REQUIRED: 'invalid_parameter',
  UNKNOWN_FIELD: 'invalid_parameter',
  ENTITY_TYPE_MISMATCH: 'invalid_parameter',
  ENTITY_ID_REQUIRED: 'invalid_parameter',
  UNEXPECTED_ENTITY_ID: 'invalid_parameter',
  REASON_REQUIRED: 'reason_required',
  NOTE_REQUIRED: 'reason_required',
  CLOCK_ENTRY_NOT_FOUND: 'not_visible',
  BREAK_NOT_FOUND: 'not_visible',
  INVALID_VALUE: 'invalid_parameter',
  NEGATIVE_DURATION: 'invalid_parameter',
  BREAK_OUTSIDE_SESSION: 'invalid_parameter',
  ALREADY_OPEN_ENTRY: 'already_clocked_in',
};

/**
 * The codes an apply-phase failure returns rather than raises.
 *
 * `v1.9.4` distinguishes the two deliberately: a guard rejection raises, and a
 * write that failed inside the apply block returns, because the second is the
 * outcome Requirement 16, criterion 6 describes and the caller has to be able to
 * tell which statement gave way without parsing prose.
 */
const APPLY_FAILURE_CODES: Readonly<Record<string, AttendanceServiceErrorCode>> = {
  audit_write_failed: 'audit_write_failed',
  change_write_failed: 'write_failed',
};

/** What every correction names, whichever field it changes. */
interface CorrectionSubject {
  /** The employee the correction is recorded against. */
  profileId: string;
  /** The work date it is recorded against, `YYYY-MM-DD`. */
  workDate: string;
  /**
   * The reason stored on the change and on the audit entry.
   *
   * Required for every field except `note`, whose text is its own stated reason
   * (Requirements 5.16, 12.13, 21.9).
   */
  reason?: string | null;
  /**
   * What makes a resubmitted correction apply once. Non-blank.
   *
   * A key already recorded against this employee and work date means the change
   * was applied by an earlier call, so nothing moves a second time and the prior
   * result comes back with `applied: false` — and a second audit entry is still
   * written, pointing at the first, because two submitted corrections that showed
   * one audit entry would understate what happened.
   */
  idempotencyKey: string;
  /**
   * The caller's assertion about what it believes it is correcting, or null.
   *
   * Passed through rather than derived from the field. The function validates the
   * assertion against the field it resolves itself, so a drawer that names a
   * break while sending a clock-entry field is refused; deriving the value here
   * would make that check unable to fire.
   */
  entityType?: CorrectionEntityType | null;
}

/** Correcting one instant on a clock entry or a break row. */
export interface PunchCorrectionInput extends CorrectionSubject {
  field: 'clock_in' | 'clock_out' | 'break_start' | 'break_end';
  /** The `time_clock_entries` or `time_clock_breaks` row to change. */
  entityId: string;
  /** The corrected instant, ISO. */
  value: string;
}

/** Correcting a stored minute count on a clock entry or a break row. */
export interface MinutesCorrectionInput extends CorrectionSubject {
  field: 'break_minutes' | 'duration_minutes';
  entityId: string;
  /** Whole minutes, 0 to 1440. */
  value: number;
}

/** Adding a whole clock session the employee never recorded. */
export interface SessionCorrectionInput extends CorrectionSubject {
  field: 'session';
  value: {
    /** ISO instant. */
    clockIn: string;
    /** ISO instant, or null for a session that is still open. */
    clockOut?: string | null;
    breakMinutes?: number | null;
  };
}

/** Adding one manager note against the employee and work date. */
export interface NoteCorrectionInput extends CorrectionSubject {
  field: 'note';
  /** The note text. At least one non-whitespace character. */
  value: string;
}

/**
 * Approving the unscheduled work recorded on the date.
 *
 * There is no row to write: the approval *is* the audit entry, which the read
 * paths pick up as `unscheduledWorkApproved` and which is what clears the
 * payroll-blocking exception of Requirement 12, criterion 8. There is no
 * un-approve path.
 */
export interface UnscheduledWorkApprovalInput extends CorrectionSubject {
  field: 'unscheduled_work';
  /** The clock entry the approval refers to, when the caller names one. */
  entityId?: string | null;
  value?: true;
}

/** One correction, as the drawers submit it. */
export type CorrectionInput =
  | PunchCorrectionInput
  | MinutesCorrectionInput
  | SessionCorrectionInput
  | NoteCorrectionInput
  | UnscheduledWorkApprovalInput;

/** What one committed correction produced. */
export interface CorrectionResult {
  /**
   * False for a replayed idempotency key: the change was already applied and
   * nothing moved a second time.
   */
  applied: boolean;
  /** `already_applied` for a replay, null for a correction that moved something. */
  code: 'already_applied' | null;
  profileId: string;
  workDate: string;
  field: CorrectionField;
  entityType: CorrectionEntityType | null;
  /** The row the correction changed, or the row it created. */
  entityId: string | null;
  action: CorrectionAction | null;
  /** The value the field held, as the function read it under the lock. */
  previousValue: unknown;
  newValue: unknown;
  reason: string | null;
  actorProfileId: string | null;
  /** When the audit entry was written. */
  appliedAt: string | null;
  /**
   * The payroll period covering the work date, resolved by the function
   * (Requirement 16, criterion 2). Null when no period covers it.
   */
  payrollPeriodId: string | null;
  payrollPeriodStatus: PayrollPeriodStatus | null;
  /**
   * True when that period is `processed` or `paid`.
   *
   * The correction was still applied and no stored `payroll_summaries` row was
   * recomputed. A screen showing this can tell the administrator that a later
   * period has to carry the adjustment deliberately.
   */
  insideSettledPayrollPeriod: boolean;
  /** The audit entry the change was recorded in. */
  auditId: string | null;
  /** The audit entry a replay recorded, which points at `auditId`. */
  replayAuditId: string | null;
  /**
   * The affected `DailyAttendanceRecord`, recomputed from source rows after the
   * transaction committed (Requirements 3.16, 5.18, 12.14).
   *
   * Null when the employee and work date carry no record at all, which a manager
   * note alone does not create: a note on a date with no schedule, no session, no
   * approved absence, and no review has nothing to report a status about.
   */
  record: DailyAttendanceRecord | null;
}

/** What marking one employee-date reviewed produced. */
export interface ReviewResult {
  /** False when the date was already reviewed (Requirement 12, criterion 16). */
  applied: boolean;
  code: 'already_reviewed' | null;
  profileId: string;
  workDate: string;
  /**
   * The reviewer the date now carries.
   *
   * The first reviewer, always: `insert ... on conflict do nothing` writes
   * nothing the second time, so there is nothing to overwrite.
   */
  reviewedBy: string | null;
  reviewedAt: string | null;
  /**
   * The payroll period covering the work date, for the audit entry. Null on a
   * repeat, which writes no audit entry because nothing changed.
   */
  payrollPeriodId: string | null;
  payrollPeriodStatus: PayrollPeriodStatus | null;
  auditId: string | null;
  /** The affected record, recomputed after the transaction committed. */
  record: DailyAttendanceRecord | null;
}

/** The envelope the two functions return, as far as this module reads it. */
interface MutationEnvelope {
  ok?: unknown;
  applied?: unknown;
  code?: unknown;
  error?: unknown;
  profile_id?: unknown;
  work_date?: unknown;
  entity_type?: unknown;
  entity_id?: unknown;
  action?: unknown;
  old_value?: unknown;
  new_value?: unknown;
  reason?: unknown;
  actor_profile_id?: unknown;
  applied_at?: unknown;
  payroll_period_id?: unknown;
  payroll_period_status?: unknown;
  audit_id?: unknown;
  replay_audit_id?: unknown;
  reviewed_by?: unknown;
  reviewed_at?: unknown;
}

function readTextOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readCorrectionEntityType(value: unknown): CorrectionEntityType | null {
  return value === 'clock_entry' || value === 'break' || value === 'note' ? value : null;
}

function readCorrectionAction(value: unknown): CorrectionAction | null {
  return KNOWN_CORRECTION_ACTIONS.includes(value as CorrectionAction)
    ? (value as CorrectionAction)
    : null;
}

function readPayrollPeriodStatus(value: unknown): PayrollPeriodStatus | null {
  return KNOWN_PAYROLL_PERIOD_STATUSES.includes(value as PayrollPeriodStatus)
    ? (value as PayrollPeriodStatus)
    : null;
}

function invalidParameter(field: string, message: string): AttendanceServiceError {
  return new AttendanceServiceError('invalid_parameter', `attendance: ${message}`, { field });
}

/**
 * The caller administers attendance, or nothing happens.
 *
 * Before any read and any write, so a call outside the permitted set touches no
 * data (Requirement 21, criterion 15). Both functions assert the same rule again
 * as their owner, which is what makes the boundary hold for a caller that reaches
 * the database another way (Requirement 21, criterion 10).
 *
 * Requirements: 21.4, 21.12, 21.15
 */
function assertAdministersAttendance(actor: Actor, action: string): void {
  if (!canAdministerAttendance(actor.role)) {
    throw new AttendanceServiceError(
      'not_authorised',
      `attendance: only an attendance administrator may ${action}`,
      { role: actor.role },
    );
  }
}

/** The failure a raised mutation function describes, by its `CODE:` prefix. */
function mutationFailure(
  message: string,
  detail: Record<string, string>,
): AttendanceServiceError {
  const prefix = message.slice(0, Math.max(0, message.indexOf(':')));
  const code = MUTATION_FAILURE_CODES[prefix] ?? 'write_failed';
  return new AttendanceServiceError(code, `attendance: ${message}`, detail);
}

/**
 * The failure an envelope with `ok: false` describes.
 *
 * Reached only from the apply block, so the change is already rolled back and the
 * source row is exactly as it was. `audit_write_failed` is Requirement 16,
 * criterion 6 by name; `change_write_failed` is the same guarantee one statement
 * earlier.
 */
function applyFailure(
  envelope: MutationEnvelope,
  detail: Record<string, string>,
): AttendanceServiceError {
  const returned = typeof envelope.code === 'string' ? envelope.code : 'unknown';
  const code = APPLY_FAILURE_CODES[returned] ?? 'write_failed';
  return new AttendanceServiceError(
    code,
    readTextOrNull(envelope.error) ??
      'attendance: that change could not be recorded. Nothing was changed.',
    { ...detail, code: returned },
  );
}

/** The row a correction changes, or null for the fields that create one. */
function correctionEntityId(input: CorrectionInput): string | null {
  switch (input.field) {
    // `session` and `note` insert a row, so they name none: the function refuses
    // an entity id for both rather than ignoring it.
    case 'session':
    case 'note':
      return null;
    case 'unscheduled_work':
      return input.entityId ?? null;
    default:
      return input.entityId;
  }
}

/**
 * The value a correction carries, in the shape `p_new_value` expects.
 *
 * Snake_case only where the function reads a nested key. Every instant and every
 * integer inside it is cast by the function, once, before it takes a lock.
 */
function correctionValue(input: CorrectionInput): unknown {
  switch (input.field) {
    case 'session':
      return {
        clock_in: input.value.clockIn,
        clock_out: input.value.clockOut ?? null,
        break_minutes: input.value.breakMinutes ?? 0,
      };
    // `unscheduled_work` accepts `true` and nothing else: the approval clears the
    // payroll-blocking exception, and there is no un-approve path to send false to.
    case 'unscheduled_work':
      return true;
    default:
      return input.value;
  }
}

/**
 * Step four of a write path: the affected record, read back through the same path
 * every screen uses.
 *
 * Nine queries — the policy singleton and the eight range reads — narrowed to the
 * one employee and the one date. The review reads are included because the
 * response has to carry the review stamp and the payroll-blocking flag the
 * correction may have just changed: approving unscheduled work is recorded in
 * `attendance_audit_log` and nowhere else, so a recompute that skipped that read
 * would report the approval as not having happened.
 *
 * A read failure here propagates. The correction is committed and audited by that
 * point, and answering as though it were not would be worse than reporting a
 * failed read: the idempotency key makes a resubmission apply nothing, so the
 * caller can retry safely.
 *
 * Requirements: 3.16, 5.18, 12.14
 */
async function recomputeRecord(
  profileId: string,
  workDate: string,
  context: AttendanceContext,
  evaluatedAt: string,
): Promise<DailyAttendanceRecord | null> {
  const sources = await readAttendanceSources(
    { ...context, evaluatedAt },
    [profileId],
    { from: workDate, to: workDate },
    true,
  );

  return deriveRecords(sources).find((record) => record.profileId === profileId) ?? null;
}

/**
 * Commit one attendance correction.
 *
 * Four steps, and each is there because skipping it is a way to get a correction
 * wrong:
 *
 *  1. **Authorise.** Before anything is read or written. Correction is reserved to
 *     an Attendance_Administrator (Requirements 21.4, 21.12), and
 *     `attendance_apply_correction` asserts the same rule again as its owner.
 *  2. **Check what the call needs to build its payload.** The field, so the value
 *     can be shaped; the reason, because Requirements 5.16, 12.13, and 21.9
 *     require one for every correction other than a note; the idempotency key,
 *     because it is what makes a resubmission apply once. Not the value: the
 *     function casts every instant and integer itself, before any lock, and
 *     re-validating the nine shapes here would be a second implementation of the
 *     vocabulary.
 *  3. **One RPC call.** The function locks the row it changes, applies the change,
 *     and inserts the `attendance_audit_log` row as its last statement, so a
 *     failed audit write leaves nothing committed and returns the reason
 *     (Requirement 16, criterion 6). It resolves the previous value under the lock
 *     and the covering payroll period itself, and both come back on the envelope.
 *  4. **Recompute**, after the transaction has committed, from the same source
 *     rows the function wrote (Requirements 3.16, 5.18, 12.14).
 *
 * A correction inside a `processed` or `paid` period is permitted and recomputes
 * no stored payroll summary. The audit entry carries `payroll_period_id`, and the
 * result reports the period and `insideSettledPayrollPeriod` so a screen can say
 * that a later period has to carry the adjustment (Correctness Property 39).
 *
 * @throws AttendanceServiceError `not_authorised` for a caller who does not
 *   administer attendance, `invalid_parameter` or `reason_required` for a payload
 *   the function or this module refuses, `not_visible` for a target row that does
 *   not exist, `already_clocked_in` for an added open session when one is already
 *   open, `write_failed` or `audit_write_failed` for a write that gave way, and
 *   `read_failed` when the recompute could not be read.
 *
 * Requirements: 3.16, 5.15, 5.16, 5.17, 5.18, 12.12, 12.13, 12.14, 16.1, 16.2,
 * 16.6, 21.4, 21.9, 21.15
 */
export async function applyCorrection(
  actor: Actor,
  input: CorrectionInput,
  context: AttendanceContext,
): Promise<CorrectionResult> {
  const evaluatedAt = context.evaluatedAt ?? new Date().toISOString();

  // 1. Authorise before touching data.
  assertAdministersAttendance(actor, 'correct attendance');

  // 2. What the call needs in order to be built at all.
  if (!CORRECTION_FIELDS.includes(input.field)) {
    throw invalidParameter(
      'field',
      `"${String(input.field)}" is not a correctable field. Accepted fields are ` +
        `${CORRECTION_FIELDS.join(', ')}.`,
    );
  }

  const profileId = readTextOrNull(input.profileId);
  if (profileId === null) {
    throw invalidParameter('profileId', 'a correction names the employee it applies to');
  }

  const workDate = assertCalendarDate(input.workDate, 'workDate');

  const idempotencyKey = reasonWithContent(input.idempotencyKey);
  if (idempotencyKey === null) {
    throw invalidParameter(
      'idempotencyKey',
      'a correction carries a non-blank idempotency key, which is what makes a ' +
        'resubmitted correction apply once',
    );
  }

  const reason = reasonWithContent(input.reason);
  if (reason === null && input.field !== 'note') {
    throw new AttendanceServiceError(
      'reason_required',
      'attendance: a correction carries a reason of at least one non-whitespace character',
      { field: 'reason' },
    );
  }

  const detail = { profileId, workDate, field: input.field };

  // 3. One call. Everything below it is what the function committed.
  const rpc = await context.client.rpc('attendance_apply_correction', {
    p_entity_type: input.entityType ?? null,
    p_entity_id: correctionEntityId(input),
    p_profile_id: profileId,
    p_work_date: workDate,
    p_field: input.field,
    p_new_value: correctionValue(input),
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
  });

  if (rpc.error) throw mutationFailure(rpc.error.message, detail);

  const envelope = (rpc.data ?? {}) as MutationEnvelope;
  if (envelope.ok !== true) throw applyFailure(envelope, detail);

  const periodStatus = readPayrollPeriodStatus(envelope.payroll_period_status);

  // 4. The affected record, recomputed from the rows the function just wrote.
  const record = await recomputeRecord(profileId, workDate, context, evaluatedAt);

  return {
    applied: envelope.applied === true,
    code: envelope.code === 'already_applied' ? 'already_applied' : null,
    profileId: readText(envelope.profile_id, profileId),
    workDate: readWorkDate(envelope.work_date) ?? workDate,
    field: input.field,
    entityType: readCorrectionEntityType(envelope.entity_type),
    entityId: readTextOrNull(envelope.entity_id),
    action: readCorrectionAction(envelope.action),
    previousValue: envelope.old_value ?? null,
    newValue: envelope.new_value ?? null,
    reason: readTextOrNull(envelope.reason),
    actorProfileId: readTextOrNull(envelope.actor_profile_id),
    appliedAt: readTextOrNull(envelope.applied_at),
    payrollPeriodId: readTextOrNull(envelope.payroll_period_id),
    payrollPeriodStatus: periodStatus,
    insideSettledPayrollPeriod:
      periodStatus !== null && SETTLED_PAYROLL_PERIOD_STATUSES.includes(periodStatus),
    auditId: readTextOrNull(envelope.audit_id),
    replayAuditId: readTextOrNull(envelope.replay_audit_id),
    record,
  };
}

// ─── markReviewed ────────────────────────────────────────────────────────────

/**
 * Mark one employee and work date reviewed.
 *
 * The same four steps, with two differences that follow from what a review is.
 *
 * It carries no reason. Requirement 12, criterion 15 asks for the actor and the
 * timestamp, and marking a day reviewed overrides no derived value, so
 * Requirement 21, criterion 9 does not apply to it.
 *
 * A repeat is not a replay. `attendance_mark_reviewed` inserts with `on conflict
 * (profile_id, work_date) do nothing`, so the first reviewer and timestamp are
 * retained by the composite primary key rather than by a read-then-write
 * (Requirement 12, criterion 16 and Correctness Property 34). The repeat returns
 * `already_reviewed` with the retained reviewer and writes no audit entry:
 * Requirement 16, criterion 1 records review status *changes*, and a repeat
 * changes nothing. That is deliberately the opposite of a replayed correction,
 * which is a resubmitted change and is recorded as one.
 *
 * The record still comes back recomputed, because the review stamp is part of it
 * and the queue filters on review status.
 *
 * @throws AttendanceServiceError `not_authorised` for a caller who does not
 *   administer attendance, `invalid_parameter` for a missing employee,
 *   `invalid_range` for a work date that is not a calendar date, `not_visible`
 *   for an employee that does not exist, `audit_write_failed` when the audit
 *   entry could not be written — in which case the day is unreviewed again — and
 *   `read_failed` when the recompute could not be read.
 *
 * Requirements: 12.15, 12.16, 16.1, 16.2, 16.6, 21.15
 */
export async function markReviewed(
  actor: Actor,
  profileId: string,
  workDate: string,
  context: AttendanceContext,
): Promise<ReviewResult> {
  const evaluatedAt = context.evaluatedAt ?? new Date().toISOString();

  assertAdministersAttendance(actor, 'mark an attendance day reviewed');

  const subject = readTextOrNull(profileId);
  if (subject === null) {
    throw invalidParameter('profileId', 'marking a day reviewed names the employee');
  }

  const date = assertCalendarDate(workDate, 'workDate');

  const rpc = await context.client.rpc('attendance_mark_reviewed', {
    p_profile_id: subject,
    p_work_date: date,
  });

  if (rpc.error) throw mutationFailure(rpc.error.message, { profileId: subject, workDate: date });

  const envelope = (rpc.data ?? {}) as MutationEnvelope;
  if (envelope.ok !== true) {
    throw applyFailure(envelope, { profileId: subject, workDate: date });
  }

  const record = await recomputeRecord(subject, date, context, evaluatedAt);

  return {
    applied: envelope.applied === true,
    code: envelope.code === 'already_reviewed' ? 'already_reviewed' : null,
    profileId: readText(envelope.profile_id, subject),
    workDate: readWorkDate(envelope.work_date) ?? date,
    reviewedBy: readTextOrNull(envelope.reviewed_by),
    reviewedAt: readTextOrNull(envelope.reviewed_at),
    payrollPeriodId: readTextOrNull(envelope.payroll_period_id),
    payrollPeriodStatus: readPayrollPeriodStatus(envelope.payroll_period_status),
    auditId: readTextOrNull(envelope.audit_id),
    record,
  };
}

// ─── payrollInputs ───────────────────────────────────────────────────────────
//
// The per-employee figures a payroll period is calculated from, in one of two
// modes.
//
// ## Why there are two modes
//
// Requirement 2, criterion 4 says the Payroll_Service must produce the same
// regular hours, overtime hours, break hours, total hours, PTO days, gross pay,
// deductions total, and net pay after the redesign as before it, for the same
// period and the same data. Requirement 19, criterion 6 says payroll consumes
// worked hours, break minutes, and approved absence days from the
// Attendance_Service rather than deriving them itself. Those two pull in
// opposite directions, because the pre-redesign arithmetic is wrong in ways the
// attendance derivation deliberately fixes:
//
// | figure       | pre-redesign                                   | attendance derivation                     |
// | ------------ | ---------------------------------------------- | ----------------------------------------- |
// | worked hours | stored `total_hours`, closed entries only      | derived per work date, open sessions too  |
// | break hours  | `time_clock_entries.break_minutes` (lunch only)| unpaid break minutes per the policy       |
// | PTO days     | whole `total_days` of any overlapping request  | dates inside the period, one day each     |
// | work date    | the UTC date of the clock-in instant           | the shift the session was worked against  |
//
// `legacy_parity` is that first column, transcribed. It is what the parity
// harness measures and what `/api/payroll/calculate` consumes, so the redesign
// changes no cent of anybody's pay.
//
// `recomputed` is the second column: the same pay arithmetic applied to hours,
// break minutes, and absence days read off `DailyAttendanceRecord`. It is
// implemented and deliberately wired to nothing. Switching a route to it would
// move payroll output for unchanged input, which Requirement 2, criterion 6
// reserves for a separately approved payroll rule change.
//
// ## What the two modes share
//
// Both modes end in `payrollRowFor`, so the pay arithmetic — the period-average
// overtime cap, the eight-hour PTO day, the deduction pass, the two-decimal
// rounding at each stage — exists once. The mode chooses where the hours come
// from and nothing else. That is on purpose: the open question about the
// overtime rule (Appendix B, Open Question 5) is a question about the pay
// formula, and answering it accidentally by writing the formula twice is exactly
// the failure this split prevents.
//
// ## What is preserved bug-for-bug in `legacy_parity`
//
// - Entries with a null `clock_out` are silently excluded, so a missing
//   clock-out costs the employee the whole session. The redesign reports that as
//   a payroll-blocking exception in the Review center instead of hiding it, but
//   it does not change the figure.
// - The clock-entry window is the naive text `${from}T00:00:00` to
//   `${to}T23:59:59`, with no zone designator, so the boundary lands wherever
//   the database session timezone puts it.
// - `daysWorked` counts distinct UTC dates of the clock-in instant, not work
//   dates, so a late-evening shift in a western timezone counts on the next day.
// - PTO days count the whole `total_days` of every approved request overlapping
//   the period, so a ten-day request straddling the boundary is paid twice, once
//   in each period. `partially_approved` requests are not counted at all: the
//   status did not exist before `v1.9.3` and the legacy query names `approved`
//   alone.
// - Overtime is the period average `(period dates / 7) x weekly threshold`
//   rather than a weekly threshold, so a 60-hour week followed by a 20-hour week
//   produces no overtime in a fortnight.
// - `pay_type` is never read, so a salaried employee calculates to zero pay.
// - Employees whose rounded total hours and PTO days are both zero are dropped.
//
// Five departures from the transcription are deliberate. None changes a figure
// for a value the column it comes from is meant to hold:
//
//   1. The period is validated as a calendar range first. Legacy fed an
//      unparseable date straight into the arithmetic and answered `NaN`.
//   2. A `deductions` value that is not an array reads as no deductions instead
//      of throwing part-way through the response.
//   3. A deduction amount is coerced with `Number`. `deductions` is free-form
//      JSON that no editor validates, and legacy let a numeric string
//      concatenate rather than add.
//   4. A figure that comes out non-finite reports zero rather than `NaN`, which
//      is what the legacy value became anyway once it crossed the JSON boundary
//      into `/api/payroll/process`.
//   5. Rows come back ordered by display name. Legacy returned them in whatever
//      order Postgres chose, which was not stable between calls.
//
// ## Authorisation
//
// This function performs none. It takes no `Actor` and it does not resolve
// scope through `visibleProfileIds`, because payroll is calculated over the
// whole active roster and the figures are reserved to an Attendance_
// Administrator (Requirement 21, criterion 6). Every caller must gate on
// `canAdministerAttendance` before calling it, and must pass either the
// caller's own row-level-security-bound client — `/api/payroll/calculate` does
// — or a service client from a script that runs outside a request, as the parity
// harness does.
//
// ## Query counts
//
// | mode            | queries | tables                                                          |
// | --------------- | ------- | --------------------------------------------------------------- |
// | `legacy_parity` | 4       | profiles, employee_payment_settings, time_clock_entries, pto_requests |
// | `recomputed`    | 10      | employee_payment_settings plus the nine reads of a record range  |
//
// Neither count moves with the roster size or the period length
// (Requirements 20.1, 20.2).
//
// Requirements: 2.4 (identical payroll output), 19.6 (payroll consumes worked
// hours, break minutes, and absence days from the Attendance_Service).

/**
 * Where a payroll period's hours come from.
 *
 * `legacy_parity` transcribes the pre-redesign arithmetic. `recomputed` reads
 * the same figures off `DailyAttendanceRecord`. Only `legacy_parity` is wired to
 * a route.
 */
export type PayrollInputMode = 'legacy_parity' | 'recomputed';

/** One entry of the `employee_payment_settings.deductions` JSON array. */
export interface PayrollDeduction {
  label: string;
  amount: number;
  /** `'percentage'` takes a share of gross pay; anything else is a fixed amount. */
  type: string;
}

/** One employee's pay configuration, with the documented defaults applied. */
export interface PayrollPaySettings {
  hourlyRate: number;
  overtimeMultiplier: number;
  weeklyOvertimeThreshold: number;
  deductions: readonly PayrollDeduction[];
}

/** An `employee_payment_settings` row as it arrives. */
export interface PaySettingsRow {
  profile_id: string;
  hourly_rate?: unknown;
  overtime_multiplier?: unknown;
  weekly_overtime_threshold?: unknown;
  deductions?: unknown;
}

/** A `time_clock_entries` row as the legacy payroll read selects it. */
export interface PayrollEntryRow {
  id: string;
  profile_id: string;
  clock_in: string;
  total_hours?: unknown;
  break_minutes?: unknown;
}

/** A `pto_requests` row as the legacy payroll read selects it. */
export interface PayrollAbsenceRow {
  profile_id: string;
  total_days?: unknown;
}

/**
 * One employee's payroll figures for one period.
 *
 * Field for field the pre-redesign summary object, in the module's own casing.
 * `/api/payroll/calculate` maps these onto its snake_case response and the
 * parity harness compares them against the stored `payroll_summaries` row, so
 * neither caller re-derives anything.
 *
 * Hours and money carry two decimals. `ptoDaysUsed`, `ptoHoursPaid`,
 * `hourlyRate`, `daysWorked`, and `entriesCount` are reported as they were
 * computed, matching the legacy response.
 */
export interface PayrollInputRow {
  profileId: string;
  displayName: string;
  initials: string;
  role: AppRole;
  hourlyRate: number;
  regularHours: number;
  overtimeHours: number;
  breakHours: number;
  totalHours: number;
  ptoDaysUsed: number;
  ptoHoursPaid: number;
  regularPay: number;
  overtimePay: number;
  ptoPay: number;
  grossPay: number;
  deductionsTotal: number;
  netPay: number;
  daysWorked: number;
  entriesCount: number;
}

/**
 * The hours side of one employee's period, before any pay arithmetic.
 *
 * The only thing the two modes disagree about. Kept at full precision: rounding
 * belongs at the boundary, in `payrollRowFor`.
 */
interface PayrollHoursFacts {
  /** Hours paid as worked, unpaid break time already deducted. */
  workedHours: number;
  /** Break hours excluded from paid time. */
  breakHours: number;
  /** Absence days paid at the eight-hour PTO day. */
  ptoDays: number;
  /** Distinct dates the employee worked. */
  daysWorked: number;
  /** Clock sessions behind `workedHours`. */
  entriesCount: number;
}

/** Hours per profile, defaulting to a period with nothing recorded. */
type PayrollFactsIndex = Map<string, PayrollHoursFacts>;

function emptyPayrollFacts(): PayrollHoursFacts {
  return { workedHours: 0, breakHours: 0, ptoDays: 0, daysWorked: 0, entriesCount: 0 };
}

function payrollFactsFor(index: PayrollFactsIndex, profileId: string): PayrollHoursFacts {
  const existing = index.get(profileId);
  if (existing !== undefined) return existing;
  const created = emptyPayrollFacts();
  index.set(profileId, created);
  return created;
}

/**
 * A pay settings row as the arithmetic wants it.
 *
 * `Number(value ?? fallback)` is the legacy coercion, kept because it is the
 * one place a null column and a missing row have to behave identically: an
 * employee with no `employee_payment_settings` row calculates at a zero rate
 * rather than failing the period.
 */
export function toPayrollPaySettings(row: PaySettingsRow | undefined): PayrollPaySettings {
  return {
    hourlyRate: Number(row?.hourly_rate ?? 0),
    overtimeMultiplier: Number(row?.overtime_multiplier ?? 1.5),
    weeklyOvertimeThreshold: Number(row?.weekly_overtime_threshold ?? 40),
    // A non-array `deductions` reads as none. Legacy threw part-way through the
    // response instead, which lost every employee's figures over one bad row.
    deductions: Array.isArray(row?.deductions) ? (row.deductions as PayrollDeduction[]) : [],
  };
}

/**
 * Dates in the period, inclusive, as the legacy overtime cap counts them.
 *
 * `new Date('YYYY-MM-DD')` is UTC midnight at both ends, so the difference is a
 * whole number of days and the `Math.round` is belt and braces. Transcribed
 * rather than replaced by a date-arithmetic helper because this figure feeds the
 * overtime cap: a different count is a different pay figure.
 */
function payrollPeriodDays(period: DateRange): number {
  const from = new Date(period.from).getTime();
  const to = new Date(period.to).getTime();
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * One employee's row: the pay arithmetic, shared by both modes.
 *
 * The order of operations and the position of every rounding boundary is the
 * pre-redesign one:
 *
 *   weeks       = period dates / 7                      (fractional, not whole)
 *   regularCap  = weeks x weekly overtime threshold
 *   regular     = min(worked, cap)
 *   overtime    = max(0, worked - cap)
 *   ptoHours    = pto days x 8
 *   gross       = regular x rate + overtime x rate x multiplier + ptoHours x rate
 *   deductions  = sum of fixed amounts and percentages of gross, then rounded
 *   net         = round(gross - rounded deductions)
 *
 * Note where the rounding is not: `gross` is built from unrounded components and
 * `net` subtracts the rounded deductions from the unrounded gross. Rounding
 * earlier would drift by a cent on the periods most likely to be checked.
 */
function payrollRowFor(
  employee: AttendanceEmployee,
  settings: PayrollPaySettings,
  facts: PayrollHoursFacts,
  periodDays: number,
): PayrollInputRow {
  const regularCap = (periodDays / 7) * settings.weeklyOvertimeThreshold;
  const regularHours = Math.min(facts.workedHours, regularCap);
  const overtimeHours = Math.max(0, facts.workedHours - regularCap);

  const ptoHoursPaid = facts.ptoDays * 8;
  const ptoPay = ptoHoursPaid * settings.hourlyRate;
  const regularPay = regularHours * settings.hourlyRate;
  const overtimePay = overtimeHours * settings.hourlyRate * settings.overtimeMultiplier;
  const grossPay = regularPay + overtimePay + ptoPay;

  let deductionsAccumulated = 0;
  for (const deduction of settings.deductions) {
    // `Number` because `deductions` is free-form JSON that no editor validates.
    // A no-op for the numbers the column is meant to hold; legacy instead let a
    // numeric string concatenate, so two string amounts produced "053".
    const amount = Number(deduction.amount);
    deductionsAccumulated += deduction.type === 'percentage' ? grossPay * (amount / 100) : amount;
  }
  const deductionsTotal = roundToTwoDecimals(deductionsAccumulated);

  return {
    profileId: employee.profileId,
    displayName: employee.displayName,
    initials: employee.initials,
    role: employee.role,
    hourlyRate: settings.hourlyRate,
    regularHours: roundToTwoDecimals(regularHours),
    overtimeHours: roundToTwoDecimals(overtimeHours),
    breakHours: roundToTwoDecimals(facts.breakHours),
    totalHours: roundToTwoDecimals(facts.workedHours),
    ptoDaysUsed: facts.ptoDays,
    ptoHoursPaid,
    regularPay: roundToTwoDecimals(regularPay),
    overtimePay: roundToTwoDecimals(overtimePay),
    ptoPay: roundToTwoDecimals(ptoPay),
    grossPay: roundToTwoDecimals(grossPay),
    deductionsTotal,
    netPay: roundToTwoDecimals(grossPay - deductionsTotal),
    daysWorked: facts.daysWorked,
    entriesCount: facts.entriesCount,
  };
}

/**
 * Whether the employee had any payroll activity in the period.
 *
 * Read off the rounded total, as legacy did, so an employee whose worked hours
 * round to zero is dropped rather than reported with a zero row.
 */
function hasPayrollActivity(row: PayrollInputRow): boolean {
  return row.totalHours > 0 || row.ptoDaysUsed > 0;
}

/** Every employee's pay configuration, in one query. */
async function readPaySettings(client: AttendanceClient): Promise<PaySettingsRow[]> {
  const query = client
    .from('employee_payment_settings')
    .select('profile_id, hourly_rate, overtime_multiplier, weekly_overtime_threshold, deductions');

  return rowsOf<PaySettingsRow>('employee_payment_settings', await query);
}

/**
 * The closed clock entries the legacy calculation counted.
 *
 * The window is the naive text the legacy route built, without a zone
 * designator, because the boundary it produces is part of the figure being
 * preserved. The `clock_out is not null` filter is what silently drops a session
 * with a missing clock-out.
 */
async function readLegacyPayrollEntries(
  client: AttendanceClient,
  period: DateRange,
): Promise<PayrollEntryRow[]> {
  const query = client
    .from('time_clock_entries')
    .select('id, profile_id, clock_in, total_hours, break_minutes')
    .gte('clock_in', `${period.from}T00:00:00`)
    .lte('clock_in', `${period.to}T23:59:59`)
    .not('clock_out', 'is', null);

  return rowsOf<PayrollEntryRow>('time_clock_entries', await query);
}

/**
 * The approved absences the legacy calculation counted.
 *
 * `approved` alone, and the whole `total_days` of any request overlapping the
 * period. Both are the legacy behaviour: `partially_approved` post-dates it, and
 * a request straddling the boundary is counted in full in both periods.
 */
async function readLegacyPayrollAbsences(
  client: AttendanceClient,
  period: DateRange,
): Promise<PayrollAbsenceRow[]> {
  const query = client
    .from('pto_requests')
    .select('profile_id, total_days')
    .eq('status', 'approved')
    .lte('start_date', period.to)
    .gte('end_date', period.from);

  return rowsOf<PayrollAbsenceRow>('pto_requests', await query);
}

/**
 * The UTC date of a clock-in instant, as the legacy day count bucketed it.
 *
 * Not a work date: this is `new Date(clock_in).toISOString().split('T')[0]`,
 * which assigns a shift worked on the evening of one date in a western timezone
 * to the next date. Preserved because `days_worked` is a stored summary field.
 *
 * An instant that cannot be read falls back to the stored text rather than
 * throwing, which is what legacy did on the same row.
 */
function legacyDayKey(clockIn: string): string {
  const instant = new Date(clockIn);
  if (Number.isFinite(instant.getTime())) return instant.toISOString().slice(0, 10);
  return readWorkDate(clockIn) ?? clockIn;
}

/**
 * The hours side of the pre-redesign calculation: stored `total_hours` summed
 * over closed entries, `break_minutes` as break hours, and whole request days
 * for every overlapping approved absence.
 *
 * Pure, so the transcription is checkable without a database.
 */
export function legacyPayrollFacts(
  entries: readonly PayrollEntryRow[],
  absences: readonly PayrollAbsenceRow[],
): PayrollFactsIndex {
  const index: PayrollFactsIndex = new Map();
  const datesByProfile = new Map<string, Set<string>>();

  for (const entry of entries) {
    const facts = payrollFactsFor(index, entry.profile_id);
    facts.workedHours += Number(entry.total_hours ?? 0);
    facts.breakHours += Number(entry.break_minutes ?? 0) / 60;
    facts.entriesCount += 1;

    const dates = datesByProfile.get(entry.profile_id) ?? new Set<string>();
    dates.add(legacyDayKey(entry.clock_in));
    datesByProfile.set(entry.profile_id, dates);
  }

  for (const [profileId, dates] of datesByProfile) {
    payrollFactsFor(index, profileId).daysWorked = dates.size;
  }

  for (const absence of absences) {
    payrollFactsFor(index, absence.profile_id).ptoDays += Number(absence.total_days ?? 0);
  }

  return index;
}

/**
 * The hours side read off the derived records: worked hours and unpaid break
 * minutes as the domain computed them, and one absence day per date the period
 * actually covers.
 *
 * Every figure here comes off a `DailyAttendanceRecord`; nothing is recomputed
 * (Requirements 3.14, 3.15, 19.6). The differences from `legacyPayrollFacts` are
 * all corrections: an open session contributes the hours it has accrued instead
 * of nothing, break minutes follow `policy.unpaidBreakTypes` instead of the
 * lunch-only column, a day is counted against the shift it was worked against,
 * and an absence contributes only the dates inside the period.
 */
export function recomputedPayrollFacts(
  records: readonly DailyAttendanceRecord[],
  subjects: RecordSubjectIndex,
): PayrollFactsIndex {
  const index: PayrollFactsIndex = new Map();

  for (const record of records) {
    const facts = payrollFactsFor(index, record.profileId);
    facts.workedHours += record.workedHours;
    facts.breakHours += record.unpaidBreakMinutes / 60;
    facts.entriesCount += record.sessions.length;
    if (record.firstClockIn !== null) facts.daysWorked += 1;
  }

  // Absence days through the domain's own `time_off_day` predicate, so the
  // definition of a paid absence day is the one Overview and the trends use.
  for (const record of filterRecords(records, { predicates: ['time_off_day'] }, subjects)) {
    payrollFactsFor(index, record.profileId).ptoDays += 1;
  }

  return index;
}

/**
 * The per-employee figures a payroll period is calculated from.
 *
 * `legacy_parity` reproduces the pre-redesign arithmetic exactly and is the mode
 * every caller uses today. `recomputed` applies the same pay arithmetic to hours
 * the attendance derivation produced, and is wired to nothing: adopting it would
 * move payroll output for unchanged input, which Requirement 2, criterion 6
 * reserves for a separately approved payroll rule change.
 *
 * Active employees only, ordered by display name, with employees who neither
 * worked nor took paid leave dropped.
 *
 * The caller authorises. See the module note above `PayrollInputMode`.
 *
 * @throws AttendanceServiceError `invalid_range` for a period that is not a
 *   calendar range, `read_failed` for a source read that failed, and for an
 *   unrecognised mode.
 *
 * Requirements: 2.4, 19.6
 */
export async function payrollInputs(
  period: DateRange,
  mode: PayrollInputMode,
  context: AttendanceContext,
): Promise<PayrollInputRow[]> {
  // A mode arriving from a query string can be any string, and defaulting an
  // unrecognised one to either mode would silently pay somebody by the wrong rule.
  if (mode !== 'legacy_parity' && mode !== 'recomputed') {
    throw new AttendanceServiceError(
      'read_failed',
      `attendance: unknown payroll input mode "${String(mode)}"`,
      { mode: String(mode) },
    );
  }

  const resolved = resolveRange(period.from, period.to);
  const periodDays = payrollPeriodDays(resolved);

  const { employees, settingsByProfile, facts } =
    mode === 'legacy_parity'
      ? await legacyPayrollSources(resolved, context)
      : await recomputedPayrollSources(resolved, context);

  return employees
    .filter((employee) => employee.isActive)
    .map((employee) =>
      payrollRowFor(
        employee,
        toPayrollPaySettings(settingsByProfile.get(employee.profileId)),
        facts.get(employee.profileId) ?? emptyPayrollFacts(),
        periodDays,
      ),
    )
    .filter(hasPayrollActivity);
}

/** What either mode hands the row builder. */
interface PayrollSources {
  employees: AttendanceEmployee[];
  settingsByProfile: Map<string, PaySettingsRow>;
  facts: PayrollFactsIndex;
}

function indexPaySettings(rows: readonly PaySettingsRow[]): Map<string, PaySettingsRow> {
  return new Map(rows.map((row) => [row.profile_id, row]));
}

/**
 * The four legacy reads, issued together.
 *
 * `attendance_policy` is not read: the legacy calculation consulted no policy,
 * and reading one here would invite a tolerance into a figure that must not move.
 */
async function legacyPayrollSources(
  period: DateRange,
  context: AttendanceContext,
): Promise<PayrollSources> {
  const [profiles, settings, entries, absences] = await Promise.all([
    readProfiles(context.client, 'all'),
    readPaySettings(context.client),
    readLegacyPayrollEntries(context.client, period),
    readLegacyPayrollAbsences(context.client, period),
  ]);

  // The employee mapping needs a policy only for its timezone fallback, which
  // the legacy figures never consult. The documented defaults keep the read at
  // four queries.
  const policy = context.policy ?? DEFAULT_ATTENDANCE_POLICY;

  return {
    employees: sortEmployees(profiles.map((row) => toAttendanceEmployee(row, policy))),
    settingsByProfile: indexPaySettings(settings),
    facts: legacyPayrollFacts(entries, absences),
  };
}

/** The record range plus the pay settings: ten reads, whatever the roster. */
async function recomputedPayrollSources(
  period: DateRange,
  context: AttendanceContext,
): Promise<PayrollSources> {
  const [sources, settings] = await Promise.all([
    readAttendanceSources(context, 'all', period, true),
    readPaySettings(context.client),
  ]);

  const employees = sortEmployees(sources.employees);
  const subjects = toSubjectIndex(employees);

  return {
    employees,
    settingsByProfile: indexPaySettings(settings),
    facts: recomputedPayrollFacts(deriveRecords(sources), subjects),
  };
}

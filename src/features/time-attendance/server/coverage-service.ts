// src/features/time-attendance/server/coverage-service.ts
// The one read path behind every coverage surface: the Live_Coverage_Panel on
// Today, the Coverage_Calendar on Time Off & Coverage, the Health_Ribbon on all
// three operational screens, and the Approval_Impact_Preview inside the decision
// drawer.
//
// ## One query shape, four consumers
//
// `CoverageQuery` is deliberately small, and each consumer is a setting of it:
//
// | consumer                  | mode        | range          | proposedAbsence |
// | ------------------------- | ----------- | -------------- | --------------- |
// | Live_Coverage_Panel       | `live`      | one date       | —               |
// | Coverage_Calendar         | `projected` | month or fortnight | —           |
// | Health_Ribbon             | `projected` | seven dates    | —               |
// | Approval_Impact_Preview   | `projected` | the request's dates | the request |
//
// That is the whole point. The ribbon has no coverage code of its own to
// disagree with the calendar, and the impact preview computes the projection the
// same way the calendar does, so the figure shown before a decision is the figure
// read after it (Correctness Properties 20 and 21). `getImpact` is a thin wrapper
// that loads the request and calls `getCoverage` with the request's own dates as
// the proposed absence — it holds no projection arithmetic at all.
//
// ## The whole displayed range in one request
//
// Requirements 8.12, 18.11, and 20.4 all say the same thing: a coverage surface
// asks once. The outbound query count is therefore a property of the mode, never
// of the roster size or the range length:
//
// | mode        | configuration | range reads | total |
// | ----------- | ------------- | ----------- | ----- |
// | `projected` | 2             | 4           | 6     |
// | `live`      | 2             | 7           | 9     |
//
// The four projected range reads are profiles, published schedules over the
// range, time-off requests overlapping the range (approved and pending in one
// query), and the closed dates in the range. Live coverage additionally needs the
// derived records, so it reuses `readAttendanceSources` — profiles, schedules,
// clock entries, breaks, approved absences — and adds the pending-request and
// closed-date reads that the attendance read has no reason to make.
//
// Every read is issued unconditionally. Skipping one because its input happens to
// be empty would make the count a function of the data, which is what Property 46
// measures.
//
// ## Projected coverage never reads clock data
//
// The projected path does not read `time_clock_entries` or `time_clock_breaks` at
// all, and `ProjectionInput` has no field able to hold them, so Requirement 19,
// criterion 4 and Property 13 hold by construction rather than by discipline.
// Live coverage reads `DailyAttendanceRecord[]`, which is a conclusion the status
// matrix drew, so "is this employee at work" still has exactly one
// implementation.
//
// ## Required staffing
//
// Required staffing comes from `staffing_thresholds` for the department, the
// date's day of week, and a time slot (Requirement 6, criterion 3). The lookup is
// exact — `server/policy.ts` refuses to treat a `full_day` row as a default for
// `morning` — so this module states which slot each figure is compared against:
// a whole-date projection uses `full_day`, and live coverage uses the slot the
// evaluation instant falls in. `staffing_thresholds` is empty until migration
// stage 6, so most lookups answer null today, which renders as required
// unconfigured and Coverage_Status Healthy (criterion 4).
//
// ## Employee names
//
// Requirement 8, criterion 13 withholds employee names from absences unless the
// caller administers attendance or a shared absence calendar permission grants
// name visibility. No such permission exists in the schema, so it arrives here as
// an input on the context rather than as a role — the shape Property 36 pins.
// The same rule is applied to every employee reference in the response, not only
// to absences: a named list of scheduled employees would otherwise be a way
// around the criterion.
//
// Requirements: 6.1 (one row per department), 6.2 (the seven live figures), 6.3
// (required staffing per department, day of week, and time slot), 6.4 (an
// unconfigured slot reports unconfigured and Healthy), 6.13, 6.14, 8.2 (the
// per-date calendar figures), 8.5 (the date drawer's four lists), 8.6, 8.8, 8.9,
// 8.10, 8.11, 8.12 (the whole displayed range in a single request), 8.13 (names
// withheld without administration or the shared-calendar permission), 9.1 (the
// projection for every requested date with the request as a proposed absence),
// 9.2 (scheduled minus approved minus proposed), 9.4, 9.5 (the interval
// breakdown), 9.6 (interval availability from schedules and absences, not clock
// entries), 9.14 (a date that cannot be projected carries its reason and the rest
// of the range survives), 18.4, 18.5, 18.11 (the seven-date state set in one
// request), 19.4, 20.4 (the whole displayed coverage range in a single request),
// 21.1, 21.2.

import {
  resolveScheduleFacts,
  type RecordSubjectIndex,
  type ScheduleInput,
} from '../domain/attendance';
import {
  DEPARTMENT_ORDER,
  RIBBON_DAYS,
  buildCoverageIntervals,
  deriveRibbonStates,
  liveCoverage,
  projectCoverage,
  type CoverageInterval,
  type DateCoverage,
  type DepartmentCoverage,
  type RibbonDate,
  type ShiftWindow,
} from '../domain/coverage';
import type {
  AttendancePolicy,
  DailyAttendanceRecord,
  DateRange,
  Threshold,
} from '../domain/types';
import { addCalendarDays, wallClockOf, zonedToInstant } from '../domain/work-date';
import type { Department, TimeSlot } from '../types';
import {
  AttendanceServiceError,
  MAX_RANGE_DAYS,
  deriveRecords,
  readAttendanceSources,
  toAttendanceEmployee,
  toSubjectIndex,
  type AbsenceRow,
  type AttendanceClient,
  type AttendanceEmployee,
  type ProfileRow,
  type ScheduleRow,
} from './attendance-service';
import {
  loadAttendanceConfig,
  loadAttendancePolicy,
  loadStaffingThresholds,
  type StaffingThresholdTable,
} from './policy';
import { type Actor, canAdministerAttendance, visibleProfileIds } from './visibility';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * The slot a whole-date figure is compared against.
 *
 * A Projected_Coverage figure describes a whole date, so it is compared against
 * the whole-day requirement. The morning and afternoon rows describe a part of a
 * date and are what Live_Coverage reads, since "now" falls inside exactly one of
 * them.
 */
const WHOLE_DATE_TIME_SLOT: TimeSlot = 'full_day';

/**
 * The hour, in the business timezone, at which the morning slot ends.
 *
 * Transcribed from the behaviour `/api/staffing` has had since the thresholds
 * table was introduced, so wiring the coverage service in does not silently move
 * which row an afternoon figure is compared against. The one change is the zone:
 * the hour is read in the business timezone rather than in whatever timezone the
 * server process happens to run in.
 */
const AFTERNOON_START_HOUR = 12;

/** `employee_schedules.status` values the projection admits. Published only. */
const READ_SCHEDULE_STATUSES = ['published'] as const;

/** `pto_requests.status` values that record an absence the employee will take. */
const APPROVED_ABSENCE_STATUSES = ['approved', 'partially_approved'] as const;

/** `pto_requests.status` value that records an absence nobody has decided yet. */
const PENDING_STATUS = 'pending';

/** The statuses the projected path reads in one query, then splits. */
const COVERAGE_REQUEST_STATUSES = [...APPROVED_ABSENCE_STATUSES, PENDING_STATUS] as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The shift facts `resolveScheduleFacts` copies through but this module never
 * reads. Only the resolved `start` and `end` instants matter for an interval
 * partition, and the read already filters to published rows, so re-deriving the
 * two enumerations here would add a second place for the vocabulary to drift.
 */
const IGNORED_SHIFT_FACTS = { shiftType: 'regular', status: 'published' } as const;

// ─── Query ───────────────────────────────────────────────────────────────────

/**
 * Which coverage figure is being asked for.
 *
 * `live` is current operational coverage: who is at work right now, read from
 * derived status. `projected` is expected coverage: how many are scheduled less
 * how many are away, read from published schedules and absences only. The two are
 * separate figures answering separate questions, which is the distinction
 * Requirement 6, criterion 15 asks the panel to make visible.
 */
export type CoverageMode = 'live' | 'projected';

/**
 * One coverage question. The four consumers are four settings of this shape.
 *
 * `from` and `to` are inclusive `YYYY-MM-DD` bounds. `live` answers one date, so
 * it requires `from` to equal `to`: there is no such thing as current coverage
 * over a fortnight, and quietly answering for the first date would let a caller
 * believe otherwise.
 *
 * `department` restricts every figure to the employees mapped to that department,
 * which is the same expression applied to a smaller roster (Requirement 8,
 * criterion 8). Omitted, the response carries the whole organisation plus a row
 * per department.
 *
 * `proposedAbsence` is the requested absence of an Approval_Impact_Preview: an
 * absence that is not approved and is being costed (Requirement 9, criteria 1 and
 * 2). It affects the projection only; live coverage is a reading of clock state
 * and cannot be perturbed by a hypothetical.
 */
export interface CoverageQuery {
  from: string;
  to: string;
  mode: CoverageMode;
  department?: Department;
  proposedAbsence?: { profileId: string; ranges: readonly DateRange[] };
}

/**
 * Everything a coverage read needs besides its own arguments.
 *
 * `evaluatedAt` is the instant live coverage is read at and the instant the live
 * time slot is resolved from. Supplied by the caller so a read is reproducible;
 * defaults to the moment the read starts.
 *
 * `policy` and `thresholds` let a composite request that has already loaded the
 * configuration pass it down instead of reading it again.
 *
 * `sharedAbsenceCalendarGrant` is Requirement 8, criterion 13's shared absence
 * calendar permission. It is an input rather than a role test because the schema
 * carries no such grant yet, and because the criterion describes something that
 * widens absence visibility for a caller who is not an administrator — never a
 * role gaining attendance administration.
 */
export interface CoverageContext {
  client: AttendanceClient;
  /** ISO instant. Defaults to the moment the read starts. */
  evaluatedAt?: string;
  policy?: AttendancePolicy;
  thresholds?: StaffingThresholdTable;
  /** Requirement 8, criterion 13's shared absence calendar permission. */
  sharedAbsenceCalendarGrant?: boolean;
}

// ─── Response shapes ─────────────────────────────────────────────────────────

/**
 * An employee a coverage response refers to.
 *
 * `displayName` and `initials` are null when names are withheld (Requirement 8,
 * criterion 13). The identifier is retained either way: it names nobody without
 * the roster, the roster read runs under the caller's own row level security, and
 * the projection figures carry identifiers too — withholding it here while
 * `DateCoverage` carries it would be a distinction without a difference.
 */
export interface CoverageEmployee {
  profileId: string;
  department: Department | null;
  displayName: string | null;
  initials: string | null;
}

/** One absence on a date: approved and already costed, or pending and not. */
export interface CoverageAbsence {
  requestId: string;
  employee: CoverageEmployee;
  /** The stored request bounds, which may reach outside the read range. */
  startDate: string;
  endDate: string;
  kind: 'approved' | 'pending';
}

/**
 * Why one date carries no projection.
 *
 * Stated in plain language, because it is displayed: Requirement 9, criterion 14
 * asks the Approval_Impact_Preview to say that the projection is unavailable for
 * that date *and* to state the reason, and the Coverage_Calendar renders the same
 * text beside its unavailable marker.
 */
export interface CoverageUnavailable {
  reason: string;
}

/**
 * One date's coverage picture: the projection, its interval breakdown, and the
 * four lists the date drawer shows (Requirement 8, criterion 5).
 *
 * `closed` and `hasPublishedSchedule` are the two facts that decide a
 * Health_Ribbon state before any coverage status is read (Requirement 18,
 * criteria 4 and 5). They are carried rather than inferred so the calendar can
 * label a closed date without a second request.
 */
export interface ComputedCoverageDate {
  workDate: string;
  /**
   * Absent on a computed date, and the discriminant against
   * `UnavailableCoverageDate`.
   */
  unavailable?: undefined;
  /** 0 is Sunday, matching `staffing_thresholds.day_of_week`. */
  dayOfWeek: number;
  /** The slot the required figures on this date were looked up for. */
  timeSlot: TimeSlot;
  closed: boolean;
  /** `attendance_closed_dates.label`, or null when the date is open. */
  closedLabel: string | null;
  hasPublishedSchedule: boolean;
  /** Requirement 8, criterion 6: scheduled minus approved minus proposed. */
  projection: DateCoverage;
  /** Requirements 8.9 through 8.11, 9.4, 9.5. Empty when nothing is scheduled. */
  intervals: CoverageInterval[];
  scheduled: CoverageEmployee[];
  approvedAbsences: CoverageAbsence[];
  pendingRequests: CoverageAbsence[];
}

/**
 * One date the projection could not be computed for.
 *
 * It carries the date and the reason, and nothing else. A zeroed projection
 * alongside the reason would be worse than no projection: a caller that did not
 * branch would render "0 available, Critical" — a definite claim about a date
 * nothing is known about — so the figures are absent from the type rather than
 * present and meaningless.
 *
 * Requirements: 9.14
 */
export interface UnavailableCoverageDate {
  workDate: string;
  unavailable: CoverageUnavailable;
}

/**
 * One per-date result: computed, or unavailable with its reason.
 *
 * A union rather than an optional field on one shape, so a consumer cannot read
 * `projection` without having established that there is one. That is what makes
 * Requirement 9, criterion 14 structural for the calendar and the impact preview
 * rather than a thing to remember.
 */
export type CoverageDate = ComputedCoverageDate | UnavailableCoverageDate;

/** Whether this date carries figures. Narrows the per-date union. */
export function isComputedCoverageDate(date: CoverageDate): date is ComputedCoverageDate {
  return date.unavailable === undefined;
}

/** What one coverage read returns. */
export interface CoverageResponse {
  mode: CoverageMode;
  /** The range read, both bounds inclusive. */
  range: DateRange;
  evaluatedAt: string;
  /** The department every figure is restricted to, or null for the whole roster. */
  department: Department | null;
  /** Whether employee names accompany the response (Requirement 8.13). */
  employeeNamesVisible: boolean;
  /** True when `staffing_thresholds` carries at least one row. */
  thresholdsConfigured: boolean;
  /** The employees the figures were computed over. */
  employees: CoverageEmployee[];
  /** One entry per date in the range, ascending. */
  dates: CoverageDate[];
  /**
   * Live coverage per department for `range.from`. Empty in projected mode.
   *
   * Requirements: 6.1, 6.2, 6.13, 6.14
   */
  live: DepartmentCoverage[];
  /** The slot `live` was compared against, or null in projected mode. */
  liveTimeSlot: TimeSlot | null;
  /**
   * The seven Health_Ribbon dates beginning at `range.from`.
   *
   * Empty unless the mode is `projected` and the range spans at least seven
   * dates, because the ribbon consumer asks for exactly seven (Requirement 18,
   * criterion 2). A shorter range carries no ribbon rather than a ribbon padded
   * with dates nothing was read for.
   */
  ribbon: RibbonDate[];
}

/** The request an impact preview is costing. */
export interface ImpactRequest {
  requestId: string;
  profileId: string;
  employee: CoverageEmployee | null;
  startDate: string;
  endDate: string;
  status: string;
}

/** What an impact preview returns: the request, and the coverage it would cause. */
export interface ImpactResponse {
  request: ImpactRequest;
  /** The absence handed to the projection, exactly as `getCoverage` received it. */
  proposedAbsence: { profileId: string; ranges: DateRange[] };
  coverage: CoverageResponse;
}

// ─── Source row shapes ───────────────────────────────────────────────────────

/**
 * A `pto_requests` row as the coverage reads select it.
 *
 * Extends the attendance read's `AbsenceRow` with the status, because the
 * projected path reads approved and pending rows in one query and splits them
 * here rather than paying for two round trips.
 */
export interface CoverageRequestRow extends AbsenceRow {
  status?: unknown;
}

export interface ClosedDateRow {
  closed_date: string;
  label?: unknown;
}

/** Everything one coverage read fetched. */
export interface CoverageSources {
  range: DateRange;
  evaluatedAt: string;
  policy: AttendancePolicy;
  employees: readonly AttendanceEmployee[];
  schedules: readonly ScheduleRow[];
  approvedAbsences: readonly CoverageRequestRow[];
  pendingRequests: readonly CoverageRequestRow[];
  closedDates: readonly ClosedDateRow[];
  /** The derived records behind live coverage. Empty in projected mode. */
  records: readonly DailyAttendanceRecord[];
}

// ─── Field readers ───────────────────────────────────────────────────────────

function readText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

/** A stored `date` column, which can arrive as `YYYY-MM-DD` or as a timestamp. */
function readWorkDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10) return null;
  const candidate = value.slice(0, 10);
  return DATE_PATTERN.test(candidate) ? candidate : null;
}

function isApprovedStatus(value: unknown): boolean {
  return (APPROVED_ABSENCE_STATUSES as readonly string[]).includes(String(value));
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * A read that failed is reported rather than absorbed.
 *
 * `AttendanceServiceError` is reused rather than copied: its three codes —
 * `read_failed`, `not_visible`, `invalid_range` — are exactly the failures a
 * coverage read can have, and they already map onto the shared error contract in
 * `api-response.ts`. A second error class carrying the same three codes would
 * only give the route layer two things to match on.
 */
function coverageError(
  code: 'read_failed' | 'not_visible' | 'invalid_range',
  message: string,
  detail: Record<string, string> = {},
): AttendanceServiceError {
  return new AttendanceServiceError(code, message, detail);
}

function rowsOf<T>(
  table: string,
  result: { data: unknown; error: { message: string; code?: string } | null },
): T[] {
  if (result.error) {
    throw coverageError('read_failed', `coverage: reading ${table} failed: ${result.error.message}`, {
      table,
      ...(result.error.code === undefined ? {} : { pgCode: result.error.code }),
    });
  }
  return (result.data as T[] | null) ?? [];
}

// ─── Range resolution ────────────────────────────────────────────────────────

function assertCalendarDate(value: string, field: string): string {
  // Two checks, because the shape and the date are different mistakes:
  // `2026-2-3` fails the pattern, `2026-02-30` matches it and names no date.
  if (typeof value === 'string' && DATE_PATTERN.test(value)) {
    try {
      return addCalendarDays(value, 0);
    } catch {
      // Falls through to the reported failure below.
    }
  }

  throw coverageError(
    'invalid_range',
    `coverage: ${field} must be a calendar date, received "${String(value)}"`,
    { field, value: String(value) },
  );
}

/**
 * The range a coverage read will honour, and the dates it covers.
 *
 * The date list is produced here rather than per consumer so that a date the
 * response carries and a date a figure was computed for cannot differ. The width
 * cap is the attendance read's cap: past it, an accidental range — a cleared date
 * picker, a query-string typo — would build a projection per date for years
 * before anything downstream could reject it.
 */
function resolveRange(from: string, to: string): { range: DateRange; dates: string[] } {
  const start = assertCalendarDate(from, 'from');
  const end = assertCalendarDate(to, 'to');

  if (start > end) {
    throw coverageError('invalid_range', 'coverage: from must not follow to', {
      from: start,
      to: end,
    });
  }

  const dates: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addCalendarDays(cursor, 1)) {
    dates.push(cursor);
    if (dates.length > MAX_RANGE_DAYS) {
      throw coverageError(
        'invalid_range',
        `coverage: a range of more than ${MAX_RANGE_DAYS} dates cannot be read in one request`,
        { from: start, to: end, maxDays: String(MAX_RANGE_DAYS) },
      );
    }
  }

  return { range: { from: start, to: end }, dates };
}

// ─── Calendar facts ──────────────────────────────────────────────────────────

/**
 * The day of week of a calendar date, 0 for Sunday, matching
 * `staffing_thresholds.day_of_week`.
 *
 * The date is anchored at midnight UTC, where every day is exactly 24 hours, so
 * the answer is a property of the calendar date rather than of any zone or of the
 * process timezone. Routed through `zonedToInstant` because that is the module
 * that owns turning a date string into an instant, and it rejects a string that
 * matches the shape but names no real date.
 */
function dayOfWeekOf(workDate: string): number {
  return zonedToInstant(workDate, '00:00:00', 'UTC').getUTCDay();
}

/**
 * The slot an instant falls in, read in the business timezone.
 *
 * Only live coverage asks: a whole-date figure is compared against `full_day`.
 * The hour is read through `wallClockOf`, so the answer does not move with the
 * timezone the server runs in — which is the bug in the behaviour this replaces.
 */
function timeSlotAt(evaluatedAt: string, policy: AttendancePolicy): TimeSlot {
  const instant = new Date(evaluatedAt);
  if (!Number.isFinite(instant.getTime())) return WHOLE_DATE_TIME_SLOT;

  const hour = Number(wallClockOf(instant, policy.businessTimezone).time.slice(0, 2));
  return hour < AFTERNOON_START_HOUR ? 'morning' : 'afternoon';
}

// ─── The reads ───────────────────────────────────────────────────────────────

type ProfileScope = string[] | 'all';

async function readProfiles(client: AttendanceClient, scope: ProfileScope): Promise<ProfileRow[]> {
  let query = client
    .from('profiles')
    .select('id, display_name, initials, role, timezone, is_active');
  if (scope !== 'all') query = query.in('id', scope);

  return rowsOf<ProfileRow>('profiles', await query);
}

/**
 * Published schedule rows on the requested dates.
 *
 * Narrower than the attendance read, which widens by a date at each end so an
 * overnight session is attributed to the shift it was worked against. A
 * projection has nothing to attribute: it counts the employees a date carries a
 * published row for, so a boundary date's rows would only be filtered back out.
 */
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

/**
 * Time-off requests overlapping the range, in the statuses `statuses` names.
 *
 * Overlap, not containment: a request that starts before the range and ends
 * inside it covers dates in the range.
 */
async function readRequests(
  client: AttendanceClient,
  scope: ProfileScope,
  range: DateRange,
  statuses: readonly string[],
): Promise<CoverageRequestRow[]> {
  // The request type is deliberately not selected. Coverage counts absences, and
  // the type is a decision-drawer concern: an approved absence removes the
  // employee from the date whatever kind of leave it is, so reading the column
  // here would be a second place to keep in step with the constraint for no
  // effect on the figure.
  let query = client
    .from('pto_requests')
    .select('id, profile_id, start_date, end_date, status')
    .in('status', statuses)
    .lte('start_date', range.to)
    .gte('end_date', range.from);
  if (scope !== 'all') query = query.in('profile_id', scope);

  return rowsOf<CoverageRequestRow>('pto_requests', await query);
}

/**
 * The dates the organisation is not open, inside the range.
 *
 * Readable by every signed-in user, because the Health_Ribbon renders a Closed
 * date for everybody (Requirement 18, criterion 4).
 */
async function readClosedDates(
  client: AttendanceClient,
  range: DateRange,
): Promise<ClosedDateRow[]> {
  const query = client
    .from('attendance_closed_dates')
    .select('closed_date, label')
    .gte('closed_date', range.from)
    .lte('closed_date', range.to);

  return rowsOf<ClosedDateRow>('attendance_closed_dates', await query);
}

/** The `pto_requests` row an impact preview is costing. */
interface ImpactRequestRow {
  id: string;
  profile_id: string;
  start_date: string;
  end_date: string;
  status?: unknown;
}

async function readRequest(
  client: AttendanceClient,
  requestId: string,
): Promise<ImpactRequestRow | null> {
  const result = await client
    .from('pto_requests')
    .select('id, profile_id, start_date, end_date, status')
    .eq('id', requestId)
    .maybeSingle();

  if (result.error) {
    throw coverageError(
      'read_failed',
      `coverage: reading pto_requests failed: ${result.error.message}`,
      { table: 'pto_requests' },
    );
  }

  return (result.data as ImpactRequestRow | null) ?? null;
}

/**
 * Both configuration reads, unless the caller already has them.
 *
 * Two queries, or one, or none. The count does not move with the range or the
 * roster either way, so a composite request that passes the configuration down
 * pays for it once rather than once per surface.
 */
async function resolveConfig(
  context: CoverageContext,
): Promise<{ policy: AttendancePolicy; thresholds: StaffingThresholdTable }> {
  if (context.policy !== undefined && context.thresholds !== undefined) {
    return { policy: context.policy, thresholds: context.thresholds };
  }
  if (context.policy !== undefined) {
    return { policy: context.policy, thresholds: await loadStaffingThresholds(context.client) };
  }
  if (context.thresholds !== undefined) {
    return { policy: await loadAttendancePolicy(context.client), thresholds: context.thresholds };
  }
  return loadAttendanceConfig(context.client);
}

/**
 * The source rows for one coverage read.
 *
 * Projected mode issues four range reads. Live mode reuses
 * `readAttendanceSources` for the five the derivation needs, then adds the two
 * the attendance read has no reason to make: the pending requests the calendar
 * counts, and the closed dates the ribbon reads. Nothing is read twice — the
 * approved absences come from the attendance read's own absence query.
 */
async function readCoverageSources(
  context: CoverageContext,
  scope: ProfileScope,
  range: DateRange,
  mode: CoverageMode,
  evaluatedAt: string,
  policy: AttendancePolicy,
): Promise<CoverageSources> {
  const base = { range, evaluatedAt, policy };

  if (mode === 'projected') {
    const [profiles, schedules, requests, closedDates] = await Promise.all([
      readProfiles(context.client, scope),
      readSchedules(context.client, scope, range),
      readRequests(context.client, scope, range, COVERAGE_REQUEST_STATUSES),
      readClosedDates(context.client, range),
    ]);

    return {
      ...base,
      employees: profiles.map((row) => toAttendanceEmployee(row, policy)),
      schedules,
      approvedAbsences: requests.filter((row) => isApprovedStatus(row.status)),
      pendingRequests: requests.filter((row) => !isApprovedStatus(row.status)),
      closedDates,
      records: [],
    };
  }

  const sources = await readAttendanceSources(
    { client: context.client, evaluatedAt, policy },
    scope,
    range,
    false,
  );

  const [pendingRequests, closedDates] = await Promise.all([
    readRequests(context.client, scope, range, [PENDING_STATUS]),
    readClosedDates(context.client, range),
  ]);

  return {
    ...base,
    employees: sources.employees,
    schedules: sources.schedules,
    approvedAbsences: sources.absences,
    pendingRequests,
    closedDates,
    records: deriveRecords(sources),
  };
}

// ─── Assembly ────────────────────────────────────────────────────────────────

/**
 * Whether this caller sees employee names alongside absences.
 *
 * Requirement 8, criterion 13 and Property 36's decision table:
 * administration, or the shared absence calendar grant. Nothing else, and no
 * role gains administration by holding the grant.
 */
export function absenceNamesVisible(actor: Actor, sharedAbsenceCalendarGrant: boolean): boolean {
  return canAdministerAttendance(actor.role) || sharedAbsenceCalendarGrant;
}

/**
 * An employee reference, named or not.
 *
 * An employee always sees their own name, whatever the grant says: their own
 * attendance data is theirs to read (Requirement 21, criterion 1), and blanking
 * it would tell them less about their own absence than the request row already
 * does.
 */
function toCoverageEmployee(
  employee: AttendanceEmployee,
  actor: Actor,
  namesVisible: boolean,
): CoverageEmployee {
  const named = namesVisible || employee.profileId === actor.id;
  return {
    profileId: employee.profileId,
    department: employee.department,
    displayName: named ? employee.displayName : null,
    initials: named ? employee.initials : null,
  };
}

/** An employee the roster does not carry: referenced, never named. */
function unknownCoverageEmployee(profileId: string): CoverageEmployee {
  return { profileId, department: null, displayName: null, initials: null };
}

/** One employee's shift on one date, resolved into instants. */
interface DateSchedule {
  profileId: string;
  window: ShiftWindow;
}

/**
 * Published schedules bucketed by work date, resolved into shift windows.
 *
 * Resolution runs through the domain's `resolveScheduleFacts`, so an overnight
 * shift arrives with its end on the following date and a shift crossing a
 * daylight-saving transition arrives with its true span. A row whose times cannot
 * be read resolves to nothing and is dropped: it can neither staff an interval
 * nor bound one, and the Exception_Queue is where a malformed schedule is
 * reported.
 */
function schedulesByDate(
  sources: CoverageSources,
  members: ReadonlySet<string>,
): Map<string, DateSchedule[]> {
  const byDate = new Map<string, DateSchedule[]>();

  for (const row of sources.schedules) {
    const workDate = readWorkDate(row.schedule_date);
    if (workDate === null || !members.has(row.profile_id)) continue;

    const start = row.shift_start;
    const end = row.shift_end;
    if (typeof start !== 'string' || typeof end !== 'string') continue;

    const schedule: ScheduleInput = { start, end, ...IGNORED_SHIFT_FACTS };
    const facts = resolveScheduleFacts(workDate, schedule, sources.policy);
    if (facts === null) continue;

    const entry: DateSchedule = {
      profileId: row.profile_id,
      window: { profileId: row.profile_id, start: facts.start, end: facts.end },
    };

    const list = byDate.get(workDate);
    if (list === undefined) byDate.set(workDate, [entry]);
    else list.push(entry);
  }

  return byDate;
}

/**
 * Absence rows bucketed by every date they cover inside the range.
 *
 * A request is expanded across its dates rather than compared per date at read
 * time, so a request spanning a month contributes to each of its dates exactly
 * once and the per-date lists cannot disagree with the counts taken from them.
 */
function absencesByDate(
  rows: readonly CoverageRequestRow[],
  kind: 'approved' | 'pending',
  range: DateRange,
  members: ReadonlySet<string>,
  employeeOf: (profileId: string) => CoverageEmployee,
): Map<string, CoverageAbsence[]> {
  const byDate = new Map<string, CoverageAbsence[]>();

  for (const row of rows) {
    if (!members.has(row.profile_id)) continue;
    const start = readWorkDate(row.start_date);
    const end = readWorkDate(row.end_date);
    if (start === null || end === null || start > end) continue;

    const absence: CoverageAbsence = {
      requestId: row.id,
      employee: employeeOf(row.profile_id),
      startDate: start,
      endDate: end,
      kind,
    };

    const first = start < range.from ? range.from : start;
    const last = end > range.to ? range.to : end;
    for (let date = first; date <= last; date = addCalendarDays(date, 1)) {
      const list = byDate.get(date);
      if (list === undefined) byDate.set(date, [absence]);
      else list.push(absence);
    }
  }

  return byDate;
}

/** The dates a proposed absence covers, inside the range. */
function proposedDates(query: CoverageQuery, range: DateRange): Set<string> {
  const dates = new Set<string>();
  const proposed = query.proposedAbsence;
  if (proposed === undefined) return dates;

  for (const requested of proposed.ranges) {
    const start = readWorkDate(requested.from);
    const end = readWorkDate(requested.to);
    if (start === null || end === null || start > end) continue;

    const first = start < range.from ? range.from : start;
    const last = end > range.to ? range.to : end;
    for (let date = first; date <= last; date = addCalendarDays(date, 1)) dates.add(date);
  }

  return dates;
}

/** The threshold pair per department for one date and slot. */
function departmentThresholds(
  departments: readonly Department[],
  thresholds: StaffingThresholdTable,
  dayOfWeek: number,
  timeSlot: TimeSlot,
): ReadonlyMap<Department, Threshold | null> {
  return new Map(
    departments.map<[Department, Threshold | null]>((department) => [
      department,
      thresholds.thresholdFor(department, dayOfWeek, timeSlot),
    ]),
  );
}

/**
 * Distinct identifiers, sorted.
 *
 * A headcount counts employees, not rows, so a split shift recorded as two
 * schedule rows contributes one identifier. The domain figures de-duplicate too;
 * doing it here as well keeps the per-date lists the response carries consistent
 * with the counts computed from them.
 */
function distinctSorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/** Stated when a date's projection failed for a reason with no reader's message. */
export const PROJECTION_UNAVAILABLE_REASON =
  'The coverage projection for this date could not be computed.';

/**
 * The per-date result for a date whose projection raised.
 *
 * ## What can actually raise today: nothing
 *
 * Worth saying plainly rather than implying otherwise. The whole range is built
 * from one set of rows and one threshold table that were read before any date was
 * touched, and each per-date step is total over that input:
 *
 * - `thresholds.thresholdFor` is a lookup in a `Map` that
 *   `buildStaffingThresholdTable` already filled and validated, and a miss
 *   answers `null` rather than raising (Requirement 6, criterion 4).
 * - `loadStaffingThresholds` treats a failed read as an empty table, so a
 *   threshold failure is whole-request and already absorbed before this point.
 * - `dayOfWeekOf` can raise for a string that names no date, but `resolveRange`
 *   stepped every date through `addCalendarDays` first.
 * - `projectCoverage` and `buildCoverageIntervals` contain no `throw`.
 *
 * So this branch is unreachable through `getCoverage` as the service stands. It
 * is written anyway, because the contract is what the calendar and the impact
 * preview are built against, and because two reachable paths are one change away:
 * `buildCoverage` is exported and takes its date list as an argument, so a caller
 * that assembles one itself can hand over a date `dayOfWeekOf` rejects; and
 * `StaffingThresholdTable` is an interface, so a per-date or lazily-read
 * implementation — the case the design names — would raise here rather than at
 * load time. Neither can then blank the range.
 *
 * The reason is the error's own message only when the error is one this module
 * authored, since those are written for a reader. Anything else is logged for a
 * maintainer and stated generically, on the same grounds `api-response.ts`
 * withholds an unclassified message: a driver or connection string does not
 * belong in a calendar cell.
 *
 * Requirements: 9.14, 22.16
 */
function unavailableCoverageDate(workDate: string, error: unknown): UnavailableCoverageDate {
  if (error instanceof AttendanceServiceError) {
    return { workDate, unavailable: { reason: error.message } };
  }

  console.error(`[time-attendance] coverage projection failed for ${workDate}`, error);
  return { workDate, unavailable: { reason: PROJECTION_UNAVAILABLE_REASON } };
}

// ─── getCoverage ─────────────────────────────────────────────────────────────

/**
 * Coverage for one range: the figure the mode asks for, per date, in one
 * request.
 *
 * Six queries in projected mode and nine in live mode, whatever the roster size
 * and however long the range (Requirements 8.12, 18.11, 20.4).
 *
 * The arithmetic is entirely the domain layer's: `projectCoverage` for the
 * per-date figures, `buildCoverageIntervals` for the interval breakdown,
 * `liveCoverage` for the operational headcounts, `classifyCoverage` inside all
 * three for the status, and `deriveRibbonStates` for the seven ribbon states.
 * This function reads rows, buckets them by date, and asks. It decides nothing
 * about what "critical" means, which is why the four consumers cannot disagree.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 8.2, 8.5, 8.6, 8.8, 8.9, 8.10, 8.11, 8.12,
 * 8.13, 9.1, 9.2, 9.6, 9.14, 18.4, 18.5, 18.11, 19.4, 20.4, 21.1, 21.2
 */
export async function getCoverage(
  actor: Actor,
  q: CoverageQuery,
  context: CoverageContext,
): Promise<CoverageResponse> {
  const evaluatedAt = context.evaluatedAt ?? new Date().toISOString();
  const { range, dates } = resolveRange(q.from, q.to);

  if (q.mode === 'live' && range.from !== range.to) {
    throw coverageError('invalid_range', 'coverage: live coverage answers a single date', {
      from: range.from,
      to: range.to,
    });
  }

  const scope = await visibleProfileIds(actor);
  const { policy, thresholds } = await resolveConfig(context);
  const sources = await readCoverageSources(
    context,
    scope,
    range,
    q.mode,
    evaluatedAt,
    policy,
  );

  const namesVisible = absenceNamesVisible(
    actor,
    context.sharedAbsenceCalendarGrant === true,
  );

  return buildCoverage(actor, q, range, dates, sources, thresholds, namesVisible);
}

/**
 * The response for one read's sources.
 *
 * Separated from the reads so that the whole assembly — bucketing, the threshold
 * lookups, the projection, the intervals, the ribbon, and the name withholding —
 * is a pure function of the rows and can be tested without a database.
 */
export function buildCoverage(
  actor: Actor,
  q: CoverageQuery,
  range: DateRange,
  dates: readonly string[],
  sources: CoverageSources,
  thresholds: StaffingThresholdTable,
  namesVisible: boolean,
): CoverageResponse {
  const department = q.department ?? null;

  // The roster the figures are computed over. Restricting it is how Requirement
  // 8, criterion 8's "the same expression, restricted to that department" is
  // applied: the expression does not change, the roster does.
  const roster =
    department === null
      ? [...sources.employees]
      : sources.employees.filter((employee) => employee.department === department);

  const members = new Set(roster.map((employee) => employee.profileId));
  const byProfileId = new Map(roster.map((employee) => [employee.profileId, employee]));
  const employeeOf = (profileId: string): CoverageEmployee => {
    const employee = byProfileId.get(profileId);
    return employee === undefined
      ? unknownCoverageEmployee(profileId)
      : toCoverageEmployee(employee, actor, namesVisible);
  };

  const subjects: RecordSubjectIndex = toSubjectIndex(roster);
  const departments = department === null ? DEPARTMENT_ORDER : [department];

  const scheduled = schedulesByDate(sources, members);
  const approved = absencesByDate(
    sources.approvedAbsences,
    'approved',
    range,
    members,
    employeeOf,
  );
  const pending = absencesByDate(sources.pendingRequests, 'pending', range, members, employeeOf);
  const proposed = proposedDates(q, range);
  const proposedProfileId = q.proposedAbsence?.profileId ?? null;

  const closedLabels = new Map<string, string>();
  for (const row of sources.closedDates) {
    const date = readWorkDate(row.closed_date);
    if (date !== null) closedLabels.set(date, readText(row.label, 'Closed'));
  }

  // One date at a time, and one date's failure at a time. The `try` is what
  // makes Requirement 9, criterion 14 hold: whatever a per-date step raises, that
  // date carries the reason and the other thirty keep their figures, so a single
  // bad date cannot blank a month.
  const coverageDates = dates.map<CoverageDate>((workDate) => {
    try {
      const dayOfWeek = dayOfWeekOf(workDate);
      const perDepartment = departmentThresholds(
        departments,
        thresholds,
        dayOfWeek,
        WHOLE_DATE_TIME_SLOT,
      );
      // A department-filtered view compares its one roster against that
      // department's pair. An unfiltered view has no pair to compare against:
      // `staffing_thresholds` states a requirement per department, and summing
      // those minimums would invent an organisation-wide requirement nobody
      // configured.
      const wholeRoster = department === null ? null : (perDepartment.get(department) ?? null);

      const daySchedules = scheduled.get(workDate) ?? [];
      const approvedOnDate = approved.get(workDate) ?? [];
      const pendingOnDate = pending.get(workDate) ?? [];

      const scheduledProfileIds = distinctSorted(daySchedules.map((entry) => entry.profileId));
      const approvedProfileIds = distinctSorted(
        approvedOnDate.map((absence) => absence.employee.profileId),
      );
      const proposedProfileIds =
        proposedProfileId !== null && proposed.has(workDate) && members.has(proposedProfileId)
          ? [proposedProfileId]
          : [];

      const projection = projectCoverage({
        workDate,
        scheduledProfileIds,
        approvedAbsenceProfileIds: approvedProfileIds,
        proposedAbsenceProfileIds: proposedProfileIds,
        threshold: wholeRoster,
        roster: subjects,
        departmentThresholds: perDepartment,
      });

      // Requirement 9, criterion 6: interval availability comes from the published
      // schedules and the absences, never from clock entries. An absent employee is
      // absent once, so the two lists are a union here rather than two independent
      // subtractions — a shift cannot be vacated twice.
      const absentProfileIds = new Set([...approvedProfileIds, ...proposedProfileIds]);

      return {
        workDate,
        dayOfWeek,
        timeSlot: WHOLE_DATE_TIME_SLOT,
        closed: closedLabels.has(workDate),
        closedLabel: closedLabels.get(workDate) ?? null,
        hasPublishedSchedule: daySchedules.length > 0,
        projection,
        intervals: buildCoverageIntervals(
          daySchedules.map((entry) => entry.window),
          absentProfileIds,
          wholeRoster,
        ),
        scheduled: scheduledProfileIds.map(employeeOf),
        approvedAbsences: approvedOnDate,
        pendingRequests: pendingOnDate,
      };
    } catch (error) {
      return unavailableCoverageDate(workDate, error);
    }
  });

  const liveTimeSlot = q.mode === 'live' ? timeSlotAt(sources.evaluatedAt, sources.policy) : null;

  return {
    mode: q.mode,
    range,
    evaluatedAt: sources.evaluatedAt,
    department,
    employeeNamesVisible: namesVisible,
    thresholdsConfigured: thresholds.size > 0,
    employees: roster.map((employee) => toCoverageEmployee(employee, actor, namesVisible)),
    dates: coverageDates,
    live:
      liveTimeSlot === null
        ? []
        : liveCoverage({
            workDate: range.from,
            records: sources.records,
            roster: subjects,
            thresholds: departmentThresholds(
              departments,
              thresholds,
              dayOfWeekOf(range.from),
              liveTimeSlot,
            ),
          }),
    liveTimeSlot,
    ribbon: buildRibbon(q.mode, range, dates, coverageDates, closedLabels),
  };
}

/**
 * The seven Health_Ribbon states beginning at `range.from`.
 *
 * Empty unless the range is projected and spans at least seven dates. The ribbon
 * consumer asks for exactly seven (Requirement 18, criterion 2), and padding a
 * shorter range would report No_Schedule for dates nothing was read for — a
 * state that says something definite about a date the request never covered.
 *
 * The states come from `deriveRibbonStates`, which reads the coverage the
 * projection already produced rather than classifying anything itself. That is
 * what makes Requirement 18, criterion 10 and Property 20 structural: the ribbon
 * cell and the calendar cell for one date are the same answer, not two.
 *
 * A date carrying no figures contributes none, and `deriveRibbonStates` answers a
 * date it holds no coverage for with No_Schedule. The strip stays seven cells
 * wide and claims nothing about the date; the reason travels on the date's own
 * entry in `dates`, which is where Requirement 9, criterion 14 is served. The
 * ribbon has five states and none of them is "unavailable", so inventing one here
 * would be a domain change rather than a presentation one.
 */
function buildRibbon(
  mode: CoverageMode,
  range: DateRange,
  dates: readonly string[],
  coverageDates: readonly CoverageDate[],
  closedLabels: ReadonlyMap<string, string>,
): RibbonDate[] {
  if (mode !== 'projected' || dates.length < RIBBON_DAYS) return [];

  const computed = coverageDates.filter(isComputedCoverageDate);
  const scheduledDates = new Set(
    computed.filter((date) => date.hasPublishedSchedule).map((date) => date.workDate),
  );

  return deriveRibbonStates(
    range.from,
    new Set(closedLabels.keys()),
    scheduledDates,
    computed.map((date) => date.projection),
  );
}

// ─── getImpact ───────────────────────────────────────────────────────────────

/**
 * The coverage a pending request would cause, if approved.
 *
 * A wrapper, and deliberately nothing more: it loads the request, then calls
 * `getCoverage` with the request's own dates as the proposed absence. Because the
 * projection is the same call the Coverage_Calendar makes, the figure the preview
 * shows before a decision is the figure the calendar reads after it — which is
 * Correctness Property 21 by construction rather than by two implementations
 * happening to agree.
 *
 * Seven queries: the request, then the projected read's six.
 *
 * A request the caller may not see is refused with `not_visible` rather than
 * reported as missing, and a request that does not exist is refused identically.
 * Row level security answers an unpermitted read with no rows, so the two are
 * indistinguishable here, and a refusal that named the difference would confirm
 * the existence of a record the caller may not read.
 *
 * Requirements: 9.1, 9.2, 9.6, 21.1, 21.2, 21.15
 */
export async function getImpact(
  actor: Actor,
  requestId: string,
  context: CoverageContext,
): Promise<ImpactResponse> {
  const scope = await visibleProfileIds(actor);
  const row = await readRequest(context.client, requestId);

  if (row === null || (scope !== 'all' && !scope.includes(row.profile_id))) {
    throw coverageError('not_visible', 'coverage: that request is not available to you', {
      requestId,
    });
  }

  const from = readWorkDate(row.start_date);
  const to = readWorkDate(row.end_date);
  if (from === null || to === null || from > to) {
    throw coverageError('invalid_range', 'coverage: that request carries no usable date range', {
      requestId,
      from: String(row.start_date),
      to: String(row.end_date),
    });
  }

  const ranges: DateRange[] = [{ from, to }];
  const proposedAbsence = { profileId: row.profile_id, ranges };

  const coverage = await getCoverage(
    actor,
    { from, to, mode: 'projected', proposedAbsence },
    context,
  );

  const employee =
    coverage.employees.find((candidate) => candidate.profileId === row.profile_id) ?? null;

  return {
    request: {
      requestId: row.id,
      profileId: row.profile_id,
      employee,
      startDate: from,
      endDate: to,
      status: readText(row.status, 'pending'),
    },
    proposedAbsence,
    coverage,
  };
}

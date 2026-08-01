// src/features/time-attendance/domain/coverage.ts
// The coverage vocabulary: how a staffing count becomes a Coverage_Status, how
// a day's shift windows become a Coverage_Interval partition, the two coverage
// figures themselves — Live_Coverage from derived status, and Projected_Coverage
// from schedules and absences — and how a run of dates becomes the seven states
// the Health_Ribbon renders.
//
// This module owns the single implementation of the coverage rule
// (Requirement 19, criterion 8). No screen, route, or service decides for
// itself what "critical" means: the Live_Coverage_Panel, the Coverage_Calendar,
// the Approval_Impact_Preview, and the health ribbon all call
// `classifyCoverage`, so they cannot disagree about the same numbers.
//
// Pure: no I/O, no `Date.now()`, no reads of `process.env`. Every result is a
// function of the arguments alone.
//
// ## Live and projected are separated by type, not by discipline
//
// `liveCoverage` answers "who is at work right now" and therefore reads derived
// status, which is a conclusion about clock data. `projectCoverage` answers
// "how many are expected on this date" and reads published schedules and
// absences only (Requirement 19, criterion 4).
//
// `ProjectionInput` has no field that can hold a clock entry, a break, or a
// session: every field is a date string, a set of profile identifiers, a
// department mapping, or a threshold pair. It also declares the field names a
// caller might reach for — `sessions`, `breaks`, `records`, `derivedStatus` and
// the rest — as `never`, so passing a wider object that happens to carry actual
// work data does not compile even when it is passed through a variable rather
// than as a fresh object literal. Projected coverage cannot be perturbed by
// clock data because there is nowhere to put it, which is what makes
// Requirement 19, criterion 4 a property of the types rather than a test
// outcome.
//
// Requirements: 6.2 (the seven per-department figures), 6.4 (an unconfigured
// threshold reports required as unconfigured and status Healthy), 6.5
// (currently working headcount), 6.6 (on-break headcount), 6.7 (on-break
// excluded from working), 6.8 (missing headcount: the scheduled employees
// accounted for by none of those three), 6.9 (Critical below minimum), 6.10 (At_Minimum at the minimum), 6.11 (Warning
// above the minimum and at or below the warning threshold), 6.12 (Healthy above
// the warning threshold), 6.13 (available staffing is a headcount for a
// department and instant), 6.14 (the employees behind each headcount), 8.6
// (Projected_Coverage is scheduled minus approved absences), 8.7 (the clocked-in
// headcount is excluded from Projected_Coverage), 8.8 (per-department
// projection uses the same expression restricted to the department roster), 8.9
// (partition a date at every distinct scheduled start and end instant), 8.10
// (available and required staffing per interval), 8.11 (interval status uses
// the Requirement 6 thresholds), 18.2 (seven consecutive ribbon dates), 18.3
// (exactly one ribbon state per date), 18.4 (Closed on a date the organisation
// is not open), 18.5 (No_Schedule on an open date with no published schedule),
// 18.6 (the other three states come from the Coverage_Status), 18.10 (the same
// date reads the same on every screen), 19.4 (coverage derives from published
// schedules and approved absences only).

import type { Department, TimeSlot } from '../types';
import type { RecordSubjectIndex } from './attendance';
import type { DailyAttendanceRecord, DerivedStatus, Threshold } from './types';
import { consecutiveDates } from './work-date';

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * The four coverage outcomes of the Requirement 6 matrix.
 *
 * `at_minimum` sits between `warning` and `critical` on purpose: a department
 * exactly at its minimum has no slack left, so it is worse news than one still
 * inside its warning band.
 */
export type CoverageStatus = 'critical' | 'at_minimum' | 'warning' | 'healthy';

/**
 * How bad each status is, higher being worse. This is the one ordering the rest
 * of the module compares against — the ribbon's precedence, the inbox's
 * highest-severity collapse, and the monotonicity property all read it rather
 * than hardcoding an order of their own.
 *
 * Requirements: 6.9, 6.10, 6.11, 6.12
 */
export const COVERAGE_SEVERITY: Record<CoverageStatus, number> = {
  healthy: 0,
  warning: 1,
  at_minimum: 2,
  critical: 3,
};

/**
 * The Coverage_Status for an available headcount against a threshold pair.
 *
 * One ordered comparison, in the order Requirement 6 states its criteria:
 *
 * | condition                        | status       | criterion |
 * | -------------------------------- | ------------ | --------- |
 * | no threshold configured          | `healthy`    | 6.4       |
 * | `available < minimumStaff`       | `critical`   | 6.9       |
 * | `available === minimumStaff`     | `at_minimum` | 6.10      |
 * | `available <= warningThreshold`  | `warning`    | 6.11      |
 * | otherwise                        | `healthy`    | 6.12      |
 *
 * Because the comparisons are ordered and the cut points are fixed, this is a
 * step function of `available`: decreasing `available` can never lower the
 * severity of the answer. That holds for a `warningThreshold` below
 * `minimumStaff` too — a configuration the database permits — which simply
 * collapses the Warning band to nothing rather than inverting the order.
 *
 * A null `threshold` means the department, day of week, and time slot has no
 * `staffing_thresholds` row. That is reported as Healthy with required staffing
 * unconfigured (criterion 4), never as Critical: an unconfigured slot is a gap
 * in the configuration, not a staffing emergency.
 *
 * `available` is taken as given. Callers that compute it by subtraction floor
 * it at zero themselves, because they also display the raw shortfall.
 *
 * Requirements: 6.4, 6.9, 6.10, 6.11, 6.12, 8.11
 */
export function classifyCoverage(available: number, threshold: Threshold | null): CoverageStatus {
  if (!threshold) return 'healthy';
  if (available < threshold.minimumStaff) return 'critical';
  if (available === threshold.minimumStaff) return 'at_minimum';
  if (available <= threshold.warningThreshold) return 'warning';
  return 'healthy';
}

// ─── The bands a threshold pair describes ────────────────────────────────────
//
// `classifyCoverage` reads a pair and answers for one headcount. The threshold
// editor has the opposite problem: an administrator typing a pair needs to see
// what that pair will mean for every headcount, because `warning_threshold` is
// the top edge of the Warning band rather than a second minimum and nothing on a
// form says so. Both readings come from this module, so what the editor shows and
// what the coverage panel later assigns cannot disagree.

/** The largest headcount a threshold may state. */
export const MAX_REQUIRED_STAFF = 999;

/**
 * The slot one threshold pair applies to: a department, a day of week, and a
 * time slot.
 *
 * `dayOfWeek` is `staffing_thresholds.day_of_week`, where 0 is Sunday.
 *
 * The lookup over these three is exact. A `full_day` row is not a default for
 * `morning`, because inferring one slot's requirement from another's would invent
 * a staffing rule the organisation has not stated — so a slot is a triple and
 * never a department alone.
 */
export interface ThresholdSlot {
  department: Department;
  dayOfWeek: number;
  timeSlot: TimeSlot;
}

/**
 * A slot as one comparable string.
 *
 * The loader's lookup table, the editor's draft, and the write path's
 * duplicate check all key on this, so the three cannot disagree about when two
 * references mean the same slot.
 */
export function slotKey(slot: ThresholdSlot): string {
  return `${slot.department}:${slot.dayOfWeek}:${slot.timeSlot}`;
}

/**
 * A slot in its stored vocabulary, for a message about one.
 *
 * The raw column values rather than display labels: this is what an API refusal
 * names, and a refusal that renamed `full_day` to "Full day" would be describing
 * something the caller did not send. A screen has its own labels.
 */
export function describeSlot(slot: ThresholdSlot): string {
  return `${slot.department}, day ${slot.dayOfWeek}, ${slot.timeSlot}`;
}

/**
 * One stretch of headcounts that classify to the same status.
 *
 * `from` is inclusive. `to` is inclusive as well, and null means unbounded above
 * — the Healthy band has no top. Every band a pair produces is non-empty: an
 * empty one is omitted rather than rendered as a range nothing can fall in.
 */
export interface CoverageBand {
  status: CoverageStatus;
  from: number;
  to: number | null;
}

/**
 * The bands a threshold pair describes, worst first.
 *
 * The edges follow from `classifyCoverage` and are not a second statement of the
 * rule: Critical is every headcount below the minimum, At Minimum is the minimum
 * exactly, Warning runs from one above the minimum to the warning threshold, and
 * Healthy is everything above that.
 *
 * Two bands can be empty and are then omitted:
 *
 * - Critical, when `minimumStaff` is zero — a headcount cannot fall below none.
 * - Warning, when `warningThreshold` equals `minimumStaff` — there is no room
 *   between the minimum and the top of the band. A pair with the warning value
 *   *below* the minimum is refused before it can be stored (`rejectThreshold`),
 *   so the only way to reach an empty Warning band is to make the two equal,
 *   which is a legible choice: no warning band, straight from at-minimum to
 *   healthy.
 *
 * Requirements: 6.9, 6.10, 6.11, 6.12
 */
export function coverageBands(threshold: Threshold): CoverageBand[] {
  const { minimumStaff, warningThreshold } = threshold;
  const bands: CoverageBand[] = [];

  if (minimumStaff > 0) bands.push({ status: 'critical', from: 0, to: minimumStaff - 1 });
  bands.push({ status: 'at_minimum', from: minimumStaff, to: minimumStaff });
  if (warningThreshold > minimumStaff) {
    bands.push({ status: 'warning', from: minimumStaff + 1, to: warningThreshold });
  }
  bands.push({ status: 'healthy', from: Math.max(minimumStaff, warningThreshold) + 1, to: null });

  return bands;
}

/** Why a threshold pair cannot be stored. */
export type ThresholdRejection =
  | 'not_whole'
  | 'negative'
  | 'above_maximum'
  | 'unreachable_warning_band';

/**
 * What each rejection is, in words a form can display.
 *
 * The reason names the pair's own vocabulary rather than a column, because the
 * administrator is looking at two labelled fields and not at a table.
 */
export const THRESHOLD_REJECTION_REASON: Readonly<Record<ThresholdRejection, string>> = {
  not_whole: 'Minimum staff and warning threshold must each be a whole number of people.',
  negative: 'Minimum staff and warning threshold cannot be negative.',
  above_maximum: `Minimum staff and warning threshold cannot exceed ${MAX_REQUIRED_STAFF}.`,
  unreachable_warning_band:
    'The warning threshold is the top of the Warning band, so it cannot be below minimum staff. ' +
    'Set it to minimum staff for no Warning band, or higher to open one.',
};

/**
 * Why this pair cannot be stored, or null when it can.
 *
 * `classifyCoverage` tolerates a warning value below the minimum — it collapses
 * the Warning band and the ordered comparison still holds — so this is not a
 * correctness guard for the derivation. It is a guard against storing a rule
 * that can never fire: a pair whose Warning band is unreachable states a warning
 * level the coverage panel will never show, which is a configuration mistake
 * rather than a policy. The v1.9.5 seed migration refuses the same shape in its
 * post-condition block, so the two agree about what a coherent pair is.
 *
 * Requirements: 2.5, 6.3, 6.11
 */
export function rejectThreshold(threshold: Threshold): ThresholdRejection | null {
  const { minimumStaff, warningThreshold } = threshold;

  if (!Number.isInteger(minimumStaff) || !Number.isInteger(warningThreshold)) return 'not_whole';
  if (minimumStaff < 0 || warningThreshold < 0) return 'negative';
  if (minimumStaff > MAX_REQUIRED_STAFF || warningThreshold > MAX_REQUIRED_STAFF) {
    return 'above_maximum';
  }
  if (warningThreshold < minimumStaff) return 'unreachable_warning_band';

  return null;
}

// ─── Interval partition ──────────────────────────────────────────────────────

/**
 * One employee's shift on a date, already resolved into instants.
 *
 * Resolution happens in the caller through `domain/work-date.ts`, so an
 * overnight shift arrives with its `end` on the following calendar date and a
 * shift crossing a daylight-saving transition arrives with its true span. This
 * module never converts between a wall clock and an instant.
 */
export interface ShiftWindow {
  profileId: string;
  start: Date;
  end: Date;
}

/**
 * A stretch of a date over which the staffing figures do not change.
 *
 * `start` and `end` are ISO instants and the stretch is half-open,
 * `[start, end)`, so consecutive intervals share a boundary without
 * double-counting it.
 *
 * `availableStaff` is a headcount and always equals `profileIds.length`.
 * `requiredStaff` is null when the slot has no configured threshold, which is
 * how criterion 4's "unconfigured" is carried to the screen.
 */
export interface CoverageInterval {
  start: string;
  end: string;
  availableStaff: number;
  requiredStaff: number | null;
  status: CoverageStatus;
  profileIds: string[];
}

/** A shift window reduced to the numbers the partition works in. */
interface WindowMs {
  profileId: string;
  startMs: number;
  endMs: number;
}

/**
 * The Coverage_Interval set for one date's shift windows.
 *
 * Every distinct start and end instant becomes a boundary, the boundaries are
 * sorted, consecutive boundaries are paired, and each pair keeps the set of
 * windows spanning it (criterion 8.9). Pairs whose set is empty — the gaps
 * between blocks of activity — are dropped, so the output covers exactly the
 * union of the windows and nothing else: sorted, pairwise non-overlapping, and
 * contiguous within each block of activity.
 *
 * `absentProfileIds` are excluded from the active set but still contribute
 * their boundaries. Marking one employee absent therefore changes counts
 * without changing where the partition splits, which is what lets the
 * Approval_Impact_Preview compare a date before and after a proposed absence
 * interval for interval.
 *
 * `threshold` is the pair the whole date is compared against, and it is
 * optional: called with two arguments the intervals report required staffing as
 * unconfigured and status Healthy, exactly as an unconfigured slot does
 * (criterion 6.4). Passing it fills in `requiredStaff` and `status` per
 * interval (criteria 8.10, 8.11).
 *
 * Two windows for the same employee count once. `availableStaff` is a headcount
 * of distinct employees, not a count of shift rows (criterion 6.13), so a split
 * shift recorded as two overlapping rows cannot inflate the coverage figure.
 *
 * Windows that cover no time — `end` at or before `start` — are ignored
 * entirely, boundaries included. They can neither staff an interval nor bound
 * one, and admitting their boundaries would split a block at an instant no
 * shift actually starts or ends.
 *
 * @throws RangeError if any window carries an invalid Date.
 */
export function buildCoverageIntervals(
  shifts: readonly ShiftWindow[],
  absentProfileIds: ReadonlySet<string>,
  threshold: Threshold | null = null,
): CoverageInterval[] {
  const windows = toWindowsMs(shifts);
  if (windows.length === 0) return [];

  const boundaries = collectBoundaries(windows);
  const intervals: CoverageInterval[] = [];

  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const startMs = boundaries[i];
    const endMs = boundaries[i + 1];

    const active = new Set<string>();
    for (const window of windows) {
      // Boundaries are exactly the window edges, so nothing starts or ends
      // strictly inside a pair: spanning the pair is spanning all of it.
      if (window.startMs <= startMs && window.endMs >= endMs) {
        if (!absentProfileIds.has(window.profileId)) active.add(window.profileId);
      }
    }

    if (active.size === 0) continue;

    const profileIds = [...active].sort();
    intervals.push({
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      availableStaff: profileIds.length,
      requiredStaff: threshold ? threshold.minimumStaff : null,
      status: classifyCoverage(profileIds.length, threshold),
      profileIds,
    });
  }

  return intervals;
}

/** Windows as milliseconds, dropping those that cover no time. */
function toWindowsMs(shifts: readonly ShiftWindow[]): WindowMs[] {
  const windows: WindowMs[] = [];

  for (const shift of shifts) {
    const startMs = instantMs(shift.start, 'start');
    const endMs = instantMs(shift.end, 'end');
    if (endMs <= startMs) continue;
    windows.push({ profileId: shift.profileId, startMs, endMs });
  }

  return windows;
}

/** Every distinct window edge, ascending. */
function collectBoundaries(windows: readonly WindowMs[]): number[] {
  const boundaries = new Set<number>();
  for (const window of windows) {
    boundaries.add(window.startMs);
    boundaries.add(window.endMs);
  }
  return [...boundaries].sort((a, b) => a - b);
}

function instantMs(value: Date, field: 'start' | 'end'): number {
  const ms = value.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError(`buildCoverageIntervals: shift ${field} is not a valid Date`);
  }
  return ms;
}
// ─── Departments ─────────────────────────────────────────────────────────────

/**
 * The order department rows are returned in, matching the order the module has
 * always listed them in.
 *
 * Ordering is a display choice rather than a rule, and it lives here only so
 * that both coverage figures return their rows in the same, deterministic
 * order. A department not named here is returned after the named ones, sorted
 * by identifier, so adding a department to the union without touching this list
 * cannot silently drop it from a coverage response.
 */
export const DEPARTMENT_ORDER: readonly Department[] = [
  'sales',
  'customer_service',
  'commercial',
  'management',
];

function departmentRank(department: Department): number {
  const index = DEPARTMENT_ORDER.indexOf(department);
  return index === -1 ? DEPARTMENT_ORDER.length : index;
}

function byDepartment(a: { department: Department }, b: { department: Department }): number {
  const rank = departmentRank(a.department) - departmentRank(b.department);
  return rank !== 0 ? rank : a.department.localeCompare(b.department);
}

/**
 * The departments a coverage response carries a row for: those with somebody on
 * the roster, plus those with a configured threshold.
 *
 * Threshold-only departments are included on purpose. A department that
 * requires two people and has nobody rostered or scheduled is the most serious
 * gap the panel can report, and omitting its row would hide it.
 *
 * An employee whose `department` is null belongs to no row. There is no
 * department to count them in, and inventing one would move a headcount into a
 * department that does not employ them.
 */
function departmentsPresent(
  roster: RecordSubjectIndex,
  thresholds: ReadonlyMap<Department, Threshold | null>,
): Department[] {
  const present = new Set<Department>();
  for (const subject of roster.values()) {
    if (subject.department !== null) present.add(subject.department);
  }
  for (const department of thresholds.keys()) present.add(department);
  return [...present];
}

function thresholdOf(
  thresholds: ReadonlyMap<Department, Threshold | null>,
  department: Department,
): Threshold | null {
  return thresholds.get(department) ?? null;
}

const NO_THRESHOLDS: ReadonlyMap<Department, Threshold | null> = new Map();
const NO_ROSTER: RecordSubjectIndex = new Map();

/** Identifiers as a sorted array, so a headcount's employee list is stable. */
function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

/** Distinct identifiers, sorted: a headcount counts employees, not rows. */
function distinctSorted(ids: readonly string[]): string[] {
  return sortedIds(new Set(ids));
}

// ─── Live coverage ───────────────────────────────────────────────────────────

/**
 * Everything the Live_Coverage_Panel needs for one date.
 *
 * `records` are the day's Daily_Attendance_Records, already derived. This is
 * the only coverage input that sees any conclusion drawn from clock data, and
 * it sees it as a `derivedStatus` rather than as raw entries, so the status
 * matrix stays the single implementation of "is this employee at work"
 * (Requirement 19, criterion 8).
 *
 * Scheduled staffing counts the records carrying a scheduled start, which is
 * the only schedule fact a record exposes. The service supplies records derived
 * from published rows, because published `employee_schedules` rows are the sole
 * record of expected work (Requirement 19, criterion 1).
 *
 * `roster` is the same `RecordSubjectIndex` the record queries take, so the
 * panel and the Exception_Queue cannot disagree about which department an
 * employee belongs to. A record whose employee is absent from the roster, or
 * carries a null department, is not counted: there is no department to count it
 * in.
 *
 * `thresholds` is the pair per department for the current day of week and time
 * slot, resolved by the caller from `staffing_thresholds` (Requirement 6,
 * criterion 3). A department absent from the map is unconfigured, which reports
 * required staffing as unconfigured and status Healthy (criterion 4).
 */
export interface LiveInput {
  /** `YYYY-MM-DD`. Records for any other date are ignored. */
  workDate: string;
  records: readonly DailyAttendanceRecord[];
  roster: RecordSubjectIndex;
  thresholds?: ReadonlyMap<Department, Threshold | null>;
}

/**
 * Current operational coverage for one department on one date: the seven
 * figures Requirement 6, criterion 2 lists, and the employees behind each of
 * them (criterion 14).
 *
 * `available` is the figure `status` is classified from. It equals `working` by
 * criterion 13 — on-break employees are excluded (criterion 7) — and is named
 * separately so that the figure being compared against the threshold is
 * explicit rather than inferred at the call site.
 *
 * `missing` is criterion 8: the scheduled employees whose status is none of
 * Working, On_Break, and Approved_Time_Off. It is `missingProfileIds.length`,
 * so the figure and the employees the drawer lists behind it (criterion 14)
 * are one answer rather than two.
 *
 * The subtraction `scheduled − working − onBreak − approvedOff` is deliberately
 * not what this figure reports. Status Rule Matrix rules 1, 3, and 4 assign
 * Approved_Time_Off, On_Break, and Working without requiring a published
 * schedule, so an employee who picks up an unscheduled day is counted as
 * working while never counting as scheduled. The subtraction then falls below
 * the number of scheduled employees actually unaccounted for — to zero, once
 * floored — while a scheduled employee is genuinely absent and named in the
 * list. Counting the roster directly cannot drift that way, and it is
 * non-negative because it counts a subset of the scheduled set rather than
 * subtracting one headcount from another.
 */
export interface DepartmentCoverage {
  department: Department;
  workDate: string;
  /** `staffing_thresholds.minimum_staff`, or null when the slot is unconfigured. */
  requiredStaff: number | null;
  scheduled: number;
  working: number;
  onBreak: number;
  approvedOff: number;
  /** Scheduled employees in none of the three headcounts. Equals `missingProfileIds.length`. */
  missing: number;
  /** The headcount `status` is classified from. Equals `working`. */
  available: number;
  status: CoverageStatus;
  scheduledProfileIds: string[];
  workingProfileIds: string[];
  onBreakProfileIds: string[];
  approvedOffProfileIds: string[];
  missingProfileIds: string[];
}

/** The three status headcounts, keyed by the status that feeds them. */
type LiveHeadcount = 'working' | 'onBreak' | 'approvedOff';

/**
 * Which Derived_Status contributes to which headcount.
 *
 * A status maps to at most one headcount, which is how Requirement 6,
 * criterion 7 holds by construction: `on_break` reaches `onBreak` and nothing
 * else, so an employee on break cannot also be counted as working. Every other
 * status contributes to no headcount and is only ever counted as scheduled.
 *
 * Requirements: 6.5, 6.6, 6.7
 */
const LIVE_HEADCOUNT_BY_STATUS: Partial<Record<DerivedStatus, LiveHeadcount>> = {
  working: 'working',
  on_break: 'onBreak',
  approved_time_off: 'approvedOff',
};

/**
 * The statuses that account for a scheduled employee: Working, On_Break, and
 * Approved_Time_Off.
 *
 * The complement is Requirement 6, criterion 8's missing headcount — the
 * scheduled employees in none of the three. Derived from the headcount table's
 * own keys, so the two cannot drift: a status added to a headcount leaves the
 * missing set in the same edit.
 *
 * Exported because Team Today's coverage-warning counter selects exactly that
 * complement, and a hand-written copy of these three values would be a second
 * definition of who counts as present.
 *
 * Requirements: 6.5, 6.6, 6.7, 6.8
 */
export const ACCOUNTED_FOR_STATUSES: readonly DerivedStatus[] = Object.keys(
  LIVE_HEADCOUNT_BY_STATUS,
) as DerivedStatus[];

/** One department's employee sets while the records are being read. */
interface LiveBuckets {
  scheduled: Set<string>;
  working: Set<string>;
  onBreak: Set<string>;
  approvedOff: Set<string>;
}

function emptyBuckets(): LiveBuckets {
  return {
    scheduled: new Set<string>(),
    working: new Set<string>(),
    onBreak: new Set<string>(),
    approvedOff: new Set<string>(),
  };
}

/**
 * Live_Coverage for every department on `input.workDate`, one row each.
 *
 * Each employee is counted once. The Attendance_Service produces at most one
 * record per employee per work date (Requirement 3, criterion 1), and a second
 * record for the same employee is ignored here rather than counted again, which
 * is what keeps the four employee lists pairwise disjoint: a status maps to one
 * headcount, and an employee reaches one status.
 *
 * Records carrying another `workDate` are ignored, so handing this function a
 * range read cannot leak yesterday's clock state into today's headcount.
 *
 * Requirements: 6.2, 6.5, 6.6, 6.7, 6.8, 6.13, 6.14
 */
export function liveCoverage(input: LiveInput): DepartmentCoverage[] {
  const thresholds = input.thresholds ?? NO_THRESHOLDS;

  const buckets = new Map<Department, LiveBuckets>();
  for (const department of departmentsPresent(input.roster, thresholds)) {
    buckets.set(department, emptyBuckets());
  }

  const counted = new Set<string>();
  for (const record of input.records) {
    if (record.workDate !== input.workDate) continue;
    if (counted.has(record.profileId)) continue;

    const department = input.roster.get(record.profileId)?.department;
    if (department === undefined || department === null) continue;
    const bucket = buckets.get(department);
    if (bucket === undefined) continue;

    counted.add(record.profileId);
    if (record.scheduledStart !== null) bucket.scheduled.add(record.profileId);

    const headcount = LIVE_HEADCOUNT_BY_STATUS[record.derivedStatus];
    if (headcount !== undefined) bucket[headcount].add(record.profileId);
  }

  const rows: DepartmentCoverage[] = [];
  for (const [department, bucket] of buckets) {
    rows.push(
      toDepartmentCoverage(department, input.workDate, bucket, thresholdOf(thresholds, department)),
    );
  }

  return rows.sort(byDepartment);
}

function toDepartmentCoverage(
  department: Department,
  workDate: string,
  bucket: LiveBuckets,
  threshold: Threshold | null,
): DepartmentCoverage {
  const { scheduled, working, onBreak, approvedOff } = bucket;
  const scheduledProfileIds = sortedIds(scheduled);

  // Criterion 8: the scheduled employees accounted for by none of the three
  // headcounts. Counted once, so the figure and criterion 14's list agree.
  const missingProfileIds = scheduledProfileIds.filter(
    (id) => !working.has(id) && !onBreak.has(id) && !approvedOff.has(id),
  );

  // Criterion 13: available staffing is the working headcount, on-break
  // excluded. The same figure the status is classified from.
  const available = working.size;

  return {
    department,
    workDate,
    requiredStaff: threshold ? threshold.minimumStaff : null,
    scheduled: scheduled.size,
    working: working.size,
    onBreak: onBreak.size,
    approvedOff: approvedOff.size,
    missing: missingProfileIds.length,
    available,
    status: classifyCoverage(available, threshold),
    scheduledProfileIds,
    workingProfileIds: sortedIds(working),
    onBreakProfileIds: sortedIds(onBreak),
    approvedOffProfileIds: sortedIds(approvedOff),
    missingProfileIds,
  };
}

// ─── Projected coverage ──────────────────────────────────────────────────────

/**
 * Field names that could carry actual work into a projection.
 *
 * `ProjectionInput` declares each of these as `never`, so an object carrying
 * one cannot be passed even through a variable, where excess property checking
 * would not apply. The list is not, and cannot be, exhaustive over every name a
 * clock entry might travel under; the guarantee that matters is the positive
 * one, that no field `ProjectionInput` does declare has a type able to hold a
 * session, a break, or an entry. This list closes the one remaining gap, which
 * is a caller reaching for a wider object it already has to hand.
 *
 * Requirements: 8.7, 19.4
 */
type ClockBearingField =
  | 'sessions'
  | 'session'
  | 'clockEntries'
  | 'clockIn'
  | 'clockOut'
  | 'breaks'
  | 'records'
  | 'firstClockIn'
  | 'lastClockOut'
  | 'hasOpenSession'
  | 'workedHours'
  | 'derivedStatus';

type NoClockData = { readonly [K in ClockBearingField]?: never };

/**
 * Everything Projected_Coverage for one date is computed from.
 *
 * Published schedules and absences, and nothing else (Requirement 19,
 * criterion 4). Each of the three identifier lists is a set of employees, not a
 * set of rows: repeated identifiers are counted once, so a split shift recorded
 * as two schedule rows cannot inflate the scheduled figure.
 *
 * `threshold` is the pair the whole-roster figure is compared against. The
 * caller passes the department's pair when the view is filtered to one
 * department and null when it is not: `staffing_thresholds` states a
 * requirement per department, and summing those minimums would invent an
 * organisation-wide requirement the configuration does not contain.
 *
 * `roster` and `departmentThresholds` drive the per-department rows and are
 * optional. Omitting them yields the whole-roster figures with no department
 * breakdown, which is what the Health_Ribbon needs.
 */
export interface ProjectionInput extends NoClockData {
  /** The date being projected, `YYYY-MM-DD`. */
  workDate: string;
  /** Employees with a published schedule on `workDate`. */
  scheduledProfileIds: readonly string[];
  /** Employees with an approved absence covering `workDate`. */
  approvedAbsenceProfileIds: readonly string[];
  /**
   * Employees whose absence is being previewed and not yet approved: the
   * requested absence in an Approval_Impact_Preview (Requirement 9,
   * criterion 2). Empty for a plain projection.
   */
  proposedAbsenceProfileIds: readonly string[];
  /** The pair the whole-roster figure is compared against, or null. */
  threshold: Threshold | null;
  /** Employee to department, for the per-department projection. */
  roster?: RecordSubjectIndex;
  /** Threshold pair per department for the projected date's slot. */
  departmentThresholds?: ReadonlyMap<Department, Threshold | null>;
}

/**
 * The projection figures for one roster: the whole organisation, or one
 * department's members.
 *
 * `available` is the reported figure, floored at zero. `rawAvailable` is the
 * same arithmetic unfloored and is negative exactly when absences outnumber
 * schedules; its magnitude is the shortfall the date drawer displays, which is
 * why the unfloored value is retained rather than discarded by the floor.
 *
 * Because the three counts partition the same way the roster does, the
 * per-department `rawAvailable` figures sum to the whole-roster `rawAvailable`
 * whenever every employee carries a department. The floored `available` figures
 * sum to it as well unless some department's raw figure is negative, in which
 * case the floor has absorbed that department's excess absences — another
 * reason the raw figure is kept.
 */
export interface ProjectionFigures {
  scheduled: number;
  approvedAbsences: number;
  proposedAbsences: number;
  /** `scheduled − approvedAbsences − proposedAbsences`, floored at zero. */
  available: number;
  /** The same expression unfloored. Negative means more absences than schedules. */
  rawAvailable: number;
  /** `staffing_thresholds.minimum_staff`, or null when the slot is unconfigured. */
  requiredStaff: number | null;
  status: CoverageStatus;
  scheduledProfileIds: string[];
  approvedAbsenceProfileIds: string[];
  proposedAbsenceProfileIds: string[];
}

/** One department's projection, computed from the same expression. */
export interface DepartmentProjection extends ProjectionFigures {
  department: Department;
}

/** Projected_Coverage for one date, with its per-department breakdown. */
export interface DateCoverage extends ProjectionFigures {
  workDate: string;
  departments: DepartmentProjection[];
}

/**
 * Projected_Coverage for one date: `scheduled − approvedAbsences −
 * proposedAbsences`.
 *
 * The three lists are counted independently, which is the expression
 * Requirement 8, criterion 6 and Requirement 9, criterion 2 state. An employee
 * named in both the approved and the proposed list is therefore subtracted
 * twice. The service does not build such an input — a proposed absence is a
 * pending request, and a request is not raised for a date the employee already
 * has approved leave on — and intersecting the lists here would break the
 * decision arithmetic instead of fixing it: approving a proposed absence would
 * then move an identifier from one list to the other and leave the projection
 * unchanged, when the whole point of the figure is that each absence costs
 * exactly one.
 *
 * Absences are not restricted to scheduled employees, because criterion 6 does
 * not restrict them: an approved absence on a date the employee has no schedule
 * for still subtracts, which is what can drive `rawAvailable` below zero.
 *
 * No clock data is read, and none can be supplied. See `ProjectionInput`.
 *
 * Requirements: 8.6, 8.7, 8.8, 19.4
 */
export function projectCoverage(input: ProjectionInput): DateCoverage {
  const scheduled = distinctSorted(input.scheduledProfileIds);
  const approved = distinctSorted(input.approvedAbsenceProfileIds);
  const proposed = distinctSorted(input.proposedAbsenceProfileIds);

  const roster = input.roster ?? NO_ROSTER;
  const departmentThresholds = input.departmentThresholds ?? NO_THRESHOLDS;

  const departments = departmentsPresent(roster, departmentThresholds)
    .map<DepartmentProjection>((department) => ({
      department,
      ...projectFigures(
        inDepartment(scheduled, department, roster),
        inDepartment(approved, department, roster),
        inDepartment(proposed, department, roster),
        thresholdOf(departmentThresholds, department),
      ),
    }))
    .sort(byDepartment);

  return {
    workDate: input.workDate,
    ...projectFigures(scheduled, approved, proposed, input.threshold),
    departments,
  };
}

/**
 * The projection expression, in one place.
 *
 * Requirement 8, criterion 8 asks for the per-department figure to use the same
 * expression as the whole-organisation figure. It does: both call this, so a
 * department row and the organisation row cannot be computed differently.
 */
function projectFigures(
  scheduled: readonly string[],
  approved: readonly string[],
  proposed: readonly string[],
  threshold: Threshold | null,
): ProjectionFigures {
  const rawAvailable = scheduled.length - approved.length - proposed.length;
  const available = Math.max(0, rawAvailable);

  return {
    scheduled: scheduled.length,
    approvedAbsences: approved.length,
    proposedAbsences: proposed.length,
    available,
    rawAvailable,
    requiredStaff: threshold ? threshold.minimumStaff : null,
    status: classifyCoverage(available, threshold),
    scheduledProfileIds: [...scheduled],
    approvedAbsenceProfileIds: [...approved],
    proposedAbsenceProfileIds: [...proposed],
  };
}

/**
 * The members of `ids` mapped to `department`.
 *
 * An employee absent from the roster, or carrying a null department, belongs to
 * no department row and is counted in the whole-roster figures only. The
 * per-department figures therefore sum to the organisation figure exactly when
 * every employee carries a department — when the departments partition the
 * roster.
 */
function inDepartment(
  ids: readonly string[],
  department: Department,
  roster: RecordSubjectIndex,
): string[] {
  return ids.filter((id) => roster.get(id)?.department === department);
}

// ─── Health ribbon ───────────────────────────────────────────────────────────

/**
 * The five states a Health_Ribbon date can carry (Requirement 18, criterion 3).
 *
 * Three of them are the coverage picture collapsed for a strip that has room for
 * one indicator per date; the other two say why there is no coverage picture to
 * show. `closed` and `no_schedule` are therefore not coverage outcomes, which is
 * why they are absent from `CoverageStatus` rather than added to it.
 */
export type RibbonState = 'healthy' | 'warning' | 'critical' | 'closed' | 'no_schedule';

/**
 * How many dates the ribbon shows: seven, beginning at the start date
 * (Requirement 18, criterion 2).
 */
export const RIBBON_DAYS = 7;

/**
 * The one place a Coverage_Status becomes a ribbon state.
 *
 * Coverage has four outcomes and the ribbon has three coverage-derived states,
 * so `at_minimum` presents as Warning: a department sitting exactly on its
 * minimum has no slack, which is a warning, and it is not below its minimum,
 * which is what Critical means. Collapsing here rather than at each call site is
 * what keeps the Today_Screen, the Schedule_Screen, and the
 * Time_Off_Coverage_Screen from disagreeing about the same date
 * (criterion 10).
 *
 * The mapping loses information on purpose. `RibbonDate.coverage` carries the
 * uncollapsed figures, so a caller that needs to tell At_Minimum from Warning —
 * the date drawer, for instance — reads the status there instead of trying to
 * recover it from the state.
 *
 * Requirements: 18.6, 18.10
 */
export const RIBBON_STATE_BY_COVERAGE: Record<CoverageStatus, RibbonState> = {
  healthy: 'healthy',
  warning: 'warning',
  at_minimum: 'warning',
  critical: 'critical',
};

/** One date of the ribbon: its state, and the coverage that state was read from. */
export interface RibbonDate {
  /** `YYYY-MM-DD`. */
  workDate: string;
  state: RibbonState;
  /**
   * The Projected_Coverage the Coverage_Service produced for this date, or null
   * when the supplied coverage set does not cover it.
   *
   * Carried through rather than recomputed. It is the evidence behind `state`,
   * and it is what lets the date drawer show the figures Requirement 18,
   * criterion 8 lists without a second request.
   */
  coverage: DateCoverage | null;
}

/**
 * The seven ribbon dates beginning at `startDate`, one state each.
 *
 * Seven consecutive calendar dates are produced from `startDate` regardless of
 * what the other three arguments contain, so the strip is always seven cells
 * wide (criterion 2) and every cell carries exactly one state (criterion 3).
 * The dates are stepped through `domain/work-date.ts`, so a run crossing a
 * daylight-saving transition still advances one date at a time.
 *
 * State is decided by first match in the order Requirement 18 states its
 * criteria:
 *
 * | condition                                   | state         | criterion |
 * | ------------------------------------------- | ------------- | --------- |
 * | date is in `closedDates`                    | `closed`      | 18.4      |
 * | date is not in `scheduledDates`             | `no_schedule` | 18.5      |
 * | `coverage` carries no figures for the date  | `no_schedule` | —         |
 * | otherwise                                   | the collapsed Coverage_Status | 18.6 |
 *
 * A closed date is Closed whatever its coverage says: the organisation is not
 * open, so a shortfall against a staffing requirement is not a staffing
 * emergency. That is the precedence Property 15 fixes, and it is why the two
 * non-coverage states are tested before the coverage status is read at all.
 *
 * `coverage` is the Coverage_Service's own output, not a set of inputs to
 * classify. This function never calls `classifyCoverage` and holds no threshold,
 * so the state it assigns to a date cannot differ from the status the service
 * published for that date — which is what makes criterion 10 and Property 15's
 * agreement clause structural rather than a thing to remember. A date the
 * coverage set does not cover reports `no_schedule`: the ribbon has nothing to
 * collapse, and inventing Healthy would claim coverage nobody computed while
 * inventing Critical would raise an alarm from missing data.
 *
 * @param startDate The first date of the strip, `YYYY-MM-DD`. The caller decides
 *   what "current" means; this function never reads the clock.
 * @param closedDates Dates the organisation is not open, from
 *   `attendance_closed_dates`.
 * @param scheduledDates Dates carrying at least one published schedule row. The
 *   caller filters by schedule status, because published rows are the sole
 *   record of expected work (Requirement 19, criterion 1).
 * @param coverage Projected_Coverage per date, as produced by
 *   `projectCoverage`. Dates outside the seven are ignored; a repeated
 *   `workDate` keeps the first entry, so the result never depends on the order
 *   the service happened to return.
 *
 * @throws RangeError if `startDate` is malformed or is not a real calendar date.
 */
export function deriveRibbonStates(
  startDate: string,
  closedDates: ReadonlySet<string>,
  scheduledDates: ReadonlySet<string>,
  coverage: readonly DateCoverage[],
): RibbonDate[] {
  const coverageByDate = new Map<string, DateCoverage>();
  for (const dateCoverage of coverage) {
    if (!coverageByDate.has(dateCoverage.workDate)) {
      coverageByDate.set(dateCoverage.workDate, dateCoverage);
    }
  }

  return consecutiveDates(startDate, RIBBON_DAYS).map<RibbonDate>((workDate) => {
    const dateCoverage = coverageByDate.get(workDate) ?? null;
    return {
      workDate,
      state: ribbonState(workDate, closedDates, scheduledDates, dateCoverage),
      coverage: dateCoverage,
    };
  });
}

/**
 * The state for one date: the precedence of criteria 4, 5, and 6 as an ordered
 * comparison, in one place so the seven cells cannot be decided differently.
 */
function ribbonState(
  workDate: string,
  closedDates: ReadonlySet<string>,
  scheduledDates: ReadonlySet<string>,
  coverage: DateCoverage | null,
): RibbonState {
  if (closedDates.has(workDate)) return 'closed';
  if (!scheduledDates.has(workDate)) return 'no_schedule';
  if (coverage === null) return 'no_schedule';
  return RIBBON_STATE_BY_COVERAGE[coverage.status];
}

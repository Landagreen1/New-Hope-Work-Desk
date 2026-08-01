// src/features/time-attendance/domain/attendance.ts
// The evaluation context and the hours arithmetic every Daily_Attendance_Record
// is built from.
//
// This module owns the single implementation of the worked-hours rule, the
// break-deduction rule, the scheduled-hours rule, the late rule, and the
// early-departure rule (Requirement 19, criterion 8). Nothing else in the
// module — no route, no screen, no service — recomputes any of them.
//
// Pure: no I/O, no `Date.now()`, no reads of `process.env`. The evaluation
// instant arrives as `inputs.evaluatedAt`, so a record is a function of its
// inputs alone and evaluating the same inputs twice produces the same answer.
//
// Every conversion between an instant and a calendar date or a wall clock goes
// through `domain/work-date.ts`. There is deliberately no second conversion
// here (Requirements 19.9, 19.10).
//
// The status rule matrix and the exception rules follow the context. They read
// it and draw the conclusions: `STATUS_RULES` assigns exactly one
// `DerivedStatus`, `EXCEPTION_RULES` collects every condition that needs review.
//
// Record assembly, range derivation, the record queries, and the metric
// aggregation close the file: `deriveDailyAttendance` and `deriveRange` produce
// at most one record per employee per work date, `RECORD_PREDICATES` holds the
// thirteen saved filters and the metric scopes, and `aggregateMetrics` computes
// each Overview metric over the same query `recordQueryForMetric` hands its
// drill-down, so a metric and its rows cannot disagree.
//
// Requirements: 3.2 (derive from schedules, clock entries, breaks, absences),
// 3.4 (twelve-value status set), 3.5 (Status Rule Matrix order, first match
// wins), 3.8 (closed-session worked hours), 3.9 (open-session worked hours),
// 3.10 (paid and unpaid break classification), 3.11 (scheduled hours once per
// date), 3.12 (late minutes and the grace period), 3.13 (rule id and
// plain-language description per exception), 3.16 (recompute from source rows),
// 3.17 (earliest session only for lateness), 3.18 (overnight shift attribution),
// 12.3 (the thirteen saved filters), 12.8 (payroll-blocking classification),
// 12.20 (one row per employee and work date), 13.3 (the fourteen Overview
// metrics), 13.5 (drill-down on the query that produced the metric),
// 19.8 (one implementation of each rule).

import type { Department, ScheduleStatus, ShiftType } from '../types';
import type {
  AttendanceException,
  AttendanceInputs,
  AttendancePolicy,
  ClockSessionInput,
  DailyAttendanceRecord,
  DerivedStatus,
  ExceptionCode,
} from './types';
import { workDateOf, zonedToInstant } from './work-date';

// ─── Constants ───────────────────────────────────────────────────────────────

export const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Margin either side of a shift window within which a clock session is
 * attributed to that shift's scheduled start date: four hours, wide enough to
 * absorb an early arrival or a late clock-out and narrow enough that two
 * consecutive shifts cannot claim the same session.
 *
 * Requirements: 3.18
 */
export const SESSION_ATTRIBUTION_MARGIN_MINUTES = 240;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `HH:MM`, `HH:MM:SS`, or `HH:MM:SS.fff`, plus the `24:00` end-of-day form. */
const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** The schedule row shape `AttendanceInputs` carries, wall-clock times included. */
export type ScheduleInput = NonNullable<AttendanceInputs['schedule']>;

/**
 * A schedule row resolved into instants.
 *
 * `start` and `end` are the wall-clock `shift_start` and `shift_end` read in
 * the business timezone (Requirement 3, criterion 7). An overnight shift has
 * its `end` resolved on the following calendar date, so a shift crossing a
 * daylight-saving transition is 23 or 25 hours rather than a nominal 24.
 */
export interface ScheduleFacts {
  /** The work date the shift starts on, `YYYY-MM-DD`. */
  workDate: string;
  /** `shift_start` as stored, a wall clock in the business timezone. */
  startWallClock: string;
  /** `shift_end` as stored, a wall clock in the business timezone. */
  endWallClock: string;
  start: Date;
  end: Date;
  /** True when `shift_end <= shift_start`, so the shift ends the next day. */
  overnight: boolean;
  /** Exact scheduled span in minutes, before boundary rounding. */
  scheduledMinutes: number;
  /** Scheduled hours, rounded at the boundary. Derived once per date. */
  scheduledHours: number;
  shiftType: ShiftType;
  status: ScheduleStatus;
  /** Attribution window: `start - 4h`, inclusive. */
  windowStart: Date;
  /** Attribution window: `end + 4h`, inclusive. */
  windowEnd: Date;
}

/** One break inside a session, with the minutes it contributes. */
export interface BreakFacts {
  id: string;
  type: ClockSessionInput['breaks'][number]['type'];
  /** True when the type is outside `policy.unpaidBreakTypes`. */
  paid: boolean;
  start: Date | null;
  end: Date | null;
  /** True when the break has no recorded end. */
  open: boolean;
  /** Minutes counted for this break, floored at zero. */
  minutes: number;
  /** True when a stored duration or an elapsed span was negative. */
  negative: boolean;
  /** True when `start`, or a non-null `end`, could not be read as an instant. */
  malformed: boolean;
}

/** One clock session, with its span, its breaks, and its worked minutes. */
export interface SessionFacts {
  /** The input row, carried through for the drawer timeline. */
  session: ClockSessionInput;
  id: string;
  /** Position in the input array, used as a stable tie-break when sorting. */
  inputIndex: number;
  clockIn: Date | null;
  clockOut: Date | null;
  /** True when the session has no clock-out and its clock-in is readable. */
  open: boolean;
  /** True when `clockIn`, or a non-null `clockOut`, is not a readable instant. */
  malformed: boolean;
  /**
   * The instant the session is measured to: its clock-out when closed, the
   * evaluation instant while open (Requirements 3.8, 3.9).
   */
  measuredTo: Date | null;
  /** `measuredTo - clockIn` in minutes, sign preserved. */
  rawSpanMinutes: number;
  /** `rawSpanMinutes` floored at zero. */
  spanMinutes: number;
  /** True when the session clocked out before it clocked in. */
  negativeDuration: boolean;
  breaks: BreakFacts[];
  hasOpenBreak: boolean;
  /** Elapsed minutes of the unended break, zero when there is none. */
  openBreakMinutes: number;
  /** Longest single break on the session, in minutes. */
  longestBreakMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  /** `max(0, spanMinutes - unpaidBreakMinutes)`. Paid breaks never subtract. */
  workedMinutes: number;
}

/**
 * Every fact the status matrix, the exception rules, and the record assembly
 * read. Built once per employee per work date.
 *
 * Facts only: no status, no exception, no conclusion. A field named `isLate` or
 * `hasOverlappingSessions` reports a condition of the data, not a rule outcome.
 */
export interface EvaluationContext {
  profileId: string;
  workDate: string;
  employeeTimezone: string;
  policy: AttendancePolicy;
  evaluatedAt: Date;

  /** The work date `evaluatedAt` falls on in the employee's timezone. */
  evaluatedWorkDate: string;
  isFutureDate: boolean;
  isPastDate: boolean;

  schedule: ScheduleFacts | null;
  /** True when a schedule row was supplied but its times could not be read. */
  hasMalformedSchedule: boolean;
  scheduledHours: number;
  scheduledStartPassed: boolean;
  scheduledEndPassed: boolean;
  /** `evaluatedAt` is past `scheduledEnd + missingClockOutToleranceMinutes`. */
  missingClockOutDeadlinePassed: boolean;

  /** Sessions ordered by clock-in ascending; unreadable sessions last. */
  sessions: SessionFacts[];
  /**
   * True when at least one readable session exists. A date carrying only
   * unreadable rows reports false here and true in `hasMalformedSession`, so
   * it reads as inconsistent data rather than as an absence.
   */
  hasSessions: boolean;
  openSessions: SessionFacts[];
  hasOpenSession: boolean;
  allSessionsClosed: boolean;
  hasOpenBreakOnOpenSession: boolean;
  hasOpenBreakOnClosedSession: boolean;
  hasOverlappingSessions: boolean;
  hasNegativeDuration: boolean;
  hasNegativeBreakDuration: boolean;
  hasMalformedSession: boolean;

  firstClockIn: Date | null;
  /** Latest clock-out among closed sessions; null when none has closed. */
  lastClockOut: Date | null;

  /** Exact worked minutes across sessions, before boundary rounding. */
  workedMinutes: number;
  workedHours: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;

  /** Minutes past the scheduled start of the earliest session, floored at zero. */
  lateMinutes: number;
  /** True only when `lateMinutes` strictly exceeds the grace period. */
  isLate: boolean;
  /** Minutes the last clock-out precedes the scheduled end, floored at zero. */
  earlyDepartureMinutes: number;
  /** True only when `earlyDepartureMinutes` strictly exceeds the tolerance. */
  isEarlyDeparture: boolean;

  absence: AttendanceInputs['approvedAbsence'];
  hasApprovedAbsence: boolean;
  unscheduledWorkApproved: boolean;
  reviewedAt: string | null;
}

/** A shift window a clock session can be attributed to. */
export interface ShiftAttributionWindow {
  /** The scheduled start date the session is attributed to. */
  workDate: string;
  shiftStart: Date;
  shiftEnd: Date;
  windowStart: Date;
  windowEnd: Date;
}

// ─── Rounding ────────────────────────────────────────────────────────────────

/**
 * Two-decimal rounding, applied at the boundary only.
 *
 * Sums are accumulated at full precision and rounded once, when a figure
 * leaves the arithmetic. Rounding per session and then summing would drift.
 */
export function roundToTwoDecimals(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 100) / 100;
  // Avoid -0 reaching JSON, where it serialises as `-0`.
  return rounded === 0 ? 0 : rounded;
}

// ─── Policy and input validation ─────────────────────────────────────────────

const POLICY_MINUTE_FIELDS = [
  'gracePeriodMinutes',
  'earlyDepartureToleranceMinutes',
  'missingClockOutToleranceMinutes',
  'breakOverrunMinutes',
] as const satisfies readonly (keyof AttendancePolicy)[];

/**
 * A malformed policy is a deployment fault, not a data fault, so it throws.
 * Every other failure this module can meet — an unreadable instant, a
 * clock-out before its clock-in, a negative stored break duration — is
 * classified rather than thrown, because one bad row must not blank a screen.
 */
function assertValidPolicy(policy: AttendancePolicy): void {
  if (policy === null || typeof policy !== 'object') {
    throw new TypeError('attendance: policy is required');
  }
  if (typeof policy.businessTimezone !== 'string' || policy.businessTimezone.trim() === '') {
    throw new RangeError('attendance: policy.businessTimezone must be a timezone identifier');
  }
  for (const field of POLICY_MINUTE_FIELDS) {
    const value = policy[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`attendance: policy.${field} must be a non-negative number`);
    }
  }
  if (!Array.isArray(policy.unpaidBreakTypes)) {
    throw new TypeError('attendance: policy.unpaidBreakTypes must be an array');
  }
}

/**
 * `workDate` and `evaluatedAt` are constructed by the caller rather than read
 * from a row, so a bad value in either is programmer error and throws.
 */
function assertWorkDate(workDate: string): void {
  if (typeof workDate !== 'string' || !isCalendarDate(workDate)) {
    throw new RangeError(`attendance: workDate must be a calendar date, received "${workDate}"`);
  }
}

function parseEvaluatedAt(evaluatedAt: string): Date {
  const instant = parseInstant(evaluatedAt);
  if (instant === null) {
    throw new RangeError(`attendance: evaluatedAt must be an instant, received "${evaluatedAt}"`);
  }
  return instant;
}

// ─── Instants, dates, and wall clocks ────────────────────────────────────────

/** An instant, or null when the value is absent or unreadable. */
function parseInstant(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? new Date(epochMs) : null;
}

function isCalendarDate(date: string): boolean {
  const match = DATE_PATTERN.exec(date);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * The calendar date after `date`.
 *
 * Calendar arithmetic on a date string, not a timezone conversion: the result
 * is the date an overnight shift ends on, which is then resolved to an instant
 * by `zonedToInstant` in the business timezone.
 */
function nextCalendarDate(date: string): string {
  const match = DATE_PATTERN.exec(date);
  if (!match) return date;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(utc + DAY_MS).toISOString().slice(0, 10);
}

/**
 * Seconds past midnight for a wall-clock time, or null when the value cannot
 * be read as a time of day.
 *
 * Used only to order `shift_end` against `shift_start`, which is how an
 * overnight shift is detected (Requirement 3, criterion 18). Ordering the two
 * resolved instants instead would misread a shift that starts inside a
 * spring-forward gap, where two distinct wall clocks resolve to the same
 * instant.
 */
function wallClockSeconds(time: string): number | null {
  if (typeof time !== 'string') return null;
  const match = TIME_PATTERN.exec(time);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 24 || minute > 59 || second > 59) return null;
  if (hour === 24 && (minute !== 0 || second !== 0)) return null;

  return hour * 3600 + minute * 60 + second;
}

function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MINUTE_MS;
}

function atLeastZero(value: number): number {
  return value > 0 ? value : 0;
}

// ─── Schedule resolution ─────────────────────────────────────────────────────

/**
 * Resolve a schedule row for one work date into instants and scheduled hours.
 *
 * Returns null when no row exists, and also when the row's times cannot be
 * read — an unreadable schedule is a data fault, so it is reported through
 * `EvaluationContext.hasMalformedSchedule` rather than thrown.
 *
 * `shift_end <= shift_start` means the shift ends the next day, so `end` is
 * resolved on the following calendar date. `shift_end` equal to `shift_start`
 * lands in that same branch and describes a 24-hour shift, which is the
 * documented consequence of the rule rather than a special case.
 *
 * Scheduled hours are derived here, once, from the schedule row alone. Nothing
 * downstream multiplies them by a session count (Requirement 3, criterion 11).
 *
 * @throws RangeError if `policy.businessTimezone` is not a known timezone.
 */
export function resolveScheduleFacts(
  workDate: string,
  schedule: ScheduleInput | null,
  policy: AttendancePolicy,
): ScheduleFacts | null {
  if (!schedule) return null;

  const startSeconds = wallClockSeconds(schedule.start);
  const endSeconds = wallClockSeconds(schedule.end);
  if (startSeconds === null || endSeconds === null) return null;

  const overnight = endSeconds <= startSeconds;
  const endDate = overnight ? nextCalendarDate(workDate) : workDate;

  let start: Date;
  let end: Date;
  try {
    start = zonedToInstant(workDate, schedule.start, policy.businessTimezone);
    end = zonedToInstant(endDate, schedule.end, policy.businessTimezone);
  } catch (error) {
    // An unknown timezone is a deployment fault and propagates. A time or date
    // string this module already screened is a data fault, so it resolves to
    // "no usable schedule" instead.
    if (isUnknownTimeZone(policy.businessTimezone)) throw error;
    return null;
  }

  const scheduledMinutes = atLeastZero(minutesBetween(start, end));
  const marginMs = SESSION_ATTRIBUTION_MARGIN_MINUTES * MINUTE_MS;

  return {
    workDate,
    startWallClock: schedule.start,
    endWallClock: schedule.end,
    start,
    end,
    overnight,
    scheduledMinutes,
    scheduledHours: roundToTwoDecimals(scheduledMinutes / 60),
    shiftType: schedule.shiftType,
    status: schedule.status,
    windowStart: new Date(start.getTime() - marginMs),
    windowEnd: new Date(end.getTime() + marginMs),
  };
}

/** A fixed instant, used only to ask whether a zone identifier is usable. */
const TIME_ZONE_PROBE = new Date(0);

/**
 * Distinguish "this timezone does not exist" from "this date or time string is
 * unusable". Both arrive as a `RangeError`, and only the first is a deployment
 * fault worth throwing for.
 *
 * Probed through `workDateOf` rather than through `Intl` directly, so
 * `domain/work-date.ts` stays the only module in the feature that touches zone
 * data (Requirements 19.9, 19.10). The probe instant is fixed, so the answer is
 * a function of the argument alone.
 */
function isUnknownTimeZone(timeZone: string): boolean {
  try {
    workDateOf(TIME_ZONE_PROBE, timeZone);
    return false;
  } catch {
    return true;
  }
}

// ─── Session attribution ─────────────────────────────────────────────────────

/**
 * Attribution windows for a set of schedule rows, one per resolvable row.
 *
 * The server layer builds these from the schedules it has already fetched for
 * the range, then buckets clock sessions with `attributeSessionWorkDate`. An
 * overnight shift therefore claims its own sessions, including those whose
 * clock-in falls on the following calendar date (Requirement 3, criterion 18).
 */
export function shiftAttributionWindows(
  schedules: readonly { workDate: string; schedule: ScheduleInput }[],
  policy: AttendancePolicy,
): ShiftAttributionWindow[] {
  assertValidPolicy(policy);

  const windows: ShiftAttributionWindow[] = [];
  for (const row of schedules) {
    const facts = resolveScheduleFacts(row.workDate, row.schedule, policy);
    if (!facts) continue;
    windows.push({
      workDate: facts.workDate,
      shiftStart: facts.start,
      shiftEnd: facts.end,
      windowStart: facts.windowStart,
      windowEnd: facts.windowEnd,
    });
  }
  return windows;
}

/**
 * The work date a clock session belongs to.
 *
 * A session whose clock-in falls inside a shift's window is attributed to that
 * shift's scheduled start date; a session outside every window is attributed
 * by the calendar date of its clock-in in the employee's timezone
 * (Requirements 3.6, 3.18).
 *
 * When windows overlap, one containing the clock-in within the shift itself
 * wins over one that only contains it within the margin; ties are settled by
 * proximity to the shift start and then by the earlier scheduled date, so the
 * answer never depends on the order the windows arrive in.
 *
 * @throws RangeError if `employeeTimezone` is not a known timezone.
 */
export function attributeSessionWorkDate(
  clockIn: Date,
  employeeTimezone: string,
  windows: readonly ShiftAttributionWindow[],
): string {
  const at = clockIn.getTime();
  const candidates = windows.filter(
    (w) => at >= w.windowStart.getTime() && at <= w.windowEnd.getTime(),
  );
  if (candidates.length === 0) return workDateOf(clockIn, employeeTimezone);

  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (compareAttributionCandidates(candidate, best, at) < 0) best = candidate;
  }
  return best.workDate;
}

function compareAttributionCandidates(
  a: ShiftAttributionWindow,
  b: ShiftAttributionWindow,
  at: number,
): number {
  const insideA = at >= a.shiftStart.getTime() && at <= a.shiftEnd.getTime();
  const insideB = at >= b.shiftStart.getTime() && at <= b.shiftEnd.getTime();
  if (insideA !== insideB) return insideA ? -1 : 1;

  const distanceA = Math.abs(at - a.shiftStart.getTime());
  const distanceB = Math.abs(at - b.shiftStart.getTime());
  if (distanceA !== distanceB) return distanceA - distanceB;

  return a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : 0;
}

// ─── Break facts ─────────────────────────────────────────────────────────────

/**
 * Minutes a break contributes, and whether it is paid.
 *
 * A break of a type listed in `policy.unpaidBreakTypes` is unpaid; every other
 * type is paid (Requirement 3, criterion 10). Paid minutes are reported and
 * never subtracted from worked hours.
 *
 * The stored `duration_minutes` is preferred for an ended break, because that
 * is the figure the clock-out path persisted. When it is absent, the elapsed
 * span is used instead. An unended break is measured to `measuredTo`, which is
 * the evaluation instant on an open session and the clock-out on a closed one:
 * Requirement 3, criterion 9 ties evaluation-instant measurement to sessions
 * that have no clock-out, so a closed session's hours cannot drift with the
 * passage of time. An unended break on a closed session is still reported
 * through `hasOpenBreakOnClosedSession`.
 */
function buildBreakFacts(
  raw: ClockSessionInput['breaks'][number],
  policy: AttendancePolicy,
  measuredTo: Date | null,
): BreakFacts {
  const paid = !policy.unpaidBreakTypes.includes(raw.type);
  const start = parseInstant(raw.start);
  const end = parseInstant(raw.end);
  const open = raw.end === null || raw.end === undefined;
  const malformed = start === null || (!open && end === null);

  let minutes = 0;
  let negative = false;

  if (!malformed && start !== null) {
    const storedDuration = raw.durationMinutes;
    const hasStoredDuration =
      !open && typeof storedDuration === 'number' && Number.isFinite(storedDuration);

    if (hasStoredDuration) {
      negative = storedDuration < 0;
      minutes = atLeastZero(storedDuration);
    } else {
      const until = open ? measuredTo : end;
      if (until !== null) {
        const elapsed = minutesBetween(start, until);
        negative = elapsed < 0;
        minutes = atLeastZero(elapsed);
      }
    }
  }

  return {
    id: raw.id,
    type: raw.type,
    paid,
    start,
    end,
    open,
    minutes,
    negative,
    malformed,
  };
}

// ─── Session facts ───────────────────────────────────────────────────────────

/**
 * One session's span, breaks, and worked minutes.
 *
 * Span is `clockOut - clockIn` for a closed session and `evaluatedAt - clockIn`
 * for an open one, floored at zero (Requirements 3.8, 3.9). Worked minutes are
 * the span less that session's unpaid break minutes, floored at zero. A
 * session that clocked out before it clocked in contributes zero and is
 * flagged through `negativeDuration`.
 */
function buildSessionFacts(
  session: ClockSessionInput,
  inputIndex: number,
  policy: AttendancePolicy,
  evaluatedAt: Date,
): SessionFacts {
  const clockIn = parseInstant(session.clockIn);
  const clockOut = parseInstant(session.clockOut);
  const closed = session.clockOut !== null && session.clockOut !== undefined;
  const malformed = clockIn === null || (closed && clockOut === null);
  const open = !malformed && !closed;
  const measuredTo = malformed ? null : closed ? clockOut : evaluatedAt;

  const rawSpanMinutes =
    clockIn !== null && measuredTo !== null ? minutesBetween(clockIn, measuredTo) : 0;
  const spanMinutes = atLeastZero(rawSpanMinutes);

  const breaks = (session.breaks ?? []).map((raw) => buildBreakFacts(raw, policy, measuredTo));

  let paidBreakMinutes = 0;
  let unpaidBreakMinutes = 0;
  let openBreakMinutes = 0;
  let longestBreakMinutes = 0;
  let hasOpenBreak = false;

  for (const item of breaks) {
    if (item.paid) paidBreakMinutes += item.minutes;
    else unpaidBreakMinutes += item.minutes;
    if (item.minutes > longestBreakMinutes) longestBreakMinutes = item.minutes;
    if (item.open) {
      hasOpenBreak = true;
      openBreakMinutes += item.minutes;
    }
  }

  return {
    session,
    id: session.id,
    inputIndex,
    clockIn,
    clockOut,
    open,
    malformed,
    measuredTo,
    rawSpanMinutes,
    spanMinutes,
    negativeDuration: rawSpanMinutes < 0,
    breaks,
    hasOpenBreak,
    openBreakMinutes,
    longestBreakMinutes,
    paidBreakMinutes,
    unpaidBreakMinutes,
    workedMinutes: atLeastZero(spanMinutes - unpaidBreakMinutes),
  };
}

/** Clock-in ascending, unreadable sessions last, input order as the tie-break. */
function compareSessions(a: SessionFacts, b: SessionFacts): number {
  if (a.clockIn === null || b.clockIn === null) {
    if (a.clockIn === b.clockIn) return a.inputIndex - b.inputIndex;
    return a.clockIn === null ? 1 : -1;
  }
  const delta = a.clockIn.getTime() - b.clockIn.getTime();
  return delta !== 0 ? delta : a.inputIndex - b.inputIndex;
}

/**
 * True when two readable sessions share time.
 *
 * A session is treated as running to its clock-out, or to the evaluation
 * instant while open, so two open sessions always overlap. A clock-in exactly
 * at the previous clock-out is contiguous, not overlapping.
 */
function detectOverlap(ordered: readonly SessionFacts[]): boolean {
  let previousEndMs: number | null = null;

  for (const session of ordered) {
    if (session.malformed || session.clockIn === null || session.measuredTo === null) continue;
    const startMs = session.clockIn.getTime();
    const endMs = Math.max(startMs, session.measuredTo.getTime());
    if (previousEndMs !== null && startMs < previousEndMs) return true;
    previousEndMs = previousEndMs === null ? endMs : Math.max(previousEndMs, endMs);
  }

  return false;
}

// ─── Evaluation context ──────────────────────────────────────────────────────

/**
 * Build the facts for one employee on one work date.
 *
 * Everything the status matrix and the exception rules need is resolved here,
 * once: the scheduled instants, each session's span and break split, the
 * totals, the lateness and early-departure figures, and the flags that mark
 * internally inconsistent data.
 *
 * Hours arithmetic, in one place:
 *
 * - Session span: clock-out, or the evaluation instant while open, minus
 *   clock-in, floored at zero.
 * - Unpaid break minutes: summed per session from breaks whose type is in
 *   `policy.unpaidBreakTypes`, and subtracted from that session's span.
 * - Paid break minutes: the complement, reported and never subtracted.
 * - Worked hours: the sum over sessions of `max(0, span - unpaid)`, rounded
 *   once at the boundary.
 * - Scheduled hours: from the schedule row alone, independent of how many
 *   sessions the date carries.
 * - Late minutes: the earliest session's clock-in minus the scheduled start,
 *   floored at zero. Late only when that strictly exceeds the grace period, so
 *   exactly five minutes is not late and six minutes is.
 * - Early departure minutes: the scheduled end minus the last clock-out, once
 *   every session has closed, floored at zero, and only an excursion beyond
 *   the configured tolerance counts.
 *
 * @throws TypeError or RangeError for a malformed policy, a malformed
 *   `workDate` or `evaluatedAt`, an unknown `employeeTimezone`, or an unknown
 *   `policy.businessTimezone` on a date that carries a schedule row. Never for
 *   the contents of a clock, break, or schedule row.
 */
export function buildEvaluationContext(inputs: AttendanceInputs): EvaluationContext {
  const { policy } = inputs;
  assertValidPolicy(policy);
  assertWorkDate(inputs.workDate);

  const evaluatedAt = parseEvaluatedAt(inputs.evaluatedAt);
  // Throws for an unknown employee timezone, which is a deployment fault.
  const evaluatedWorkDate = workDateOf(evaluatedAt, inputs.employeeTimezone);

  const schedule = resolveScheduleFacts(inputs.workDate, inputs.schedule ?? null, policy);
  const hasMalformedSchedule = Boolean(inputs.schedule) && schedule === null;

  const sessions = (inputs.sessions ?? [])
    .map((session, index) => buildSessionFacts(session, index, policy, evaluatedAt))
    .sort(compareSessions);

  const readable = sessions.filter((s) => !s.malformed);
  const openSessions = readable.filter((s) => s.open);

  let workedMinutes = 0;
  let paidBreakMinutes = 0;
  let unpaidBreakMinutes = 0;
  let firstClockIn: Date | null = null;
  let lastClockOut: Date | null = null;
  let hasNegativeDuration = false;
  let hasNegativeBreakDuration = false;
  let hasOpenBreakOnOpenSession = false;
  let hasOpenBreakOnClosedSession = false;

  for (const session of readable) {
    workedMinutes += session.workedMinutes;
    paidBreakMinutes += session.paidBreakMinutes;
    unpaidBreakMinutes += session.unpaidBreakMinutes;

    if (session.negativeDuration) hasNegativeDuration = true;
    if (session.breaks.some((b) => b.negative)) hasNegativeBreakDuration = true;
    if (session.hasOpenBreak) {
      if (session.open) hasOpenBreakOnOpenSession = true;
      else hasOpenBreakOnClosedSession = true;
    }

    if (session.clockIn !== null && (firstClockIn === null || session.clockIn < firstClockIn)) {
      firstClockIn = session.clockIn;
    }
    if (session.clockOut !== null && (lastClockOut === null || session.clockOut > lastClockOut)) {
      lastClockOut = session.clockOut;
    }
  }

  const allSessionsClosed = readable.length > 0 && openSessions.length === 0;

  // Late minutes come from the earliest session only, so a second session on
  // the same date cannot change them (Requirement 3, criterion 17).
  let rawLateMinutes = 0;
  if (schedule !== null && firstClockIn !== null) {
    rawLateMinutes = atLeastZero(minutesBetween(schedule.start, firstClockIn));
  }

  // Early departure is only meaningful once the employee has stopped working,
  // so an open session reports zero rather than a growing shortfall.
  let rawEarlyDepartureMinutes = 0;
  if (schedule !== null && allSessionsClosed && lastClockOut !== null) {
    rawEarlyDepartureMinutes = atLeastZero(minutesBetween(lastClockOut, schedule.end));
  }

  const evaluatedAtMs = evaluatedAt.getTime();
  const missingClockOutDeadlineMs =
    schedule === null
      ? null
      : schedule.end.getTime() + policy.missingClockOutToleranceMinutes * MINUTE_MS;

  return {
    profileId: inputs.profileId,
    workDate: inputs.workDate,
    employeeTimezone: inputs.employeeTimezone,
    policy,
    evaluatedAt,

    evaluatedWorkDate,
    isFutureDate: inputs.workDate > evaluatedWorkDate,
    isPastDate: inputs.workDate < evaluatedWorkDate,

    schedule,
    hasMalformedSchedule,
    scheduledHours: schedule?.scheduledHours ?? 0,
    scheduledStartPassed: schedule !== null && evaluatedAtMs > schedule.start.getTime(),
    scheduledEndPassed: schedule !== null && evaluatedAtMs > schedule.end.getTime(),
    missingClockOutDeadlinePassed:
      missingClockOutDeadlineMs !== null && evaluatedAtMs > missingClockOutDeadlineMs,

    sessions,
    hasSessions: readable.length > 0,
    openSessions,
    hasOpenSession: openSessions.length > 0,
    allSessionsClosed,
    hasOpenBreakOnOpenSession,
    hasOpenBreakOnClosedSession,
    hasOverlappingSessions: detectOverlap(sessions),
    hasNegativeDuration,
    hasNegativeBreakDuration,
    hasMalformedSession: sessions.length !== readable.length,

    firstClockIn,
    lastClockOut,

    workedMinutes,
    workedHours: roundToTwoDecimals(workedMinutes / 60),
    paidBreakMinutes: roundToTwoDecimals(paidBreakMinutes),
    unpaidBreakMinutes: roundToTwoDecimals(unpaidBreakMinutes),

    lateMinutes: roundToTwoDecimals(rawLateMinutes),
    isLate: rawLateMinutes > policy.gracePeriodMinutes,
    earlyDepartureMinutes: roundToTwoDecimals(rawEarlyDepartureMinutes),
    isEarlyDeparture: rawEarlyDepartureMinutes > policy.earlyDepartureToleranceMinutes,

    absence: inputs.approvedAbsence ?? null,
    hasApprovedAbsence: Boolean(inputs.approvedAbsence),
    unscheduledWorkApproved: Boolean(inputs.unscheduledWorkApproved),
    reviewedAt: inputs.reviewedAt ?? null,
  };
}
// ─── Facts the rules share ───────────────────────────────────────────────────

/**
 * The `employee_schedules.status` values that record expected work.
 *
 * Requirement 19, criterion 1 makes published rows the sole record of expected
 * work, so a draft (`scheduled`) or `cancelled` row is not a schedule as far as
 * the matrix is concerned: the date reads as unscheduled. `/api/schedules`
 * writes `published` for every shift it creates, and no code path sets
 * `completed` or `missed`, so this list is the one place to extend if a shift
 * lifecycle status is introduced later.
 *
 * Requirements: 19.1
 */
export const EXPECTED_WORK_SCHEDULE_STATUSES = [
  'published',
] as const satisfies readonly ScheduleStatus[];

/**
 * True when the date carries a published schedule, which is the phrase rules 5,
 * 6, 7, and 11 of the Status Rule Matrix are written in.
 *
 * A schedule row whose times could not be read resolves the context's
 * `schedule` to null, so it reports false here and true in
 * `hasMalformedSchedule`. That combination is inconsistent data, not an
 * unscheduled date, and `hasInconsistentData` is what keeps it out of the
 * unscheduled branch.
 */
export function hasPublishedSchedule(ctx: EvaluationContext): boolean {
  if (ctx.schedule === null) return false;
  return isExpectedWorkStatus(ctx.schedule.status);
}

/** True when a schedule row's status records expected work. */
function isExpectedWorkStatus(status: ScheduleStatus): boolean {
  const expected: readonly ScheduleStatus[] = EXPECTED_WORK_SCHEDULE_STATUSES;
  return expected.includes(status);
}

/**
 * True when the recorded rows contradict themselves.
 *
 * Rule 12 of the matrix reads "the date matches no rule above, **or** the
 * recorded data is internally inconsistent", so inconsistency has to outrank
 * every other rule while the matrix order is still evaluated first-match-wins.
 * That is achieved by making consistency a precondition of rules 1 through 11
 * rather than by reordering the matrix or by short-circuiting ahead of it: an
 * inconsistent record fails all eleven and falls through to rule 12, and the
 * statement "no rule earlier than the assigned one holds" stays true of every
 * record.
 *
 * The five conditions are the ones the derivation can detect but cannot
 * resolve: sessions sharing time, a session or break whose duration ran
 * backwards, and a clock, break, or schedule row whose instants could not be
 * read at all. None of them throws — an exception thrown inside a range
 * derivation would blank a screen because one employee has one bad row, whereas
 * `needs_review` puts that employee in front of somebody who can fix it.
 *
 * Requirements: 3.5, 3.13
 */
export function hasInconsistentData(ctx: EvaluationContext): boolean {
  return (
    ctx.hasOverlappingSessions ||
    ctx.hasNegativeDuration ||
    ctx.hasNegativeBreakDuration ||
    ctx.hasMalformedSession ||
    ctx.hasMalformedSchedule
  );
}

/** Shorthand for the precondition rules 1 through 11 share. */
function isConsistent(ctx: EvaluationContext): boolean {
  return !hasInconsistentData(ctx);
}

/**
 * The longest single break on the date, across every session.
 *
 * Per session this is already resolved in `SessionFacts.longestBreakMinutes`;
 * the break-overrun rule asks about the date, so it takes the maximum. Summing
 * would flag three short breaks as one overrun, which is not what a break
 * overrun is.
 */
export function longestBreakMinutes(ctx: EvaluationContext): number {
  let longest = 0;
  for (const session of ctx.sessions) {
    if (session.longestBreakMinutes > longest) longest = session.longestBreakMinutes;
  }
  return longest;
}

// ─── The status rule matrix ──────────────────────────────────────────────────

/**
 * One row of the Status Rule Matrix in Requirement 3.
 *
 * The matrix is data rather than a chain of branches so that it can be read
 * against the requirements table line for line, and so that the rule that
 * fired can be reported on the record.
 */
export interface StatusRule {
  /** Position in the matrix, 1-based, matching the requirements table. */
  order: number;
  /** Stable identifier, carried on the record as `statusRuleId`. */
  id: string;
  status: DerivedStatus;
  /** Plain language, shown in the drawer beside the status. */
  description: string;
  holds(ctx: EvaluationContext): boolean;
}

/**
 * Rule 12. Named, because it is both the last entry of the matrix and the
 * fallback `assignStatus` returns, which is what makes totality structural
 * rather than something a reader has to verify.
 */
const NEEDS_REVIEW_RULE: StatusRule = {
  order: 12,
  id: 'AS-12',
  status: 'needs_review',
  description:
    'The date matches no rule above, or the recorded clock, break, and schedule rows contradict each other.',
  holds: () => true,
};

/**
 * The twelve rules of the Status Rule Matrix, in the order Requirement 3 states
 * them. `assignStatus` returns the first whose `holds` is true.
 *
 * Every rule from 1 to 11 carries `isConsistent(ctx)` as its first conjunct,
 * which is rule 12's "or the recorded data is internally inconsistent" clause
 * expressed without disturbing the order. Rule 12 holds unconditionally, so
 * exactly one status is always assigned.
 *
 * One refinement to the literal table: rule 6 also requires the work date to
 * have arrived. Read literally, "the scheduled end instant has not passed"
 * holds for every future date, so tomorrow's published shift would be
 * Missing_Clock_In — a payroll-blocking exception on a shift that has not
 * started — and rule 11 (Scheduled) would be unreachable. Requiring the date to
 * have arrived is the narrowest change that keeps rule 11 meaningful, and it is
 * stated in the rule's own description.
 *
 * Requirements: 3.4, 3.5
 */
export const STATUS_RULES: readonly StatusRule[] = [
  {
    order: 1,
    id: 'AS-01',
    status: 'approved_time_off',
    description: 'An approved time-off request covers the date, and no clock session exists on the date.',
    holds: (ctx) => isConsistent(ctx) && ctx.hasApprovedAbsence && !ctx.hasSessions,
  },
  {
    order: 2,
    id: 'AS-02',
    status: 'missing_clock_out',
    description:
      'A clock session on the date has a clock-in and no clock-out, and the scheduled end plus the configured tolerance has passed.',
    holds: (ctx) => isConsistent(ctx) && ctx.hasOpenSession && ctx.missingClockOutDeadlinePassed,
  },
  {
    order: 3,
    id: 'AS-03',
    status: 'on_break',
    description: 'A clock session on the date is open and an unended break exists on that session.',
    holds: (ctx) => isConsistent(ctx) && ctx.hasOpenBreakOnOpenSession,
  },
  {
    order: 4,
    id: 'AS-04',
    status: 'working',
    description: 'A clock session on the date is open and no unended break exists on that session.',
    holds: (ctx) => isConsistent(ctx) && ctx.hasOpenSession && !ctx.hasOpenBreakOnOpenSession,
  },
  {
    order: 5,
    id: 'AS-05',
    status: 'clocked_in_unscheduled',
    description:
      'At least one clock session exists on the date and no published schedule exists for the employee on that date.',
    holds: (ctx) => isConsistent(ctx) && ctx.hasSessions && !hasPublishedSchedule(ctx),
  },
  {
    order: 6,
    id: 'AS-06',
    status: 'missing_clock_in',
    description:
      'A published schedule exists for a date that has arrived, no clock session exists on the date, no approved time off covers the date, and the scheduled end has not passed.',
    holds: (ctx) =>
      isConsistent(ctx) &&
      hasPublishedSchedule(ctx) &&
      !ctx.isFutureDate &&
      !ctx.hasSessions &&
      !ctx.hasApprovedAbsence &&
      !ctx.scheduledEndPassed,
  },
  {
    order: 7,
    id: 'AS-07',
    status: 'absent',
    description:
      'A published schedule exists for the date, no clock session exists on the date, no approved time off covers the date, and the scheduled end has passed.',
    holds: (ctx) =>
      isConsistent(ctx) &&
      hasPublishedSchedule(ctx) &&
      !ctx.hasSessions &&
      !ctx.hasApprovedAbsence &&
      ctx.scheduledEndPassed,
  },
  {
    order: 8,
    id: 'AS-08',
    status: 'left_early',
    description:
      'Every clock session on the date is closed, and the last clock-out precedes the scheduled end by more than the configured early-departure tolerance.',
    holds: (ctx) => isConsistent(ctx) && ctx.allSessionsClosed && ctx.isEarlyDeparture,
  },
  {
    order: 9,
    id: 'AS-09',
    status: 'late',
    description:
      'Every clock session on the date is closed, and the first clock-in exceeds the scheduled start by more than the grace period.',
    holds: (ctx) => isConsistent(ctx) && ctx.allSessionsClosed && ctx.isLate,
  },
  {
    order: 10,
    id: 'AS-10',
    status: 'completed',
    description:
      'Every clock session on the date is closed, the first clock-in is within the grace period, and the last clock-out is within the early-departure tolerance.',
    holds: (ctx) =>
      isConsistent(ctx) && ctx.allSessionsClosed && !ctx.isLate && !ctx.isEarlyDeparture,
  },
  {
    order: 11,
    id: 'AS-11',
    status: 'scheduled',
    description: 'A published schedule exists for a future date.',
    holds: (ctx) => isConsistent(ctx) && hasPublishedSchedule(ctx) && ctx.isFutureDate,
  },
  NEEDS_REVIEW_RULE,
];

/**
 * The twelve `DerivedStatus` values, in Status Rule Matrix order.
 *
 * Read off the matrix rather than restated, so a thirteenth status is offered by
 * every filter control and accepted by every route the moment it is added to the
 * rules (Requirement 19, criteria 1 and 2). Every consumer — the query parser's
 * accepted set, Team Today's status filter — reads this list.
 *
 * Requirements: 3.4, 19.2
 */
export const DERIVED_STATUSES: readonly DerivedStatus[] = [
  ...new Set(STATUS_RULES.map((rule) => rule.status)),
];

/**
 * The rule that assigns the status for one evaluation context: the first rule
 * in matrix order whose condition holds.
 *
 * Total by construction. Rule 12 holds unconditionally and is also the
 * fallback, so this returns a rule for every possible context and never needs a
 * non-null assertion.
 *
 * Requirements: 3.4, 3.5
 */
export function assignStatus(ctx: EvaluationContext): StatusRule {
  return STATUS_RULES.find((rule) => rule.holds(ctx)) ?? NEEDS_REVIEW_RULE;
}

// ─── The exception rules ─────────────────────────────────────────────────────

/**
 * One exception rule.
 *
 * Unlike the status matrix these are unordered and independent: every rule is
 * evaluated against every record and all matches are collected, so one record
 * can carry several exceptions while still appearing once in the queue
 * (Requirement 12, criterion 20).
 *
 * `payrollBlocking` is a predicate rather than a constant because unscheduled
 * work blocks payroll only while it is unapproved (Requirement 12, criterion 8).
 */
export interface ExceptionRule {
  /** Stable identifier, carried on the exception as `ruleId`. */
  id: string;
  code: ExceptionCode;
  /** Plain language, carried as `ruleDescription` and shown as visible text. */
  description: string;
  holds(ctx: EvaluationContext): boolean;
  payrollBlocking(ctx: EvaluationContext): boolean;
  /** Figures the drawer and the queue show beside the exception. */
  detail?(ctx: EvaluationContext): Record<string, number | string>;
}

const BLOCKS_PAYROLL = () => true;
const DOES_NOT_BLOCK_PAYROLL = () => false;

/**
 * Every condition on a Daily_Attendance_Record that requires human review.
 *
 * Exactly two of them block payroll: a missing clock-out and a missing clock-in
 * on a date carrying a published schedule. The remaining rules — including
 * unscheduled work, which is purely informational — describe conditions an
 * administrator should see without holding up pay.
 *
 * AX-01 and AX-05 split at the scheduled end, the same boundary the status
 * matrix splits Missing_Clock_In from Absent at, so a genuine absence is never
 * also reported as a missing punch and never blocks payroll.
 *
 * AX-11 and AX-12 cover rows whose instants could not be read. The
 * `ExceptionCode` vocabulary has no code for an unreadable row, so they reuse
 * the nearest one and carry the precise condition in their descriptions, which
 * is what Requirement 3, criterion 13 asks a rule to expose. Without them an
 * unreadable row would produce a `needs_review` record carrying no exception,
 * which the Exception_Queue lists records by and would therefore never show.
 *
 * Requirements: 3.13, 12.8
 */
export const EXCEPTION_RULES: readonly ExceptionRule[] = [
  {
    id: 'AX-01',
    code: 'missing_clock_in',
    description:
      'The employee was scheduled on this date and the shift is under way with no clock-in recorded.',
    holds: (ctx) =>
      hasPublishedSchedule(ctx) &&
      !ctx.isFutureDate &&
      !ctx.hasSessions &&
      !ctx.hasApprovedAbsence &&
      !ctx.scheduledEndPassed,
    payrollBlocking: BLOCKS_PAYROLL,
    detail: (ctx) => ({ scheduledHours: ctx.scheduledHours }),
  },
  {
    id: 'AX-02',
    code: 'missing_clock_out',
    description:
      'A clock session is still open after the scheduled end plus the configured tolerance, or after the work date itself has passed.',
    holds: (ctx) =>
      ctx.hasOpenSession && (ctx.missingClockOutDeadlinePassed || ctx.isPastDate),
    payrollBlocking: BLOCKS_PAYROLL,
    detail: (ctx) => ({
      openSessions: ctx.openSessions.length,
      toleranceMinutes: ctx.policy.missingClockOutToleranceMinutes,
    }),
  },
  {
    id: 'AX-03',
    code: 'late_arrival',
    description: 'The first clock-in is later than the scheduled start by more than the grace period.',
    holds: (ctx) => ctx.isLate,
    payrollBlocking: DOES_NOT_BLOCK_PAYROLL,
    detail: (ctx) => ({
      lateMinutes: ctx.lateMinutes,
      gracePeriodMinutes: ctx.policy.gracePeriodMinutes,
    }),
  },
  {
    id: 'AX-04',
    code: 'early_departure',
    description:
      'Every session is closed and the last clock-out is earlier than the scheduled end by more than the configured tolerance.',
    holds: (ctx) => ctx.isEarlyDeparture,
    payrollBlocking: DOES_NOT_BLOCK_PAYROLL,
    detail: (ctx) => ({
      earlyDepartureMinutes: ctx.earlyDepartureMinutes,
      toleranceMinutes: ctx.policy.earlyDepartureToleranceMinutes,
    }),
  },
  {
    id: 'AX-05',
    code: 'absent',
    description:
      'The employee was scheduled on this date, the shift has ended, and no clock session and no approved time off cover it.',
    holds: (ctx) =>
      hasPublishedSchedule(ctx) &&
      !ctx.hasSessions &&
      !ctx.hasApprovedAbsence &&
      ctx.scheduledEndPassed,
    payrollBlocking: DOES_NOT_BLOCK_PAYROLL,
    detail: (ctx) => ({ scheduledHours: ctx.scheduledHours }),
  },
  {
    id: 'AX-06',
    code: 'unscheduled_work',
    description:
      'The employee clocked in on a date carrying no published schedule.',
    holds: (ctx) => ctx.hasSessions && !hasPublishedSchedule(ctx),
    payrollBlocking: DOES_NOT_BLOCK_PAYROLL,
    detail: (ctx) => ({
      workedHours: ctx.workedHours,
    }),
  },
  {
    id: 'AX-07',
    code: 'break_overrun',
    description: 'A single break on this date ran longer than the configured break limit.',
    holds: (ctx) => longestBreakMinutes(ctx) > ctx.policy.breakOverrunMinutes,
    payrollBlocking: DOES_NOT_BLOCK_PAYROLL,
    detail: (ctx) => ({
      breakMinutes: roundToTwoDecimals(longestBreakMinutes(ctx)),
      limitMinutes: ctx.policy.breakOverrunMinutes,
    }),
  },
  {
    id: 'AX-08',
    code: 'open_break_at_clock_out',
    description:
      'A break was never ended on a session that has since clocked out, so its duration was measured to the clock-out.',
    holds: (ctx) => ctx.hasOpenBreakOnClosedSession,
    payrollBlocking: DOES_NOT_BLOCK_PAYROLL,
  },
  {
    id: 'AX-09',
    code: 'overlapping_sessions',
    description: 'Two clock sessions on this date share time, so worked hours cannot be trusted.',
    holds: (ctx) => ctx.hasOverlappingSessions,
    payrollBlocking: DOES_NOT_BLOCK_PAYROLL,
    detail: (ctx) => ({ sessions: ctx.sessions.length }),
  },
  {
    id: 'AX-10',
    code: 'negative_duration',
    description:
      'A recorded duration runs backwards: a clock-out before its clock-in, or a negative stored break duration.',
    holds: (ctx) => ctx.hasNegativeDuration || ctx.hasNegativeBreakDuration,
    payrollBlocking: DOES_NOT_BLOCK_PAYROLL,
  },
  {
    id: 'AX-11',
    code: 'schedule_without_clock',
    description:
      'The date carries a schedule row whose shift times cannot be read, so no clock session can be measured against it.',
    holds: (ctx) => ctx.hasMalformedSchedule,
    payrollBlocking: DOES_NOT_BLOCK_PAYROLL,
  },
  {
    id: 'AX-12',
    code: 'negative_duration',
    description:
      'A clock or break row on this date records a time that cannot be read, so its duration cannot be measured.',
    holds: (ctx) => ctx.hasMalformedSession,
    payrollBlocking: DOES_NOT_BLOCK_PAYROLL,
  },
];

/**
 * The distinct exception codes, in rule order.
 *
 * Read off the rule table for the same reason `DERIVED_STATUSES` is read off the
 * matrix: the vocabulary a filter offers and a route accepts is the vocabulary
 * the rules can produce, stated once. Shorter than `EXCEPTION_RULES` — two rules
 * share `negative_duration`, because an unreadable row and a backwards duration
 * are different conditions with the same code.
 *
 * Requirements: 3.13, 19.2
 */
export const EXCEPTION_CODES: readonly ExceptionCode[] = [
  ...new Set(EXCEPTION_RULES.map((rule) => rule.code)),
];

/**
 * Every exception that holds for one evaluation context, in rule order.
 *
 * Rules are independent, so all matches are collected: a date can be late, run
 * a break long, and end with an unended break at once, and it is still one
 * record with three exceptions rather than three records.
 *
 * When `policy.effectiveStartDate` is set and the work date precedes it, no
 * exceptions are generated. The record still exists and derives its status
 * normally, but the absence of exceptions means `payrollBlocking` is false and
 * the record does not appear in the Exception Queue's actionable filters. This
 * is the "grace period" behaviour: clock data is visible but generates no noise.
 *
 * Requirements: 3.13, 12.20
 */
export function collectExceptions(ctx: EvaluationContext): AttendanceException[] {
  // Suppress all exceptions for dates before the effective start date.
  if (
    ctx.policy.effectiveStartDate !== null &&
    ctx.workDate < ctx.policy.effectiveStartDate
  ) {
    return [];
  }

  const exceptions: AttendanceException[] = [];

  for (const rule of EXCEPTION_RULES) {
    if (!rule.holds(ctx)) continue;
    const detail = rule.detail?.(ctx);
    exceptions.push({
      code: rule.code,
      ruleId: rule.id,
      ruleDescription: rule.description,
      payrollBlocking: rule.payrollBlocking(ctx),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  return exceptions;
}

/**
 * The record-level payroll-blocking flag: the OR of the exception flags.
 *
 * Derived from the exceptions rather than recomputed from the context, so the
 * flag and the exceptions shown beside it cannot disagree.
 *
 * Requirements: 12.8
 */
export function isPayrollBlocking(exceptions: readonly AttendanceException[]): boolean {
  return exceptions.some((exception) => exception.payrollBlocking);
}

// ─── Record assembly ─────────────────────────────────────────────────────────

/**
 * Assemble the record for one already-built evaluation context: the context's
 * figures, the status the matrix assigned, and every exception that holds.
 *
 * Exposed separately from `deriveDailyAttendance` so a caller that already
 * needs the context — the day read, which shows session facts in the drawer —
 * does not build it twice.
 *
 * `statusRuleId` carries the id of the rule that assigned the status, so the
 * drawer can name the rule that fired (Requirement 3, criterion 13), and
 * `payrollBlocking` is read off the exceptions rather than recomputed, so the
 * flag and the exceptions shown beside it cannot disagree.
 *
 * `sessions` are the input rows in the context's order, clock-in ascending,
 * which is the order the drawer timeline renders (Requirement 5, criterion 11).
 *
 * Requirements: 3.3, 3.13, 12.8
 */
export function recordFromContext(ctx: EvaluationContext): DailyAttendanceRecord {
  const rule = assignStatus(ctx);
  const exceptions = collectExceptions(ctx);

  return {
    profileId: ctx.profileId,
    workDate: ctx.workDate,
    scheduledStart: ctx.schedule === null ? null : ctx.schedule.start.toISOString(),
    scheduledEnd: ctx.schedule === null ? null : ctx.schedule.end.toISOString(),
    scheduledHours: ctx.scheduledHours,
    firstClockIn: ctx.firstClockIn === null ? null : ctx.firstClockIn.toISOString(),
    lastClockOut: ctx.lastClockOut === null ? null : ctx.lastClockOut.toISOString(),
    hasOpenSession: ctx.hasOpenSession,
    workedHours: ctx.workedHours,
    paidBreakMinutes: ctx.paidBreakMinutes,
    unpaidBreakMinutes: ctx.unpaidBreakMinutes,
    lateMinutes: ctx.lateMinutes,
    earlyDepartureMinutes: ctx.earlyDepartureMinutes,
    derivedStatus: rule.status,
    statusRuleId: rule.id,
    exceptions,
    payrollBlocking: isPayrollBlocking(exceptions),
    reviewedAt: ctx.reviewedAt,
    sessions: ctx.sessions.map((session) => session.session),
  };
}

/**
 * The Daily_Attendance_Record for one employee on one work date.
 *
 * A function of its inputs alone: the evaluation instant arrives as
 * `inputs.evaluatedAt`, so evaluating the same inputs twice produces identical
 * records.
 *
 * Requirements: 3.1, 3.2, 3.3
 */
export function deriveDailyAttendance(inputs: AttendanceInputs): DailyAttendanceRecord {
  return recordFromContext(buildEvaluationContext(inputs));
}

/**
 * The row key for a record: one key per employee and work date.
 *
 * A record carrying five exceptions still has one key, which is what keeps the
 * Exception_Queue at one row per employee per date (Requirement 12, criteria 4
 * and 20). Also the `recordId` shape a `NavigationTarget` carries for an
 * `attendance_day` record.
 *
 * Requirements: 12.4, 12.20
 */
export function recordKey(profileId: string, workDate: string): string {
  return `${profileId}:${workDate}`;
}

/** `recordKey` for a record. */
export function recordRowKey(record: Pick<DailyAttendanceRecord, 'profileId' | 'workDate'>): string {
  return recordKey(record.profileId, record.workDate);
}

// ─── Range derivation ────────────────────────────────────────────────────────

/**
 * Collapse an input set to one input per employee per work date.
 *
 * Requirement 3, criterion 1 allows at most one record per employee per
 * calendar work date, and the server layer builds its inputs from set-based
 * range queries where a second schedule row, or a session attributed to a date
 * that already has one, can produce two inputs for the same key. Dropping the
 * later one would lose clock sessions and understate worked hours, and throwing
 * would blank a screen over a duplicate schedule row, so duplicates are merged:
 *
 * - Sessions: the union, keyed by session id, ordered by clock-in.
 * - Schedule: a row recording expected work wins over one that does not; then
 *   the earlier start, then the earlier end. A row whose times cannot be read
 *   loses to one that can, and is still reported through the `AX-11` exception
 *   when it is the only row.
 * - Approved absence: the request with the lower id, so the choice does not
 *   depend on which query returned first.
 * - Unscheduled-work approval: approved if any input says approved.
 * - Review: the earliest recorded review, which is the actor and timestamp
 *   Requirement 12, criterion 16 retains.
 * - Timezone, policy, and evaluation instant: taken from the first input, since
 *   one read supplies all three for the whole range.
 *
 * The result is ordered by work date then employee, so the collapse — and every
 * record set derived from it — does not depend on the order the inputs arrived
 * in.
 *
 * Requirements: 3.1, 3.2, 12.16
 */
export function collapseAttendanceInputs(inputs: readonly AttendanceInputs[]): AttendanceInputs[] {
  const byKey = new Map<string, AttendanceInputs>();

  for (const row of inputs) {
    const key = recordKey(row.profileId, row.workDate);
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined ? row : mergeAttendanceInputs(existing, row));
  }

  return [...byKey.values()].sort(compareInputs);
}

/**
 * Records for a whole range, at most one per employee per work date.
 *
 * Every read path — the day read, the Exception_Queue, the Overview metrics,
 * the trends, the exports, and the payroll inputs — derives its records here,
 * so no two screens can disagree about a status or an hours figure
 * (Requirement 3, criteria 14 and 15).
 *
 * Requirements: 3.1, 3.2, 3.16
 */
export function deriveRange(inputs: readonly AttendanceInputs[]): DailyAttendanceRecord[] {
  return collapseAttendanceInputs(inputs).map((row) => deriveDailyAttendance(row));
}

/** Work date ascending, then employee, so range output is order-independent. */
function compareInputs(a: AttendanceInputs, b: AttendanceInputs): number {
  if (a.workDate !== b.workDate) return a.workDate < b.workDate ? -1 : 1;
  return a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0;
}

function mergeAttendanceInputs(a: AttendanceInputs, b: AttendanceInputs): AttendanceInputs {
  return {
    profileId: a.profileId,
    workDate: a.workDate,
    employeeTimezone: a.employeeTimezone,
    schedule: preferSchedule(a.schedule ?? null, b.schedule ?? null),
    sessions: unionSessions(a.sessions ?? [], b.sessions ?? []),
    approvedAbsence: preferAbsence(a.approvedAbsence ?? null, b.approvedAbsence ?? null),
    unscheduledWorkApproved: Boolean(a.unscheduledWorkApproved) || Boolean(b.unscheduledWorkApproved),
    reviewedAt: earlierInstant(a.reviewedAt ?? null, b.reviewedAt ?? null),
    policy: a.policy,
    evaluatedAt: a.evaluatedAt,
  };
}

function unionSessions(
  a: readonly ClockSessionInput[],
  b: readonly ClockSessionInput[],
): ClockSessionInput[] {
  const byId = new Map<string, ClockSessionInput>();
  for (const session of [...a, ...b]) {
    if (!byId.has(session.id)) byId.set(session.id, session);
  }
  return [...byId.values()].sort(compareSessionInputs);
}

/** Clock-in ascending, unreadable clock-ins last, session id as the tie-break. */
function compareSessionInputs(a: ClockSessionInput, b: ClockSessionInput): number {
  const aInstant = parseInstant(a.clockIn);
  const bInstant = parseInstant(b.clockIn);
  if (aInstant === null || bInstant === null) {
    if ((aInstant === null) !== (bInstant === null)) return aInstant === null ? 1 : -1;
  } else if (aInstant.getTime() !== bInstant.getTime()) {
    return aInstant.getTime() - bInstant.getTime();
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function preferSchedule(
  a: ScheduleInput | null,
  b: ScheduleInput | null,
): ScheduleInput | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareSchedules(a, b) <= 0 ? a : b;
}

function compareSchedules(a: ScheduleInput, b: ScheduleInput): number {
  const aExpected = isExpectedWorkStatus(a.status);
  const bExpected = isExpectedWorkStatus(b.status);
  if (aExpected !== bExpected) return aExpected ? -1 : 1;

  const aStart = wallClockSeconds(a.start);
  const bStart = wallClockSeconds(b.start);
  if (aStart !== bStart) {
    if (aStart === null) return 1;
    if (bStart === null) return -1;
    return aStart - bStart;
  }

  const aEnd = wallClockSeconds(a.end);
  const bEnd = wallClockSeconds(b.end);
  if (aEnd !== bEnd) {
    if (aEnd === null) return 1;
    if (bEnd === null) return -1;
    return aEnd - bEnd;
  }

  if (a.shiftType !== b.shiftType) return a.shiftType < b.shiftType ? -1 : 1;
  return a.status < b.status ? -1 : a.status > b.status ? 1 : 0;
}

function preferAbsence(
  a: AttendanceInputs['approvedAbsence'],
  b: AttendanceInputs['approvedAbsence'],
): AttendanceInputs['approvedAbsence'] {
  if (a === null) return b;
  if (b === null) return a;
  return a.requestId <= b.requestId ? a : b;
}

/** The earlier of two recorded instants, ignoring an unreadable one. */
function earlierInstant(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aInstant = parseInstant(a);
  const bInstant = parseInstant(b);
  if (aInstant === null) return b;
  if (bInstant === null) return a;
  return aInstant.getTime() <= bInstant.getTime() ? a : b;
}

// ─── Record predicates: the saved filters and the metric scopes ───────────────

/**
 * The thirteen saved filters the Exception_Queue offers, in the order
 * Requirement 12, criterion 3 states them.
 */
export type SavedFilterId =
  | 'needs_attention'
  | 'payroll_blocking'
  | 'missing_punches'
  | 'missing_clock_ins'
  | 'missing_clock_outs'
  | 'late_arrivals'
  | 'early_departures'
  | 'absences'
  | 'break_issues'
  | 'unscheduled_work'
  | 'pending_manager_approval'
  | 'corrected'
  | 'all_records';

/**
 * Every named predicate a `RecordQuery` can carry: the thirteen saved filters
 * plus the scopes the Overview metrics are computed over.
 *
 * The metric scopes are named predicates rather than ad-hoc closures because a
 * metric's drill-down has to be expressible as a query. That is what makes a
 * metric and its rows the same set by construction (Requirement 13, criterion 5).
 */
export type RecordPredicateId =
  | SavedFilterId
  | 'expected_day'
  | 'scheduled_day'
  | 'worked_day'
  | 'overtime_day'
  | 'time_off_day'
  | 'not_payroll_blocking'
  | 'reviewed'
  | 'unreviewed';

/** One named predicate over a record. */
export interface RecordPredicate {
  id: RecordPredicateId;
  /** Shown when a view names its active filters (Requirements 12.3, 13.8). */
  label: string;
  description: string;
  /** True for the thirteen filters the Exception_Queue lists. */
  saved: boolean;
  holds(record: DailyAttendanceRecord): boolean;
}

function hasAnyException(
  record: DailyAttendanceRecord,
  codes: readonly ExceptionCode[],
): boolean {
  return record.exceptions.some((exception) => codes.includes(exception.code));
}

function hasCorrection(record: DailyAttendanceRecord): boolean {
  return record.sessions.some(
    (session) =>
      (session.adjustedBy !== null && session.adjustedBy !== undefined) ||
      (typeof session.adjustmentReason === 'string' && session.adjustmentReason.trim() !== ''),
  );
}

/**
 * The predicate table.
 *
 * The thirteen saved entries come first, in Requirement 12, criterion 3 order,
 * so `SAVED_FILTERS` is that list without a second ordering to keep in step.
 *
 * `scheduled_day` and `expected_day` read the record's scheduled figures, which
 * are present exactly when the read supplied a schedule row for the date. The
 * read services supply published rows only (Requirement 19, criterion 1), which
 * is the same source `hasPublishedSchedule` consults inside the rules.
 *
 * Requirements: 12.3, 13.2, 13.3
 */
export const RECORD_PREDICATES: readonly RecordPredicate[] = [
  {
    id: 'needs_attention',
    label: 'Needs attention',
    description: 'The record carries at least one exception and has not been marked reviewed.',
    saved: true,
    holds: (record) => record.exceptions.length > 0 && record.reviewedAt === null,
  },
  {
    id: 'payroll_blocking',
    label: 'Payroll blocking',
    description: 'The record carries an exception that holds payroll for this employee and date.',
    saved: true,
    holds: (record) => record.payrollBlocking,
  },
  {
    id: 'missing_punches',
    label: 'Missing punches',
    description: 'A clock-in or a clock-out is missing on this date.',
    saved: true,
    holds: (record) => hasAnyException(record, ['missing_clock_in', 'missing_clock_out']),
  },
  {
    id: 'missing_clock_ins',
    label: 'Missing clock-ins',
    description: 'The employee was scheduled and the shift is under way with no clock-in recorded.',
    saved: true,
    holds: (record) => hasAnyException(record, ['missing_clock_in']),
  },
  {
    id: 'missing_clock_outs',
    label: 'Missing clock-outs',
    description: 'A clock session is still open past the configured tolerance.',
    saved: true,
    holds: (record) => hasAnyException(record, ['missing_clock_out']),
  },
  {
    id: 'late_arrivals',
    label: 'Late arrivals',
    description: 'The first clock-in is later than the scheduled start by more than the grace period.',
    saved: true,
    holds: (record) => hasAnyException(record, ['late_arrival']),
  },
  {
    id: 'early_departures',
    label: 'Early departures',
    description:
      'The last clock-out is earlier than the scheduled end by more than the configured tolerance.',
    saved: true,
    holds: (record) => hasAnyException(record, ['early_departure']),
  },
  {
    id: 'absences',
    label: 'Absences',
    description: 'The shift ended with no clock session and no approved time off covering it.',
    saved: true,
    holds: (record) => hasAnyException(record, ['absent']),
  },
  {
    id: 'break_issues',
    label: 'Break issues',
    description: 'A break ran past the configured limit, or a break was never ended.',
    saved: true,
    holds: (record) => hasAnyException(record, ['break_overrun', 'open_break_at_clock_out']),
  },
  {
    id: 'unscheduled_work',
    label: 'Unscheduled work',
    description: 'The employee clocked in on a date carrying no published schedule.',
    saved: true,
    holds: (record) => hasAnyException(record, ['unscheduled_work']),
  },
  {
    id: 'pending_manager_approval',
    label: 'Pending manager approval',
    description:
      'Unscheduled work on this date is still unapproved. (Legacy filter — unscheduled work no longer blocks payroll.)',
    saved: true,
    holds: (record) =>
      record.exceptions.some(
        (exception) => exception.code === 'unscheduled_work' && exception.payrollBlocking,
      ),
  },
  {
    id: 'corrected',
    label: 'Corrected',
    description: 'A clock session on this date carries a recorded correction.',
    saved: true,
    holds: hasCorrection,
  },
  {
    id: 'all_records',
    label: 'All records',
    description: 'Every record in the active range and scope.',
    saved: true,
    holds: () => true,
  },
  {
    id: 'expected_day',
    label: 'Expected working day',
    description:
      'The date carries a schedule and is not covered by approved time off, so attendance was expected.',
    saved: false,
    holds: (record) => record.scheduledStart !== null && record.derivedStatus !== 'approved_time_off',
  },
  {
    id: 'scheduled_day',
    label: 'Scheduled day',
    description: 'The date carries a schedule, so it contributes scheduled hours.',
    saved: false,
    holds: (record) => record.scheduledStart !== null,
  },
  {
    id: 'worked_day',
    label: 'Worked hours recorded',
    description: 'The record contributes worked hours.',
    saved: false,
    holds: (record) => record.workedHours > 0,
  },
  {
    id: 'overtime_day',
    label: 'Worked beyond schedule',
    description: 'Worked hours exceed the scheduled hours for the date.',
    saved: false,
    holds: (record) => record.workedHours > record.scheduledHours,
  },
  {
    id: 'time_off_day',
    label: 'Approved time off',
    description: 'An approved time-off request covers the date and no clock session exists on it.',
    saved: false,
    holds: (record) => record.derivedStatus === 'approved_time_off',
  },
  {
    id: 'not_payroll_blocking',
    label: 'Not payroll blocking',
    description: 'The record carries no exception that holds payroll.',
    saved: false,
    holds: (record) => !record.payrollBlocking,
  },
  {
    id: 'reviewed',
    label: 'Reviewed',
    description: 'The record has been marked reviewed.',
    saved: false,
    holds: (record) => record.reviewedAt !== null,
  },
  {
    id: 'unreviewed',
    label: 'Not reviewed',
    description: 'The record has not been marked reviewed.',
    saved: false,
    holds: (record) => record.reviewedAt === null,
  },
];

const PREDICATE_BY_ID: ReadonlyMap<string, RecordPredicate> = new Map(
  RECORD_PREDICATES.map((predicate) => [predicate.id, predicate]),
);

/** The thirteen saved filters, in Requirement 12, criterion 3 order. */
export const SAVED_FILTERS: readonly RecordPredicate[] = RECORD_PREDICATES.filter(
  (predicate) => predicate.saved,
);

/** The thirteen saved filter ids, in Requirement 12, criterion 3 order. */
export const SAVED_FILTER_IDS: readonly SavedFilterId[] = SAVED_FILTERS.map(
  (predicate) => predicate.id as SavedFilterId,
);

/**
 * The named predicate, or undefined for an id outside the table.
 *
 * A query arriving from a route can carry any string, so an unrecognised id is
 * treated as unsatisfiable by `matchesRecordQuery` rather than ignored: a filter
 * nobody can explain must not widen a result set.
 */
export function recordPredicate(id: string): RecordPredicate | undefined {
  return PREDICATE_BY_ID.get(id);
}

export function isSavedFilterId(value: string): value is SavedFilterId {
  return PREDICATE_BY_ID.get(value)?.saved === true;
}

// ─── Record queries ──────────────────────────────────────────────────────────

export type ReviewStatusFilter = 'reviewed' | 'unreviewed';

/**
 * The employee facts a query filters on that a record does not carry.
 *
 * Only the department, today: everything else the Exception_Queue filters by
 * lives on the record. Supplied per employee by the read service, which has
 * already loaded the roster.
 */
export interface RecordSubject {
  profileId: string;
  department: Department | null;
}

/** Subjects keyed by profile id. */
export type RecordSubjectIndex = ReadonlyMap<string, RecordSubject>;

/**
 * One query over Daily_Attendance_Records: a saved filter, the free filters of
 * Requirement 12, criterion 3 and Requirement 13, criterion 2, and the named
 * predicates a metric scope adds.
 *
 * Every field is a conjunct. An array field is satisfied when the record's
 * value is one of the listed values, so an empty array is satisfied by nothing
 * — the intersection with an empty set, which is what makes `mergeRecordQuery`
 * a plain conjunction.
 *
 * `page` and `limit` travel with the query for the read service, which applies
 * the view's row cap. `matchesRecordQuery` ignores both: paging selects rows
 * from a match, it is not part of matching.
 *
 * Requirements: 12.3, 12.4, 13.2, 13.5
 */
export interface RecordQuery {
  /** Inclusive lower bound on the work date, `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive upper bound on the work date, `YYYY-MM-DD`. */
  to?: string;
  profileIds?: readonly string[];
  departments?: readonly Department[];
  statuses?: readonly DerivedStatus[];
  exceptionCodes?: readonly ExceptionCode[];
  reviewStatus?: ReviewStatusFilter;
  payrollBlocking?: boolean;
  savedFilter?: SavedFilterId;
  predicates?: readonly RecordPredicateId[];
  page?: number;
  limit?: number;
}

/**
 * True when a record satisfies every active filter in the query.
 *
 * `subject` supplies the employee's department for the department filter. When
 * the filter is active and no subject is supplied for that record, the record
 * does not match: a row is shown only when the filter can be confirmed for it.
 *
 * Requirements: 12.3, 12.4, 13.2
 */
export function matchesRecordQuery(
  record: DailyAttendanceRecord,
  query: RecordQuery = {},
  subject?: RecordSubject | null,
): boolean {
  if (query.from !== undefined && record.workDate < query.from) return false;
  if (query.to !== undefined && record.workDate > query.to) return false;

  if (query.profileIds !== undefined && !query.profileIds.includes(record.profileId)) return false;

  if (query.departments !== undefined) {
    const department =
      subject !== undefined && subject !== null && subject.profileId === record.profileId
        ? subject.department
        : null;
    if (department === null || !query.departments.includes(department)) return false;
  }

  if (query.statuses !== undefined && !query.statuses.includes(record.derivedStatus)) return false;

  if (query.exceptionCodes !== undefined && !hasAnyException(record, query.exceptionCodes)) {
    return false;
  }

  if (query.reviewStatus !== undefined) {
    const reviewed = record.reviewedAt !== null;
    if (reviewed !== (query.reviewStatus === 'reviewed')) return false;
  }

  if (query.payrollBlocking !== undefined && record.payrollBlocking !== query.payrollBlocking) {
    return false;
  }

  if (query.savedFilter !== undefined && !holdsPredicate(query.savedFilter, record)) return false;

  if (query.predicates !== undefined) {
    for (const id of query.predicates) {
      if (!holdsPredicate(id, record)) return false;
    }
  }

  return true;
}

/** An id outside the table is unsatisfiable, never a no-op. */
function holdsPredicate(id: RecordPredicateId, record: DailyAttendanceRecord): boolean {
  const predicate = PREDICATE_BY_ID.get(id);
  return predicate === undefined ? false : predicate.holds(record);
}

/**
 * The records a query matches, in the order they were given.
 *
 * Row order is the caller's — `deriveRange` already orders by work date then
 * employee — so an export and the view it came from list the same rows in the
 * same order (Requirement 15, criterion 3).
 */
export function filterRecords(
  records: readonly DailyAttendanceRecord[],
  query: RecordQuery = {},
  subjects?: RecordSubjectIndex,
): DailyAttendanceRecord[] {
  return records.filter((record) =>
    matchesRecordQuery(record, query, subjects?.get(record.profileId) ?? null),
  );
}

/**
 * The conjunction of two queries: a record matches the result exactly when it
 * matches both.
 *
 * Bounds tighten, list filters intersect, and predicate lists concatenate.
 * Where the two disagree on a single-valued filter — one asking for reviewed
 * records and the other for unreviewed — the base value stays on the field and
 * the other is added as a named predicate, so the result is the empty
 * intersection the two filters describe rather than a silent choice between
 * them.
 *
 * `page` and `limit` are the requesting view's, so the base keeps them.
 *
 * Requirements: 12.3, 13.5
 */
export function mergeRecordQuery(base?: RecordQuery, extra?: RecordQuery): RecordQuery {
  if (base === undefined) return { ...(extra ?? {}) };
  if (extra === undefined) return { ...base };

  const predicates: RecordPredicateId[] = [...(base.predicates ?? []), ...(extra.predicates ?? [])];

  let savedFilter = base.savedFilter ?? extra.savedFilter;
  if (
    base.savedFilter !== undefined &&
    extra.savedFilter !== undefined &&
    base.savedFilter !== extra.savedFilter
  ) {
    savedFilter = base.savedFilter;
    predicates.push(extra.savedFilter);
  }

  let reviewStatus = base.reviewStatus ?? extra.reviewStatus;
  if (
    base.reviewStatus !== undefined &&
    extra.reviewStatus !== undefined &&
    base.reviewStatus !== extra.reviewStatus
  ) {
    reviewStatus = base.reviewStatus;
    predicates.push(extra.reviewStatus);
  }

  let payrollBlocking = base.payrollBlocking ?? extra.payrollBlocking;
  if (
    base.payrollBlocking !== undefined &&
    extra.payrollBlocking !== undefined &&
    base.payrollBlocking !== extra.payrollBlocking
  ) {
    payrollBlocking = base.payrollBlocking;
    predicates.push(extra.payrollBlocking ? 'payroll_blocking' : 'not_payroll_blocking');
  }

  const merged: RecordQuery = {};
  assignDefined(merged, 'from', laterDate(base.from, extra.from));
  assignDefined(merged, 'to', earlierDate(base.to, extra.to));
  assignDefined(merged, 'profileIds', intersect(base.profileIds, extra.profileIds));
  assignDefined(merged, 'departments', intersect(base.departments, extra.departments));
  assignDefined(merged, 'statuses', intersect(base.statuses, extra.statuses));
  assignDefined(merged, 'exceptionCodes', intersect(base.exceptionCodes, extra.exceptionCodes));
  assignDefined(merged, 'reviewStatus', reviewStatus);
  assignDefined(merged, 'payrollBlocking', payrollBlocking);
  assignDefined(merged, 'savedFilter', savedFilter);
  assignDefined(merged, 'predicates', predicates.length === 0 ? undefined : dedupe(predicates));
  assignDefined(merged, 'page', base.page ?? extra.page);
  assignDefined(merged, 'limit', base.limit ?? extra.limit);
  return merged;
}

function assignDefined<K extends keyof RecordQuery>(
  query: RecordQuery,
  key: K,
  value: RecordQuery[K] | undefined,
): void {
  if (value !== undefined) query[key] = value;
}

function intersect<T>(
  a: readonly T[] | undefined,
  b: readonly T[] | undefined,
): readonly T[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.filter((value) => b.includes(value));
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function laterDate(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a >= b ? a : b;
}

function earlierDate(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a <= b ? a : b;
}

// ─── Overview metrics ────────────────────────────────────────────────────────

/**
 * The fourteen Overview metrics, in the order Requirement 13, criterion 3
 * states them.
 */
export type MetricKey =
  | 'attendance_rate'
  | 'scheduled_hours'
  | 'worked_hours'
  | 'approved_payable_hours'
  | 'overtime_hours'
  | 'late_arrival_count'
  | 'total_late_minutes'
  | 'early_departure_count'
  | 'absence_count'
  | 'time_off_days'
  | 'missing_clock_in_count'
  | 'missing_clock_out_count'
  | 'unscheduled_work_count'
  | 'break_exception_count';

export type MetricUnit = 'count' | 'hours' | 'minutes' | 'percent';

/**
 * One metric: the query fragment that selects the records it is computed over,
 * and the aggregate taken across them.
 *
 * The scope is a query rather than a closure so that the metric and its
 * drill-down are the same set by construction: `aggregateMetrics` computes the
 * value over `recordQueryForMetric(key, base)`, and the drill-down hands the
 * Exception_Queue that identical query (Requirement 13, criterion 5).
 */
export interface MetricDefinition {
  key: MetricKey;
  /** Position in Requirement 13, criterion 3, 1-based. */
  order: number;
  label: string;
  unit: MetricUnit;
  description: string;
  /** The query fragment narrowing the active scope to this metric's records. */
  scope: RecordQuery;
  aggregate(records: readonly DailyAttendanceRecord[]): number;
}

function sumOf(
  records: readonly DailyAttendanceRecord[],
  read: (record: DailyAttendanceRecord) => number,
): number {
  let total = 0;
  for (const record of records) total += read(record);
  return roundToTwoDecimals(total);
}

/**
 * The metric table.
 *
 * Three definitions carry a rule worth stating, because Requirement 13,
 * criterion 3 names the metric without fixing its arithmetic:
 *
 * - **Attendance rate** is the share of expected working days the employee
 *   clocked in on: days carrying a schedule and not covered by approved time
 *   off. Approved time off is neither attendance nor absence, so it is out of
 *   both the numerator and the denominator. An empty expected-day set reports
 *   zero, and the metric's `recordCount` of zero is what tells a view the figure
 *   is vacuous.
 * - **Approved payable hours** are worked hours on records carrying no
 *   payroll-blocking exception, which is the same classification Requirement 12,
 *   criterion 8 defines. Approving unscheduled work moves those hours into this
 *   figure without any second rule.
 * - **Overtime hours** are worked hours beyond the scheduled hours for the date,
 *   summed over the dates where worked exceeds scheduled. This is the
 *   attendance-side excess, deliberately not the payroll overtime figure: that
 *   one is the period-average cap `payrollInputs` preserves in `legacy_parity`
 *   mode under Requirement 2, criterion 4, and changing it is the separately
 *   approved payroll change of Requirement 2, criterion 6.
 *
 * Requirements: 13.3, 13.4, 13.5
 */
export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    key: 'attendance_rate',
    order: 1,
    label: 'Attendance rate',
    unit: 'percent',
    description:
      'Share of expected working days the employee clocked in on. Dates covered by approved time off are excluded.',
    scope: { predicates: ['expected_day'] },
    aggregate: (records) =>
      records.length === 0
        ? 0
        : roundToTwoDecimals(
            (records.filter((record) => record.firstClockIn !== null).length / records.length) * 100,
          ),
  },
  {
    key: 'scheduled_hours',
    order: 2,
    label: 'Scheduled hours',
    unit: 'hours',
    description: 'Sum of scheduled hours across the dates carrying a schedule.',
    scope: { predicates: ['scheduled_day'] },
    aggregate: (records) => sumOf(records, (record) => record.scheduledHours),
  },
  {
    key: 'worked_hours',
    order: 3,
    label: 'Worked hours',
    unit: 'hours',
    description: 'Sum of worked hours, unpaid break minutes already deducted.',
    scope: { predicates: ['worked_day'] },
    aggregate: (records) => sumOf(records, (record) => record.workedHours),
  },
  {
    key: 'approved_payable_hours',
    order: 4,
    label: 'Approved payable hours',
    unit: 'hours',
    description: 'Worked hours on records carrying no payroll-blocking exception.',
    scope: { predicates: ['worked_day', 'not_payroll_blocking'] },
    aggregate: (records) => sumOf(records, (record) => record.workedHours),
  },
  {
    key: 'overtime_hours',
    order: 5,
    label: 'Overtime hours',
    unit: 'hours',
    description:
      'Worked hours beyond the scheduled hours for the date. Not the payroll overtime figure, which applies the period cap.',
    scope: { predicates: ['overtime_day'] },
    aggregate: (records) =>
      sumOf(records, (record) => atLeastZero(record.workedHours - record.scheduledHours)),
  },
  {
    key: 'late_arrival_count',
    order: 6,
    label: 'Late arrivals',
    unit: 'count',
    description: 'Records whose first clock-in is past the scheduled start by more than the grace period.',
    scope: { savedFilter: 'late_arrivals' },
    aggregate: (records) => records.length,
  },
  {
    key: 'total_late_minutes',
    order: 7,
    label: 'Total late minutes',
    unit: 'minutes',
    description: 'Sum of late minutes across the late arrivals.',
    scope: { savedFilter: 'late_arrivals' },
    aggregate: (records) => sumOf(records, (record) => record.lateMinutes),
  },
  {
    key: 'early_departure_count',
    order: 8,
    label: 'Early departures',
    unit: 'count',
    description:
      'Records whose last clock-out precedes the scheduled end by more than the configured tolerance.',
    scope: { savedFilter: 'early_departures' },
    aggregate: (records) => records.length,
  },
  {
    key: 'absence_count',
    order: 9,
    label: 'Absences',
    unit: 'count',
    description: 'Scheduled dates that ended with no clock session and no approved time off.',
    scope: { savedFilter: 'absences' },
    aggregate: (records) => records.length,
  },
  {
    key: 'time_off_days',
    order: 10,
    label: 'Time-off days',
    unit: 'count',
    description: 'Dates covered by an approved time-off request with no clock session.',
    scope: { predicates: ['time_off_day'] },
    aggregate: (records) => records.length,
  },
  {
    key: 'missing_clock_in_count',
    order: 11,
    label: 'Missing clock-ins',
    unit: 'count',
    description: 'Scheduled dates under way with no clock-in recorded.',
    scope: { savedFilter: 'missing_clock_ins' },
    aggregate: (records) => records.length,
  },
  {
    key: 'missing_clock_out_count',
    order: 12,
    label: 'Missing clock-outs',
    unit: 'count',
    description: 'Records carrying a session still open past the configured tolerance.',
    scope: { savedFilter: 'missing_clock_outs' },
    aggregate: (records) => records.length,
  },
  {
    key: 'unscheduled_work_count',
    order: 13,
    label: 'Unscheduled work',
    unit: 'count',
    description: 'Dates with a clock session and no published schedule.',
    scope: { savedFilter: 'unscheduled_work' },
    aggregate: (records) => records.length,
  },
  {
    key: 'break_exception_count',
    order: 14,
    label: 'Break exceptions',
    unit: 'count',
    description: 'Records carrying a break overrun or a break that was never ended.',
    scope: { savedFilter: 'break_issues' },
    aggregate: (records) => records.length,
  },
];

/** The fourteen metric keys, in Requirement 13, criterion 3 order. */
export const METRIC_KEYS: readonly MetricKey[] = METRIC_DEFINITIONS.map(
  (definition) => definition.key,
);

const METRIC_BY_KEY: ReadonlyMap<string, MetricDefinition> = new Map(
  METRIC_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function isMetricKey(value: string): value is MetricKey {
  return METRIC_BY_KEY.has(value);
}

/**
 * The definition for a metric key.
 *
 * @throws RangeError for a key outside the table. A metric key reaches this
 *   function from the table itself or from a route that has validated it with
 *   `isMetricKey`, so an unknown key is a programming fault rather than
 *   attendance data.
 */
export function metricDefinition(key: MetricKey): MetricDefinition {
  const definition = METRIC_BY_KEY.get(key);
  if (definition === undefined) {
    throw new RangeError(`attendance: unknown metric "${key}"`);
  }
  return definition;
}

/**
 * The query that produced a metric, and therefore the query its drill-down
 * must use: the active query narrowed by the metric's own scope.
 *
 * `aggregateMetrics` computes the metric over exactly this query, so a metric
 * and the rows behind it cannot disagree (Requirement 13, criterion 5).
 *
 * Requirements: 13.5
 */
export function recordQueryForMetric(key: MetricKey, baseQuery?: RecordQuery): RecordQuery {
  return mergeRecordQuery(baseQuery, metricDefinition(key).scope);
}

/** One computed metric, with the rows behind it and the query that produced it. */
export interface AttendanceMetric {
  key: MetricKey;
  label: string;
  unit: MetricUnit;
  value: number;
  /** Rows the value was computed over: the size of the drill-down set. */
  recordCount: number;
  /** The query that produced the value. Hand this to the Exception_Queue. */
  query: RecordQuery;
}

/** The Overview metric set for one active query. */
export interface AttendanceMetrics {
  /** The active query the set was computed under. */
  query: RecordQuery;
  /** Records the active query matches, before any metric scope narrows it. */
  recordCount: number;
  /** All fourteen metrics, in Requirement 13, criterion 3 order. */
  metrics: readonly AttendanceMetric[];
}

/**
 * The fourteen Overview metrics over a record set.
 *
 * The active query is applied here rather than assumed of the input, so the
 * metric set always describes the query it reports, whatever set the caller
 * passed. Each metric is then computed over `recordQueryForMetric`, the same
 * query its drill-down uses.
 *
 * Requirements: 13.3, 13.4, 13.5, 13.7
 */
export function aggregateMetrics(
  records: readonly DailyAttendanceRecord[],
  baseQuery: RecordQuery = {},
  subjects?: RecordSubjectIndex,
): AttendanceMetrics {
  const scoped = filterRecords(records, baseQuery, subjects);

  const metrics = METRIC_DEFINITIONS.map((definition) => {
    const query = recordQueryForMetric(definition.key, baseQuery);
    const rows = filterRecords(records, query, subjects);
    return {
      key: definition.key,
      label: definition.label,
      unit: definition.unit,
      value: definition.aggregate(rows),
      recordCount: rows.length,
      query,
    };
  });

  return { query: { ...baseQuery }, recordCount: scoped.length, metrics };
}

/** One metric from a computed set. */
export function metricOf(metrics: AttendanceMetrics, key: MetricKey): AttendanceMetric {
  const metric = metrics.metrics.find((candidate) => candidate.key === key);
  if (metric === undefined) {
    throw new RangeError(`attendance: metric "${key}" is not in this metric set`);
  }
  return metric;
}

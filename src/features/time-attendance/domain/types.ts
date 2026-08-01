// src/features/time-attendance/domain/types.ts
// Type vocabulary for the pure attendance domain layer.
//
// This module contains types only: no I/O, no `Date.now()`, no logic. Every
// function in `domain/` speaks in these shapes, and the server layer is the only
// place that turns database rows into them.
//
// Requirements: 3.3 (exposed fields), 3.4 (twelve-value status set),
// 12.8 (payroll-blocking classification).

import type { BreakType, PTOType, ScheduleStatus, ShiftType } from '../types';

/**
 * The single attendance status assigned to a Daily_Attendance_Record.
 *
 * Exactly twelve values, matching the Status Rule Matrix in Requirement 3.
 * Rule 12 (`needs_review`) holds unconditionally, so one of these is always
 * assigned.
 *
 * Requirements: 3.4, 3.5
 */
export type DerivedStatus =
  | 'scheduled' | 'working' | 'on_break' | 'completed' | 'late' | 'absent'
  | 'approved_time_off' | 'clocked_in_unscheduled' | 'left_early'
  | 'missing_clock_in' | 'missing_clock_out' | 'needs_review';

/**
 * A condition on a Daily_Attendance_Record that requires human review.
 *
 * Exception rules are evaluated independently of the status matrix and all
 * matches are collected, so one record can carry several codes.
 *
 * Requirements: 3.13, 12.5
 */
export type ExceptionCode =
  | 'missing_clock_in' | 'missing_clock_out' | 'late_arrival' | 'early_departure'
  | 'absent' | 'unscheduled_work' | 'break_overrun' | 'open_break_at_clock_out'
  | 'overlapping_sessions' | 'negative_duration' | 'schedule_without_clock';

/**
 * One exception carried on a record, with the rule that produced it.
 *
 * `ruleDescription` is plain language and is rendered as visible text rather
 * than only as a hover title.
 *
 * `payrollBlocking` is true for a missing clock-out, a missing clock-in on a
 * date carrying a published schedule, and unapproved unscheduled work.
 *
 * Requirements: 3.13, 12.8
 */
export interface AttendanceException {
  code: ExceptionCode;
  ruleId: string;               // 'AX-02'
  ruleDescription: string;      // plain language, shown as visible text
  payrollBlocking: boolean;
  detail?: Record<string, number | string>;
}

/**
 * The tolerances the Status Rule Matrix and the exception rules refer to,
 * loaded from the single-row `attendance_policy` table.
 *
 * Requirements: 3.7, 3.10, 3.12
 */
export interface AttendancePolicy {
  businessTimezone: string;                    // 'America/New_York'
  gracePeriodMinutes: number;                  // 5
  earlyDepartureToleranceMinutes: number;      // 15
  missingClockOutToleranceMinutes: number;     // 120
  unpaidBreakTypes: readonly BreakType[];      // ['lunch']
  breakOverrunMinutes: number;                 // 60
  effectiveStartDate: string | null;           // '2026-08-04' or null (no restriction)
}

/**
 * An inclusive range of calendar work dates, `YYYY-MM-DD` at both ends.
 *
 * Inclusive at both ends because every range the module speaks in is stated
 * that way: a payroll period runs to its last date, a leave request covers its
 * end date, and an export names both. A half-open range would need a convention
 * nobody writing a date picker would expect.
 *
 * A single date is expressed as `from` equal to `to`, so a one-day read needs no
 * separate shape.
 *
 * Requirements: 12.19, 13.1, 14.1
 */
export interface DateRange {
  from: string;
  to: string;
}

/**
 * The staffing pair a coverage figure is compared against, loaded from
 * `staffing_thresholds` for one department, day of week, and time slot.
 *
 * A null threshold anywhere this type is optional means the slot is
 * unconfigured, which reports required staffing as unconfigured and status
 * Healthy rather than Critical. `warningThreshold` below `minimumStaff` is
 * accepted: it collapses the Warning band to nothing, and the ordered
 * comparison in `domain/coverage.ts` still holds.
 *
 * Produced by `server/policy.ts` and consumed by `domain/coverage.ts`.
 *
 * Requirements: 6.3, 6.4, 6.9, 6.10, 6.11, 6.12
 */
export interface Threshold {
  minimumStaff: number;
  warningThreshold: number;
}

/**
 * One clock session on a work date, with its breaks.
 *
 * A null `clockOut` marks an open session; a null break `end` marks an unended
 * break. Instants are ISO strings so the shape is serialisable across the
 * route boundary unchanged.
 *
 * Requirements: 3.8, 3.9, 3.10, 3.17
 */
export interface ClockSessionInput {
  id: string;
  clockIn: string;                             // ISO instant
  clockOut: string | null;
  breaks: Array<{
    id: string; type: BreakType;
    start: string; end: string | null;
    durationMinutes: number | null;
  }>;
  adjustedBy: string | null;
  adjustmentReason: string | null;
}

/**
 * Everything the derivation needs for one employee on one work date.
 *
 * `evaluatedAt` is a required field supplied by the caller and is never read
 * from the clock inside the domain layer. Without it, determinism is
 * untestable and every status involving "has passed" would be a moving target.
 *
 * Requirements: 3.2, 3.6, 3.7
 */
export interface AttendanceInputs {
  profileId: string;
  workDate: string;                            // YYYY-MM-DD
  employeeTimezone: string;
  schedule: { start: string; end: string; shiftType: ShiftType; status: ScheduleStatus } | null;
  sessions: ClockSessionInput[];
  approvedAbsence: { requestId: string; ptoType: PTOType } | null;
  unscheduledWorkApproved: boolean;
  reviewedAt: string | null;
  policy: AttendancePolicy;
  evaluatedAt: string;                         // ISO instant, supplied by the caller
}

/**
 * The computed record for one employee on one calendar work date. Never
 * stored: every read recomputes it from source rows.
 *
 * `statusRuleId` names the rule that assigned `derivedStatus`, so the drawer
 * can show which rule fired. `payrollBlocking` is the OR of the exception
 * flags.
 *
 * Requirements: 3.1, 3.3, 3.13, 12.8
 */
export interface DailyAttendanceRecord {
  profileId: string;
  workDate: string;
  scheduledStart: string | null;               // ISO instant
  scheduledEnd: string | null;
  scheduledHours: number;
  firstClockIn: string | null;
  lastClockOut: string | null;
  hasOpenSession: boolean;
  workedHours: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  derivedStatus: DerivedStatus;
  statusRuleId: string;
  exceptions: AttendanceException[];
  payrollBlocking: boolean;
  reviewedAt: string | null;
  sessions: ClockSessionInput[];               // carried through for the drawer timeline
}

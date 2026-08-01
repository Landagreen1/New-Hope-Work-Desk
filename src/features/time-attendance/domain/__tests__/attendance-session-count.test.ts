// src/features/time-attendance/domain/__tests__/attendance-session-count.test.ts
// Property test for what a second clock session on a date can and cannot change.
//
// This is the regression the redesign is built around: scheduled hours that
// multiplied with the number of clock sessions, and a lateness figure that moved
// when an employee clocked back in after lunch. Requirement 3, criterion 11
// makes scheduled hours a function of the schedule row alone, and criterion 17
// evaluates lateness against the earliest session only, so appending a later
// session must move worked hours and nothing else.
//
// The appended session is built here rather than drawn from the session
// generators, so its contribution is known independently: a span in whole
// minutes carrying at most one break of a known type and length, both well
// inside the span, which keeps the contribution a subtraction the test can state
// without consulting the module.
//
// Feature: time-attendance-ui-redesign, Property 5: Session-count invariance
// **Validates: Requirements 3.11, 3.17**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MINUTE_MS, buildEvaluationContext, recordFromContext } from '../attendance';
import type { AttendanceInputs, AttendancePolicy, ClockSessionInput } from '../types';
import type { BreakType } from '../../types';
import type { ScheduleInput } from './arbitraries';
import {
  attendancePolicyArb,
  breakTypeArb,
  nonOverlappingSessionSetArb,
  optionalScheduleArb,
  timeZoneArb,
  workDateArb,
} from './arbitraries';

/** The break sits from +10 minutes for at most 20, so it always fits the span. */
const BREAK_START_MINUTES = 10;

/**
 * A base set whose sessions have all closed. An open session is measured to the
 * evaluation instant, so a session appended after it would not be "later in the
 * same work date" — it would share time with it.
 */
const closedSessionSetArb = nonOverlappingSessionSetArb.filter((sessions) =>
  sessions.every((session) => session.clockOut !== null),
);

/** The session appended after everything the base set recorded. */
const appendedSessionArb = fc.record({
  gapMinutes: fc.integer({ min: 1, max: 180 }),
  spanMinutes: fc.integer({ min: 30, max: 240 }),
  breakType: breakTypeArb,
  /** Zero means the appended session carries no break at all. */
  breakLengthMinutes: fc.integer({ min: 0, max: 20 }),
});

function buildAppendedSession(
  clockInMs: number,
  spec: {
    gapMinutes: number;
    spanMinutes: number;
    breakType: BreakType;
    breakLengthMinutes: number;
  },
): { session: ClockSessionInput; clockOutMs: number } {
  const clockOutMs = clockInMs + spec.spanMinutes * MINUTE_MS;
  const breakStartMs = clockInMs + BREAK_START_MINUTES * MINUTE_MS;

  return {
    clockOutMs,
    session: {
      id: 'appended-session',
      clockIn: new Date(clockInMs).toISOString(),
      clockOut: new Date(clockOutMs).toISOString(),
      breaks:
        spec.breakLengthMinutes === 0
          ? []
          : [
              {
                id: 'appended-break',
                type: spec.breakType,
                start: new Date(breakStartMs).toISOString(),
                end: new Date(breakStartMs + spec.breakLengthMinutes * MINUTE_MS).toISOString(),
                durationMinutes: spec.breakLengthMinutes,
              },
            ],
      adjustedBy: null,
      adjustmentReason: null,
    },
  };
}

function inputsFor(
  sessions: ClockSessionInput[],
  schedule: ScheduleInput | null,
  evaluatedAtMs: number,
  policy: AttendancePolicy,
  workDate: string,
  employeeTimezone: string,
): AttendanceInputs {
  return {
    profileId: 'session-count-property',
    workDate,
    employeeTimezone,
    schedule,
    sessions,
    approvedAbsence: null,
    unscheduledWorkApproved: false,
    reviewedAt: null,
    policy,
    evaluatedAt: new Date(evaluatedAtMs).toISOString(),
  };
}

describe('PBT-5: Session-count invariance', () => {
  it('appending a later session adds that session contribution to worked hours and leaves scheduled hours and late minutes alone', () => {
    let scheduledCases = 0;
    let lateCases = 0;
    let breakCases = 0;

    fc.assert(
      fc.property(
        closedSessionSetArb,
        appendedSessionArb,
        optionalScheduleArb,
        attendancePolicyArb,
        workDateArb,
        timeZoneArb,
        (baseSessions, spec, schedule, policy, workDate, employeeTimezone) => {
          const lastClockOutMs = Math.max(
            ...baseSessions.map((session) => Date.parse(session.clockOut as string)),
          );
          const { session: appended, clockOutMs } = buildAppendedSession(
            lastClockOutMs + spec.gapMinutes * MINUTE_MS,
            spec,
          );

          // One evaluation instant for both derivations, after everything has
          // closed, so nothing but the appended session differs between them.
          const evaluatedAtMs = clockOutMs + 10 * MINUTE_MS;
          const before = inputsFor(
            baseSessions,
            schedule,
            evaluatedAtMs,
            policy,
            workDate,
            employeeTimezone,
          );
          const after = inputsFor(
            [...baseSessions, appended],
            schedule,
            evaluatedAtMs,
            policy,
            workDate,
            employeeTimezone,
          );

          const contextBefore = buildEvaluationContext(before);
          const contextAfter = buildEvaluationContext(after);
          const recordBefore = recordFromContext(contextBefore);
          const recordAfter = recordFromContext(contextAfter);

          // The appended session's contribution, stated without the module: its
          // span, less its break when the policy calls that type unpaid.
          const unpaid = policy.unpaidBreakTypes.includes(spec.breakType);
          const contributionMinutes =
            spec.spanMinutes - (unpaid ? spec.breakLengthMinutes : 0);

          // Worked hours increase by exactly that contribution.
          expect(contextAfter.workedMinutes - contextBefore.workedMinutes).toBe(
            contributionMinutes,
          );
          expect(recordAfter.workedHours).toBeCloseTo(
            (contextBefore.workedMinutes + contributionMinutes) / 60,
            2,
          );

          // Scheduled hours and late minutes are untouched.
          expect(recordAfter.scheduledHours).toBe(recordBefore.scheduledHours);
          expect(recordAfter.lateMinutes).toBe(recordBefore.lateMinutes);
          expect(recordAfter.scheduledStart).toBe(recordBefore.scheduledStart);
          expect(recordAfter.scheduledEnd).toBe(recordBefore.scheduledEnd);

          if (recordAfter.scheduledHours > 0) scheduledCases += 1;
          if (recordAfter.lateMinutes > 0) lateCases += 1;
          if (spec.breakLengthMinutes > 0 && unpaid) breakCases += 1;
        },
      ),
      { numRuns: 100 },
    );

    // Guard against a vacuous pass: scheduled hours and late minutes have to
    // have been non-zero somewhere, or "unchanged" would mean "always zero", and
    // the contribution has to have had a break deducted from it somewhere.
    expect(scheduledCases).toBeGreaterThan(0);
    expect(lateCases).toBeGreaterThan(0);
    expect(breakCases).toBeGreaterThan(0);
  });
});

// src/features/time-attendance/domain/__tests__/attendance-late-minutes.test.ts
// Property test for late minutes and the grace-period boundary.
//
// Two statements in one property, because they are two readings of the same
// rule: the figure is monotone in the clock-in instant, and the late condition
// turns over at a strict comparison against the grace period. Requirement 3,
// criterion 12 says the condition is reported only when the difference
// *exceeds* the grace period, so exactly the grace period is on time and one
// minute past it is late — the boundary a `>=` would move by a minute.
//
// Clock-ins are positioned relative to the resolved scheduled start rather than
// at absolute instants, so every generated case sits somewhere meaningful
// against the schedule instead of hours away from it. The grace period itself is
// generated, zero included.
//
// Feature: time-attendance-ui-redesign, Property 4: Late minutes monotonicity and grace boundary
// **Validates: Requirements 3.12**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MINUTE_MS,
  buildEvaluationContext,
  recordFromContext,
  resolveScheduleFacts,
} from '../attendance';
import type { AttendanceInputs, AttendancePolicy } from '../types';
import type { ScheduleInput } from './arbitraries';
import { attendancePolicyArb, scheduleArb, timeZoneArb, workDateArb } from './arbitraries';

const SESSION_LENGTH_MINUTES = 8 * 60;

/** Minutes either side of the scheduled start, clustered near the boundary. */
const clockInOffsetArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: -60, max: 60 }) },
  { weight: 2, arbitrary: fc.integer({ min: -600, max: 600 }) },
);

/**
 * One closed session clocking in at `clockInMs`, evaluated after it closed, so
 * the only thing varying across a comparison is the first clock-in.
 */
function contextForClockIn(
  clockInMs: number,
  schedule: ScheduleInput,
  policy: AttendancePolicy,
  workDate: string,
  employeeTimezone: string,
) {
  const clockOutMs = clockInMs + SESSION_LENGTH_MINUTES * MINUTE_MS;
  const inputs: AttendanceInputs = {
    profileId: 'late-property',
    workDate,
    employeeTimezone,
    schedule,
    sessions: [
      {
        id: 'session-1',
        clockIn: new Date(clockInMs).toISOString(),
        clockOut: new Date(clockOutMs).toISOString(),
        breaks: [],
        adjustedBy: null,
        adjustmentReason: null,
      },
    ],
    approvedAbsence: null,
    unscheduledWorkApproved: false,
    reviewedAt: null,
    policy,
    evaluatedAt: new Date(clockOutMs + MINUTE_MS).toISOString(),
  };

  return buildEvaluationContext(inputs);
}

describe('PBT-4: Late minutes monotonicity and grace boundary', () => {
  it('reports late minutes non-decreasing in the clock-in instant, on time at exactly the grace period and late one minute beyond', () => {
    let lateCases = 0;
    let onTimeCases = 0;

    fc.assert(
      fc.property(
        scheduleArb,
        workDateArb,
        attendancePolicyArb,
        timeZoneArb,
        clockInOffsetArb,
        clockInOffsetArb,
        (schedule, workDate, policy, employeeTimezone, offsetA, offsetB) => {
          const facts = resolveScheduleFacts(workDate, schedule, policy);
          expect(facts).not.toBeNull();
          if (facts === null) return;

          const scheduledStartMs = facts.start.getTime();
          const at = (offsetMinutes: number) =>
            contextForClockIn(
              scheduledStartMs + offsetMinutes * MINUTE_MS,
              schedule,
              policy,
              workDate,
              employeeTimezone,
            );

          const earlierOffset = Math.min(offsetA, offsetB);
          const laterOffset = Math.max(offsetA, offsetB);
          const earlier = at(earlierOffset);
          const later = at(laterOffset);

          // Non-decreasing in the clock-in instant.
          expect(later.lateMinutes).toBeGreaterThanOrEqual(earlier.lateMinutes);

          // The figure itself: minutes past the scheduled start, floored at zero.
          expect(earlier.lateMinutes).toBe(Math.max(0, earlierOffset));
          expect(later.lateMinutes).toBe(Math.max(0, laterOffset));

          // Reported only when the difference exceeds the grace period.
          const { gracePeriodMinutes } = policy;
          expect(earlier.isLate).toBe(Math.max(0, earlierOffset) > gracePeriodMinutes);
          expect(later.isLate).toBe(Math.max(0, laterOffset) > gracePeriodMinutes);

          // The boundary: exactly the grace period, and one minute beyond it.
          const atGrace = at(gracePeriodMinutes);
          const beyondGrace = at(gracePeriodMinutes + 1);

          expect(atGrace.lateMinutes).toBe(gracePeriodMinutes);
          expect(atGrace.isLate).toBe(false);
          expect(beyondGrace.lateMinutes).toBe(gracePeriodMinutes + 1);
          expect(beyondGrace.isLate).toBe(true);

          // The record reports the condition the same way it is decided.
          const codesAtGrace = recordFromContext(atGrace).exceptions.map((e) => e.code);
          const codesBeyondGrace = recordFromContext(beyondGrace).exceptions.map((e) => e.code);
          expect(codesAtGrace).not.toContain('late_arrival');
          expect(codesBeyondGrace).toContain('late_arrival');

          if (later.isLate) lateCases += 1;
          else onTimeCases += 1;
        },
      ),
      { numRuns: 100 },
    );

    // Guard against a vacuous pass: both sides of the condition must occur.
    expect(lateCases).toBeGreaterThan(0);
    expect(onTimeCases).toBeGreaterThan(0);
  });
});

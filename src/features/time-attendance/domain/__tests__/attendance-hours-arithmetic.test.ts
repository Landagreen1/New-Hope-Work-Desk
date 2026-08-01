// src/features/time-attendance/domain/__tests__/attendance-hours-arithmetic.test.ts
// Property test for the worked-hours and break arithmetic.
//
// The reference calculation below is written from Requirement 3, criteria 8, 9,
// and 10 rather than from `attendance.ts`, so a change to the module that also
// changes the arithmetic fails here instead of agreeing with itself.
//
// Two readings the requirement text leaves to the implementation, both settled
// the same way here as in the module, and both deliberate:
//
// 1. An unended break on a **closed** session is measured to that session's
//    clock-out, not to the evaluation instant. Criterion 9 ties
//    evaluation-instant measurement to a session with no clock-out; measuring a
//    closed day's unended break to the evaluation instant instead would make
//    that day's worked hours drift downward with wall-clock time, which
//    criterion 8 does not allow. `nonOverlappingSessionSetArb` generates this
//    shape, and the condition is reported through the AX-08 exception.
//
// 2. The subtraction is per session and floored at zero, so a session cannot
//    lose more than its own span. The evaluation instant is generated anywhere
//    at or after the last clock-in, which includes instants before a recorded
//    break on the open session has finished, and there the floor is reached.
//    The clause about unpaid minutes reducing worked hours by exactly their
//    amount is therefore asserted in both forms: the reduction always equals
//    the amount each session can absorb, and it equals the reported figure
//    exactly whenever no session's unpaid minutes exceed its span.
//
// 3. The outer span the total is bounded by runs from the first clock-in to the
//    last instant the day is measured to. A day whose final session is still
//    open has no last clock-out to bound it, and criterion 9 measures that
//    session to the evaluation instant, so that instant closes the span.
//
// Feature: time-attendance-ui-redesign, Property 3: Hours arithmetic invariants
// **Validates: Requirements 3.8, 3.9, 3.10**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MINUTE_MS, buildEvaluationContext, recordFromContext } from '../attendance';
import type { AttendanceInputs, AttendancePolicy, ClockSessionInput } from '../types';
import type { BreakType } from '../../types';
import {
  attendancePolicyArb,
  nonOverlappingSessionSetArb,
  timeZoneArb,
  workDateArb,
} from './arbitraries';

/** One session's figures, computed from the requirement text alone. */
interface SessionReference {
  open: boolean;
  /** The instant the session is measured to: its clock-out, or `evaluatedAt`. */
  measuredToMs: number;
  spanMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
}

function referenceSession(
  session: ClockSessionInput,
  evaluatedAtMs: number,
  unpaidBreakTypes: readonly BreakType[],
): SessionReference {
  const clockInMs = Date.parse(session.clockIn);
  const open = session.clockOut === null;
  const measuredToMs = open ? evaluatedAtMs : Date.parse(session.clockOut as string);
  const spanMinutes = Math.max(0, (measuredToMs - clockInMs) / MINUTE_MS);

  let paidBreakMinutes = 0;
  let unpaidBreakMinutes = 0;

  for (const item of session.breaks) {
    const startMs = Date.parse(item.start);
    // A stored duration is the figure the clock-out path persisted; without one
    // the elapsed span stands in. An unended break runs to `measuredToMs`.
    const minutes =
      item.end === null
        ? Math.max(0, (measuredToMs - startMs) / MINUTE_MS)
        : Math.max(0, item.durationMinutes ?? (Date.parse(item.end) - startMs) / MINUTE_MS);

    if (unpaidBreakTypes.includes(item.type)) unpaidBreakMinutes += minutes;
    else paidBreakMinutes += minutes;
  }

  return {
    open,
    measuredToMs,
    spanMinutes,
    paidBreakMinutes,
    unpaidBreakMinutes,
    workedMinutes: Math.max(0, spanMinutes - unpaidBreakMinutes),
  };
}

function sumOf(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Requirement 3, criteria 8 to 10 carry the widest input space in the suite. */
const RUNS = 200;

/** A session set with an evaluation instant at or after its last clock-in. */
const hoursCaseArb = nonOverlappingSessionSetArb.chain((sessions) => {
  const lastClockInMs = Math.max(...sessions.map((session) => Date.parse(session.clockIn)));
  return fc
    .integer({ min: 0, max: 24 * 60 })
    .map((minutesAfterLastClockIn) => ({
      sessions,
      evaluatedAtMs: lastClockInMs + minutesAfterLastClockIn * MINUTE_MS,
    }));
});

function inputsFor(
  sessions: ClockSessionInput[],
  evaluatedAtMs: number,
  policy: AttendancePolicy,
  workDate: string,
  employeeTimezone: string,
): AttendanceInputs {
  return {
    profileId: 'hours-property',
    workDate,
    employeeTimezone,
    // The schedule is irrelevant to worked hours, which is itself part of the
    // arithmetic: hours come from the clock rows only.
    schedule: null,
    sessions,
    approvedAbsence: null,
    unscheduledWorkApproved: false,
    reviewedAt: null,
    policy,
    evaluatedAt: new Date(evaluatedAtMs).toISOString(),
  };
}

describe('PBT-3: Hours arithmetic invariants', () => {
  it('worked hours equal the per-session identity, stay inside the outer span, and treat paid and unpaid breaks differently', () => {
    let exactReductionCases = 0;
    let flooredReductionCases = 0;
    let openSessionCases = 0;

    fc.assert(
      fc.property(
        hoursCaseArb,
        attendancePolicyArb,
        workDateArb,
        timeZoneArb,
        ({ sessions, evaluatedAtMs }, policy, workDate, employeeTimezone) => {
          const inputs = inputsFor(sessions, evaluatedAtMs, policy, workDate, employeeTimezone);
          const ctx = buildEvaluationContext(inputs);
          const record = recordFromContext(ctx);

          const references = sessions.map((session) =>
            referenceSession(session, evaluatedAtMs, policy.unpaidBreakTypes),
          );
          const expectedWorkedMinutes = sumOf(references.map((r) => r.workedMinutes));
          const expectedPaidMinutes = sumOf(references.map((r) => r.paidBreakMinutes));
          const expectedUnpaidMinutes = sumOf(references.map((r) => r.unpaidBreakMinutes));

          // Worked hours are the sum over sessions of span less that session's
          // unpaid break minutes, floored at zero.
          expect(ctx.workedMinutes).toBe(expectedWorkedMinutes);
          expect(record.workedHours).toBeCloseTo(expectedWorkedMinutes / 60, 2);
          expect(record.paidBreakMinutes).toBe(expectedPaidMinutes);
          expect(record.unpaidBreakMinutes).toBe(expectedUnpaidMinutes);

          // Worked hours never exceed the span from the first clock-in to the
          // last instant the day is measured to.
          const firstClockInMs = Math.min(...sessions.map((s) => Date.parse(s.clockIn)));
          const measuredEndMs = Math.max(...references.map((r) => r.measuredToMs));
          const outerSpanMinutes = (measuredEndMs - firstClockInMs) / MINUTE_MS;
          expect(ctx.workedMinutes).toBeLessThanOrEqual(outerSpanMinutes);
          expect(record.workedHours).toBeLessThanOrEqual(outerSpanMinutes / 60 + 0.005);

          // Every reported figure is non-negative.
          expect(record.workedHours).toBeGreaterThanOrEqual(0);
          expect(record.paidBreakMinutes).toBeGreaterThanOrEqual(0);
          expect(record.unpaidBreakMinutes).toBeGreaterThanOrEqual(0);

          // The same day under a policy where every break is paid: paid break
          // minutes do not reduce worked hours and are still reported.
          const allPaid = buildEvaluationContext({
            ...inputs,
            policy: { ...policy, unpaidBreakTypes: [] },
          });
          expect(allPaid.workedMinutes).toBe(sumOf(references.map((r) => r.spanMinutes)));
          expect(allPaid.paidBreakMinutes).toBe(expectedPaidMinutes + expectedUnpaidMinutes);
          expect(allPaid.unpaidBreakMinutes).toBe(0);

          // Unpaid break minutes reduce worked hours by exactly their amount,
          // per session and floored at that session's span.
          const reduction = allPaid.workedMinutes - ctx.workedMinutes;
          expect(reduction).toBe(
            sumOf(references.map((r) => Math.min(r.unpaidBreakMinutes, r.spanMinutes))),
          );
          if (references.every((r) => r.unpaidBreakMinutes <= r.spanMinutes)) {
            exactReductionCases += 1;
            expect(reduction).toBe(expectedUnpaidMinutes);
          } else {
            flooredReductionCases += 1;
          }

          // An open session is measured to the evaluation instant. Sessions are
          // generated ascending and sorted ascending, so positions correspond.
          expect(ctx.sessions).toHaveLength(sessions.length);
          ctx.sessions.forEach((fact, index) => {
            const reference = references[index];
            expect(fact.id).toBe(sessions[index].id);
            expect(fact.open).toBe(reference.open);
            expect(fact.measuredTo?.getTime()).toBe(reference.measuredToMs);
            expect(fact.spanMinutes).toBe(reference.spanMinutes);
            if (fact.open) expect(fact.measuredTo?.getTime()).toBe(evaluatedAtMs);
          });
          expect(ctx.hasOpenSession).toBe(references.some((r) => r.open));
          if (ctx.hasOpenSession) openSessionCases += 1;
        },
      ),
      { numRuns: RUNS },
    );

    // Guard against a vacuous pass: the open-session clause and the exact form
    // of the reduction clause have to have been reached, and every run has to
    // have taken one of the two arms of the reduction check. Which arm is a
    // property of the generated day, not a clause of the property, so the
    // floored arm is counted rather than required.
    expect(openSessionCases).toBeGreaterThan(0);
    expect(exactReductionCases).toBeGreaterThan(0);
    expect(exactReductionCases + flooredReductionCases).toBe(RUNS);
  });
});

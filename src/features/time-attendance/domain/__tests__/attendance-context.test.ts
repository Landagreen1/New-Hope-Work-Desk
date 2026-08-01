// src/features/time-attendance/domain/__tests__/attendance-context.test.ts
// Example tests for the evaluation context and the hours arithmetic.
//
// Feature: time-attendance-ui-redesign, task 3.1
//
// These are worked examples, not properties. The universal statements about
// hours, lateness, session independence, and overnight attribution are covered
// by Properties 3, 4, 5, and 8. What is asserted here is that the arithmetic
// lands on the figures a person would compute by hand for a handful of
// concrete days, including the cases the redesign is fixing: a paid break that
// must not be deducted, an open session measured to the evaluation instant,
// scheduled hours that do not multiply with session count, and an overnight
// shift resolved across a date boundary.
//
// Requirements: 3.2, 3.8, 3.9, 3.10, 3.11, 3.12, 3.17, 3.18

import { describe, expect, it } from 'vitest';
import {
  SESSION_ATTRIBUTION_MARGIN_MINUTES,
  attributeSessionWorkDate,
  buildEvaluationContext,
  resolveScheduleFacts,
  roundToTwoDecimals,
  shiftAttributionWindows,
} from '../attendance';
import type { AttendanceInputs, AttendancePolicy, ClockSessionInput } from '../types';

const POLICY: AttendancePolicy = {
  businessTimezone: 'America/New_York',
  gracePeriodMinutes: 5,
  earlyDepartureToleranceMinutes: 15,
  missingClockOutToleranceMinutes: 120,
  unpaidBreakTypes: ['lunch'],
  breakOverrunMinutes: 60,
};

/** 2026-07-28 is a summer weekday, so New York is UTC-4 that day. */
const WORK_DATE = '2026-07-28';

function eastern(time: string, date = WORK_DATE): string {
  // Fixed -04:00 offset: every date used in this file is inside EDT.
  return new Date(`${date}T${time}-04:00`).toISOString();
}

function session(
  id: string,
  clockIn: string,
  clockOut: string | null,
  breaks: ClockSessionInput['breaks'] = [],
): ClockSessionInput {
  return { id, clockIn, clockOut, breaks, adjustedBy: null, adjustmentReason: null };
}

function inputs(overrides: Partial<AttendanceInputs> = {}): AttendanceInputs {
  return {
    profileId: 'p1',
    workDate: WORK_DATE,
    employeeTimezone: 'America/New_York',
    schedule: { start: '09:00:00', end: '17:00:00', shiftType: 'regular', status: 'published' },
    sessions: [],
    approvedAbsence: null,
    unscheduledWorkApproved: false,
    reviewedAt: null,
    policy: POLICY,
    evaluatedAt: eastern('18:00:00'),
    ...overrides,
  };
}

describe('hours arithmetic', () => {
  it('subtracts an unpaid lunch from a closed session and reports it', () => {
    const ctx = buildEvaluationContext(
      inputs({
        sessions: [
          session('s1', eastern('09:00:00'), eastern('17:00:00'), [
            {
              id: 'b1',
              type: 'lunch',
              start: eastern('12:00:00'),
              end: eastern('12:30:00'),
              durationMinutes: 30,
            },
          ]),
        ],
      }),
    );

    expect(ctx.workedHours).toBe(7.5);
    expect(ctx.unpaidBreakMinutes).toBe(30);
    expect(ctx.paidBreakMinutes).toBe(0);
  });

  it('reports a paid break without deducting it', () => {
    const ctx = buildEvaluationContext(
      inputs({
        sessions: [
          session('s1', eastern('09:00:00'), eastern('17:00:00'), [
            {
              id: 'b1',
              type: 'short',
              start: eastern('10:00:00'),
              end: eastern('10:15:00'),
              durationMinutes: 15,
            },
            {
              id: 'b2',
              type: 'personal',
              start: eastern('15:00:00'),
              end: eastern('15:10:00'),
              durationMinutes: 10,
            },
          ]),
        ],
      }),
    );

    expect(ctx.workedHours).toBe(8);
    expect(ctx.paidBreakMinutes).toBe(25);
    expect(ctx.unpaidBreakMinutes).toBe(0);
  });

  it('falls back to the elapsed span when a break stores no duration', () => {
    const ctx = buildEvaluationContext(
      inputs({
        sessions: [
          session('s1', eastern('09:00:00'), eastern('17:00:00'), [
            {
              id: 'b1',
              type: 'lunch',
              start: eastern('12:00:00'),
              end: eastern('12:45:00'),
              durationMinutes: null,
            },
          ]),
        ],
      }),
    );

    expect(ctx.unpaidBreakMinutes).toBe(45);
    expect(ctx.workedHours).toBe(7.25);
  });

  it('measures an open session to the evaluation instant', () => {
    const ctx = buildEvaluationContext(
      inputs({
        sessions: [session('s1', eastern('09:00:00'), null)],
        evaluatedAt: eastern('13:30:00'),
      }),
    );

    expect(ctx.hasOpenSession).toBe(true);
    expect(ctx.lastClockOut).toBeNull();
    expect(ctx.workedHours).toBe(4.5);
  });

  it('measures an unended break to the evaluation instant while the session is open', () => {
    const ctx = buildEvaluationContext(
      inputs({
        sessions: [
          session('s1', eastern('09:00:00'), null, [
            {
              id: 'b1',
              type: 'lunch',
              start: eastern('12:00:00'),
              end: null,
              durationMinutes: null,
            },
          ]),
        ],
        evaluatedAt: eastern('12:20:00'),
      }),
    );

    // Span 09:00 to 12:20 is 200 minutes; the open lunch has run 20 of them.
    expect(ctx.hasOpenBreakOnOpenSession).toBe(true);
    expect(ctx.unpaidBreakMinutes).toBe(20);
    expect(roundToTwoDecimals(ctx.workedMinutes)).toBe(180);
  });

  it('measures an unended break on a closed session to the clock-out, not the evaluation instant', () => {
    const early = buildEvaluationContext(
      inputs({
        sessions: [
          session('s1', eastern('09:00:00'), eastern('17:00:00'), [
            {
              id: 'b1',
              type: 'lunch',
              start: eastern('16:30:00'),
              end: null,
              durationMinutes: null,
            },
          ]),
        ],
        evaluatedAt: eastern('17:05:00'),
      }),
    );
    const late = buildEvaluationContext(
      inputs({
        sessions: [
          session('s1', eastern('09:00:00'), eastern('17:00:00'), [
            {
              id: 'b1',
              type: 'lunch',
              start: eastern('16:30:00'),
              end: null,
              durationMinutes: null,
            },
          ]),
        ],
        evaluatedAt: eastern('23:59:00'),
      }),
    );

    expect(early.unpaidBreakMinutes).toBe(30);
    expect(early.workedHours).toBe(7.5);
    expect(late.unpaidBreakMinutes).toBe(30);
    expect(late.workedHours).toBe(7.5);
    expect(late.hasOpenBreakOnClosedSession).toBe(true);
  });

  it('sums several sessions and leaves scheduled hours and late minutes alone', () => {
    const one = buildEvaluationContext(
      inputs({ sessions: [session('s1', eastern('09:10:00'), eastern('12:00:00'))] }),
    );
    const two = buildEvaluationContext(
      inputs({
        sessions: [
          session('s1', eastern('09:10:00'), eastern('12:00:00')),
          session('s2', eastern('13:00:00'), eastern('17:00:00')),
        ],
      }),
    );

    expect(one.scheduledHours).toBe(8);
    expect(two.scheduledHours).toBe(8);
    expect(one.workedHours).toBe(2.83);
    expect(two.workedHours).toBe(6.83);
    expect(two.lateMinutes).toBe(one.lateMinutes);
    expect(two.lateMinutes).toBe(10);
    expect(two.hasOverlappingSessions).toBe(false);
  });

  it('floors a session that clocked out before it clocked in and flags it', () => {
    const ctx = buildEvaluationContext(
      inputs({ sessions: [session('s1', eastern('17:00:00'), eastern('09:00:00'))] }),
    );

    expect(ctx.workedHours).toBe(0);
    expect(ctx.hasNegativeDuration).toBe(true);
  });

  it('flags overlapping sessions', () => {
    const ctx = buildEvaluationContext(
      inputs({
        sessions: [
          session('s1', eastern('09:00:00'), eastern('13:00:00')),
          session('s2', eastern('12:00:00'), eastern('17:00:00')),
        ],
      }),
    );

    expect(ctx.hasOverlappingSessions).toBe(true);
  });
});

describe('lateness and early departure', () => {
  it('treats exactly the grace period as on time and one minute beyond as late', () => {
    const onTime = buildEvaluationContext(
      inputs({ sessions: [session('s1', eastern('09:05:00'), eastern('17:00:00'))] }),
    );
    const late = buildEvaluationContext(
      inputs({ sessions: [session('s1', eastern('09:06:00'), eastern('17:00:00'))] }),
    );

    expect(onTime.lateMinutes).toBe(5);
    expect(onTime.isLate).toBe(false);
    expect(late.lateMinutes).toBe(6);
    expect(late.isLate).toBe(true);
  });

  it('reports no lateness for an early arrival', () => {
    const ctx = buildEvaluationContext(
      inputs({ sessions: [session('s1', eastern('08:30:00'), eastern('17:00:00'))] }),
    );

    expect(ctx.lateMinutes).toBe(0);
    expect(ctx.isLate).toBe(false);
  });

  it('counts an early departure only beyond the tolerance, and only once closed', () => {
    const withinTolerance = buildEvaluationContext(
      inputs({ sessions: [session('s1', eastern('09:00:00'), eastern('16:45:00'))] }),
    );
    const beyondTolerance = buildEvaluationContext(
      inputs({ sessions: [session('s1', eastern('09:00:00'), eastern('16:30:00'))] }),
    );
    const stillOpen = buildEvaluationContext(
      inputs({
        sessions: [session('s1', eastern('09:00:00'), null)],
        evaluatedAt: eastern('16:30:00'),
      }),
    );

    expect(withinTolerance.earlyDepartureMinutes).toBe(15);
    expect(withinTolerance.isEarlyDeparture).toBe(false);
    expect(beyondTolerance.earlyDepartureMinutes).toBe(30);
    expect(beyondTolerance.isEarlyDeparture).toBe(true);
    expect(stillOpen.earlyDepartureMinutes).toBe(0);
  });

  it('reports zero for both figures when the date carries no schedule', () => {
    const ctx = buildEvaluationContext(
      inputs({ schedule: null, sessions: [session('s1', eastern('09:30:00'), eastern('17:00:00'))] }),
    );

    expect(ctx.schedule).toBeNull();
    expect(ctx.scheduledHours).toBe(0);
    expect(ctx.lateMinutes).toBe(0);
    expect(ctx.earlyDepartureMinutes).toBe(0);
    expect(ctx.workedHours).toBe(7.5);
  });
});

describe('schedule resolution', () => {
  it('resolves a same-day shift in the business timezone', () => {
    const facts = resolveScheduleFacts(
      WORK_DATE,
      { start: '09:00:00', end: '17:00:00', shiftType: 'regular', status: 'published' },
      POLICY,
    );

    expect(facts?.overnight).toBe(false);
    expect(facts?.scheduledHours).toBe(8);
    expect(facts?.start.toISOString()).toBe('2026-07-28T13:00:00.000Z');
    expect(facts?.end.toISOString()).toBe('2026-07-28T21:00:00.000Z');
  });

  it('runs an overnight shift into the following date', () => {
    const facts = resolveScheduleFacts(
      WORK_DATE,
      { start: '22:00:00', end: '06:00:00', shiftType: 'regular', status: 'published' },
      POLICY,
    );

    expect(facts?.overnight).toBe(true);
    expect(facts?.scheduledHours).toBe(8);
    expect(facts?.end.toISOString()).toBe('2026-07-29T10:00:00.000Z');
  });

  it('treats an end equal to its start as a full day rather than a zero-length shift', () => {
    const facts = resolveScheduleFacts(
      WORK_DATE,
      { start: '08:00:00', end: '08:00:00', shiftType: 'regular', status: 'published' },
      POLICY,
    );

    expect(facts?.overnight).toBe(true);
    expect(facts?.scheduledHours).toBe(24);
  });

  it('crosses a daylight-saving transition without inventing an hour', () => {
    // Spring forward in New York: 2026-03-08, clocks jump 02:00 to 03:00.
    const spring = resolveScheduleFacts(
      '2026-03-07',
      { start: '22:00:00', end: '06:00:00', shiftType: 'regular', status: 'published' },
      POLICY,
    );
    // Fall back: 2026-11-01, the hour from 01:00 happens twice.
    const autumn = resolveScheduleFacts(
      '2026-10-31',
      { start: '22:00:00', end: '06:00:00', shiftType: 'regular', status: 'published' },
      POLICY,
    );

    expect(spring?.scheduledHours).toBe(7);
    expect(autumn?.scheduledHours).toBe(9);
  });

  it('returns no facts for an unreadable schedule instead of throwing', () => {
    const ctx = buildEvaluationContext(
      inputs({
        // A shift_start that is not a time of day: a data fault, not a throw.
        schedule: { start: 'not-a-time', end: '17:00:00', shiftType: 'regular', status: 'published' },
      }),
    );

    expect(ctx.schedule).toBeNull();
    expect(ctx.hasMalformedSchedule).toBe(true);
    expect(ctx.scheduledHours).toBe(0);
  });

  it('throws for an unknown business timezone, which is a deployment fault', () => {
    expect(() =>
      buildEvaluationContext(inputs({ policy: { ...POLICY, businessTimezone: 'Mars/Olympus' } })),
    ).toThrow(RangeError);
  });

  it('throws for a malformed policy and for a malformed evaluation instant', () => {
    expect(() =>
      buildEvaluationContext(inputs({ policy: { ...POLICY, gracePeriodMinutes: -1 } })),
    ).toThrow(RangeError);
    expect(() => buildEvaluationContext(inputs({ evaluatedAt: 'whenever' }))).toThrow(RangeError);
  });
});

describe('session attribution', () => {
  const windows = shiftAttributionWindows(
    [
      {
        workDate: WORK_DATE,
        schedule: { start: '22:00:00', end: '06:00:00', shiftType: 'regular', status: 'published' },
      },
    ],
    POLICY,
  );

  it('keeps a session that clocks in on the following date with the shift start date', () => {
    const clockIn = new Date(eastern('01:30:00', '2026-07-29'));

    expect(attributeSessionWorkDate(clockIn, 'America/New_York', windows)).toBe(WORK_DATE);
  });

  it('accepts an early arrival inside the leading margin', () => {
    const clockIn = new Date(eastern('19:00:00'));

    expect(attributeSessionWorkDate(clockIn, 'America/New_York', windows)).toBe(WORK_DATE);
  });

  it('falls back to the calendar date once the session leaves every window', () => {
    const clockIn = new Date(eastern('11:00:00', '2026-07-29'));

    expect(SESSION_ATTRIBUTION_MARGIN_MINUTES).toBe(240);
    expect(attributeSessionWorkDate(clockIn, 'America/New_York', windows)).toBe('2026-07-29');
  });

  it('falls back to the employee timezone when no schedule exists at all', () => {
    // 00:30 in New York on 29 July is still 23:30 on 28 July in Tegucigalpa.
    const clockIn = new Date(eastern('00:30:00', '2026-07-29'));

    expect(attributeSessionWorkDate(clockIn, 'America/New_York', [])).toBe('2026-07-29');
    expect(attributeSessionWorkDate(clockIn, 'America/Tegucigalpa', [])).toBe(WORK_DATE);
  });
});

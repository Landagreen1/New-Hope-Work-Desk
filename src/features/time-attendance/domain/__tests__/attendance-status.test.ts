// src/features/time-attendance/domain/__tests__/attendance-status.test.ts
// Example tests for the status rule matrix and the exception rules.
//
// Feature: time-attendance-ui-redesign, task 3.2
//
// One worked day per row of the Status Rule Matrix, plus the cases where two
// rows could both hold and precedence decides. The universal statements —
// totality, precedence, exception attribution, and the payroll-blocking
// classification — are covered by Properties 1, 2, and 9.
//
// Requirements: 3.4, 3.5, 3.13, 12.8

import { describe, expect, it } from 'vitest';
import {
  EXCEPTION_RULES,
  STATUS_RULES,
  assignStatus,
  buildEvaluationContext,
  collectExceptions,
  hasInconsistentData,
  isPayrollBlocking,
} from '../attendance';
import type {
  AttendanceInputs,
  AttendancePolicy,
  ClockSessionInput,
  DerivedStatus,
} from '../types';

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

function statusOf(overrides: Partial<AttendanceInputs> = {}): { status: DerivedStatus; id: string } {
  const rule = assignStatus(buildEvaluationContext(inputs(overrides)));
  return { status: rule.status, id: rule.id };
}

function exceptionsOf(overrides: Partial<AttendanceInputs> = {}) {
  return collectExceptions(buildEvaluationContext(inputs(overrides)));
}

function codesOf(overrides: Partial<AttendanceInputs> = {}): string[] {
  return exceptionsOf(overrides).map((exception) => exception.code);
}

describe('status rule matrix shape', () => {
  it('holds twelve rules in the order the requirements state them', () => {
    expect(STATUS_RULES).toHaveLength(12);
    expect(STATUS_RULES.map((rule) => rule.order)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(STATUS_RULES.map((rule) => rule.id)).toEqual([
      'AS-01', 'AS-02', 'AS-03', 'AS-04', 'AS-05', 'AS-06',
      'AS-07', 'AS-08', 'AS-09', 'AS-10', 'AS-11', 'AS-12',
    ]);
    expect(STATUS_RULES.map((rule) => rule.status)).toEqual([
      'approved_time_off', 'missing_clock_out', 'on_break', 'working',
      'clocked_in_unscheduled', 'missing_clock_in', 'absent', 'left_early',
      'late', 'completed', 'scheduled', 'needs_review',
    ]);
    expect(STATUS_RULES.every((rule) => rule.description.trim().length > 0)).toBe(true);
  });

  it('assigns a status to an empty date, because the last rule holds unconditionally', () => {
    const last = STATUS_RULES[STATUS_RULES.length - 1];
    const ctx = buildEvaluationContext(inputs({ schedule: null }));

    expect(last.status).toBe('needs_review');
    expect(assignStatus(ctx)).toBe(last);
  });
});

describe('status assignment, one day per matrix row', () => {
  it('1: approved time off covers the date and nobody clocked in', () => {
    expect(statusOf({ approvedAbsence: { requestId: 'r1', ptoType: 'vacation' } })).toEqual({
      status: 'approved_time_off',
      id: 'AS-01',
    });
  });

  it('2: a session is still open past the scheduled end plus the tolerance', () => {
    // Scheduled end 17:00 plus a 120-minute tolerance expires at 19:00.
    expect(
      statusOf({
        sessions: [session('s1', eastern('09:00:00'), null)],
        evaluatedAt: eastern('19:01:00'),
      }),
    ).toEqual({ status: 'missing_clock_out', id: 'AS-02' });
  });

  it('3: an open session carries an unended break', () => {
    expect(
      statusOf({
        sessions: [
          session('s1', eastern('09:00:00'), null, [
            { id: 'b1', type: 'lunch', start: eastern('12:00:00'), end: null, durationMinutes: null },
          ]),
        ],
        evaluatedAt: eastern('12:20:00'),
      }),
    ).toEqual({ status: 'on_break', id: 'AS-03' });
  });

  it('4: an open session carries no unended break', () => {
    expect(
      statusOf({
        sessions: [session('s1', eastern('09:00:00'), null)],
        evaluatedAt: eastern('12:00:00'),
      }),
    ).toEqual({ status: 'working', id: 'AS-04' });
  });

  it('5: a session exists on a date carrying no published schedule', () => {
    expect(
      statusOf({ schedule: null, sessions: [session('s1', eastern('09:00:00'), eastern('17:00:00'))] }),
    ).toEqual({ status: 'clocked_in_unscheduled', id: 'AS-05' });
  });

  it('5: a draft schedule is not a published schedule', () => {
    expect(
      statusOf({
        schedule: { start: '09:00:00', end: '17:00:00', shiftType: 'regular', status: 'scheduled' },
        sessions: [session('s1', eastern('09:00:00'), eastern('17:00:00'))],
      }),
    ).toEqual({ status: 'clocked_in_unscheduled', id: 'AS-05' });
  });

  it('6: the shift is under way and no clock-in was recorded', () => {
    expect(statusOf({ evaluatedAt: eastern('10:00:00') })).toEqual({
      status: 'missing_clock_in',
      id: 'AS-06',
    });
  });

  it('7: the shift has ended and no clock-in was recorded', () => {
    expect(statusOf({ evaluatedAt: eastern('18:00:00') })).toEqual({
      status: 'absent',
      id: 'AS-07',
    });
  });

  it('8: the last clock-out precedes the scheduled end beyond the tolerance', () => {
    expect(statusOf({ sessions: [session('s1', eastern('09:00:00'), eastern('16:30:00'))] })).toEqual(
      { status: 'left_early', id: 'AS-08' },
    );
  });

  it('8: an early departure inside the tolerance is a completed day', () => {
    expect(statusOf({ sessions: [session('s1', eastern('09:00:00'), eastern('16:45:00'))] })).toEqual(
      { status: 'completed', id: 'AS-10' },
    );
  });

  it('9: the first clock-in exceeds the scheduled start beyond the grace period', () => {
    expect(statusOf({ sessions: [session('s1', eastern('09:10:00'), eastern('17:00:00'))] })).toEqual(
      { status: 'late', id: 'AS-09' },
    );
  });

  it('10: the day was worked inside both tolerances', () => {
    expect(statusOf({ sessions: [session('s1', eastern('09:00:00'), eastern('17:00:00'))] })).toEqual(
      { status: 'completed', id: 'AS-10' },
    );
  });

  it('11: a published schedule exists for a future date', () => {
    expect(statusOf({ workDate: '2026-07-30', evaluatedAt: eastern('18:00:00') })).toEqual({
      status: 'scheduled',
      id: 'AS-11',
    });
  });

  it('12: the recorded rows contradict each other', () => {
    expect(
      statusOf({
        sessions: [
          session('s1', eastern('09:00:00'), eastern('13:00:00')),
          session('s2', eastern('12:00:00'), eastern('17:00:00')),
        ],
      }),
    ).toEqual({ status: 'needs_review', id: 'AS-12' });
  });
});

describe('precedence between rules that both hold', () => {
  it('reports a missing clock-out rather than an open break once the tolerance expires', () => {
    const openBreakPastDeadline = {
      sessions: [
        session('s1', eastern('09:00:00'), null, [
          { id: 'b1', type: 'lunch', start: eastern('16:00:00'), end: null, durationMinutes: null },
        ]),
      ],
      evaluatedAt: eastern('19:30:00'),
    };
    const ctx = buildEvaluationContext(inputs(openBreakPastDeadline));

    expect(ctx.hasOpenBreakOnOpenSession).toBe(true);
    expect(statusOf(openBreakPastDeadline)).toEqual({ status: 'missing_clock_out', id: 'AS-02' });
  });

  it('reports approved time off rather than an absence when nobody clocked in', () => {
    expect(
      statusOf({
        approvedAbsence: { requestId: 'r1', ptoType: 'vacation' },
        evaluatedAt: eastern('18:00:00'),
      }),
    ).toEqual({ status: 'approved_time_off', id: 'AS-01' });
  });

  it('reports lateness only after every session has closed', () => {
    const stillOpen = statusOf({
      sessions: [session('s1', eastern('09:30:00'), null)],
      evaluatedAt: eastern('12:00:00'),
    });
    const closed = statusOf({ sessions: [session('s1', eastern('09:30:00'), eastern('17:00:00'))] });

    expect(stillOpen).toEqual({ status: 'working', id: 'AS-04' });
    expect(closed).toEqual({ status: 'late', id: 'AS-09' });
  });

  it('reports leaving early ahead of arriving late when the day did both', () => {
    expect(statusOf({ sessions: [session('s1', eastern('09:30:00'), eastern('16:00:00'))] })).toEqual(
      { status: 'left_early', id: 'AS-08' },
    );
  });

  it('overrides an otherwise completed day when a duration runs backwards', () => {
    const backwards = { sessions: [session('s1', eastern('17:00:00'), eastern('09:00:00'))] };
    const ctx = buildEvaluationContext(inputs(backwards));

    expect(hasInconsistentData(ctx)).toBe(true);
    expect(statusOf(backwards)).toEqual({ status: 'needs_review', id: 'AS-12' });
  });

  it('overrides an unscheduled reading when the schedule row cannot be read', () => {
    const unreadableSchedule = {
      schedule: { start: 'not-a-time', end: '17:00:00', shiftType: 'regular' as const, status: 'published' as const },
      sessions: [session('s1', eastern('09:00:00'), eastern('17:00:00'))],
    };

    expect(statusOf(unreadableSchedule)).toEqual({ status: 'needs_review', id: 'AS-12' });
    expect(codesOf(unreadableSchedule)).toContain('schedule_without_clock');
  });
});

describe('exception rules', () => {
  it('names a rule and a plain-language description on every rule it defines', () => {
    expect(EXCEPTION_RULES.length).toBeGreaterThan(0);
    expect(
      EXCEPTION_RULES.every(
        (rule) => /^AX-\d\d$/.test(rule.id) && rule.description.trim().length > 0,
      ),
    ).toBe(true);
  });

  it('reports no exception on a clean completed day', () => {
    expect(codesOf({ sessions: [session('s1', eastern('09:00:00'), eastern('17:00:00'))] })).toEqual(
      [],
    );
  });

  it('collects every match on one record rather than choosing between them', () => {
    const messyDay = {
      sessions: [
        session('s1', eastern('09:10:00'), eastern('17:00:00'), [
          {
            id: 'b1',
            type: 'lunch' as const,
            start: eastern('12:00:00'),
            end: eastern('13:30:00'),
            durationMinutes: 90,
          },
          {
            id: 'b2',
            type: 'short' as const,
            start: eastern('16:30:00'),
            end: null,
            durationMinutes: null,
          },
        ]),
      ],
    };
    const exceptions = exceptionsOf(messyDay);

    expect(exceptions.map((exception) => exception.code)).toEqual([
      'late_arrival',
      'break_overrun',
      'open_break_at_clock_out',
    ]);
    expect(exceptions.map((exception) => exception.ruleId)).toEqual(['AX-03', 'AX-07', 'AX-08']);
    expect(exceptions[0].detail).toEqual({ lateMinutes: 10, gracePeriodMinutes: 5 });
    expect(exceptions[1].detail).toEqual({ breakMinutes: 90, limitMinutes: 60 });
  });

  it('splits a missing clock-in from an absence at the scheduled end', () => {
    expect(codesOf({ evaluatedAt: eastern('10:00:00') })).toEqual(['missing_clock_in']);
    expect(codesOf({ evaluatedAt: eastern('18:00:00') })).toEqual(['absent']);
  });

  it('raises nothing for a future scheduled date', () => {
    expect(codesOf({ workDate: '2026-07-30', evaluatedAt: eastern('18:00:00') })).toEqual([]);
  });

  it('raises no absence when approved time off covers the date', () => {
    expect(
      codesOf({
        approvedAbsence: { requestId: 'r1', ptoType: 'vacation' },
        evaluatedAt: eastern('18:00:00'),
      }),
    ).toEqual([]);
  });

  it('raises a missing clock-out for a session left open on a past date with no schedule', () => {
    expect(
      codesOf({
        schedule: null,
        sessions: [session('s1', eastern('09:00:00'), null)],
        evaluatedAt: eastern('10:00:00', '2026-07-29'),
      }),
    ).toEqual(['missing_clock_out', 'unscheduled_work']);
  });

  it('reports an unreadable clock row, which would otherwise carry no exception at all', () => {
    const unreadableRow = {
      sessions: [
        session('s1', 'never', eastern('17:00:00')),
        session('s2', eastern('09:00:00'), eastern('17:00:00')),
      ],
    };

    expect(exceptionsOf(unreadableRow).map((exception) => exception.ruleId)).toEqual(['AX-12']);
    expect(codesOf(unreadableRow)).toEqual(['negative_duration']);
    expect(statusOf(unreadableRow)).toEqual({ status: 'needs_review', id: 'AS-12' });
  });
});

describe('payroll blocking', () => {
  it('blocks on a missing clock-out', () => {
    const exceptions = exceptionsOf({
      sessions: [session('s1', eastern('09:00:00'), null)],
      evaluatedAt: eastern('19:01:00'),
    });

    expect(exceptions.map((exception) => exception.code)).toEqual(['missing_clock_out']);
    expect(isPayrollBlocking(exceptions)).toBe(true);
  });

  it('blocks on a missing clock-in on a date carrying a published schedule', () => {
    const exceptions = exceptionsOf({ evaluatedAt: eastern('10:00:00') });

    expect(exceptions[0].payrollBlocking).toBe(true);
    expect(isPayrollBlocking(exceptions)).toBe(true);
  });

  it('does not block on unscheduled work (informational only)', () => {
    const unapproved = exceptionsOf({
      schedule: null,
      sessions: [session('s1', eastern('09:00:00'), eastern('17:00:00'))],
    });
    const approved = exceptionsOf({
      schedule: null,
      sessions: [session('s1', eastern('09:00:00'), eastern('17:00:00'))],
      unscheduledWorkApproved: true,
    });

    expect(unapproved.map((exception) => exception.code)).toEqual(['unscheduled_work']);
    expect(isPayrollBlocking(unapproved)).toBe(false);
    expect(approved.map((exception) => exception.code)).toEqual(['unscheduled_work']);
    expect(isPayrollBlocking(approved)).toBe(false);
  });

  it('does not block on an absence, a late arrival, an early departure, or a break issue', () => {
    const absent = exceptionsOf({ evaluatedAt: eastern('18:00:00') });
    const late = exceptionsOf({ sessions: [session('s1', eastern('09:10:00'), eastern('17:00:00'))] });
    const leftEarly = exceptionsOf({
      sessions: [session('s1', eastern('09:00:00'), eastern('16:00:00'))],
    });
    const longBreak = exceptionsOf({
      sessions: [
        session('s1', eastern('09:00:00'), eastern('17:00:00'), [
          {
            id: 'b1',
            type: 'lunch',
            start: eastern('12:00:00'),
            end: eastern('13:30:00'),
            durationMinutes: 90,
          },
        ]),
      ],
    });

    expect(absent.map((exception) => exception.code)).toEqual(['absent']);
    expect(isPayrollBlocking(absent)).toBe(false);
    expect(isPayrollBlocking(late)).toBe(false);
    expect(isPayrollBlocking(leftEarly)).toBe(false);
    expect(isPayrollBlocking(longBreak)).toBe(false);
  });

  it('does not block on inconsistent data, which needs review rather than a pay hold', () => {
    const overlapping = exceptionsOf({
      sessions: [
        session('s1', eastern('09:00:00'), eastern('13:00:00')),
        session('s2', eastern('12:00:00'), eastern('17:00:00')),
      ],
    });

    expect(overlapping.map((exception) => exception.code)).toEqual(['overlapping_sessions']);
    expect(isPayrollBlocking(overlapping)).toBe(false);
  });
});

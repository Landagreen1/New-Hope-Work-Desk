// src/features/time-attendance/domain/__tests__/pto-requests.test.ts
// Example tests for the submission disclosure, the decision context, and the
// Request_Inbox row, order, filters, and page cap in `domain/pto.ts`.
//
// Feature: time-attendance-ui-redesign, task 11.3
//
// Coverage inputs are built by calling `projectCoverage` rather than by writing
// `DateCoverage` objects by hand, so the statuses the risk indicator reads are
// statuses the coverage rule actually assigns. Hand-written fixtures could carry
// a status `classifyCoverage` would never produce, and the tests would stop
// saying anything about the real pairing.
//
// 2026-07-27 is a Monday, so 2026-07-31 is the Friday of that week and
// 2026-08-01 the Saturday. 2026-07-01 is 26 calendar days before that Monday,
// which is comfortably outside the short-notice fortnight and is therefore the
// default submission date here.
//
// Requirements: 7.5, 7.6, 7.7, 7.8, 7.9, 7.12, 9.8, 9.9, 9.10, 9.11, 9.12,
// 11.4, 11.5

import { describe, expect, it } from 'vitest';
import type { RecordSubject } from '../attendance';
import { projectCoverage, type DateCoverage } from '../coverage';
import {
  NEARBY_ABSENCE_DAYS,
  PTO_TYPE_TO_ALLOWANCE_FIELD,
  PTO_TYPE_TO_BALANCE_FIELD,
  REQUEST_PAGE_LIMIT,
  REQUEST_STATUS_FILTERS,
  SHORT_NOTICE_DAYS,
  buildDecisionContext,
  buildRequestInbox,
  buildRequestRow,
  buildSubmissionDisclosure,
  calendarDaysBetween,
  compareRequestRows,
  coverageRiskForRequest,
  countWorkingDays,
  filterRequestRows,
  isPendingRequest,
  matchesRequestQuery,
  orderRequestRows,
  remainingBalanceFor,
  requestPageLimit,
  workingDatesAcross,
  worstCoverageStatus,
  type ApprovedAbsence,
  type PTOBalanceRow,
  type PTORequestRecord,
  type RequestInboxRow,
  type ScheduledShift,
} from '../pto';
import type { Department, PTOStatus, PTOType } from '../../types';
import type { Threshold } from '../types';

const MONDAY = '2026-07-27';
const TUESDAY = '2026-07-28';
const WEDNESDAY = '2026-07-29';
const THURSDAY = '2026-07-30';
const FRIDAY = '2026-07-31';
const SATURDAY = '2026-08-01';

const SUBMITTED_ON = '2026-07-01';
const SUBMITTED_AT = '2026-07-01T14:00:00.000Z';
const EVALUATED_AT = '2026-07-02T14:00:00.000Z';

const NOTHING_CLOSED: ReadonlySet<string> = new Set<string>();

/** Two required, warning collapsed to nothing, so three people read Healthy. */
const NEEDS_TWO: Threshold = { minimumStaff: 2, warningThreshold: 2 };

const ALL_STATUSES: readonly PTOStatus[] = [
  'pending',
  'approved',
  'denied',
  'cancelled',
  'waitlisted',
  'information_requested',
  'partially_approved',
];

const ALL_TYPES: readonly PTOType[] = [
  'vacation',
  'sick',
  'personal',
  'bereavement',
  'unpaid',
];

function request(overrides: Partial<PTORequestRecord> = {}): PTORequestRecord {
  return {
    id: 'req-1',
    profileId: 'emp-1',
    ptoType: 'vacation',
    startDate: MONDAY,
    endDate: FRIDAY,
    status: 'pending',
    submittedAt: SUBMITTED_AT,
    submissionDate: SUBMITTED_ON,
    ...overrides,
  };
}

function balanceRow(overrides: Partial<PTOBalanceRow> = {}): PTOBalanceRow {
  return {
    year: 2026,
    vacation_days: 10,
    sick_days: 5,
    personal_days: 3,
    vacation_used: 0,
    sick_used: 0,
    personal_used: 0,
    ...overrides,
  };
}

function absence(overrides: Partial<ApprovedAbsence> = {}): ApprovedAbsence {
  return {
    requestId: 'other-1',
    profileId: 'emp-1',
    ptoType: 'vacation',
    range: { from: '2026-08-03', to: '2026-08-04' },
    ...overrides,
  };
}

const subjects: Record<string, RecordSubject> = {
  'emp-1': { profileId: 'emp-1', department: 'sales' },
  'emp-2': { profileId: 'emp-2', department: 'sales' },
  'emp-3': { profileId: 'emp-3', department: 'customer_service' },
};

/** One date's projection, as the Coverage_Service produces it. */
function projected(options: {
  workDate: string;
  scheduled: readonly string[];
  proposedAbsences?: readonly string[];
  threshold?: Threshold | null;
  withDepartments?: boolean;
}): DateCoverage {
  return projectCoverage({
    workDate: options.workDate,
    scheduledProfileIds: options.scheduled,
    approvedAbsenceProfileIds: [],
    proposedAbsenceProfileIds: options.proposedAbsences ?? [],
    threshold: options.threshold === undefined ? NEEDS_TWO : options.threshold,
    ...(options.withDepartments === true
      ? {
          roster: new Map(Object.entries(subjects)),
          departmentThresholds: new Map<Department, Threshold | null>([
            ['sales', NEEDS_TWO],
            ['customer_service', NEEDS_TWO],
          ]),
        }
      : {}),
  });
}

function row(overrides: Partial<RequestInboxRow> = {}): RequestInboxRow {
  return {
    requestId: 'req-1',
    profileId: 'emp-1',
    employeeName: 'Ana Ruiz',
    department: 'sales',
    ptoType: 'vacation',
    startDate: MONDAY,
    endDate: FRIDAY,
    workingDays: 5,
    status: 'pending',
    remainingBalance: 10,
    coverageRisk: 'healthy',
    submittedAt: SUBMITTED_AT,
    awaitingReviewMinutes: 0,
    pending: true,
    shortNotice: false,
    ...overrides,
  };
}

// ─── Calendar-day arithmetic ─────────────────────────────────────────────────

describe('calendarDaysBetween', () => {
  it('counts zero days from a date to itself', () => {
    expect(calendarDaysBetween(MONDAY, MONDAY)).toBe(0);
  });

  it('counts forwards as positive and backwards as negative', () => {
    expect(calendarDaysBetween(MONDAY, FRIDAY)).toBe(4);
    expect(calendarDaysBetween(FRIDAY, MONDAY)).toBe(-4);
  });

  it('counts across a month and a year boundary', () => {
    expect(calendarDaysBetween('2026-07-30', '2026-08-02')).toBe(3);
    expect(calendarDaysBetween('2025-12-25', '2026-01-05')).toBe(11);
  });

  it('counts the leap day when the year has one', () => {
    expect(calendarDaysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(calendarDaysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });

  it('refuses a date that is not a calendar date', () => {
    expect(() => calendarDaysBetween('2026-02-30', MONDAY)).toThrow(RangeError);
    expect(() => calendarDaysBetween(MONDAY, '27/07/2026')).toThrow(RangeError);
  });
});

describe('workingDatesAcross', () => {
  it('lists the working dates of a range, ascending', () => {
    expect(workingDatesAcross([{ from: MONDAY, to: SATURDAY }], NOTHING_CLOSED)).toEqual([
      MONDAY,
      TUESDAY,
      WEDNESDAY,
      THURSDAY,
      FRIDAY,
    ]);
  });

  it('counts a date once however many ranges cover it', () => {
    const dates = workingDatesAcross(
      [
        { from: MONDAY, to: WEDNESDAY },
        { from: TUESDAY, to: FRIDAY },
      ],
      NOTHING_CLOSED,
    );
    expect(dates).toEqual([MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY]);
  });

  it('excludes the dates the organisation is closed', () => {
    expect(
      workingDatesAcross([{ from: MONDAY, to: FRIDAY }], new Set([WEDNESDAY])),
    ).toEqual([MONDAY, TUESDAY, THURSDAY, FRIDAY]);
  });

  it('lists nothing for an inverted range', () => {
    expect(workingDatesAcross([{ from: FRIDAY, to: MONDAY }], NOTHING_CLOSED)).toEqual([]);
  });
});

// ─── Remaining balance ───────────────────────────────────────────────────────

describe('remainingBalanceFor', () => {
  it('reports the allocation minus the days used', () => {
    expect(remainingBalanceFor(balanceRow({ vacation_used: 3 }), 'vacation')).toBe(7);
    expect(remainingBalanceFor(balanceRow({ sick_used: 1 }), 'sick')).toBe(4);
    expect(remainingBalanceFor(balanceRow({ personal_used: 1 }), 'personal')).toBe(2);
  });

  it('draws bereavement and unpaid against the personal pair', () => {
    const balance = balanceRow({ personal_used: 1 });
    expect(remainingBalanceFor(balance, 'bereavement')).toBe(2);
    expect(remainingBalanceFor(balance, 'unpaid')).toBe(2);
    expect(remainingBalanceFor(balance, 'personal')).toBe(2);
  });

  it('reports an overdrawn balance as the negative figure it is', () => {
    expect(remainingBalanceFor(balanceRow({ vacation_used: 12 }), 'vacation')).toBe(-2);
  });

  it('reports zero when no balance row exists for the employee and year', () => {
    expect(remainingBalanceFor(null, 'vacation')).toBe(0);
    expect(remainingBalanceFor(undefined, 'vacation')).toBe(0);
  });

  it('names an allowance column and a usage column for every accepted type', () => {
    for (const ptoType of ALL_TYPES) {
      expect(PTO_TYPE_TO_ALLOWANCE_FIELD[ptoType]).toBeDefined();
      expect(PTO_TYPE_TO_BALANCE_FIELD[ptoType]).toBeDefined();
    }
  });

  it('pairs each allowance column with the usage column of the same leave kind', () => {
    for (const ptoType of ALL_TYPES) {
      const allowance = PTO_TYPE_TO_ALLOWANCE_FIELD[ptoType].replace('_days', '');
      const used = PTO_TYPE_TO_BALANCE_FIELD[ptoType].replace('_used', '');
      expect(allowance).toBe(used);
    }
  });

  it('rejects a request type the database constraint does not accept', () => {
    expect(() =>
      remainingBalanceFor(balanceRow(), 'birthday' as unknown as PTOType),
    ).toThrow(RangeError);
  });
});

// ─── Submission disclosure ───────────────────────────────────────────────────

describe('buildSubmissionDisclosure', () => {
  const submission = (overrides: Partial<Parameters<typeof buildSubmissionDisclosure>[0]> = {}) =>
    buildSubmissionDisclosure({
      ptoType: 'vacation',
      range: { from: MONDAY, to: FRIDAY },
      remainingBalance: 10,
      submissionDate: SUBMITTED_ON,
      ...overrides,
    });

  it('reports the working days the request covers', () => {
    expect(submission().workingDays).toBe(5);
    expect(submission({ range: { from: MONDAY, to: SATURDAY } }).workingDays).toBe(5);
  });

  it('reports no shortfall while the request fits inside the balance', () => {
    const disclosure = submission({ remainingBalance: 10 });
    expect(disclosure.shortfallDays).toBe(0);
    expect(disclosure.exceedsBalance).toBe(false);
    expect(disclosure.balanceAfter).toBe(5);
  });

  it('reports no shortfall when the request uses the balance exactly', () => {
    const disclosure = submission({ remainingBalance: 5 });
    expect(disclosure.shortfallDays).toBe(0);
    expect(disclosure.exceedsBalance).toBe(false);
    expect(disclosure.balanceAfter).toBe(0);
  });

  it('reports the shortfall as the working days beyond the balance', () => {
    const disclosure = submission({ remainingBalance: 3 });
    expect(disclosure.shortfallDays).toBe(2);
    expect(disclosure.exceedsBalance).toBe(true);
    expect(disclosure.balanceAfter).toBe(-2);
  });

  it('measures the shortfall from an already overdrawn balance', () => {
    expect(submission({ remainingBalance: -1 }).shortfallDays).toBe(6);
  });

  it('carries a fractional balance through without rounding it away', () => {
    const disclosure = submission({ remainingBalance: 2.5 });
    expect(disclosure.shortfallDays).toBe(2.5);
    expect(disclosure.balanceAfter).toBe(-2.5);
  });

  it('accepts the submission whatever the shortfall', () => {
    expect(submission({ remainingBalance: 0 }).accepted).toBe(true);
    expect(submission({ remainingBalance: -20 }).accepted).toBe(true);
  });

  it('excludes closed dates from the working days and therefore from the shortfall', () => {
    const disclosure = submission({
      remainingBalance: 4,
      closedDates: new Set([WEDNESDAY]),
    });
    expect(disclosure.workingDays).toBe(4);
    expect(disclosure.shortfallDays).toBe(0);
  });

  it('reports the calendar days of notice, not the working days', () => {
    // 2026-07-01 to 2026-07-27 spans four weekends.
    expect(submission().noticeDays).toBe(26);
  });

  it('is not short notice at exactly a fortnight', () => {
    const disclosure = submission({
      range: { from: '2026-07-15', to: '2026-07-15' },
      submissionDate: '2026-07-01',
    });
    expect(disclosure.noticeDays).toBe(SHORT_NOTICE_DAYS);
    expect(disclosure.shortNotice).toBe(false);
  });

  it('is short notice one day inside the fortnight', () => {
    const disclosure = submission({
      range: { from: '2026-07-14', to: '2026-07-14' },
      submissionDate: '2026-07-01',
    });
    expect(disclosure.noticeDays).toBe(SHORT_NOTICE_DAYS - 1);
    expect(disclosure.shortNotice).toBe(true);
  });

  it('is short notice for a request starting on the day it is submitted', () => {
    const disclosure = submission({
      range: { from: SUBMITTED_ON, to: SUBMITTED_ON },
      submissionDate: SUBMITTED_ON,
    });
    expect(disclosure.noticeDays).toBe(0);
    expect(disclosure.shortNotice).toBe(true);
  });

  it('is short notice for a backdated request', () => {
    const disclosure = submission({
      range: { from: '2026-06-29', to: '2026-06-29' },
      submissionDate: SUBMITTED_ON,
    });
    expect(disclosure.noticeDays).toBe(-2);
    expect(disclosure.shortNotice).toBe(true);
  });

  it('discloses a shortfall and short notice together without blocking either', () => {
    const disclosure = submission({
      range: { from: '2026-07-06', to: '2026-07-10' },
      submissionDate: SUBMITTED_ON,
      remainingBalance: 1,
    });
    expect(disclosure).toMatchObject({
      accepted: true,
      workingDays: 5,
      shortfallDays: 4,
      exceedsBalance: true,
      noticeDays: 5,
      shortNotice: true,
    });
  });

  it('reports no working days and no shortfall for an inverted range', () => {
    const disclosure = submission({ range: { from: FRIDAY, to: MONDAY }, remainingBalance: 0 });
    expect(disclosure.workingDays).toBe(0);
    expect(disclosure.shortfallDays).toBe(0);
  });

  it('reports the working days the count rule reports, for every type', () => {
    for (const ptoType of ALL_TYPES) {
      expect(submission({ ptoType }).workingDays).toBe(
        countWorkingDays(MONDAY, FRIDAY, NOTHING_CLOSED),
      );
    }
  });

  it('rejects a request type the database constraint does not accept', () => {
    expect(() => submission({ ptoType: 'birthday' as unknown as PTOType })).toThrow(
      RangeError,
    );
  });

  it('refuses a range bound that is not a calendar date', () => {
    expect(() => submission({ range: { from: '2026-02-30', to: FRIDAY } })).toThrow(RangeError);
  });
});

// ─── Coverage risk ───────────────────────────────────────────────────────────

describe('worstCoverageStatus', () => {
  it('reports nothing for an empty set', () => {
    expect(worstCoverageStatus([])).toBeNull();
  });

  it('reports the worst status in the set', () => {
    expect(worstCoverageStatus(['healthy', 'warning'])).toBe('warning');
    expect(worstCoverageStatus(['healthy', 'warning', 'at_minimum'])).toBe('at_minimum');
    expect(worstCoverageStatus(['at_minimum', 'critical', 'healthy'])).toBe('critical');
  });

  it('does not depend on the order the statuses arrive in', () => {
    expect(worstCoverageStatus(['critical', 'healthy'])).toBe(
      worstCoverageStatus(['healthy', 'critical']),
    );
  });

  it('ranks at_minimum worse than warning, as the coverage severity does', () => {
    expect(worstCoverageStatus(['warning', 'at_minimum'])).toBe('at_minimum');
  });
});

describe('coverageRiskForRequest', () => {
  const ranges = [{ from: MONDAY, to: FRIDAY }];

  it('reports the worst status across the requested dates', () => {
    const coverage = [
      projected({ workDate: MONDAY, scheduled: ['a', 'b', 'c'] }),
      projected({ workDate: TUESDAY, scheduled: ['a', 'b'] }),
      projected({ workDate: WEDNESDAY, scheduled: ['a'] }),
    ];
    expect(coverage.map((entry) => entry.status)).toEqual([
      'healthy',
      'at_minimum',
      'critical',
    ]);
    expect(coverageRiskForRequest({ ranges, coverage })).toBe('critical');
  });

  it('reports nothing when no requested date carries a projection', () => {
    expect(coverageRiskForRequest({ ranges, coverage: [] })).toBeNull();
    expect(
      coverageRiskForRequest({
        ranges,
        coverage: [projected({ workDate: '2026-09-01', scheduled: ['a'] })],
      }),
    ).toBeNull();
  });

  it('ignores dates outside the requested range', () => {
    const coverage = [
      projected({ workDate: MONDAY, scheduled: ['a', 'b', 'c'] }),
      projected({ workDate: '2026-08-10', scheduled: [] }),
    ];
    expect(coverageRiskForRequest({ ranges, coverage })).toBe('healthy');
  });

  it('ignores a weekend inside the requested range', () => {
    // The absence removes nobody from a Saturday shift, so a short Saturday is
    // not this request's risk.
    const coverage = [
      projected({ workDate: FRIDAY, scheduled: ['a', 'b', 'c'] }),
      projected({ workDate: SATURDAY, scheduled: [] }),
    ];
    expect(
      coverageRiskForRequest({ ranges: [{ from: FRIDAY, to: SATURDAY }], coverage }),
    ).toBe('healthy');
  });

  it('ignores a closed date inside the requested range', () => {
    const coverage = [
      projected({ workDate: MONDAY, scheduled: ['a', 'b', 'c'] }),
      projected({ workDate: WEDNESDAY, scheduled: [] }),
    ];
    expect(
      coverageRiskForRequest({
        ranges,
        coverage,
        closedDates: new Set([WEDNESDAY]),
      }),
    ).toBe('healthy');
  });

  it('reports nothing when the range covers no working date at all', () => {
    const coverage = [projected({ workDate: SATURDAY, scheduled: [] })];
    expect(
      coverageRiskForRequest({ ranges: [{ from: SATURDAY, to: '2026-08-02' }], coverage }),
    ).toBeNull();
  });

  it('reads the named department instead of the whole organisation', () => {
    // emp-3 is the only customer_service member scheduled, so that department is
    // Critical while the organisation of three reads Healthy.
    const coverage = [
      projected({
        workDate: MONDAY,
        scheduled: ['emp-1', 'emp-2', 'emp-3'],
        withDepartments: true,
      }),
    ];
    expect(coverage[0].status).toBe('healthy');
    expect(coverageRiskForRequest({ ranges, coverage })).toBe('healthy');
    expect(coverageRiskForRequest({ ranges, coverage, department: 'sales' })).toBe(
      'at_minimum',
    );
    expect(
      coverageRiskForRequest({ ranges, coverage, department: 'customer_service' }),
    ).toBe('critical');
  });

  it('reads the whole-date figure when the projection carries no breakdown', () => {
    // The ribbon's query asks for no departments, and its whole-date figure is
    // still the projection the service produced for that date.
    const coverage = [projected({ workDate: MONDAY, scheduled: ['emp-1'] })];
    expect(coverage[0].departments).toEqual([]);
    expect(coverageRiskForRequest({ ranges, coverage, department: 'sales' })).toBe('critical');
  });

  it('reports nothing when a breakdown names other departments but not this one', () => {
    const coverage = [
      projected({
        workDate: MONDAY,
        scheduled: ['emp-1', 'emp-2', 'emp-3'],
        withDepartments: true,
      }),
    ];
    expect(coverage[0].departments.map((entry) => entry.department)).toEqual([
      'sales',
      'customer_service',
    ]);
    expect(coverageRiskForRequest({ ranges, coverage, department: 'commercial' })).toBeNull();
  });

  it('reports nothing for a date whose slot has no configured requirement', () => {
    const coverage = [projected({ workDate: MONDAY, scheduled: [], threshold: null })];
    expect(coverage[0].status).toBe('healthy');
    expect(coverageRiskForRequest({ ranges, coverage })).toBe('healthy');
  });
});

// ─── Decision context ────────────────────────────────────────────────────────

describe('buildDecisionContext', () => {
  const context = (overrides: Partial<Parameters<typeof buildDecisionContext>[0]> = {}) =>
    buildDecisionContext({ request: request(), remainingBalance: 10, ...overrides });

  it('reports the working dates an approval would debit', () => {
    const built = context();
    expect(built.approvedDates).toEqual([MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY]);
    expect(built.workingDays).toBe(5);
    expect(built.balanceField).toBe('vacation_used');
  });

  it('reports the balance before and after approval', () => {
    const built = context({ remainingBalance: 8 });
    expect(built.balanceBefore).toBe(8);
    expect(built.balanceAfter).toBe(3);
    expect(built.shortfallDays).toBe(0);
  });

  it('shows an approval that would overdraw the balance as a negative figure', () => {
    const built = context({ remainingBalance: 2 });
    expect(built.balanceAfter).toBe(-3);
    expect(built.shortfallDays).toBe(3);
  });

  it('follows the sub-ranges a partial approval is contemplating', () => {
    const built = context({
      approvedRanges: [{ from: MONDAY, to: TUESDAY }],
      remainingBalance: 8,
    });
    expect(built.approvedDates).toEqual([MONDAY, TUESDAY]);
    expect(built.workingDays).toBe(2);
    expect(built.balanceAfter).toBe(6);
    expect(built.requestedRange).toEqual({ from: MONDAY, to: FRIDAY });
  });

  it('excludes closed dates from the debit it would apply', () => {
    expect(context({ closedDates: new Set([WEDNESDAY]) }).workingDays).toBe(4);
  });

  it('reports the calendar days of notice and the short-notice condition', () => {
    expect(context().noticeDays).toBe(26);
    expect(context().shortNotice).toBe(false);

    const late = context({
      request: request({ submissionDate: '2026-07-20', startDate: MONDAY, endDate: MONDAY }),
    });
    expect(late.noticeDays).toBe(7);
    expect(late.shortNotice).toBe(true);
  });

  it('lists the requester’s other approved absences inside the fortnight', () => {
    const built = context({
      approvedAbsences: [
        absence({ requestId: 'near-after', range: { from: '2026-08-03', to: '2026-08-04' } }),
        absence({ requestId: 'near-before', range: { from: '2026-07-20', to: '2026-07-21' } }),
      ],
    });
    expect(built.nearbyAbsences.map((entry) => entry.requestId)).toEqual([
      'near-before',
      'near-after',
    ]);
  });

  it('includes an absence exactly a fortnight from the requested range', () => {
    const built = context({
      approvedAbsences: [
        absence({ requestId: 'edge', range: { from: '2026-08-14', to: '2026-08-14' } }),
      ],
    });
    expect(calendarDaysBetween(FRIDAY, '2026-08-14')).toBe(NEARBY_ABSENCE_DAYS);
    expect(built.nearbyAbsences.map((entry) => entry.requestId)).toEqual(['edge']);
  });

  it('excludes an absence beyond the fortnight', () => {
    const built = context({
      approvedAbsences: [
        absence({ requestId: 'far', range: { from: '2026-08-15', to: '2026-08-15' } }),
      ],
    });
    expect(built.nearbyAbsences).toEqual([]);
  });

  it('excludes another employee’s absence and the request’s own', () => {
    const built = context({
      approvedAbsences: [
        absence({ requestId: 'someone-else', profileId: 'emp-2' }),
        absence({ requestId: 'req-1' }),
      ],
    });
    expect(built.nearbyAbsences).toEqual([]);
  });

  it('lists other pending requests overlapping the range, from any employee', () => {
    const built = context({
      otherRequests: [
        request({ id: 'other-emp', profileId: 'emp-2', startDate: WEDNESDAY, endDate: THURSDAY }),
        request({ id: 'same-emp', startDate: FRIDAY, endDate: SATURDAY }),
      ],
    });
    expect(built.overlappingPending.map((entry) => entry.id)).toEqual([
      'other-emp',
      'same-emp',
    ]);
  });

  it('excludes the request under decision from its own conflicts', () => {
    const built = context({ otherRequests: [request()] });
    expect(built.overlappingPending).toEqual([]);
  });

  it('excludes requests that are not pending and requests that do not overlap', () => {
    const built = context({
      otherRequests: [
        request({ id: 'decided', profileId: 'emp-2', status: 'approved' }),
        request({ id: 'waitlisted', profileId: 'emp-2', status: 'waitlisted' }),
        request({
          id: 'elsewhere',
          profileId: 'emp-2',
          startDate: '2026-09-01',
          endDate: '2026-09-02',
        }),
      ],
    });
    expect(built.overlappingPending).toEqual([]);
  });

  it('counts an adjacent request as overlapping only when a date is shared', () => {
    const touching = context({
      otherRequests: [
        request({ id: 'touching', profileId: 'emp-2', startDate: FRIDAY, endDate: '2026-08-05' }),
      ],
    });
    expect(touching.overlappingPending.map((entry) => entry.id)).toEqual(['touching']);

    const adjacent = context({
      otherRequests: [
        request({
          id: 'adjacent',
          profileId: 'emp-2',
          startDate: SATURDAY,
          endDate: '2026-08-05',
        }),
      ],
    });
    expect(adjacent.overlappingPending).toEqual([]);
  });

  it('lists the employees scheduled on the requested dates as backup', () => {
    const schedules: ScheduledShift[] = [
      { profileId: 'emp-1', workDate: MONDAY },
      { profileId: 'emp-2', workDate: MONDAY },
      { profileId: 'emp-3', workDate: TUESDAY },
    ];
    const built = context({ schedules });

    expect(built.backupProfileIds).toEqual(['emp-2', 'emp-3']);
    expect(built.backupsByDate.slice(0, 3)).toEqual([
      { workDate: MONDAY, profileIds: ['emp-2'] },
      { workDate: TUESDAY, profileIds: ['emp-3'] },
      { workDate: WEDNESDAY, profileIds: [] },
    ]);
  });

  it('excludes an employee holding an approved absence on the date', () => {
    const built = context({
      schedules: [
        { profileId: 'emp-2', workDate: MONDAY },
        { profileId: 'emp-2', workDate: TUESDAY },
        { profileId: 'emp-3', workDate: MONDAY },
      ],
      approvedAbsences: [
        absence({ requestId: 'away', profileId: 'emp-2', range: { from: MONDAY, to: MONDAY } }),
      ],
    });

    expect(built.backupsByDate[0]).toEqual({ workDate: MONDAY, profileIds: ['emp-3'] });
    expect(built.backupsByDate[1]).toEqual({ workDate: TUESDAY, profileIds: ['emp-2'] });
    expect(built.backupProfileIds).toEqual(['emp-2', 'emp-3']);
  });

  it('never lists the requester as their own backup', () => {
    const built = context({
      schedules: [{ profileId: 'emp-1', workDate: MONDAY }],
    });
    expect(built.backupProfileIds).toEqual([]);
  });

  it('reports one backup entry per requested working date', () => {
    const built = context({ closedDates: new Set([WEDNESDAY]) });
    expect(built.backupsByDate.map((entry) => entry.workDate)).toEqual([
      MONDAY,
      TUESDAY,
      THURSDAY,
      FRIDAY,
    ]);
  });

  it('counts a duplicated schedule row once', () => {
    const built = context({
      schedules: [
        { profileId: 'emp-2', workDate: MONDAY },
        { profileId: 'emp-2', workDate: MONDAY },
      ],
    });
    expect(built.backupsByDate[0]).toEqual({ workDate: MONDAY, profileIds: ['emp-2'] });
  });

  it('rejects a request type the database constraint does not accept', () => {
    expect(() =>
      context({ request: request({ ptoType: 'birthday' as unknown as PTOType }) }),
    ).toThrow(RangeError);
  });
});

// ─── The inbox row ───────────────────────────────────────────────────────────

describe('buildRequestRow', () => {
  const built = (overrides: Partial<Parameters<typeof buildRequestRow>[0]> = {}) =>
    buildRequestRow({ request: request(), evaluatedAt: EVALUATED_AT, ...overrides });

  it('carries the twelve fields the inbox row displays', () => {
    const inboxRow = built({
      subject: { profileId: 'emp-1', employeeName: 'Ana Ruiz', department: 'sales' },
      balance: balanceRow({ vacation_used: 2 }),
      coverage: [projected({ workDate: MONDAY, scheduled: ['emp-1', 'emp-2'] })],
    });

    expect(inboxRow).toEqual({
      requestId: 'req-1',
      profileId: 'emp-1',
      employeeName: 'Ana Ruiz',
      department: 'sales',
      ptoType: 'vacation',
      startDate: MONDAY,
      endDate: FRIDAY,
      workingDays: 5,
      status: 'pending',
      remainingBalance: 8,
      coverageRisk: 'at_minimum',
      submittedAt: SUBMITTED_AT,
      awaitingReviewMinutes: 1440,
      pending: true,
      shortNotice: false,
    });
  });

  it('reports the employee as unresolved when no subject is supplied', () => {
    const inboxRow = built();
    expect(inboxRow.employeeName).toBeNull();
    expect(inboxRow.department).toBeNull();
  });

  it('ignores a subject describing a different employee', () => {
    const inboxRow = built({
      subject: { profileId: 'emp-2', employeeName: 'Someone Else', department: 'commercial' },
    });
    expect(inboxRow.employeeName).toBeNull();
    expect(inboxRow.department).toBeNull();
  });

  it('prefers the working-day count the request stored at submission', () => {
    expect(built({ request: request({ workingDays: 4 }) }).workingDays).toBe(4);
  });

  it('recomputes the working days for a row that stored none', () => {
    expect(built({ request: request({ workingDays: null }) }).workingDays).toBe(5);
    expect(
      built({
        request: request({ workingDays: null }),
        closedDates: new Set([WEDNESDAY]),
      }).workingDays,
    ).toBe(4);
  });

  it('measures the wait to the evaluation instant while the request is pending', () => {
    expect(built({ evaluatedAt: '2026-07-01T15:30:00.000Z' }).awaitingReviewMinutes).toBe(90);
  });

  it('measures the wait to the decision once the request has one', () => {
    const inboxRow = built({
      request: request({ status: 'approved', decidedAt: '2026-07-01T15:00:00.000Z' }),
      evaluatedAt: '2026-07-09T15:00:00.000Z',
    });
    expect(inboxRow.awaitingReviewMinutes).toBe(60);
    expect(inboxRow.pending).toBe(false);
  });

  it('reports no wait rather than a negative one when the timestamps disagree', () => {
    const inboxRow = built({
      request: request({ decidedAt: '2026-06-30T15:00:00.000Z' }),
    });
    expect(inboxRow.awaitingReviewMinutes).toBe(0);
  });

  it('reports no wait for a submission instant it cannot read', () => {
    expect(built({ request: request({ submittedAt: 'not an instant' }) }).awaitingReviewMinutes).toBe(0);
  });

  it('reports the remaining balance as unknown when none is supplied', () => {
    expect(built().remainingBalance).toBeNull();
    expect(built({ balance: null }).remainingBalance).toBeNull();
  });

  it('reports the coverage risk as unknown when no projection is supplied', () => {
    expect(built().coverageRisk).toBeNull();
    expect(built({ coverage: [] }).coverageRisk).toBeNull();
  });

  it('reads the coverage risk for the requester’s own department', () => {
    const coverage = [
      projected({
        workDate: MONDAY,
        scheduled: ['emp-1', 'emp-2', 'emp-3'],
        withDepartments: true,
      }),
    ];
    expect(
      built({
        subject: { profileId: 'emp-3', employeeName: 'Iris', department: 'customer_service' },
        request: request({ profileId: 'emp-3' }),
        coverage,
      }).coverageRisk,
    ).toBe('critical');
  });

  it('prefers the short-notice condition the request stored', () => {
    expect(built({ request: request({ shortNotice: true }) }).shortNotice).toBe(true);
    expect(
      built({
        request: request({ shortNotice: false, submissionDate: FRIDAY, startDate: FRIDAY }),
      }).shortNotice,
    ).toBe(false);
  });

  it('applies the short-notice test to a row that stored no flag', () => {
    expect(
      built({ request: request({ submissionDate: '2026-07-20' }) }).shortNotice,
    ).toBe(true);
    expect(built({ request: request({ submissionDate: '2026-07-13' }) }).shortNotice).toBe(
      false,
    );
  });

  it('marks exactly the pending requests as pending', () => {
    for (const status of ALL_STATUSES) {
      expect(built({ request: request({ status }) }).pending).toBe(status === 'pending');
      expect(isPendingRequest(status)).toBe(status === 'pending');
    }
  });

  it('refuses an evaluation instant it cannot read', () => {
    expect(() => built({ evaluatedAt: 'yesterday' })).toThrow(RangeError);
  });

  it('rejects a request type the database constraint does not accept', () => {
    expect(() =>
      built({ request: request({ ptoType: 'birthday' as unknown as PTOType }) }),
    ).toThrow(RangeError);
  });
});

// ─── Order ───────────────────────────────────────────────────────────────────

describe('compareRequestRows', () => {
  it('places every pending request before every decided one', () => {
    const rows = [
      row({ requestId: 'decided-old', status: 'approved', pending: false, submittedAt: '2026-01-01T00:00:00.000Z' }),
      row({ requestId: 'pending-new', submittedAt: '2026-07-05T00:00:00.000Z' }),
    ];
    expect(orderRequestRows(rows).map((entry) => entry.requestId)).toEqual([
      'pending-new',
      'decided-old',
    ]);
  });

  it('places the longest-waiting request first inside each group', () => {
    const rows = [
      row({ requestId: 'newer', submittedAt: '2026-07-05T00:00:00.000Z' }),
      row({ requestId: 'older', submittedAt: '2026-07-01T00:00:00.000Z' }),
    ];
    expect(orderRequestRows(rows).map((entry) => entry.requestId)).toEqual(['older', 'newer']);
  });

  it('settles a tie by request identifier, so the order is total', () => {
    const rows = [row({ requestId: 'b' }), row({ requestId: 'a' })];
    expect(orderRequestRows(rows).map((entry) => entry.requestId)).toEqual(['a', 'b']);
    expect(compareRequestRows(rows[0], rows[0])).toBe(0);
  });

  it('does not depend on the order the rows arrived in', () => {
    const rows = [
      row({ requestId: 'p2', submittedAt: '2026-07-02T00:00:00.000Z' }),
      row({ requestId: 'd1', status: 'denied', pending: false, submittedAt: '2026-06-01T00:00:00.000Z' }),
      row({ requestId: 'p1', submittedAt: '2026-07-01T00:00:00.000Z' }),
    ];
    const forwards = orderRequestRows(rows).map((entry) => entry.requestId);
    const backwards = orderRequestRows([...rows].reverse()).map((entry) => entry.requestId);
    expect(forwards).toEqual(['p1', 'p2', 'd1']);
    expect(backwards).toEqual(forwards);
  });

  it('does not mutate the rows it is given', () => {
    const rows = [row({ requestId: 'b' }), row({ requestId: 'a' })];
    orderRequestRows(rows);
    expect(rows.map((entry) => entry.requestId)).toEqual(['b', 'a']);
  });
});

// ─── Filters ─────────────────────────────────────────────────────────────────

describe('matchesRequestQuery', () => {
  it('matches every row when no filter is active', () => {
    expect(matchesRequestQuery(row())).toBe(true);
    expect(matchesRequestQuery(row(), {})).toBe(true);
  });

  it('offers the four status filter values Requirement 7.7 names', () => {
    expect([...REQUEST_STATUS_FILTERS]).toEqual(['pending', 'approved', 'denied', 'cancelled']);
    for (const status of REQUEST_STATUS_FILTERS) {
      expect(matchesRequestQuery(row({ status }), { statuses: [status] })).toBe(true);
      expect(matchesRequestQuery(row({ status: 'waitlisted' }), { statuses: [status] })).toBe(
        false,
      );
    }
  });

  it('filters by department, employee, and request type', () => {
    expect(matchesRequestQuery(row(), { departments: ['sales'] })).toBe(true);
    expect(matchesRequestQuery(row(), { departments: ['commercial'] })).toBe(false);

    expect(matchesRequestQuery(row(), { profileIds: ['emp-1', 'emp-2'] })).toBe(true);
    expect(matchesRequestQuery(row(), { profileIds: ['emp-2'] })).toBe(false);

    expect(matchesRequestQuery(row(), { ptoTypes: ['vacation'] })).toBe(true);
    expect(matchesRequestQuery(row(), { ptoTypes: ['sick'] })).toBe(false);
  });

  it('does not match a department filter it cannot confirm for the row', () => {
    expect(matchesRequestQuery(row({ department: null }), { departments: ['sales'] })).toBe(
      false,
    );
  });

  it('filters by coverage risk and does not match an unknown indicator', () => {
    expect(matchesRequestQuery(row({ coverageRisk: 'critical' }), { coverageRisks: ['critical'] })).toBe(true);
    expect(matchesRequestQuery(row({ coverageRisk: 'healthy' }), { coverageRisks: ['critical'] })).toBe(false);
    expect(matchesRequestQuery(row({ coverageRisk: null }), { coverageRisks: ['critical'] })).toBe(false);
  });

  it('matches a request whose dates overlap the active range', () => {
    expect(matchesRequestQuery(row(), { from: WEDNESDAY, to: '2026-08-31' })).toBe(true);
    expect(matchesRequestQuery(row(), { from: '2026-07-01', to: MONDAY })).toBe(true);
    expect(matchesRequestQuery(row(), { from: '2026-08-01', to: '2026-08-31' })).toBe(false);
    expect(matchesRequestQuery(row(), { from: '2026-06-01', to: '2026-06-30' })).toBe(false);
  });

  it('treats a one-sided range as an open bound', () => {
    expect(matchesRequestQuery(row(), { from: FRIDAY })).toBe(true);
    expect(matchesRequestQuery(row(), { from: SATURDAY })).toBe(false);
    expect(matchesRequestQuery(row(), { to: MONDAY })).toBe(true);
    expect(matchesRequestQuery(row(), { to: '2026-07-26' })).toBe(false);
  });

  it('matches nothing against an empty filter list', () => {
    expect(matchesRequestQuery(row(), { statuses: [] })).toBe(false);
    expect(matchesRequestQuery(row(), { departments: [] })).toBe(false);
    expect(matchesRequestQuery(row(), { profileIds: [] })).toBe(false);
    expect(matchesRequestQuery(row(), { ptoTypes: [] })).toBe(false);
    expect(matchesRequestQuery(row(), { coverageRisks: [] })).toBe(false);
  });

  it('applies every active filter as a conjunction', () => {
    const query = {
      statuses: ['pending'] as const,
      departments: ['sales'] as const,
      profileIds: ['emp-1'] as const,
      ptoTypes: ['vacation'] as const,
      from: MONDAY,
      to: FRIDAY,
      coverageRisks: ['healthy'] as const,
    };
    expect(matchesRequestQuery(row(), query)).toBe(true);
    expect(matchesRequestQuery(row({ ptoType: 'sick' }), query)).toBe(false);
  });

  it('keeps the matching rows in the order they were given', () => {
    const rows = [row({ requestId: 'a' }), row({ requestId: 'b', ptoType: 'sick' }), row({ requestId: 'c' })];
    expect(filterRequestRows(rows, { ptoTypes: ['vacation'] }).map((entry) => entry.requestId)).toEqual(['a', 'c']);
  });
});

// ─── Paging ──────────────────────────────────────────────────────────────────

describe('requestPageLimit', () => {
  it('defaults to the 50-row cap', () => {
    expect(requestPageLimit()).toBe(REQUEST_PAGE_LIMIT);
    expect(REQUEST_PAGE_LIMIT).toBe(50);
  });

  it('caps a larger request at 50 rows', () => {
    expect(requestPageLimit(1000)).toBe(50);
    expect(requestPageLimit(51)).toBe(50);
  });

  it('accepts a smaller page and floors it at one row', () => {
    expect(requestPageLimit(20)).toBe(20);
    expect(requestPageLimit(0)).toBe(1);
    expect(requestPageLimit(-5)).toBe(1);
  });

  it('ignores a limit that is not a number', () => {
    expect(requestPageLimit(Number.NaN)).toBe(REQUEST_PAGE_LIMIT);
  });
});

describe('buildRequestInbox', () => {
  /** 120 pending rows, newest first, so ordering has something to correct. */
  const manyRows = Array.from({ length: 120 }, (_, index) =>
    row({
      requestId: `req-${String(120 - index).padStart(3, '0')}`,
      submittedAt: `2026-07-${String(((120 - index) % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }),
  );

  it('loads at most 50 rows in a page', () => {
    const page = buildRequestInbox(manyRows);
    expect(page.rows).toHaveLength(REQUEST_PAGE_LIMIT);
    expect(page.limit).toBe(REQUEST_PAGE_LIMIT);
    expect(page.totalRows).toBe(120);
    expect(page.totalPages).toBe(3);
  });

  it('caps a page size the caller asks to exceed', () => {
    expect(buildRequestInbox(manyRows, { limit: 500 }).rows).toHaveLength(REQUEST_PAGE_LIMIT);
  });

  it('returns the requested page', () => {
    const first = buildRequestInbox(manyRows, { limit: 10, page: 1 });
    const second = buildRequestInbox(manyRows, { limit: 10, page: 2 });

    expect(first.rows).toHaveLength(10);
    expect(second.rows).toHaveLength(10);
    expect(second.page).toBe(2);
    expect(first.rows.map((entry) => entry.requestId)).not.toEqual(
      second.rows.map((entry) => entry.requestId),
    );
  });

  it('returns no rows for a page beyond the last', () => {
    const page = buildRequestInbox(manyRows, { limit: 50, page: 9 });
    expect(page.rows).toEqual([]);
    expect(page.page).toBe(9);
    expect(page.totalPages).toBe(3);
  });

  it('reports a first page even when nothing matches', () => {
    const page = buildRequestInbox(manyRows, { ptoTypes: ['sick'] });
    expect(page.rows).toEqual([]);
    expect(page.totalRows).toBe(0);
    expect(page.totalPages).toBe(1);
  });

  it('filters before it orders and pages', () => {
    const rows = [
      row({ requestId: 'decided', status: 'approved', pending: false, submittedAt: '2026-06-01T00:00:00.000Z' }),
      row({ requestId: 'pending-b', submittedAt: '2026-07-05T00:00:00.000Z' }),
      row({ requestId: 'pending-a', submittedAt: '2026-07-01T00:00:00.000Z' }),
    ];

    const all = buildRequestInbox(rows);
    expect(all.rows.map((entry) => entry.requestId)).toEqual([
      'pending-a',
      'pending-b',
      'decided',
    ]);

    const pendingOnly = buildRequestInbox(rows, { statuses: ['pending'] });
    expect(pendingOnly.rows.map((entry) => entry.requestId)).toEqual([
      'pending-a',
      'pending-b',
    ]);
    expect(pendingOnly.totalRows).toBe(2);
  });

  it('carries the query the page was produced under', () => {
    const query = { statuses: ['pending'] as const, page: 2, limit: 10 };
    expect(buildRequestInbox(manyRows, query).query).toEqual(query);
  });

  it('does not mutate the rows it is given', () => {
    const rows = [row({ requestId: 'b' }), row({ requestId: 'a' })];
    buildRequestInbox(rows);
    expect(rows.map((entry) => entry.requestId)).toEqual(['b', 'a']);
  });
});

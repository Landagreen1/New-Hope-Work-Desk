// src/features/time-attendance/domain/__tests__/attendance-records.test.ts
// Example tests for range derivation, record queries, and metric aggregation.
//
// Feature: time-attendance-ui-redesign, task 3.3
//
// One worked range across nine employees, then the queries and the metrics read
// off it. The universal statements — one record per employee and work date,
// metric and row agreement, query shaping — are covered by Properties 1, 29,
// and 30.
//
// Requirements: 3.1, 3.2, 12.3, 12.20, 13.3, 13.5

import { describe, expect, it } from 'vitest';
import {
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  SAVED_FILTER_IDS,
  aggregateMetrics,
  collapseAttendanceInputs,
  deriveDailyAttendance,
  deriveRange,
  filterRecords,
  matchesRecordQuery,
  mergeRecordQuery,
  metricOf,
  recordQueryForMetric,
  recordRowKey,
} from '../attendance';
import type { MetricKey, RecordSubject, RecordSubjectIndex } from '../attendance';
import type {
  AttendanceInputs,
  AttendancePolicy,
  ClockSessionInput,
  DailyAttendanceRecord,
} from '../types';
import type { Department } from '../../types';

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

/** Late enough that a 17:00 shift is over and its clock-out tolerance has run out. */
const EVALUATED_AT = eastern('20:00:00');

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

function lunch(start: string, end: string, durationMinutes: number): ClockSessionInput['breaks'] {
  return [{ id: `b-${start}`, type: 'lunch', start, end, durationMinutes }];
}

function inputs(profileId: string, overrides: Partial<AttendanceInputs> = {}): AttendanceInputs {
  return {
    profileId,
    workDate: WORK_DATE,
    employeeTimezone: 'America/New_York',
    schedule: { start: '09:00:00', end: '17:00:00', shiftType: 'regular', status: 'published' },
    sessions: [],
    approvedAbsence: null,
    unscheduledWorkApproved: false,
    reviewedAt: null,
    policy: POLICY,
    evaluatedAt: EVALUATED_AT,
    ...overrides,
  };
}

/**
 * Nine employees on one date, one per interesting outcome: a clean day, a late
 * arrival, an absence, unapproved unscheduled work, an open session past its
 * tolerance, approved time off, a shift under way with no clock-in, an early
 * departure, and a break overrun.
 */
const RANGE_INPUTS: AttendanceInputs[] = [
  inputs('p1', {
    sessions: [
      session('s1', eastern('09:00:00'), eastern('17:00:00'), lunch(eastern('12:00:00'), eastern('13:00:00'), 60)),
    ],
  }),
  inputs('p2', { sessions: [session('s2', eastern('09:20:00'), eastern('17:00:00'))] }),
  inputs('p3'),
  inputs('p4', {
    schedule: null,
    sessions: [session('s4', eastern('10:00:00'), eastern('14:00:00'))],
  }),
  inputs('p5', { sessions: [session('s5', eastern('09:00:00'), null)] }),
  inputs('p6', { approvedAbsence: { requestId: 'r6', ptoType: 'vacation' } }),
  inputs('p7', {
    schedule: { start: '19:00:00', end: '23:00:00', shiftType: 'regular', status: 'published' },
  }),
  inputs('p8', { sessions: [session('s8', eastern('09:00:00'), eastern('16:00:00'))] }),
  inputs('p9', {
    sessions: [
      session('s9', eastern('09:00:00'), eastern('17:00:00'), lunch(eastern('12:00:00'), eastern('13:30:00'), 90)),
    ],
  }),
];

const DEPARTMENTS: Record<string, Department> = {
  p1: 'sales',
  p2: 'sales',
  p3: 'customer_service',
  p4: 'customer_service',
  p5: 'commercial',
  p6: 'commercial',
  p7: 'management',
  p8: 'management',
  p9: 'management',
};

function subjectIndex(): RecordSubjectIndex {
  const entries: [string, RecordSubject][] = Object.entries(DEPARTMENTS).map(
    ([profileId, department]) => [profileId, { profileId, department }],
  );
  return new Map(entries);
}

const RECORDS = deriveRange(RANGE_INPUTS);

function recordFor(profileId: string): DailyAttendanceRecord {
  const record = RECORDS.find((candidate) => candidate.profileId === profileId);
  if (!record) throw new Error(`no record derived for ${profileId}`);
  return record;
}

function profileIdsMatching(query: Parameters<typeof filterRecords>[1]): string[] {
  return filterRecords(RECORDS, query, subjectIndex()).map((record) => record.profileId);
}

describe('record assembly', () => {
  it('carries the rule that assigned the status and the exceptions that hold', () => {
    const record = recordFor('p2');

    expect(record.derivedStatus).toBe('late');
    expect(record.statusRuleId).toBe('AS-09');
    expect(record.lateMinutes).toBe(20);
    expect(record.exceptions.map((exception) => exception.code)).toEqual(['late_arrival']);
    expect(record.exceptions[0].ruleId).toBe('AX-03');
    expect(record.exceptions[0].ruleDescription).not.toBe('');
  });

  it('reports payroll blocking as the OR of the exception flags', () => {
    expect(recordFor('p4').payrollBlocking).toBe(true); // unapproved unscheduled work
    expect(recordFor('p5').payrollBlocking).toBe(true); // missing clock-out
    expect(recordFor('p7').payrollBlocking).toBe(true); // missing clock-in while scheduled
    expect(recordFor('p9').payrollBlocking).toBe(false); // break overrun does not hold pay
  });

  it('exposes the scheduled span as instants and the hours the context computed', () => {
    const record = recordFor('p1');

    expect(record.scheduledStart).toBe(eastern('09:00:00'));
    expect(record.scheduledEnd).toBe(eastern('17:00:00'));
    expect(record.scheduledHours).toBe(8);
    expect(record.workedHours).toBe(7);
    expect(record.unpaidBreakMinutes).toBe(60);
    expect(record.paidBreakMinutes).toBe(0);
    expect(record.derivedStatus).toBe('completed');
  });

  it('measures an open session to the evaluation instant', () => {
    const record = recordFor('p5');

    expect(record.hasOpenSession).toBe(true);
    expect(record.lastClockOut).toBeNull();
    expect(record.workedHours).toBe(11); // 09:00 to the 20:00 evaluation instant
    expect(record.derivedStatus).toBe('missing_clock_out');
  });
});

describe('range derivation', () => {
  it('produces one record per employee per work date', () => {
    const keys = RECORDS.map(recordRowKey);

    expect(RECORDS).toHaveLength(RANGE_INPUTS.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keys a record once even when it carries several exceptions', () => {
    const twoExceptions = deriveDailyAttendance(
      inputs('p10', {
        sessions: [
          session(
            's10',
            eastern('09:30:00'),
            eastern('15:00:00'),
            lunch(eastern('12:00:00'), eastern('13:30:00'), 90),
          ),
        ],
      }),
    );

    expect(twoExceptions.exceptions.map((exception) => exception.code)).toEqual([
      'late_arrival',
      'early_departure',
      'break_overrun',
    ]);
    expect(recordRowKey(twoExceptions)).toBe('p10:2026-07-28');
  });

  it('merges duplicate inputs for one employee and date without losing sessions', () => {
    const draft = inputs('p1', {
      schedule: { start: '08:00:00', end: '12:00:00', shiftType: 'regular', status: 'scheduled' },
      sessions: [session('a', eastern('09:00:00'), eastern('11:00:00'))],
      reviewedAt: eastern('10:00:00', '2026-07-30'),
    });
    const published = inputs('p1', {
      sessions: [session('b', eastern('12:00:00'), eastern('17:00:00'))],
      unscheduledWorkApproved: true,
      reviewedAt: eastern('10:00:00', '2026-07-29'),
    });

    const [record] = deriveRange([draft, published]);

    expect(record.sessions.map((row) => row.id)).toEqual(['a', 'b']);
    expect(record.scheduledStart).toBe(eastern('09:00:00')); // the row recording expected work
    expect(record.scheduledHours).toBe(8);
    expect(record.workedHours).toBe(7);
    expect(record.reviewedAt).toBe(eastern('10:00:00', '2026-07-29')); // the first review
  });

  it('collapses duplicate session ids and does not depend on input order', () => {
    const first = inputs('p1', { sessions: [session('a', eastern('09:00:00'), eastern('12:00:00'))] });
    const second = inputs('p1', {
      sessions: [
        session('a', eastern('09:00:00'), eastern('12:00:00')),
        session('b', eastern('13:00:00'), eastern('17:00:00')),
      ],
    });

    const forwards = deriveRange([first, second]);
    const backwards = deriveRange([second, first]);

    expect(forwards).toHaveLength(1);
    expect(forwards[0].sessions.map((row) => row.id)).toEqual(['a', 'b']);
    expect(backwards).toEqual(forwards);
  });

  it('orders records by work date then employee', () => {
    const shuffled = deriveRange([
      inputs('p2', { workDate: '2026-07-29' }),
      inputs('p1', { workDate: '2026-07-29' }),
      inputs('p2'),
      inputs('p1'),
    ]);

    expect(shuffled.map(recordRowKey)).toEqual([
      'p1:2026-07-28',
      'p2:2026-07-28',
      'p1:2026-07-29',
      'p2:2026-07-29',
    ]);
  });

  it('collapses inputs before deriving, so the collapse and the range agree', () => {
    const collapsed = collapseAttendanceInputs(RANGE_INPUTS);

    expect(collapsed).toHaveLength(RANGE_INPUTS.length);
    expect(collapsed.map((row) => row.profileId)).toEqual(RECORDS.map((record) => record.profileId));
  });
});

describe('record queries', () => {
  it('offers the thirteen saved filters in the stated order', () => {
    expect(SAVED_FILTER_IDS).toEqual([
      'needs_attention',
      'payroll_blocking',
      'missing_punches',
      'missing_clock_ins',
      'missing_clock_outs',
      'late_arrivals',
      'early_departures',
      'absences',
      'break_issues',
      'unscheduled_work',
      'pending_manager_approval',
      'corrected',
      'all_records',
    ]);
  });

  it('selects the records each saved filter names', () => {
    expect(profileIdsMatching({ savedFilter: 'needs_attention' })).toEqual([
      'p2',
      'p3',
      'p4',
      'p5',
      'p7',
      'p8',
      'p9',
    ]);
    expect(profileIdsMatching({ savedFilter: 'payroll_blocking' })).toEqual(['p4', 'p5', 'p7']);
    expect(profileIdsMatching({ savedFilter: 'missing_punches' })).toEqual(['p5', 'p7']);
    expect(profileIdsMatching({ savedFilter: 'missing_clock_ins' })).toEqual(['p7']);
    expect(profileIdsMatching({ savedFilter: 'missing_clock_outs' })).toEqual(['p5']);
    expect(profileIdsMatching({ savedFilter: 'late_arrivals' })).toEqual(['p2']);
    expect(profileIdsMatching({ savedFilter: 'early_departures' })).toEqual(['p8']);
    expect(profileIdsMatching({ savedFilter: 'absences' })).toEqual(['p3']);
    expect(profileIdsMatching({ savedFilter: 'break_issues' })).toEqual(['p9']);
    expect(profileIdsMatching({ savedFilter: 'unscheduled_work' })).toEqual(['p4']);
    expect(profileIdsMatching({ savedFilter: 'pending_manager_approval' })).toEqual(['p4']);
    expect(profileIdsMatching({ savedFilter: 'corrected' })).toEqual([]);
    expect(profileIdsMatching({ savedFilter: 'all_records' })).toHaveLength(RECORDS.length);
  });

  it('drops unscheduled work from pending approval once it is approved', () => {
    const approved = deriveDailyAttendance(
      inputs('p4', {
        schedule: null,
        sessions: [session('s4', eastern('10:00:00'), eastern('14:00:00'))],
        unscheduledWorkApproved: true,
      }),
    );

    expect(matchesRecordQuery(approved, { savedFilter: 'unscheduled_work' })).toBe(true);
    expect(matchesRecordQuery(approved, { savedFilter: 'pending_manager_approval' })).toBe(false);
    expect(approved.payrollBlocking).toBe(false);
  });

  it('selects corrected records from the recorded adjustment', () => {
    const corrected = deriveDailyAttendance(
      inputs('p1', {
        sessions: [
          {
            ...session('s1', eastern('09:00:00'), eastern('17:00:00')),
            adjustedBy: 'admin-1',
            adjustmentReason: 'Employee forgot to clock out',
          },
        ],
      }),
    );

    expect(matchesRecordQuery(corrected, { savedFilter: 'corrected' })).toBe(true);
  });

  it('applies the department, status, exception, review, and payroll filters', () => {
    expect(profileIdsMatching({ departments: ['sales'] })).toEqual(['p1', 'p2']);
    expect(profileIdsMatching({ statuses: ['completed'] })).toEqual(['p1', 'p9']);
    expect(profileIdsMatching({ exceptionCodes: ['break_overrun'] })).toEqual(['p9']);
    expect(profileIdsMatching({ payrollBlocking: false })).toEqual([
      'p1',
      'p2',
      'p3',
      'p6',
      'p8',
      'p9',
    ]);
    expect(profileIdsMatching({ reviewStatus: 'reviewed' })).toEqual([]);
    expect(profileIdsMatching({ reviewStatus: 'unreviewed' })).toHaveLength(RECORDS.length);
  });

  it('withholds a row when the department filter cannot be confirmed for it', () => {
    expect(filterRecords(RECORDS, { departments: ['sales'] })).toEqual([]);
  });

  it('bounds the work date inclusively', () => {
    const range = deriveRange([
      inputs('p1', { workDate: '2026-07-27' }),
      inputs('p1'),
      inputs('p1', { workDate: '2026-07-29' }),
    ]);

    expect(
      filterRecords(range, { from: '2026-07-28', to: '2026-07-28' }).map((row) => row.workDate),
    ).toEqual(['2026-07-28']);
    expect(filterRecords(range, { from: '2026-07-28' })).toHaveLength(2);
  });

  it('treats an empty list filter as satisfied by nothing', () => {
    expect(filterRecords(RECORDS, { profileIds: [] })).toEqual([]);
  });

  it('merges two queries into their conjunction', () => {
    const merged = mergeRecordQuery(
      { from: '2026-07-01', to: '2026-07-31', statuses: ['late', 'completed'], limit: 100 },
      { from: '2026-07-28', statuses: ['completed'], predicates: ['worked_day'] },
    );

    expect(merged).toEqual({
      from: '2026-07-28',
      to: '2026-07-31',
      statuses: ['completed'],
      predicates: ['worked_day'],
      limit: 100,
    });
  });

  it('keeps both constraints when two queries disagree on a single-valued filter', () => {
    const merged = mergeRecordQuery({ reviewStatus: 'reviewed' }, { reviewStatus: 'unreviewed' });

    expect(merged.reviewStatus).toBe('reviewed');
    expect(merged.predicates).toEqual(['unreviewed']);
    expect(filterRecords(RECORDS, merged)).toEqual([]);
  });
});

describe('metric aggregation', () => {
  const metrics = aggregateMetrics(RECORDS, {}, subjectIndex());

  it('reports all fourteen metrics in the stated order', () => {
    expect(METRIC_KEYS).toHaveLength(14);
    expect(metrics.metrics.map((metric) => metric.key)).toEqual(METRIC_KEYS);
    expect(metrics.recordCount).toBe(RECORDS.length);
  });

  it('computes each metric from the record set', () => {
    const value = (key: MetricKey): number => metricOf(metrics, key).value;

    expect(value('attendance_rate')).toBe(71.43); // 5 of 7 expected days clocked in
    expect(value('scheduled_hours')).toBe(60);
    expect(value('worked_hours')).toBe(43.17);
    expect(value('approved_payable_hours')).toBe(28.17); // excludes the two blocked records
    expect(value('overtime_hours')).toBe(7); // 4 unscheduled plus 3 past a scheduled end
    expect(value('late_arrival_count')).toBe(1);
    expect(value('total_late_minutes')).toBe(20);
    expect(value('early_departure_count')).toBe(1);
    expect(value('absence_count')).toBe(1);
    expect(value('time_off_days')).toBe(1);
    expect(value('missing_clock_in_count')).toBe(1);
    expect(value('missing_clock_out_count')).toBe(1);
    expect(value('unscheduled_work_count')).toBe(1);
    expect(value('break_exception_count')).toBe(1);
  });

  it('hands the drill-down the query that produced the metric', () => {
    for (const metric of metrics.metrics) {
      const rows = filterRecords(RECORDS, metric.query, subjectIndex());
      const definition = METRIC_DEFINITIONS.find((entry) => entry.key === metric.key);

      expect(metric.query).toEqual(recordQueryForMetric(metric.key, {}));
      expect(rows).toHaveLength(metric.recordCount);
      expect(definition?.aggregate(rows)).toBe(metric.value);
    }
  });

  it('narrows every metric by the active query', () => {
    const salesOnly = aggregateMetrics(RECORDS, { departments: ['sales'] }, subjectIndex());

    expect(salesOnly.recordCount).toBe(2);
    expect(metricOf(salesOnly, 'worked_hours').value).toBe(14.67); // p1 and p2 only
    expect(metricOf(salesOnly, 'absence_count').value).toBe(0);
    expect(metricOf(salesOnly, 'late_arrival_count').query.departments).toEqual(['sales']);
  });

  it('reports a vacant attendance rate as zero over no expected days', () => {
    const timeOffOnly = aggregateMetrics([recordFor('p6')]);

    expect(metricOf(timeOffOnly, 'attendance_rate').recordCount).toBe(0);
    expect(metricOf(timeOffOnly, 'attendance_rate').value).toBe(0);
    expect(metricOf(timeOffOnly, 'time_off_days').value).toBe(1);
  });
});

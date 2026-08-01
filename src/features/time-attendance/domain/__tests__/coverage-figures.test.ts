// src/features/time-attendance/domain/__tests__/coverage-figures.test.ts
// Example tests for the two coverage figures: Live_Coverage from derived status
// and Projected_Coverage from schedules and absences.
//
// Feature: time-attendance-ui-redesign, task 4.2
//
// The live records are derived through `deriveRange` rather than hand-built, so
// the statuses the headcounts read are the ones the Status Rule Matrix actually
// assigns. One department per interesting shape: a full roster mid-shift, a
// department whose approved leave outnumbers its schedule, a department with an
// unscheduled employee at work, and a department that has a requirement and
// nobody rostered.
//
// The universal statements — the headcount partition, the projection identity
// with its department partition, and the separation of live from projected —
// are covered by Properties 11, 12, and 13.
//
// Requirements: 6.2, 6.5, 6.6, 6.7, 6.8, 6.13, 6.14, 8.6, 8.7, 8.8, 19.4

import { describe, expect, it } from 'vitest';
import { deriveRange } from '../attendance';
import type { RecordSubject, RecordSubjectIndex } from '../attendance';
import { DEPARTMENT_ORDER, liveCoverage, projectCoverage } from '../coverage';
import type { DepartmentCoverage } from '../coverage';
import type { AttendanceInputs, AttendancePolicy, ClockSessionInput, Threshold } from '../types';
import type { Department } from '../../types';

const POLICY: AttendancePolicy = {
  businessTimezone: 'America/New_York',
  gracePeriodMinutes: 5,
  earlyDepartureToleranceMinutes: 15,
  missingClockOutToleranceMinutes: 120,
  unpaidBreakTypes: ['lunch'],
  breakOverrunMinutes: 60,
  effectiveStartDate: null,
};

/** 2026-07-28 is a summer weekday, so New York is UTC-4 that day. */
const WORK_DATE = '2026-07-28';
const PREVIOUS_DATE = '2026-07-27';

/** Midday: a 09:00–17:00 shift is under way and no clock-out is yet overdue. */
const EVALUATED_AT = eastern('13:00:00');

function eastern(time: string, date = WORK_DATE): string {
  return new Date(`${date}T${time}-04:00`).toISOString();
}

function openSession(clockIn: string, breaks: ClockSessionInput['breaks'] = []): ClockSessionInput {
  return { id: `s-${clockIn}`, clockIn, clockOut: null, breaks, adjustedBy: null, adjustmentReason: null };
}

/** A break that has been started and not ended, which is what On_Break reads. */
const OPEN_BREAK: ClockSessionInput['breaks'] = [
  { id: 'b1', type: 'lunch', start: eastern('12:30:00'), end: null, durationMinutes: null },
];

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
 * Ten employees at 13:00 on the work date.
 *
 * Sales has a full picture: one working, one on break, one scheduled who has not
 * clocked in, one on approved leave. Customer service has more approved leave
 * than schedule. Commercial has somebody working an unscheduled day alongside a
 * scheduled employee who has not arrived. `x1` is deliberately off the roster
 * and `y1` belongs to the previous date.
 */
const DAY_INPUTS: AttendanceInputs[] = [
  inputs('s1', { sessions: [openSession(eastern('09:00:00'))] }),
  inputs('s2', { sessions: [openSession(eastern('09:00:00'), OPEN_BREAK)] }),
  inputs('s3'),
  inputs('s4', { approvedAbsence: { requestId: 'r4', ptoType: 'vacation' } }),
  inputs('c1', { sessions: [openSession(eastern('09:00:00'))] }),
  inputs('c2', { schedule: null, approvedAbsence: { requestId: 'r2', ptoType: 'vacation' } }),
  inputs('m1', { schedule: null, sessions: [openSession(eastern('10:00:00'))] }),
  inputs('m2'),
  inputs('x1', { sessions: [openSession(eastern('09:00:00'))] }),
  inputs('y1', { workDate: PREVIOUS_DATE }),
];

const RECORDS = deriveRange(DAY_INPUTS);

const DEPARTMENTS: Record<string, Department> = {
  s1: 'sales',
  s2: 'sales',
  s3: 'sales',
  s4: 'sales',
  c1: 'customer_service',
  c2: 'customer_service',
  m1: 'commercial',
  m2: 'commercial',
  y1: 'sales',
};

function roster(): RecordSubjectIndex {
  const entries: [string, RecordSubject][] = Object.entries(DEPARTMENTS).map(
    ([profileId, department]) => [profileId, { profileId, department }],
  );
  return new Map(entries);
}

/** Commercial is deliberately unconfigured; management has nobody rostered. */
const LIVE_THRESHOLDS: ReadonlyMap<Department, Threshold | null> = new Map<Department, Threshold>([
  ['sales', { minimumStaff: 2, warningThreshold: 3 }],
  ['customer_service', { minimumStaff: 1, warningThreshold: 2 }],
  ['management', { minimumStaff: 1, warningThreshold: 2 }],
]);

function coverage(): DepartmentCoverage[] {
  return liveCoverage({
    workDate: WORK_DATE,
    records: RECORDS,
    roster: roster(),
    thresholds: LIVE_THRESHOLDS,
  });
}

function rowFor(department: Department): DepartmentCoverage {
  const row = coverage().find((candidate) => candidate.department === department);
  if (!row) throw new Error(`no coverage row for ${department}`);
  return row;
}

describe('liveCoverage', () => {
  it('reports the seven figures and the employees behind each headcount', () => {
    const sales = rowFor('sales');

    expect(sales).toMatchObject({
      department: 'sales',
      workDate: WORK_DATE,
      requiredStaff: 2,
      scheduled: 4,
      working: 1,
      onBreak: 1,
      approvedOff: 1,
      missing: 1,
      available: 1,
      status: 'critical',
    });
    expect(sales.scheduledProfileIds).toEqual(['s1', 's2', 's3', 's4']);
    expect(sales.workingProfileIds).toEqual(['s1']);
    expect(sales.onBreakProfileIds).toEqual(['s2']);
    expect(sales.approvedOffProfileIds).toEqual(['s4']);
    expect(sales.missingProfileIds).toEqual(['s3']);
  });

  it('excludes an employee on break from the working headcount and from available staffing', () => {
    const sales = rowFor('sales');

    expect(sales.workingProfileIds).not.toContain('s2');
    expect(sales.available).toBe(sales.working);
  });

  it('reports nobody missing when approved leave outnumbers the schedule', () => {
    // One scheduled employee at work, one on leave with no schedule for the
    // date. Every scheduled employee is accounted for, so the missing headcount
    // is zero because there is nobody to count — not because a negative
    // subtraction was floored (criterion 8).
    const customerService = rowFor('customer_service');

    expect(customerService).toMatchObject({
      scheduled: 1,
      working: 1,
      approvedOff: 1,
      missing: 0,
      status: 'at_minimum',
    });
    expect(customerService.missingProfileIds).toEqual([]);
  });

  it('counts a scheduled employee who is absent while somebody works unscheduled', () => {
    // `m1` works an unscheduled day, so the working headcount counts somebody
    // the scheduled figure does not, and `m2` is scheduled and has not arrived.
    // Counting the roster reports the one genuinely absent employee where
    // `scheduled − working − onBreak − approvedOff` would have floored to zero
    // (criteria 8 and 14).
    const commercial = rowFor('commercial');

    expect(commercial).toMatchObject({ scheduled: 1, working: 1, missing: 1 });
    expect(commercial.workingProfileIds).toEqual(['m1']);
    expect(commercial.missingProfileIds).toEqual(['m2']);
  });

  it('reports the missing headcount as the length of the employee list behind it', () => {
    for (const row of coverage()) {
      expect(row.missing).toBe(row.missingProfileIds.length);
    }
  });

  it('reports an unconfigured department as required-unconfigured and healthy', () => {
    const commercial = rowFor('commercial');

    expect(commercial.requiredStaff).toBeNull();
    expect(commercial.status).toBe('healthy');
  });

  it('carries a row for a department that has a requirement and nobody rostered', () => {
    const management = rowFor('management');

    expect(management).toMatchObject({
      requiredStaff: 1,
      scheduled: 0,
      working: 0,
      onBreak: 0,
      approvedOff: 0,
      missing: 0,
      available: 0,
      status: 'critical',
    });
    expect(management.scheduledProfileIds).toEqual([]);
  });

  it('ignores employees off the roster and records from another date', () => {
    const rows = coverage();
    const everyProfileId = rows.flatMap((row) => row.scheduledProfileIds.concat(row.workingProfileIds));

    // `y1` is rostered to sales but belongs to the previous date, and `x1` is
    // clocked in but on no roster.
    expect(rowFor('sales').scheduled).toBe(4);
    expect(everyProfileId).not.toContain('y1');
    expect(everyProfileId).not.toContain('x1');
  });

  it('returns one row per department in a stable order', () => {
    expect(coverage().map((row) => row.department)).toEqual(DEPARTMENT_ORDER);
  });

  it('counts an employee once when handed the same record twice', () => {
    const duplicated = liveCoverage({
      workDate: WORK_DATE,
      records: [...RECORDS, ...RECORDS],
      roster: roster(),
      thresholds: LIVE_THRESHOLDS,
    });

    expect(duplicated).toEqual(coverage());
  });

  it('reports every department empty when no records are supplied', () => {
    const rows = liveCoverage({
      workDate: WORK_DATE,
      records: [],
      roster: roster(),
      thresholds: LIVE_THRESHOLDS,
    });

    expect(rows.map((row) => row.scheduled)).toEqual([0, 0, 0, 0]);
    expect(rows.map((row) => row.missing)).toEqual([0, 0, 0, 0]);
  });
});

// ─── Projected coverage ──────────────────────────────────────────────────────

const PROJECTION_ROSTER: RecordSubjectIndex = new Map<string, RecordSubject>([
  ['p1', { profileId: 'p1', department: 'sales' }],
  ['p2', { profileId: 'p2', department: 'sales' }],
  ['p3', { profileId: 'p3', department: 'sales' }],
  ['p4', { profileId: 'p4', department: 'customer_service' }],
  ['p5', { profileId: 'p5', department: 'customer_service' }],
  ['p6', { profileId: 'p6', department: 'commercial' }],
]);

function projection(overrides: Partial<Parameters<typeof projectCoverage>[0]> = {}) {
  return projectCoverage({
    workDate: WORK_DATE,
    scheduledProfileIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
    approvedAbsenceProfileIds: [],
    proposedAbsenceProfileIds: [],
    threshold: null,
    ...overrides,
  });
}

describe('projectCoverage', () => {
  it('projects scheduled minus approved absences minus proposed absences', () => {
    const projected = projection({
      approvedAbsenceProfileIds: ['p1', 'p4'],
      proposedAbsenceProfileIds: ['p6'],
    });

    expect(projected).toMatchObject({
      workDate: WORK_DATE,
      scheduled: 6,
      approvedAbsences: 2,
      proposedAbsences: 1,
      available: 3,
      rawAvailable: 3,
      requiredStaff: null,
      status: 'healthy',
    });
  });

  it('floors the reported figure at zero and retains the raw arithmetic', () => {
    const projected = projection({
      scheduledProfileIds: ['p1'],
      approvedAbsenceProfileIds: ['p2', 'p3'],
      proposedAbsenceProfileIds: ['p4'],
    });

    expect(projected.available).toBe(0);
    expect(projected.rawAvailable).toBe(-2);
  });

  it('counts each employee once however many schedule rows name them', () => {
    const projected = projection({ scheduledProfileIds: ['p1', 'p1', 'p2'] });

    expect(projected.scheduled).toBe(2);
    expect(projected.scheduledProfileIds).toEqual(['p1', 'p2']);
  });

  it('costs exactly one for each additional approved absence', () => {
    const absent = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];

    for (let count = 0; count <= absent.length; count += 1) {
      const projected = projection({ approvedAbsenceProfileIds: absent.slice(0, count) });
      expect(projected.available).toBe(6 - count);
    }
  });

  it('classifies the projection against the threshold it is given', () => {
    const projected = projection({
      approvedAbsenceProfileIds: ['p1', 'p2', 'p3', 'p4'],
      threshold: { minimumStaff: 2, warningThreshold: 3 },
    });

    expect(projected).toMatchObject({ available: 2, requiredStaff: 2, status: 'at_minimum' });
  });

  it('restricts each department to its own roster and sums back to the organisation figure', () => {
    const projected = projection({
      approvedAbsenceProfileIds: ['p1'],
      proposedAbsenceProfileIds: ['p5'],
      roster: PROJECTION_ROSTER,
      departmentThresholds: new Map([['sales', { minimumStaff: 3, warningThreshold: 4 }]]),
    });

    expect(projected.departments.map((row) => [row.department, row.scheduled, row.available])).toEqual([
      ['sales', 3, 2],
      ['customer_service', 2, 1],
      ['commercial', 1, 1],
    ]);

    const summed = projected.departments.reduce((total, row) => total + row.available, 0);
    expect(summed).toBe(projected.available);
  });

  it('classifies each department against its own threshold', () => {
    const projected = projection({
      roster: PROJECTION_ROSTER,
      departmentThresholds: new Map([['sales', { minimumStaff: 3, warningThreshold: 4 }]]),
    });
    const sales = projected.departments.find((row) => row.department === 'sales');
    const commercial = projected.departments.find((row) => row.department === 'commercial');

    expect(sales).toMatchObject({ requiredStaff: 3, status: 'at_minimum' });
    expect(commercial).toMatchObject({ requiredStaff: null, status: 'healthy' });
  });

  it('carries no department breakdown when no roster is supplied', () => {
    expect(projection().departments).toEqual([]);
  });

  it('cannot be handed clock data, which is a compile-time guarantee', () => {
    const withClockData = {
      workDate: WORK_DATE,
      scheduledProfileIds: ['p1', 'p2'],
      approvedAbsenceProfileIds: [],
      proposedAbsenceProfileIds: [],
      threshold: null,
      sessions: [{ id: 'session-1', clockIn: eastern('09:00:00'), clockOut: null }],
    };

    // @ts-expect-error a projection input has nowhere to hold a clock session,
    // and the ban survives being passed through a variable, where excess
    // property checking would not apply.
    const projected = projectCoverage(withClockData);

    // The figure is unchanged by the session the type refused: projected
    // coverage reads schedules and absences only (Requirement 19.4).
    expect(projected.available).toBe(2);
  });
});

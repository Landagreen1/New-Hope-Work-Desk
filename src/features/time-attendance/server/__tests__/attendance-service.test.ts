// Example tests for the attendance-service read paths.
//
// Feature: time-attendance-ui-redesign, task 7.1
//
// Three things are asserted here, because they are the three ways a read of this
// shape goes wrong:
//
//   1. The outbound query count is a property of the function, not of the data.
//      A read that grows a query per employee or per date passes every
//      correctness check and then falls over on the real roster, so the tables
//      touched are asserted by name and by count.
//   2. Sessions are attributed to the shift they were worked against, not to the
//      calendar date their clock-in lands on. The fixture is built so that naive
//      bucketing and correct attribution disagree, and the assertion fails under
//      naive bucketing.
//   3. Status and hours come off the domain layer unchanged, the record page caps
//      at 100 rows, and scope is whatever `visibleProfileIds` says it is.
//
// The Supabase client is a small in-memory double that records every table it is
// asked for. Nothing is mocked in the domain layer: the records these tests read
// are produced by the real `deriveRange`.
//
// Requirements: 3.14, 3.15, 3.18, 12.4, 12.17, 12.19, 13.7, 14.2, 14.3, 14.6,
// 20.1, 20.2, 20.3, 20.8

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ATTENDANCE_POLICY } from '../policy';
import type { Actor } from '../visibility';
import {
  AttendanceServiceError,
  MAX_RANGE_DAYS,
  RECORDS_PAGE_LIMIT,
  buildAttendanceInputs,
  deriveRecords,
  getDay,
  getMetrics,
  getRecords,
  getTrends,
  toAttendanceEmployee,
  type AttendanceClient,
  type AttendanceEmployee,
  type AttendanceSources,
  type BreakRow,
  type ClockEntryRow,
  type ProfileRow,
  type ScheduleRow,
} from '../attendance-service';

// ─── An in-memory Supabase double ────────────────────────────────────────────

/** Table contents keyed by table name. Rows are the shapes the reads select. */
type Tables = Record<string, unknown[]>;

function field(row: unknown, column: string): unknown {
  return (row as Record<string, unknown>)[column];
}

class FakeQuery {
  private readonly filters: ((row: unknown) => boolean)[] = [];

  constructor(private readonly rows: readonly unknown[]) {}

  select(): this {
    return this;
  }

  order(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => field(row, column) === value);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.filters.push((row) => values.includes(field(row, column)));
    return this;
  }

  gte(column: string, value: string): this {
    this.filters.push((row) => String(field(row, column)) >= value);
    return this;
  }

  lte(column: string, value: string): this {
    this.filters.push((row) => String(field(row, column)) <= value);
    return this;
  }

  lt(column: string, value: string): this {
    this.filters.push((row) => String(field(row, column)) < value);
    return this;
  }

  private matched(): unknown[] {
    return this.rows.filter((row) => this.filters.every((keep) => keep(row)));
  }

  maybeSingle(): Promise<{ data: unknown; error: null }> {
    return Promise.resolve({ data: this.matched()[0] ?? null, error: null });
  }

  then<TResult1, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({ data: this.matched(), error: null }).then(onfulfilled, onrejected);
  }
}

interface Recorder {
  client: AttendanceClient;
  /** Every table asked for, in order. One entry per outbound query. */
  tables: string[];
}

function fakeClient(tables: Tables): Recorder {
  const asked: string[] = [];
  const client = {
    from(table: string) {
      asked.push(table);
      return new FakeQuery(tables[table] ?? []);
    },
  };
  return { client: client as unknown as AttendanceClient, tables: asked };
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

const WORK_DATE = '2026-08-10'; // A Monday.
/** After the day shift's scheduled end, before the missing-clock-out deadline. */
const EVALUATED_AT = '2026-08-10T22:00:00.000Z';

const ADMIN: Actor = { id: 'admin-1', role: 'super_admin' };
const EMPLOYEE_A: Actor = { id: 'emp-a', role: 'agent' };

function profile(id: string, role: string, timezone = 'America/New_York'): ProfileRow {
  return {
    id,
    display_name: id.toUpperCase(),
    initials: id.slice(-1).toUpperCase(),
    role,
    timezone,
    is_active: true,
  };
}

function schedule(profileId: string, date: string, start = '09:00', end = '17:00'): ScheduleRow {
  return {
    profile_id: profileId,
    schedule_date: date,
    shift_start: start,
    shift_end: end,
    shift_type: 'regular',
    status: 'published',
  };
}

function entry(
  id: string,
  profileId: string,
  clockIn: string,
  clockOut: string | null,
): ClockEntryRow {
  return {
    id,
    profile_id: profileId,
    clock_in: clockIn,
    clock_out: clockOut,
    adjusted_by: null,
    adjustment_reason: null,
  };
}

function lunch(
  id: string,
  entryId: string,
  start: string,
  end: string,
  minutes: number,
): BreakRow {
  return {
    id,
    clock_entry_id: entryId,
    break_start: start,
    break_end: end,
    break_type: 'lunch',
    duration_minutes: minutes,
  };
}

/**
 * Four employees on 2026-08-10, one of each interesting shape:
 *
 * - `emp-a` worked the whole shift with a 30-minute lunch → Completed, 7.5 h.
 * - `emp-b` was scheduled and never clocked in, shift over → Absent.
 * - `emp-c` is still clocked in, ten minutes late → Working, late exception.
 * - `emp-d` has no schedule and no clock entry → no record at all.
 */
function dayTables(): Tables {
  return {
    profiles: [
      profile('emp-a', 'agent'),
      profile('emp-b', 'customer_service'),
      profile('emp-c', 'commercial'),
      profile('emp-d', 'agent'),
      profile('admin-1', 'super_admin'),
    ],
    employee_schedules: [
      schedule('emp-a', WORK_DATE),
      schedule('emp-b', WORK_DATE),
      schedule('emp-c', WORK_DATE),
    ],
    time_clock_entries: [
      // 09:00 to 17:00 New York on 2026-08-10 is 13:00Z to 21:00Z.
      entry('entry-a', 'emp-a', '2026-08-10T13:00:00.000Z', '2026-08-10T21:00:00.000Z'),
      entry('entry-c', 'emp-c', '2026-08-10T13:10:00.000Z', null),
    ],
    time_clock_breaks: [
      lunch('break-a', 'entry-a', '2026-08-10T16:00:00.000Z', '2026-08-10T16:30:00.000Z', 30),
    ],
    pto_requests: [],
    attendance_day_reviews: [],
    attendance_notes: [],
    attendance_audit_log: [],
  };
}

function recordFor<T extends { profileId: string }>(records: readonly T[], profileId: string): T {
  const record = records.find((row) => row.profileId === profileId);
  if (record === undefined) throw new Error(`no record for ${profileId}`);
  return record;
}

// ─── Row mapping ─────────────────────────────────────────────────────────────

describe('toAttendanceEmployee', () => {
  it('reads the department from the role through the canonical mapping', () => {
    expect(toAttendanceEmployee(profile('emp-a', 'agent'), DEFAULT_ATTENDANCE_POLICY).department).toBe(
      'sales',
    );
    expect(
      toAttendanceEmployee(profile('sup', 'customer_service_supervisor'), DEFAULT_ATTENDANCE_POLICY)
        .department,
    ).toBe('customer_service');
    expect(
      toAttendanceEmployee(profile('boss', 'super_admin'), DEFAULT_ATTENDANCE_POLICY).department,
    ).toBe('management');
  });

  it('falls back to the business timezone when the stored zone is unusable', () => {
    // A bad zone would otherwise throw inside attribution and blank the read.
    const employee = toAttendanceEmployee(
      profile('emp-x', 'agent', 'Mars/Olympus_Mons'),
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(employee.timezone).toBe(DEFAULT_ATTENDANCE_POLICY.businessTimezone);
  });

  it('keeps a usable employee timezone', () => {
    const employee = toAttendanceEmployee(
      profile('emp-y', 'agent', 'America/Guayaquil'),
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(employee.timezone).toBe('America/Guayaquil');
  });
});

// ─── Input assembly and shift attribution ────────────────────────────────────

function sourcesFor(overrides: Partial<AttendanceSources>): AttendanceSources {
  return {
    range: { from: WORK_DATE, to: WORK_DATE },
    contextRange: { from: '2026-08-09', to: '2026-08-11' },
    evaluatedAt: EVALUATED_AT,
    policy: DEFAULT_ATTENDANCE_POLICY,
    employees: [],
    schedules: [],
    entries: [],
    breaks: [],
    absences: [],
    reviews: [],
    notes: [],
    unscheduledApprovals: [],
    ...overrides,
  };
}

function employee(id: string, role: string, timezone?: string): AttendanceEmployee {
  return toAttendanceEmployee(profile(id, role, timezone), DEFAULT_ATTENDANCE_POLICY);
}

describe('buildAttendanceInputs', () => {
  it('builds no input for a date carrying nothing at all', () => {
    // A date with no schedule, no session, no absence, and no review has nothing
    // to report. Manufacturing a record would file an ordinary day off as
    // needing review.
    const inputs = buildAttendanceInputs(
      sourcesFor({ employees: [employee('emp-d', 'agent')] }),
    );
    expect(inputs).toEqual([]);
  });

  it('builds one input per employee per work date', () => {
    const inputs = buildAttendanceInputs(
      sourcesFor({
        employees: [employee('emp-a', 'agent'), employee('emp-b', 'customer_service')],
        schedules: [schedule('emp-a', WORK_DATE), schedule('emp-b', WORK_DATE)],
      }),
    );

    expect(inputs).toHaveLength(2);
    expect(inputs.map((input) => `${input.profileId}:${input.workDate}`).sort()).toEqual([
      `emp-a:${WORK_DATE}`,
      `emp-b:${WORK_DATE}`,
    ]);
  });

  it('expands an approved absence across every date it covers inside the range', () => {
    const inputs = buildAttendanceInputs(
      sourcesFor({
        range: { from: '2026-08-10', to: '2026-08-12' },
        contextRange: { from: '2026-08-09', to: '2026-08-13' },
        employees: [employee('emp-a', 'agent')],
        absences: [
          {
            id: 'req-1',
            profile_id: 'emp-a',
            pto_type: 'vacation',
            start_date: '2026-08-11',
            end_date: '2026-08-12',
          },
        ],
      }),
    );

    expect(inputs.map((input) => input.workDate).sort()).toEqual(['2026-08-11', '2026-08-12']);
    expect(inputs.every((input) => input.approvedAbsence?.requestId === 'req-1')).toBe(true);
  });

  it('attributes an overnight session to the date its shift started, not the date it clocked in', () => {
    // The fixture is chosen so the two answers differ. `emp-n` is in Guayaquil
    // (UTC-5) and works 23:30 to 07:30 New York on 2026-08-10, which resolves to
    // 03:30Z to 11:30Z on 2026-08-11. A clock-in at 05:00Z falls on the calendar
    // date 2026-08-11 in the employee's own timezone, so naive bucketing files it
    // there; the shift it was worked against started on 2026-08-10.
    const sources = sourcesFor({
      employees: [employee('emp-n', 'agent', 'America/Guayaquil')],
      schedules: [schedule('emp-n', WORK_DATE, '23:30', '07:30')],
      entries: [
        entry('entry-n', 'emp-n', '2026-08-11T05:00:00.000Z', '2026-08-11T11:30:00.000Z'),
      ],
    });

    const inputs = buildAttendanceInputs(sources);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].workDate).toBe(WORK_DATE);
    expect(inputs[0].sessions.map((session) => session.id)).toEqual(['entry-n']);

    // And the record that follows is a worked shift on 2026-08-10, not an absence
    // there plus unscheduled work on 2026-08-11.
    const records = deriveRecords(sources);
    expect(records).toHaveLength(1);
    expect(records[0].workDate).toBe(WORK_DATE);
    expect(records[0].derivedStatus).not.toBe('absent');
    expect(records[0].derivedStatus).not.toBe('clocked_in_unscheduled');
  });

  it('marks unscheduled work approved from the recorded approval', () => {
    const base = sourcesFor({
      employees: [employee('emp-u', 'agent')],
      entries: [
        entry('entry-u', 'emp-u', '2026-08-10T13:00:00.000Z', '2026-08-10T21:00:00.000Z'),
      ],
    });

    const unapproved = deriveRecords(base);
    expect(unapproved[0].derivedStatus).toBe('clocked_in_unscheduled');
    expect(unapproved[0].payrollBlocking).toBe(true);

    const approved = deriveRecords({
      ...base,
      unscheduledApprovals: [{ profile_id: 'emp-u', work_date: WORK_DATE }],
    });
    expect(approved[0].payrollBlocking).toBe(false);
  });
});

// ─── getDay ──────────────────────────────────────────────────────────────────

describe('getDay', () => {
  let recorder: Recorder;

  beforeEach(() => {
    recorder = fakeClient(dayTables());
  });

  it('issues one configuration read and the five range reads, and no more', async () => {
    await getDay(ADMIN, WORK_DATE, { client: recorder.client, evaluatedAt: EVALUATED_AT });

    expect(recorder.tables).toHaveLength(6);
    expect([...recorder.tables].sort()).toEqual([
      'attendance_policy',
      'employee_schedules',
      'profiles',
      'pto_requests',
      'time_clock_breaks',
      'time_clock_entries',
    ]);
  });

  it('reads the same number of queries for a roster of one and a roster of forty', async () => {
    const small = fakeClient(dayTables());
    await getDay(ADMIN, WORK_DATE, { client: small.client, evaluatedAt: EVALUATED_AT });

    const wide = dayTables();
    for (let i = 0; i < 40; i += 1) {
      wide.profiles.push(profile(`bulk-${i}`, 'agent'));
      wide.employee_schedules.push(schedule(`bulk-${i}`, WORK_DATE));
      wide.time_clock_entries.push(
        entry(`bulk-entry-${i}`, `bulk-${i}`, '2026-08-10T13:00:00.000Z', '2026-08-10T21:00:00.000Z'),
      );
    }
    const large = fakeClient(wide);
    const response = await getDay(ADMIN, WORK_DATE, {
      client: large.client,
      evaluatedAt: EVALUATED_AT,
    });

    expect(large.tables.length).toBe(small.tables.length);
    expect(response.records).toHaveLength(43);
  });

  it('reports status and hours as the domain derived them', async () => {
    const { records } = await getDay(ADMIN, WORK_DATE, {
      client: recorder.client,
      evaluatedAt: EVALUATED_AT,
    });

    const a = recordFor(records, 'emp-a');
    expect(a.derivedStatus).toBe('completed');
    expect(a.scheduledHours).toBe(8);
    expect(a.workedHours).toBe(7.5); // 480 minutes less a 30-minute unpaid lunch.
    expect(a.unpaidBreakMinutes).toBe(30);
    expect(a.paidBreakMinutes).toBe(0);

    expect(recordFor(records, 'emp-b').derivedStatus).toBe('absent');

    const c = recordFor(records, 'emp-c');
    expect(c.derivedStatus).toBe('working');
    expect(c.hasOpenSession).toBe(true);
    expect(c.lateMinutes).toBe(10);
    expect(c.exceptions.map((exception) => exception.code)).toContain('late_arrival');
  });

  it('produces no record for an employee with nothing recorded on the date', async () => {
    const { records, employees } = await getDay(ADMIN, WORK_DATE, {
      client: recorder.client,
      evaluatedAt: EVALUATED_AT,
    });

    expect(records.some((record) => record.profileId === 'emp-d')).toBe(false);
    // The employee is still in scope, so the screen can list them.
    expect(employees.some((row) => row.profileId === 'emp-d')).toBe(true);
  });

  it('produces at most one record per employee per work date', async () => {
    const tables = dayTables();
    // A duplicate schedule row and a second session on the same date.
    tables.employee_schedules.push(schedule('emp-a', WORK_DATE, '09:00', '18:00'));
    tables.time_clock_entries.push(
      entry('entry-a2', 'emp-a', '2026-08-10T21:30:00.000Z', '2026-08-10T22:00:00.000Z'),
    );

    const { records } = await getDay(ADMIN, WORK_DATE, {
      client: fakeClient(tables).client,
      evaluatedAt: EVALUATED_AT,
    });

    expect(records.filter((record) => record.profileId === 'emp-a')).toHaveLength(1);
    expect(recordFor(records, 'emp-a').sessions.map((session) => session.id).sort()).toEqual([
      'entry-a',
      'entry-a2',
    ]);
  });

  it('scopes a non-administrator to their own record', async () => {
    const own = fakeClient(dayTables());
    const response = await getDay(EMPLOYEE_A, WORK_DATE, {
      client: own.client,
      evaluatedAt: EVALUATED_AT,
    });

    expect(response.teamScope).toBe(false);
    expect(response.records.map((record) => record.profileId)).toEqual(['emp-a']);
    expect(response.employees.map((row) => row.profileId)).toEqual(['emp-a']);
    // Scope narrows the reads themselves, not the derived output.
    expect(own.tables).toHaveLength(6);
  });

  it('rejects a date that is not a calendar date', async () => {
    await expect(
      getDay(ADMIN, '2026-02-30', { client: recorder.client, evaluatedAt: EVALUATED_AT }),
    ).rejects.toThrowError(AttendanceServiceError);
  });
});

// ─── getRecords ──────────────────────────────────────────────────────────────

/** `count` employees scheduled on every date of a `days`-long range from 2026-08-03. */
function bulkTables(count: number, days: number): Tables {
  const profiles: ProfileRow[] = [profile('admin-1', 'super_admin')];
  const schedules: ScheduleRow[] = [];

  for (let e = 0; e < count; e += 1) {
    const id = `bulk-${e}`;
    profiles.push(profile(id, 'agent'));
    for (let d = 0; d < days; d += 1) {
      const date = new Date(Date.UTC(2026, 7, 3 + d)).toISOString().slice(0, 10);
      schedules.push(schedule(id, date));
    }
  }

  return {
    profiles,
    employee_schedules: schedules,
    time_clock_entries: [],
    time_clock_breaks: [],
    pto_requests: [],
    attendance_day_reviews: [],
    attendance_notes: [],
    attendance_audit_log: [],
  };
}

describe('getRecords', () => {
  const RANGE = { from: '2026-08-03', to: '2026-08-22' }; // 20 dates.

  it('issues the five range reads plus the three review reads, and one configuration read', async () => {
    const recorder = fakeClient(bulkTables(2, 20));
    await getRecords(ADMIN, RANGE, { client: recorder.client, evaluatedAt: EVALUATED_AT });

    expect(recorder.tables).toHaveLength(9);
    expect([...recorder.tables].sort()).toEqual([
      'attendance_audit_log',
      'attendance_day_reviews',
      'attendance_notes',
      'attendance_policy',
      'employee_schedules',
      'profiles',
      'pto_requests',
      'time_clock_breaks',
      'time_clock_entries',
    ]);
  });

  it('caps a page at 100 rows however many match', async () => {
    // Eight employees over twenty dates is 160 records.
    const recorder = fakeClient(bulkTables(8, 20));
    const page = await getRecords(ADMIN, RANGE, {
      client: recorder.client,
      evaluatedAt: EVALUATED_AT,
    });

    expect(page.total).toBe(160);
    expect(page.rows).toHaveLength(RECORDS_PAGE_LIMIT);
    expect(page.limit).toBe(RECORDS_PAGE_LIMIT);
    expect(page.hasMore).toBe(true);
  });

  it('caps a page at 100 rows even when the caller asks for more', async () => {
    const recorder = fakeClient(bulkTables(8, 20));
    const page = await getRecords(
      ADMIN,
      { ...RANGE, limit: 5000 },
      { client: recorder.client, evaluatedAt: EVALUATED_AT },
    );

    expect(page.limit).toBe(RECORDS_PAGE_LIMIT);
    expect(page.rows).toHaveLength(RECORDS_PAGE_LIMIT);
    // The query it hands back carries the paging that was applied.
    expect(page.query.limit).toBe(RECORDS_PAGE_LIMIT);
    expect(page.query.page).toBe(1);
  });

  it('pages without overlap and reports the last page as complete', async () => {
    const recorder = fakeClient(bulkTables(8, 20));
    const context = { client: recorder.client, evaluatedAt: EVALUATED_AT };

    const first = await getRecords(ADMIN, { ...RANGE, page: 1 }, context);
    const second = await getRecords(ADMIN, { ...RANGE, page: 2 }, context);

    expect(second.rows).toHaveLength(60);
    expect(second.hasMore).toBe(false);
    const firstKeys = new Set(first.rows.map((row) => `${row.profileId}:${row.workDate}`));
    expect(second.rows.some((row) => firstKeys.has(`${row.profileId}:${row.workDate}`))).toBe(false);
  });

  it('conjoins the resolved scope and range onto the returned query', async () => {
    const recorder = fakeClient(bulkTables(2, 20));
    const page = await getRecords(EMPLOYEE_A, RANGE, {
      client: recorder.client,
      evaluatedAt: EVALUATED_AT,
    });

    expect(page.query.from).toBe(RANGE.from);
    expect(page.query.to).toBe(RANGE.to);
    expect(page.query.profileIds).toEqual(['emp-a']);
  });

  it('honours a saved filter', async () => {
    const recorder = fakeClient(dayTables());
    const page = await getRecords(
      ADMIN,
      { from: WORK_DATE, to: WORK_DATE, savedFilter: 'absences' },
      { client: recorder.client, evaluatedAt: EVALUATED_AT },
    );

    expect(page.rows.map((row) => row.profileId)).toEqual(['emp-b']);
  });

  it('falls back to a fortnight ending today when the caller names no range', async () => {
    const recorder = fakeClient(dayTables());
    const page = await getRecords(ADMIN, {}, { client: recorder.client, evaluatedAt: EVALUATED_AT });

    // 2026-08-10T22:00Z is 18:00 on 2026-08-10 in New York.
    expect(page.query.to).toBe('2026-08-10');
    expect(page.query.from).toBe('2026-07-28');
  });

  it('refuses a range wider than the read cap rather than assembling it', async () => {
    const recorder = fakeClient(dayTables());
    await expect(
      getRecords(
        ADMIN,
        { from: '2020-01-01', to: '2026-12-31' },
        { client: recorder.client, evaluatedAt: EVALUATED_AT },
      ),
    ).rejects.toThrowError(new RegExp(`${MAX_RANGE_DAYS}`));
  });
});

// ─── getMetrics ──────────────────────────────────────────────────────────────

describe('getMetrics', () => {
  it('returns the fourteen metrics in one request', async () => {
    const recorder = fakeClient(dayTables());
    const response = await getMetrics(
      ADMIN,
      { from: WORK_DATE, to: WORK_DATE },
      { client: recorder.client, evaluatedAt: EVALUATED_AT },
    );

    expect(response.metrics).toHaveLength(14);
    expect(recorder.tables).toHaveLength(9);
  });

  it('agrees with the rows its drill-down query selects', async () => {
    const tables = dayTables();
    const context = { client: fakeClient(tables).client, evaluatedAt: EVALUATED_AT };
    const query = { from: WORK_DATE, to: WORK_DATE };

    const metrics = await getMetrics(ADMIN, query, context);
    const absences = metrics.metrics.find((metric) => metric.key === 'absence_count');
    expect(absences?.value).toBe(1);

    const drilled = await getRecords(ADMIN, absences?.query ?? {}, {
      client: fakeClient(tables).client,
      evaluatedAt: EVALUATED_AT,
    });
    expect(drilled.total).toBe(absences?.recordCount);
    expect(drilled.rows.map((row) => row.profileId)).toEqual(['emp-b']);
  });

  it('sums scheduled and worked hours off the records', async () => {
    const recorder = fakeClient(dayTables());
    const response = await getMetrics(
      ADMIN,
      { from: WORK_DATE, to: WORK_DATE },
      { client: recorder.client, evaluatedAt: EVALUATED_AT },
    );

    const value = (key: string) =>
      response.metrics.find((metric) => metric.key === key)?.value ?? null;

    expect(value('scheduled_hours')).toBe(24); // Three published eight-hour shifts.
    expect(value('worked_hours')).toBeGreaterThan(0);
    expect(value('late_arrival_count')).toBe(1);
  });
});

// ─── getTrends ───────────────────────────────────────────────────────────────

describe('getTrends', () => {
  const RANGE = { from: '2026-08-10', to: '2026-08-10' };

  it('returns the twelve values in the order Requirement 14 states them', async () => {
    const recorder = fakeClient(dayTables());
    const response = await getTrends(ADMIN, 'emp-a', RANGE, {
      client: recorder.client,
      evaluatedAt: EVALUATED_AT,
    });

    expect(response.values.map((value) => value.key)).toEqual([
      'scheduled_hours',
      'worked_hours',
      'attendance_rate',
      'late_occurrence_count',
      'total_late_minutes',
      'absence_count',
      'time_off_days_used',
      'overtime_hours',
      'break_minutes',
      'missing_punch_count',
      'correction_count',
      'manager_note_count',
    ]);
    expect(recorder.tables).toHaveLength(9);
  });

  it('carries a drill-down query on every value', async () => {
    const recorder = fakeClient(dayTables());
    const response = await getTrends(ADMIN, 'emp-a', RANGE, {
      client: recorder.client,
      evaluatedAt: EVALUATED_AT,
    });

    for (const value of response.values) {
      expect(value.query.profileIds).toEqual(['emp-a']);
      expect(value.query.from).toBe(RANGE.from);
      expect(value.query.to).toBe(RANGE.to);
    }
  });

  it('reports scheduled against worked per work date', async () => {
    const recorder = fakeClient(dayTables());
    const response = await getTrends(ADMIN, 'emp-a', RANGE, {
      client: recorder.client,
      evaluatedAt: EVALUATED_AT,
    });

    expect(response.byDate).toEqual([
      {
        workDate: WORK_DATE,
        scheduledHours: 8,
        workedHours: 7.5,
        derivedStatus: 'completed',
        payrollBlocking: false,
        query: { from: WORK_DATE, to: WORK_DATE, profileIds: ['emp-a'] },
      },
    ]);
  });

  it('reads break minutes off the record rather than recomputing them', async () => {
    const recorder = fakeClient(dayTables());
    const response = await getTrends(ADMIN, 'emp-a', RANGE, {
      client: recorder.client,
      evaluatedAt: EVALUATED_AT,
    });

    const breakMinutes = response.values.find((value) => value.key === 'break_minutes');
    const record = response.records[0];
    expect(breakMinutes?.value).toBe(record.paidBreakMinutes + record.unpaidBreakMinutes);
  });

  it('returns the manager notes for the employee and range', async () => {
    const tables = dayTables();
    tables.attendance_notes = [
      {
        id: 'note-1',
        profile_id: 'emp-a',
        work_date: WORK_DATE,
        note: 'Covered the afternoon queue.',
        author_profile_id: 'admin-1',
        created_at: '2026-08-10T21:05:00.000Z',
      },
      {
        id: 'note-2',
        profile_id: 'emp-b',
        work_date: WORK_DATE,
        note: 'Called in.',
        author_profile_id: 'admin-1',
        created_at: '2026-08-10T13:05:00.000Z',
      },
    ];

    const response = await getTrends(ADMIN, 'emp-a', RANGE, {
      client: fakeClient(tables).client,
      evaluatedAt: EVALUATED_AT,
    });

    expect(response.notes.map((note) => note.id)).toEqual(['note-1']);
    expect(response.values.find((value) => value.key === 'manager_note_count')?.value).toBe(1);
  });

  it('refuses an employee outside the caller visibility', async () => {
    const recorder = fakeClient(dayTables());
    await expect(
      getTrends(EMPLOYEE_A, 'emp-b', RANGE, {
        client: recorder.client,
        evaluatedAt: EVALUATED_AT,
      }),
    ).rejects.toMatchObject({ code: 'not_visible' });
    // Nothing was read: authorisation precedes the reads.
    expect(recorder.tables).toHaveLength(0);
  });

  it('lets an employee read their own trend', async () => {
    const recorder = fakeClient(dayTables());
    const response = await getTrends(EMPLOYEE_A, 'emp-a', RANGE, {
      client: recorder.client,
      evaluatedAt: EVALUATED_AT,
    });

    expect(response.employee?.profileId).toBe('emp-a');
    expect(response.records).toHaveLength(1);
  });
});

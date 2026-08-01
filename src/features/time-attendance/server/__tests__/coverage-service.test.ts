// Unit tests for the coverage-service read paths.
//
// Feature: time-attendance-ui-redesign, task 9.1
//
// Five things are asserted, because they are the five ways one implementation
// serving four consumers goes wrong:
//
//   1. The outbound query count is a property of the mode, not of the roster size
//      or the range length. A coverage read that grows a query per date passes
//      every correctness check and then falls over on a month view, so the tables
//      touched are asserted by name and by count (Requirements 8.12, 18.11,
//      20.4).
//   2. Projected coverage never reads clock data. The projected path is asserted
//      not to touch `time_clock_entries` or `time_clock_breaks`, and adding clock
//      entries to the fixture is asserted to change nothing (Requirements 9.6,
//      19.4).
//   3. The ribbon state for a date agrees with the coverage status the same
//      response carries for that date, and Closed and No_Schedule take precedence
//      (Requirements 18.4, 18.5, 18.10).
//   4. Required staffing comes from the threshold row for the date's day of week
//      and the slot the figure describes: `full_day` for a whole date, the
//      current slot for live coverage (Requirements 6.3, 6.4).
//   5. Absences carry employee names only when administration or the shared
//      absence calendar grant holds (Requirement 8.13).
//
// The Supabase client is a small in-memory double that records every table it is
// asked for. Nothing in the domain layer is mocked: the records, projections,
// intervals, and ribbon states these tests read are produced by the real
// `deriveRange`, `projectCoverage`, `buildCoverageIntervals`, and
// `deriveRibbonStates`.
//
// Requirements: 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 8.2, 8.5, 8.6, 8.8, 8.9,
// 8.10, 8.11, 8.12, 8.13, 9.1, 9.2, 9.6, 18.4, 18.5, 18.10, 18.11, 19.4, 20.4,
// 21.1, 21.2

import { describe, expect, it } from 'vitest';

import { addCalendarDays } from '../../domain/work-date';
import type { AttendancePolicy, DateRange } from '../../domain/types';
import {
  toAttendanceEmployee,
  type AttendanceClient,
  type AttendanceEmployee,
  type BreakRow,
  type ClockEntryRow,
  type ProfileRow,
  type ScheduleRow,
} from '../attendance-service';
import {
  DEFAULT_ATTENDANCE_POLICY,
  buildStaffingThresholdTable,
  type StaffingThresholdRow,
} from '../policy';
import type { Actor } from '../visibility';
import {
  absenceNamesVisible,
  buildCoverage,
  getCoverage,
  getImpact,
  isComputedCoverageDate,
  type ClosedDateRow,
  type ComputedCoverageDate,
  type CoverageDate,
  type CoverageQuery,
  type CoverageRequestRow,
  type CoverageSources,
} from '../coverage-service';

// ─── An in-memory Supabase double ────────────────────────────────────────────

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

const MONDAY = '2026-08-10';
const TUESDAY = '2026-08-11';
const WEDNESDAY = '2026-08-12';
const SUNDAY = '2026-08-16';

/** `staffing_thresholds.day_of_week` for the Monday the fixture is built around. */
const MONDAY_DOW = 1;

/** 14:00 in New York on the Monday: mid-shift, and inside the afternoon slot. */
const AFTERNOON_AT = '2026-08-10T18:00:00.000Z';
/** 10:00 in New York on the same date: inside the morning slot. */
const MORNING_AT = '2026-08-10T14:00:00.000Z';

const ADMIN: Actor = { id: 'admin-1', role: 'super_admin' };
const EMPLOYEE_B: Actor = { id: 'emp-b', role: 'customer_service' };
const MANAGER: Actor = { id: 'mgr-1', role: 'manager' };

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

function openBreak(id: string, entryId: string, start: string): BreakRow {
  return {
    id,
    clock_entry_id: entryId,
    break_start: start,
    break_end: null,
    break_type: 'lunch',
    duration_minutes: null,
  };
}

function request(
  id: string,
  profileId: string,
  startDate: string,
  endDate: string,
  status: string,
): CoverageRequestRow & { status: string } {
  return { id, profile_id: profileId, pto_type: 'vacation', start_date: startDate, end_date: endDate, status };
}

/**
 * The roster and the week the tests read.
 *
 * Departments follow the canonical role mapping: `emp-a` and `emp-d` are sales,
 * `emp-b` is customer service, `emp-c` is commercial, `admin-1` is management.
 *
 * On the Monday:
 * - `emp-a` is scheduled 09:00 to 17:00 and is clocked in with no clock-out.
 * - `emp-b` is scheduled and holds an approved absence.
 * - `emp-c` is scheduled 13:00 to 21:00 — a different start and end, so the date
 *   partitions into three intervals — and is on an unended break.
 * - `emp-d` is scheduled and has not clocked in.
 *
 * The Tuesday carries one published schedule. The Wednesday carries one published
 * schedule and is a closed date, so Closed has something to take precedence over.
 * The rest of the week carries nothing.
 */
function weekTables(): Tables {
  return {
    profiles: [
      profile('emp-a', 'agent'),
      profile('emp-b', 'customer_service'),
      profile('emp-c', 'commercial'),
      profile('emp-d', 'agent'),
      profile('admin-1', 'super_admin'),
    ],
    employee_schedules: [
      schedule('emp-a', MONDAY),
      schedule('emp-b', MONDAY),
      schedule('emp-c', MONDAY, '13:00', '21:00'),
      schedule('emp-d', MONDAY),
      schedule('emp-a', TUESDAY),
      schedule('emp-a', WEDNESDAY),
    ],
    time_clock_entries: [
      entry('entry-a', 'emp-a', '2026-08-10T13:00:00.000Z', null),
      entry('entry-c', 'emp-c', '2026-08-10T17:00:00.000Z', null),
    ],
    time_clock_breaks: [openBreak('break-c', 'entry-c', '2026-08-10T17:30:00.000Z')],
    pto_requests: [
      request('req-b', 'emp-b', MONDAY, MONDAY, 'approved'),
      request('req-d', 'emp-d', TUESDAY, TUESDAY, 'pending'),
    ],
    attendance_closed_dates: [{ closed_date: WEDNESDAY, label: 'Company holiday' }],
    attendance_policy: [],
    staffing_thresholds: [],
    attendance_day_reviews: [],
    attendance_notes: [],
    attendance_audit_log: [],
  };
}

/** Sales thresholds for the fixture's Monday, one row per slot. */
const SALES_THRESHOLDS: StaffingThresholdRow[] = [
  { department: 'sales', day_of_week: MONDAY_DOW, time_slot: 'full_day', minimum_staff: 2, warning_threshold: 3 },
  { department: 'sales', day_of_week: MONDAY_DOW, time_slot: 'morning', minimum_staff: 3, warning_threshold: 4 },
  { department: 'sales', day_of_week: MONDAY_DOW, time_slot: 'afternoon', minimum_staff: 1, warning_threshold: 2 },
];

const WEEK: CoverageQuery = { from: MONDAY, to: SUNDAY, mode: 'projected' };
const MONDAY_ONLY: CoverageQuery = { from: MONDAY, to: MONDAY, mode: 'projected' };
const MONDAY_LIVE: CoverageQuery = { from: MONDAY, to: MONDAY, mode: 'live' };

function contextFor(recorder: Recorder, evaluatedAt = AFTERNOON_AT) {
  return { client: recorder.client, evaluatedAt };
}

/**
 * The computed figures for one date.
 *
 * Narrows the per-date union. Every date in these fixtures is computable, so a
 * date arriving unavailable is a failure of the read rather than a case to branch
 * on, and it is reported with the reason the response gave.
 */
function dateOf(
  response: { dates: readonly CoverageDate[] },
  workDate: string,
): ComputedCoverageDate {
  const found = response.dates.find((date) => date.workDate === workDate);
  if (found === undefined) throw new Error(`no coverage for ${workDate}`);
  if (!isComputedCoverageDate(found)) {
    throw new Error(`coverage for ${workDate} is unavailable: ${found.unavailable.reason}`);
  }
  return found;
}

function departmentRow<T extends { department: string }>(rows: readonly T[], department: string): T {
  const row = rows.find((candidate) => candidate.department === department);
  if (row === undefined) throw new Error(`no row for ${department}`);
  return row;
}

// ─── Query counts ────────────────────────────────────────────────────────────

describe('getCoverage query counts', () => {
  it('issues two configuration reads and four range reads in projected mode', async () => {
    const recorder = fakeClient(weekTables());
    await getCoverage(ADMIN, WEEK, contextFor(recorder));

    expect(recorder.tables).toHaveLength(6);
    expect([...recorder.tables].sort()).toEqual([
      'attendance_closed_dates',
      'attendance_policy',
      'employee_schedules',
      'profiles',
      'pto_requests',
      'staffing_thresholds',
    ]);
  });

  it('never reads clock data in projected mode', async () => {
    const recorder = fakeClient(weekTables());
    await getCoverage(ADMIN, WEEK, contextFor(recorder));

    expect(recorder.tables).not.toContain('time_clock_entries');
    expect(recorder.tables).not.toContain('time_clock_breaks');
  });

  it('issues two configuration reads and seven range reads in live mode', async () => {
    const recorder = fakeClient(weekTables());
    await getCoverage(ADMIN, MONDAY_LIVE, contextFor(recorder));

    expect(recorder.tables).toHaveLength(9);
    expect([...recorder.tables].sort()).toEqual([
      'attendance_closed_dates',
      'attendance_policy',
      'employee_schedules',
      'profiles',
      'pto_requests',
      'pto_requests',
      'staffing_thresholds',
      'time_clock_breaks',
      'time_clock_entries',
    ]);
  });

  it('reads the same number of queries for one date and for a whole month', async () => {
    const week = fakeClient(weekTables());
    await getCoverage(ADMIN, WEEK, contextFor(week));

    const month = fakeClient(weekTables());
    const response = await getCoverage(
      ADMIN,
      { from: '2026-08-01', to: '2026-08-31', mode: 'projected' },
      contextFor(month),
    );

    expect(month.tables.length).toBe(week.tables.length);
    // The range still widened: one entry per date, in one request.
    expect(response.dates).toHaveLength(31);
  });

  it('reads the same number of queries for a roster of five and a roster of forty-five', async () => {
    const small = fakeClient(weekTables());
    await getCoverage(ADMIN, WEEK, contextFor(small));

    const wide = weekTables();
    for (let i = 0; i < 40; i += 1) {
      wide.profiles.push(profile(`bulk-${i}`, 'agent'));
      wide.employee_schedules.push(schedule(`bulk-${i}`, MONDAY));
    }
    const large = fakeClient(wide);
    const response = await getCoverage(ADMIN, WEEK, contextFor(large));

    expect(large.tables.length).toBe(small.tables.length);
    expect(dateOf(response, MONDAY).projection.scheduled).toBe(44);
  });

  it('makes no configuration read when the caller supplies both', async () => {
    const recorder = fakeClient(weekTables());
    await getCoverage(ADMIN, WEEK, {
      client: recorder.client,
      evaluatedAt: AFTERNOON_AT,
      policy: DEFAULT_ATTENDANCE_POLICY,
      thresholds: buildStaffingThresholdTable([]),
    });

    expect(recorder.tables).toHaveLength(4);
    expect(recorder.tables).not.toContain('attendance_policy');
    expect(recorder.tables).not.toContain('staffing_thresholds');
  });
});

// ─── Projected coverage ──────────────────────────────────────────────────────

describe('getCoverage projected figures', () => {
  it('reports scheduled minus approved absences per date', async () => {
    const recorder = fakeClient(weekTables());
    const response = await getCoverage(ADMIN, WEEK, contextFor(recorder));

    const monday = dateOf(response, MONDAY);
    expect(monday.projection.scheduled).toBe(4);
    expect(monday.projection.approvedAbsences).toBe(1);
    expect(monday.projection.proposedAbsences).toBe(0);
    expect(monday.projection.available).toBe(3);
    expect(monday.projection.rawAvailable).toBe(3);
  });

  it('counts pending requests without subtracting them', async () => {
    const recorder = fakeClient(weekTables());
    const response = await getCoverage(ADMIN, WEEK, contextFor(recorder));

    const tuesday = dateOf(response, TUESDAY);
    expect(tuesday.pendingRequests.map((row) => row.requestId)).toEqual(['req-d']);
    expect(tuesday.projection.scheduled).toBe(1);
    expect(tuesday.projection.approvedAbsences).toBe(0);
    expect(tuesday.projection.available).toBe(1);
  });

  it('carries the four date-drawer lists for the date', async () => {
    const recorder = fakeClient(weekTables());
    const response = await getCoverage(ADMIN, WEEK, contextFor(recorder));

    const monday = dateOf(response, MONDAY);
    expect(monday.scheduled.map((row) => row.profileId)).toEqual([
      'emp-a',
      'emp-b',
      'emp-c',
      'emp-d',
    ]);
    expect(monday.approvedAbsences.map((row) => row.requestId)).toEqual(['req-b']);
    expect(monday.pendingRequests).toEqual([]);
    expect(monday.intervals.length).toBeGreaterThan(0);
  });

  it('breaks a date into intervals at every distinct scheduled start and end', async () => {
    const recorder = fakeClient(weekTables());
    const response = await getCoverage(ADMIN, MONDAY_ONLY, contextFor(recorder));

    // 09:00 to 17:00 New York is 13:00Z to 21:00Z; 13:00 to 21:00 is 17:00Z to
    // 01:00Z the following date. `emp-b` is absent, so their window bounds the
    // partition without staffing it.
    expect(dateOf(response, MONDAY).intervals).toEqual([
      expect.objectContaining({
        start: '2026-08-10T13:00:00.000Z',
        end: '2026-08-10T17:00:00.000Z',
        availableStaff: 2,
        profileIds: ['emp-a', 'emp-d'],
      }),
      expect.objectContaining({
        start: '2026-08-10T17:00:00.000Z',
        end: '2026-08-10T21:00:00.000Z',
        availableStaff: 3,
        profileIds: ['emp-a', 'emp-c', 'emp-d'],
      }),
      expect.objectContaining({
        start: '2026-08-10T21:00:00.000Z',
        end: '2026-08-11T01:00:00.000Z',
        availableStaff: 1,
        profileIds: ['emp-c'],
      }),
    ]);
  });

  it('is unchanged by any clock entry', async () => {
    const withoutClocks = weekTables();
    withoutClocks.time_clock_entries = [];
    withoutClocks.time_clock_breaks = [];

    const bare = await getCoverage(ADMIN, WEEK, contextFor(fakeClient(withoutClocks)));
    const clocked = await getCoverage(ADMIN, WEEK, contextFor(fakeClient(weekTables())));

    expect(clocked.dates).toEqual(bare.dates);
  });

  it('restricts every figure to one department when the query names one', async () => {
    const recorder = fakeClient(weekTables());
    const response = await getCoverage(
      ADMIN,
      { ...MONDAY_ONLY, department: 'sales' },
      contextFor(recorder),
    );

    expect(response.department).toBe('sales');
    expect(response.employees.map((row) => row.profileId)).toEqual(['emp-a', 'emp-d']);

    const monday = dateOf(response, MONDAY);
    expect(monday.projection.scheduled).toBe(2);
    expect(monday.projection.approvedAbsences).toBe(0);
    expect(monday.projection.departments.map((row) => row.department)).toEqual(['sales']);
  });
});

// ─── Required staffing ───────────────────────────────────────────────────────

describe('getCoverage required staffing', () => {
  it('reports required staffing as unconfigured and Healthy when no threshold row exists', async () => {
    const recorder = fakeClient(weekTables());
    const response = await getCoverage(ADMIN, MONDAY_ONLY, contextFor(recorder));

    expect(response.thresholdsConfigured).toBe(false);
    const monday = dateOf(response, MONDAY);
    expect(monday.projection.requiredStaff).toBeNull();
    expect(monday.projection.status).toBe('healthy');
    for (const department of monday.projection.departments) {
      expect(department.requiredStaff).toBeNull();
      expect(department.status).toBe('healthy');
    }
  });

  it('compares a whole-date figure against the full_day row for that day of week', async () => {
    const tables = weekTables();
    tables.staffing_thresholds = SALES_THRESHOLDS;
    const response = await getCoverage(
      ADMIN,
      { ...MONDAY_ONLY, department: 'sales' },
      contextFor(fakeClient(tables)),
    );

    // Sales has two scheduled and no absence, against a full_day minimum of two.
    const monday = dateOf(response, MONDAY);
    expect(response.thresholdsConfigured).toBe(true);
    expect(monday.timeSlot).toBe('full_day');
    expect(monday.dayOfWeek).toBe(MONDAY_DOW);
    expect(monday.projection.requiredStaff).toBe(2);
    expect(monday.projection.available).toBe(2);
    expect(monday.projection.status).toBe('at_minimum');
    // Every interval on the date is compared against the same pair.
    for (const interval of monday.intervals) expect(interval.requiredStaff).toBe(2);
  });

  it('compares live coverage against the slot the evaluation instant falls in', async () => {
    const tables = weekTables();
    tables.staffing_thresholds = SALES_THRESHOLDS;

    const afternoon = await getCoverage(
      ADMIN,
      { ...MONDAY_LIVE, department: 'sales' },
      contextFor(fakeClient(tables), AFTERNOON_AT),
    );
    expect(afternoon.liveTimeSlot).toBe('afternoon');
    expect(departmentRow(afternoon.live, 'sales').requiredStaff).toBe(1);
    expect(departmentRow(afternoon.live, 'sales').working).toBe(1);
    expect(departmentRow(afternoon.live, 'sales').status).toBe('at_minimum');

    const morning = await getCoverage(
      ADMIN,
      { ...MONDAY_LIVE, department: 'sales' },
      contextFor(fakeClient(tables), MORNING_AT),
    );
    expect(morning.liveTimeSlot).toBe('morning');
    expect(departmentRow(morning.live, 'sales').requiredStaff).toBe(3);
    expect(departmentRow(morning.live, 'sales').status).toBe('critical');
  });
});

// ─── Live coverage ───────────────────────────────────────────────────────────

describe('getCoverage live figures', () => {
  it('reports the working, on-break, approved-off, and missing headcounts', async () => {
    const recorder = fakeClient(weekTables());
    const response = await getCoverage(ADMIN, MONDAY_LIVE, contextFor(recorder));

    expect(response.live.map((row) => row.department)).toEqual([
      'sales',
      'customer_service',
      'commercial',
      'management',
    ]);

    const sales = departmentRow(response.live, 'sales');
    expect(sales.scheduled).toBe(2);
    expect(sales.working).toBe(1);
    expect(sales.workingProfileIds).toEqual(['emp-a']);
    expect(sales.missing).toBe(1);
    expect(sales.missingProfileIds).toEqual(['emp-d']);

    const commercial = departmentRow(response.live, 'commercial');
    expect(commercial.onBreak).toBe(1);
    // On-break is excluded from the working headcount and from availability.
    expect(commercial.working).toBe(0);
    expect(commercial.available).toBe(0);

    const customerService = departmentRow(response.live, 'customer_service');
    expect(customerService.approvedOff).toBe(1);
    expect(customerService.approvedOffProfileIds).toEqual(['emp-b']);
  });

  it('carries no ribbon and no live rows for the mode that does not produce them', async () => {
    const live = await getCoverage(ADMIN, MONDAY_LIVE, contextFor(fakeClient(weekTables())));
    expect(live.ribbon).toEqual([]);
    expect(live.live.length).toBeGreaterThan(0);

    const projected = await getCoverage(ADMIN, WEEK, contextFor(fakeClient(weekTables())));
    expect(projected.live).toEqual([]);
    expect(projected.liveTimeSlot).toBeNull();
  });

  it('refuses a live read over more than one date', async () => {
    const recorder = fakeClient(weekTables());
    await expect(
      getCoverage(ADMIN, { from: MONDAY, to: TUESDAY, mode: 'live' }, contextFor(recorder)),
    ).rejects.toMatchObject({ code: 'invalid_range' });
    // Authorisation and validation precede the reads.
    expect(recorder.tables).toHaveLength(0);
  });
});

// ─── Health ribbon ───────────────────────────────────────────────────────────

describe('getCoverage ribbon', () => {
  it('returns seven consecutive dates whose states agree with the coverage it carries', async () => {
    const recorder = fakeClient(weekTables());
    const response = await getCoverage(ADMIN, WEEK, contextFor(recorder));

    expect(response.ribbon.map((day) => day.workDate)).toEqual([
      MONDAY,
      TUESDAY,
      WEDNESDAY,
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      SUNDAY,
    ]);

    expect(response.ribbon.map((day) => day.state)).toEqual([
      'healthy', // open, scheduled, no threshold configured
      'healthy',
      'closed', // Requirement 18.4 takes precedence over its coverage
      'no_schedule', // Requirement 18.5
      'no_schedule',
      'no_schedule',
      'no_schedule',
    ]);

    // Requirement 18.10: the state a date reads is the status the same response
    // published for that date, never a second classification.
    for (const day of response.ribbon) {
      if (day.state !== 'closed' && day.state !== 'no_schedule') {
        expect(day.coverage?.status).toBe(day.state);
        expect(day.coverage).toEqual(dateOf(response, day.workDate).projection);
      }
    }
  });

  it('marks the closed date closed and names it', async () => {
    const recorder = fakeClient(weekTables());
    const response = await getCoverage(ADMIN, WEEK, contextFor(recorder));

    const wednesday = dateOf(response, WEDNESDAY);
    expect(wednesday.closed).toBe(true);
    expect(wednesday.closedLabel).toBe('Company holiday');
    // Still scheduled, which is what makes Closed a precedence rather than a
    // consequence of having nothing on the date.
    expect(wednesday.hasPublishedSchedule).toBe(true);
  });

  it('carries no ribbon for a range shorter than seven dates', async () => {
    const recorder = fakeClient(weekTables());
    const response = await getCoverage(
      ADMIN,
      { from: MONDAY, to: TUESDAY, mode: 'projected' },
      contextFor(recorder),
    );

    expect(response.dates).toHaveLength(2);
    expect(response.ribbon).toEqual([]);
  });
});

// ─── Scope ───────────────────────────────────────────────────────────────────

describe('getCoverage scope', () => {
  it('scopes a non-administrator to their own rows', async () => {
    const recorder = fakeClient(weekTables());
    const response = await getCoverage(EMPLOYEE_B, MONDAY_ONLY, contextFor(recorder));

    expect(response.employees.map((row) => row.profileId)).toEqual(['emp-b']);
    const monday = dateOf(response, MONDAY);
    expect(monday.projection.scheduledProfileIds).toEqual(['emp-b']);
    expect(monday.projection.approvedAbsenceProfileIds).toEqual(['emp-b']);
    // Scope narrows the reads, not the query count.
    expect(recorder.tables).toHaveLength(6);
  });
});

// ─── Employee names ──────────────────────────────────────────────────────────

describe('absence employee names', () => {
  it('grants name visibility to administration or the shared calendar permission, and nothing else', () => {
    expect(absenceNamesVisible(ADMIN, false)).toBe(true);
    expect(absenceNamesVisible(EMPLOYEE_B, false)).toBe(false);
    expect(absenceNamesVisible(EMPLOYEE_B, true)).toBe(true);
    // The grant widens absence visibility; it never confers administration, and a
    // manager holds neither.
    expect(absenceNamesVisible(MANAGER, false)).toBe(false);
    expect(absenceNamesVisible(MANAGER, true)).toBe(true);
  });

  it('names absences for an administrator', async () => {
    const recorder = fakeClient(weekTables());
    const response = await getCoverage(ADMIN, MONDAY_ONLY, contextFor(recorder));

    expect(response.employeeNamesVisible).toBe(true);
    const absence = dateOf(response, MONDAY).approvedAbsences[0];
    expect(absence.employee.displayName).toBe('EMP-B');
    expect(absence.employee.initials).toBe('B');
  });

  /** Two absences on the Monday: one the caller owns, one they do not. */
  const TWO_ABSENCES: CoverageRequestRow[] = [
    request('req-a', 'emp-a', MONDAY, MONDAY, 'approved'),
    request('req-b', 'emp-b', MONDAY, MONDAY, 'approved'),
  ];

  function nameOfAbsence(
    response: ReturnType<typeof buildCoverage>,
    requestId: string,
  ): string | null {
    const absence = dateOf(response, MONDAY).approvedAbsences.find(
      (row) => row.requestId === requestId,
    );
    if (absence === undefined) throw new Error(`no absence ${requestId}`);
    return absence.employee.displayName;
  }

  it('withholds other employees names without the grant, and keeps the caller their own', () => {
    const withheld = buildCoverage(
      EMPLOYEE_B,
      MONDAY_ONLY,
      { from: MONDAY, to: MONDAY },
      [MONDAY],
      sourcesFor({ approvedAbsences: TWO_ABSENCES }),
      buildStaffingThresholdTable([]),
      false,
    );

    expect(withheld.employeeNamesVisible).toBe(false);
    const named = new Map(
      withheld.employees.map((row) => [row.profileId, row.displayName] as const),
    );
    expect(named.get('emp-b')).toBe('EMP-B'); // the caller's own row
    expect(named.get('emp-a')).toBeNull();
    expect(named.get('emp-c')).toBeNull();

    expect(nameOfAbsence(withheld, 'req-a')).toBeNull();
    expect(nameOfAbsence(withheld, 'req-b')).toBe('EMP-B');

    // The identifier is retained either way, so the figures and the lists agree.
    expect(dateOf(withheld, MONDAY).scheduled.map((row) => row.profileId)).toEqual([
      'emp-a',
      'emp-b',
      'emp-c',
      'emp-d',
    ]);
  });

  it('names every employee once the shared calendar permission holds', () => {
    const granted = buildCoverage(
      EMPLOYEE_B,
      MONDAY_ONLY,
      { from: MONDAY, to: MONDAY },
      [MONDAY],
      sourcesFor({ approvedAbsences: TWO_ABSENCES }),
      buildStaffingThresholdTable([]),
      true,
    );

    expect(granted.employeeNamesVisible).toBe(true);
    expect(granted.employees.every((row) => row.displayName !== null)).toBe(true);
    expect(nameOfAbsence(granted, 'req-a')).toBe('EMP-A');
    expect(nameOfAbsence(granted, 'req-b')).toBe('EMP-B');
  });
});

/** The full roster and Monday's rows, as `buildCoverage` takes them. */
function sourcesFor(overrides: Partial<CoverageSources>): CoverageSources {
  const policy: AttendancePolicy = DEFAULT_ATTENDANCE_POLICY;
  const tables = weekTables();

  return {
    range: { from: MONDAY, to: MONDAY },
    evaluatedAt: AFTERNOON_AT,
    policy,
    employees: (tables.profiles as ProfileRow[]).map<AttendanceEmployee>((row) =>
      toAttendanceEmployee(row, policy),
    ),
    schedules: (tables.employee_schedules as ScheduleRow[]).filter(
      (row) => row.schedule_date === MONDAY,
    ),
    approvedAbsences: [request('req-b', 'emp-b', MONDAY, MONDAY, 'approved')],
    pendingRequests: [],
    closedDates: tables.attendance_closed_dates as ClosedDateRow[],
    records: [],
    ...overrides,
  };
}

// ─── getImpact ───────────────────────────────────────────────────────────────

describe('getImpact', () => {
  it('costs the request as a proposed absence over its own dates', async () => {
    const tables = weekTables();
    tables.pto_requests = [
      ...(tables.pto_requests as unknown[]),
      request('req-a', 'emp-a', MONDAY, MONDAY, 'pending'),
    ];
    const recorder = fakeClient(tables);

    const impact = await getImpact(ADMIN, 'req-a', contextFor(recorder));

    expect(impact.request).toMatchObject({
      requestId: 'req-a',
      profileId: 'emp-a',
      startDate: MONDAY,
      endDate: MONDAY,
      status: 'pending',
    });
    expect(impact.proposedAbsence).toEqual({
      profileId: 'emp-a',
      ranges: [{ from: MONDAY, to: MONDAY }],
    });

    const monday = dateOf(impact.coverage, MONDAY);
    expect(monday.projection.proposedAbsences).toBe(1);
    expect(monday.projection.proposedAbsenceProfileIds).toEqual(['emp-a']);
    // Requirement 9.2: scheduled minus approved minus proposed.
    expect(monday.projection.available).toBe(4 - 1 - 1);

    // Seven queries: the request, then the projected read's six.
    expect(recorder.tables).toHaveLength(7);
  });

  it('shows exactly one fewer than the projection the calendar reads', async () => {
    const tables = weekTables();
    tables.pto_requests = [
      ...(tables.pto_requests as unknown[]),
      request('req-a', 'emp-a', MONDAY, MONDAY, 'pending'),
    ];

    const plain = await getCoverage(ADMIN, MONDAY_ONLY, contextFor(fakeClient(tables)));
    const impact = await getImpact(ADMIN, 'req-a', contextFor(fakeClient(tables)));

    expect(dateOf(impact.coverage, MONDAY).projection.available).toBe(
      dateOf(plain, MONDAY).projection.available - 1,
    );
    // The proposed absence vacates the shift it covers in the interval breakdown
    // too, and from schedules and absences only.
    expect(dateOf(impact.coverage, MONDAY).intervals[0].profileIds).toEqual(['emp-d']);
  });

  it('excludes the proposed employee from the interval they were scheduled on', async () => {
    const tables = weekTables();
    tables.pto_requests = [request('req-c', 'emp-c', MONDAY, MONDAY, 'pending')];

    const impact = await getImpact(ADMIN, 'req-c', contextFor(fakeClient(tables)));
    const monday = dateOf(impact.coverage, MONDAY);

    // `emp-c` held the 21:00Z to 01:00Z stretch alone, so it now staffs nobody
    // and drops out, while their window still bounds the partition.
    expect(monday.intervals.map((interval) => interval.availableStaff)).toEqual([3, 3]);
    expect(monday.intervals.at(-1)?.end).toBe('2026-08-10T21:00:00.000Z');
  });

  it('refuses a request outside the caller visibility without naming it', async () => {
    const recorder = fakeClient(weekTables());
    await expect(getImpact(EMPLOYEE_B, 'req-d', contextFor(recorder))).rejects.toMatchObject({
      code: 'not_visible',
    });
  });

  it('refuses a request that does not exist identically', async () => {
    const recorder = fakeClient(weekTables());
    await expect(getImpact(ADMIN, 'missing', contextFor(recorder))).rejects.toMatchObject({
      code: 'not_visible',
    });
  });
});

// ─── Range validation ────────────────────────────────────────────────────────

describe('getCoverage range validation', () => {
  const cases: ReadonlyArray<[string, DateRange]> = [
    ['a string that matches the shape but names no date', { from: '2026-02-30', to: '2026-02-30' }],
    ['a malformed date', { from: '2026-8-1', to: '2026-08-31' }],
    ['an inverted range', { from: SUNDAY, to: MONDAY }],
  ];

  for (const [label, range] of cases) {
    it(`refuses ${label}`, async () => {
      const recorder = fakeClient(weekTables());
      await expect(
        getCoverage(ADMIN, { ...range, mode: 'projected' }, contextFor(recorder)),
      ).rejects.toMatchObject({ code: 'invalid_range' });
      expect(recorder.tables).toHaveLength(0);
    });
  }

  it('refuses a range wider than the read cap rather than assembling it', async () => {
    const recorder = fakeClient(weekTables());
    await expect(
      getCoverage(
        ADMIN,
        { from: '2026-01-01', to: addCalendarDays('2026-01-01', 500), mode: 'projected' },
        contextFor(recorder),
      ),
    ).rejects.toMatchObject({ code: 'invalid_range' });
    expect(recorder.tables).toHaveLength(0);
  });
});

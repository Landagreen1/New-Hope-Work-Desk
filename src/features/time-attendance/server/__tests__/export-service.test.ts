//
// Feature: time-attendance-ui-redesign, task 20.2
//
// Four things are asserted here, because they are the four ways an export of this
// shape goes wrong:
//
//   1. **The export is the view's own read.** Reading a view whole and reading it
//      one page at a time have to produce the same rows in the same order. If they
//      diverge, the file an administrator sends onward is not the screen they were
//      looking at, and nothing downstream would notice.
//   2. **Pay columns follow the role, not the view.** Requirement 15, criterion 9
//      restricts pay-rate and pay-amount columns to an Attendance_Administrator,
//      so the same request is made twice and the two files are compared.
//   3. **The file says what it contains.** The active range and every active
//      filter value in the name (criterion 6), and the statement that nothing
//      matched when nothing did, beside a file that still carries its header row
//      (criterion 8).
//   4. **A malformed request is refused rather than answered.** An unknown view,
//      a view whose range cannot be invented, a trends export naming no employee.
//
// The values themselves are the services' — a status label, a worked-hours figure,
// a coverage projection — so they are not re-asserted here beyond the quoting the
// writer applies to them. The fixture's employee name carries a comma, an embedded
// double quotation mark, and non-ASCII characters, and the request reason carries a
// newline, because those are exactly what the inherited browser-built export
// corrupted.
//
// The Supabase client is the same small in-memory double the other server tests
// use. Nothing in the domain layer is mocked: the records, projections, and inbox
// rows these files are built from are produced by the real derivations.
//
// Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9

import { describe, expect, it } from 'vitest';

import { getRecords, type AttendanceClient } from '../attendance-service';
import { exportView } from '../export-service';
import { parseExportQuery } from '../request-query';
import type { Actor } from '../visibility';

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

  /** `not('clock_out', 'is', null)` on the legacy payroll read. */
  not(): this {
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

function fakeClient(tables: Tables): AttendanceClient {
  return {
    from(table: string) {
      return new FakeQuery(tables[table] ?? []);
    },
  } as unknown as AttendanceClient;
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

const WORK_DATE = '2026-08-10'; // A Monday.
/** After the day shift's scheduled end, before the missing-clock-out deadline. */
const EVALUATED_AT = '2026-08-10T22:00:00.000Z';
const RANGE = { from: WORK_DATE, to: WORK_DATE };

const ADMIN: Actor = { id: 'admin-1', role: 'super_admin' };
const EMPLOYEE: Actor = { id: 'emp-a', role: 'agent' };

/**
 * The name every export has to carry intact: a comma that would split the row, an
 * embedded quotation mark that would corrupt every field after it, and non-ASCII
 * characters the file name has to sanitise while the file body does not.
 */
const AWKWARD_NAME = 'Ana, "Nita" Núñez';

/** A reason with a newline in it, which would split the record without quoting. */
const AWKWARD_REASON = 'Family, "urgent"\nmatter';

const TABLES: Tables = {
  profiles: [
    {
      id: 'admin-1',
      display_name: 'Admin One',
      initials: 'A1',
      role: 'super_admin',
      timezone: 'America/New_York',
      is_active: true,
    },
    {
      id: 'emp-a',
      display_name: AWKWARD_NAME,
      initials: 'AN',
      role: 'agent',
      timezone: 'America/New_York',
      is_active: true,
    },
    {
      id: 'emp-b',
      display_name: 'Bob Brown',
      initials: 'BB',
      role: 'customer_service',
      timezone: 'America/New_York',
      is_active: true,
    },
  ],
  employee_schedules: [
    {
      profile_id: 'emp-a',
      schedule_date: WORK_DATE,
      shift_start: '09:00',
      shift_end: '17:00',
      shift_type: 'regular',
      status: 'published',
    },
    {
      profile_id: 'emp-b',
      schedule_date: WORK_DATE,
      shift_start: '09:00',
      shift_end: '17:00',
      shift_type: 'regular',
      status: 'published',
    },
  ],
  // emp-a worked the whole shift with a thirty-minute lunch. emp-b never clocked
  // in, so the date reports as an absence.
  time_clock_entries: [
    {
      id: 'entry-1',
      profile_id: 'emp-a',
      clock_in: '2026-08-10T13:00:00.000Z',
      clock_out: '2026-08-10T21:00:00.000Z',
      total_hours: 7.5,
      break_minutes: 30,
      adjusted_by: null,
      adjustment_reason: null,
    },
  ],
  time_clock_breaks: [
    {
      id: 'break-1',
      clock_entry_id: 'entry-1',
      break_start: '2026-08-10T16:00:00.000Z',
      break_end: '2026-08-10T16:30:00.000Z',
      break_type: 'lunch',
      duration_minutes: 30,
    },
  ],
  pto_requests: [
    {
      id: 'req-1',
      profile_id: 'emp-b',
      pto_type: 'vacation',
      start_date: WORK_DATE,
      end_date: WORK_DATE,
      total_days: 1,
      working_days: 1,
      short_notice: true,
      status: 'pending',
      reason: AWKWARD_REASON,
      denial_reason: null,
      reviewed_by: null,
      reviewed_at: null,
      created_at: '2026-08-01T12:00:00.000Z',
    },
  ],
  employee_payment_settings: [
    {
      profile_id: 'emp-a',
      hourly_rate: 20,
      overtime_multiplier: 1.5,
      weekly_overtime_threshold: 40,
      deductions: [{ label: 'Tax', amount: 10, type: 'percentage' }],
    },
  ],
  attendance_policy: [],
  staffing_thresholds: [],
  attendance_closed_dates: [],
  attendance_day_reviews: [],
  attendance_notes: [],
  attendance_audit_log: [],
  pto_request_decisions: [],
  pto_balances: [],
};

function context() {
  return { client: fakeClient(TABLES), evaluatedAt: EVALUATED_AT };
}

/** The file's records. `toCsv` separates them with CRLF and ends with neither. */
function records(csv: string): string[] {
  return csv.split('\r\n');
}

// ─── The export is the view's read ───────────────────────────────────────────

describe('exportView row agreement', () => {
  it('exports the rows the paged read returns, in the same order', async () => {
    const query = { ...RANGE };
    const page = await getRecords(ADMIN, query, context());
    const file = await exportView(ADMIN, 'attendance_records', { records: query }, context());

    expect(file.rowCount).toBe(page.total);

    // The employee column, in file order, is the page's row order.
    const exported = records(file.csv)
      .slice(1)
      .map((row) => row.split('","')[0].replace(/^"/, ''));
    const displayed = page.rows.map((row) =>
      row.profileId === 'emp-a' ? AWKWARD_NAME.replace(/"/g, '""') : 'Bob Brown',
    );
    expect(exported).toEqual(displayed);
  });

  it('applies the filters the requesting view had active', async () => {
    const query = { ...RANGE, savedFilter: 'absences' } as const;
    const page = await getRecords(ADMIN, query, context());
    const file = await exportView(ADMIN, 'attendance_records', { records: query }, context());

    expect(page.total).toBe(1);
    expect(file.rowCount).toBe(1);
    expect(file.csv).toContain('"Bob Brown"');
    expect(file.csv).not.toContain('Núñez');
  });

  it('drops the paging the caller sent rather than exporting one page', async () => {
    const file = await exportView(
      ADMIN,
      'attendance_records',
      { records: { ...RANGE, page: 1, limit: 1 } },
      context(),
    );

    expect(file.rowCount).toBe(2);
  });
});

// ─── The six views ───────────────────────────────────────────────────────────

describe('exportView view shapes', () => {
  it('writes a quoted header and one record per row, embedded quotes doubled', async () => {
    const file = await exportView(ADMIN, 'attendance_records', { records: RANGE }, context());
    const rows = records(file.csv);

    expect(rows[0].startsWith('"Employee","Department","Work date"')).toBe(true);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('"Ana, ""Nita"" Núñez"');
    expect(rows[1]).toContain('"Completed"');
    expect(file.notice).toBeNull();
  });

  it('gives the exception queue its own columns, with the rule behind each code', async () => {
    const file = await exportView(ADMIN, 'exception_queue', { records: RANGE }, context());
    const [header, ...rows] = records(file.csv);

    expect(header).toContain('"Exception type"');
    expect(header).toContain('"Payroll impact"');
    expect(header).toContain('"Primary action"');
    expect(rows).toHaveLength(2);
    // The absence carries its rule id and its plain-language description.
    expect(file.csv).toContain('AX-05:');
    // One action per row, from the exception-code lookup the queue row uses.
    expect(file.csv).toContain('"Mark Reviewed"');
    expect(file.csv).toContain('"Add Manager Note"');
  });

  it('exports the payroll period figures for the active roster', async () => {
    const file = await exportView(ADMIN, 'payroll_ready', { range: RANGE }, context());

    // Only emp-a had activity in the period; the other two are dropped.
    expect(file.rowCount).toBe(1);
    expect(file.csv).toContain('"Total hours"');
    expect(file.csv).toContain('"7.5"');
  });

  it('exports time-off activity with the employee reason intact', async () => {
    const file = await exportView(ADMIN, 'time_off_activity', { range: RANGE }, context());

    expect(file.rowCount).toBe(1);
    // The newline survives inside the quoted field rather than splitting the record.
    expect(file.csv).toContain('"Family, ""urgent""\nmatter"');
    expect(file.csv).toContain('"Vacation"');
    expect(file.csv).toContain('"Short notice"');
  });

  it('exports coverage history one row per date of the range', async () => {
    const file = await exportView(
      ADMIN,
      'coverage_history',
      { range: { from: WORK_DATE, to: '2026-08-12' } },
      context(),
    );

    expect(file.rowCount).toBe(3);
    expect(records(file.csv)[0]).toContain('"Projected available"');
    expect(file.filename).toContain('coverage-history_2026-08-10_to_2026-08-12');
  });

  it('exports the twelve trend values for one employee', async () => {
    const file = await exportView(
      ADMIN,
      'employee_trends',
      { range: RANGE, profileId: 'emp-a' },
      context(),
    );

    expect(file.rowCount).toBe(12);
    expect(file.csv).toContain('"scheduled_hours"');
    expect(file.csv).toContain('"manager_note_count"');
  });
});

// ─── Pay columns follow the role ─────────────────────────────────────────────

describe('exportView pay columns', () => {
  it('includes the pay-rate and pay-amount columns for an administrator', async () => {
    const file = await exportView(ADMIN, 'payroll_ready', { range: RANGE }, context());

    expect(file.payColumnsIncluded).toBe(true);
    expect(file.csv).toContain('"Hourly rate"');
    expect(file.csv).toContain('"Gross pay"');
    expect(file.csv).toContain('"Net pay"');
  });

  it('removes them for a caller who does not administer attendance', async () => {
    const file = await exportView(EMPLOYEE, 'payroll_ready', { range: RANGE }, context());

    expect(file.payColumnsIncluded).toBe(false);
    expect(file.csv).not.toContain('Hourly rate');
    expect(file.csv).not.toContain('Gross pay');
    expect(file.csv).not.toContain('Net pay');
    // The hours side is still theirs to see, and the rows are their own.
    expect(file.csv).toContain('"Total hours"');
    expect(file.rowCount).toBe(1);
    expect(file.csv).toContain('Núñez');
  });
});

// ─── The file says what it contains ──────────────────────────────────────────

describe('exportView naming and the empty export', () => {
  it('names the view, the resolved range, and every active filter value', async () => {
    const file = await exportView(
      ADMIN,
      'exception_queue',
      { records: { ...RANGE, savedFilter: 'absences', departments: ['customer_service'] } },
      context(),
    );

    expect(file.filename).toContain('exception-queue');
    expect(file.filename).toContain('2026-08-10_to_2026-08-10');
    expect(file.filename).toContain('department-customer-service');
    expect(file.filename).toContain('filter-absences');
    expect(file.filename.endsWith('.csv')).toBe(true);
    // No character illegal in a file name survives the sanitiser.
    expect(/[<>:"/\\|?*]/.test(file.filename)).toBe(false);
  });

  it('sanitises a subject name into the file name without losing the filter', async () => {
    const file = await exportView(
      ADMIN,
      'employee_trends',
      { range: RANGE, profileId: 'emp-a' },
      context(),
    );

    expect(file.filename).toContain('employee-Ana-Nita-N-ez');
    expect(/[<>:"/\\|?*,]/.test(file.filename)).toBe(false);
  });

  it('produces the header row alone and states that nothing matched', async () => {
    const file = await exportView(
      ADMIN,
      'attendance_records',
      { records: { from: '2026-09-01', to: '2026-09-02' } },
      context(),
    );

    expect(records(file.csv)).toHaveLength(1);
    expect(file.rowCount).toBe(0);
    expect(file.notice).toBe('No records matched 2026-09-01 to 2026-09-02.');
  });
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe('exportView refusals', () => {
  it('refuses a view whose range it will not invent', async () => {
    await expect(exportView(ADMIN, 'payroll_ready', {}, context())).rejects.toThrowError(
      /from is missing/,
    );
    await expect(
      exportView(ADMIN, 'coverage_history', { range: { from: WORK_DATE } }, context()),
    ).rejects.toThrowError(/to is missing/);
  });

  it('refuses a trends export that names no employee', async () => {
    await expect(
      exportView(ADMIN, 'employee_trends', { range: RANGE }, context()),
    ).rejects.toThrowError(/names one employee/);
  });
});

// ─── The query string ────────────────────────────────────────────────────────

describe('parseExportQuery', () => {
  it('reads the view, the range, and that view its own filters', () => {
    const parsed = parseExportQuery(
      new URLSearchParams(
        'view=exception_queue&from=2026-08-01&to=2026-08-14&saved_filter=absences&limit=10',
      ),
    );

    expect(parsed.view).toBe('exception_queue');
    expect(parsed.query.range).toEqual({ from: '2026-08-01', to: '2026-08-14' });
    expect(parsed.query.records?.savedFilter).toBe('absences');
  });

  it('reads a coverage export department and no record filters', () => {
    const parsed = parseExportQuery(
      new URLSearchParams('view=coverage_history&from=2026-08-01&to=2026-08-14&department=sales'),
    );

    expect(parsed.query.department).toBe('sales');
    expect(parsed.query.records).toBeUndefined();
  });

  it('refuses an unrecognised view rather than defaulting to one', () => {
    expect(() => parseExportQuery(new URLSearchParams('view=everything'))).toThrowError(
      /not accepted/,
    );
    expect(() => parseExportQuery(new URLSearchParams(''))).toThrowError(/view is required/);
  });

  it('requires a profile identifier for a trends export', () => {
    expect(() =>
      parseExportQuery(new URLSearchParams('view=employee_trends&from=2026-08-01&to=2026-08-14')),
    ).toThrowError(/profile_id is required/);
  });
});

// src/features/time-attendance/server/export-service.ts
// The six CSV exports of Requirement 15, criterion 1, assembled from the reads
// the screens already use.
//
// ## Why this module issues no query of its own
//
// Requirement 15, criterion 2 says the export applies the filters active in the
// requesting view, criterion 3 says the exported rows are in the same order the
// view displays them, and criterion 7 says the exported attendance values come
// from the Attendance_Service. Those three are one sentence: the export is the
// view's own read with the page removed. So every view here maps onto an existing
// service call —
//
// | export view          | read                                     |
// | -------------------- | ---------------------------------------- |
// | `attendance_records` | `getAllRecords` (`getRecords` unpaged)   |
// | `exception_queue`    | `getAllRecords` (`getRecords` unpaged)   |
// | `payroll_ready`      | `payrollInputs` in `legacy_parity`       |
// | `time_off_activity`  | `listAllRequests` (`listRequests` unpaged) |
// | `coverage_history`   | `getCoverage` in `projected` mode        |
// | `employee_trends`    | `getTrends`                              |
//
// — and the two paged reads were split into an unpaged read plus a slice rather
// than copied, so the exported rows are the same rows selected by the same
// filters in the same order by construction. That is what Correctness Property 33
// measures, and a second read that happened to agree today would be a second read
// that could disagree after one edit.
//
// The two record views share a read and differ only in their column list. The
// Exception_Queue is a `RecordQuery` over the same Daily_Attendance_Records the
// records view shows; what makes it a work queue is which columns it puts in
// front of somebody — the exception, the rule behind it, the payroll impact, and
// the one primary action — so that is what differs here.
//
// Overview has no export of its own, and deliberately. A metric is a figure over
// a record set, and Requirement 13, criterion 5 already hands the Exception_Queue
// the same `RecordQuery` the metric was computed over — so exporting what
// Overview is showing is `attendance_records` with that query. A seventh view that
// re-aggregated the same rows would be a second implementation of the fourteen
// metrics.
//
// ## Pay columns
//
// Requirement 15, criterion 9 restricts pay-rate and pay-amount columns to
// Attendance_Administrator requests. Every column list here passes through
// `withoutPayColumns` for a caller who does not administer attendance, so the
// restriction is one expression at one call site and `toCsv` never sees an actor.
// The columns it removes are marked `pay: true` on their own definitions, so a
// column added to the payroll export declares what it is rather than relying on
// this module to recognise its name.
//
// `payroll_ready` is the view that carries them. It reads through
// `payrollInputs`, which takes no actor and resolves no scope — it is written for
// a caller that has already established the right to see the whole roster's
// figures. A caller who does not administer attendance therefore gets two
// narrowings rather than one: the money columns are removed, and the rows are
// restricted to `visibleProfileIds`, which for a non-administrator is their own
// row. Their hours are their own data (Requirement 21, criterion 1); the roster's
// are not.
//
// ## Instants are exported as instants
//
// A clock-in leaves here as the ISO instant the Attendance_Service holds, not as
// a rendered local time. Rendering one is a display decision, it belongs to the
// screens, and inventing a second formatter here would be a second timezone
// implementation — the thing Requirement 19, criteria 9 and 10 exist to prevent.
// The exported value is the value; a spreadsheet can format it, and a reader
// cannot mistake which zone it is in.
//
// ## The empty export
//
// Requirement 15, criterion 8 has two halves. The file still carries its header
// row, which `toCsv` does for an empty row set, and the export states that no
// records matched, which is `noRecordsNotice` — returned beside the file rather
// than written into it, because a first line of prose is not the header row
// criterion 5 describes and a reader parsing the file would take it for data.
//
// ## What this module does not do
//
// - **No UTF-8 byte-order mark.** Excel wants one to read non-ASCII correctly, and
//   it belongs to the HTTP response, where the encoding is declared. Putting it
//   here would put `\ufeff` inside the first header field.
// - **No authorisation of its own beyond the pay-column and payroll-scope rules
//   above.** Scope is `visibleProfileIds`, resolved inside each read, which is the
//   single place a read decides whose data it may touch.
// - **No derivation.** Statuses, hours, exceptions, coverage figures, working-day
//   counts, and pay arithmetic are all read off the services. What is computed
//   here is the text of a cell.
//
// Requirements: 15.1 (the six exports), 15.2 (the requesting view's filters),
// 15.3 (the view's order), 15.4 and 15.5 (through `toCsv`), 15.6 (through
// `exportFileName`), 15.7 (values from the Attendance_Service), 15.8 (the header
// row and the statement that nothing matched), 15.9 (pay columns restricted to an
// Attendance_Administrator).

import type { Department } from '@/lib/permissions';

import type { RecordQuery } from '../domain/attendance';
import {
  EXPORT_VIEWS,
  exportFileName,
  fileNameToken,
  noRecordsNotice,
  toCsv,
  withoutPayColumns,
  type CsvColumn,
  type ExportView,
  type FilterSummary,
  type FilterValue,
} from '../domain/csv';
import { ROW_ACTION_LABELS, primaryRowAction, statusToken } from '../domain/presentation';
import type { RequestQuery } from '../domain/pto';
import type { DailyAttendanceRecord, DateRange } from '../domain/types';
import { DEPARTMENT_LABELS, PTO_STATUS_STYLES, PTO_TYPE_LABELS } from '../types';
import {
  AttendanceServiceError,
  getAllRecords,
  getTrends,
  payrollInputs,
  withoutRecordPaging,
  type AttendanceEmployee,
  type PayrollInputRow,
  type TrendValue,
} from './attendance-service';
import {
  getCoverage,
  isComputedCoverageDate,
  type CoverageContext,
  type CoverageDate,
} from './coverage-service';
import { listAllRequests, withoutRequestPaging, type RequestRow } from './pto-service';
import { canAdministerAttendance, visibleProfileIds, type Actor } from './visibility';

// ─── The request ─────────────────────────────────────────────────────────────

/** Everything an export needs besides the view it is of. */
export type ExportContext = CoverageContext;

/**
 * One export request: the active range, and the filters the requesting view had
 * active.
 *
 * One shape for all six views rather than a union, because the route resolves a
 * view identifier from a query string and hands over whatever that view's filter
 * controls carry. Each view reads the fields it has, and a field belonging to
 * another view is ignored rather than refused: sending `department` alongside
 * `saved_filter` is what a screen with both controls does, and refusing it would
 * make the caller strip fields it has no reason to know are irrelevant.
 *
 * `range` is optional because the two record views resolve their own default —
 * the Attendance_Service's fallback fortnight — and an export of an unranged
 * query should be the same rows the unranged view showed. The other four views
 * read through calls that have no default of their own, so the range is required
 * for those and its absence is reported rather than invented.
 */
export interface ExportQuery {
  /**
   * The active date range, inclusive at both ends. Named in the file name
   * (Requirement 15, criterion 6).
   *
   * Required for `payroll_ready`, `coverage_history`, and `employee_trends`.
   */
  range?: Partial<DateRange>;
  /**
   * The record filters, for `attendance_records` and `exception_queue`. Paging is
   * removed before the read.
   */
  records?: RecordQuery;
  /** The inbox filters, for `time_off_activity`. Paging is removed. */
  requests?: RequestQuery;
  /** Restricts `coverage_history` to one department's roster. */
  department?: Department;
  /** The employee `employee_trends` is about. Required for that view. */
  profileId?: string;
}

/**
 * One assembled export: the file, its name, and what it turned out to contain.
 *
 * `csv` and `filename` are what the design's signature promises. The rest is what
 * the route needs in order to answer completely: `notice` is Requirement 15,
 * criterion 8's statement, present only when nothing matched, and `rowCount` lets
 * a caller say how much it received without parsing the file it was given.
 */
export interface ExportResult {
  view: ExportView;
  filename: string;
  csv: string;
  /** Data rows, header excluded. */
  rowCount: number;
  /** Requirement 15, criterion 8's statement. Null when rows were exported. */
  notice: string | null;
  /** The range the read resolved, which is the range the file name carries. */
  range: DateRange;
  /** The filters the file name carries. */
  filters: FilterSummary;
  /** Whether the pay-rate and pay-amount columns were included. */
  payColumnsIncluded: boolean;
}

// ─── Cell helpers ────────────────────────────────────────────────────────────

/**
 * Hours and minutes as given.
 *
 * The services already round every figure they report at the boundary that owns
 * it, so rounding again here would be a second rounding rule and could disagree
 * with the screen by a hundredth of an hour. Null reads as the empty cell, which
 * is how CSV states an absent value.
 */
function numberCell(value: number | null | undefined): number | null {
  return value ?? null;
}

/** A yes-or-no cell as words rather than as `true`, which reads as data. */
function flagCell(value: boolean, whenTrue: string, whenFalse: string): string {
  return value ? whenTrue : whenFalse;
}

/** A department as the label the screens show, or the empty cell. */
function departmentCell(department: Department | null | undefined): string {
  return department === null || department === undefined ? '' : DEPARTMENT_LABELS[department];
}

/**
 * A time span as `start to end`, or the words for the ends it is missing.
 *
 * Requirement 12, criterion 5 asks the Exception_Queue row for a scheduled span
 * and an actual span, and both can be partly or wholly absent: an unscheduled
 * date has neither bound, and an open session has a start and no end. Stated in
 * words rather than left blank, because a blank cell beside a populated one reads
 * as data that failed to export.
 */
function spanCell(start: string | null, end: string | null, absent: string): string {
  if (start === null && end === null) return absent;
  if (start === null) return `unknown to ${end}`;
  if (end === null) return `${start} to open`;
  return `${start} to ${end}`;
}

/** The employees a record export refers to, keyed for the row builders. */
type EmployeeIndex = ReadonlyMap<string, AttendanceEmployee>;

function employeeIndexOf(employees: readonly AttendanceEmployee[]): EmployeeIndex {
  return new Map(employees.map((employee) => [employee.profileId, employee]));
}

/** One record row, paired with the employee it is about. */
interface RecordLine {
  record: DailyAttendanceRecord;
  employee: AttendanceEmployee | null;
}

function recordLines(
  records: readonly DailyAttendanceRecord[],
  employees: EmployeeIndex,
): RecordLine[] {
  return records.map((record) => ({
    record,
    employee: employees.get(record.profileId) ?? null,
  }));
}

// ─── attendance_records ──────────────────────────────────────────────────────

/**
 * The filtered attendance records, field for field as the Attendance_Service
 * reports them.
 *
 * The exposed fields of Requirement 3, criterion 3, which is what the record set
 * is: an export of this view is evidence about what the derivation concluded, so
 * the rule that assigned the status travels with it.
 */
const ATTENDANCE_RECORD_COLUMNS: readonly CsvColumn<RecordLine>[] = [
  { label: 'Employee', value: (line) => line.employee?.displayName ?? line.record.profileId },
  { label: 'Department', value: (line) => departmentCell(line.employee?.department) },
  { label: 'Work date', value: (line) => line.record.workDate },
  { label: 'Scheduled start', value: (line) => line.record.scheduledStart },
  { label: 'Scheduled end', value: (line) => line.record.scheduledEnd },
  { label: 'Scheduled hours', value: (line) => numberCell(line.record.scheduledHours) },
  { label: 'First clock-in', value: (line) => line.record.firstClockIn },
  { label: 'Last clock-out', value: (line) => line.record.lastClockOut },
  {
    label: 'Open session',
    value: (line) => flagCell(line.record.hasOpenSession, 'Open', 'Closed'),
  },
  { label: 'Worked hours', value: (line) => numberCell(line.record.workedHours) },
  { label: 'Paid break minutes', value: (line) => numberCell(line.record.paidBreakMinutes) },
  { label: 'Unpaid break minutes', value: (line) => numberCell(line.record.unpaidBreakMinutes) },
  { label: 'Late minutes', value: (line) => numberCell(line.record.lateMinutes) },
  {
    label: 'Early departure minutes',
    value: (line) => numberCell(line.record.earlyDepartureMinutes),
  },
  { label: 'Status', value: (line) => statusToken(line.record.derivedStatus).label },
  { label: 'Status rule', value: (line) => line.record.statusRuleId },
  {
    label: 'Exceptions',
    value: (line) => line.record.exceptions.map((exception) => exception.code).join('; '),
  },
  {
    label: 'Payroll impact',
    value: (line) => flagCell(line.record.payrollBlocking, 'Payroll blocking', 'None'),
  },
  {
    label: 'Review status',
    value: (line) => flagCell(line.record.reviewedAt !== null, 'Reviewed', 'Unreviewed'),
  },
  { label: 'Reviewed at', value: (line) => line.record.reviewedAt },
];

// ─── exception_queue ─────────────────────────────────────────────────────────

/**
 * The Exception_Queue's own columns: the ten fields Requirement 12, criterion 5
 * names, plus the rule behind each exception and the derived status.
 *
 * The primary action is `primaryRowAction`, the same exception-code lookup the
 * queue row renders, so the exported action is the action the screen offered
 * rather than a second reading of the same exception list (Requirement 12,
 * criteria 6 and 7).
 *
 * The rule descriptions are here because an exception code alone is not evidence.
 * Requirement 12, criterion 11 puts the rule in the drawer as visible text, and an
 * export somebody sends onward without the drawer needs to carry it too.
 */
const EXCEPTION_QUEUE_COLUMNS: readonly CsvColumn<RecordLine>[] = [
  { label: 'Employee', value: (line) => line.employee?.displayName ?? line.record.profileId },
  { label: 'Department', value: (line) => departmentCell(line.employee?.department) },
  { label: 'Work date', value: (line) => line.record.workDate },
  {
    label: 'Exception type',
    value: (line) => line.record.exceptions.map((exception) => exception.code).join('; '),
  },
  {
    label: 'Exception rule',
    value: (line) =>
      line.record.exceptions
        .map((exception) => `${exception.ruleId}: ${exception.ruleDescription}`)
        .join(' | '),
  },
  {
    label: 'Scheduled span',
    value: (line) =>
      spanCell(line.record.scheduledStart, line.record.scheduledEnd, 'Not scheduled'),
  },
  {
    label: 'Actual span',
    value: (line) => spanCell(line.record.firstClockIn, line.record.lastClockOut, 'No clock events'),
  },
  { label: 'Worked hours', value: (line) => numberCell(line.record.workedHours) },
  {
    label: 'Payroll impact',
    value: (line) => flagCell(line.record.payrollBlocking, 'Payroll blocking', 'None'),
  },
  {
    label: 'Review status',
    value: (line) => flagCell(line.record.reviewedAt !== null, 'Reviewed', 'Unreviewed'),
  },
  { label: 'Primary action', value: (line) => ROW_ACTION_LABELS[primaryRowAction(line.record)] },
  { label: 'Status', value: (line) => statusToken(line.record.derivedStatus).label },
];

// ─── payroll_ready ───────────────────────────────────────────────────────────

/**
 * The per-employee payroll figures for a period, exactly as
 * `/api/payroll/calculate` consumes them.
 *
 * Seven columns are marked `pay`: the hourly rate, and the six money amounts.
 * `withoutPayColumns` removes those for a caller who does not administer
 * attendance, leaving the hours and the paid-absence day count — which is a
 * statement about time worked rather than about money (Requirement 15,
 * criterion 9).
 *
 * `PTO hours paid` stays because it is hours. It multiplies out to money only
 * when a rate is applied, and the rate is one of the columns that left.
 */
const PAYROLL_READY_COLUMNS: readonly CsvColumn<PayrollInputRow>[] = [
  { label: 'Employee', value: (row) => row.displayName },
  { label: 'Initials', value: (row) => row.initials },
  { label: 'Role', value: (row) => row.role },
  { label: 'Regular hours', value: (row) => numberCell(row.regularHours) },
  { label: 'Overtime hours', value: (row) => numberCell(row.overtimeHours) },
  { label: 'Break hours', value: (row) => numberCell(row.breakHours) },
  { label: 'Total hours', value: (row) => numberCell(row.totalHours) },
  { label: 'PTO days used', value: (row) => numberCell(row.ptoDaysUsed) },
  { label: 'PTO hours paid', value: (row) => numberCell(row.ptoHoursPaid) },
  { label: 'Days worked', value: (row) => numberCell(row.daysWorked) },
  { label: 'Clock entries', value: (row) => numberCell(row.entriesCount) },
  { label: 'Hourly rate', value: (row) => numberCell(row.hourlyRate), pay: true },
  { label: 'Regular pay', value: (row) => numberCell(row.regularPay), pay: true },
  { label: 'Overtime pay', value: (row) => numberCell(row.overtimePay), pay: true },
  { label: 'PTO pay', value: (row) => numberCell(row.ptoPay), pay: true },
  { label: 'Gross pay', value: (row) => numberCell(row.grossPay), pay: true },
  { label: 'Deductions total', value: (row) => numberCell(row.deductionsTotal), pay: true },
  { label: 'Net pay', value: (row) => numberCell(row.netPay), pay: true },
];

// ─── time_off_activity ───────────────────────────────────────────────────────

/**
 * The Request_Inbox's twelve fields (Requirement 7, criterion 5), plus what the
 * employee wrote, what the reviewer answered, and who answered it.
 *
 * An export of time-off activity is the paper trail of a decision, so the reason
 * and the response are the point of it rather than an extra. The coverage risk
 * indicator is null for a non-administrator, whose visibility is their own row and
 * for whom no projection is computed; it exports as the empty cell rather than as
 * a status the data cannot support.
 */
const TIME_OFF_ACTIVITY_COLUMNS: readonly CsvColumn<RequestRow>[] = [
  { label: 'Request id', value: (row) => row.requestId },
  { label: 'Employee', value: (row) => row.employeeName ?? row.profileId },
  { label: 'Department', value: (row) => departmentCell(row.department) },
  { label: 'Request type', value: (row) => PTO_TYPE_LABELS[row.ptoType] },
  { label: 'Start date', value: (row) => row.startDate },
  { label: 'End date', value: (row) => row.endDate },
  { label: 'Working days', value: (row) => numberCell(row.workingDays) },
  { label: 'Stored total days', value: (row) => numberCell(row.totalDays) },
  { label: 'Status', value: (row) => PTO_STATUS_STYLES[row.status].label },
  { label: 'Remaining balance', value: (row) => numberCell(row.remainingBalance) },
  {
    label: 'Coverage risk',
    value: (row) => (row.coverageRisk === null ? '' : statusToken(row.coverageRisk).label),
  },
  { label: 'Submitted at', value: (row) => row.submittedAt },
  { label: 'Awaiting review minutes', value: (row) => numberCell(row.awaitingReviewMinutes) },
  {
    label: 'Short notice',
    value: (row) => flagCell(row.shortNotice, 'Short notice', 'Standard notice'),
  },
  { label: 'Employee reason', value: (row) => row.reason },
  { label: 'Reviewer response', value: (row) => row.reviewerResponse },
  { label: 'Reviewed by', value: (row) => row.reviewedBy },
  { label: 'Reviewed at', value: (row) => row.reviewedAt },
];

// ─── coverage_history ────────────────────────────────────────────────────────

/**
 * One row per date of the Coverage_Calendar: the six figures Requirement 8,
 * criterion 2 asks a date cell to carry, plus the two facts that decide a
 * Health_Ribbon state before any coverage status is read.
 *
 * A date the projection could not be computed for exports its reason and empty
 * figures. Zeroing them would be worse than leaving them out: a reader would take
 * "0 available, Critical" as a claim about a date nothing is known about
 * (Requirement 9, criterion 14).
 */
const COVERAGE_HISTORY_COLUMNS: readonly CsvColumn<CoverageDate>[] = [
  { label: 'Work date', value: (date) => date.workDate },
  {
    label: 'Day of week',
    value: (date) => (isComputedCoverageDate(date) ? date.dayOfWeek : null),
  },
  { label: 'Time slot', value: (date) => (isComputedCoverageDate(date) ? date.timeSlot : '') },
  {
    label: 'Closed',
    value: (date) => (isComputedCoverageDate(date) ? flagCell(date.closed, 'Closed', 'Open') : ''),
  },
  {
    label: 'Closed label',
    value: (date) => (isComputedCoverageDate(date) ? date.closedLabel : null),
  },
  {
    label: 'Has published schedule',
    value: (date) =>
      isComputedCoverageDate(date)
        ? flagCell(date.hasPublishedSchedule, 'Scheduled', 'No schedule')
        : '',
  },
  {
    label: 'Scheduled',
    value: (date) => (isComputedCoverageDate(date) ? date.projection.scheduled : null),
  },
  {
    label: 'Approved absences',
    value: (date) => (isComputedCoverageDate(date) ? date.projection.approvedAbsences : null),
  },
  {
    label: 'Proposed absences',
    value: (date) => (isComputedCoverageDate(date) ? date.projection.proposedAbsences : null),
  },
  {
    label: 'Pending requests',
    value: (date) => (isComputedCoverageDate(date) ? date.pendingRequests.length : null),
  },
  {
    label: 'Projected available',
    value: (date) => (isComputedCoverageDate(date) ? date.projection.available : null),
  },
  {
    label: 'Raw available',
    value: (date) => (isComputedCoverageDate(date) ? date.projection.rawAvailable : null),
  },
  {
    label: 'Required staff',
    value: (date) => (isComputedCoverageDate(date) ? date.projection.requiredStaff : null),
  },
  {
    label: 'Coverage status',
    value: (date) => (isComputedCoverageDate(date) ? statusToken(date.projection.status).label : ''),
  },
  {
    label: 'Interval count',
    value: (date) => (isComputedCoverageDate(date) ? date.intervals.length : null),
  },
  {
    label: 'Unavailable reason',
    value: (date) => (isComputedCoverageDate(date) ? '' : date.unavailable.reason),
  },
];

// ─── employee_trends ─────────────────────────────────────────────────────────

/** One trend value, with the employee and range it was computed over. */
interface TrendLine {
  employeeName: string;
  range: DateRange;
  value: TrendValue;
}

/**
 * The twelve values of Requirement 14, criterion 2, one row each, in the order the
 * criterion states them.
 *
 * A summary rather than a day-by-day history, because the day-by-day history is
 * `attendance_records` with a `profile_id` filter and two of the six exports
 * carrying the same shape would be one export too many. `Records` is the size of
 * the set behind the figure, which is the drill-down Requirement 14, criterion 4
 * opens — so a reader can tell a zero computed over eighty records from a zero
 * computed over none.
 */
const EMPLOYEE_TREND_COLUMNS: readonly CsvColumn<TrendLine>[] = [
  { label: 'Employee', value: (line) => line.employeeName },
  { label: 'Range from', value: (line) => line.range.from },
  { label: 'Range to', value: (line) => line.range.to },
  { label: 'Measure', value: (line) => line.value.key },
  { label: 'Label', value: (line) => line.value.label },
  { label: 'Unit', value: (line) => line.value.unit },
  { label: 'Value', value: (line) => numberCell(line.value.value) },
  { label: 'Records', value: (line) => numberCell(line.value.recordCount) },
];

// ─── Filter summaries ────────────────────────────────────────────────────────
//
// Requirement 15, criterion 6 puts every active filter value in the file name, so
// each view states its own active filters here. The keys are the filter's own
// name, because `department-sales` says what `sales` was filtering — and the
// values are the resolved query's, not the caller's, so a filter the read applied
// on the caller's behalf (the resolved scope, the resolved range) is named too.
//
// `from` and `to` are omitted from every summary: `exportFileName` already carries
// the range as its own group, and repeating it would name both dates twice.

function assignFilter(
  summary: Record<string, FilterValue | readonly FilterValue[] | null | undefined>,
  field: string,
  value: FilterValue | readonly FilterValue[] | null | undefined,
): void {
  if (value !== undefined) summary[field] = value;
}

function recordFilterSummary(query: RecordQuery): FilterSummary {
  const summary: Record<string, FilterValue | readonly FilterValue[] | null | undefined> = {};
  assignFilter(summary, 'employee', query.profileIds);
  assignFilter(summary, 'department', query.departments);
  assignFilter(summary, 'status', query.statuses);
  assignFilter(summary, 'exception', query.exceptionCodes);
  assignFilter(summary, 'review', query.reviewStatus);
  assignFilter(
    summary,
    'payroll',
    query.payrollBlocking === undefined
      ? undefined
      : query.payrollBlocking
        ? 'blocking'
        : 'not-blocking',
  );
  assignFilter(summary, 'filter', query.savedFilter);
  assignFilter(summary, 'predicate', query.predicates);
  return summary;
}

function requestFilterSummary(query: RequestQuery): FilterSummary {
  const summary: Record<string, FilterValue | readonly FilterValue[] | null | undefined> = {};
  assignFilter(summary, 'status', query.statuses);
  assignFilter(summary, 'department', query.departments);
  assignFilter(summary, 'employee', query.profileIds);
  assignFilter(summary, 'type', query.ptoTypes);
  assignFilter(summary, 'risk', query.coverageRisks);
  return summary;
}

// ─── Refusals ────────────────────────────────────────────────────────────────
//
// `AttendanceServiceError` is reused rather than copied, for the same reason
// `coverage-service.ts` reuses it: its codes already have a shape in
// `api-response.ts`, so `serviceFailure` maps an export failure without a branch
// of its own.

function invalidView(view: string): AttendanceServiceError {
  return new AttendanceServiceError(
    'invalid_parameter',
    `export: "${view}" is not an exportable view. Accepted views are ${EXPORT_VIEWS.join(', ')}.`,
    { field: 'view', value: view },
  );
}

/**
 * The range this view cannot be read without.
 *
 * `payroll_ready`, `coverage_history`, and `employee_trends` read through calls
 * that have no default range of their own. Inventing one here would be a fourth
 * place a default range is decided, and an export named for a range nobody asked
 * for is an export that does not say what it contains.
 */
function requiredRange(view: ExportView, range: Partial<DateRange> | undefined): DateRange {
  const from = range?.from;
  const to = range?.to;
  if (from === undefined || to === undefined) {
    const missing = from === undefined ? 'from' : 'to';
    throw new AttendanceServiceError(
      'invalid_range',
      `export: the ${view} export names its own date range; ${missing} is missing`,
      { field: missing, view },
    );
  }
  return { from, to };
}

// ─── One export ──────────────────────────────────────────────────────────────

/** One view's rows, already serialised, with what the file name has to say. */
interface ViewFile {
  csv: string;
  /** Data rows, header excluded. */
  rowCount: number;
  /** The range the read resolved. */
  range: DateRange;
  /** The filters the read applied. */
  filters: FilterSummary;
}

/**
 * One view's rows as a file.
 *
 * Generic, and called once per view with that view's own row type, so a column
 * accessor is checked against the rows it will run over. Erasing the row type to
 * a common shape would need a cast per view, and a cast is exactly what would let
 * a mismatched column list through.
 *
 * The pay-column removal happens here rather than at each call site, so the
 * decision of Requirement 15, criterion 9 is applied to every view by the same
 * expression.
 */
function serialise<T>(
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
  payColumnsIncluded: boolean,
  range: DateRange,
  filters: FilterSummary,
): ViewFile {
  return {
    csv: toCsv(rows, payColumnsIncluded ? columns : withoutPayColumns(columns)),
    rowCount: rows.length,
    range,
    filters,
  };
}

/** The requested view, read and serialised. */
async function readView(
  actor: Actor,
  view: ExportView,
  q: ExportQuery,
  context: ExportContext,
  payColumnsIncluded: boolean,
): Promise<ViewFile> {
  switch (view) {
    case 'attendance_records':
    case 'exception_queue': {
      const set = await getAllRecords(actor, withoutRecordPaging(q.records ?? {}), context);
      return serialise(
        recordLines(set.rows, employeeIndexOf(set.employees)),
        view === 'exception_queue' ? EXCEPTION_QUEUE_COLUMNS : ATTENDANCE_RECORD_COLUMNS,
        payColumnsIncluded,
        set.range,
        recordFilterSummary(set.query),
      );
    }

    case 'payroll_ready': {
      const range = requiredRange(view, q.range);

      // `payrollInputs` resolves no scope of its own — see the module note. An
      // administrator reads the roster; anybody else reads the rows the module's
      // one scoping seam admits, which for them is their own.
      const scope = canAdministerAttendance(actor.role) ? 'all' : await visibleProfileIds(actor);
      const rows = await payrollInputs(range, 'legacy_parity', context);

      return serialise(
        scope === 'all' ? rows : rows.filter((row) => scope.includes(row.profileId)),
        PAYROLL_READY_COLUMNS,
        payColumnsIncluded,
        range,
        // The period is the whole filter: the calculation runs over the active
        // roster and takes none of the record filters.
        {},
      );
    }

    case 'time_off_activity': {
      const requests = withoutRequestPaging(q.requests ?? {});
      if (q.range?.from !== undefined) requests.from = q.range.from;
      if (q.range?.to !== undefined) requests.to = q.range.to;

      const set = await listAllRequests(actor, requests, context);
      return serialise(
        set.rows,
        TIME_OFF_ACTIVITY_COLUMNS,
        payColumnsIncluded,
        set.range,
        requestFilterSummary(set.query),
      );
    }

    case 'coverage_history': {
      const range = requiredRange(view, q.range);
      const coverage = await getCoverage(
        actor,
        {
          ...range,
          mode: 'projected',
          ...(q.department === undefined ? {} : { department: q.department }),
        },
        context,
      );

      return serialise(
        coverage.dates,
        COVERAGE_HISTORY_COLUMNS,
        payColumnsIncluded,
        coverage.range,
        q.department === undefined ? {} : { department: q.department },
      );
    }

    case 'employee_trends': {
      const range = requiredRange(view, q.range);
      const profileId = q.profileId;
      if (profileId === undefined || profileId.trim() === '') {
        throw new AttendanceServiceError(
          'invalid_parameter',
          'export: the employee_trends export names one employee',
          { field: 'profileId', view },
        );
      }

      const trends = await getTrends(actor, profileId, range, context);
      const employeeName = trends.employee?.displayName ?? trends.profileId;

      // The subject in the file name is the display name where the name survives
      // tokenising, and the identifier where it does not. Requirement 15,
      // criterion 6 asks for the active filter's value in the name, and a name
      // made entirely of characters a file name cannot carry — a wholly
      // non-Latin display name — tokenises to nothing and would leave the export
      // named for no employee at all. `fileNameToken` is the same function
      // `exportFileName` will apply, so the test and the outcome cannot disagree.
      const named = fileNameToken(employeeName) === '' ? trends.profileId : employeeName;

      return serialise(
        trends.values.map<TrendLine>((value) => ({
          employeeName,
          range: trends.range,
          value,
        })),
        EMPLOYEE_TREND_COLUMNS,
        payColumnsIncluded,
        trends.range,
        { employee: named },
      );
    }
  }
}

/**
 * One CSV export: the requesting view's rows, in the view's order, under a name
 * that says what the file contains.
 *
 * The whole function is five steps, and none of them is a rule of its own:
 *
 *  1. Check the view. An unrecognised identifier is refused rather than defaulted,
 *     because answering a request for an unknown view with the attendance records
 *     export hands somebody a file that does not contain what they asked for.
 *  2. Read, through the service the requesting screen reads through, with paging
 *     removed (Requirement 15, criteria 2, 3, and 7).
 *  3. Remove the pay-rate and pay-amount columns unless the caller administers
 *     attendance (criterion 9).
 *  4. Serialise through `toCsv`, which quotes every field, doubles embedded
 *     quotes, writes the header from the column labels, and preserves the row
 *     order it is given (criteria 3, 4, 5, and 8).
 *  5. Name the file from the resolved range and the resolved filters (criterion 6),
 *     and state that nothing matched when nothing did (criterion 8).
 *
 * @throws AttendanceServiceError `invalid_parameter` for an unknown view or a
 *   trends export naming no employee, `invalid_range` for a view whose range is
 *   required and absent or whose range the read refuses, `not_visible` for an
 *   employee outside the caller's visibility, and `read_failed` for a source read
 *   that failed. Every code already has a shape in `api-response.ts`.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9
 */
export async function exportView(
  actor: Actor,
  view: ExportView,
  q: ExportQuery,
  context: ExportContext,
): Promise<ExportResult> {
  if (!EXPORT_VIEWS.includes(view)) throw invalidView(String(view));

  const payColumnsIncluded = canAdministerAttendance(actor.role);
  const file = await readView(actor, view, q, context, payColumnsIncluded);

  return {
    view,
    filename: exportFileName(view, file.range, file.filters),
    csv: file.csv,
    rowCount: file.rowCount,
    notice: file.rowCount === 0 ? noRecordsNotice(file.range, file.filters) : null,
    range: file.range,
    filters: file.filters,
    payColumnsIncluded,
  };
}

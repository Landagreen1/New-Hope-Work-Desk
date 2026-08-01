// src/features/time-attendance/review/ReviewCenter.tsx
// The fourth Time & Attendance navigation item, and the one decision it makes:
// which of five views is on screen.
//
// Requirement 12, criterion 1 fixes the order — Exceptions, Overview, Employee
// Trends, Exports, Audit Log — and criterion 2 fixes which one opens. Both are
// stated once, in `REVIEW_VIEWS` and `DEFAULT_REVIEW_VIEW`, so the order a reader
// sees and the order the criterion names cannot drift apart.
//
// Opening on Exceptions rather than on Overview is the whole point of the
// requirement's user story: the first screen is a work queue, not a chart. The
// Overview exists so that a number can be explained, which is the opposite
// direction of travel and is reached deliberately.
//
// ## What this component owns
//
// Three things, and nothing else:
//
//   - **The active view.** A tab list, and the panel under it.
//   - **The pay periods**, read once from `/api/payroll/periods`, which is what
//     makes the Exception_Queue's date range default to the current pay period
//     (criterion 19). No new endpoint: the payroll screens already read that one,
//     and it is already restricted to the administrators this screen is restricted
//     to.
//   - **The drill-down.** `openExceptionQueue` is the seam Requirement 13,
//     criterion 5 and Requirement 14, criterion 4 need: a metric or a trend value
//     hands over the `RecordQuery` that produced it, and the queue is remounted
//     under that query. The queue therefore shows the rows the figure was computed
//     over rather than a query that happens to resemble it.
//
// The Exceptions view's own state — the filters, the page, the selected row —
// belongs to `ExceptionsWorkspace` below, so the router does not grow a view's
// worth of state every time a view is added.
//
// ## The four views that are not built yet
//
// Overview, Employee Trends, Exports, and Audit Log are task 20.4. Each has a
// render seam here, taking the context it needs and nothing more, and each is
// optional in the way this module's other seams are optional: absent means the
// view states that it is not available yet rather than rendering an empty panel.
// The tab is still present and still selectable, because criterion 1 is about the
// five views being presented in order and a missing tab would be a different
// screen.
//
// ## Why the current pay period is resolved here and not on the server
//
// Criterion 19 asks the queue's date-range control to default to the current pay
// period. `payroll_periods` is the only place that range is recorded, and
// `/api/payroll/periods` already returns it. A record read cannot resolve it for
// the caller — `/api/attendance/records` falls back to a fortnight when no range
// is named, deliberately, because only the caller knows which period is current —
// so the resolution is one read and one comparison, here, before the queue's own
// read is issued.
//
// Which calendar date counts as "today" for that comparison is read through
// `workDateOf` in the reader's own zone, and only after mount, so the server and
// the first client render agree. It selects a *default range*; the records
// themselves are always bucketed in the business timezone by the service, which
// is where Requirement 3, criterion 6 lives.
//
// Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.9, 12.10, 12.11,
// 12.12, 12.13, 12.14, 12.17, 12.18, 12.19, 12.20, 13.5, 14.4, 21.1, 22.12,
// 22.14, 22.15, 22.16

'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { canAdministerAttendance } from '@/lib/permissions';

import type { ProfileLite } from '../../nhwd-shared/types';
import { statusLabel } from '../../nhwd-shared/ui';
import type { RecordQuery } from '../domain/attendance';
import type { DailyAttendanceRecord, DateRange } from '../domain/types';
import type { RowAction } from '../domain/presentation';
import { addCalendarDays, workDateOf } from '../domain/work-date';
import type { AttendanceEmployee, RecordPage } from '../server/attendance-service';
import { attendanceJson } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { formatWorkDate } from '../shared/format';
import { recordQueryUrl } from '../shared/record-query';
import { colorRoleToken } from '../shared/tokens';
import { emptyStateMessage, useAsyncResource } from '../shared/useAsyncResource';
import type { PayrollPeriodStatus } from '../types';
import { ExceptionDrawer } from './ExceptionDrawer';
import {
  DEFAULT_EXCEPTION_QUEUE_FILTERS,
  EXCEPTION_QUEUE_PAGE_LIMIT,
  ExceptionQueue,
  exceptionQueueActiveFilters,
  exceptionQueueQuery,
  exceptionRowKey,
  type ExceptionQueueFilters,
} from './ExceptionQueue';

// ─── The five views ──────────────────────────────────────────────────────────

/** The five views of Requirement 12, criterion 1. */
export type ReviewViewId = 'exceptions' | 'overview' | 'trends' | 'exports' | 'audit';

/** One view: what it is called, and what it is for. */
export interface ReviewView {
  id: ReviewViewId;
  label: string;
  description: string;
}

/**
 * The five views, in the order criterion 1 states them.
 *
 * The tab list is rendered from this array, so the order is stated once.
 *
 * Requirements: 12.1
 */
export const REVIEW_VIEWS: readonly ReviewView[] = [
  {
    id: 'exceptions',
    label: 'Exceptions',
    description: 'The records that need action, one row per employee per work date.',
  },
  {
    id: 'overview',
    label: 'Overview',
    description: 'Aggregate attendance metrics, each opening the records behind it.',
  },
  {
    id: 'trends',
    label: 'Employee Trends',
    description: 'One employee over one range, with the evidence behind each figure.',
  },
  {
    id: 'exports',
    label: 'Exports',
    description: 'CSV exports of what the screens show, under the filters they show it with.',
  },
  {
    id: 'audit',
    label: 'Audit Log',
    description: 'Every recorded attendance change, with its actor and its reason.',
  },
];

/**
 * The view the screen opens on (Requirement 12, criterion 2).
 *
 * Requirements: 12.2
 */
export const DEFAULT_REVIEW_VIEW: ReviewViewId = 'exceptions';

// ─── The current pay period ──────────────────────────────────────────────────

/**
 * The fortnight the date range falls back to when no payroll period covers today.
 *
 * Fourteen days, matching the service's own `DEFAULT_RANGE_DAYS`, so an
 * unconfigured payroll calendar produces the same window the record read would
 * have chosen for itself.
 *
 * Requirements: 12.19
 */
export const FALLBACK_RANGE_DAYS = 14;

/** One payroll period, as this screen needs it. */
export interface ReviewPayrollPeriod {
  id: string;
  /** `period_start`, inclusive. */
  from: string;
  /** `period_end`, inclusive. */
  to: string;
  payDate: string | null;
  status: PayrollPeriodStatus | null;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const PAYROLL_PERIOD_STATUSES: readonly PayrollPeriodStatus[] = [
  'open',
  'locked',
  'processed',
  'paid',
];

function optionalDate(value: unknown): string | null {
  return typeof value === 'string' && CALENDAR_DATE.test(value) ? value : null;
}

/**
 * The periods a `/api/payroll/periods` body describes, newest first.
 *
 * Every row is checked rather than cast: the response is the raw table, and a row
 * with an unreadable range would otherwise become a date-range default nobody
 * asked for. A row that cannot be read is dropped, not defaulted.
 */
export function toReviewPayrollPeriods(body: unknown): ReviewPayrollPeriod[] {
  if (typeof body !== 'object' || body === null) return [];

  const rows = (body as { periods?: unknown }).periods;
  if (!Array.isArray(rows)) return [];

  const periods: ReviewPayrollPeriod[] = [];

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const source = row as Record<string, unknown>;

    const id = typeof source.id === 'string' ? source.id : null;
    const from = optionalDate(source.period_start);
    const to = optionalDate(source.period_end);
    if (id === null || from === null || to === null || from > to) continue;

    const status = PAYROLL_PERIOD_STATUSES.find((candidate) => candidate === source.status) ?? null;

    periods.push({ id, from, to, payDate: optionalDate(source.pay_date), status });
  }

  return periods.sort((a, b) => b.from.localeCompare(a.from) || b.to.localeCompare(a.to));
}

/**
 * The period covering a date, or null when none does.
 *
 * The latest starting one where several overlap, which is the one an administrator
 * would call current: overlapping periods are a configuration fault, and choosing
 * the newest is the reading that does not silently show last fortnight's work.
 *
 * Requirements: 12.19
 */
export function payPeriodCovering(
  periods: readonly ReviewPayrollPeriod[],
  date: string,
): ReviewPayrollPeriod | null {
  let best: ReviewPayrollPeriod | null = null;

  for (const period of periods) {
    if (period.from > date || period.to < date) continue;
    if (best === null || period.from > best.from) best = period;
  }

  return best;
}

/** The fortnight ending on `date`, both bounds inclusive. */
export function fallbackRange(date: string): DateRange {
  return { from: addCalendarDays(date, -(FALLBACK_RANGE_DAYS - 1)), to: date };
}

/**
 * The range the Exception_Queue opens on: the current pay period, or the fallback
 * fortnight when no period covers the date.
 *
 * Requirements: 12.19
 */
export function defaultExceptionRange(
  periods: readonly ReviewPayrollPeriod[],
  date: string,
): DateRange {
  const covering = payPeriodCovering(periods, date);
  return covering === null ? fallbackRange(date) : { from: covering.from, to: covering.to };
}

/**
 * Today's calendar date in the reader's own zone, through the module's one
 * conversion.
 *
 * Read after mount only, so the server render and the first client render agree.
 * It chooses a default range and nothing else: which work date a clock instant
 * belongs to is the service's decision, in the business timezone.
 *
 * Exported because the Overview's date presets ask the same question — today,
 * yesterday, this week, last week — and a second copy of it in that module would
 * be a second place the display zone is read, which is what Requirement 19,
 * criterion 9 exists to prevent.
 *
 * Requirements: 13.1, 19.9
 */
export function readerWorkDate(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    return workDateOf(new Date(), zone);
  } catch {
    return workDateOf(new Date(), 'UTC');
  }
}

// ─── The seams for the other four views ──────────────────────────────────────

/** What each of the other four views is given. */
export interface ReviewViewContext {
  profile: ProfileLite;
  /** The payroll periods this screen read, newest first. */
  payPeriods: readonly ReviewPayrollPeriod[];
  /** The period covering today, or null when none does. */
  currentPayPeriod: ReviewPayrollPeriod | null;
  /** The range the Exception_Queue opened on, so a preset can match it. */
  defaultRange: DateRange;
  /**
   * Hand the Exception_Queue a query and switch to it.
   *
   * The drill-down of Requirement 13, criterion 5 and Requirement 14, criterion 4:
   * pass the query that produced the figure, and the queue shows exactly the rows
   * it was computed over.
   */
  openExceptionQueue: (query: RecordQuery) => void;
}

export interface ReviewCenterProps {
  initialProfile: ProfileLite;
  /** Task 20.4's seam: the Overview metrics and their drill-downs. */
  renderOverview?: (context: ReviewViewContext) => ReactNode;
  /** Task 20.4's seam: one employee's history. */
  renderTrends?: (context: ReviewViewContext) => ReactNode;
  /** Task 20.4's seam: the six export triggers. */
  renderExports?: (context: ReviewViewContext) => ReactNode;
  /** Task 20.4's seam: the filtered audit entries. */
  renderAudit?: (context: ReviewViewContext) => ReactNode;
}

/** Stated in a view whose seam has not been supplied. */
function PendingView({ view }: { view: ReviewView }) {
  return (
    <section className="rounded-[22px] border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
      <h2 className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">
        {view.label}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] font-semibold text-slate-500">
        {view.description}
      </p>
      <p className="mx-auto mt-2 max-w-md text-[12px] font-semibold text-slate-400">
        This view is not available on this build. The Exceptions view carries the records it
        would open.
      </p>
    </section>
  );
}

// ─── The Exceptions view ─────────────────────────────────────────────────────

/** A stable empty roster, so a memo does not see a new array every render. */
const NO_EMPLOYEES: readonly AttendanceEmployee[] = [];
const NO_ROWS: readonly DailyAttendanceRecord[] = [];

/**
 * A record list with one record replaced by its recomputed self.
 *
 * Matched on the pair that identifies a record — one employee, one work date. A
 * record the list does not hold is left out rather than appended: the list answers
 * a query, and a row that has just started matching one is the next read's
 * business, not this replacement's.
 *
 * Requirements: 12.14
 */
function withRecord(
  records: readonly DailyAttendanceRecord[],
  next: DailyAttendanceRecord,
): DailyAttendanceRecord[] {
  return records.map((record) =>
    record.profileId === next.profileId && record.workDate === next.workDate ? next : record,
  );
}

interface ExceptionsWorkspaceProps {
  profile: ProfileLite;
  canAdminister: boolean;
  range: DateRange;
  onRangeChange: (next: DateRange) => void;
  defaultRange: DateRange;
  defaultRangeLabel: string;
  rangeNote: string;
  /** The drill-down query this queue was opened under, conjoined onto its own. */
  baseQuery?: RecordQuery;
  /** The saved filter the queue starts on, which a drill-down widens. */
  initialSavedFilter: ExceptionQueueFilters['savedFilter'];
}

/**
 * The Exceptions view: the queue, its read, and the drawer a row opens.
 *
 * Holds the query state and the selection, and nothing else — the queue renders
 * what it is given and the drawer reads only the notes it needs.
 *
 * Requirements: 12.3, 12.4, 12.10, 12.14, 12.17, 12.19
 */
function ExceptionsWorkspace({
  profile,
  canAdminister,
  range,
  onRangeChange,
  defaultRange,
  defaultRangeLabel,
  rangeNote,
  baseQuery,
  initialSavedFilter,
}: ExceptionsWorkspaceProps) {
  const [filters, setFilters] = useState<ExceptionQueueFilters>({
    ...DEFAULT_EXCEPTION_QUEUE_FILTERS,
    savedFilter: initialSavedFilter,
  });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<{
    profileId: string;
    workDate: string;
    action: RowAction;
  } | null>(null);

  const query = useMemo(
    () => exceptionQueueQuery(filters, range, page, baseQuery),
    [filters, range, page, baseQuery],
  );

  const read = useMemo(() => recordQueryUrl('/api/attendance/records', query), [query]);

  const records = useAsyncResource(
    (signal) => attendanceJson<RecordPage>(read.url, { signal }),
    {
      deps: [read.url],
      enabled: !read.unsatisfiable,
      subject: 'attendance records',
      isEmpty: (response) => response.rows.length === 0,
    },
  );

  const data = records.data;
  const rows = read.unsatisfiable ? NO_ROWS : (data?.rows ?? NO_ROWS);
  const employees = data?.employees ?? NO_EMPLOYEES;

  const activeFilters = useMemo(
    () => exceptionQueueActiveFilters(filters, range),
    [filters, range],
  );
  const emptyMessage = emptyStateMessage('attendance records', activeFilters);

  // Resolved against the held page rather than kept as its own copy of the row, so
  // the drawer always describes the record as the last read or the last write
  // returned it. A row that has left the page resolves to nothing and the drawer
  // reports the date as carrying no record.
  const selectedRecord =
    selected === null
      ? null
      : (rows.find(
          (row) => row.profileId === selected.profileId && row.workDate === selected.workDate,
        ) ?? null);

  const selectedEmployee =
    selected === null
      ? undefined
      : employees.find((employee) => employee.profileId === selected.profileId);

  // The reader's own zone, from the read's employee list, for the one case the
  // selected employee is not in it. `ProfileLite` carries no timezone, and the
  // employee rows do.
  const fallbackTimeZone =
    employees.find((employee) => employee.profileId === profile.id)?.timezone ?? 'UTC';

  const setData = records.setData;
  const refresh = records.refresh;

  /**
   * A committed write from the drawer.
   *
   * The recomputed record replaces the affected row in the held page, so the
   * status, the worked hours, and the exception list the reader is looking at move
   * immediately and without a request (criterion 14). The refresh that follows
   * catches what a replacement cannot express: a corrected row can stop matching
   * the active saved filter, and a reviewed row leaves `needs attention` entirely.
   *
   * A response carrying no record is a note on a date with nothing else recorded.
   * There is no row to replace, so the refresh is the whole answer.
   */
  const onCommitted = useCallback(
    (record: DailyAttendanceRecord | null) => {
      if (record !== null && data !== null) {
        setData({ ...data, rows: withRecord(data.rows, record) });
      }
      refresh();
    },
    [data, refresh, setData],
  );

  const onFiltersChange = useCallback((next: ExceptionQueueFilters) => {
    setFilters(next);
  }, []);

  const onSelectRow = useCallback(
    (profileId: string, workDate: string, action: RowAction) => {
      setSelected({ profileId, workDate, action });
    },
    [],
  );

  return (
    <>
      <ExceptionQueue
        rows={rows}
        employees={employees}
        total={read.unsatisfiable ? 0 : (data?.total ?? rows.length)}
        page={data?.page ?? page}
        limit={data?.limit ?? EXCEPTION_QUEUE_PAGE_LIMIT}
        hasMore={read.unsatisfiable ? false : (data?.hasMore ?? false)}
        range={range}
        onRangeChange={onRangeChange}
        defaultRange={defaultRange}
        defaultRangeLabel={defaultRangeLabel}
        rangeNote={rangeNote}
        filters={filters}
        onFiltersChange={onFiltersChange}
        onPageChange={setPage}
        selectedRowKey={
          selected === null ? null : exceptionRowKey(selected.profileId, selected.workDate)
        }
        onSelectRow={onSelectRow}
        selectionOpensDialog
        status={read.unsatisfiable ? 'empty' : records.status}
        failure={read.unsatisfiable ? null : records.failure}
        emptyMessage={emptyMessage}
        pending={records.pending}
        onRetry={records.retry}
      />

      {/* Criterion 10: the row's drawer, for that employee and work date. */}
      <ExceptionDrawer
        profileId={selected?.profileId ?? null}
        workDate={selected?.workDate ?? null}
        employee={selectedEmployee}
        record={selectedRecord}
        employees={employees}
        fallbackTimeZone={fallbackTimeZone}
        canAdminister={canAdminister}
        initialAction={selected?.action ?? null}
        onClose={() => setSelected(null)}
        onCommitted={onCommitted}
      />
    </>
  );
}

// ─── The screen ──────────────────────────────────────────────────────────────

/**
 * The Review_Center: five views in order, Exceptions active by default.
 *
 * Requirements: 12.1, 12.2, 12.19, 13.5, 14.4, 21.1
 */
export function ReviewCenter({
  initialProfile,
  renderOverview,
  renderTrends,
  renderExports,
  renderAudit,
}: ReviewCenterProps) {
  const canAdminister = canAdministerAttendance(initialProfile.role);

  const [view, setView] = useState<ReviewViewId>(DEFAULT_REVIEW_VIEW);
  // Read once, on the first render, so a screen left open past midnight does not
  // move the range under the reader. Nothing derived from it is rendered until the
  // payroll read has resolved, which happens on the client, so the server render
  // and the first client render produce the same output whatever zone each is in.
  const [today] = useState(readerWorkDate);
  /**
   * The range the reader chose, or null while the default stands.
   *
   * Held as an override rather than seeded from the default, so there is no effect
   * copying one piece of state into another: the active range is the override where
   * there is one and the default otherwise, which is a single expression and cannot
   * fall out of step.
   */
  const [rangeOverride, setRangeOverride] = useState<DateRange | null>(null);
  const [drillDown, setDrillDown] = useState<RecordQuery | null>(null);
  // Bumped by a drill-down, so the queue is remounted under the new question
  // rather than keeping the filters and the page of the old one.
  const [queueEpoch, setQueueEpoch] = useState(0);

  const periods = useAsyncResource(
    (signal) => attendanceJson<unknown>('/api/payroll/periods', { signal }),
    {
      enabled: canAdminister,
      subject: 'payroll periods',
      isEmpty: () => false,
    },
  );

  const periodsBody = periods.data;
  const payPeriods = useMemo(() => toReviewPayrollPeriods(periodsBody), [periodsBody]);

  // The read has to have settled before a default is chosen, or the queue would
  // open on the fallback fortnight and jump to the pay period a moment later.
  const settled = !canAdminister || periods.status !== 'loading';

  const currentPayPeriod = useMemo(
    () => (settled ? payPeriodCovering(payPeriods, today) : null),
    [settled, payPeriods, today],
  );

  const defaultRange = useMemo<DateRange | null>(
    () => (settled ? defaultExceptionRange(payPeriods, today) : null),
    [settled, payPeriods, today],
  );

  /** The active range: the reader's choice, or the default until they make one. */
  const range = rangeOverride ?? defaultRange;

  const openExceptionQueue = useCallback((query: RecordQuery) => {
    setDrillDown(query);
    if (query.from !== undefined && query.to !== undefined) {
      setRangeOverride({ from: query.from, to: query.to });
    }
    setQueueEpoch((epoch) => epoch + 1);
    setView('exceptions');
  }, []);

  const clearDrillDown = useCallback(() => {
    setDrillDown(null);
    setQueueEpoch((epoch) => epoch + 1);
  }, []);

  const accent = colorRoleToken('accent');

  // Requirement 1, criteria 3 and 4 put Review behind the administration
  // predicate, and the workspace gates the section. This says so rather than
  // rendering controls every endpoint would refuse.
  if (!canAdminister) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-black tracking-tight text-slate-950">Review</h1>
        <p className="rounded-[22px] border border-slate-200 bg-white px-4 py-4 text-[13px] font-semibold text-slate-500 shadow-sm">
          Attendance review is available to attendance administrators. Your own attendance is on
          the Today screen, and your time-off requests are on Time Off &amp; Coverage.
        </p>
      </div>
    );
  }

  const activeView = REVIEW_VIEWS.find((candidate) => candidate.id === view) ?? REVIEW_VIEWS[0];

  const rangeNote =
    currentPayPeriod !== null
      ? `Defaults to the current pay period, ${formatWorkDate(currentPayPeriod.from)} to ${formatWorkDate(currentPayPeriod.to)}${currentPayPeriod.status === null ? '' : ` (${statusLabel(currentPayPeriod.status)})`}.`
      : periods.failure !== null
        ? `The payroll calendar could not be read, so the range defaults to the last ${FALLBACK_RANGE_DAYS} days. The reason is stated above, with a control to try again.`
        : `No payroll period covers today, so the range defaults to the last ${FALLBACK_RANGE_DAYS} days.`;

  const context: ReviewViewContext | null =
    defaultRange === null
      ? null
      : {
          profile: initialProfile,
          payPeriods,
          currentPayPeriod,
          defaultRange,
          openExceptionQueue,
        };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-black tracking-tight text-slate-950">Review</h1>
          <p className="mt-0.5 text-xs font-semibold text-slate-500">{activeView.description}</p>
        </div>
      </div>

      {/* Criterion 1: the five views, in order. Criterion 2: Exceptions selected. */}
      <div
        role="tablist"
        aria-label="Review views"
        className="flex flex-wrap gap-1.5 rounded-[22px] border border-slate-200 bg-white px-2 py-2 shadow-sm"
      >
        {REVIEW_VIEWS.map((candidate) => {
          const active = candidate.id === view;
          return (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              id={`review-tab-${candidate.id}`}
              aria-selected={active}
              aria-controls={`review-panel-${candidate.id}`}
              onClick={() => setView(candidate.id)}
              className={[
                'rounded-xl border px-3 py-1.5 text-[12px] font-black transition',
                active
                  ? `${accent.surface} ${accent.border} ${accent.text}`
                  : 'border-transparent bg-white text-slate-600 hover:bg-slate-50',
              ].join(' ')}
            >
              {candidate.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`review-panel-${activeView.id}`}
        aria-labelledby={`review-tab-${activeView.id}`}
        className="space-y-4"
      >
        {/* The pay-period read's own states, with the retry control of Requirement
            22, criterion 16. A failure here does not stop the queue: the range
            falls back to a fortnight and the note under the control says so. */}
        <AsyncStateBlock
          status={periods.status}
          failure={periods.failure}
          pending={periods.pending}
          onRetry={periods.retry}
          subject="the payroll calendar"
        />

        {view === 'exceptions' &&
          (range === null || defaultRange === null ? (
            <AsyncStateBlock status="loading" subject="the exception queue" />
          ) : (
            <>
              {/* The drill-down, named, with the way back out. Without this a
                  reader arriving from a metric has no way to widen the query
                  again. */}
              {drillDown !== null && (
                <div
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-[22px] border px-4 py-3 ${accent.surface} ${accent.border}`}
                >
                  <p className={`text-[12px] font-semibold ${accent.text}`}>
                    Showing the records behind a selected figure, so this queue is narrower than
                    its own filters describe.
                  </p>
                  <button
                    type="button"
                    onClick={clearDrillDown}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50"
                  >
                    Clear drill-down
                  </button>
                </div>
              )}

              <ExceptionsWorkspace
                key={queueEpoch}
                profile={initialProfile}
                canAdminister={canAdminister}
                range={range}
                onRangeChange={setRangeOverride}
                defaultRange={defaultRange}
                defaultRangeLabel={
                  currentPayPeriod === null ? 'Default range' : 'Current pay period'
                }
                rangeNote={rangeNote}
                baseQuery={drillDown ?? undefined}
                initialSavedFilter={
                  drillDown === null ? DEFAULT_EXCEPTION_QUEUE_FILTERS.savedFilter : 'all_records'
                }
              />
            </>
          ))}

        {view === 'overview' &&
          (context !== null && renderOverview !== undefined ? (
            renderOverview(context)
          ) : (
            <PendingView view={REVIEW_VIEWS[1]} />
          ))}

        {view === 'trends' &&
          (context !== null && renderTrends !== undefined ? (
            renderTrends(context)
          ) : (
            <PendingView view={REVIEW_VIEWS[2]} />
          ))}

        {view === 'exports' &&
          (context !== null && renderExports !== undefined ? (
            renderExports(context)
          ) : (
            <PendingView view={REVIEW_VIEWS[3]} />
          ))}

        {view === 'audit' &&
          (context !== null && renderAudit !== undefined ? (
            renderAudit(context)
          ) : (
            <PendingView view={REVIEW_VIEWS[4]} />
          ))}
      </div>
    </div>
  );
}

export default ReviewCenter;

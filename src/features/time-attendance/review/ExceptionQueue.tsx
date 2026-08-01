// src/features/time-attendance/review/ExceptionQueue.tsx
// The work queue the Review screen opens on: one row per employee per work date,
// each row carrying one action.
//
// Requirement 12, criteria 3 through 9 and 17 through 20 describe this table. It
// renders what it is given and owns no read — `ReviewCenter` holds the
// `RecordQuery`, reads `/api/attendance/records` under it, and hands the answer
// down. That is the same division `TeamTodayTable` and `RequestInbox` already use,
// and it is what makes a saved filter mean something: narrowing a held array here
// would present one page of a hundred as the whole match, and would let the row
// count disagree with the count a metric was taken from a minute earlier.
//
// | column        | fields (criterion 5)                     | read from                        |
// | ------------- | ---------------------------------------- | -------------------------------- |
// | Employee      | employee name, department                | the read's own employee list     |
// | Work date     | work date                                | `workDate`                       |
// | Exception     | Attendance_Exception type                | `highestPriorityException`       |
// | Scheduled     | scheduled time span                      | `scheduledStart`, `scheduledEnd` |
// | Actual        | actual time span                         | `firstClockIn`, `lastClockOut`   |
// | Worked        | worked hours                             | `workedHours`                    |
// | Payroll       | payroll impact                           | `payrollBlocking`, `exceptions`  |
// | Review        | review status                            | `reviewedAt`                     |
// | Action        | one primary action                       | `primaryRowAction`               |
//
// Every figure is read off the `DailyAttendanceRecord` the Attendance_Service
// derived. The table computes no hours, assigns no status, and decides no action:
// the action is `primaryRowAction`, a lookup from the row's highest-priority
// exception code, which is why "at most one primary action per row" (criterion 6)
// is a property of the domain layer rather than a rule a reviewer has to check row
// by row.
//
// ## One row, however many exceptions
//
// Criterion 20 asks for one row per employee and work date even when that row
// carries several exceptions, and criterion 4 says the same thing from the other
// side. `deriveRange` already produces at most one record per pair, so the row
// count is settled before this component sees it. What is decided here is *which*
// exception the row names: the highest-priority one, with the rest reported as a
// count. The drawer lists all of them with the rule behind each (criterion 11), so
// nothing is hidden — it is summarised, and the row stays one line high.
//
// ## Payroll-blocking is a label and an icon, not a colour
//
// Criterion 9 asks for the payroll-blocking property in a text label or an icon
// *in addition to* colour. The cell renders a pill through `pillClassName` and
// `StatusIcon`, so the words "Payroll blocked" and the glyph travel with the rose
// surface and neither can be dropped. The blocking exceptions are named on the
// line beneath, because "blocked" without a reason is not actionable.
//
// ## Virtualisation, and why it is not the same thing as paging
//
// Criterion 17 caps a page at 100 rows and criterion 18 asks large result sets to
// be rendered with paging *or* virtualisation. Both are here, and they answer
// different questions. Paging is what the service applies: the read never returns
// more than 100 rows, so a 5,000-record match arrives 100 at a time. Virtualisation
// is what this component applies: above `VIRTUALISE_ABOVE_ROWS` rows it renders
// only the window a reader can see plus an overscan, with spacer rows standing in
// for the rest, so the node count stays bounded whatever it is handed.
//
// The two coexist rather than overlap. A caller that pages will never trip the
// window; a caller that hands the whole match over — an export preview, a test —
// will, and the table holds up. Implemented with a scroll offset and arithmetic, no
// dependency: `visibleRowWindow` is a pure function and is exported so the bound can
// be checked without a DOM.
//
// Rows are a fixed height for that arithmetic to be exact, which is why every cell
// is two short lines and truncates rather than wrapping.
//
// Requirements: 12.3, 12.4, 12.5, 12.6, 12.7, 12.9, 12.10, 12.17, 12.18, 12.19,
// 12.20, 22.5, 22.6, 22.7, 22.12, 22.14, 22.15, 22.16

'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

import type { Department } from '@/lib/permissions';

import { statusLabel, ui } from '../../nhwd-shared/ui';
import {
  DERIVED_STATUSES,
  EXCEPTION_CODES,
  SAVED_FILTERS,
  mergeRecordQuery,
  type RecordQuery,
  type ReviewStatusFilter,
  type SavedFilterId,
} from '../domain/attendance';
import {
  ROW_ACTION_LABELS,
  highestPriorityException,
  primaryRowAction,
  type RowAction,
} from '../domain/presentation';
import type {
  DailyAttendanceRecord,
  DateRange,
  DerivedStatus,
  ExceptionCode,
} from '../domain/types';
import type { AttendanceEmployee } from '../server/attendance-service';
import type { ApiFailure } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { formatHours, formatTimeOfDay, formatWorkDate } from '../shared/format';
import { StatusIcon } from '../shared/StatusIcon';
import { StatusPill } from '../shared/StatusPill';
import { PILL_ICON_SIZE, colorRoleToken, pillClassName, type ColorRole } from '../shared/tokens';
import type { ActiveFilter, AsyncResourceStatus } from '../shared/useAsyncResource';
import { DEPARTMENT_LABELS } from '../types';

// ─── Paging and virtualisation constants ─────────────────────────────────────

/**
 * Rows per page (Requirement 12, criterion 17).
 *
 * The same figure `RECORDS_PAGE_LIMIT` caps the service at, stated here rather
 * than imported: that constant lives in `server/attendance-service.ts`, and this
 * module takes only types from the server layer. The response reports the limit it
 * actually applied, and the footer displays that, so a disagreement would be
 * visible rather than silent.
 *
 * Requirements: 12.17, 20.8
 */
export const EXCEPTION_QUEUE_PAGE_LIMIT = 100;

/**
 * The fixed height of one row, in pixels.
 *
 * Fixed because the virtualisation window is arithmetic over this figure: a row
 * that grew with its content would put the spacer heights out and make the table
 * jump as a reader scrolled. Every cell is therefore two short lines and truncates.
 *
 * Requirements: 12.18
 */
export const EXCEPTION_ROW_HEIGHT_PX = 76;

/**
 * The row count above which the table renders a window rather than every row
 * (Requirement 12, criterion 18).
 *
 * Set to the page size, so a paged read never virtualises and a caller handing over
 * a whole match always does.
 */
export const VIRTUALISE_ABOVE_ROWS = 100;

/** The height of the scroll container while virtualising, in pixels. */
export const VIRTUAL_VIEWPORT_PX = 640;

/**
 * Rows rendered either side of the visible window.
 *
 * Enough that a fast scroll does not show blank space before the next render, few
 * enough that the node count stays a small multiple of what is on screen.
 */
export const VIRTUAL_OVERSCAN_ROWS = 6;

/**
 * The half-open row window to render for a scroll offset.
 *
 * Pure arithmetic, exported so the bound of Requirement 12, criterion 18 can be
 * checked without a DOM: for any row count and any offset, `end - start` is at most
 * the viewport's worth of rows plus twice the overscan.
 *
 * Requirements: 12.18
 */
export function visibleRowWindow(
  rowCount: number,
  scrollTop: number,
  viewportPx: number = VIRTUAL_VIEWPORT_PX,
  rowHeightPx: number = EXCEPTION_ROW_HEIGHT_PX,
  overscan: number = VIRTUAL_OVERSCAN_ROWS,
): { start: number; end: number } {
  if (rowCount <= 0) return { start: 0, end: 0 };

  const rowHeight = rowHeightPx > 0 ? rowHeightPx : 1;
  const offset = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  const height = Number.isFinite(viewportPx) && viewportPx > 0 ? viewportPx : rowHeight;

  const first = Math.min(rowCount - 1, Math.floor(offset / rowHeight));
  const onScreen = Math.ceil(height / rowHeight) + 1;

  const start = Math.max(0, first - overscan);
  const end = Math.min(rowCount, first + onScreen + overscan);

  return { start, end: end < start ? start : end };
}

// ─── Filters ─────────────────────────────────────────────────────────────────

/** The status values the free filter offers: the twelve the matrix can assign. */
export const EXCEPTION_QUEUE_STATUS_OPTIONS: readonly DerivedStatus[] = DERIVED_STATUSES;

/** The exception types the free filter offers: the codes the rules can produce. */
export const EXCEPTION_QUEUE_EXCEPTION_OPTIONS: readonly ExceptionCode[] = EXCEPTION_CODES;

/** The two review states a row can be in. */
export const REVIEW_STATUS_OPTIONS: readonly ReviewStatusFilter[] = ['unreviewed', 'reviewed'];

/**
 * The saved filter the queue opens on.
 *
 * Requirement 12's user story asks for a screen that opens on records that need
 * action, and `needs_attention` is that set: an exception, not yet reviewed. Every
 * other saved filter is one selection away, and `all_records` is the way back out.
 *
 * Requirements: 12.2, 12.3
 */
export const DEFAULT_SAVED_FILTER: SavedFilterId = 'needs_attention';

/**
 * The queue's filter state: one saved filter, plus the five free filters the
 * design gives `RecordQuery`.
 *
 * The saved filter is never null — `all_records` is the unfiltered member of the
 * set, so "no saved filter" has a name rather than being an absent field.
 *
 * Requirements: 12.3
 */
export interface ExceptionQueueFilters {
  savedFilter: SavedFilterId;
  department: Department | null;
  status: DerivedStatus | null;
  exception: ExceptionCode | null;
  reviewStatus: ReviewStatusFilter | null;
  payrollBlocking: boolean | null;
}

/** The state the queue opens in: needs attention, nothing else narrowed. */
export const DEFAULT_EXCEPTION_QUEUE_FILTERS: ExceptionQueueFilters = {
  savedFilter: DEFAULT_SAVED_FILTER,
  department: null,
  status: null,
  exception: null,
  reviewStatus: null,
  payrollBlocking: null,
};

/** True when a free filter is set, or the saved filter is not the default. */
export function hasExceptionQueueFilter(filters: ExceptionQueueFilters): boolean {
  return (
    filters.savedFilter !== DEFAULT_SAVED_FILTER ||
    filters.department !== null ||
    filters.status !== null ||
    filters.exception !== null ||
    filters.reviewStatus !== null ||
    filters.payrollBlocking !== null
  );
}

/** One saved filter's label, or the identifier itself if the table lost it. */
export function savedFilterLabel(id: SavedFilterId): string {
  return SAVED_FILTERS.find((predicate) => predicate.id === id)?.label ?? statusLabel(id);
}

/** One saved filter's description, for the line under the chip row. */
export function savedFilterDescription(id: SavedFilterId): string | null {
  return SAVED_FILTERS.find((predicate) => predicate.id === id)?.description ?? null;
}

/**
 * The `RecordQuery` the rows are read under.
 *
 * The date range, the saved filter, the free filters, and the page. `base` is the
 * drill-down seam: a query handed over by the Overview or the trends view is
 * conjoined through `mergeRecordQuery`, so the queue shows the intersection of what
 * it was asked for and what the reader has since narrowed, and never the union
 * (Requirement 13, criterion 5).
 *
 * Requirements: 12.3, 12.17, 12.19, 12.20, 13.5
 */
export function exceptionQueueQuery(
  filters: ExceptionQueueFilters,
  range: DateRange,
  page: number,
  base?: RecordQuery,
): RecordQuery {
  const own: RecordQuery = {
    from: range.from,
    to: range.to,
    savedFilter: filters.savedFilter,
    page,
    limit: EXCEPTION_QUEUE_PAGE_LIMIT,
  };

  if (filters.department !== null) own.departments = [filters.department];
  if (filters.status !== null) own.statuses = [filters.status];
  if (filters.exception !== null) own.exceptionCodes = [filters.exception];
  if (filters.reviewStatus !== null) own.reviewStatus = filters.reviewStatus;
  if (filters.payrollBlocking !== null) own.payrollBlocking = filters.payrollBlocking;

  // `own` is the base of the merge so the queue's own paging survives it.
  return base === undefined ? own : mergeRecordQuery(own, base);
}

/**
 * The active filters in the queue's own words, for the empty state and for the
 * line the queue displays above its rows.
 *
 * Every filter appears, set or not, because "All departments" tells a reader that
 * an empty result is not a department they forgot they had selected.
 *
 * Requirements: 12.3, 22.15
 */
export function exceptionQueueActiveFilters(
  filters: ExceptionQueueFilters,
  range: DateRange,
): ActiveFilter[] {
  return [
    { label: 'Dates', value: `${range.from} to ${range.to}` },
    { label: 'Saved filter', value: savedFilterLabel(filters.savedFilter) },
    {
      label: 'Department',
      value: filters.department === null ? 'All departments' : DEPARTMENT_LABELS[filters.department],
    },
    {
      label: 'Status',
      value: filters.status === null ? 'All statuses' : statusLabel(filters.status),
    },
    {
      label: 'Exception',
      value: filters.exception === null ? 'All exceptions' : statusLabel(filters.exception),
    },
    {
      label: 'Review status',
      value:
        filters.reviewStatus === null
          ? 'Reviewed and unreviewed'
          : statusLabel(filters.reviewStatus),
    },
    {
      label: 'Payroll',
      value:
        filters.payrollBlocking === null
          ? 'Blocking and not blocking'
          : filters.payrollBlocking
            ? 'Payroll blocking only'
            : 'Not payroll blocking',
    },
  ];
}

/** The row key the queue and the drawer agree on: one employee, one work date. */
export function exceptionRowKey(profileId: string, workDate: string): string {
  return `${profileId}\u0000${workDate}`;
}

// ─── Cell pieces ─────────────────────────────────────────────────────────────

/**
 * A pill for a property that is not one of the four status families.
 *
 * Payroll impact and review status are row properties rather than statuses, so
 * `statusToken` has no entry for them. They still carry a colour role, a label,
 * and an icon together, through the same `pillClassName` and `StatusIcon` the
 * status pill uses, so criterion 9 and Requirement 22, criterion 6 hold for them
 * as well.
 */
function TokenPill({ role, icon, label }: { role: ColorRole; icon: string; label: string }) {
  return (
    <span className={pillClassName(role)}>
      <StatusIcon name={icon} className={PILL_ICON_SIZE.sm} />
      {label}
    </span>
  );
}

/** A cell's two lines: a value and a subordinate note, both truncating. */
function Lines({ value, note }: { value: ReactNode; note?: string | null }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[12px] font-black text-slate-900">{value}</div>
      <div className="truncate text-[11px] font-semibold text-slate-400">
        {note === undefined || note === null || note === '' ? '\u00a0' : note}
      </div>
    </div>
  );
}

/** The actual clock span, with an open session said in words rather than left blank. */
function actualSpan(record: DailyAttendanceRecord, timeZone: string): string {
  if (record.firstClockIn === null) return 'No clock session';
  const out = record.hasOpenSession ? 'open' : formatTimeOfDay(record.lastClockOut, timeZone);
  return `${formatTimeOfDay(record.firstClockIn, timeZone)} \u2013 ${out}`;
}

/** The scheduled span, with an unscheduled date said in words. */
function scheduledSpan(record: DailyAttendanceRecord, timeZone: string): string {
  if (record.scheduledStart === null && record.scheduledEnd === null) return 'No shift';
  return `${formatTimeOfDay(record.scheduledStart, timeZone)} \u2013 ${formatTimeOfDay(record.scheduledEnd, timeZone)}`;
}

/** The exceptions that hold payroll, named, so "blocked" carries its reason. */
function blockingReason(record: DailyAttendanceRecord): string {
  const codes = record.exceptions
    .filter((exception) => exception.payrollBlocking)
    .map((exception) => statusLabel(exception.code));
  return codes.length === 0 ? 'Held for review' : codes.join(', ');
}

// ─── One row ─────────────────────────────────────────────────────────────────

interface RowProps {
  record: DailyAttendanceRecord;
  employee: AttendanceEmployee | undefined;
  /** 1-based index in the whole match, for `aria-rowindex` while virtualising. */
  ariaRowIndex: number | undefined;
  selected: boolean;
  onSelect: ((profileId: string, workDate: string, action: RowAction) => void) | undefined;
  opensDialog: boolean;
}

/**
 * One employee on one work date, with the ten fields of criterion 5.
 *
 * Requirements: 12.4, 12.5, 12.6, 12.7, 12.9, 12.10, 12.20
 */
function ExceptionRow({
  record,
  employee,
  ariaRowIndex,
  selected,
  onSelect,
  opensDialog,
}: RowProps) {
  // Instants are read in the employee's own zone, so a row for a colleague in
  // another country reads as that colleague's clock rather than the reader's.
  const timeZone = employee?.timezone ?? 'UTC';
  const name = employee?.displayName ?? 'Unknown employee';
  const dateLabel = formatWorkDate(record.workDate);

  // The one action, from the lookup. Total over every record, exception or not.
  const action = primaryRowAction(record);
  const top = highestPriorityException(record);
  const remaining = record.exceptions.length - (top === null ? 0 : 1);

  const accent = colorRoleToken('accent');

  const open = onSelect === undefined ? undefined : () => onSelect(record.profileId, record.workDate, action);

  return (
    <tr
      aria-rowindex={ariaRowIndex}
      aria-current={selected ? true : undefined}
      style={{ height: EXCEPTION_ROW_HEIGHT_PX }}
      onClick={open}
      className={[
        'border-b border-slate-100',
        selected ? accent.surface : 'bg-white',
        open === undefined ? '' : 'cursor-pointer transition hover:bg-[#f8faff]',
      ]
        .filter((part) => part !== '')
        .join(' ')}
    >
      {/* Employee name and department. The name is the row's keyboard-reachable
          way in, so the row is not a mouse-only control. */}
      <td className="px-3 py-2 align-middle">
        {open === undefined ? (
          <Lines
            value={name}
            note={employee === undefined ? 'No department' : statusLabel(employee.department ?? 'unassigned')}
          />
        ) : (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              open();
            }}
            aria-label={`Open the attendance record for ${name} on ${dateLabel}`}
            {...(opensDialog ? { 'aria-haspopup': 'dialog' as const } : {})}
            className="block w-full min-w-0 text-left"
          >
            <Lines
              value={<span className="underline decoration-slate-300 underline-offset-2">{name}</span>}
              note={
                employee === undefined
                  ? 'No department'
                  : statusLabel(employee.department ?? 'unassigned')
              }
            />
          </button>
        )}
      </td>

      {/* Work date. */}
      <td className="px-3 py-2 align-middle">
        <Lines value={dateLabel} note={record.workDate} />
      </td>

      {/* The exception type. One row however many it carries (criterion 20): the
          highest-priority code names the row and the rest are counted. */}
      <td className="px-3 py-2 align-middle">
        <div className="min-w-0">
          {top === null ? (
            <StatusPill status={record.derivedStatus} />
          ) : (
            <TokenPill
              role={top.payrollBlocking ? 'critical' : 'pending'}
              icon={top.payrollBlocking ? 'OctagonAlert' : 'TriangleAlert'}
              label={statusLabel(top.code)}
            />
          )}
          <div className="mt-0.5 truncate text-[11px] font-semibold text-slate-400">
            {top === null
              ? 'No exception on this date'
              : remaining > 0
                ? `+${remaining} more \u00b7 ${top.ruleDescription}`
                : top.ruleDescription}
          </div>
        </div>
      </td>

      {/* Scheduled time span. */}
      <td className="px-3 py-2 align-middle">
        <Lines
          value={scheduledSpan(record, timeZone)}
          note={`${formatHours(record.scheduledHours)} scheduled`}
        />
      </td>

      {/* Actual time span. */}
      <td className="px-3 py-2 align-middle">
        <Lines
          value={actualSpan(record, timeZone)}
          note={record.hasOpenSession ? 'Session still open' : null}
        />
      </td>

      {/* Worked hours. */}
      <td className="px-3 py-2 text-right align-middle">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-black text-slate-900">
            {formatHours(record.workedHours)}
          </div>
          <div className="truncate text-[11px] font-semibold text-slate-400">
            of {formatHours(record.scheduledHours)}
          </div>
        </div>
      </td>

      {/* Payroll impact, as a label and an icon as well as a colour (criterion 9). */}
      <td className="px-3 py-2 align-middle">
        <div className="min-w-0">
          {record.payrollBlocking ? (
            <TokenPill role="critical" icon="OctagonAlert" label="Payroll blocked" />
          ) : (
            <TokenPill role="healthy" icon="ShieldCheck" label="Payable" />
          )}
          <div className="mt-0.5 truncate text-[11px] font-semibold text-slate-400">
            {record.payrollBlocking ? blockingReason(record) : 'No exception holds payroll'}
          </div>
        </div>
      </td>

      {/* Review status. */}
      <td className="px-3 py-2 align-middle">
        <div className="min-w-0">
          {record.reviewedAt === null ? (
            <TokenPill role="pending" icon="Hourglass" label="Not reviewed" />
          ) : (
            <TokenPill role="healthy" icon="CircleCheck" label="Reviewed" />
          )}
          <div className="mt-0.5 truncate text-[11px] font-semibold text-slate-400">
            {record.reviewedAt === null
              ? 'Awaiting review'
              : formatTimeOfDay(record.reviewedAt, timeZone)}
          </div>
        </div>
      </td>

      {/* The one action styled as primary (criteria 6 and 7). */}
      <td className="px-3 py-2 align-middle">
        {open === undefined ? (
          <span className="text-[11px] font-bold text-slate-400">
            {ROW_ACTION_LABELS[action]}
          </span>
        ) : (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              open();
            }}
            aria-label={`${ROW_ACTION_LABELS[action]} for ${name} on ${dateLabel}`}
            {...(opensDialog ? { 'aria-haspopup': 'dialog' as const } : {})}
            className="inline-flex w-full items-center justify-center rounded-xl bg-[#223f7a] px-2.5 py-1.5 text-[11px] font-black text-white transition hover:bg-[#17305f]"
          >
            {ROW_ACTION_LABELS[action]}
          </button>
        )}
      </td>
    </tr>
  );
}

// ─── Filter controls ─────────────────────────────────────────────────────────

/** One select filter: a caption above a select whose empty value clears it. */
function FilterSelect<T extends string>({
  label,
  value,
  options,
  optionLabel,
  onChange,
  allLabel,
}: {
  label: string;
  value: T | null;
  options: readonly T[];
  optionLabel: (option: T) => string;
  onChange: (next: T | null) => void;
  allLabel: string;
}) {
  return (
    <label className="block min-w-[9.5rem] flex-1">
      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
        {label}
      </span>
      <select
        value={value ?? ''}
        onChange={(event) =>
          onChange(event.target.value === '' ? null : (event.target.value as T))
        }
        className={`${ui.select} mt-1 py-1.5 text-[13px]`}
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One end of the date-range control (criterion 19). */
function FilterDate({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block min-w-[9rem] flex-1">
      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
        {label}
      </span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${ui.input} mt-1 py-1.5 text-[13px]`}
      />
    </label>
  );
}

// ─── The queue ───────────────────────────────────────────────────────────────

export interface ExceptionQueueProps {
  /** The rows the active query returned, in the order the service listed them. */
  rows: readonly DailyAttendanceRecord[];
  /** The employees the read described, for each row's name and department. */
  employees: readonly AttendanceEmployee[];
  /** Rows the query matched before paging. */
  total: number;
  /** 1-based, as applied by the service. */
  page: number;
  /** Rows per page, as applied. Never above `EXCEPTION_QUEUE_PAGE_LIMIT`. */
  limit: number;
  /** True when the match ran past the page the service returned. */
  hasMore: boolean;
  /** The active date range (criterion 19). */
  range: DateRange;
  onRangeChange: (next: DateRange) => void;
  /**
   * The range the control defaults to, so it can be returned to (criterion 19).
   * Null when the caller has none to offer.
   */
  defaultRange: DateRange | null;
  /** What the reset control is called: `Current pay period`, or the fallback. */
  defaultRangeLabel: string;
  /** One sentence saying where the default range came from. */
  rangeNote: string;
  filters: ExceptionQueueFilters;
  onFiltersChange: (next: ExceptionQueueFilters) => void;
  onPageChange: (page: number) => void;
  /** The row whose drawer is open, as `exceptionRowKey`, so it reads as selected. */
  selectedRowKey: string | null;
  /**
   * Criterion 10. Rows are selectable only when this is supplied, so a queue with
   * no drawer does not advertise an interaction that goes nowhere. The action is
   * the row's own primary action, so the drawer opens on the control that action
   * names.
   */
  onSelectRow?: (profileId: string, workDate: string, action: RowAction) => void;
  /** True when selecting a row opens a dialog rather than revealing a pane. */
  selectionOpensDialog?: boolean;
  /** The read's state, so the queue carries its own loading and failed states. */
  status: AsyncResourceStatus;
  failure: ApiFailure | null;
  /** The empty-state sentence, naming the active filters. */
  emptyMessage: string;
  pending: boolean;
  onRetry: () => void;
}

/**
 * The Exception_Queue: the saved filters, the date range, the rows, and the paging.
 *
 * Requirements: 12.3, 12.4, 12.5, 12.6, 12.7, 12.9, 12.10, 12.17, 12.18, 12.19,
 * 12.20
 */
export function ExceptionQueue({
  rows,
  employees,
  total,
  page,
  limit,
  hasMore,
  range,
  onRangeChange,
  defaultRange,
  defaultRangeLabel,
  rangeNote,
  filters,
  onFiltersChange,
  onPageChange,
  selectedRowKey,
  onSelectRow,
  selectionOpensDialog = false,
  status,
  failure,
  emptyMessage,
  pending,
  onRetry,
}: ExceptionQueueProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const byProfileId = useMemo(
    () => new Map(employees.map((employee) => [employee.profileId, employee])),
    [employees],
  );

  // Only the departments the read described: a control offering a department with
  // nobody in it invites a filter that can only come back empty.
  const departments = useMemo(
    () =>
      [
        ...new Set(
          employees
            .map((employee) => employee.department)
            .filter((department): department is Department => department !== null),
        ),
      ].sort(),
    [employees],
  );

  const virtualised = rows.length > VIRTUALISE_ABOVE_ROWS;
  const rowWindow = virtualised
    ? visibleRowWindow(rows.length, scrollTop)
    : { start: 0, end: rows.length };

  const visible = rows.slice(rowWindow.start, rowWindow.end);
  const leadingPx = rowWindow.start * EXCEPTION_ROW_HEIGHT_PX;
  const trailingPx = (rows.length - rowWindow.end) * EXCEPTION_ROW_HEIGHT_PX;

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (node !== null) setScrollTop(node.scrollTop);
  }, []);

  /** Both ends move together, so the range can never be inverted. */
  const setFrom = useCallback(
    (from: string) => {
      if (from === '') return;
      onRangeChange({ from, to: from > range.to ? from : range.to });
    },
    [onRangeChange, range.to],
  );

  const setTo = useCallback(
    (to: string) => {
      if (to === '') return;
      onRangeChange({ from: to < range.from ? to : range.from, to });
    },
    [onRangeChange, range.from],
  );

  const accent = colorRoleToken('accent');
  const description = savedFilterDescription(filters.savedFilter);

  const firstRow = (page - 1) * limit + 1;
  const lastRow = (page - 1) * limit + rows.length;

  const atDefaultRange =
    defaultRange !== null && defaultRange.from === range.from && defaultRange.to === range.to;

  return (
    <section
      aria-labelledby="exception-queue-heading"
      className="rounded-[22px] border border-slate-200 bg-white shadow-sm"
    >
      <div className="space-y-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="exception-queue-heading"
            className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
          >
            Exception queue
          </h2>
          <p className="text-[11px] font-semibold text-slate-400">
            {rows.length === 0
              ? `${total} ${total === 1 ? 'record' : 'records'}`
              : `${firstRow}\u2013${lastRow} of ${total}`}
            {virtualised ? ' \u00b7 windowed list' : ''}
          </p>
        </div>

        {/* Criterion 3: the thirteen saved filters, in the order the criterion
            states them. Selecting one changes the query the rows are read under. */}
        <div>
          <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
            Saved filters
          </span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {SAVED_FILTERS.map((predicate) => {
              const id = predicate.id as SavedFilterId;
              const active = filters.savedFilter === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    onFiltersChange({ ...filters, savedFilter: id });
                    onPageChange(1);
                  }}
                  className={[
                    'rounded-full border px-2.5 py-1 text-[11px] font-black transition',
                    active
                      ? `${accent.surface} ${accent.border} ${accent.text}`
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                  ].join(' ')}
                >
                  {predicate.label}
                </button>
              );
            })}
          </div>
          {description !== null && (
            <p className="mt-1.5 text-[11px] font-semibold text-slate-500">{description}</p>
          )}
        </div>

        {/* Criterion 19: the date-range control, defaulted to the current pay
            period by the caller and returnable to it here. */}
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <FilterDate label="From" value={range.from} onChange={setFrom} />
          <FilterDate label="To" value={range.to} onChange={setTo} />
          {defaultRange !== null && (
            <button
              type="button"
              disabled={atDefaultRange}
              onClick={() => onRangeChange(defaultRange)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {defaultRangeLabel}
            </button>
          )}
        </div>

        <p className="text-[11px] font-semibold text-slate-400">{rangeNote}</p>

        {/* The five free filters the design gives `RecordQuery` beside the saved
            ones. Each sets the query; none narrows the rows already held. */}
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <FilterSelect
            label="Department"
            value={filters.department}
            options={departments}
            optionLabel={(department) => DEPARTMENT_LABELS[department]}
            allLabel="All departments"
            onChange={(department) => {
              onFiltersChange({ ...filters, department });
              onPageChange(1);
            }}
          />
          <FilterSelect
            label="Status"
            value={filters.status}
            options={EXCEPTION_QUEUE_STATUS_OPTIONS}
            optionLabel={statusLabel}
            allLabel="All statuses"
            onChange={(next) => {
              onFiltersChange({ ...filters, status: next });
              onPageChange(1);
            }}
          />
          <FilterSelect
            label="Exception"
            value={filters.exception}
            options={EXCEPTION_QUEUE_EXCEPTION_OPTIONS}
            optionLabel={statusLabel}
            allLabel="All exceptions"
            onChange={(exception) => {
              onFiltersChange({ ...filters, exception });
              onPageChange(1);
            }}
          />
          <FilterSelect
            label="Review status"
            value={filters.reviewStatus}
            options={REVIEW_STATUS_OPTIONS}
            optionLabel={statusLabel}
            allLabel="Reviewed and unreviewed"
            onChange={(reviewStatus) => {
              onFiltersChange({ ...filters, reviewStatus });
              onPageChange(1);
            }}
          />
          <FilterSelect
            label="Payroll"
            value={filters.payrollBlocking === null ? null : filters.payrollBlocking ? 'blocking' : 'clear'}
            options={['blocking', 'clear'] as const}
            optionLabel={(option) =>
              option === 'blocking' ? 'Payroll blocking only' : 'Not payroll blocking'
            }
            allLabel="Blocking and not blocking"
            onChange={(option) => {
              onFiltersChange({
                ...filters,
                payrollBlocking: option === null ? null : option === 'blocking',
              });
              onPageChange(1);
            }}
          />
          {hasExceptionQueueFilter(filters) && (
            <button
              type="button"
              onClick={() => {
                onFiltersChange(DEFAULT_EXCEPTION_QUEUE_FILTERS);
                onPageChange(1);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {(status !== 'ready' || failure !== null) && (
        <div className="px-4 pt-3 sm:px-5">
          <AsyncStateBlock
            status={status}
            failure={failure}
            pending={pending}
            onRetry={onRetry}
            subject="attendance records"
            message={emptyMessage}
          />
        </div>
      )}

      {rows.length > 0 && (
        <div
          ref={scrollRef}
          onScroll={virtualised ? onScroll : undefined}
          className="overflow-x-auto"
          style={virtualised ? { maxHeight: VIRTUAL_VIEWPORT_PX, overflowY: 'auto' } : undefined}
        >
          <table
            className="w-full min-w-[70rem] table-fixed text-left text-sm"
            aria-rowcount={virtualised ? rows.length + 1 : undefined}
          >
            <colgroup>
              <col style={{ width: '16%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '17%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '10%' }} />
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr aria-rowindex={virtualised ? 1 : undefined}>
                <th className={ui.th}>Employee</th>
                <th className={ui.th}>Work date</th>
                <th className={ui.th}>Exception</th>
                <th className={ui.th}>Scheduled</th>
                <th className={ui.th}>Actual</th>
                <th className={`${ui.th} text-right`}>Worked</th>
                <th className={ui.th}>Payroll</th>
                <th className={ui.th}>Review</th>
                <th className={ui.th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {/* The rows above the window, as height rather than as nodes. */}
              {leadingPx > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={9} style={{ height: leadingPx, padding: 0, border: 0 }} />
                </tr>
              )}

              {visible.map((record, index) => (
                <ExceptionRow
                  key={exceptionRowKey(record.profileId, record.workDate)}
                  record={record}
                  employee={byProfileId.get(record.profileId)}
                  // Header is row 1, so the first body row is row 2.
                  ariaRowIndex={virtualised ? rowWindow.start + index + 2 : undefined}
                  selected={
                    selectedRowKey === exceptionRowKey(record.profileId, record.workDate)
                  }
                  onSelect={onSelectRow}
                  opensDialog={selectionOpensDialog}
                />
              ))}

              {trailingPx > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={9} style={{ height: trailingPx, padding: 0, border: 0 }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Criterion 17: pages of at most a hundred. A page beyond the last yields no
          rows rather than the last page, so the control cannot claim to be
          somewhere it is not. */}
      {(page > 1 || hasMore) && (
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1 || pending}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-[11px] font-semibold text-slate-400">
            Page {page} {'\u00b7'} {limit} per page
          </span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={!hasMore || pending}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

export default ExceptionQueue;

// src/features/time-attendance/timeoff/RequestInbox.tsx
// The queue of time-off requests: one compact row each, six filters above them,
// fifty to a page.
//
// Requirement 7, criterion 4 asks for one row per request and criterion 5 names
// eleven things that row carries. Every one of them is a field on the `RequestRow`
// the PTO_Service returned, and the twelfth is the request's own identifier, which
// the row is keyed by and the decision drawer is opened from:
//
// | shown                        | read from                | criterion |
// | ---------------------------- | ------------------------ | --------- |
// | employee name                | `employeeName`           | 5         |
// | department                   | `department`             | 5         |
// | request type                 | `ptoType`                | 5         |
// | requested start date         | `startDate`              | 5         |
// | requested end date           | `endDate`                | 5         |
// | working days requested       | `workingDays`            | 5         |
// | current status               | `status`                 | 5         |
// | remaining balance for type   | `remainingBalance`       | 5         |
// | coverage risk indicator      | `coverageRisk`           | 5, 9      |
// | submission date              | `submittedAt`            | 5         |
// | elapsed time awaiting review | `awaitingReviewMinutes`  | 5         |
// | request reference            | `requestId`              | 10        |
//
// This component derives none of them. The working-day count is
// `countWorkingDays`, the remaining balance is `remainingBalanceFor`, the coverage
// risk is `coverageRiskForRequest` over the Coverage_Service's own projection, and
// the elapsed figure is measured from the evaluation instant the read carried —
// all inside `domain/pto.ts`, on the server, before the row left it. So the risk
// indicator on a row and the Coverage_Calendar cell beside it cannot disagree
// (criterion 9), and the day count the employee was shown at submission is the day
// count a decision will debit.
//
// ## The filters ask the server; they do not sieve the rows
//
// Criterion 12 caps a page at fifty rows and criterion 8 orders pending before
// decided. Both happen inside `buildRequestInbox`, over the whole match, on the
// server. A filter applied here instead would filter one page of fifty and present
// the result as the whole match — and the coverage-risk filter would be filtering
// on a figure only the Coverage_Service can produce. So each control calls
// `onFiltersChange`, the screen serialises the query through
// `shared/request-query.ts`, and the rows are the server's answer to it.
//
// The option lists come from the rule tables for the same reason: the four status
// values are `REQUEST_STATUS_FILTERS` (criterion 7), the request types are the ones
// the `pto_requests.pto_type` constraint accepts as the response reported them
// (Requirement 10, criterion 20), the coverage risks are the keys of
// `COVERAGE_SEVERITY`, and the employees and departments are the ones the read
// actually described. A control cannot offer a value the route would refuse or the
// window contains none of.
//
// ## Scope is the server's, and the heading says whose queue this is
//
// Criterion 11 gives a non-administrator only their own requests, and
// `visibleProfileIds` enforces it inside `listRequests` — this component holds no
// rule about it. What it does hold is the wording: an administrator's heading says
// the team's requests and an employee's says their own, so a short list reads as
// the whole of what the reader may see rather than as a filter they forgot.
//
// ## A row is a control
//
// Selecting a row opens the Request_Decision_Drawer and highlights the requested
// dates in the calendar (criterion 10). Each row is therefore a real `button`: the
// drawer has something to return focus to when it closes, and the row is reachable
// by keyboard without this component reinventing what a button already does. Rows
// are selectable only when `onSelectRequest` is supplied, so a screen with no
// drawer and no calendar to react does not advertise an interaction that goes
// nowhere.
//
// Requirements: 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 22.5, 22.6, 22.7,
// 22.9, 22.12, 22.14, 22.15, 22.16

'use client';

import type { Department } from '@/lib/permissions';

import { statusLabel, ui } from '../../nhwd-shared/ui';
import { COVERAGE_SEVERITY, type CoverageStatus } from '../domain/coverage';
import { REQUEST_PAGE_LIMIT, REQUEST_STATUS_FILTERS, type RequestQuery } from '../domain/pto';
import type { AttendanceEmployee } from '../server/attendance-service';
import type { RequestRow } from '../server/pto-service';
import type { ApiFailure } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { CoverageBadge } from '../shared/CoverageBadge';
import {
  formatDays,
  formatElapsedMinutes,
  formatInstantDate,
  formatWorkDate,
} from '../shared/format';
import { StatusPill } from '../shared/StatusPill';
import { colorRoleToken } from '../shared/tokens';
import type { ActiveFilter, AsyncResourceStatus } from '../shared/useAsyncResource';
import { DEPARTMENT_LABELS, PTO_TYPE_LABELS, REQUESTABLE_PTO_TYPES, type PTOStatus, type PTOType } from '../types';

/**
 * The four status values the control offers, in the order Requirement 7,
 * criterion 7 names them.
 *
 * The query accepts all seven stored statuses, so a drill-down from elsewhere can
 * ask for `waitlisted` or `information_requested`; the criterion sets a floor on
 * what the control offers rather than a ceiling on what the query can express.
 *
 * Requirements: 7.7
 */
export const REQUEST_STATUS_OPTIONS: readonly PTOStatus[] = REQUEST_STATUS_FILTERS;

/**
 * The coverage-risk values the control offers, worst first.
 *
 * Ordered by `COVERAGE_SEVERITY` rather than by an ordering of this file's own, so
 * the control's idea of "worse" is the coverage module's idea of it. Worst first
 * because the reason to filter by risk is to find the requests that cannot be
 * approved as they stand.
 *
 * Requirements: 7.6
 */
export const COVERAGE_RISK_OPTIONS: readonly CoverageStatus[] = (
  Object.keys(COVERAGE_SEVERITY) as CoverageStatus[]
).sort((a, b) => COVERAGE_SEVERITY[b] - COVERAGE_SEVERITY[a]);

/** Every accepted request type, for a screen with no response to read them from. */
export const REQUEST_TYPE_OPTIONS: readonly PTOType[] = [...REQUESTABLE_PTO_TYPES];

/**
 * The six filters of Requirement 7, criterion 6. An unset filter is null.
 *
 * One value per control rather than a set, because that is what the six controls
 * are: a select each, and two date fields. `RequestQuery` takes lists, so
 * `requestInboxQuery` wraps each value in a one-element list — which is also why a
 * cleared control produces an absent key rather than an empty list, the one shape
 * a query string cannot express.
 *
 * Requirements: 7.6, 7.7
 */
export interface RequestInboxFilters {
  status: PTOStatus | null;
  department: Department | null;
  profileId: string | null;
  ptoType: PTOType | null;
  /** `YYYY-MM-DD`. Requests whose dates overlap from this date onwards. */
  from: string | null;
  /** `YYYY-MM-DD`. Requests whose dates overlap up to this date. */
  to: string | null;
  coverageRisk: CoverageStatus | null;
}

/** No filter set. The state the inbox opens in. */
export const NO_REQUEST_INBOX_FILTERS: RequestInboxFilters = {
  status: null,
  department: null,
  profileId: null,
  ptoType: null,
  from: null,
  to: null,
  coverageRisk: null,
};

/** True when at least one of the six filters is set. */
export function hasRequestInboxFilter(filters: RequestInboxFilters): boolean {
  return (
    filters.status !== null ||
    filters.department !== null ||
    filters.profileId !== null ||
    filters.ptoType !== null ||
    filters.from !== null ||
    filters.to !== null ||
    filters.coverageRisk !== null
  );
}

/**
 * The `RequestQuery` a filter state and a page number describe.
 *
 * `limit` is stated rather than left to the service's default, so the page size
 * the screen displays is the page size it asked for. The domain caps it at
 * `REQUEST_PAGE_LIMIT` regardless (Requirement 7, criterion 12), which is where a
 * caller asking for more is refused.
 *
 * Requirements: 7.6, 7.7, 7.12
 */
export function requestInboxQuery(filters: RequestInboxFilters, page: number): RequestQuery {
  const query: RequestQuery = { page, limit: REQUEST_PAGE_LIMIT };

  if (filters.status !== null) query.statuses = [filters.status];
  if (filters.department !== null) query.departments = [filters.department];
  if (filters.profileId !== null) query.profileIds = [filters.profileId];
  if (filters.ptoType !== null) query.ptoTypes = [filters.ptoType];
  if (filters.from !== null) query.from = filters.from;
  if (filters.to !== null) query.to = filters.to;
  if (filters.coverageRisk !== null) query.coverageRisks = [filters.coverageRisk];

  return query;
}

/**
 * The active filters in the inbox's own words, for the empty state of
 * Requirement 22, criterion 15.
 *
 * An unset control is named too — "All statuses" — because that is what tells a
 * reader an empty result is not a filter they had forgotten was set.
 *
 * Requirements: 22.15
 */
export function requestInboxActiveFilters(
  filters: RequestInboxFilters,
  employees: readonly AttendanceEmployee[],
): ActiveFilter[] {
  const employee =
    filters.profileId === null
      ? null
      : (employees.find((entry) => entry.profileId === filters.profileId) ?? null);

  return [
    { label: 'Status', value: filters.status === null ? 'All statuses' : statusLabel(filters.status) },
    {
      label: 'Department',
      value:
        filters.department === null ? 'All departments' : DEPARTMENT_LABELS[filters.department],
    },
    {
      label: 'Employee',
      value:
        filters.profileId === null
          ? 'Everyone in view'
          : (employee?.displayName ?? 'Employee outside this window'),
    },
    {
      label: 'Type',
      value: filters.ptoType === null ? 'All types' : PTO_TYPE_LABELS[filters.ptoType],
    },
    {
      label: 'Dates',
      value:
        filters.from === null && filters.to === null
          ? 'The whole window'
          : `${filters.from === null ? 'any' : filters.from} to ${filters.to === null ? 'any' : filters.to}`,
    },
    {
      label: 'Coverage risk',
      value:
        filters.coverageRisk === null ? 'Any risk' : statusLabel(filters.coverageRisk),
    },
  ];
}

/**
 * A request's reference, as a reader would quote it.
 *
 * The stored identifier is a uuid, which is the twelfth field of criterion 5 and
 * is unreadable in full inside a compact row. The leading segment is enough to
 * pair a row with a support message or an audit entry, and it is shown rather than
 * hidden because a queue people talk to each other about needs something to call
 * each item.
 */
function requestReference(requestId: string): string {
  const separator = requestId.indexOf('-');
  return (separator > 0 ? requestId.slice(0, separator) : requestId.slice(0, 8)).toUpperCase();
}

/** One labelled figure inside a row: a small caption over the value. */
function Figure({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-[5rem]">
      <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className={`text-[13px] font-bold ${muted ? 'text-slate-400' : 'text-slate-800'}`}>
        {value}
      </dd>
    </div>
  );
}

/** What stands in for a coverage risk no projection could produce. */
const RISK_UNKNOWN = 'Coverage risk unknown';

/**
 * One request, as a compact row.
 *
 * Requirements: 7.4, 7.5, 7.9, 7.10
 */
function RequestRowItem({
  row,
  employee,
  selected,
  onSelect,
  opensDialog,
}: {
  row: RequestRow;
  employee: AttendanceEmployee | undefined;
  selected: boolean;
  onSelect: ((requestId: string) => void) | undefined;
  opensDialog: boolean;
}) {
  // The submission instant is read in the requester's own zone, so a row for a
  // colleague in another country reads as the day they submitted it.
  const timeZone = employee?.timezone ?? 'UTC';
  const accent = colorRoleToken('accent');
  const selectable = onSelect !== undefined;

  const content = (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <span className="block truncate text-[13px] font-black text-slate-900">
            {row.employeeName ?? 'Unknown employee'}
          </span>
          <span className="block text-[11px] font-semibold text-slate-400">
            {row.department === null ? 'No department' : DEPARTMENT_LABELS[row.department]}
            {' \u00b7 '}
            {PTO_TYPE_LABELS[row.ptoType]}
          </span>
        </div>
        <StatusPill status={row.status} />
      </div>

      <p className="mt-1.5 text-[13px] font-bold text-slate-700">
        {formatWorkDate(row.startDate)} {'\u2013'} {formatWorkDate(row.endDate)}
        <span className="ml-1.5 font-semibold text-slate-500">
          ({formatDays(row.workingDays)} requested)
        </span>
      </p>

      <div className="mt-1.5">
        {row.coverageRisk === null ? (
          <span className="text-[11px] font-bold text-slate-400">{RISK_UNKNOWN}</span>
        ) : (
          <CoverageBadge status={row.coverageRisk} />
        )}
        {/* The stored short-notice condition (Requirement 11, criterion 5), which
            an administrator triaging the queue needs on the row rather than only in
            the drawer. Its colour is the Warning role read from the token table,
            not a palette chosen here. */}
        {row.shortNotice && (
          <span className={`ml-1.5 text-[11px] font-bold ${colorRoleToken('warning').text}`}>
            Short notice
          </span>
        )}
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
        <Figure
          label="Balance left"
          value={formatDays(row.remainingBalance)}
          muted={row.remainingBalance === null}
        />
        <Figure label="Submitted" value={formatInstantDate(row.submittedAt, timeZone)} />
        <Figure
          label={row.pending ? 'Awaiting review' : 'Waited'}
          value={formatElapsedMinutes(row.awaitingReviewMinutes)}
        />
        <Figure label="Reference" value={requestReference(row.requestId)} muted />
      </dl>
    </>
  );

  const shell = [
    'w-full rounded-2xl border px-3.5 py-3 text-left transition',
    selected
      ? `${accent.surface} ${accent.border} ring-2 ${accent.ring}`
      : 'border-slate-200 bg-white',
    selectable ? 'hover:bg-slate-50' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');

  return (
    <li>
      {selectable ? (
        <button
          type="button"
          onClick={() => onSelect(row.requestId)}
          // `aria-current` rather than `aria-expanded`: the row is one item in a
          // list and selecting it marks it as the one being read, which is what
          // the accent ring says visually. `aria-haspopup` is stated only where
          // the selection genuinely opens a dialog — below 768 pixels the decision
          // pane is a drawer, and at 768 and above it is a pane on the page, so a
          // fixed `haspopup` would be wrong at one width or the other.
          aria-current={selected ? true : undefined}
          {...(opensDialog ? { 'aria-haspopup': 'dialog' as const } : {})}
          className={shell}
        >
          {content}
        </button>
      ) : (
        <div className={shell}>{content}</div>
      )}
    </li>
  );
}

/** One select filter: a caption above a select whose empty value clears it. */
function FilterSelect<T extends string>({
  label,
  value,
  options,
  optionLabel,
  onChange,
  allLabel,
  disabled = false,
}: {
  label: string;
  value: T | null;
  options: readonly T[];
  optionLabel: (option: T) => string;
  onChange: (next: T | null) => void;
  allLabel: string;
  disabled?: boolean;
}) {
  return (
    <label className="block min-w-[9rem] flex-1">
      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
        {label}
      </span>
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === '' ? null : (event.target.value as T))}
        className={`${ui.select} mt-1 py-1.5 text-[13px] disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400`}
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

/** One end of the date-range filter. */
function FilterDate({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <label className="block min-w-[9rem] flex-1">
      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
        {label}
      </span>
      <input
        type="date"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        className={`${ui.input} mt-1 py-1.5 text-[13px]`}
      />
    </label>
  );
}

export interface RequestInboxProps {
  /** The page the active query returned, in the order the service listed it. */
  rows: readonly RequestRow[];
  /** The employees the read described, for the filter options and row zones. */
  employees: readonly AttendanceEmployee[];
  /** The request types the database constraint accepts, as the response reported. */
  requestTypes: readonly PTOType[];
  /** Rows the query matched before paging. */
  total: number;
  /** 1-based, as applied by the service. */
  page: number;
  /** Rows per page, as applied. Never above `REQUEST_PAGE_LIMIT`. */
  limit: number;
  /** True when the match ran past the page the service returned. */
  hasMore: boolean;
  filters: RequestInboxFilters;
  onFiltersChange: (next: RequestInboxFilters) => void;
  onPageChange: (page: number) => void;
  /** The request whose decision drawer is open, so its row reads as selected. */
  selectedRequestId: string | null;
  /**
   * Criterion 10. Rows are selectable only when this is supplied, so a screen
   * with nothing to open does not advertise an interaction that goes nowhere.
   */
  onSelectRequest?: (requestId: string) => void;
  /**
   * True when selecting a row opens a dialog rather than revealing a pane on the
   * page — which below 768 pixels it does (criterion 3). Announced to assistive
   * technology, so it is stated by the screen that decides the arrangement rather
   * than guessed at here.
   */
  selectionOpensDialog?: boolean;
  /** The read's state, so the pane carries its own loading and failed states. */
  status: AsyncResourceStatus;
  failure: ApiFailure | null;
  /** The empty-state sentence, naming the active filters. */
  emptyMessage: string;
  pending: boolean;
  onRetry: () => void;
  /**
   * Whether the signed-in user administers attendance. Wording only: scope is
   * enforced by `visibleProfileIds` on the server (criterion 11).
   */
  canAdminister: boolean;
  /**
   * False when no date in the window could be projected, in which case every
   * row's coverage risk is unknown and filtering by it would match nothing.
   */
  coverageAvailable: boolean;
}

/**
 * The Request_Inbox: the requests in view, the six filters, and the paging.
 *
 * Requirements: 7.4, 7.5, 7.6, 7.7, 7.8, 7.10, 7.11, 7.12
 */
export function RequestInbox({
  rows,
  employees,
  requestTypes,
  total,
  page,
  limit,
  hasMore,
  filters,
  onFiltersChange,
  onPageChange,
  selectedRequestId,
  onSelectRequest,
  selectionOpensDialog = false,
  status,
  failure,
  emptyMessage,
  pending,
  onRetry,
  canAdminister,
  coverageAvailable,
}: RequestInboxProps) {
  const byProfileId = new Map(employees.map((employee) => [employee.profileId, employee]));

  // Only the departments the read described: a control offering a department with
  // nobody in it invites a filter that can only come back empty.
  const departments = [
    ...new Set(
      employees
        .map((employee) => employee.department)
        .filter((department): department is Department => department !== null),
    ),
  ].sort();

  const profileIds = employees.map((employee) => employee.profileId);
  const firstRow = (page - 1) * limit + 1;
  const lastRow = (page - 1) * limit + rows.length;

  return (
    <section
      aria-labelledby="request-inbox-heading"
      className="flex min-h-0 flex-col rounded-[22px] border border-slate-200 bg-white shadow-sm"
    >
      <div className="space-y-3 border-b border-slate-100 px-4 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="request-inbox-heading"
            className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
          >
            {canAdminister ? 'Request inbox' : 'My requests'}
          </h2>
          <p className="text-[11px] font-semibold text-slate-400">
            {rows.length === 0
              ? `${total} ${total === 1 ? 'request' : 'requests'}`
              : `${firstRow}\u2013${lastRow} of ${total}`}
          </p>
        </div>

        {/* Criterion 11 as wording: whose queue this is, so a short list reads as
            the whole of what the reader may see. Criterion 8 as wording too — the
            order is the service's, and stating it saves a reader wondering. */}
        <p className="text-[12px] font-semibold text-slate-500">
          {canAdminister
            ? 'Every request from the employees you administer, pending first and longest waiting at the top.'
            : 'Your own requests in every state, pending first and longest waiting at the top.'}
        </p>

        {/* Criterion 6: the six filters. Each one sets the query the rows are read
            under; none of them narrows the rows already held. */}
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <FilterSelect
            label="Status"
            value={filters.status}
            options={REQUEST_STATUS_OPTIONS}
            optionLabel={statusLabel}
            allLabel="All statuses"
            onChange={(next) => onFiltersChange({ ...filters, status: next })}
          />
          <FilterSelect
            label="Department"
            value={filters.department}
            options={departments}
            optionLabel={(department) => DEPARTMENT_LABELS[department]}
            allLabel="All departments"
            onChange={(department) => onFiltersChange({ ...filters, department })}
          />
          <FilterSelect
            label="Employee"
            value={filters.profileId}
            options={profileIds}
            optionLabel={(profileId) =>
              byProfileId.get(profileId)?.displayName ?? 'Unknown employee'
            }
            allLabel="Everyone in view"
            onChange={(profileId) => onFiltersChange({ ...filters, profileId })}
          />
          <FilterSelect
            label="Type"
            value={filters.ptoType}
            options={requestTypes}
            optionLabel={(ptoType) => PTO_TYPE_LABELS[ptoType]}
            allLabel="All types"
            onChange={(ptoType) => onFiltersChange({ ...filters, ptoType })}
          />
          <FilterDate
            label="From"
            value={filters.from}
            onChange={(from) => onFiltersChange({ ...filters, from })}
          />
          <FilterDate
            label="To"
            value={filters.to}
            onChange={(to) => onFiltersChange({ ...filters, to })}
          />
          <FilterSelect
            label="Coverage risk"
            value={filters.coverageRisk}
            options={COVERAGE_RISK_OPTIONS}
            optionLabel={statusLabel}
            allLabel="Any risk"
            disabled={!coverageAvailable}
            onChange={(coverageRisk) => onFiltersChange({ ...filters, coverageRisk })}
          />
          {hasRequestInboxFilter(filters) && (
            <button
              type="button"
              onClick={() => onFiltersChange(NO_REQUEST_INBOX_FILTERS)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* A disabled control with no stated reason reads as a fault. Criterion 9
            derives the indicator from the Coverage_Service's projection, and where
            no date could be projected there is no value to filter on. */}
        {!coverageAvailable && (
          <p className="text-[11px] font-semibold text-slate-400">
            No coverage projection is available for these dates, so every request reports its
            coverage risk as unknown and that filter is unavailable.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
        <AsyncStateBlock
          status={status}
          failure={failure}
          pending={pending}
          onRetry={onRetry}
          subject="time-off requests"
          message={emptyMessage}
        />

        {/* Criterion 4: one compact row per request, in the order the service
            listed them — pending before decided, longest waiting first. */}
        {rows.length > 0 && (
          <ul className="space-y-2">
            {rows.map((row) => (
              <RequestRowItem
                key={row.requestId}
                row={row}
                employee={byProfileId.get(row.profileId)}
                selected={row.requestId === selectedRequestId}
                onSelect={onSelectRequest}
                opensDialog={selectionOpensDialog}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Criterion 12: pages of at most fifty. A page beyond the last yields no
          rows rather than the last page, so the control cannot claim to be
          somewhere it is not. */}
      {(page > 1 || hasMore) && (
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3">
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

export default RequestInbox;

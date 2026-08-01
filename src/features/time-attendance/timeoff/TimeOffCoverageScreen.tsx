// src/features/time-attendance/timeoff/TimeOffCoverageScreen.tsx
// The third Time & Attendance navigation item: requests and coverage on one
// screen, so a decision is made where its staffing effect is visible.
//
// Requirement 7 is a layout requirement before it is anything else. The
// Request_Inbox, the Coverage_Calendar, and the Request_Decision_Drawer are three
// panes at 1280 pixels and above (criterion 1), the same three stacked in that
// order below it (criterion 2), and below 768 pixels the decision pane becomes a
// full-width overlay (criterion 3). Merging the two legacy screens is the point:
// `PTORequests.tsx` listed requests with no idea what approving one would do to a
// Friday, and `StaffingCoverage.tsx` showed a coverage figure on a screen with no
// request on it.
//
// ## How the three arrangements are produced
//
// Two of the three are CSS. The panes are rendered in document order — inbox,
// calendar, decision — so the stacked arrangement of criterion 2 is what the
// markup already is, and criterion 1 is a `xl:` grid variant at Tailwind's 1280
// pixel breakpoint. Nothing measures the window for either.
//
// The third is not. Criterion 3 asks for an overlay, and an overlay in this module
// means `SideDrawer` — the one drawer implementation, with the focus trap, the
// focus restore, and the Escape handler of Requirement 22, criteria 10 and 11. A
// stylesheet cannot move a subtree into a focus trap, so the choice between "third
// pane" and "drawer" is made in the component, through `useMediaQuery`. That is the
// module's only viewport test, and this is the only rule that needs one.
//
// The decision pane exists only while a request is selected, so the grid is two
// columns until then and three after. That is not a compromise: there is no
// decision to present until someone picks a request.
//
// ## Filtering asks the server
//
// The inbox is a paged, ordered, filtered read (`buildRequestInbox`, fifty rows,
// pending before decided). This component holds the filter state and the page
// number, serialises both through `shared/request-query.ts`, and renders the
// answer. It never narrows the rows it is holding — a page of fifty filtered in the
// browser would be presented as the whole match, and the coverage-risk indicator it
// filtered on is a figure only the Coverage_Service can produce.
//
// Changing a filter returns to page one. A filter and a page number that moved
// together would otherwise leave a reader on page three of a two-page result,
// looking at an empty list they had no way to interpret.
//
// ## Selecting a request
//
// Criterion 10 asks a selected row to open the decision drawer *and* highlight the
// requested dates in the calendar. Both come from one piece of state: the selected
// request identifier, resolved against the held page to a row, which the decision
// pane receives and whose range the calendar pane receives. A request that leaves
// the page — because a filter changed under it — resolves to no row, and the pane
// closes rather than describing a request the reader can no longer see.
//
// ## The seams for 19.2, 19.3, and 19.4
//
// The Coverage_Calendar (task 19.2), the decision drawer (19.3), and the employee
// composer (19.4) are not built yet. Each has a slot here, taking the context it
// needs and nothing more, and each slot is optional in the way this module's other
// seams are optional: absent means the affordance does not exist. With no decision
// pane and no calendar, rows are not selectable, because selecting one would open
// nothing.
//
// Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12,
// 22.3, 22.8, 22.14, 22.15, 22.16

'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { canAdministerAttendance, type Department } from '@/lib/permissions';

import type { ProfileLite } from '../../nhwd-shared/types';
import { REQUEST_PAGE_LIMIT } from '../domain/pto';
import type { DateRange } from '../domain/types';
import type { AttendanceEmployee } from '../server/attendance-service';
import type { RequestPage, RequestRow } from '../server/pto-service';
import { attendanceJson } from '../shared/api-failure';
import { formatWorkDate } from '../shared/format';
import { requestQueryUrl } from '../shared/request-query';
import { SideDrawer } from '../shared/SideDrawer';
import { emptyStateMessage, useAsyncResource } from '../shared/useAsyncResource';
import { OVERLAY_VIEWPORT_QUERY, useMediaQuery } from '../shared/useMediaQuery';
import { PTO_TYPE_LABELS, type PTOType } from '../types';
import {
  NO_REQUEST_INBOX_FILTERS,
  REQUEST_TYPE_OPTIONS,
  RequestInbox,
  requestInboxActiveFilters,
  requestInboxQuery,
  type RequestInboxFilters,
} from './RequestInbox';

/**
 * What `/api/pto` answers a GET with.
 *
 * `RequestPage` plus the one field the route adds on top of the service's page:
 * the request types the `pto_requests.pto_type` check constraint accepts, so the
 * type selector cannot offer a value the database refuses (Requirement 10,
 * criterion 20). Declared here because it is the shape of the *route's* response
 * rather than of the service's return, and this screen is the only caller.
 */
export interface RequestInboxResponse extends RequestPage {
  requestTypes: PTOType[];
}

/** Stable empty collections, so a memo does not see a new array every render. */
const NO_ROWS: readonly RequestRow[] = [];
const NO_EMPLOYEES: readonly AttendanceEmployee[] = [];

/**
 * The grid at 1280 pixels and above, by how many panes are present.
 *
 * Written out as three complete class strings rather than composed at runtime,
 * because Tailwind reads the source to decide which classes to emit and a string
 * assembled from parts is a class it never sees. Below `xl` every one of these is
 * inert and the panes stack in document order, which is criterion 2.
 *
 * The inbox is given a fixed comfortable reading width, the calendar takes what is
 * left, and the decision pane is wide enough for the impact preview's per-date
 * table without crowding the calendar out.
 *
 * Requirements: 7.1, 7.2
 */
const PANE_GRID: Readonly<Record<1 | 2 | 3, string>> = {
  1: '',
  2: 'xl:grid xl:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)] xl:items-start xl:gap-4 xl:space-y-0',
  3: 'xl:grid xl:grid-cols-[minmax(19rem,22rem)_minmax(0,1fr)_minmax(21rem,26rem)] xl:items-start xl:gap-4 xl:space-y-0',
};

/** What the Coverage_Calendar pane is given. Task 19.2's seam. */
export interface CoveragePaneContext {
  /**
   * The selected request's requested dates, for criterion 10's highlight, or null
   * when no request is selected.
   */
  highlightedRange: DateRange | null;
  /** The window the inbox read over, so the calendar can open on the same dates. */
  window: DateRange | null;
  /** The department the inbox is filtered to, or null for the whole organisation. */
  department: Department | null;
}

/** What the Request_Decision_Drawer is given. Task 19.3's seam. */
export interface DecisionPaneContext {
  /** The selected request, as the inbox read returned it. */
  request: RequestRow;
  /**
   * Called with the request as it now stands once a decision is committed. The
   * row is replaced from the response and the read is refreshed, because a
   * decision can move a request out of the active filter as well as change it.
   */
  onCommitted: (request: RequestRow) => void;
  /** Close the pane. */
  onClose: () => void;
}

/** What the employee's request composer is given. Task 19.4's seam. */
export interface ComposerPaneContext {
  /** The signed-in employee. */
  profileId: string;
  /** The request types the database constraint accepts (Requirement 10.20). */
  requestTypes: readonly PTOType[];
  /** The rows the read returned that belong to the signed-in employee. */
  ownRequests: readonly RequestRow[];
  /** Called with the affected row after a submission or a cancellation. */
  onCommitted: (request: RequestRow) => void;
}

export interface TimeOffCoverageScreenProps {
  initialProfile: ProfileLite;
  /**
   * Task 19.2's seam: the Coverage_Calendar, the centre pane.
   *
   * Must return a single element. It is a direct child of the pane grid, so a
   * fragment with several children would be several columns.
   */
  renderCoverage?: (context: CoveragePaneContext) => ReactNode;
  /**
   * Task 19.3's seam: the decision options, the impact preview, and the guard.
   *
   * Returns the pane's *content*. The heading, the close control, and — below 768
   * pixels — the overlay and its focus trap are this screen's, because which of
   * the two the content sits in is a layout decision (criteria 1 to 3) and the
   * drawer is `SideDrawer` either way.
   */
  renderDecision?: (context: DecisionPaneContext) => ReactNode;
  /**
   * Task 19.4's seam: the employee's own submission and cancellation controls.
   *
   * Rendered above the inbox in the left pane, for an administrator as much as for
   * an employee: an administrator has leave of their own to request, and
   * Requirement 11 belongs to whoever is signed in.
   */
  renderComposer?: (context: ComposerPaneContext) => ReactNode;
}

/**
 * A page of rows with one row replaced by its committed self.
 *
 * Matched on the request identifier. A request the page does not hold is left out
 * rather than appended: the page answers a query, and a request that has just
 * started matching one is the refresh's business, not this replacement's.
 */
function withRequest(
  rows: readonly RequestRow[],
  next: RequestRow,
): RequestRow[] {
  return rows.map((row) => (row.requestId === next.requestId ? next : row));
}

/**
 * Time Off & Coverage.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.10, 7.11
 */
export function TimeOffCoverageScreen({
  initialProfile,
  renderCoverage,
  renderDecision,
  renderComposer,
}: TimeOffCoverageScreenProps) {
  const canAdminister = canAdministerAttendance(initialProfile.role);

  const [filters, setFilters] = useState<RequestInboxFilters>(NO_REQUEST_INBOX_FILTERS);
  const [page, setPage] = useState(1);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  const query = useMemo(() => requestInboxQuery(filters, page), [filters, page]);
  const read = useMemo(() => requestQueryUrl('/api/pto', query), [query]);

  const inbox = useAsyncResource(
    (signal) => attendanceJson<RequestInboxResponse>(read.url, { signal }),
    {
      deps: [read.url],
      enabled: !read.unsatisfiable,
      subject: 'time-off requests',
      isEmpty: (response) => response.rows.length === 0,
    },
  );

  const data = inbox.data;
  const rows = data?.rows ?? NO_ROWS;
  const employees = data?.employees ?? NO_EMPLOYEES;
  const requestTypes = data?.requestTypes ?? REQUEST_TYPE_OPTIONS;
  const windowRange = data?.range ?? null;

  // The empty-state sentence is assembled here rather than through the hook's own
  // `filters` option, because one of the six filters is an employee and only the
  // response knows that employee's name. Passing it into the hook would mean
  // reading the response before the read that produces it.
  const activeFilters = useMemo(
    () => requestInboxActiveFilters(filters, employees),
    [filters, employees],
  );
  const emptyMessage = emptyStateMessage('time-off requests', activeFilters);

  // Resolved against the held page rather than kept as its own copy of the row, so
  // the pane always describes the request as the last read returned it. A request
  // that has left the page resolves to nothing and the pane closes with it.
  const selectedRequest = rows.find((row) => row.requestId === selectedRequestId) ?? null;

  const setData = inbox.setData;
  const refresh = inbox.refresh;

  const onCommitted = useCallback(
    (committed: RequestRow) => {
      // The write endpoints answer with the affected row rebuilt from stored data,
      // so the row in front of the reader moves without a request.
      if (data !== null) setData({ ...data, rows: withRequest(data.rows, committed) });
      // The refresh catches what a row replacement cannot express: a decision can
      // move a request out of the active filter, and it changes the coverage
      // projection every other row's risk indicator was read from.
      refresh();
    },
    [data, refresh, setData],
  );

  const onFiltersChange = useCallback((next: RequestInboxFilters) => {
    setFilters(next);
    setPage(1);
  }, []);

  const ownRequests = useMemo(
    () => rows.filter((row) => row.profileId === initialProfile.id),
    [rows, initialProfile.id],
  );

  // Below 768 pixels the decision pane is an overlay rather than a pane; at 768 and
  // above it is the third block, stacked or in the third column (criteria 1 to 3).
  const overlay = useMediaQuery(OVERLAY_VIEWPORT_QUERY);
  const decisionOpen = selectedRequest !== null && renderDecision !== undefined;
  const inlineDecision = decisionOpen && !overlay;

  const paneCount = (1 + (renderCoverage === undefined ? 0 : 1) + (inlineDecision ? 1 : 0)) as
    | 1
    | 2
    | 3;

  // Criterion 10 needs a row to open something. With no decision pane and no
  // calendar, selecting one would change nothing a reader could see.
  const selectable = renderDecision !== undefined || renderCoverage !== undefined;

  const decisionContext: DecisionPaneContext | null =
    selectedRequest === null
      ? null
      : {
          request: selectedRequest,
          onCommitted,
          onClose: () => setSelectedRequestId(null),
        };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-black tracking-tight text-slate-950">Time Off &amp; Coverage</h1>
          <p className="mt-0.5 text-xs font-semibold text-slate-500">
            {windowRange === null
              ? 'Requests and projected staffing'
              : `Requests and projected staffing, ${formatWorkDate(windowRange.from)} to ${formatWorkDate(windowRange.to)}`}
          </p>
        </div>
      </div>

      <div className={`space-y-4 ${PANE_GRID[paneCount]}`}>
        {/* Left: the employee's own composer above the queue it appears in, then
            the Request_Inbox itself. */}
        <div className="space-y-4">
          {renderComposer?.({
            profileId: initialProfile.id,
            requestTypes,
            ownRequests,
            onCommitted,
          })}

          <RequestInbox
            rows={read.unsatisfiable ? NO_ROWS : rows}
            employees={employees}
            requestTypes={requestTypes}
            total={read.unsatisfiable ? 0 : (data?.total ?? rows.length)}
            page={data?.page ?? page}
            limit={data?.limit ?? REQUEST_PAGE_LIMIT}
            hasMore={read.unsatisfiable ? false : (data?.hasMore ?? false)}
            filters={filters}
            onFiltersChange={onFiltersChange}
            onPageChange={setPage}
            selectedRequestId={selectedRequestId}
            onSelectRequest={selectable ? setSelectedRequestId : undefined}
            selectionOpensDialog={overlay && renderDecision !== undefined}
            status={read.unsatisfiable ? 'empty' : inbox.status}
            failure={read.unsatisfiable ? null : inbox.failure}
            emptyMessage={emptyMessage}
            pending={inbox.pending}
            onRetry={inbox.retry}
            canAdminister={canAdminister}
            coverageAvailable={data?.coverageAvailable ?? false}
          />
        </div>

        {/* Centre: the Coverage_Calendar, with the selected request's dates to
            highlight. Task 19.2. */}
        {renderCoverage?.({
          highlightedRange:
            selectedRequest === null
              ? null
              : { from: selectedRequest.startDate, to: selectedRequest.endDate },
          window: windowRange,
          department: filters.department,
        })}

        {/* Right: the decision pane, inline at 768 pixels and above. Task 19.3. */}
        {inlineDecision && decisionContext !== null && (
          <aside
            aria-labelledby="request-decision-heading"
            className="rounded-[22px] border border-slate-200 bg-white shadow-sm"
          >
            <div className="border-b border-slate-100 px-4 py-4">
              <h2
                id="request-decision-heading"
                className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
              >
                {decisionContext.request.employeeName ?? 'Time-off request'}
              </h2>
              <p className="mt-0.5 text-[12px] font-semibold text-slate-500">
                {requestSubtitle(decisionContext.request)}
              </p>
            </div>
            <div className="px-4 py-4">{renderDecision?.(decisionContext)}</div>
          </aside>
        )}
      </div>

      {/* Below 768 pixels the same content is a full-width overlay, through the
          module's one drawer — so its focus behaviour is the drawer's rather than
          this screen's (criterion 3, and Requirement 22, criteria 10 and 11). */}
      <SideDrawer
        open={decisionOpen && overlay}
        onClose={() => setSelectedRequestId(null)}
        title={decisionContext?.request.employeeName ?? 'Time-off request'}
        subtitle={decisionContext === null ? undefined : requestSubtitle(decisionContext.request)}
      >
        {decisionContext !== null && renderDecision?.(decisionContext)}
      </SideDrawer>
    </div>
  );
}

/** The request in one line: what was asked for, and for which dates. */
function requestSubtitle(row: RequestRow): string {
  return `${PTO_TYPE_LABELS[row.ptoType]} \u00b7 ${formatWorkDate(row.startDate)} \u2013 ${formatWorkDate(row.endDate)}`;
}

export default TimeOffCoverageScreen;

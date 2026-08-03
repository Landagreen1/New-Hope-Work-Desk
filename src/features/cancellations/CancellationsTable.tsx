'use client';

// Cancellations list surface: one compact row per Cancellation_Case, thirteen cells in the order
// Requirement 16.1 fixes. The twin of `renewals/RenewalsTable.tsx`, same structure and same
// styling tokens.
//
// Purely presentational. Every value arrives already derived: a row carries the thirteen cells
// `cancellationRowCells` produced in `derive.ts`, which is where the em dash of an absent
// cancellation reason or amount due, the `Unassigned` of a case with no assigned employee, the
// days remaining count, and the four derived cells of Requirement 16.9 are decided. Nothing here
// reads a clock, a date, a contact row, or a Communication_Record, so the SMS status, email
// status, last contact, and next required action cells are the ones the drawer reads from the
// same functions — which is what makes the list cell and the drawer's prominent control name one
// action (Requirements 16.9, 16.10).
//
// The column order is not restated here either: the header row and every body row are generated
// from `CANCELLATION_ROW_CELL_ORDER`, so this file supplies header text and per-cell presentation
// and `derive.ts` remains the single place the Requirement 16.1 order is written down.
//
// Paging and selection stay with the parent (task 16.12). It hands in the page it loaded, its
// zero-based index, and the case whose drawer is open; this component renders at most one page of
// `CANCELLATION_PAGE_SIZE` rows (Requirement 16.5), replaces the whole list surface with a
// loading indicator while the FIRST page is in flight (Requirement 1.5), and raises `onRowClick`
// with the case id when a row is chosen (Requirement 16.6).

import { LoaderCircle } from 'lucide-react';

import { ui } from '../nhwd-shared/ui';
// Display formatting only, the same implementation the renewal surfaces use. It changes how a
// stored date reads, never which value the cell holds: an em dash handed in comes back unchanged.
import { calendarText } from '../renewals/format';
import {
  CANCELLATION_PAGE_SIZE,
  CANCELLATION_ROW_CELL_ORDER,
  cancellationRowCellValues,
  cancellationRowCells,
  EM_DASH,
  UNASSIGNED,
  type CancellationRowCells,
  type CancellationRowState,
  type CaseStatus,
  type CommunicationStatus,
} from './derive';

/**
 * Dense row styling, identical to the renewals list surface: the shared `ui.th` / `ui.td` borders,
 * type scale, and slate palette with tighter vertical padding and single-line cells, because this
 * is a triage work surface rather than a card list.
 */
const HEAD_CELL =
  'border-b border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] font-black uppercase tracking-wider whitespace-nowrap text-slate-400';
const CELL = 'border-b border-slate-100 px-3 py-2 align-middle whitespace-nowrap text-slate-700';
const NUMERIC_CELL = `${CELL} text-right tabular-nums`;

/** One of the thirteen cell keys of Requirement 16.1, as `derive.ts` fixes their order. */
type CancellationCellKey = (typeof CANCELLATION_ROW_CELL_ORDER)[number];

/** Header text per cell, in Requirement 16.1's own words. The ORDER comes from `derive.ts`. */
const CELL_LABELS: Record<CancellationCellKey, string> = {
  customerName: 'Customer name',
  policyNumber: 'Policy number',
  carrier: 'Carrier',
  cancellationEffectiveDate: 'Cancellation effective date',
  daysRemaining: 'Days remaining',
  cancellationReason: 'Cancellation reason',
  amountDue: 'Amount due',
  assignedEmployee: 'Assigned employee',
  smsStatus: 'SMS status',
  emailStatus: 'Email status',
  lastContact: 'Last contact',
  caseStatus: 'Case status',
  nextRequiredAction: 'Next required action',
};

/** Per-cell styling. The two numeric cells are right aligned so their digits compare by eye. */
const CELL_CLASS: Record<CancellationCellKey, string> = {
  customerName: `${CELL} font-black text-slate-900`,
  policyNumber: `${CELL} font-semibold`,
  carrier: CELL,
  cancellationEffectiveDate: CELL,
  daysRemaining: `${NUMERIC_CELL} font-bold`,
  cancellationReason: `${CELL} max-w-[18rem] truncate`,
  amountDue: NUMERIC_CELL,
  assignedEmployee: CELL,
  smsStatus: CELL,
  emailStatus: CELL,
  lastContact: CELL,
  caseStatus: CELL,
  nextRequiredAction: `${CELL} font-semibold text-slate-900`,
};

/** The cells whose header is right aligned over right-aligned digits. */
const NUMERIC_CELLS: ReadonlySet<CancellationCellKey> = new Set<CancellationCellKey>([
  'daysRemaining',
  'amountDue',
]);

/**
 * Badge tone per Case_Status. Colour is a redundant cue only: the badge carries the stored value
 * as its text, exactly as Requirement 16.1 names it, so nothing is expressed by colour alone.
 */
const CASE_STATUS_TONE = {
  Imported: 'neutral',
  Open: 'info',
  'Payment Reported': 'progress',
  'Verification Pending': 'progress',
  'Reinstatement Pending': 'violet',
  Reinstated: 'success',
  Cancelled: 'danger',
  Resolved: 'success',
  Invalid: 'neutral',
  Duplicate: 'neutral',
} as const satisfies Record<CaseStatus, string>;

/** Badge tone per Communication_Status, for the SMS status and email status cells. */
const COMMUNICATION_STATUS_TONE = {
  'Not Scheduled': 'neutral',
  Scheduled: 'info',
  'Partially Sent': 'progress',
  Sent: 'cyan',
  Delivered: 'success',
  'Partially Failed': 'danger',
  Failed: 'danger',
  Suppressed: 'violet',
  'Manual Follow-up Required': 'danger',
} as const satisfies Record<CommunicationStatus, string>;

/** A tone for a cell value, falling back to the neutral tone for anything unrecognized. */
function toneOf(tones: Record<string, string>, value: string): string {
  return ui.badgeTone[tones[value] ?? 'neutral'] ?? ui.badgeTone.neutral;
}

/** An absent value and an unassigned case read quieter than a value that is there. */
function absentTone(value: string): string {
  return value === EM_DASH || value === UNASSIGNED ? 'text-slate-400' : '';
}

/** One row of the cancellation list: the case id and its thirteen derived cells. */
export interface CancellationsTableRow {
  /** `cancellation_cases.id`, the value handed back through `onRowClick`. */
  id: string;
  /** The thirteen cells of Requirement 16.1, from `cancellationRowCells` in `derive.ts`. */
  cells: CancellationRowCells;
}

export interface CancellationsTableProps {
  /**
   * The page of rows to display, already filtered, searched, and sorted upstream. At most
   * `CANCELLATION_PAGE_SIZE` of them are rendered (Requirement 16.5).
   */
  rows: readonly CancellationsTableRow[];
  /**
   * Zero-based index of the page `rows` holds. Only page 0 is the first page, so only page 0
   * replaces the list surface with the loading indicator of Requirement 1.5.
   */
  page?: number;
  /**
   * The one Cancellation_Case whose detail drawer is open, or `null`. A single value rather than
   * a set, so at most one drawer can be open at a time (Requirement 16.6).
   */
  selectedCaseId: string | null;
  /** Raised with the case id when a row is chosen, which opens that case's drawer (Req 16.6). */
  onRowClick: (caseId: string) => void;
  /** True while the query for the current page is in flight (Requirement 1.5). */
  loading?: boolean;
}

/**
 * One table row from a state bundle: the case id and the thirteen cells `cancellationRowCells`
 * derives from it. The page container (task 16.12) maps its loaded page through this, so the
 * cells reach the table already derived and this component derives nothing.
 */
export function cancellationsTableRow(state: CancellationRowState): CancellationsTableRow {
  return { id: state.case.id ?? '', cells: cancellationRowCells(state) };
}

export default function CancellationsTable({
  rows,
  page = 0,
  selectedCaseId,
  onRowClick,
  loading = false,
}: CancellationsTableProps) {
  // Requirement 1.5: while the first page of at most 50 cases loads, the indicator stands in
  // place of the list surface rather than beside it, so no partial or stale row set is on screen
  // while the query is in flight. A later page keeps the rows already on screen and says it is
  // fetching below the table instead.
  if (loading && page === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-6 py-12 text-sm font-bold text-slate-500"
      >
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading cancellations…
      </div>
    );
  }

  // Requirement 16.5: one page is at most 50 rows. The parent decides WHICH page; this is the
  // guarantee that the surface never shows more than one page of it.
  const pageRows = rows.length > CANCELLATION_PAGE_SIZE ? rows.slice(0, CANCELLATION_PAGE_SIZE) : rows;

  return (
    <div className="overflow-x-auto">
      <table className={ui.table}>
        <caption className="sr-only">
          {`Cancellations, page ${page + 1}. Thirteen columns per case. Select the customer name in a row to open that cancellation.`}
        </caption>
        <thead>
          <tr>
            {CANCELLATION_ROW_CELL_ORDER.map((key) => (
              <th
                key={key}
                scope="col"
                className={`${HEAD_CELL} ${NUMERIC_CELLS.has(key) ? 'text-right' : ''}`}
              >
                {CELL_LABELS[key]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* An empty result set renders zero rows on purpose: the parent owns the empty state so
              it can name the active saved filter and the search text (Req 1.6, 1.9). */}
          {pageRows.map((row) => {
            const selected = row.id === selectedCaseId;
            // The thirteen values in the Requirement 16.1 order, read straight from the derived
            // cells — position by position the same order the header row was built from.
            const values = cancellationRowCellValues(row.cells);
            return (
              <tr
                key={row.id}
                aria-selected={selected}
                // Row click is a convenience target only. The keyboard path is the real button in
                // the first cell below, so opening a drawer is never mouse-only (Req 16.6).
                onClick={() => onRowClick(row.id)}
                className={`${ui.trHover} ${selected ? 'bg-[#eef3fb]' : ''}`}
              >
                {CANCELLATION_ROW_CELL_ORDER.map((key, index) => {
                  const value = values[index];
                  const className = `${CELL_CLASS[key]} ${absentTone(value)}`;

                  if (key === 'customerName') {
                    return (
                      <td key={key} className={className}>
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={(event) => {
                            event.stopPropagation();
                            onRowClick(row.id);
                          }}
                          className="inline-flex items-center gap-1.5 rounded text-left font-black text-slate-900 underline-offset-2 transition hover:underline focus-visible:ring-2 focus-visible:ring-[#7890bc] focus-visible:outline-none"
                        >
                          {/* Symbol cue so selection is not carried by the row tint alone. */}
                          <span aria-hidden="true" className={selected ? 'text-[#223f7a]' : 'text-transparent'}>
                            &#10003;
                          </span>
                          {value}
                        </button>
                      </td>
                    );
                  }

                  return (
                    <td
                      key={key}
                      className={className}
                      title={key === 'cancellationReason' && value !== EM_DASH ? value : undefined}
                    >
                      {renderCell(key, value)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* A page after the first keeps its rows on screen while the next one loads. */}
      {loading && page > 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 px-3 py-3 text-sm font-bold text-slate-500"
        >
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading more cancellations…
        </div>
      ) : null}
    </div>
  );
}

/**
 * How one cell reads. The three status cells become badges carrying their stored value as text,
 * the two temporal cells are formatted for reading, and every other cell is the derived text as
 * `derive.ts` handed it over.
 */
function renderCell(key: CancellationCellKey, value: string) {
  switch (key) {
    case 'cancellationEffectiveDate':
      return calendarText(value);
    case 'lastContact':
      // The most recent contact event, which is a send time or a response time, so the time of
      // day is part of the answer (Req 16.9).
      return calendarText(value, true);
    case 'smsStatus':
    case 'emailStatus':
      return (
        <span className={`${ui.badge} ${toneOf(COMMUNICATION_STATUS_TONE, value)}`}>{value}</span>
      );
    case 'caseStatus':
      return <span className={`${ui.badge} ${toneOf(CASE_STATUS_TONE, value)}`}>{value}</span>;
    default:
      return value;
  }
}

'use client';

// Renewals list surface: one compact row per renewal, fourteen cells in the order
// Requirement 4.1 fixes.
//
// Purely presentational (Requirement 7.2). Every value arrives already derived from
// `derive.ts` upstream, so this file performs no date arithmetic, no premium arithmetic,
// no filtering, no sorting, and no data access. It formats what it is handed, applies the
// absent-value markers of Requirements 4.3, 4.4, and 4.9, and raises `onSelect` when a row
// is chosen. Paging stays with the parent: this component renders exactly the rows handed
// in, and while the first page of at most 50 records loads it renders a loading indicator in
// place of the whole list surface (Req 1.5).

import { LoaderCircle } from 'lucide-react';

import { renewalStatusTone, statusLabel, ui } from '../nhwd-shared/ui';
import type { RenewalStatus } from './api';
import type { RenewalNextAction, RenewalPremiumChange } from './derive';
// Every absent-value marker of Requirements 4.3, 4.4, and 4.9 comes from one place: an em dash
// for an absent cell, `Unassigned` for an absent assigned employee, and the Requirement 4.8 sign
// characters on a premium movement.
import {
  EM_DASH, assignedText, calendarText, money, signedMoney, text, wholeNumber,
} from './format';

/**
 * Dense row styling. These mirror the shared `ui.th` / `ui.td` tokens — same borders, same
 * type scale, same slate palette — with tighter vertical padding and single-line cells,
 * because this surface is a triage work surface rather than a card list.
 */
const HEAD_CELL =
  'border-b border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] font-black uppercase tracking-wider whitespace-nowrap text-slate-400';
const CELL = 'border-b border-slate-100 px-3 py-2 align-middle whitespace-nowrap text-slate-700';
const NUMERIC_CELL = `${CELL} text-right tabular-nums`;

/** The fourteen columns in the Requirement 4.1 order. */
const COLUMNS: readonly { label: string; numeric?: boolean }[] = [
  { label: 'Customer name' },
  { label: 'Policy number' },
  { label: 'Carrier' },
  { label: 'Line of business' },
  { label: 'Renewal date' },
  { label: 'Days remaining', numeric: true },
  { label: 'Assigned employee' },
  { label: 'Current premium', numeric: true },
  { label: 'Renewal premium', numeric: true },
  { label: 'Premium change', numeric: true },
  { label: 'Last contact' },
  { label: 'Next follow-up' },
  { label: 'Status' },
  { label: 'Next required action' },
];

/**
 * One list row, already derived. `daysRemaining` comes from `daysRemaining()`,
 * `premiumChange` from `premiumChange()`, and `nextRequiredAction` from
 * `recommendedNextAction()`, so no cell here is computed from raw record fields.
 */
export interface RenewalTableRow {
  /** `renewal_records.id`, the value handed back through `onSelect`. */
  id: string;
  customerName: string | null;
  policyNumber: string | null;
  carrier: string | null;
  lineOfBusiness: string | null;
  /** `YYYY-MM-DD` calendar date, or a timestamp; absent renders an em dash. */
  renewalDate: string | null;
  /** Signed whole days: `0` on the renewal date, negative once it has passed (Req 4.7). */
  daysRemaining: number | null;
  /** Display name of the assigned employee; absent renders `Unassigned` (Req 4.3). */
  assignedEmployee: string | null;
  currentPremium: number | null;
  renewalPremium: number | null;
  /** `null` when either premium is absent, which renders an em dash (Req 4.4). */
  premiumChange: RenewalPremiumChange | null;
  /** Event time of the most recent contact entry recorded on the record (Req 4.1). */
  lastContact: string | null;
  nextFollowUp: string | null;
  /** Stored renewal workflow status (Req 4.1). */
  status: RenewalStatus | null;
  /** Recommended next action from Requirement 5.2 (Req 4.1). */
  nextRequiredAction: RenewalNextAction | null;
}

export interface RenewalsTableProps {
  rows: readonly RenewalTableRow[];
  selectedId: string | null;
  onSelect: (recordId: string) => void;
  loading?: boolean;
}

/** Colour is a redundant cue only; the sign character carries the direction on its own. */
function premiumChangeTone(change: RenewalPremiumChange | null | undefined): string {
  if (!change || !Number.isFinite(change.amount) || change.amount === 0) return 'text-slate-700';
  return change.amount > 0 ? 'text-rose-700' : 'text-emerald-700';
}

export default function RenewalsTable({ rows, selectedId, onSelect, loading = false }: RenewalsTableProps) {
  // Requirement 1.5: while the first page of at most 50 records loads, the indicator stands in
  // place of the list surface rather than beside it, so no partial or stale row set is on screen
  // while the query is in flight. The parent owns paging and swaps `loading` off once the query
  // returns records or returns an error.
  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-6 py-12 text-sm font-bold text-slate-500"
      >
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading renewals…
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className={ui.table}>
        <caption className="sr-only">
          Renewals. Fourteen columns per record. Select the customer name in a row to open that renewal.
        </caption>
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column.label} scope="col" className={`${HEAD_CELL} ${column.numeric ? 'text-right' : ''}`}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* An empty result set renders zero rows on purpose: the parent owns the empty state
              so it can name the active saved filter and search text (Req 1.6, 1.9). */}
          {rows.map((row) => {
            const selected = row.id === selectedId;
            return (
              <tr
                key={row.id}
                aria-selected={selected}
                // Row click is a convenience target only. The keyboard path is the real
                // button in the first cell below, so no interaction is mouse-only (Req 4.6).
                onClick={() => onSelect(row.id)}
                className={`${ui.trHover} ${selected ? 'bg-[#eef3fb]' : ''}`}
              >
                <td className={`${CELL} font-black text-slate-900`}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(row.id);
                    }}
                    className="inline-flex items-center gap-1.5 rounded text-left font-black text-slate-900 underline-offset-2 transition hover:underline focus-visible:ring-2 focus-visible:ring-[#7890bc] focus-visible:outline-none"
                  >
                    {/* Symbol cue so selection is not carried by the row tint alone. */}
                    <span aria-hidden="true" className={selected ? 'text-[#223f7a]' : 'text-transparent'}>
                      &#10003;
                    </span>
                    {text(row.customerName)}
                  </button>
                </td>
                <td className={`${CELL} font-semibold`}>{text(row.policyNumber)}</td>
                <td className={CELL}>{text(row.carrier)}</td>
                <td className={CELL}>{text(row.lineOfBusiness)}</td>
                <td className={CELL}>{calendarText(row.renewalDate)}</td>
                <td className={`${NUMERIC_CELL} font-bold`}>{wholeNumber(row.daysRemaining)}</td>
                <td className={CELL}>{assignedText(row.assignedEmployee)}</td>
                <td className={NUMERIC_CELL}>{money(row.currentPremium)}</td>
                <td className={NUMERIC_CELL}>{money(row.renewalPremium)}</td>
                <td className={`${NUMERIC_CELL} font-bold ${premiumChangeTone(row.premiumChange)}`}>
                  {signedMoney(row.premiumChange)}
                </td>
                <td className={CELL}>{calendarText(row.lastContact)}</td>
                <td className={CELL}>{calendarText(row.nextFollowUp)}</td>
                <td className={CELL}>
                  {row.status ? (
                    <span className={`${ui.badge} ${ui.badgeTone[renewalStatusTone[row.status] || 'neutral']}`}>
                      {statusLabel(row.status)}
                    </span>
                  ) : (
                    EM_DASH
                  )}
                </td>
                <td className={`${CELL} font-semibold text-slate-900`}>{text(row.nextRequiredAction)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

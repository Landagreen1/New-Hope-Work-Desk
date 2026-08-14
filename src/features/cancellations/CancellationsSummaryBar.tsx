'use client';

// Cancellations summary filter bar (Requirements 16.2, 16.3, 1.4, 1.6, 1.9).
//
// The cancellations twin of `../renewals/RenewalsSummaryBar`, and purely presentational in the
// same way: the fourteen filters and their order come from `CANCELLATION_SAVED_FILTERS`, every
// count arrives through props, and the active filter, the search text, and the row count are owned
// by `CancellationsPage`. This file performs zero data access — no Supabase client, no cancellation
// database function, no network call.
//
// It renders three things the tab needs above its list surface (Requirement 1.4): the fourteen
// saved filters with their counts, the search field, and — when the query came back with nothing —
// the empty state in one of its two variants.
//
// **Readings recorded where a criterion leaves something open.**
//
//  1. *"No saved filter is selected" means the All filter is active.* Requirement 1.9's empty state
//     applies while no saved filter is selected, but Requirement 16.2 keeps exactly one of the
//     fourteen filters active at all times, so the Cancellations tab has no zero-filter state. The
//     one filter that narrows nothing is All, so All is what "not narrowed by a filter" is here,
//     and `isCancellationListNarrowed` is the single definition of it.
//  2. *The clearing control of Requirement 1.6 clears to All, not to Needs Action.* That control
//     exists to remove the narrowing the empty state just named. Returning to
//     `DEFAULT_CANCELLATION_FILTER` would leave the list narrowed by Needs Action and land the user
//     on the same empty state, so `CLEARED_CANCELLATION_FILTER` is All — the state in which
//     reading 1 says the Requirement 1.9 variant applies. The container performs the clear; this
//     file exports the constant so both agree on one meaning.
//  3. *An absent active filter reads as Needs Action.* `CancellationsUiState.savedFilter` is
//     nullable, because Requirement 1.3 retains a value the user may never have set. Null is
//     resolved to `DEFAULT_CANCELLATION_FILTER` exactly as `filterCancellationRows` resolves it, so
//     the bar highlights the filter the list actually applied (Requirement 16.2).
//  4. *The empty state quotes the search text with its case intact.* `effectiveSearchText` decides
//     whether search narrowing is present, so the bar and the list agree on that; it also
//     lower-cases, which is right for comparison and wrong for quoting the user back to
//     themselves. The quoted form applies the same trim and the same 100-character cap and leaves
//     the case alone (Requirement 16.4).

import { Check, Search } from 'lucide-react';
import { useId } from 'react';

import { ui } from '../nhwd-shared/ui';
import {
  CANCELLATION_SAVED_FILTERS,
  DEFAULT_CANCELLATION_FILTER,
  MAX_SEARCH_LENGTH,
  STANDARD_CANCELLATION_SAVED_FILTERS,
  effectiveSearchText,
} from './derive';
import type { CancellationFilterCounts, CancellationSavedFilterId } from './derive';

/** The filter the Requirement 1.6 clearing control selects — reading 2. */
export const CLEARED_CANCELLATION_FILTER: CancellationSavedFilterId = 'all';

export interface CancellationsSummaryBarProps {
  /** All fourteen counts, each computed independently of which filter is active (Req 16.2). */
  counts: CancellationFilterCounts;
  /** The one active filter; `null` reads as Needs Action, as the list reads it — reading 3. */
  activeFilter: CancellationSavedFilterId | null;
  /** Receives the newly selected filter. Never `null`: exactly one filter is active (Req 16.2). */
  onFilterChange: (next: CancellationSavedFilterId) => void;
  /** The text as entered. The effective text is trimmed and capped at 100 characters (Req 16.4). */
  searchText: string;
  onSearchTextChange: (next: string) => void;
  /** Rows the list surface is displaying. Zero, and not loading, raises the empty state. */
  rowCount: number;
  /** Requirement 1.6: clears both the saved filter selection and the search text — reading 2. */
  onClearFilterAndSearch: () => void;
  /** Requirement 1.5: while the first page loads, the empty state is not a true statement yet. */
  loading?: boolean;
}

/** A count of zero renders as `0`; a filter is never hidden because its count is zero (Req 16.2). */
function displayCount(value: number | undefined): string {
  const count = Number.isFinite(value) ? Number(value) : 0;
  return count.toLocaleString('en-US');
}

/** The active filter as the list resolves it: an absent selection is Needs Action — reading 3. */
export function resolveCancellationFilter(
  activeFilter: CancellationSavedFilterId | null | undefined,
): CancellationSavedFilterId {
  return activeFilter ?? DEFAULT_CANCELLATION_FILTER;
}

/**
 * True where the list is narrowed by a saved filter or by search text, which is what separates the
 * Requirement 1.6 empty state from the Requirement 1.9 one. A filter narrows unless it is All
 * (reading 1); search text narrows once its effective form holds at least one character
 * (Requirement 16.3).
 */
export function isCancellationListNarrowed(
  activeFilter: CancellationSavedFilterId | null | undefined,
  searchText: string | null | undefined,
): boolean {
  return (
    resolveCancellationFilter(activeFilter) !== CLEARED_CANCELLATION_FILTER ||
    effectiveSearchText(searchText).length > 0
  );
}

/** The effective search text as the empty state quotes it: trimmed, capped, case kept — reading 4. */
function quotedSearchText(searchText: string | null | undefined): string {
  return (searchText ?? '').trim().slice(0, MAX_SEARCH_LENGTH);
}

export default function CancellationsSummaryBar({
  counts,
  activeFilter,
  onFilterChange,
  searchText,
  onSearchTextChange,
  rowCount,
  onClearFilterAndSearch,
  loading = false,
}: CancellationsSummaryBarProps) {
  const headingId = useId();
  const groupName = `${headingId}-cancellation-filter`;

  const selectedFilter = resolveCancellationFilter(activeFilter);
  /** Absent for All, which names no narrowing of its own — reading 1. */
  const filterLabel =
    selectedFilter === CLEARED_CANCELLATION_FILTER
      ? ''
      : CANCELLATION_SAVED_FILTERS.find((filter) => filter.id === selectedFilter)?.label ?? '';
  const quotedSearch = quotedSearchText(searchText);
  const narrowed = isCancellationListNarrowed(activeFilter, searchText);
  const empty = !loading && rowCount === 0;

  return (
    <section className="space-y-4">
      <label className="relative block w-full lg:max-w-md">
        <span className="sr-only">Search cancellations</span>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden="true"
        />
        <input
          type="search"
          className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm font-semibold text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#7890bc] focus:ring-4 focus:ring-[#eef3fb]"
          value={searchText}
          maxLength={MAX_SEARCH_LENGTH}
          placeholder="Customer, policy number, carrier, phone, or email"
          onChange={(event) => onSearchTextChange(event.target.value)}
        />
      </label>

      <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
        <div className="mb-3">
          <p className={ui.sectionTitle} id={headingId}>
            Cancellation saved filters
          </p>
          <p className="mt-1 text-xs font-semibold text-slate-500">
            Exactly one filter is active. Needs Action is active until you select another.
          </p>
        </div>

        {/* A radio group rather than a set of toggles: Requirement 16.2 keeps exactly one filter
            active, so the selected state and its exclusivity reach assistive tech natively, and
            arrow-key movement between the fourteen filters comes for free. */}
        <div role="radiogroup" aria-labelledby={headingId} aria-busy={loading} className="flex flex-wrap gap-2">
          {STANDARD_CANCELLATION_SAVED_FILTERS.map((filter) => {
            const active = selectedFilter === filter.id;
            const count = displayCount(counts[filter.id]);
            return (
              <label
                key={filter.id}
                className={`relative inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black transition has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-[#eef3fb] ${
                  loading ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
                } ${
                  active
                    ? 'border-[#223f7a] bg-[#223f7a] text-white shadow-sm'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-[#8da4cf] hover:bg-[#f8faff]'
                }`}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name={groupName}
                  value={filter.id}
                  checked={active}
                  disabled={loading}
                  aria-label={`${filter.label}, ${count}`}
                  onChange={() => onFilterChange(filter.id)}
                />
                {/* Non-color indicator of the selected state, paired with the radio semantics. */}
                {active ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                <span>{filter.label}</span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[11px] font-black tabular-nums ${
                    active ? 'bg-white/20 text-white' : 'bg-[#eef3fb] text-[#223f7a]'
                  }`}
                >
                  {count}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Requirement 1.6 while the list is narrowed, Requirement 1.9 while it is not. The two
          differ in what they state and in whether the clearing control is offered. */}
      {empty ? (
        <div className={ui.empty}>
          {narrowed ? (
            <>
              <p>
                No cancellation records match
                {filterLabel ? ` the ${filterLabel} filter` : ''}
                {filterLabel && quotedSearch ? ' and' : ''}
                {quotedSearch ? ` the search text \u201C${quotedSearch}\u201D` : ''}.
              </p>
              <button type="button" className={`${ui.btnSecondary} mt-3`} onClick={onClearFilterAndSearch}>
                Clear the filter and the search text
              </button>
            </>
          ) : (
            <p>This tab contains zero cancellation records.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

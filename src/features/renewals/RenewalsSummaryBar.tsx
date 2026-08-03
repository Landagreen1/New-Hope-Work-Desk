'use client';

// Renewals summary filter bar (Requirements 3.1 to 3.4).
//
// Purely presentational and controlled: the ten filters and their order come from
// `RENEWAL_SUMMARY_FILTERS`, every count arrives through props, and the active filter is
// owned by the page container. This file performs zero data access — no Supabase client,
// no renewal database function, no network call (Requirement 7.2).

import { Check } from 'lucide-react';
import { useId } from 'react';

import { ui } from '../nhwd-shared/ui';
import { RENEWAL_SUMMARY_FILTERS } from './derive';
import type { RenewalSummaryCounts, RenewalSummaryFilterId } from './derive';

export interface RenewalsSummaryBarProps {
  counts: RenewalSummaryCounts;
  activeFilter: RenewalSummaryFilterId | null;
  /** Receives the newly selected filter, or `null` when the active filter is cleared (Req 3.4). */
  onFilterChange: (next: RenewalSummaryFilterId | null) => void;
  loading?: boolean;
}

/** A count of zero renders as `0`; a filter is never hidden because its count is zero (Req 3.3). */
function displayCount(value: number | undefined): string {
  const count = Number.isFinite(value) ? Number(value) : 0;
  return count.toLocaleString('en-US');
}

export default function RenewalsSummaryBar({
  counts,
  activeFilter,
  onFilterChange,
  loading = false,
}: RenewalsSummaryBarProps) {
  const headingId = useId();

  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="mb-3">
        <p className={ui.sectionTitle} id={headingId}>
          Renewal summary filters
        </p>
        <p className="mt-1 text-xs font-semibold text-slate-500">
          Select a counter to narrow the renewal list. Select the active counter again to clear it.
        </p>
      </div>

      <div
        role="group"
        aria-labelledby={headingId}
        aria-busy={loading}
        className="flex flex-wrap gap-2"
      >
        {RENEWAL_SUMMARY_FILTERS.map((filter) => {
          const active = activeFilter === filter.id;
          const count = displayCount(counts[filter.id]);
          return (
            <button
              key={filter.id}
              type="button"
              aria-pressed={active}
              aria-label={`${filter.label}, ${count}`}
              disabled={loading}
              onClick={() => onFilterChange(active ? null : filter.id)}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#eef3fb] disabled:cursor-not-allowed disabled:opacity-40 ${
                active
                  ? 'border-[#223f7a] bg-[#223f7a] text-white shadow-sm'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-[#8da4cf] hover:bg-[#f8faff]'
              }`}
            >
              {/* Non-color indicator of the active state, paired with aria-pressed. */}
              {active ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
              <span>{filter.label}</span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[11px] font-black tabular-nums ${
                  active ? 'bg-white/20 text-white' : 'bg-[#eef3fb] text-[#223f7a]'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

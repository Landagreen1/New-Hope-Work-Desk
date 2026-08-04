'use client';

/**
 * The Needs Attention summary.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 11.5, 11.6
 *
 * Eight named operational concerns, each a count that opens its own records. The report
 * this replaces built a flat list of up to a hundred exception strings from present
 * state, ignored the date range, and had no way to reach the records behind any of them.
 */

import { ui } from '../nhwd-shared-bridge';
import { formatCount, severityTone } from '../derive';
import type { NeedsAttentionRow } from '../types';

export function NeedsAttention({
  rows,
  onSelect,
}: {
  rows: NeedsAttentionRow[];
  onSelect: (conditionKey: string, label: string) => void;
}) {
  const total = rows.reduce((sum, row) => sum + Number(row.record_count), 0);

  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div>
          <p className={ui.sectionTitle}>Needs Attention</p>
          <h3 className="mt-1 text-xl font-black text-slate-950">
            {total === 0
              ? 'Nothing is waiting on a decision'
              : `${formatCount(total)} item${total === 1 ? '' : 's'} to look at`}
          </h3>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            Every count opens the exact records behind it.
          </p>
        </div>
      </div>
      <div className={ui.cardPad}>
        {rows.length === 0 ? (
          <p className={ui.empty}>No operational concerns for the active filters.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {rows.map((row) => {
              const count = Number(row.record_count);
              return (
                <button
                  key={row.condition_key}
                  type="button"
                  onClick={() => onSelect(row.condition_key, row.label)}
                  disabled={count === 0}
                  className={`${ui.stat} text-left transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-default disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-sm`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className={ui.statLabel}>{row.label}</span>
                    <span className={`${ui.badge} ${ui.badgeTone[severityTone(row.severity)]}`}>
                      {row.severity}
                    </span>
                  </span>
                  <span
                    className={`mt-1 block text-3xl font-black tracking-tight ${
                      count === 0 ? 'text-slate-300' : 'text-slate-950'
                    }`}
                  >
                    {formatCount(count)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

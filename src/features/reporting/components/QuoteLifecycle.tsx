'use client';

/**
 * The Quote Cohort lifecycle funnel.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 3.4, 4.10, 4.11, 11.3, 11.4
 *
 * Two blocks, because they answer different questions and mixing them is what makes a
 * funnel misleading:
 *
 *   Progression  Received -> Accepted -> Priced -> Finalized. Cumulative. A quote can
 *                appear in all four.
 *   State        Sold, Not Sold, Awaiting Customer Decision, Still Pending Pricing,
 *                Still Active. Mutually exclusive, and they sum to Received.
 *
 * Every value is a legible number with its percentage next to it. No decorative funnel
 * shape, because a tapering graphic communicates the shape and hides the count, and the
 * count is the thing a manager needs.
 *
 * The sum invariant is checked on screen rather than assumed: if the five states do not
 * add up to Received, that is a defect in the query and it should be visible, not
 * silently rendered as a slightly wrong chart.
 */

import { ui } from '../nhwd-shared-bridge';
import { formatCount, formatPercent, shareOf } from '../derive';
import type { LifecycleSummary } from '../types';

function Bar({
  label,
  value,
  total,
  tone,
  onSelect,
  note,
}: {
  label: string;
  value: number | undefined;
  total: number | undefined;
  tone: string;
  onSelect?: () => void;
  note?: string;
}) {
  const share = shareOf(value, total);
  const width = share === null ? 0 : Math.min(100, Math.max(0, share));
  const content = (
    <>
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-black text-slate-700">{label}</span>
        <span className="flex items-baseline gap-2">
          <span className="text-lg font-black tabular-nums text-slate-950">
            {formatCount(value)}
          </span>
          <span className="w-16 text-right text-xs font-bold tabular-nums text-slate-400">
            {formatPercent(share)}
          </span>
        </span>
      </span>
      <span className="mt-2 block h-2.5 overflow-hidden rounded-full bg-slate-100">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${width}%` }} />
      </span>
      {note !== undefined ? (
        <span className="mt-1 block text-[11px] font-semibold text-slate-400">{note}</span>
      ) : null}
    </>
  );

  if (onSelect === undefined) {
    return <div className="block w-full">{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      className="block w-full rounded-xl text-left transition hover:bg-slate-50"
    >
      {content}
    </button>
  );
}

export function QuoteLifecycle({
  lifecycle,
  onSelectMetric,
}: {
  lifecycle: LifecycleSummary | null;
  onSelectMetric: (metricKey: string) => void;
}) {
  const received = lifecycle?.received;
  const sumsCorrectly = lifecycle?.states_sum_to_received ?? true;

  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div>
          <p className={ui.sectionTitle}>Quote Cohort</p>
          <h3 className="mt-1 text-xl font-black text-slate-950">
            What became of the quotes received in this period
          </h3>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            Every quote created in the period, followed to where it stood at the end of
            it.
          </p>
        </div>
      </div>

      <div className={`${ui.cardPad} grid grid-cols-1 gap-8 lg:grid-cols-2`}>
        <div>
          <p className={ui.sectionTitle}>Progression</p>
          <p className="mt-1 text-xs font-semibold text-slate-400">
            Cumulative. A quote counts in every stage it has reached.
          </p>
          <div className="mt-4 space-y-4">
            <Bar
              label="Received"
              value={received}
              total={received}
              tone="bg-slate-400"
              onSelect={() => onSelectMetric('quotes_received')}
            />
            <Bar label="Accepted" value={lifecycle?.accepted} total={received} tone="bg-cyan-500" />
            <Bar
              label="Priced"
              value={lifecycle?.priced}
              total={received}
              tone="bg-blue-500"
              onSelect={() => onSelectMetric('pricing_sent')}
            />
            <Bar
              label="Finalized"
              value={lifecycle?.finalized}
              total={received}
              tone="bg-[#223f7a]"
              onSelect={() => onSelectMetric('finalized')}
            />
          </div>
        </div>

        <div>
          <p className={ui.sectionTitle}>State at period end</p>
          <p className="mt-1 text-xs font-semibold text-slate-400">
            Mutually exclusive. These five add up to Received.
          </p>
          <div className="mt-4 space-y-4">
            <Bar
              label="Sold"
              value={lifecycle?.sold}
              total={received}
              tone="bg-emerald-500"
              onSelect={() => onSelectMetric('sold')}
            />
            <Bar
              label="Not Sold"
              value={lifecycle?.not_sold}
              total={received}
              tone="bg-rose-500"
              onSelect={() => onSelectMetric('not_sold')}
            />
            <Bar
              label="Awaiting Customer Decision"
              value={lifecycle?.awaiting_customer_decision}
              total={received}
              tone="bg-amber-500"
              note="Priced, no outcome recorded yet"
            />
            <Bar
              label="Still Pending Pricing"
              value={lifecycle?.still_pending_pricing}
              total={received}
              tone="bg-violet-500"
              onSelect={() => onSelectMetric('pending_pricing')}
              note="Accepted, no pricing sent yet"
            />
            <Bar
              label="Still Active"
              value={lifecycle?.still_active}
              total={received}
              tone="bg-slate-300"
              note="Not yet accepted"
            />
          </div>

          {!sumsCorrectly ? (
            <p className={`${ui.error} mt-4`}>
              The five states do not add up to Received. This is a defect in the
              reporting query rather than a property of the data; do not rely on these
              figures until it is corrected.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

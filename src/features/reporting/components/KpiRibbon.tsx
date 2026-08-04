'use client';

/**
 * The eight-metric KPI ribbon.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 3.5, 4.7, 4.8, 4.9, 11.1, 11.2, 12.8
 *
 * Exactly the eight metrics named in Requirement 11.1, no more. Each card shows its
 * value, states which timestamp produced it, offers its definition, and opens its own
 * records. A ninth metric would need a requirement change, which is the point: the
 * ribbon this replaces grew to six cards with three different definitions of "pending".
 *
 * A rate with a zero denominator renders as an em dash. Rendering it as 0% would say
 * "nothing converted" where the truth is "nothing was decided yet".
 */

import { useState } from 'react';

import { ui } from '../nhwd-shared-bridge';
import { KPI_RIBBON_METRICS, METRIC_DEFINITIONS, metricTimestampLabel } from '../definitions';
import {
  computeDelta,
  formatCount,
  formatDelta,
  formatKpi,
  isPercentMetric,
  kpiValue,
} from '../derive';
import type { MetricId, ReportSummary } from '../types';

function DefinitionPopover({ metricId }: { metricId: MetricId }) {
  const [open, setOpen] = useState(false);
  const definition = METRIC_DEFINITIONS[metricId];
  return (
    <span className="relative">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className="grid h-5 w-5 place-items-center rounded-full bg-slate-100 text-[11px] font-black text-slate-500 hover:bg-slate-200"
        aria-label={`What ${definition.label} means`}
        aria-expanded={open}
      >
        ?
      </button>
      {open ? (
        <span
          className="absolute left-0 top-7 z-30 block w-72 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-lg"
          role="tooltip"
        >
          <span className="block text-xs font-black text-slate-900">{definition.label}</span>
          <span className="mt-1 block text-xs font-semibold leading-5 text-slate-600">
            {definition.definition}
          </span>
          <span className="mt-2 block text-[11px] font-bold text-slate-400">
            Counted by {metricTimestampLabel(metricId)}.
            {definition.denominator !== null
              ? ` Denominator: ${definition.denominator}.`
              : ''}
          </span>
        </span>
      ) : null}
    </span>
  );
}

export function KpiRibbon({
  summary,
  compareEnabled,
  onSelectMetric,
  activeMetricId,
}: {
  summary: ReportSummary | null;
  compareEnabled: boolean;
  onSelectMetric: (metricId: MetricId) => void;
  activeMetricId: string | null;
}) {
  return (
    <section aria-label="Key metrics">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {KPI_RIBBON_METRICS.map((metricId) => {
          const definition = METRIC_DEFINITIONS[metricId];
          const current = kpiValue(summary?.current, metricId);
          const previous = kpiValue(summary?.previous ?? undefined, metricId);
          const delta = compareEnabled ? computeDelta(current, previous) : null;
          const isActive = activeMetricId === metricId;

          return (
            <button
              key={metricId}
              type="button"
              onClick={() => onSelectMetric(metricId)}
              aria-pressed={isActive}
              className={`${ui.stat} text-left transition hover:-translate-y-0.5 hover:shadow-md ${
                isActive ? 'ring-2 ring-[#223f7a]' : ''
              }`}
            >
              <span className="flex items-start justify-between gap-2">
                <span className={ui.statLabel}>{definition.label}</span>
                <DefinitionPopover metricId={metricId} />
              </span>
              <span className={ui.statValue}>{formatKpi(current, metricId)}</span>
              {/*
                The companion figure. "Pending Pricing" named the opposite population in
                the legacy report, so showing only one of the two invites a manager to
                read a 1 where they expect a 60 and conclude the report is broken.
              */}
              {metricId === 'pending_pricing' ? (
                <span className="mt-1 block text-[11px] font-black text-amber-700">
                  {formatCount(summary?.current?.awaiting_customer_decision)} awaiting
                  customer decision (priced)
                </span>
              ) : null}
              <span className="mt-1 block text-[11px] font-bold text-slate-400">
                by {metricTimestampLabel(metricId)}
              </span>
              {compareEnabled ? (
                <span
                  className={`mt-2 block text-[11px] font-black ${
                    delta === null
                      ? 'text-slate-400'
                      : delta.direction === 'up'
                        ? 'text-emerald-700'
                        : delta.direction === 'down'
                          ? 'text-rose-700'
                          : 'text-slate-500'
                  }`}
                >
                  {formatDelta(delta, isPercentMetric(metricId))} vs previous period
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] font-semibold text-slate-400">
        Conversion Rate is Sold divided by Finalized. Quote-to-Sale Rate, which divides
        Sold by every quote received, is a different measure and is shown separately in
        Quote Cohort mode. <strong className="text-slate-500">Awaiting Pricing</strong>{' '}
        counts quotes with no pricing sent yet; the legacy report&rsquo;s
        &ldquo;Pending Pricing&rdquo; card counted the opposite group, shown here as
        awaiting customer decision.
      </p>
    </section>
  );
}

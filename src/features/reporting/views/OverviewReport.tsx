'use client';

/**
 * View 1 — Overview. The default report.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 3.4, 11.1-11.8
 *
 * Answers the four questions management opens a report to ask: how many quotes came in,
 * how many sold, how much is stuck, and what needs a decision. The compact summaries at
 * the bottom hand off to the Agents and Sources views carrying every active filter, so
 * following a lead never means rebuilding the filter set.
 */

import { ui } from '../nhwd-shared-bridge';
import { METRIC_DEFINITIONS } from '../definitions';
import { formatCount, formatMinutes, formatPercent } from '../derive';
import { KpiRibbon } from '../components/KpiRibbon';
import { NeedsAttention } from '../components/NeedsAttention';
import { QuoteLifecycle } from '../components/QuoteLifecycle';
import type {
  AfterHoursSummary,
  AgentReportRow,
  LifecycleSummary,
  MetricId,
  NeedsAttentionRow,
  ReportFilters,
  ReportSummary,
  ReportView,
  SourceReportRow,
} from '../types';

function SummaryList({
  title,
  note,
  rows,
  onOpen,
  openLabel,
}: {
  title: string;
  note: string;
  rows: ReadonlyArray<{ key: string; label: string; value: string; sub?: string }>;
  onOpen: () => void;
  openLabel: string;
}) {
  return (
    <section className={ui.card}>
      <div className="border-b border-slate-100 px-5 py-4">
        <p className={ui.sectionTitle}>{title}</p>
        <p className="mt-1 text-xs font-semibold text-slate-400">{note}</p>
      </div>
      <div className="px-5 py-4">
        {rows.length === 0 ? (
          <p className="text-sm font-semibold text-slate-400">
            No activity for the active filters.
          </p>
        ) : (
          <ol className="space-y-2.5">
            {rows.map((row, index) => (
              <li key={row.key} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="mr-2 text-xs font-black text-slate-300">
                    {index + 1}
                  </span>
                  <span className="text-sm font-bold text-slate-800">{row.label}</span>
                  {row.sub !== undefined ? (
                    <span className="ml-2 text-xs font-semibold text-slate-400">
                      {row.sub}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-sm font-black tabular-nums text-slate-950">
                  {row.value}
                </span>
              </li>
            ))}
          </ol>
        )}
        <button type="button" onClick={onOpen} className={`${ui.btnGhost} mt-4 px-0`}>
          {openLabel} →
        </button>
      </div>
    </section>
  );
}

export function OverviewReport({
  filters,
  summary,
  lifecycle,
  needsAttention,
  agentRows,
  sourceRows,
  afterHours,
  onSelectMetric,
  onSelectCondition,
  onNavigateToView,
}: {
  filters: ReportFilters;
  summary: ReportSummary | null;
  lifecycle: LifecycleSummary | null;
  needsAttention: NeedsAttentionRow[];
  agentRows: AgentReportRow[];
  sourceRows: SourceReportRow[];
  afterHours: AfterHoursSummary | null;
  onSelectMetric: (metricId: MetricId) => void;
  onSelectCondition: (conditionKey: string, label: string) => void;
  onNavigateToView: (view: ReportView) => void;
}) {
  const topByVolume = [...agentRows]
    .sort((left, right) => right.quotes_received - left.quotes_received)
    .slice(0, 5);
  const topBySold = [...agentRows]
    .sort((left, right) => right.sold - left.sold)
    .slice(0, 5);
  const sourcesByVolume = [...sourceRows]
    .sort((left, right) => right.quotes - left.quotes)
    .slice(0, 5);
  // Conversion ranking needs a volume floor, or a single sold quote out of one tops
  // the list and the table says nothing useful.
  const sourcesByConversion = [...sourceRows]
    .filter((row) => row.finalized >= 5 && row.conversion_rate !== null)
    .sort((left, right) => (right.conversion_rate ?? 0) - (left.conversion_rate ?? 0))
    .slice(0, 5);
  const sourcesMissingAttribution = [...sourceRows]
    .filter((row) => row.missing_salesperson_count > 0)
    .sort((left, right) => right.missing_salesperson_count - left.missing_salesperson_count)
    .slice(0, 5);

  const manualQuoteTotal = agentRows.reduce((sum, row) => sum + row.manual_quotes, 0);
  const manualWorkloadTotal = agentRows.reduce((sum, row) => sum + row.manual_workloads, 0);

  return (
    <div className="space-y-5">
      <KpiRibbon
        summary={summary}
        compareEnabled={filters.compareToPreviousPeriod}
        onSelectMetric={onSelectMetric}
        activeMetricId={null}
      />

      {filters.mode === 'cohort' ? (
        <QuoteLifecycle
          lifecycle={lifecycle}
          onSelectMetric={(metricKey) => onSelectMetric(metricKey as MetricId)}
        />
      ) : (
        <section className={`${ui.card} ${ui.cardPad}`}>
          <p className={ui.sectionTitle}>Quote lifecycle</p>
          <p className="mt-2 text-sm font-semibold leading-6 text-slate-600">
            The lifecycle funnel is a Quote Cohort measure: it follows the quotes
            received in this period to where they stood at the end of it. In Operational
            Activity mode each metric counts by its own event date, so the stages would
            not share a denominator and the funnel would mislead.{' '}
            <button
              type="button"
              className="font-black text-[#223f7a] underline"
              onClick={() => onSelectMetric('quotes_received')}
            >
              Switch the mode selector to Quote Cohort
            </button>{' '}
            to see it.
          </p>
        </section>
      )}

      <NeedsAttention rows={needsAttention} onSelect={onSelectCondition} />

      {/* Manual activity and after hours, the two things no current report separates. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => onSelectCondition('manual_quotes', 'Manual Quotes')}
          className={`${ui.stat} text-left transition hover:-translate-y-0.5 hover:shadow-md`}
        >
          <span className={ui.statLabel}>Manual Quotes</span>
          <span className={ui.statValue}>{formatCount(manualQuoteTotal)}</span>
          <span className="mt-1 block text-[11px] font-bold text-slate-400">
            Entered through the manual quote workflow
          </span>
        </button>
        <div className={ui.stat}>
          <p className={ui.statLabel}>Manual Workloads</p>
          <p className={ui.statValue}>{formatCount(manualWorkloadTotal)}</p>
          <p className="mt-1 block text-[11px] font-bold text-slate-400">
            Counted separately from Manual Quotes for the first time
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            onSelectCondition('received_after_hours', 'Quotes received after hours')
          }
          className={`${ui.stat} text-left transition hover:-translate-y-0.5 hover:shadow-md`}
        >
          <span className={ui.statLabel}>Received after hours</span>
          <span className={ui.statValue}>
            {formatCount(afterHours?.quotes_received_after_hours)}
          </span>
          <span className="mt-1 block text-[11px] font-bold text-slate-400">
            Arrived outside business hours
          </span>
        </button>
        <button
          type="button"
          onClick={() => onSelectCondition('worked_after_hours', 'Quotes worked after hours')}
          className={`${ui.stat} text-left transition hover:-translate-y-0.5 hover:shadow-md`}
        >
          <span className={ui.statLabel}>Worked after hours</span>
          <span className={ui.statValue}>
            {formatCount(afterHours?.quotes_worked_after_hours)}
          </span>
          <span className="mt-1 block text-[11px] font-bold text-slate-400">
            Actually worked outside business hours
          </span>
        </button>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <SummaryList
          title="Top agents by quote volume"
          note={`Attributed to the assigned agent. ${METRIC_DEFINITIONS.quotes_received.label} counts by quote creation.`}
          rows={topByVolume.map((row) => ({
            key: row.profile_id,
            label: row.display_name,
            value: formatCount(row.quotes_received),
            sub: `${formatCount(row.sold)} sold`,
          }))}
          onOpen={() => onNavigateToView('agents')}
          openLabel="Open the Agents view with these filters"
        />
        <SummaryList
          title="Top agents by Sold"
          note="Attributed to the sales-credit owner, frozen at finalization."
          rows={topBySold.map((row) => ({
            key: row.profile_id,
            label: row.display_name,
            value: formatCount(row.sold),
            sub: formatPercent(row.conversion_rate),
          }))}
          onOpen={() => onNavigateToView('agents')}
          openLabel="Open the Agents view with these filters"
        />
        <SummaryList
          title="Sources with the highest volume"
          note="Quotes created in the period, by source."
          rows={sourcesByVolume.map((row) => ({
            key: row.dealer_id ?? row.source_name,
            label: row.source_name,
            value: formatCount(row.quotes),
            sub: `${formatMinutes(row.median_time_to_pricing_minutes)} to pricing`,
          }))}
          onOpen={() => onNavigateToView('sources')}
          openLabel="Open the Sources view with these filters"
        />
        <SummaryList
          title="Sources with the highest conversion"
          note="At least five finalized quotes, so one lucky sale cannot top the list."
          rows={sourcesByConversion.map((row) => ({
            key: row.dealer_id ?? row.source_name,
            label: row.source_name,
            value: formatPercent(row.conversion_rate),
            sub: `${formatCount(row.finalized)} finalized`,
          }))}
          onOpen={() => onNavigateToView('sources')}
          openLabel="Open the Sources view with these filters"
        />
        <SummaryList
          title="Sources with the most missing attribution"
          note="Quotes with no salesperson recorded."
          rows={sourcesMissingAttribution.map((row) => ({
            key: row.dealer_id ?? row.source_name,
            label: row.source_name,
            value: formatCount(row.missing_salesperson_count),
            sub: `of ${formatCount(row.quotes)} quotes`,
          }))}
          onOpen={() => onNavigateToView('sources')}
          openLabel="Open the Sources view with these filters"
        />
        <SummaryList
          title="Employees performing after-hours work"
          note="Work recorded outside business hours, not quotes that merely arrived then."
          rows={(afterHours?.agents ?? []).slice(0, 5).map((row) => ({
            key: row.agent_name,
            label: row.agent_name,
            value: formatCount(row.quotes),
          }))}
          onOpen={() => onNavigateToView('agents')}
          openLabel="Open the Agents view with these filters"
        />
      </div>
    </div>
  );
}

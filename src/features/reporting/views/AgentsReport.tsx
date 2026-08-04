'use client';

/**
 * View 2 — Agents. One expandable table replacing four separate reports.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 12.1-12.8, 6.10
 *
 * Eleven default columns, sixteen more on expansion, and deliberately no composite
 * score. The Agent 360 report this replaces published a single number out of six
 * weighted measures with the weights buried in a component, so an employee could not be
 * told why their score moved. The measures are shown separately instead.
 *
 * Every column is attributed to the credit role it measures. The detail drawer reports
 * the five populations separately, because "quotes" today means five different things
 * depending on which report is open.
 */

import { useState } from 'react';

import { ui } from '../nhwd-shared-bridge';
import {
  EM_DASH,
  formatCount,
  formatMinutes,
  formatPercent,
  formatRatio,
} from '../derive';
import type { AgentReportRow, MetricId } from '../types';

type SortKey = keyof AgentReportRow;

const DEFAULT_COLUMNS: ReadonlyArray<{
  key: SortKey;
  label: string;
  credit: string;
  render: (row: AgentReportRow) => string;
  metric?: MetricId;
}> = [
  { key: 'quotes_received', label: 'Quotes Received', credit: 'assigned agent', render: (r) => formatCount(r.quotes_received), metric: 'quotes_received' },
  { key: 'pricing_sent', label: 'Pricing Sent', credit: 'pricing employee', render: (r) => formatCount(r.pricing_sent), metric: 'pricing_sent' },
  { key: 'pending_pricing', label: 'Pending Pricing', credit: 'assigned agent', render: (r) => formatCount(r.pending_pricing), metric: 'pending_pricing' },
  { key: 'sold', label: 'Sold', credit: 'sales credit', render: (r) => formatCount(r.sold), metric: 'sold' },
  { key: 'not_sold', label: 'Not Sold', credit: 'sales credit', render: (r) => formatCount(r.not_sold), metric: 'not_sold' },
  { key: 'conversion_rate', label: 'Conversion', credit: 'sold ÷ finalized', render: (r) => formatPercent(r.conversion_rate) },
  { key: 'manual_quotes', label: 'Manual Quotes', credit: 'created by', render: (r) => formatCount(r.manual_quotes) },
  { key: 'manual_workloads', label: 'Manual Workloads', credit: 'created by', render: (r) => formatCount(r.manual_workloads) },
  { key: 'after_hours_activity', label: 'After-Hours Activity', credit: 'assigned agent', render: (r) => formatCount(r.after_hours_activity) },
  { key: 'median_time_to_pricing_minutes', label: 'Median to Pricing', credit: 'pricing employee', render: (r) => formatMinutes(r.median_time_to_pricing_minutes) },
];

const EXPANDED_COLUMNS: ReadonlyArray<{
  key: SortKey;
  label: string;
  render: (row: AgentReportRow) => string;
}> = [
  { key: 'new_quotes', label: 'New Quotes', render: (r) => formatCount(r.new_quotes) },
  { key: 'requotes', label: 'Requotes', render: (r) => formatCount(r.requotes) },
  { key: 'intake_claims', label: 'Intake Queue claims', render: (r) => formatCount(r.intake_claims) },
  { key: 'whatsapp_claims', label: 'WhatsApp claims', render: (r) => formatCount(r.whatsapp_claims) },
  { key: 'ringcentral_claims', label: 'RingCentral claims', render: (r) => formatCount(r.ringcentral_claims) },
  { key: 'workload_queue_claims', label: 'Workload queue claims', render: (r) => formatCount(r.workload_queue_claims) },
  { key: 'passes', label: 'Passes', render: (r) => formatCount(r.passes) },
  { key: 'missed_turns', label: 'Missed turns', render: (r) => formatCount(r.missed_turns) },
  { key: 'recovered_quotes', label: 'Recovered quotes', render: (r) => formatCount(r.recovered_quotes) },
  { key: 'notes_coverage_percent', label: 'Notes coverage', render: (r) => formatPercent(r.notes_coverage_percent) },
  { key: 'follow_ups_overdue', label: 'Follow-ups overdue', render: (r) => formatCount(r.follow_ups_overdue) },
  { key: 'sold_without_pricing_evidence', label: 'Sold without pricing evidence', render: (r) => formatCount(r.sold_without_pricing_evidence) },
  { key: 'not_sold_without_reason', label: 'Not Sold without reason', render: (r) => formatCount(r.not_sold_without_reason) },
  { key: 'quotes_per_scheduled_hour', label: 'Quotes per scheduled hour', render: (r) => formatRatio(r.quotes_per_scheduled_hour) },
  { key: 'sales_per_hundred_finalized', label: 'Sales per 100 finalized', render: (r) => formatRatio(r.sales_per_hundred_finalized, 1) },
  { key: 'manual_per_hundred_activities', label: 'Manual per 100 activities', render: (r) => formatRatio(r.manual_per_hundred_activities, 1) },
  { key: 'missed_turns_per_hundred_eligible', label: 'Missed turns per 100 eligible', render: (r) => formatRatio(r.missed_turns_per_hundred_eligible, 1) },
];

function AgentDetail({ row }: { row: AgentReportRow }) {
  const populations: ReadonlyArray<{ label: string; value: number; note: string }> = [
    { label: 'Created by this employee', value: row.quotes_created, note: 'Who logged the quote' },
    { label: 'Claimed by this employee', value: row.quotes_claimed, note: 'Who accepted it' },
    { label: 'Priced by this employee', value: row.quotes_priced, note: 'Who sent the pricing' },
    { label: 'Sales credited to this employee', value: row.quotes_sales_credited, note: 'Held at finalization' },
    { label: 'Outcomes entered by this employee', value: row.quotes_outcome_entered, note: 'Who recorded Sold or Not Sold' },
  ];

  return (
    <tr className="bg-[#f8faff]">
      <td colSpan={DEFAULT_COLUMNS.length + 2} className="px-4 py-5">
        <p className={ui.sectionTitle}>
          Five different questions, five different answers
        </p>
        <p className="mt-1 max-w-3xl text-xs font-semibold leading-5 text-slate-500">
          A single &ldquo;quotes&rdquo; column cannot distinguish these. Where they
          disagree, work moved between employees, which is a fact worth seeing rather
          than a problem.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {populations.map((population) => (
            <div key={population.label} className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-2xl font-black tabular-nums text-slate-950">
                {formatCount(population.value)}
              </p>
              <p className="mt-1 text-xs font-black text-slate-700">{population.label}</p>
              <p className="mt-0.5 text-[11px] font-semibold text-slate-400">
                {population.note}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <p className={ui.statLabel}>Scheduled hours</p>
            <p className="mt-1 text-lg font-black text-slate-900">
              {row.scheduled_hours > 0 ? formatRatio(row.scheduled_hours) : EM_DASH}
            </p>
            {row.scheduled_hours === 0 ? (
              <p className="mt-0.5 text-[11px] font-semibold text-slate-400">
                No schedule recorded, so per-hour rates are undefined
              </p>
            ) : null}
          </div>
          {EXPANDED_COLUMNS.slice(13).map((column) => (
            <div key={String(column.key)}>
              <p className={ui.statLabel}>{column.label}</p>
              <p className="mt-1 text-lg font-black text-slate-900">{column.render(row)}</p>
            </div>
          ))}
        </div>
      </td>
    </tr>
  );
}

export function AgentsReport({
  rows,
  onSelectMetric,
  sortKey,
  onSortChange,
}: {
  rows: AgentReportRow[];
  onSelectMetric: (metricId: MetricId, agentProfileId: string, agentName: string) => void;
  sortKey: string | null;
  onSortChange: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showExpandedColumns, setShowExpandedColumns] = useState(false);

  const activeKey = (sortKey ?? 'quotes_received') as SortKey;
  const sorted = [...rows].sort((left, right) => {
    const a = left[activeKey];
    const b = right[activeKey];
    if (typeof a === 'number' && typeof b === 'number') return b - a;
    if (a === null) return 1;
    if (b === null) return -1;
    return String(a).localeCompare(String(b));
  });

  const columns = showExpandedColumns
    ? [...DEFAULT_COLUMNS, ...EXPANDED_COLUMNS.slice(0, 13)]
    : DEFAULT_COLUMNS;

  function toggleRow(profileId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(profileId)) next.delete(profileId);
      else next.add(profileId);
      return next;
    });
  }

  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div>
          <p className={ui.sectionTitle}>Agents</p>
          <h3 className="mt-1 text-xl font-black text-slate-950">
            Employee performance, one table
          </h3>
          <p className="mt-1 max-w-3xl text-sm font-semibold text-slate-500">
            Each column is counted against the credit role it measures: volume by
            assigned agent, pricing by whoever sent it, outcomes by the sales-credit
            owner. No composite score.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowExpandedColumns((value) => !value)}
          className={ui.btnSecondary}
          aria-pressed={showExpandedColumns}
        >
          {showExpandedColumns ? 'Fewer columns' : 'More columns'}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={`${ui.th} sticky left-0 z-10 bg-slate-50`}>Agent</th>
              {columns.map((column) => (
                <th key={String(column.key)} className={ui.th}>
                  <button
                    type="button"
                    onClick={() => onSortChange(String(column.key))}
                    className="text-left hover:text-slate-700"
                  >
                    {column.label}
                    {activeKey === column.key ? ' ▼' : ''}
                  </button>
                  {'credit' in column ? (
                    <span className="mt-0.5 block text-[9px] font-bold normal-case tracking-normal text-slate-300">
                      {(column as { credit: string }).credit}
                    </span>
                  ) : null}
                </th>
              ))}
              <th className={ui.th}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 2} className="px-4 py-10 text-center">
                  <p className="text-sm font-semibold text-slate-500">
                    No employee activity for the active filters.
                  </p>
                </td>
              </tr>
            ) : (
              sorted.map((row) => (
                <>
                  <tr key={row.profile_id} className="hover:bg-[#f8faff]">
                    <td className={`${ui.td} sticky left-0 z-10 bg-white font-black`}>
                      {row.display_name}
                      <span className="mt-0.5 block text-[11px] font-semibold text-slate-400">
                        @{row.username}
                      </span>
                    </td>
                    {columns.map((column) => {
                      const metric = 'metric' in column ? column.metric : undefined;
                      return (
                        <td key={String(column.key)} className={`${ui.td} tabular-nums`}>
                          {metric !== undefined ? (
                            <button
                              type="button"
                              onClick={() =>
                                onSelectMetric(metric, row.profile_id, row.display_name)
                              }
                              className="font-black text-[#223f7a] hover:underline"
                            >
                              {column.render(row)}
                            </button>
                          ) : (
                            <span className="font-bold">{column.render(row)}</span>
                          )}
                        </td>
                      );
                    })}
                    <td className={ui.td}>
                      <button
                        type="button"
                        onClick={() => toggleRow(row.profile_id)}
                        className={ui.btnGhost}
                        aria-expanded={expanded.has(row.profile_id)}
                      >
                        {expanded.has(row.profile_id) ? 'Hide' : 'Open'}
                      </button>
                    </td>
                  </tr>
                  {expanded.has(row.profile_id) ? (
                    <AgentDetail key={`${row.profile_id}-detail`} row={row} />
                  ) : null}
                </>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

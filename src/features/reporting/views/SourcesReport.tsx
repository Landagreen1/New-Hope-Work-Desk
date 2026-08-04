'use client';

/**
 * View 3 — Sources. Source, dealership, salesperson and input method in one place.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 13.1-13.7
 *
 * Source health is a set of named conditions, each showing the data that caused it. The
 * report this replaces labelled a source "High value" or "Needs attention" from three
 * hard-coded thresholds and showed none of them, so a manager could not tell whether a
 * label meant low volume or low conversion.
 *
 * A quote with no source is labelled and kept. Dropping it would hide the exact problem
 * the Sources view exists to surface.
 */

import { useMemo, useState } from 'react';

import { ui } from '../nhwd-shared-bridge';
import { SOURCE_HEALTH_CONDITIONS } from '../definitions';
import { formatCount, formatMinutes, formatPercent, formatRatio } from '../derive';
import type { MetricId, SourceReportRow } from '../types';

interface HealthFinding {
  key: string;
  label: string;
  evidence: string;
}

/**
 * Evaluate the nine named conditions for one source.
 *
 * Thresholds are stated in the evidence string rather than hidden, so a reader can
 * disagree with the rule instead of only with the label.
 */
function evaluateHealth(row: SourceReportRow, teamConversion: number | null): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const label = (key: string) =>
    SOURCE_HEALTH_CONDITIONS.find((condition) => condition.key === key)?.label ?? key;

  if (
    row.quotes >= 20 &&
    row.conversion_rate !== null &&
    teamConversion !== null &&
    row.conversion_rate < teamConversion - 15
  ) {
    findings.push({
      key: 'high_volume_low_conversion',
      label: label('high_volume_low_conversion'),
      evidence: `${formatCount(row.quotes)} quotes at ${formatPercent(row.conversion_rate)} against a team rate of ${formatPercent(teamConversion)}`,
    });
  }
  if (row.median_days_pending !== null && row.median_days_pending >= 7) {
    findings.push({
      key: 'high_pending_pricing_aging',
      label: label('high_pending_pricing_aging'),
      evidence: `${formatCount(row.pending_pricing)} pending, median ${formatRatio(row.median_days_pending, 1)} days waiting`,
    });
  }
  if (row.not_sold > 0 && row.no_response_count / row.not_sold >= 0.4) {
    findings.push({
      key: 'high_no_response_rate',
      label: label('high_no_response_rate'),
      evidence: `${formatCount(row.no_response_count)} of ${formatCount(row.not_sold)} lost quotes were No Response`,
    });
  }
  if (row.quotes >= 10 && row.missing_salesperson_count / row.quotes >= 0.3) {
    findings.push({
      key: 'high_missing_salesperson_rate',
      label: label('high_missing_salesperson_rate'),
      evidence: `${formatCount(row.missing_salesperson_count)} of ${formatCount(row.quotes)} quotes have no salesperson`,
    });
  }
  if (row.manual_quote_share_percent !== null && row.manual_quote_share_percent >= 50 && row.quotes >= 10) {
    findings.push({
      key: 'high_manual_entry_rate',
      label: label('high_manual_entry_rate'),
      evidence: `${formatPercent(row.manual_quote_share_percent)} of quotes were entered manually`,
    });
  }
  if (row.duplicate_count > 0) {
    findings.push({
      key: 'high_duplicate_frequency',
      label: label('high_duplicate_frequency'),
      evidence: `${formatCount(row.duplicate_count)} duplicate record${row.duplicate_count === 1 ? '' : 's'} detected`,
    });
  }
  if (row.source_change_count > 0) {
    findings.push({
      key: 'sudden_source_reassignment',
      label: label('sudden_source_reassignment'),
      evidence: `${formatCount(row.source_change_count)} recorded source change${row.source_change_count === 1 ? '' : 's'}`,
    });
  }
  if (
    row.quotes > 0 &&
    row.quotes < 10 &&
    row.conversion_rate !== null &&
    row.conversion_rate >= 60 &&
    row.finalized >= 3
  ) {
    findings.push({
      key: 'strong_conversion_low_volume',
      label: label('strong_conversion_low_volume'),
      evidence: `${formatPercent(row.conversion_rate)} conversion on only ${formatCount(row.quotes)} quotes`,
    });
  }
  return findings;
}

export function SourcesReport({
  rows,
  onSelectMetric,
}: {
  rows: SourceReportRow[];
  onSelectMetric: (metricId: MetricId, dealerId: string | null, sourceName: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const teamConversion = useMemo(() => {
    const sold = rows.reduce((sum, row) => sum + row.sold, 0);
    const finalized = rows.reduce((sum, row) => sum + row.finalized, 0);
    return finalized === 0 ? null : (sold / finalized) * 100;
  }, [rows]);

  const sorted = [...rows].sort((left, right) => right.quotes - left.quotes);

  function keyOf(row: SourceReportRow): string {
    return row.dealer_id ?? `unnamed:${row.source_name}`;
  }

  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div>
          <p className={ui.sectionTitle}>Sources</p>
          <h3 className="mt-1 text-xl font-black text-slate-950">
            Where quotes come from, and which sources produce results
          </h3>
          <p className="mt-1 max-w-3xl text-sm font-semibold text-slate-500">
            Health appears as named conditions with the data behind them, not as a score.
            Quotes with no source are listed rather than hidden.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={`${ui.th} sticky left-0 z-10 bg-slate-50`}>Source</th>
              <th className={ui.th}>Quotes</th>
              <th className={ui.th}>Pricing Sent</th>
              <th className={ui.th}>Pending</th>
              <th className={ui.th}>Sold</th>
              <th className={ui.th}>Not Sold</th>
              <th className={ui.th}>Conversion</th>
              <th className={ui.th}>Median to Pricing</th>
              <th className={ui.th}>Manual Share</th>
              <th className={ui.th}>After-Hours Share</th>
              <th className={ui.th}>Missing Salesperson</th>
              <th className={ui.th}>Duplicates</th>
              <th className={ui.th}>Conditions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={13} className="px-4 py-10 text-center">
                  <p className="text-sm font-semibold text-slate-500">
                    No source activity for the active filters.
                  </p>
                </td>
              </tr>
            ) : (
              sorted.map((row) => {
                const key = keyOf(row);
                const findings = evaluateHealth(row, teamConversion);
                const isOpen = expanded.has(key);
                return (
                  <>
                    <tr key={key} className="hover:bg-[#f8faff]">
                      <td className={`${ui.td} sticky left-0 z-10 bg-white`}>
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                          className="text-left font-black text-[#223f7a] hover:underline"
                          aria-expanded={isOpen}
                        >
                          {row.source_name}
                        </button>
                      </td>
                      <td className={`${ui.td} tabular-nums`}>
                        <button
                          type="button"
                          onClick={() => onSelectMetric('quotes_received', row.dealer_id, row.source_name)}
                          className="font-black text-[#223f7a] hover:underline"
                        >
                          {formatCount(row.quotes)}
                        </button>
                      </td>
                      <td className={`${ui.td} tabular-nums font-bold`}>{formatCount(row.pricing_sent)}</td>
                      <td className={`${ui.td} tabular-nums font-bold`}>{formatCount(row.pending_pricing)}</td>
                      <td className={`${ui.td} tabular-nums`}>
                        <button
                          type="button"
                          onClick={() => onSelectMetric('sold', row.dealer_id, row.source_name)}
                          className="font-black text-emerald-700 hover:underline"
                        >
                          {formatCount(row.sold)}
                        </button>
                      </td>
                      <td className={`${ui.td} tabular-nums`}>
                        <button
                          type="button"
                          onClick={() => onSelectMetric('not_sold', row.dealer_id, row.source_name)}
                          className="font-black text-rose-700 hover:underline"
                        >
                          {formatCount(row.not_sold)}
                        </button>
                      </td>
                      <td className={`${ui.td} tabular-nums font-bold`}>{formatPercent(row.conversion_rate)}</td>
                      <td className={`${ui.td} tabular-nums font-bold`}>{formatMinutes(row.median_time_to_pricing_minutes)}</td>
                      <td className={`${ui.td} tabular-nums font-bold`}>{formatPercent(row.manual_quote_share_percent)}</td>
                      <td className={`${ui.td} tabular-nums font-bold`}>{formatPercent(row.after_hours_share_percent)}</td>
                      <td className={`${ui.td} tabular-nums font-bold`}>{formatCount(row.missing_salesperson_count)}</td>
                      <td className={`${ui.td} tabular-nums font-bold`}>{formatCount(row.duplicate_count)}</td>
                      <td className={ui.td}>
                        {findings.length === 0 ? (
                          <span className="text-xs font-semibold text-slate-400">None</span>
                        ) : (
                          <span className={`${ui.badge} ${ui.badgeTone.progress}`}>
                            {findings.length}
                          </span>
                        )}
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr key={`${key}-detail`} className="bg-[#f8faff]">
                        <td colSpan={13} className="px-4 py-5">
                          <p className={ui.sectionTitle}>Source health conditions</p>
                          {findings.length === 0 ? (
                            <p className="mt-2 text-sm font-semibold text-slate-500">
                              No condition met for this source in the active period.
                            </p>
                          ) : (
                            <ul className="mt-3 space-y-2">
                              {findings.map((finding) => (
                                <li
                                  key={finding.key}
                                  className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3"
                                >
                                  <p className="text-sm font-black text-amber-900">
                                    {finding.label}
                                  </p>
                                  <p className="mt-0.5 text-xs font-semibold text-amber-800">
                                    {finding.evidence}
                                  </p>
                                </li>
                              ))}
                            </ul>
                          )}

                          <p className={`${ui.sectionTitle} mt-5`}>Breakdown</p>
                          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
                            <div>
                              <p className={ui.statLabel}>Finalized</p>
                              <p className="mt-1 text-lg font-black">{formatCount(row.finalized)}</p>
                            </div>
                            <div>
                              <p className={ui.statLabel}>No Response lost</p>
                              <p className="mt-1 text-lg font-black">{formatCount(row.no_response_count)}</p>
                            </div>
                            <div>
                              <p className={ui.statLabel}>Median days pending</p>
                              <p className="mt-1 text-lg font-black">{formatRatio(row.median_days_pending, 1)}</p>
                            </div>
                            <div>
                              <p className={ui.statLabel}>Source changes</p>
                              <p className="mt-1 text-lg font-black">{formatCount(row.source_change_count)}</p>
                            </div>
                            <div>
                              <p className={ui.statLabel}>Manual share</p>
                              <p className="mt-1 text-lg font-black">{formatPercent(row.manual_quote_share_percent)}</p>
                            </div>
                            <div>
                              <p className={ui.statLabel}>After-hours share</p>
                              <p className="mt-1 text-lg font-black">{formatPercent(row.after_hours_share_percent)}</p>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => onSelectMetric('quotes_received', row.dealer_id, row.source_name)}
                            className={`${ui.btnSecondary} mt-5`}
                          >
                            Open every quote from this source
                          </button>
                        </td>
                      </tr>
                    ) : null}
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

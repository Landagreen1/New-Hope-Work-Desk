'use client';

/**
 * Specialty Quotes reporting.
 *
 * Seven views, each one a single aggregate RPC. Nothing is computed in the browser
 * from a full table pull — the figures are scoped server-side by the same team
 * boundary the operational list uses, so a Homeowners-only member's reports contain
 * no trucking numbers and a manager's contain everything.
 *
 * Two deliberate choices in how the numbers are presented:
 *
 *   * Workload and Contribution are separate views, not one table. Workload counts
 *     primary assignments; contribution counts what people actually did. Merging them
 *     would reintroduce exactly the mistake this engine exists to avoid — crediting
 *     the assignee for a teammate's carrier submission.
 *   * A metric with no underlying data reads as "—", never as zero. A carrier we have
 *     never submitted to has no quote rate; saying 0% would be a claim about the
 *     carrier rather than about our records.
 */

import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import DatePicker from '../nhwd-shared/DatePicker';
import { ui } from '../nhwd-shared/ui';
import {
  getAttentionReport,
  getCarrierPerformanceReport,
  getContributionReport,
  getLostBusinessReport,
  getPipelineReport,
  getTimingReport,
  getWorkloadReport,
} from './api';
import {
  attentionLabel,
  formatMoney,
  formatRelative,
  lineLabel,
  lostReasonLabel,
  stageLabel,
  STAGE_ORDER,
} from './status';
import type {
  AttentionRow,
  CarrierPerformanceRow,
  ContributionRow,
  LostBusinessRow,
  PipelineRow,
  SpecialtyLine,
  TimingRow,
  WorkloadRow,
  WorkspaceContext,
} from './types';

type ReportView =
  | 'pipeline'
  | 'workload'
  | 'contribution'
  | 'timing'
  | 'carriers'
  | 'lost'
  | 'attention';

const REPORT_VIEWS: { id: ReportView; label: string }[] = [
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'attention', label: 'Needs Attention' },
  { id: 'workload', label: 'Workload' },
  { id: 'contribution', label: 'Contribution' },
  { id: 'timing', label: 'Timing' },
  { id: 'carriers', label: 'Carrier Performance' },
  { id: 'lost', label: 'Lost Business' },
];

function num(value: number | null | undefined, suffix = ''): string {
  if (value === null || value === undefined) return '—';
  return `${value}${suffix}`;
}

function hours(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 24) return `${value}h`;
  return `${(value / 24).toFixed(1)}d`;
}

export interface SpecialtyReportsProps {
  context: WorkspaceContext;
  onOpen: (opportunityId: string) => void;
}

export default function SpecialtyReports({ context, onOpen }: SpecialtyReportsProps) {
  const [view, setView] = useState<ReportView>('pipeline');
  const [line, setLine] = useState<SpecialtyLine | 'all'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [pipeline, setPipeline] = useState<PipelineRow[]>([]);
  const [workload, setWorkload] = useState<WorkloadRow[]>([]);
  const [contribution, setContribution] = useState<ContributionRow[]>([]);
  const [timing, setTiming] = useState<TimingRow[]>([]);
  const [carriers, setCarriers] = useState<CarrierPerformanceRow[]>([]);
  const [lost, setLost] = useState<LostBusinessRow[]>([]);
  const [attention, setAttention] = useState<AttentionRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const availableLines = useMemo(
    () => Array.from(new Set(context.lines_of_business.map((route) => route.line_of_business))),
    [context.lines_of_business],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const range = { from: from || null, to: to || null, lineOfBusiness: line };
    try {
      switch (view) {
        case 'pipeline':
          setPipeline(await getPipelineReport(range));
          break;
        case 'workload':
          setWorkload(await getWorkloadReport(line));
          break;
        case 'contribution':
          setContribution(await getContributionReport(range));
          break;
        case 'timing':
          setTiming(await getTimingReport(range));
          break;
        case 'carriers':
          setCarriers(await getCarrierPerformanceReport(range));
          break;
        case 'lost':
          setLost(await getLostBusinessReport(range));
          break;
        case 'attention':
          setAttention(await getAttentionReport(line));
          break;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That report could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [from, line, to, view]);

  useEffect(() => {
    void load();
  }, [load]);

  const attentionGroups = useMemo(() => {
    const map = new Map<string, AttentionRow[]>();
    for (const row of attention) {
      const list = map.get(row.bucket) ?? [];
      list.push(row);
      map.set(row.bucket, list);
    }
    return Array.from(map.entries());
  }, [attention]);

  return (
    <div className="space-y-5">
      {error ? <div className={ui.error}>{error}</div> : null}

      <section className={`${ui.card} ${ui.cardPad}`}>
        <nav aria-label="Report views" className="flex flex-wrap gap-1 rounded-2xl bg-slate-100 p-1.5">
          {REPORT_VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setView(entry.id)}
              aria-current={view === entry.id ? 'page' : undefined}
              className={`rounded-xl px-4 py-2.5 text-sm font-black transition ${
                view === entry.id ? 'bg-[#223f7a] text-white shadow-sm' : 'text-slate-600 hover:bg-white'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        {/* The pickers get an explicit mt-2 because, unlike `ui.select` and `ui.input`,
            DatePicker carries no top margin of its own — so without it the date fields
            sit higher than the select beside them. Same convention as PayrollProcessor
            and WorkforceAdmin. */}
        <div className="mt-4 grid items-end gap-3 sm:grid-cols-2 md:grid-cols-[minmax(160px,200px)_minmax(150px,180px)_minmax(150px,180px)_auto]">
          <div>
            <label className={ui.label} htmlFor="specialty-report-line">
              Line of business
            </label>
            <select
              id="specialty-report-line"
              className={ui.select}
              value={line}
              onChange={(event) => setLine(event.target.value as SpecialtyLine | 'all')}
            >
              <option value="all">All lines</option>
              {availableLines.map((option) => (
                <option key={option} value={option}>
                  {lineLabel(option)}
                </option>
              ))}
            </select>
          </div>

          {view !== 'workload' && view !== 'attention' ? (
            <>
              <div>
                <span className={ui.label}>From</span>
                <DatePicker value={from} onChange={setFrom} max={to || undefined} className="mt-2" />
              </div>
              <div>
                <span className={ui.label}>To</span>
                <DatePicker value={to} onChange={setTo} min={from || undefined} className="mt-2" />
              </div>
            </>
          ) : null}

          <div>
            <button
              type="button"
              className={`${ui.btnSecondary} mt-2 w-full whitespace-nowrap sm:w-auto`}
              onClick={() => void load()}
            >
              <RefreshCw className={`h-4 w-4 shrink-0 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </section>

      {loading ? <p className={ui.empty}>Loading…</p> : null}

      {/* ── Pipeline ─────────────────────────────────────────────────────────── */}
      {!loading && view === 'pipeline' ? (
        <div className="space-y-5">
          {availableLines
            .filter((option) => line === 'all' || option === line)
            .map((option) => {
              const rows = pipeline.filter((row) => row.line_of_business === option);
              const total = rows.reduce((sum, row) => sum + row.opportunity_count, 0);
              const active = rows
                .filter((row) => row.stage !== 'sold' && row.stage !== 'not_sold')
                .reduce((sum, row) => sum + row.opportunity_count, 0);
              const overdue = rows.reduce((sum, row) => sum + row.overdue_count, 0);
              const stale = rows.reduce((sum, row) => sum + row.stale_count, 0);
              const sold = rows.find((row) => row.stage === 'sold');
              return (
                <section key={option} className={ui.card}>
                  <div className={ui.cardHeader}>
                    <p className={ui.sectionTitle}>{lineLabel(option)}</p>
                    <div className="flex flex-wrap gap-4 text-xs font-black text-slate-500">
                      <span>{active} active</span>
                      <span>{total} total</span>
                      <span className={overdue > 0 ? 'text-rose-600' : ''}>{overdue} overdue</span>
                      <span className={stale > 0 ? 'text-amber-600' : ''}>{stale} stale</span>
                      {sold ? <span className="text-emerald-700">{formatMoney(sold.sold_premium_total)} sold</span> : null}
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className={ui.table}>
                      <thead>
                        <tr>
                          <th className={ui.th}>Stage</th>
                          <th className={ui.th}>Quotes</th>
                          <th className={ui.th}>Unclaimed</th>
                          <th className={ui.th}>Overdue</th>
                          <th className={ui.th}>No recent activity</th>
                          <th className={ui.th}>Average age</th>
                        </tr>
                      </thead>
                      <tbody>
                        {STAGE_ORDER.map((stage) => {
                          const row = rows.find((entry) => entry.stage === stage);
                          return (
                            <tr key={stage}>
                              <td className={ui.td}>
                                <span className="font-black text-slate-800">{stageLabel(stage)}</span>
                              </td>
                              <td className={ui.td}>{row?.opportunity_count ?? 0}</td>
                              <td className={ui.td}>{row?.unclaimed_count ?? 0}</td>
                              <td className={ui.td}>{row?.overdue_count ?? 0}</td>
                              <td className={ui.td}>{row?.stale_count ?? 0}</td>
                              <td className={ui.td}>{num(row?.avg_age_days ?? null, ' days')}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}
        </div>
      ) : null}

      {/* ── Needs attention ──────────────────────────────────────────────────── */}
      {!loading && view === 'attention' ? (
        <div className="space-y-5">
          {attentionGroups.length === 0 ? (
            <p className={ui.empty}>Nothing needs chasing right now.</p>
          ) : null}
          {attentionGroups.map(([bucket, rows]) => (
            <section key={bucket} className={ui.card}>
              <div className={ui.cardHeader}>
                <p className={ui.sectionTitle}>{attentionLabel(bucket)}</p>
                <span className={`${ui.badge} ${ui.badgeTone.progress}`}>{rows.length}</span>
              </div>
              <div className="overflow-x-auto">
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th className={ui.th}>Quote</th>
                      <th className={ui.th}>Stage</th>
                      <th className={ui.th}>Assigned</th>
                      <th className={ui.th}>Why</th>
                      <th className={ui.th}>Age</th>
                      <th className={ui.th}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={`${bucket}-${row.opportunity_id}`} className={ui.trHover}>
                        <td className={ui.td}>
                          <span className="font-black text-slate-900">{row.display_name}</span>
                          <p className="mt-0.5 text-xs font-bold text-slate-400">
                            {row.reference} · {lineLabel(row.line_of_business)}
                          </p>
                        </td>
                        <td className={ui.td}>{row.stage_label}</td>
                        <td className={ui.td}>{row.assignee_name ?? 'Unclaimed'}</td>
                        <td className={ui.td}>{row.detail ?? '—'}</td>
                        <td className={ui.td}>{num(row.age_days, ' days')}</td>
                        <td className={ui.td}>
                          <button
                            type="button"
                            className={ui.btnSecondary}
                            onClick={() => onOpen(row.opportunity_id)}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      ) : null}

      {/* ── Workload ─────────────────────────────────────────────────────────── */}
      {!loading && view === 'workload' ? (
        <section className={ui.card}>
          <div className={ui.cardHeader}>
            <p className={ui.sectionTitle}>Employee workload</p>
            <p className="text-xs font-semibold text-slate-500">
              Primary assignments. What each person is accountable for, not a record of who did the
              work — that is the Contribution view.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>Employee</th>
                  <th className={ui.th}>Active</th>
                  <th className={ui.th}>Info needed</th>
                  <th className={ui.th}>Marketing</th>
                  <th className={ui.th}>Options ready</th>
                  <th className={ui.th}>Price sent</th>
                  <th className={ui.th}>Follow-up</th>
                  <th className={ui.th}>Due today</th>
                  <th className={ui.th}>Overdue</th>
                  <th className={ui.th}>Sold</th>
                  <th className={ui.th}>Not sold</th>
                </tr>
              </thead>
              <tbody>
                {workload.length === 0 ? (
                  <tr>
                    <td className={ui.td} colSpan={11}>
                      No team members to report on.
                    </td>
                  </tr>
                ) : null}
                {workload.map((row) => (
                  <tr key={row.profile_id}>
                    <td className={ui.td}>
                      <span className="font-black text-slate-900">{row.display_name}</span>
                    </td>
                    <td className={ui.td}>
                      <span className="font-black">{row.active_count}</span>
                    </td>
                    <td className={ui.td}>{row.information_needed_count}</td>
                    <td className={ui.td}>{row.marketing_count}</td>
                    <td className={ui.td}>{row.options_ready_count}</td>
                    <td className={ui.td}>{row.price_sent_count}</td>
                    <td className={ui.td}>{row.follow_up_count}</td>
                    <td className={ui.td}>{row.due_today_count}</td>
                    <td className={row.overdue_count > 0 ? `${ui.td} font-black text-rose-600` : ui.td}>
                      {row.overdue_count}
                    </td>
                    <td className={ui.td}>{row.sold_count}</td>
                    <td className={ui.td}>{row.not_sold_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ── Contribution ─────────────────────────────────────────────────────── */}
      {!loading && view === 'contribution' ? (
        <section className={ui.card}>
          <div className={ui.cardHeader}>
            <p className={ui.sectionTitle}>Contribution</p>
            <p className="text-xs font-semibold text-slate-500">
              Counted from recorded actions, so a carrier submission made on a teammate&rsquo;s quote is
              credited to whoever made it. Raw counts, offered as operational visibility rather than
              as a score.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>Employee</th>
                  <th className={ui.th}>Primary on</th>
                  <th className={ui.th}>Contributed to</th>
                  <th className={ui.th}>Carrier submissions</th>
                  <th className={ui.th}>Quotes recorded</th>
                  <th className={ui.th}>Prices sent</th>
                  <th className={ui.th}>Notes</th>
                  <th className={ui.th}>Info actions</th>
                  <th className={ui.th}>Results closed</th>
                  <th className={ui.th}>Total actions</th>
                  <th className={ui.th}>Last action</th>
                </tr>
              </thead>
              <tbody>
                {contribution.length === 0 ? (
                  <tr>
                    <td className={ui.td} colSpan={11}>
                      No recorded activity in this range.
                    </td>
                  </tr>
                ) : null}
                {contribution.map((row) => (
                  <tr key={row.profile_id}>
                    <td className={ui.td}>
                      <span className="font-black text-slate-900">{row.display_name}</span>
                    </td>
                    <td className={ui.td}>{row.primary_count}</td>
                    <td className={ui.td}>
                      <span className="font-black">{row.contributed_count}</span>
                    </td>
                    <td className={ui.td}>{row.carrier_submissions}</td>
                    <td className={ui.td}>{row.carrier_quotes_recorded}</td>
                    <td className={ui.td}>{row.price_sent_actions}</td>
                    <td className={ui.td}>{row.notes_added}</td>
                    <td className={ui.td}>{row.information_requests}</td>
                    <td className={ui.td}>{row.results_recorded}</td>
                    <td className={ui.td}>{row.total_actions}</td>
                    <td className={ui.td}>{formatRelative(row.last_action_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ── Timing ───────────────────────────────────────────────────────────── */}
      {!loading && view === 'timing' ? (
        <section className={ui.card}>
          <div className={ui.cardHeader}>
            <p className={ui.sectionTitle}>Pipeline timing</p>
            <p className="text-xs font-semibold text-slate-500">
              Averages between server-recorded timestamps. A stage that has not happened is excluded
              rather than counted as zero.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>Line</th>
                  <th className={ui.th}>Quotes</th>
                  <th className={ui.th}>Submitted → claimed</th>
                  <th className={ui.th}>Claimed → ready</th>
                  <th className={ui.th}>Ready → 1st submission</th>
                  <th className={ui.th}>1st submission → 1st quote</th>
                  <th className={ui.th}>1st quote → price sent</th>
                  <th className={ui.th}>Price sent → decision</th>
                  <th className={ui.th}>Intake → decision</th>
                </tr>
              </thead>
              <tbody>
                {timing.length === 0 ? (
                  <tr>
                    <td className={ui.td} colSpan={9}>
                      No quotes in this range yet.
                    </td>
                  </tr>
                ) : null}
                {timing.map((row) => (
                  <tr key={row.line_of_business}>
                    <td className={ui.td}>
                      <span className="font-black text-slate-900">{lineLabel(row.line_of_business)}</span>
                    </td>
                    <td className={ui.td}>{row.measured_count}</td>
                    <td className={ui.td}>{hours(row.avg_submitted_to_claimed_hours)}</td>
                    <td className={ui.td}>{hours(row.avg_claimed_to_ready_hours)}</td>
                    <td className={ui.td}>{hours(row.avg_ready_to_first_submission_hours)}</td>
                    <td className={ui.td}>{hours(row.avg_first_submission_to_first_quote_hours)}</td>
                    <td className={ui.td}>{hours(row.avg_first_quote_to_price_sent_hours)}</td>
                    <td className={ui.td}>{hours(row.avg_price_sent_to_decision_hours)}</td>
                    <td className={ui.td}>{num(row.avg_intake_to_decision_days, ' days')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ── Carrier performance ──────────────────────────────────────────────── */}
      {!loading && view === 'carriers' ? (
        <section className={ui.card}>
          <div className={ui.cardHeader}>
            <p className={ui.sectionTitle}>Carrier performance</p>
            <p className="text-xs font-semibold text-slate-500">
              A rate is shown only where its denominator exists — a carrier we have never submitted to
              has no quote rate, which is not the same as a rate of zero.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>Carrier</th>
                  <th className={ui.th}>Submissions</th>
                  <th className={ui.th}>Quotes</th>
                  <th className={ui.th}>Quote rate</th>
                  <th className={ui.th}>Avg response</th>
                  <th className={ui.th}>Declines</th>
                  <th className={ui.th}>More info</th>
                  <th className={ui.th}>Waiting</th>
                  <th className={ui.th}>Bound</th>
                  <th className={ui.th}>Bind rate</th>
                  <th className={ui.th}>Avg quoted</th>
                  <th className={ui.th}>Avg sold</th>
                </tr>
              </thead>
              <tbody>
                {carriers.length === 0 ? (
                  <tr>
                    <td className={ui.td} colSpan={12}>
                      No carrier markets in this range yet.
                    </td>
                  </tr>
                ) : null}
                {carriers.map((row) => (
                  <tr key={row.carrier_id}>
                    <td className={ui.td}>
                      <span className="font-black text-slate-900">{row.carrier_name}</span>
                    </td>
                    <td className={ui.td}>{row.submissions}</td>
                    <td className={ui.td}>{row.quotes_received}</td>
                    <td className={ui.td}>{num(row.quote_rate, '%')}</td>
                    <td className={ui.td}>{hours(row.avg_response_hours)}</td>
                    <td className={ui.td}>{row.declines}</td>
                    <td className={ui.td}>{row.more_info_requests}</td>
                    <td className={ui.td}>{row.still_waiting}</td>
                    <td className={ui.td}>{row.bound_count}</td>
                    <td className={ui.td}>{num(row.bind_rate, '%')}</td>
                    <td className={ui.td}>{formatMoney(row.avg_quoted_premium)}</td>
                    <td className={ui.td}>{formatMoney(row.avg_sold_premium)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ── Lost business ────────────────────────────────────────────────────── */}
      {!loading && view === 'lost' ? (
        <div className="space-y-5">
          <section className={`${ui.card} ${ui.cardPad}`}>
            <p className={ui.sectionTitle}>Why we lost it</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.entries(
                lost.reduce<Record<string, number>>((acc, row) => {
                  acc[row.lost_reason] = (acc[row.lost_reason] ?? 0) + 1;
                  return acc;
                }, {}),
              )
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => (
                  <span key={reason} className={`${ui.badge} ${ui.badgeTone.neutral}`}>
                    {lostReasonLabel(reason)} · {count}
                  </span>
                ))}
              {lost.length === 0 ? (
                <p className="text-sm font-semibold text-slate-500">
                  Nothing recorded as not sold in this range.
                </p>
              ) : null}
            </div>
          </section>

          {lost.length > 0 ? (
            <section className={ui.card}>
              <div className="overflow-x-auto">
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th className={ui.th}>Quote</th>
                      <th className={ui.th}>Reason</th>
                      <th className={ui.th}>Assigned</th>
                      <th className={ui.th}>Recorded by</th>
                      <th className={ui.th}>Options offered</th>
                      <th className={ui.th}>Best quote</th>
                      <th className={ui.th}>Days to decision</th>
                      <th className={ui.th}>Closed</th>
                      <th className={ui.th}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lost.map((row) => (
                      <tr key={row.opportunity_id} className={ui.trHover}>
                        <td className={ui.td}>
                          <span className="font-black text-slate-900">{row.display_name}</span>
                          <p className="mt-0.5 text-xs font-bold text-slate-400">
                            {row.reference} · {lineLabel(row.line_of_business)}
                          </p>
                        </td>
                        <td className={ui.td}>
                          {lostReasonLabel(row.lost_reason)}
                          {row.lost_reason_note ? (
                            <p className="mt-0.5 text-xs font-semibold text-slate-500">
                              {row.lost_reason_note}
                            </p>
                          ) : null}
                        </td>
                        <td className={ui.td}>{row.assignee_name ?? '—'}</td>
                        <td className={ui.td}>{row.recorded_by_name ?? '—'}</td>
                        <td className={ui.td}>{row.carriers_offered ?? 'None quoted'}</td>
                        <td className={ui.td}>{formatMoney(row.best_premium)}</td>
                        <td className={ui.td}>{num(row.days_to_decision)}</td>
                        <td className={ui.td}>{formatRelative(row.finalized_at)}</td>
                        <td className={ui.td}>
                          <button
                            type="button"
                            className={ui.btnSecondary}
                            onClick={() => onOpen(row.opportunity_id)}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

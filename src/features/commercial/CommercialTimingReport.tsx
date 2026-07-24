'use client';

import {
  AlertCircle,
  Clock,
  RefreshCw,
  Timer,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';

interface CommercialTimingReportProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
}

interface QuoteMetric {
  id: string;
  business_name: string;
  assigned_to: string;
  agent_name: string;
  agent_initials: string;
  outcome: 'sold' | 'not_sold';
  coverage_type: string | null;
  sold_premium: number | null;
  quote_speed_hours: number | null;
  decision_time_hours: number | null;
  cycle_time_hours: number | null;
  entered_quoting_at: string | null;
  left_quoting_at: string | null;
  reached_outcome_at: string | null;
}

interface Summary {
  avgQuoteSpeed: number;
  avgDecisionTime: number;
  avgCycleTime: number;
  total: number;
  withTimingData: number;
  soldCount: number;
  notSoldCount: number;
}

function formatHours(hours: number | null): string {
  if (hours == null || hours < 0) return '—';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 24) return `${Math.round(hours)} hrs`;
  const days = hours / 24;
  if (days < 7) return `${days.toFixed(1)} days`;
  const weeks = days / 7;
  return `${weeks.toFixed(1)} weeks`;
}

function formatHoursShort(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${days.toFixed(1)}d`;
  return `${(days / 7).toFixed(1)}w`;
}

export default function CommercialTimingReport({ initialProfile, embedded = false }: CommercialTimingReportProps) {
  const [metrics, setMetrics] = useState<QuoteMetric[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState('');
  const [filterOutcome, setFilterOutcome] = useState<'' | 'sold' | 'not_sold'>('');

  const isManager = initialProfile.role === 'manager' || initialProfile.role === 'super_admin';

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/commercial-quotes/reports/timing');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load timing data.');
      }
      const body = await res.json();
      setMetrics(body.metrics ?? []);
      setSummary(body.summary ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  // Agent list for filter
  const agents = useMemo(() => {
    const map = new Map<string, { name: string; initials: string }>();
    for (const m of metrics) {
      if (!map.has(m.assigned_to)) map.set(m.assigned_to, { name: m.agent_name, initials: m.agent_initials });
    }
    return Array.from(map.entries()).map(([id, info]) => ({ id, ...info })).sort((a, b) => a.name.localeCompare(b.name));
  }, [metrics]);

  // Filtered metrics
  const filtered = useMemo(() => {
    let result = metrics;
    if (filterAgent) result = result.filter((m) => m.assigned_to === filterAgent);
    if (filterOutcome) result = result.filter((m) => m.outcome === filterOutcome);
    return result;
  }, [metrics, filterAgent, filterOutcome]);

  // Per-agent summary
  const agentSummaries = useMemo(() => {
    const map = new Map<string, { name: string; initials: string; quoteSpeeds: number[]; decisionTimes: number[]; cycleTimes: number[]; sold: number; notSold: number }>();
    for (const m of filtered) {
      if (!map.has(m.assigned_to)) {
        map.set(m.assigned_to, { name: m.agent_name, initials: m.agent_initials, quoteSpeeds: [], decisionTimes: [], cycleTimes: [], sold: 0, notSold: 0 });
      }
      const entry = map.get(m.assigned_to)!;
      if (m.quote_speed_hours != null && m.quote_speed_hours >= 0) entry.quoteSpeeds.push(m.quote_speed_hours);
      if (m.decision_time_hours != null && m.decision_time_hours >= 0) entry.decisionTimes.push(m.decision_time_hours);
      if (m.cycle_time_hours != null && m.cycle_time_hours >= 0) entry.cycleTimes.push(m.cycle_time_hours);
      if (m.outcome === 'sold') entry.sold++;
      else entry.notSold++;
    }
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    return Array.from(map.values()).map((e) => ({
      ...e,
      avgQuoteSpeed: avg(e.quoteSpeeds),
      avgDecisionTime: avg(e.decisionTimes),
      avgCycleTime: avg(e.cycleTimes),
      total: e.sold + e.notSold,
    })).sort((a, b) => a.avgCycleTime - b.avgCycleTime);
  }, [filtered]);

  if (!isManager) {
    return <div className={ui.empty}>This report is only available to managers.</div>;
  }

  return (
    <section className={embedded ? 'text-slate-950' : ''}>
      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-[#526b9a]">
            Operational Analytics
          </p>
          <h2 className={ui.pageTitle}>Timing Report</h2>
          <p className={ui.pageSubtitle}>
            Measures how fast your team quotes and how long customers take to decide.
            Excludes Quote Intake stage — timing starts from Quoting.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void fetchData()} className={ui.btnSecondary}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className={ui.error + ' mb-4'}>
          <AlertCircle className="mr-2 inline h-4 w-4" />{error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
          <span className="ml-2 text-sm font-semibold text-slate-500">Calculating timing metrics...</span>
        </div>
      ) : !summary ? (
        <div className={ui.empty}>No completed quotes with timing data yet.</div>
      ) : (
        <div className="space-y-6">
          {/* ═══ SUMMARY CARDS ═══ */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className={ui.stat}>
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-600" />
                <p className={ui.statLabel}>Avg Quote Speed</p>
              </div>
              <p className={ui.statValue + ' text-2xl'}>{formatHours(summary.avgQuoteSpeed)}</p>
              <p className="mt-0.5 text-[10px] font-semibold text-slate-400">Time your team takes to produce a quote</p>
            </div>
            <div className={ui.stat}>
              <div className="flex items-center gap-2">
                <Timer className="h-4 w-4 text-violet-600" />
                <p className={ui.statLabel}>Avg Customer Decision</p>
              </div>
              <p className={ui.statValue + ' text-2xl'}>{formatHours(summary.avgDecisionTime)}</p>
              <p className="mt-0.5 text-[10px] font-semibold text-slate-400">Time customer takes after receiving quote</p>
            </div>
            <div className={ui.stat}>
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-[#223f7a]" />
                <p className={ui.statLabel}>Avg Total Cycle</p>
              </div>
              <p className={ui.statValue + ' text-2xl'}>{formatHours(summary.avgCycleTime)}</p>
              <p className="mt-0.5 text-[10px] font-semibold text-slate-400">End-to-end from quoting to outcome</p>
            </div>
            <div className={ui.stat}>
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-emerald-600" />
                <p className={ui.statLabel}>Completed Quotes</p>
              </div>
              <p className={ui.statValue + ' text-2xl'}>{summary.total}</p>
              <p className="mt-0.5 text-[10px] font-semibold text-slate-400">
                {summary.soldCount} sold · {summary.notSoldCount} not sold · {summary.withTimingData} with timing data
              </p>
            </div>
          </div>

          {/* ═══ FILTERS ═══ */}
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <select
              value={filterAgent}
              onChange={(e) => setFilterAgent(e.target.value)}
              className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-700 outline-none focus:border-[#7890bc]"
            >
              <option value="">All Agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <select
              value={filterOutcome}
              onChange={(e) => setFilterOutcome(e.target.value as '' | 'sold' | 'not_sold')}
              className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-700 outline-none focus:border-[#7890bc]"
            >
              <option value="">All Outcomes</option>
              <option value="sold">Sold</option>
              <option value="not_sold">Not Sold</option>
            </select>
            <span className="text-xs font-bold text-slate-400">
              {filtered.length} records
            </span>
          </div>

          {/* ═══ AGENT SPEED TABLE ═══ */}
          {agentSummaries.length > 0 && (
            <div className={ui.card}>
              <div className={ui.cardHeader}>
                <h3 className="text-sm font-black text-slate-800">
                  <Users className="inline h-4 w-4 mr-1.5 text-[#223f7a]" />
                  Agent Speed Comparison
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th className={ui.th}>Agent</th>
                      <th className={ui.th}>Quotes</th>
                      <th className={ui.th}>Avg Quote Speed</th>
                      <th className={ui.th}>Avg Customer Decision</th>
                      <th className={ui.th}>Avg Total Cycle</th>
                      <th className={ui.th}>Sold / Not Sold</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentSummaries.map((agent) => (
                      <tr key={agent.name} className={ui.trHover}>
                        <td className={ui.td}>
                          <div className="flex items-center gap-2">
                            <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#223f7a] text-[10px] font-black text-white">
                              {agent.initials}
                            </span>
                            <span className="text-xs font-bold text-slate-800">{agent.name}</span>
                          </div>
                        </td>
                        <td className={ui.td + ' text-xs font-bold text-slate-700'}>{agent.total}</td>
                        <td className={ui.td}>
                          <span className="text-xs font-black text-amber-700">
                            {formatHours(agent.avgQuoteSpeed)}
                          </span>
                        </td>
                        <td className={ui.td}>
                          <span className="text-xs font-black text-violet-700">
                            {formatHours(agent.avgDecisionTime)}
                          </span>
                        </td>
                        <td className={ui.td}>
                          <span className="text-xs font-black text-[#223f7a]">
                            {formatHours(agent.avgCycleTime)}
                          </span>
                        </td>
                        <td className={ui.td}>
                          <span className="text-xs font-bold text-emerald-700">{agent.sold}</span>
                          {' / '}
                          <span className="text-xs font-bold text-rose-600">{agent.notSold}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ═══ DETAILED TABLE ═══ */}
          <div className={ui.card}>
            <div className={ui.cardHeader}>
              <h3 className="text-sm font-black text-slate-800">
                <Clock className="inline h-4 w-4 mr-1.5 text-[#223f7a]" />
                Individual Quote Timing
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>Business</th>
                    <th className={ui.th}>Agent</th>
                    <th className={ui.th}>Outcome</th>
                    <th className={ui.th}>Quote Speed</th>
                    <th className={ui.th}>Customer Decision</th>
                    <th className={ui.th}>Total Cycle</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 100).map((m) => (
                    <tr key={m.id} className={ui.trHover}>
                      <td className={ui.td}>
                        <span className="text-xs font-bold text-slate-800">{m.business_name}</span>
                      </td>
                      <td className={ui.td}>
                        <span className="text-xs font-semibold text-slate-600">{m.agent_name}</span>
                      </td>
                      <td className={ui.td}>
                        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${m.outcome === 'sold' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                          {m.outcome === 'sold' ? 'Sold' : 'Not Sold'}
                        </span>
                      </td>
                      <td className={ui.td}>
                        <span className="text-xs font-bold text-amber-700">{formatHours(m.quote_speed_hours)}</span>
                      </td>
                      <td className={ui.td}>
                        <span className="text-xs font-bold text-violet-700">{formatHours(m.decision_time_hours)}</span>
                      </td>
                      <td className={ui.td}>
                        <span className="text-xs font-bold text-[#223f7a]">{formatHours(m.cycle_time_hours)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length > 100 && (
                <p className="p-3 text-center text-xs font-semibold text-slate-400">
                  Showing first 100 of {filtered.length} records.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

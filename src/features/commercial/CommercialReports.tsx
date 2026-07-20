'use client';

import {
  AlertCircle,
  BarChart3,
  Clock,
  DollarSign,
  Layers,
  PieChart,
  RefreshCw,
  Shield,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import type { BoardColumn, CommercialQuote } from './types';
import { BOARD_COLUMNS, COVERAGE_LABELS, RISK_STYLES } from './types';

interface CommercialReportsProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
}

interface ReportCard {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}

interface AgentMetric {
  name: string;
  initials: string;
  total: number;
  sold: number;
  notSold: number;
  conversionRate: number;
  avgDaysToSold: number;
  totalPremium: number;
}

interface ColumnDistribution {
  column: string;
  label: string;
  count: number;
  color: string;
  pct: number;
}

function daysBetween(start: string, end: string): number {
  return Math.max(0, Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 86400000));
}

export default function CommercialReports({ initialProfile, embedded = false }: CommercialReportsProps) {
  const [quotes, setQuotes] = useState<CommercialQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const isManager = initialProfile.role === 'manager';

  // ─── Fetch all quotes for reporting ──────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch everything including archive
      const [resAll, resArchive] = await Promise.all([
        fetch('/api/commercial-quotes'),
        fetch('/api/commercial-quotes?board_column=archive'),
      ]);
      if (!resAll.ok) throw new Error('Failed to load quotes.');

      const bodyAll = await resAll.json();
      let all = bodyAll.quotes as CommercialQuote[];

      if (resArchive.ok) {
        const bodyArchive = await resArchive.json();
        const archived = bodyArchive.quotes as CommercialQuote[];
        const ids = new Set(all.map((q) => q.id));
        for (const a of archived) {
          if (!ids.has(a.id)) all.push(a);
        }
      }
      setQuotes(all);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  // ─── Compute reports ─────────────────────────────────────────────────────────
  const reports = useMemo(() => {
    if (quotes.length === 0) return null;

    const now = new Date();
    const activeQuotes = quotes.filter((q) => !q.is_deleted && q.board_column !== 'archive');
    const soldQuotes = quotes.filter((q) => ['sold', 'commission_approved', 'commission_not_approved'].includes(q.board_column));
    const notSoldQuotes = quotes.filter((q) => q.board_column === 'not_sold');
    const totalCompleted = soldQuotes.length + notSoldQuotes.length;
    const conversionRate = totalCompleted > 0 ? Math.round((soldQuotes.length / totalCompleted) * 100) : 0;

    // 1. Total Pipeline Value
    const totalPremium = soldQuotes.reduce((sum, q) => sum + (q.sold_premium ?? 0), 0);

    // 2. Average days from intake to sold
    const soldWithDays = soldQuotes.map((q) => daysBetween(q.board_entered_at, q.column_entered_at));
    const avgDaysToSold = soldWithDays.length > 0 ? Math.round(soldWithDays.reduce((a, b) => a + b, 0) / soldWithDays.length) : 0;

    // 3. Commission stats
    const commissionsApproved = quotes.filter((q) => q.commission_status === 'approved').length;
    const commissionsDenied = quotes.filter((q) => q.commission_status === 'denied').length;
    const commissionsPending = soldQuotes.filter((q) => !q.commission_status || q.commission_status === 'pending').length;

    // 4. Risk distribution
    const riskCounts = { low: 0, medium: 0, high: 0 };
    for (const q of activeQuotes) riskCounts[q.risk_level]++;

    // 5. Coverage type distribution
    const coverageCounts: Record<string, number> = {};
    for (const q of quotes) {
      const cov = q.coverage_type ?? 'unset';
      coverageCounts[cov] = (coverageCounts[cov] ?? 0) + 1;
    }

    // 6. Column distribution (pipeline stages)
    const columnDist: ColumnDistribution[] = BOARD_COLUMNS.filter((c) => c.id !== 'archive').map((col) => {
      const count = activeQuotes.filter((q) => q.board_column === col.id).length;
      return {
        column: col.id,
        label: col.label,
        count,
        color: col.color,
        pct: activeQuotes.length > 0 ? Math.round((count / activeQuotes.length) * 100) : 0,
      };
    });

    // 7. Agent performance (manager view)
    const agentMap = new Map<string, AgentMetric>();
    for (const q of quotes) {
      const name = q.profiles?.display_name ?? 'Unknown';
      const initials = q.profiles?.initials ?? '?';
      if (!agentMap.has(q.assigned_to)) {
        agentMap.set(q.assigned_to, { name, initials, total: 0, sold: 0, notSold: 0, conversionRate: 0, avgDaysToSold: 0, totalPremium: 0 });
      }
      const m = agentMap.get(q.assigned_to)!;
      m.total++;
      if (['sold', 'commission_approved', 'commission_not_approved'].includes(q.board_column)) {
        m.sold++;
        m.totalPremium += q.sold_premium ?? 0;
      }
      if (q.board_column === 'not_sold') m.notSold++;
    }
    const agentMetrics = Array.from(agentMap.values()).map((m) => ({
      ...m,
      conversionRate: (m.sold + m.notSold) > 0 ? Math.round((m.sold / (m.sold + m.notSold)) * 100) : 0,
    })).sort((a, b) => b.sold - a.sold);

    // 8. Stale quotes (in same column > 14 days)
    const staleCount = activeQuotes.filter((q) => daysBetween(q.column_entered_at, now.toISOString()) > 14).length;

    // 9. This month's new quotes
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const newThisMonth = quotes.filter((q) => q.created_at >= thisMonth).length;

    // 10. This month's sold
    const soldThisMonth = soldQuotes.filter((q) => q.column_entered_at >= thisMonth).length;

    // Summary cards
    const summaryCards: ReportCard[] = [
      { title: 'Active Pipeline', value: activeQuotes.length, subtitle: 'cards in progress', icon: Layers, color: 'text-[#223f7a]' },
      { title: 'Conversion Rate', value: `${conversionRate}%`, subtitle: `${soldQuotes.length} sold / ${totalCompleted} completed`, icon: TrendingUp, color: 'text-emerald-600' },
      { title: 'Total Premium (Sold)', value: `$${totalPremium.toLocaleString()}`, subtitle: `${soldQuotes.length} policies`, icon: DollarSign, color: 'text-green-700' },
      { title: 'Avg Days to Sold', value: avgDaysToSold, subtitle: 'from intake to sold', icon: Clock, color: 'text-violet-600' },
      { title: 'New This Month', value: newThisMonth, subtitle: 'quotes created', icon: BarChart3, color: 'text-blue-600' },
      { title: 'Sold This Month', value: soldThisMonth, subtitle: 'closed this month', icon: TrendingUp, color: 'text-emerald-600' },
      { title: 'Commissions Pending', value: commissionsPending, subtitle: `${commissionsApproved} approved, ${commissionsDenied} denied`, icon: Shield, color: 'text-amber-600' },
      { title: 'Stale Quotes', value: staleCount, subtitle: '> 14 days same column', icon: AlertCircle, color: staleCount > 5 ? 'text-rose-600' : 'text-slate-500' },
      { title: 'High Risk Active', value: riskCounts.high, subtitle: `${riskCounts.medium} medium, ${riskCounts.low} low`, icon: AlertCircle, color: riskCounts.high > 3 ? 'text-rose-600' : 'text-amber-600' },
      { title: 'Team Size', value: agentMetrics.length, subtitle: 'active agents', icon: Users, color: 'text-indigo-600' },
    ];

    return { summaryCards, columnDist, agentMetrics, coverageCounts, riskCounts };
  }, [quotes]);

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <section className={embedded ? 'text-slate-950' : ''}>
      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-[#526b9a]">
            Commercial Analytics
          </p>
          <h2 className={ui.pageTitle}>Reports Dashboard</h2>
          <p className={ui.pageSubtitle}>
            Key performance indicators and pipeline analytics for commercial policies.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {lastUpdated && (
            <p className="text-xs font-bold text-slate-400">
              Based on {quotes.length} records
            </p>
          )}
          <button type="button" onClick={() => void fetchAll()} className={ui.btnSecondary}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className={ui.error + ' mb-4'}>
          <AlertCircle className="mr-2 inline h-4 w-4" />{error}
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
          <span className="ml-2 text-sm font-semibold text-slate-500">Calculating reports...</span>
        </div>
      ) : !reports ? (
        <div className={ui.empty}>No data available for reports.</div>
      ) : (
        <div className="space-y-6">
          {/* ═══ TOP 10 KPI CARDS ═══ */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {reports.summaryCards.map((card) => {
              const Icon = card.icon;
              return (
                <div key={card.title} className={ui.stat}>
                  <div className="flex items-center gap-2">
                    <Icon className={`h-4 w-4 ${card.color}`} />
                    <p className={ui.statLabel}>{card.title}</p>
                  </div>
                  <p className={ui.statValue + ' text-2xl'}>{card.value}</p>
                  {card.subtitle && (
                    <p className="mt-0.5 text-[10px] font-semibold text-slate-400">{card.subtitle}</p>
                  )}
                </div>
              );
            })}
          </div>

          {/* ═══ PIPELINE DISTRIBUTION ═══ */}
          <div className={ui.card + ' ' + ui.cardPad}>
            <h3 className="text-sm font-black text-slate-800 mb-4">
              <PieChart className="inline h-4 w-4 mr-1.5 text-[#223f7a]" />
              Pipeline Distribution
            </h3>
            <div className="space-y-2">
              {reports.columnDist.filter((c) => c.count > 0).map((col) => (
                <div key={col.column} className="flex items-center gap-3">
                  <span className={`h-3 w-3 rounded-full ${col.color}`} />
                  <span className="w-44 text-xs font-bold text-slate-700">{col.label}</span>
                  <div className="flex-1 h-5 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${col.color} transition-all`}
                      style={{ width: `${Math.max(col.pct, 2)}%` }}
                    />
                  </div>
                  <span className="w-10 text-right text-xs font-black text-slate-600">{col.count}</span>
                  <span className="w-10 text-right text-[10px] font-semibold text-slate-400">{col.pct}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* ═══ AGENT PERFORMANCE TABLE ═══ */}
          {isManager && reports.agentMetrics.length > 0 && (
            <div className={ui.card}>
              <div className={ui.cardHeader}>
                <h3 className="text-sm font-black text-slate-800">
                  <Users className="inline h-4 w-4 mr-1.5 text-[#223f7a]" />
                  Agent Performance
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th className={ui.th}>Agent</th>
                      <th className={ui.th}>Total</th>
                      <th className={ui.th}>Sold</th>
                      <th className={ui.th}>Not Sold</th>
                      <th className={ui.th}>Conv. Rate</th>
                      <th className={ui.th}>Premium</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.agentMetrics.map((agent) => (
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
                        <td className={ui.td + ' text-xs font-bold text-emerald-700'}>{agent.sold}</td>
                        <td className={ui.td + ' text-xs font-bold text-rose-600'}>{agent.notSold}</td>
                        <td className={ui.td}>
                          <span className={`text-xs font-black ${agent.conversionRate >= 50 ? 'text-emerald-700' : agent.conversionRate >= 25 ? 'text-amber-700' : 'text-rose-600'}`}>
                            {agent.conversionRate}%
                          </span>
                        </td>
                        <td className={ui.td + ' text-xs font-black text-green-700'}>
                          ${agent.totalPremium.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ═══ COVERAGE TYPE BREAKDOWN ═══ */}
          <div className={ui.card + ' ' + ui.cardPad}>
            <h3 className="text-sm font-black text-slate-800 mb-4">
              <BarChart3 className="inline h-4 w-4 mr-1.5 text-[#223f7a]" />
              Coverage Type Breakdown
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Object.entries(reports.coverageCounts)
                .sort(([, a], [, b]) => b - a)
                .map(([key, count]) => (
                  <div key={key} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-center">
                    <p className="text-lg font-black text-slate-900">{count}</p>
                    <p className="text-[10px] font-bold text-slate-500">
                      {key === 'unset' ? 'Not Set' : (COVERAGE_LABELS[key as keyof typeof COVERAGE_LABELS] ?? key)}
                    </p>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

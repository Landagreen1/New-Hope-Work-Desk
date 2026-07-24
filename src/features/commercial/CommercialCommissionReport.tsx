'use client';

import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Clock,
  DollarSign,
  PieChart,
  RefreshCw,
  Shield,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import type { CommercialQuote } from './types';
import { COVERAGE_LABELS } from './types';

interface CommercialCommissionReportProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function daysBetween(start: string, end: string): number {
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000));
}

export default function CommercialCommissionReport({ initialProfile, embedded = false }: CommercialCommissionReportProps) {
  const [quotes, setQuotes] = useState<CommercialQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState('');
  const [filterStatus, setFilterStatus] = useState<'' | 'approved' | 'denied' | 'pending'>('');

  const isManager = initialProfile.role === 'manager' || initialProfile.role === 'super_admin';

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch quotes in commission-related columns + sold (pending)
      const [resSold, resApproved, resDenied] = await Promise.all([
        fetch('/api/commercial-quotes?board_column=sold'),
        fetch('/api/commercial-quotes?board_column=commission_approved'),
        fetch('/api/commercial-quotes?board_column=commission_not_approved'),
      ]);

      const all: CommercialQuote[] = [];
      for (const res of [resSold, resApproved, resDenied]) {
        if (res.ok) {
          const body = await res.json();
          all.push(...(body.quotes ?? []));
        }
      }
      setQuotes(all);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  // Agents list
  const agents = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of quotes) {
      if (!map.has(q.assigned_to)) map.set(q.assigned_to, q.profiles?.display_name ?? 'Unknown');
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [quotes]);

  // Categorize quotes
  const categorized = useMemo(() => {
    let filtered = quotes;
    if (filterAgent) filtered = filtered.filter((q) => q.assigned_to === filterAgent);

    const pending = filtered.filter((q) => q.board_column === 'sold' && (!q.commission_status || q.commission_status === 'pending'));
    const approved = filtered.filter((q) => q.commission_status === 'approved' || q.board_column === 'commission_approved');
    const denied = filtered.filter((q) => q.commission_status === 'denied' || q.board_column === 'commission_not_approved');

    return { pending, approved, denied, all: filtered };
  }, [quotes, filterAgent]);

  // Filter by status
  const displayQuotes = useMemo(() => {
    if (filterStatus === 'pending') return categorized.pending;
    if (filterStatus === 'approved') return categorized.approved;
    if (filterStatus === 'denied') return categorized.denied;
    return categorized.all;
  }, [categorized, filterStatus]);

  // Summary stats
  const stats = useMemo(() => {
    const total = categorized.all.length;
    const approvedCount = categorized.approved.length;
    const deniedCount = categorized.denied.length;
    const pendingCount = categorized.pending.length;
    const decided = approvedCount + deniedCount;
    const approvalRate = decided > 0 ? Math.round((approvedCount / decided) * 100) : 0;

    const totalPremiumApproved = categorized.approved.reduce((sum, q) => sum + (q.sold_premium ?? 0), 0);
    const totalPremiumDenied = categorized.denied.reduce((sum, q) => sum + (q.sold_premium ?? 0), 0);
    const totalPremiumPending = categorized.pending.reduce((sum, q) => sum + (q.sold_premium ?? 0), 0);

    // Time-to-decision: time from sold_at (or column_entered_at for sold) to commission_decision_at
    const decisionTimes: number[] = [];
    for (const q of [...categorized.approved, ...categorized.denied]) {
      if (q.commission_decision_at) {
        const soldDate = q.sold_at ?? q.column_entered_at;
        const days = daysBetween(soldDate, q.commission_decision_at);
        decisionTimes.push(days);
      }
    }
    const avgDecisionDays = decisionTimes.length > 0
      ? Math.round(decisionTimes.reduce((a, b) => a + b, 0) / decisionTimes.length)
      : 0;

    // Denial reasons breakdown
    const denialReasons: Record<string, number> = {};
    for (const q of categorized.denied) {
      const reason = q.commission_denial_reason || 'No reason given';
      denialReasons[reason] = (denialReasons[reason] ?? 0) + 1;
    }

    // Per-agent commission stats
    const agentStats = new Map<string, { name: string; initials: string; approved: number; denied: number; pending: number; premium: number }>();
    for (const q of categorized.all) {
      const name = q.profiles?.display_name ?? 'Unknown';
      const initials = q.profiles?.initials ?? '?';
      if (!agentStats.has(q.assigned_to)) {
        agentStats.set(q.assigned_to, { name, initials, approved: 0, denied: 0, pending: 0, premium: 0 });
      }
      const entry = agentStats.get(q.assigned_to)!;
      if (categorized.approved.includes(q)) { entry.approved++; entry.premium += q.sold_premium ?? 0; }
      else if (categorized.denied.includes(q)) entry.denied++;
      else if (categorized.pending.includes(q)) entry.pending++;
    }

    return {
      total, approvedCount, deniedCount, pendingCount, approvalRate,
      totalPremiumApproved, totalPremiumDenied, totalPremiumPending,
      avgDecisionDays, denialReasons,
      agentStats: Array.from(agentStats.values()).sort((a, b) => b.approved - a.approved),
    };
  }, [categorized]);

  if (!isManager) {
    return <div className={ui.empty}>This report is only available to managers.</div>;
  }

  return (
    <section className={embedded ? 'text-slate-950' : ''}>
      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-[#526b9a]">
            Commission Analytics
          </p>
          <h2 className={ui.pageTitle}>Commission Report</h2>
          <p className={ui.pageSubtitle}>
            Approval rates, denial reasons, and premium breakdowns for commission decisions.
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
          <span className="ml-2 text-sm font-semibold text-slate-500">Loading commission data...</span>
        </div>
      ) : (
        <div className="space-y-6">
          {/* ═══ SUMMARY CARDS ═══ */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
            <div className={ui.stat}>
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-[#223f7a]" />
                <p className={ui.statLabel}>Approval Rate</p>
              </div>
              <p className={ui.statValue + ' text-2xl'}>{stats.approvalRate}%</p>
              <p className="mt-0.5 text-[10px] font-semibold text-slate-400">
                {stats.approvedCount} approved / {stats.approvedCount + stats.deniedCount} decided
              </p>
            </div>
            <div className={ui.stat}>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <p className={ui.statLabel}>Approved Premium</p>
              </div>
              <p className={ui.statValue + ' text-2xl text-emerald-700'}>
                ${stats.totalPremiumApproved.toLocaleString()}
              </p>
              <p className="mt-0.5 text-[10px] font-semibold text-slate-400">{stats.approvedCount} policies</p>
            </div>
            <div className={ui.stat}>
              <div className="flex items-center gap-2">
                <Ban className="h-4 w-4 text-rose-600" />
                <p className={ui.statLabel}>Denied</p>
              </div>
              <p className={ui.statValue + ' text-2xl text-rose-700'}>{stats.deniedCount}</p>
              <p className="mt-0.5 text-[10px] font-semibold text-slate-400">
                ${stats.totalPremiumDenied.toLocaleString()} in premium
              </p>
            </div>
            <div className={ui.stat}>
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-amber-600" />
                <p className={ui.statLabel}>Pending Review</p>
              </div>
              <p className={ui.statValue + ' text-2xl text-amber-700'}>{stats.pendingCount}</p>
              <p className="mt-0.5 text-[10px] font-semibold text-slate-400">
                ${stats.totalPremiumPending.toLocaleString()} in premium
              </p>
            </div>
            <div className={ui.stat}>
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-violet-600" />
                <p className={ui.statLabel}>Avg Decision Time</p>
              </div>
              <p className={ui.statValue + ' text-2xl'}>{stats.avgDecisionDays} days</p>
              <p className="mt-0.5 text-[10px] font-semibold text-slate-400">from sold to commission decision</p>
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
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as '' | 'approved' | 'denied' | 'pending')}
              className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-700 outline-none focus:border-[#7890bc]"
            >
              <option value="">All Statuses</option>
              <option value="approved">Approved</option>
              <option value="denied">Denied</option>
              <option value="pending">Pending</option>
            </select>
            <span className="text-xs font-bold text-slate-400">
              {displayQuotes.length} records
            </span>
          </div>

          {/* ═══ AGENT COMMISSION TABLE ═══ */}
          {stats.agentStats.length > 0 && (
            <div className={ui.card}>
              <div className={ui.cardHeader}>
                <h3 className="text-sm font-black text-slate-800">
                  <Users className="inline h-4 w-4 mr-1.5 text-[#223f7a]" />
                  Agent Commission Breakdown
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th className={ui.th}>Agent</th>
                      <th className={ui.th}>Approved</th>
                      <th className={ui.th}>Denied</th>
                      <th className={ui.th}>Pending</th>
                      <th className={ui.th}>Approval Rate</th>
                      <th className={ui.th}>Approved Premium</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.agentStats.map((agent) => {
                      const decided = agent.approved + agent.denied;
                      const rate = decided > 0 ? Math.round((agent.approved / decided) * 100) : 0;
                      return (
                        <tr key={agent.name} className={ui.trHover}>
                          <td className={ui.td}>
                            <div className="flex items-center gap-2">
                              <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#223f7a] text-[10px] font-black text-white">
                                {agent.initials}
                              </span>
                              <span className="text-xs font-bold text-slate-800">{agent.name}</span>
                            </div>
                          </td>
                          <td className={ui.td + ' text-xs font-bold text-emerald-700'}>{agent.approved}</td>
                          <td className={ui.td + ' text-xs font-bold text-rose-600'}>{agent.denied}</td>
                          <td className={ui.td + ' text-xs font-bold text-amber-700'}>{agent.pending}</td>
                          <td className={ui.td}>
                            <span className={`text-xs font-black ${rate >= 70 ? 'text-emerald-700' : rate >= 40 ? 'text-amber-700' : 'text-rose-600'}`}>
                              {decided > 0 ? `${rate}%` : '—'}
                            </span>
                          </td>
                          <td className={ui.td + ' text-xs font-black text-green-700'}>
                            ${agent.premium.toLocaleString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ═══ DENIAL REASONS ═══ */}
          {Object.keys(stats.denialReasons).length > 0 && (
            <div className={ui.card + ' ' + ui.cardPad}>
              <h3 className="text-sm font-black text-slate-800 mb-4">
                <PieChart className="inline h-4 w-4 mr-1.5 text-rose-600" />
                Denial Reasons
              </h3>
              <div className="space-y-2">
                {Object.entries(stats.denialReasons)
                  .sort(([, a], [, b]) => b - a)
                  .map(([reason, count]) => (
                    <div key={reason} className="flex items-center gap-3">
                      <div className="flex-1">
                        <p className="text-xs font-bold text-slate-700">{reason}</p>
                      </div>
                      <span className="rounded-lg bg-rose-100 px-2 py-0.5 text-[10px] font-black text-rose-700">
                        {count}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* ═══ DETAILED TABLE ═══ */}
          <div className={ui.card}>
            <div className={ui.cardHeader}>
              <h3 className="text-sm font-black text-slate-800">
                <DollarSign className="inline h-4 w-4 mr-1.5 text-[#223f7a]" />
                Commission Details
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>Business</th>
                    <th className={ui.th}>Agent</th>
                    <th className={ui.th}>Premium</th>
                    <th className={ui.th}>Coverage</th>
                    <th className={ui.th}>Status</th>
                    <th className={ui.th}>Decision Date</th>
                    <th className={ui.th}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {displayQuotes.map((q) => {
                    const status = q.commission_status ?? (q.board_column === 'commission_approved' ? 'approved' : q.board_column === 'commission_not_approved' ? 'denied' : 'pending');
                    return (
                      <tr key={q.id} className={ui.trHover}>
                        <td className={ui.td}>
                          <span className="text-xs font-bold text-slate-800">{q.business_name}</span>
                        </td>
                        <td className={ui.td}>
                          <span className="text-xs font-semibold text-slate-600">
                            {q.profiles?.display_name ?? '—'}
                          </span>
                        </td>
                        <td className={ui.td}>
                          <span className="text-xs font-black text-green-700">
                            {q.sold_premium ? `$${q.sold_premium.toLocaleString()}` : '—'}
                          </span>
                        </td>
                        <td className={ui.td}>
                          <span className="text-xs font-semibold text-slate-600">
                            {q.coverage_type ? COVERAGE_LABELS[q.coverage_type] : '—'}
                          </span>
                        </td>
                        <td className={ui.td}>
                          <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                            status === 'approved' ? 'bg-emerald-100 text-emerald-800' :
                            status === 'denied' ? 'bg-rose-100 text-rose-800' :
                            'bg-amber-100 text-amber-800'
                          }`}>
                            {status === 'approved' ? 'Approved' : status === 'denied' ? 'Denied' : 'Pending'}
                          </span>
                        </td>
                        <td className={ui.td}>
                          <span className="text-xs font-semibold text-slate-500">
                            {q.commission_decision_at ? formatDate(q.commission_decision_at) : '—'}
                          </span>
                        </td>
                        <td className={ui.td}>
                          <span className="text-xs font-medium text-slate-500 max-w-[200px] truncate block">
                            {q.commission_denial_reason || (q.commission_notes ? q.commission_notes.substring(0, 50) : '—')}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

'use client';

import { AlertCircle, BarChart3, Clock, RefreshCw, TrendingUp, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';

interface AttendanceReportsProps {
  initialProfile: ProfileLite;
}

interface EmployeeReport {
  profile_id: string;
  display_name: string;
  initials: string;
  total_entries: number;
  late_count: number;
  late_minutes_total: number;
  avg_late_minutes: number;
  avg_break_minutes: number;
  break_minutes_total: number;
  scheduled_hours: number;
  actual_hours: number;
  overtime_hours: number;
  time_adherence_pct: number;
}

interface ReportSummary {
  total_employees: number;
  total_late_instances: number;
  avg_time_adherence: number;
  avg_break_minutes: number;
}

type SortField = 'late_count' | 'avg_break_minutes' | 'time_adherence_pct' | 'display_name';
type ViewMode = 'overview' | 'late' | 'breaks' | 'adherence';

function getDefaultPeriod(): { start: string; end: string } {
  const today = new Date();
  const end = new Date(today);
  const start = new Date(today);
  start.setDate(start.getDate() - 13); // 14-day period
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
  };
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

export default function AttendanceReports({ initialProfile }: AttendanceReportsProps) {
  const defaultPeriod = getDefaultPeriod();
  const [periodStart, setPeriodStart] = useState(defaultPeriod.start);
  const [periodEnd, setPeriodEnd] = useState(defaultPeriod.end);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<EmployeeReport[]>([]);
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [sortField, setSortField] = useState<SortField>('late_count');
  const [sortAsc, setSortAsc] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('overview');

  const fetchReports = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/time-clock/reports?period_start=${periodStart}&period_end=${periodEnd}`);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Failed to load reports.'); }
      const body = await res.json();
      setEmployees(body.employees ?? []);
      setSummary(body.summary ?? null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Load failed.'); }
    finally { setLoading(false); }
  }, [periodStart, periodEnd]);

  useEffect(() => { void fetchReports(); }, [fetchReports]);

  const sortedEmployees = [...employees].sort((a, b) => {
    const dir = sortAsc ? 1 : -1;
    if (sortField === 'display_name') return dir * a.display_name.localeCompare(b.display_name);
    return dir * ((a[sortField] ?? 0) - (b[sortField] ?? 0));
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) { setSortAsc(!sortAsc); }
    else { setSortField(field); setSortAsc(false); }
  };

  const adherenceColor = (pct: number) => {
    if (pct >= 95) return 'text-emerald-700 bg-emerald-50';
    if (pct >= 85) return 'text-amber-700 bg-amber-50';
    return 'text-rose-700 bg-rose-50';
  };

  const lateColor = (count: number) => {
    if (count === 0) return 'text-emerald-700 bg-emerald-50';
    if (count <= 2) return 'text-amber-700 bg-amber-50';
    return 'text-rose-700 bg-rose-50';
  };

  return (
    <div className="space-y-5">
      {error && <div className={ui.error}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}

      {/* Period Selector */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-5 w-5 text-[#223f7a]" />
          <div>
            <h3 className="text-sm font-black text-slate-900">Attendance Reports</h3>
            <p className="text-xs font-semibold text-slate-400">Lateness, breaks, and time adherence</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={periodStart}
            onChange={e => setPeriodStart(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700"
          />
          <span className="text-xs text-slate-400">to</span>
          <input
            type="date"
            value={periodEnd}
            onChange={e => setPeriodEnd(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700"
          />
          <button type="button" onClick={() => void fetchReports()} className={ui.btnSecondary + ' !text-xs'}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      {summary && !loading && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <button
            type="button"
            onClick={() => setViewMode('overview')}
            className={`${ui.stat} cursor-pointer transition hover:ring-2 hover:ring-[#223f7a]/20 ${viewMode === 'overview' ? 'ring-2 ring-[#223f7a]' : ''}`}
          >
            <p className={ui.statLabel}><Users className="inline h-3.5 w-3.5 mr-1" />Employees</p>
            <p className={ui.statValue + ' text-2xl'}>{summary.total_employees}</p>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('late')}
            className={`${ui.stat} cursor-pointer transition hover:ring-2 hover:ring-rose-200 ${viewMode === 'late' ? 'ring-2 ring-rose-400' : ''}`}
          >
            <p className={ui.statLabel}><Clock className="inline h-3.5 w-3.5 mr-1" />Late Instances</p>
            <p className={ui.statValue + ' text-2xl text-rose-700'}>{summary.total_late_instances}</p>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('breaks')}
            className={`${ui.stat} cursor-pointer transition hover:ring-2 hover:ring-violet-200 ${viewMode === 'breaks' ? 'ring-2 ring-violet-400' : ''}`}
          >
            <p className={ui.statLabel}><Clock className="inline h-3.5 w-3.5 mr-1" />Avg Break/Day</p>
            <p className={ui.statValue + ' text-2xl text-violet-700'}>{formatMinutes(summary.avg_break_minutes)}</p>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('adherence')}
            className={`${ui.stat} cursor-pointer transition hover:ring-2 hover:ring-emerald-200 ${viewMode === 'adherence' ? 'ring-2 ring-emerald-400' : ''}`}
          >
            <p className={ui.statLabel}><TrendingUp className="inline h-3.5 w-3.5 mr-1" />Avg Adherence</p>
            <p className={ui.statValue + ' text-2xl text-emerald-700'}>{summary.avg_time_adherence}%</p>
          </button>
        </div>
      )}

      {/* View Mode Tabs */}
      <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
        {([
          { id: 'overview', label: 'Overview' },
          { id: 'late', label: 'Late Arrivals' },
          { id: 'breaks', label: 'Break Time' },
          { id: 'adherence', label: 'Time Adherence' },
        ] as const).map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setViewMode(tab.id)}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-black transition ${
              viewMode === tab.id ? 'bg-white text-[#223f7a] shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Data Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12"><RefreshCw className="h-5 w-5 animate-spin text-slate-400" /></div>
      ) : employees.length === 0 ? (
        <div className={ui.empty}>No clock-in data found for this period.</div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>
                    <button type="button" onClick={() => handleSort('display_name')} className="hover:text-[#223f7a]">
                      Employee {sortField === 'display_name' && (sortAsc ? '↑' : '↓')}
                    </button>
                  </th>
                  {(viewMode === 'overview' || viewMode === 'late') && (
                    <>
                      <th className={ui.th}>
                        <button type="button" onClick={() => handleSort('late_count')} className="hover:text-[#223f7a]">
                          Late Count {sortField === 'late_count' && (sortAsc ? '↑' : '↓')}
                        </button>
                      </th>
                      <th className={ui.th}>Avg Late</th>
                      <th className={ui.th}>Total Late Time</th>
                    </>
                  )}
                  {(viewMode === 'overview' || viewMode === 'breaks') && (
                    <>
                      <th className={ui.th}>
                        <button type="button" onClick={() => handleSort('avg_break_minutes')} className="hover:text-[#223f7a]">
                          Avg Break/Day {sortField === 'avg_break_minutes' && (sortAsc ? '↑' : '↓')}
                        </button>
                      </th>
                      <th className={ui.th}>Total Break</th>
                    </>
                  )}
                  {(viewMode === 'overview' || viewMode === 'adherence') && (
                    <>
                      <th className={ui.th}>
                        <button type="button" onClick={() => handleSort('time_adherence_pct')} className="hover:text-[#223f7a]">
                          Adherence {sortField === 'time_adherence_pct' && (sortAsc ? '↑' : '↓')}
                        </button>
                      </th>
                      <th className={ui.th}>Scheduled</th>
                      <th className={ui.th}>Actual</th>
                      <th className={ui.th}>Overtime</th>
                    </>
                  )}
                  <th className={ui.th}>Entries</th>
                </tr>
              </thead>
              <tbody>
                {sortedEmployees.map(emp => (
                  <tr key={emp.profile_id} className={ui.trHover}>
                    <td className={ui.td}>
                      <div className="flex items-center gap-2.5">
                        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#223f7a] text-[9px] font-black text-white">
                          {emp.initials}
                        </div>
                        <span className="text-xs font-black text-slate-800">{emp.display_name}</span>
                      </div>
                    </td>
                    {(viewMode === 'overview' || viewMode === 'late') && (
                      <>
                        <td className={ui.td}>
                          <span className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] font-black ${lateColor(emp.late_count)}`}>
                            {emp.late_count}x
                          </span>
                        </td>
                        <td className={ui.td + ' text-xs font-bold text-slate-600'}>
                          {emp.late_count > 0 ? formatMinutes(emp.avg_late_minutes) : '—'}
                        </td>
                        <td className={ui.td + ' text-xs font-bold text-slate-600'}>
                          {emp.late_minutes_total > 0 ? formatMinutes(emp.late_minutes_total) : '—'}
                        </td>
                      </>
                    )}
                    {(viewMode === 'overview' || viewMode === 'breaks') && (
                      <>
                        <td className={ui.td + ' text-xs font-bold text-violet-700'}>
                          {formatMinutes(emp.avg_break_minutes)}
                        </td>
                        <td className={ui.td + ' text-xs font-bold text-slate-500'}>
                          {formatMinutes(emp.break_minutes_total)}
                        </td>
                      </>
                    )}
                    {(viewMode === 'overview' || viewMode === 'adherence') && (
                      <>
                        <td className={ui.td}>
                          <span className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] font-black ${adherenceColor(emp.time_adherence_pct)}`}>
                            {emp.time_adherence_pct}%
                          </span>
                        </td>
                        <td className={ui.td + ' text-xs font-bold text-slate-600'}>{emp.scheduled_hours}h</td>
                        <td className={ui.td + ' text-xs font-bold text-slate-800'}>{emp.actual_hours}h</td>
                        <td className={ui.td + ' text-xs font-bold text-amber-700'}>{emp.overtime_hours > 0 ? `${emp.overtime_hours}h` : '—'}</td>
                      </>
                    )}
                    <td className={ui.td + ' text-xs font-bold text-slate-500'}>{emp.total_entries}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Explanation */}
      <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
        <p className="text-[11px] font-bold text-slate-500">
          <strong className="text-slate-700">How adherence is calculated:</strong>{' '}
          Actual worked hours ÷ Scheduled hours × 100. Overtime hours are excluded — working
          overtime does not inflate adherence. A 5-minute grace period is applied before marking
          an arrival as late.
        </p>
      </div>
    </div>
  );
}

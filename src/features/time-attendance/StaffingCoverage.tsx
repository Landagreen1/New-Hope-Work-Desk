'use client';

import { AlertTriangle, CheckCircle2, RefreshCw, Users, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import { DEPARTMENT_LABELS } from './types';

interface CoverageData {
  department: string;
  clocked_in: number;
  available: number;
  minimum: number;
  warning: number;
  status: 'ok' | 'warning' | 'critical';
  staff_names: string[];
}

export default function StaffingCoverage() {
  const [coverage, setCoverage] = useState<CoverageData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>('');

  const fetchCoverage = useCallback(async () => {
    try {
      const res = await fetch('/api/staffing');
      if (!res.ok) throw new Error('Failed to load staffing data.');
      const body = await res.json();
      setCoverage(body.coverage as CoverageData[]);
      setLastUpdate(new Date(body.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    } catch (err) { setError(err instanceof Error ? err.message : 'Load failed.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void fetchCoverage();
    const interval = setInterval(() => void fetchCoverage(), 30000); // refresh every 30s
    return () => clearInterval(interval);
  }, [fetchCoverage]);

  const statusIcon = (status: string) => {
    if (status === 'critical') return <XCircle className="h-5 w-5 text-rose-600" />;
    if (status === 'warning') return <AlertTriangle className="h-5 w-5 text-amber-600" />;
    return <CheckCircle2 className="h-5 w-5 text-emerald-600" />;
  };

  const statusBg = (status: string) => {
    if (status === 'critical') return 'border-rose-200 bg-rose-50';
    if (status === 'warning') return 'border-amber-200 bg-amber-50';
    return 'border-emerald-200 bg-emerald-50';
  };

  if (loading) return <div className="flex items-center justify-center py-12"><RefreshCw className="h-5 w-5 animate-spin text-slate-400" /></div>;

  const hasAlerts = coverage.some(c => c.status !== 'ok');

  return (
    <div className="space-y-5">
      {error && <div className={ui.error}>{error}</div>}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-[#223f7a]" />
          <h3 className="text-sm font-black text-slate-800">Real-Time Staffing Coverage</h3>
          {hasAlerts && <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-[10px] font-black text-rose-700 animate-pulse">ALERTS</span>}
        </div>
        <p className="text-[10px] font-semibold text-slate-400">Updated {lastUpdate}</p>
      </div>

      {/* Department Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {coverage.map(dept => (
          <div key={dept.department} className={`rounded-2xl border p-4 ${statusBg(dept.status)}`}>
            <div className="flex items-center justify-between">
              <p className="text-xs font-black uppercase tracking-wider text-slate-600">
                {DEPARTMENT_LABELS[dept.department as keyof typeof DEPARTMENT_LABELS] ?? dept.department}
              </p>
              {statusIcon(dept.status)}
            </div>
            <p className="mt-2 text-3xl font-black text-slate-900">{dept.clocked_in}</p>
            <p className="text-[10px] font-semibold text-slate-500">
              {dept.available} available · Min: {dept.minimum} · Warn: {dept.warning}
            </p>
            {dept.staff_names.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {dept.staff_names.map(name => (
                  <span key={name} className="rounded bg-white/70 px-1.5 py-0.5 text-[9px] font-bold text-slate-600">{name.split(' ')[0]}</span>
                ))}
              </div>
            )}
            {dept.status === 'critical' && (
              <p className="mt-2 text-[10px] font-black text-rose-700">BELOW MINIMUM — needs coverage!</p>
            )}
            {dept.status === 'warning' && (
              <p className="mt-2 text-[10px] font-black text-amber-700">At warning level — schedule backup</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

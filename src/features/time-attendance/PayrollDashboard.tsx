'use client';

import { AlertCircle, DollarSign, Download, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import type { EmployeePaymentSettings, PayrollPeriod, PayrollSummary } from './types';
import { PAYMENT_TEMPLATE_LABELS } from './types';

interface PayrollDashboardProps { initialProfile: ProfileLite; }

export default function PayrollDashboard({ initialProfile }: PayrollDashboardProps) {
  const [settings, setSettings] = useState<EmployeePaymentSettings | null>(null);
  const [periods, setPeriods] = useState<PayrollPeriod[]>([]);
  const [summaries, setSummaries] = useState<PayrollSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isManager = initialProfile.role === 'manager' || initialProfile.role === 'super_admin';

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [settingsRes, periodsRes, summariesRes] = await Promise.all([
        fetch(`/api/payroll/settings?profile_id=${initialProfile.id}`),
        fetch('/api/payroll/periods'),
        fetch(`/api/payroll?profile_id=${initialProfile.id}`),
      ]);
      if (settingsRes.ok) { const b = await settingsRes.json(); setSettings(b.settings); }
      if (periodsRes.ok) { const b = await periodsRes.json(); setPeriods(b.periods); }
      if (summariesRes.ok) { const b = await summariesRes.json(); setSummaries(b.summaries); }
    } catch (err) { setError(err instanceof Error ? err.message : 'Load failed.'); }
    finally { setLoading(false); }
  }, [initialProfile.id]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  function formatMoney(amount: number): string {
    return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  if (loading) return <div className="flex items-center justify-center py-16"><RefreshCw className="h-5 w-5 animate-spin text-slate-400" /></div>;

  return (
    <div className="space-y-5">
      {error && <div className={ui.error}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}

      {/* Payment Settings Card */}
      <div className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-black text-slate-800 mb-3"><DollarSign className="inline h-4 w-4 mr-1.5 text-[#223f7a]" />My Payment Info</h3>
        {settings ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div><p className="text-[10px] font-black uppercase text-slate-400">Pay Type</p><p className="mt-0.5 text-sm font-bold text-slate-800">{settings.pay_type === 'hourly' ? 'Hourly' : 'Salary'}</p></div>
            <div><p className="text-[10px] font-black uppercase text-slate-400">Rate</p><p className="mt-0.5 text-sm font-bold text-slate-800">{settings.pay_type === 'hourly' ? `${formatMoney(settings.hourly_rate ?? 0)}/hr` : `${formatMoney(settings.salary_amount ?? 0)}/period`}</p></div>
            <div><p className="text-[10px] font-black uppercase text-slate-400">Schedule</p><p className="mt-0.5 text-sm font-bold text-slate-800">{PAYMENT_TEMPLATE_LABELS[settings.payment_template]}</p></div>
            <div><p className="text-[10px] font-black uppercase text-slate-400">OT After</p><p className="mt-0.5 text-sm font-bold text-slate-800">{settings.weekly_overtime_threshold}h/week @ {settings.overtime_multiplier}x</p></div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">Payment settings not configured. Contact your manager.</p>
        )}
      </div>

      {/* Payroll History */}
      <div className={ui.card + ' overflow-hidden'}>
        <div className="border-b border-slate-100 px-5 py-4 flex items-center justify-between">
          <h3 className="text-sm font-black text-slate-800">Payroll History</h3>
          <button type="button" onClick={() => void fetchData()} className={ui.btnSecondary + ' text-xs'}><RefreshCw className="h-3.5 w-3.5" /></button>
        </div>
        {summaries.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm font-semibold text-slate-400">No payroll records yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>Period</th>
                  <th className={ui.th}>Hours</th>
                  <th className={ui.th}>OT</th>
                  <th className={ui.th}>PTO</th>
                  <th className={ui.th}>Gross</th>
                  <th className={ui.th}>Deductions</th>
                  <th className={ui.th}>Net Pay</th>
                  <th className={ui.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map(s => (
                  <tr key={s.id} className={ui.trHover}>
                    <td className={ui.td}>
                      <p className="text-xs font-bold text-slate-800">{s.payroll_periods?.period_start} — {s.payroll_periods?.period_end}</p>
                      <p className="text-[10px] text-slate-400">Pay: {s.payroll_periods?.pay_date}</p>
                    </td>
                    <td className={ui.td + ' text-xs font-bold'}>{s.regular_hours}h</td>
                    <td className={ui.td + ' text-xs font-bold text-amber-700'}>{s.overtime_hours}h</td>
                    <td className={ui.td + ' text-xs font-bold text-violet-700'}>{s.pto_days_used}d</td>
                    <td className={ui.td + ' text-xs font-black text-slate-800'}>{formatMoney(s.gross_pay)}</td>
                    <td className={ui.td + ' text-xs font-bold text-rose-600'}>-{formatMoney(s.deductions_total)}</td>
                    <td className={ui.td + ' text-xs font-black text-emerald-700'}>{formatMoney(s.net_pay)}</td>
                    <td className={ui.td}><span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${s.status === 'paid' ? 'bg-emerald-100 text-emerald-800' : s.status === 'confirmed' ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-600'}`}>{s.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

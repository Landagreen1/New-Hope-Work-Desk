'use client';

import { AlertCircle, CheckCircle2, ChevronRight, DollarSign, Download, Lock, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';

import DatePicker from '../nhwd-shared/DatePicker';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';

interface PayrollProcessorProps {
  initialProfile: ProfileLite;
}

type Step = 'period' | 'review' | 'done';

interface EmployeeSummary {
  profile_id: string;
  display_name: string;
  initials: string;
  role: string;
  hourly_rate: number;
  regular_hours: number;
  overtime_hours: number;
  break_hours: number;
  total_hours: number;
  pto_days_used: number;
  pto_hours_paid: number;
  regular_pay: number;
  overtime_pay: number;
  pto_pay: number;
  gross_pay: number;
  deductions_total: number;
  net_pay: number;
  days_worked: number;
  entries_count: number;
}

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function suggestPeriodDates(): { start: string; end: string; payDate: string } {
  // Suggest a biweekly period ending yesterday, pay date 3 days after
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 13); // 14-day period
  const pay = new Date(end);
  pay.setDate(pay.getDate() + 3);

  const fmt = (d: Date) => d.toISOString().split('T')[0];
  return { start: fmt(start), end: fmt(end), payDate: fmt(pay) };
}

export default function PayrollProcessor({ initialProfile }: PayrollProcessorProps) {
  const isSuperAdmin = initialProfile.role === 'super_admin';
  const suggested = suggestPeriodDates();

  const [step, setStep] = useState<Step>('period');
  const [periodStart, setPeriodStart] = useState(suggested.start);
  const [periodEnd, setPeriodEnd] = useState(suggested.end);
  const [payDate, setPayDate] = useState(suggested.payDate);
  const [summaries, setSummaries] = useState<EmployeeSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processedId, setProcessedId] = useState<string | null>(null);

  // Step 1 → Step 2: Calculate
  const handleCalculate = useCallback(async () => {
    if (!periodStart || !periodEnd) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/payroll/calculate?period_start=${periodStart}&period_end=${periodEnd}`);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Calculation failed.'); }
      const body = await res.json();
      setSummaries(body.summaries as EmployeeSummary[]);
      setStep('review');
    } catch (err) { setError(err instanceof Error ? err.message : 'Calculation failed.'); }
    finally { setLoading(false); }
  }, [periodStart, periodEnd]);

  // Step 2 → Step 3: Process
  const handleProcess = useCallback(async () => {
    if (!summaries.length) return;
    setProcessing(true); setError(null);
    try {
      const res = await fetch('/api/payroll/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_start: periodStart,
          period_end: periodEnd,
          pay_date: payDate,
          summaries: summaries.map(s => ({
            profile_id: s.profile_id,
            regular_hours: s.regular_hours,
            overtime_hours: s.overtime_hours,
            break_hours: s.break_hours,
            total_hours: s.total_hours,
            pto_days_used: s.pto_days_used,
            pto_hours_paid: s.pto_hours_paid,
            regular_pay: s.regular_pay,
            overtime_pay: s.overtime_pay,
            pto_pay: s.pto_pay,
            gross_pay: s.gross_pay,
            deductions_total: s.deductions_total,
            net_pay: s.net_pay,
            days_worked: s.days_worked,
          })),
        }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Processing failed.'); }
      const body = await res.json();
      setProcessedId(body.period_id);
      setStep('done');
    } catch (err) { setError(err instanceof Error ? err.message : 'Processing failed.'); }
    finally { setProcessing(false); }
  }, [summaries, periodStart, periodEnd, payDate]);

  // CSV export
  const handleExport = () => {
    const headers = ['Employee', 'Hours', 'OT Hours', 'Break Hrs', 'PTO Days', 'Rate', 'Regular Pay', 'OT Pay', 'PTO Pay', 'Gross', 'Deductions', 'Net Pay'];
    const rows = summaries.map(s => [
      s.display_name, s.total_hours, s.overtime_hours, s.break_hours, s.pto_days_used,
      s.hourly_rate, s.regular_pay, s.overtime_pay, s.pto_pay, s.gross_pay, s.deductions_total, s.net_pay,
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll-${periodStart}-to-${periodEnd}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Totals
  const totalGross = summaries.reduce((sum, s) => sum + s.gross_pay, 0);
  const totalNet = summaries.reduce((sum, s) => sum + s.net_pay, 0);
  const totalHours = summaries.reduce((sum, s) => sum + s.total_hours, 0);

  if (!isSuperAdmin) {
    return (
      <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-bold text-slate-500">Payroll processing is available to super admins only. Contact your administrator.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error && <div className={ui.error}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}

      {/* Step Indicator */}
      <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-3 shadow-sm">
        {(['period', 'review', 'done'] as Step[]).map((s, i) => {
          const labels = ['Select Period', 'Review & Adjust', 'Processed'];
          const isActive = s === step;
          const isCompleted = (['period', 'review', 'done'].indexOf(step) > i);
          return (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <ChevronRight className="h-4 w-4 text-slate-300" />}
              <span className={`rounded-full px-3 py-1 text-xs font-black ${
                isActive ? 'bg-[#223f7a] text-white' : isCompleted ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-400'
              }`}>
                {i + 1}. {labels[i]}
              </span>
            </div>
          );
        })}
      </div>

      {/* ─── Step 1: Select Period ─── */}
      {step === 'period' && (
        <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Step 1</p>
            <h3 className="mt-1 text-xl font-black text-slate-900">Select Pay Period</h3>
            <p className="mt-1 text-sm text-slate-500">Choose the dates for this payroll run. A biweekly period is suggested by default.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={ui.label}>Period Start</label>
              <DatePicker value={periodStart} onChange={setPeriodStart} placeholder="Start date" className="mt-2" />
            </div>
            <div>
              <label className={ui.label}>Period End</label>
              <DatePicker value={periodEnd} onChange={setPeriodEnd} min={periodStart} placeholder="End date" className="mt-2" />
            </div>
            <div>
              <label className={ui.label}>Pay Date</label>
              <DatePicker value={payDate} onChange={setPayDate} min={periodEnd} placeholder="Pay date" className="mt-2" />
            </div>
          </div>

          <div className="mt-6">
            <button
              type="button"
              onClick={() => void handleCalculate()}
              disabled={loading || !periodStart || !periodEnd}
              className={ui.btnPrimary}
            >
              {loading ? <><RefreshCw className="h-4 w-4 animate-spin" /> Calculating...</> : <>Calculate Payroll <ChevronRight className="h-4 w-4" /></>}
            </button>
          </div>
        </div>
      )}

      {/* ─── Step 2: Review & Adjust ─── */}
      {step === 'review' && (
        <div className="space-y-5">
          {/* Period summary bar */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className={ui.stat}><p className={ui.statLabel}>Period</p><p className="mt-1 text-sm font-black text-slate-900">{periodStart} → {periodEnd}</p></div>
            <div className={ui.stat}><p className={ui.statLabel}>Employees</p><p className={ui.statValue + ' text-2xl'}>{summaries.length}</p></div>
            <div className={ui.stat}><p className={ui.statLabel}>Total Hours</p><p className={ui.statValue + ' text-2xl'}>{totalHours.toFixed(1)}h</p></div>
            <div className={ui.stat}><p className={ui.statLabel}>Total Net Pay</p><p className={ui.statValue + ' text-2xl text-emerald-700'}>{formatMoney(totalNet)}</p></div>
          </div>

          {/* Employee table */}
          <div className="rounded-[28px] border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Step 2</p>
                <h3 className="mt-1 text-lg font-black text-slate-900">Review Employee Payroll</h3>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={handleExport} className={ui.btnSecondary + ' !text-xs'}><Download className="h-3.5 w-3.5" /> Export CSV</button>
                <button type="button" onClick={() => setStep('period')} className={ui.btnSecondary + ' !text-xs'}>Back</button>
              </div>
            </div>

            {summaries.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm font-bold text-slate-400">
                No employees have clock entries or PTO in this period.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th className={ui.th}>Employee</th>
                      <th className={ui.th}>Rate</th>
                      <th className={ui.th}>Hours</th>
                      <th className={ui.th}>OT</th>
                      <th className={ui.th}>Breaks</th>
                      <th className={ui.th}>PTO</th>
                      <th className={ui.th}>Gross</th>
                      <th className={ui.th}>Deductions</th>
                      <th className={ui.th}>Net Pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaries.map((s) => (
                      <tr key={s.profile_id} className="hover:bg-[#f8faff]">
                        <td className={ui.td}>
                          <div className="flex items-center gap-2">
                            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#223f7a] text-[9px] font-black text-white">{s.initials}</span>
                            <div>
                              <p className="text-sm font-black text-slate-900">{s.display_name}</p>
                              <p className="text-[10px] text-slate-400">{s.days_worked} days · {s.entries_count} sessions</p>
                            </div>
                          </div>
                        </td>
                        <td className={`${ui.td} text-xs font-bold`}>{formatMoney(s.hourly_rate)}/hr</td>
                        <td className={`${ui.td} text-xs font-black`}>{s.total_hours}h</td>
                        <td className={`${ui.td} text-xs font-bold ${s.overtime_hours > 0 ? 'text-amber-700' : 'text-slate-400'}`}>{s.overtime_hours > 0 ? `${s.overtime_hours}h` : '—'}</td>
                        <td className={`${ui.td} text-xs font-bold text-slate-500`}>{s.break_hours > 0 ? `${s.break_hours.toFixed(1)}h` : '—'}</td>
                        <td className={`${ui.td} text-xs font-bold ${s.pto_days_used > 0 ? 'text-violet-700' : 'text-slate-400'}`}>{s.pto_days_used > 0 ? `${s.pto_days_used}d` : '—'}</td>
                        <td className={`${ui.td} text-sm font-black text-slate-800`}>{formatMoney(s.gross_pay)}</td>
                        <td className={`${ui.td} text-xs font-bold text-rose-600`}>{s.deductions_total > 0 ? `-${formatMoney(s.deductions_total)}` : '—'}</td>
                        <td className={`${ui.td} text-sm font-black text-emerald-700`}>{formatMoney(s.net_pay)}</td>
                      </tr>
                    ))}
                    {/* Totals row */}
                    <tr className="bg-slate-50 font-black">
                      <td className={`${ui.td} text-sm font-black`}>Total ({summaries.length} employees)</td>
                      <td className={ui.td} />
                      <td className={`${ui.td} text-xs`}>{totalHours.toFixed(1)}h</td>
                      <td className={`${ui.td} text-xs text-amber-700`}>{summaries.reduce((sum, s) => sum + s.overtime_hours, 0).toFixed(1)}h</td>
                      <td className={ui.td} />
                      <td className={ui.td} />
                      <td className={`${ui.td} text-sm`}>{formatMoney(totalGross)}</td>
                      <td className={`${ui.td} text-xs text-rose-600`}>-{formatMoney(summaries.reduce((sum, s) => sum + s.deductions_total, 0))}</td>
                      <td className={`${ui.td} text-sm text-emerald-700`}>{formatMoney(totalNet)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {summaries.length > 0 && (
              <div className="border-t border-slate-100 px-5 py-4 flex items-center justify-between bg-gradient-to-r from-white to-[#f8faff]">
                <p className="text-xs font-semibold text-slate-500">
                  Confirm the numbers above are correct. Once processed, the period will be locked.
                </p>
                <button
                  type="button"
                  onClick={() => void handleProcess()}
                  disabled={processing}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-black text-white shadow-lg shadow-emerald-200 transition hover:bg-emerald-700 disabled:opacity-50"
                >
                  {processing ? <><RefreshCw className="h-4 w-4 animate-spin" /> Processing...</> : <><Lock className="h-4 w-4" /> Process Payroll</>}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Step 3: Done ─── */}
      {step === 'done' && (
        <div className="rounded-[28px] border border-emerald-200 bg-gradient-to-br from-white to-emerald-50 p-8 shadow-sm text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-100">
            <CheckCircle2 className="h-8 w-8 text-emerald-600" />
          </div>
          <h3 className="mt-4 text-2xl font-black text-slate-900">Payroll Processed</h3>
          <p className="mt-2 text-sm text-slate-600">
            Period <span className="font-bold">{periodStart}</span> to <span className="font-bold">{periodEnd}</span> has been locked and saved.
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {summaries.length} employee{summaries.length !== 1 ? 's' : ''} · Total payout: <span className="font-black text-emerald-700">{formatMoney(totalNet)}</span>
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <button type="button" onClick={handleExport} className={ui.btnSecondary}><Download className="h-4 w-4" /> Download CSV</button>
            <button type="button" onClick={() => { setStep('period'); setSummaries([]); setProcessedId(null); }} className={ui.btnPrimary}>Run Another Period</button>
          </div>
        </div>
      )}
    </div>
  );
}

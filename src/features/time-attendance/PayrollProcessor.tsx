'use client';

import { AlertCircle, CheckCircle2, ChevronRight, Clock, DollarSign, Download, Edit3, Lock, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

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
  const [detailEmployee, setDetailEmployee] = useState<EmployeeSummary | null>(null);
  const [processedPeriods, setProcessedPeriods] = useState<Array<{ id: string; period_start: string; period_end: string; pay_date: string; processed_at: string }>>([]);

  // Fetch already-processed periods
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/payroll/periods');
        if (res.ok) {
          const body = await res.json();
          setProcessedPeriods((body.periods ?? []).filter((p: { status: string }) => p.status === 'processed'));
        }
      } catch { /* silent */ }
    })();
  }, [step]); // Refresh when step changes (e.g., after processing)

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

          {/* Already processed periods — always visible */}
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-black uppercase tracking-wider text-slate-400">
                <Lock className="mr-1 inline h-3.5 w-3.5" />Payroll History
              </p>
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-black text-slate-500">{processedPeriods.length} period{processedPeriods.length !== 1 ? 's' : ''}</span>
            </div>
            {processedPeriods.length > 0 ? (
              <div className="space-y-2">
                {processedPeriods.map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                    <div>
                      <p className="text-sm font-black text-slate-800">{p.period_start} → {p.period_end}</p>
                      <p className="mt-0.5 text-[10px] text-slate-400">Pay date: {p.pay_date} · Processed: {new Date(p.processed_at).toLocaleDateString()}</p>
                    </div>
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-black text-emerald-700 ring-1 ring-emerald-200">Paid</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm font-semibold text-slate-400">No payroll periods have been processed yet.</p>
            )}
            {processedPeriods.length > 0 && (
              <p className="mt-3 text-[10px] font-semibold text-slate-400">
                These periods are locked and cannot be re-processed. Select dates that don&apos;t overlap.
              </p>
            )}
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
                      <tr key={s.profile_id} className="hover:bg-[#f8faff] cursor-pointer" onClick={() => setDetailEmployee(s)}>
                        <td className={ui.td}>
                          <div className="flex items-center gap-2">
                            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#223f7a] text-[9px] font-black text-white">{s.initials}</span>
                            <div>
                              <p className="text-sm font-black text-slate-900">{s.display_name}</p>
                              <p className="text-[10px] text-slate-400">{s.days_worked} days · {s.entries_count} sessions <span className="text-[#223f7a]">· View details →</span></p>
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

      {/* ─── Employee Detail Modal for Payroll Period ─── */}
      {detailEmployee && (
        <PayrollEmployeeDetail
          profileId={detailEmployee.profile_id}
          name={detailEmployee.display_name}
          periodStart={periodStart}
          periodEnd={periodEnd}
          onClose={() => setDetailEmployee(null)}
          onRefresh={() => void handleCalculate()}
        />
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


// ─── Payroll Employee Detail Modal ────────────────────────────────────────────

interface ClockEntry {
  id: string;
  profile_id: string;
  clock_in: string;
  clock_out: string | null;
  break_minutes: number;
  total_hours: number | null;
  clock_status: string;
  adjusted_by: string | null;
  adjustment_reason: string | null;
}

function PayrollEmployeeDetail({
  profileId,
  name,
  periodStart,
  periodEnd,
  onClose,
  onRefresh,
}: {
  profileId: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [entries, setEntries] = useState<ClockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [editClockIn, setEditClockIn] = useState('');
  const [editClockOut, setEditClockOut] = useState('');
  const [editBreakMin, setEditBreakMin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/time-clock?profile_id=${profileId}&date=${periodStart}&range=month`);
      if (!res.ok) throw new Error('Load failed.');
      const body = await res.json();
      // Filter to period range
      const all = (body.entries as ClockEntry[]).filter(e => {
        const d = e.clock_in.split('T')[0];
        return d >= periodStart && d <= periodEnd;
      });
      setEntries(all);
    } catch { setEntries([]); }
    finally { setLoading(false); }
  }, [profileId, periodStart, periodEnd]);

  useEffect(() => { void loadEntries(); }, [loadEntries]);

  const handleSave = async (entryId: string) => {
    const reason = window.prompt('Reason for this adjustment:');
    if (!reason?.trim()) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/time-clock', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'edit',
          entry_id: entryId,
          clock_in: editClockIn || undefined,
          clock_out: editClockOut || undefined,
          break_minutes: editBreakMin !== '' ? Number(editBreakMin) : undefined,
          adjustment_reason: reason.trim(),
        }),
      });
      if (!res.ok) throw new Error('Save failed.');
      setEditId(null);
      await loadEntries();
      onRefresh(); // Recalculate payroll totals
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed.'); }
    finally { setSaving(false); }
  };

  // Group by day
  const entriesByDay: Record<string, ClockEntry[]> = {};
  for (const e of entries) {
    const key = e.clock_in.split('T')[0];
    if (!entriesByDay[key]) entriesByDay[key] = [];
    entriesByDay[key].push(e);
  }
  const sortedDays = Object.keys(entriesByDay).sort((a, b) => b.localeCompare(a));

  const totalHours = entries.reduce((sum, e) => sum + (e.total_hours ?? 0), 0);
  const totalBreakMin = entries.reduce((sum, e) => sum + (e.break_minutes ?? 0), 0);

  // Warnings
  const warnings: string[] = [];
  // Check for entries with > 10 hours (likely forgot to clock out)
  const longEntries = entries.filter(e => (e.total_hours ?? 0) > 10);
  if (longEntries.length) warnings.push(`${longEntries.length} session(s) over 10 hours — possible forgotten clock-out`);
  // Check for days with 0 break minutes
  const daysWithNoBreak = sortedDays.filter(day => {
    const dayEntries = entriesByDay[day];
    const dayTotal = dayEntries.reduce((sum, e) => sum + (e.total_hours ?? 0), 0);
    const dayBreak = dayEntries.reduce((sum, e) => sum + (e.break_minutes ?? 0), 0);
    return dayTotal >= 5 && dayBreak === 0; // Worked 5+ hours with no break
  });
  if (daysWithNoBreak.length) warnings.push(`${daysWithNoBreak.length} day(s) with 5+ hours worked and no lunch break recorded`);

  const fmtTime = (iso: string) => {
    try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return iso; }
  };
  const fmtDT = (iso: string) => iso ? new Date(iso).toISOString().slice(0, 16) : '';

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 p-3 backdrop-blur-sm sm:p-6" onMouseDown={onClose}>
      <div className="mx-auto max-w-4xl rounded-[30px] bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#4d6aa8]">Payroll Review</p>
            <h3 className="mt-1 text-xl font-black text-slate-900">{name}</h3>
            <p className="mt-0.5 text-xs text-slate-500">Period: {periodStart} → {periodEnd} · Click Edit to fix any entry</p>
          </div>
          <button onClick={onClose} className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600 hover:bg-slate-200"><X className="mr-1 inline h-3.5 w-3.5" />Close</button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16"><RefreshCw className="h-5 w-5 animate-spin text-slate-400" /></div>
        ) : (
          <div className="p-6 space-y-5">
            {/* Summary + Warnings */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-2xl bg-slate-50 p-4"><p className="text-[10px] font-black uppercase text-slate-400">Hours</p><p className="mt-1 text-2xl font-black">{totalHours.toFixed(1)}h</p></div>
              <div className="rounded-2xl bg-amber-50 p-4"><p className="text-[10px] font-black uppercase text-amber-700">Breaks</p><p className="mt-1 text-2xl font-black text-amber-800">{totalBreakMin}m</p></div>
              <div className="rounded-2xl bg-blue-50 p-4"><p className="text-[10px] font-black uppercase text-blue-700">Days</p><p className="mt-1 text-2xl font-black text-blue-900">{sortedDays.length}</p></div>
            </div>

            {warnings.length > 0 && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 space-y-1">
                <p className="text-xs font-black text-amber-800"><AlertCircle className="mr-1 inline h-3.5 w-3.5" />Attention Needed</p>
                {warnings.map((w, i) => <p key={i} className="text-xs font-semibold text-amber-700">• {w}</p>)}
              </div>
            )}

            {error && <div className={ui.error}>{error}</div>}

            {/* Day-by-day entries with edit capability */}
            <div className="rounded-2xl border border-slate-200 overflow-hidden">
              <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
                <p className="text-xs font-black uppercase tracking-wider text-slate-400">Clock Entries — Edit to fix errors before processing</p>
              </div>
              <div className="max-h-[450px] overflow-y-auto divide-y divide-slate-100">
                {sortedDays.map((day) => {
                  const dayEntries = entriesByDay[day];
                  const dayHours = dayEntries.reduce((sum, e) => sum + (e.total_hours ?? 0), 0);
                  const dayBreaks = dayEntries.reduce((sum, e) => sum + (e.break_minutes ?? 0), 0);
                  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                  const hasIssue = dayHours > 10 || (dayHours >= 5 && dayBreaks === 0);

                  return (
                    <div key={day} className={`px-4 py-3 ${hasIssue ? 'bg-amber-50/50' : ''}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-black text-slate-800">{dayLabel}</p>
                          {dayHours > 10 && <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[9px] font-black text-rose-700 ring-1 ring-rose-200">Long shift</span>}
                          {dayHours >= 5 && dayBreaks === 0 && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[9px] font-black text-amber-700 ring-1 ring-amber-200">No break</span>}
                        </div>
                        <div className="flex items-center gap-3">
                          {dayBreaks > 0 && <span className="text-[10px] font-bold text-amber-600">{dayBreaks}m break</span>}
                          <span className="text-sm font-black text-slate-900">{dayHours.toFixed(1)}h</span>
                        </div>
                      </div>
                      <div className="mt-2 space-y-1.5">
                        {dayEntries.map((entry) => (
                          <div key={entry.id} className="rounded-lg bg-white border border-slate-100 px-3 py-2">
                            {editId === entry.id ? (
                              <div className="space-y-2">
                                <div className="grid grid-cols-3 gap-2">
                                  <div>
                                    <p className="text-[9px] font-black uppercase text-slate-400">Clock In</p>
                                    <input type="datetime-local" value={editClockIn} onChange={e => setEditClockIn(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold" />
                                  </div>
                                  <div>
                                    <p className="text-[9px] font-black uppercase text-slate-400">Clock Out</p>
                                    <input type="datetime-local" value={editClockOut} onChange={e => setEditClockOut(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold" />
                                  </div>
                                  <div>
                                    <p className="text-[9px] font-black uppercase text-slate-400">Break (min)</p>
                                    <input type="number" min="0" value={editBreakMin} onChange={e => setEditBreakMin(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold" />
                                  </div>
                                </div>
                                <div className="flex gap-2">
                                  <button onClick={() => void handleSave(entry.id)} disabled={saving} className={ui.btnPrimary + ' !px-3 !py-1.5 !text-xs'}>{saving ? '...' : 'Save'}</button>
                                  <button onClick={() => setEditId(null)} className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}>Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <p className="text-xs font-bold text-slate-700">
                                    {fmtTime(entry.clock_in)}
                                    {entry.clock_out ? ` — ${fmtTime(entry.clock_out)}` : ' — Active (no clock-out!)'}
                                  </p>
                                  {entry.break_minutes > 0 && <span className="text-[10px] font-bold text-amber-600">{entry.break_minutes}m brk</span>}
                                  {entry.adjusted_by && <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[9px] font-black text-violet-700">Edited</span>}
                                  {!entry.clock_out && <span className="rounded-full bg-rose-50 px-1.5 py-0.5 text-[9px] font-black text-rose-700">Missing clock-out</span>}
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-black text-slate-700">{entry.total_hours != null ? `${entry.total_hours.toFixed(1)}h` : '—'}</span>
                                  <button
                                    onClick={() => { setEditId(entry.id); setEditClockIn(fmtDT(entry.clock_in)); setEditClockOut(entry.clock_out ? fmtDT(entry.clock_out) : ''); setEditBreakMin(String(entry.break_minutes ?? 0)); }}
                                    className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-black text-[#223f7a] hover:bg-slate-200"
                                  >
                                    <Edit3 className="mr-0.5 inline h-3 w-3" />Edit
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {sortedDays.length === 0 && <div className="px-4 py-8 text-center text-sm font-bold text-slate-400">No entries in this period.</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

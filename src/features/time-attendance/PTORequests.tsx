'use client';

import { AlertCircle, Calendar, CheckCircle2, Plus, RefreshCw, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import DatePicker from '../nhwd-shared/DatePicker';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import type { PTOBalance, PTORequest, PTOType } from './types';
import { PTO_STATUS_STYLES, PTO_TYPE_LABELS } from './types';

interface PTORequestsProps { initialProfile: ProfileLite; }

// Count weekdays (Mon-Fri) between two dates inclusive
function countWeekdays(startStr: string, endStr: string): number {
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  if (end < start) return 0;
  let count = 0;
  const current = new Date(start);
  while (current <= end) {
    const dow = current.getDay();
    if (dow !== 0 && dow !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

// Check if start date is at least 2 weeks from today
function isWithinTwoWeeks(startStr: string): boolean {
  if (!startStr) return false;
  const start = new Date(startStr + 'T00:00:00');
  const twoWeeks = new Date();
  twoWeeks.setDate(twoWeeks.getDate() + 14);
  twoWeeks.setHours(0, 0, 0, 0);
  return start < twoWeeks;
}

export default function PTORequests({ initialProfile }: PTORequestsProps) {
  const [requests, setRequests] = useState<PTORequest[]>([]);
  const [balance, setBalance] = useState<PTOBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState<PTOType>('vacation');
  const [formStart, setFormStart] = useState('');
  const [formEnd, setFormEnd] = useState('');
  const [formDays, setFormDays] = useState<number>(0);
  const [formReason, setFormReason] = useState('');
  const [formWarning, setFormWarning] = useState('');
  const [saving, setSaving] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [denialReason, setDenialReason] = useState('');

  const isManager = initialProfile.role === 'manager' || initialProfile.role === 'super_admin';

  // Auto-calculate weekday-only total days and check 2-week notice
  useEffect(() => {
    if (formStart && formEnd) {
      const days = countWeekdays(formStart, formEnd);
      setFormDays(days);
      if (isWithinTwoWeeks(formStart)) {
        setFormWarning('This request is within 2 weeks. The minimum notice period is 2 weeks in advance.');
      } else {
        setFormWarning('');
      }
    } else {
      setFormDays(0);
      setFormWarning('');
    }
  }, [formStart, formEnd]);

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [reqRes, balRes] = await Promise.all([
        fetch(`/api/pto${!isManager ? `?profile_id=${initialProfile.id}` : ''}`),
        fetch(`/api/pto/balance?profile_id=${initialProfile.id}`),
      ]);
      if (!reqRes.ok) throw new Error('Failed to load PTO requests.');
      const reqBody = await reqRes.json();
      setRequests(reqBody.requests as PTORequest[]);
      if (balRes.ok) { const balBody = await balRes.json(); setBalance(balBody.balance); }
    } catch (err) { setError(err instanceof Error ? err.message : 'Load failed.'); }
    finally { setLoading(false); }
  }, [isManager, initialProfile.id]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const handleSubmitRequest = async () => {
    if (!formStart || !formEnd || formDays <= 0) return;
    if (!formReason.trim()) { setError('Reason is required.'); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/pto', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pto_type: formType, start_date: formStart, end_date: formEnd, total_days: formDays, reason: formReason.trim() }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Submit failed.'); }
      setShowForm(false); setFormReason(''); setFormStart(''); setFormEnd(''); setFormWarning('');
      await fetchData();
    } catch (err) { setError(err instanceof Error ? err.message : 'Submit failed.'); }
    finally { setSaving(false); }
  };

  const handleDecision = async (requestId: string, decision: 'approved' | 'denied') => {
    setError(null);
    try {
      const res = await fetch('/api/pto', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: requestId, decision, denial_reason: decision === 'denied' ? denialReason : null }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Decision failed.'); }
      setReviewingId(null); setDenialReason('');
      await fetchData();
    } catch (err) { setError(err instanceof Error ? err.message : 'Decision failed.'); }
  };

  // Minimum date for requests (today)
  const todayStr = new Date().toISOString().split('T')[0];

  return (
    <div className="space-y-5">
      {error && <div className={ui.error}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}

      {/* Balance Card — simplified to vacation + birthday */}
      {balance && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
          <div className={ui.stat}>
            <p className={ui.statLabel}>Vacation Days</p>
            <p className={ui.statValue + ' text-2xl'}>
              {balance.vacation_days - balance.vacation_used}
              <span className="text-sm font-bold text-slate-400">/{balance.vacation_days}</span>
            </p>
            <p className="mt-1 text-xs text-slate-500">10 days per year</p>
          </div>
          <div className={ui.stat}>
            <p className={ui.statLabel}>Birthday Day</p>
            <p className={ui.statValue + ' text-2xl'}>
              {Math.max(0, 1 - (balance.personal_used ?? 0))}
              <span className="text-sm font-bold text-slate-400">/1</span>
            </p>
            <p className="mt-1 text-xs text-slate-500">1 special day per year</p>
          </div>
        </div>
      )}

      {/* Action Bar */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-black text-slate-800"><Calendar className="inline h-4 w-4 mr-1.5" />{isManager ? 'All Time Off Requests' : 'My Time Off Requests'}</h3>
        <div className="flex gap-2">
          <button type="button" onClick={() => void fetchData()} className={ui.btnSecondary + ' text-xs'}><RefreshCw className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => setShowForm(true)} className={ui.btnPrimary + ' text-xs'}><Plus className="h-3.5 w-3.5" /> Request Time Off</button>
        </div>
      </div>

      {/* Requests List */}
      {loading ? (
        <div className="flex items-center justify-center py-12"><RefreshCw className="h-5 w-5 animate-spin text-slate-400" /></div>
      ) : requests.length === 0 ? (
        <div className={ui.empty}>No time off requests.</div>
      ) : (
        <div className="space-y-3">
          {requests.map(req => {
            const statusStyle = PTO_STATUS_STYLES[req.status];
            const typeLabel = PTO_TYPE_LABELS[req.pto_type as PTOType] ?? req.pto_type;
            return (
              <div key={req.id} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-black ${statusStyle.bg} ${statusStyle.text}`}>{statusStyle.label}</span>
                    <span className="text-xs font-bold text-slate-600">{typeLabel}</span>
                  </div>
                  <p className="mt-1 text-sm font-black text-slate-900">
                    {req.start_date} — {req.end_date}{' '}
                    <span className="font-bold text-slate-500">({req.total_days} weekday{req.total_days !== 1 ? 's' : ''})</span>
                  </p>
                  {isManager && req.profiles && <p className="mt-0.5 text-[10px] font-bold text-slate-400">By {req.profiles.display_name}</p>}
                  <p className="mt-1 text-xs text-slate-500">{req.reason}</p>
                  {req.denial_reason && <p className="mt-1 text-xs font-bold text-rose-600">Denied: {req.denial_reason}</p>}
                </div>
                {isManager && req.status === 'pending' && (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void handleDecision(req.id, 'approved')} className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-50 text-emerald-600 hover:bg-emerald-100"><CheckCircle2 className="h-4 w-4" /></button>
                    <button type="button" onClick={() => setReviewingId(req.id)} className="grid h-8 w-8 place-items-center rounded-lg bg-rose-50 text-rose-600 hover:bg-rose-100"><XCircle className="h-4 w-4" /></button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* New Request Form */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={() => setShowForm(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl" onMouseDown={e => e.stopPropagation()}>
            <h3 className="text-lg font-black text-slate-900 mb-4">Request Time Off</h3>
            <div className="space-y-3">
              <div>
                <label className={ui.label}>Type</label>
                <select value={formType} onChange={e => setFormType(e.target.value as PTOType)} className={ui.select}>
                  {Object.entries(PTO_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={ui.label}>Start</label>
                  <DatePicker value={formStart} onChange={setFormStart} min={todayStr} placeholder="Start date" />
                </div>
                <div>
                  <label className={ui.label}>End</label>
                  <DatePicker value={formEnd} onChange={setFormEnd} min={formStart || todayStr} placeholder="End date" />
                </div>
              </div>

              {/* 2-week notice warning */}
              {formWarning && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs font-bold text-amber-800">
                  <AlertCircle className="mr-1.5 inline h-3.5 w-3.5" />{formWarning}
                </div>
              )}

              <div>
                <label className={ui.label}>
                  Weekdays Taken <span className="text-[10px] font-semibold text-slate-400">(weekends excluded)</span>
                </label>
                <input
                  type="text"
                  readOnly
                  value={formDays > 0 ? `${formDays} day${formDays !== 1 ? 's' : ''}` : ''}
                  className={ui.input + ' bg-slate-50 cursor-default'}
                  placeholder="Select dates"
                  tabIndex={-1}
                />
              </div>

              <div>
                <label className={ui.label}>
                  Reason <span className="text-[10px] font-black text-rose-500">*required</span>
                </label>
                <textarea
                  value={formReason}
                  onChange={e => setFormReason(e.target.value)}
                  className={ui.textarea}
                  rows={2}
                  placeholder="Why are you requesting time off?"
                />
              </div>
            </div>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => void handleSubmitRequest()}
                disabled={saving || !formStart || !formEnd || formDays <= 0 || !formReason.trim()}
                className={ui.btnPrimary}
              >
                {saving ? 'Submitting...' : 'Submit Request'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setFormWarning(''); }} className={ui.btnSecondary}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Denial Reason Dialog */}
      {reviewingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={() => { setReviewingId(null); setDenialReason(''); }}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl" onMouseDown={e => e.stopPropagation()}>
            <h3 className="text-lg font-black text-slate-900 mb-3">Deny Time Off Request</h3>
            <div><label className={ui.label}>Reason</label><textarea value={denialReason} onChange={e => setDenialReason(e.target.value)} className={ui.textarea} rows={3} placeholder="Why is this request being denied?" /></div>
            <div className="mt-4 flex gap-3">
              <button type="button" onClick={() => void handleDecision(reviewingId, 'denied')} className={ui.btnDanger}>Deny</button>
              <button type="button" onClick={() => { setReviewingId(null); setDenialReason(''); }} className={ui.btnSecondary}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

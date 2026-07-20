'use client';

import { AlertCircle, Calendar, ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import type { EmployeeSchedule } from './types';
import { SHIFT_TYPE_LABELS } from './types';

interface ScheduleManagerProps {
  initialProfile: ProfileLite;
}

function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function ScheduleManager({ initialProfile }: ScheduleManagerProps) {
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
  const [schedules, setSchedules] = useState<EmployeeSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formDate, setFormDate] = useState('');
  const [formStart, setFormStart] = useState('09:00');
  const [formEnd, setFormEnd] = useState('17:00');
  const [formType, setFormType] = useState('regular');
  const [formProfileId, setFormProfileId] = useState('');
  const [profiles, setProfiles] = useState<Array<{ id: string; display_name: string }>>([]);
  const [saving, setSaving] = useState(false);

  const isManager = initialProfile.role === 'manager';

  const weekDates = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      return d;
    });
  }, [weekStart]);

  const fetchSchedules = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ week: formatDate(weekStart) });
      if (!isManager) params.set('profile_id', initialProfile.id);
      const res = await fetch(`/api/schedules?${params}`);
      if (!res.ok) throw new Error('Failed to load schedules.');
      const body = await res.json();
      setSchedules(body.schedules as EmployeeSchedule[]);
    } catch (err) { setError(err instanceof Error ? err.message : 'Load failed.'); }
    finally { setLoading(false); }
  }, [weekStart, isManager, initialProfile.id]);

  useEffect(() => { void fetchSchedules(); }, [fetchSchedules]);

  useEffect(() => {
    if (!isManager) return;
    fetch('/api/admin/users').then(r => r.json()).then((body) => {
      const users = (body.users ?? []) as Array<{ id: string; display_name: string; is_active: boolean }>;
      setProfiles(users.filter(u => u.is_active).map(u => ({ id: u.id, display_name: u.display_name })));
    }).catch(() => {});
  }, [isManager]);

  const handleCreateSchedule = async () => {
    if (!formDate || !formProfileId) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile_id: formProfileId,
          schedule_date: formDate,
          shift_start: formStart,
          shift_end: formEnd,
          shift_type: formType,
        }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Failed.'); }
      setShowForm(false);
      await fetchSchedules();
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed.'); }
    finally { setSaving(false); }
  };

  const prevWeek = () => { const d = new Date(weekStart); d.setDate(d.getDate() - 7); setWeekStart(d); };
  const nextWeek = () => { const d = new Date(weekStart); d.setDate(d.getDate() + 7); setWeekStart(d); };
  const thisWeek = () => setWeekStart(getMonday(new Date()));

  return (
    <div className="space-y-5">
      {error && <div className={ui.error}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}

      {/* Week nav */}
      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-[#223f7a]" />
          <h3 className="text-sm font-black text-slate-800">
            Week of {weekStart.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={prevWeek} className={ui.btnSecondary + ' px-2 py-2'}><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" onClick={thisWeek} className={ui.btnSecondary + ' text-xs'}>Today</button>
          <button type="button" onClick={nextWeek} className={ui.btnSecondary + ' px-2 py-2'}><ChevronRight className="h-4 w-4" /></button>
          {isManager && <button type="button" onClick={() => setShowForm(true)} className={ui.btnPrimary + ' text-xs'}><Plus className="h-3.5 w-3.5" /> Add Shift</button>}
        </div>
      </div>

      {/* Schedule grid */}
      {loading ? (
        <div className="flex items-center justify-center py-12"><RefreshCw className="h-5 w-5 animate-spin text-slate-400" /></div>
      ) : (
        <div className="grid grid-cols-7 gap-2">
          {weekDates.map((date, i) => {
            const dateStr = formatDate(date);
            const daySchedules = schedules.filter(s => s.schedule_date === dateStr);
            const isToday = formatDate(new Date()) === dateStr;
            return (
              <div key={dateStr} className={`rounded-2xl border p-3 ${isToday ? 'border-[#223f7a] bg-[#f8faff]' : 'border-slate-200 bg-white'}`}>
                <p className={`text-[10px] font-black uppercase ${isToday ? 'text-[#223f7a]' : 'text-slate-400'}`}>{WEEKDAYS[i]}</p>
                <p className={`text-sm font-bold ${isToday ? 'text-[#223f7a]' : 'text-slate-700'}`}>{date.getDate()}</p>
                <div className="mt-2 space-y-1.5">
                  {daySchedules.map(s => (
                    <div key={s.id} className="rounded-lg bg-slate-50 border border-slate-100 px-2 py-1.5">
                      <p className="text-[10px] font-black text-slate-700">{s.profiles?.display_name?.split(' ')[0] ?? '—'}</p>
                      <p className="text-[10px] font-semibold text-slate-500">{s.shift_start?.slice(0,5)} – {s.shift_end?.slice(0,5)}</p>
                      <span className="text-[9px] font-bold text-slate-400">{SHIFT_TYPE_LABELS[s.shift_type]}</span>
                    </div>
                  ))}
                  {daySchedules.length === 0 && <p className="text-[9px] text-slate-300 text-center">—</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add Shift Form */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-black text-slate-900 mb-4">Add Shift</h3>
            <div className="space-y-3">
              <div><label className={ui.label}>Employee</label><select value={formProfileId} onChange={e => setFormProfileId(e.target.value)} className={ui.select}><option value="">Select...</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select></div>
              <div><label className={ui.label}>Date</label><input type="date" value={formDate} onChange={e => setFormDate(e.target.value)} className={ui.input} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={ui.label}>Start</label><input type="time" value={formStart} onChange={e => setFormStart(e.target.value)} className={ui.input} /></div>
                <div><label className={ui.label}>End</label><input type="time" value={formEnd} onChange={e => setFormEnd(e.target.value)} className={ui.input} /></div>
              </div>
              <div><label className={ui.label}>Type</label><select value={formType} onChange={e => setFormType(e.target.value)} className={ui.select}>{Object.entries(SHIFT_TYPE_LABELS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            </div>
            <div className="mt-5 flex gap-3">
              <button type="button" onClick={() => void handleCreateSchedule()} disabled={saving || !formProfileId || !formDate} className={ui.btnPrimary}>{saving ? 'Saving...' : 'Save'}</button>
              <button type="button" onClick={() => setShowForm(false)} className={ui.btnSecondary}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

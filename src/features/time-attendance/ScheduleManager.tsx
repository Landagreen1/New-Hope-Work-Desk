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

function getFirstDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getLastDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function getCalendarDays(monthStart: Date): Date[] {
  const firstDay = new Date(monthStart);
  const lastDay = getLastDayOfMonth(monthStart);

  // Start from Monday of the week containing the 1st
  const startDay = new Date(firstDay);
  const dow = startDay.getDay();
  const diff = dow === 0 ? 6 : dow - 1; // Monday = 0 offset
  startDay.setDate(startDay.getDate() - diff);

  // End on Sunday of the week containing the last day
  const endDay = new Date(lastDay);
  const endDow = endDay.getDay();
  const endDiff = endDow === 0 ? 0 : 7 - endDow;
  endDay.setDate(endDay.getDate() + endDiff);

  const days: Date[] = [];
  const current = new Date(startDay);
  while (current <= endDay) {
    days.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return days;
}

const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function ScheduleManager({ initialProfile }: ScheduleManagerProps) {
  const [currentMonth, setCurrentMonth] = useState(() => getFirstDayOfMonth(new Date()));
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

  const isManager = initialProfile.role === 'manager' || initialProfile.role === 'super_admin';

  const calendarDays = useMemo(() => getCalendarDays(currentMonth), [currentMonth]);

  // Fetch schedules for the entire visible range (may span prev/next month padding)
  const fetchSchedules = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const rangeStart = calendarDays[0];
      const rangeEnd = calendarDays[calendarDays.length - 1];
      const params = new URLSearchParams({
        month_start: formatDate(rangeStart),
        month_end: formatDate(rangeEnd),
      });
      if (!isManager) params.set('profile_id', initialProfile.id);
      const res = await fetch(`/api/schedules?${params}`);
      if (!res.ok) throw new Error('Failed to load schedules.');
      const body = await res.json();
      setSchedules(body.schedules as EmployeeSchedule[]);
    } catch (err) { setError(err instanceof Error ? err.message : 'Load failed.'); }
    finally { setLoading(false); }
  }, [calendarDays, isManager, initialProfile.id]);

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

  const prevMonth = () => {
    const d = new Date(currentMonth);
    d.setMonth(d.getMonth() - 1);
    setCurrentMonth(d);
  };
  const nextMonth = () => {
    const d = new Date(currentMonth);
    d.setMonth(d.getMonth() + 1);
    setCurrentMonth(d);
  };
  const goToday = () => setCurrentMonth(getFirstDayOfMonth(new Date()));

  const todayStr = formatDate(new Date());

  // Group schedules by date for quick lookup
  const schedulesByDate = useMemo(() => {
    const map: Record<string, EmployeeSchedule[]> = {};
    for (const s of schedules) {
      const key = s.schedule_date;
      if (!map[key]) map[key] = [];
      map[key].push(s);
    }
    return map;
  }, [schedules]);

  const monthLabel = currentMonth.toLocaleDateString([], { month: 'long', year: 'numeric' });

  return (
    <div className="space-y-5">
      {error && <div className={ui.error}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}

      {/* Month navigation */}
      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-[#223f7a]" />
          <h3 className="text-sm font-black text-slate-800">{monthLabel}</h3>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={prevMonth} className={ui.btnSecondary + ' px-2 py-2'}><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" onClick={goToday} className={ui.btnSecondary + ' text-xs'}>Today</button>
          <button type="button" onClick={nextMonth} className={ui.btnSecondary + ' px-2 py-2'}><ChevronRight className="h-4 w-4" /></button>
          {isManager && <button type="button" onClick={() => setShowForm(true)} className={ui.btnPrimary + ' text-xs'}><Plus className="h-3.5 w-3.5" /> Add Shift</button>}
        </div>
      </div>

      {/* Monthly calendar grid */}
      {loading ? (
        <div className="flex items-center justify-center py-12"><RefreshCw className="h-5 w-5 animate-spin text-slate-400" /></div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          {/* Weekday headers */}
          <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50">
            {WEEKDAY_HEADERS.map((day) => (
              <div key={day} className="px-2 py-2 text-center text-[10px] font-black uppercase text-slate-400">
                {day}
              </div>
            ))}
          </div>

          {/* Calendar days */}
          <div className="grid grid-cols-7">
            {calendarDays.map((date) => {
              const dateStr = formatDate(date);
              const isToday = dateStr === todayStr;
              const isCurrentMonth = date.getMonth() === currentMonth.getMonth();
              const daySchedules = schedulesByDate[dateStr] ?? [];

              return (
                <div
                  key={dateStr}
                  className={`min-h-[90px] border-b border-r border-slate-100 p-1.5 transition-colors ${
                    isToday
                      ? 'bg-[#f0f4ff] ring-1 ring-inset ring-[#223f7a]/20'
                      : isCurrentMonth
                        ? 'bg-white'
                        : 'bg-slate-50/50'
                  }`}
                >
                  <p className={`text-xs font-bold ${
                    isToday
                      ? 'text-[#223f7a]'
                      : isCurrentMonth
                        ? 'text-slate-700'
                        : 'text-slate-300'
                  }`}>
                    {date.getDate()}
                  </p>
                  <div className="mt-1 space-y-0.5 overflow-y-auto max-h-[60px]">
                    {daySchedules.map((s) => (
                      <div
                        key={s.id}
                        className="rounded px-1.5 py-0.5 bg-gradient-to-r from-[#223f7a]/10 to-[#223f7a]/5 border border-[#223f7a]/10"
                      >
                        {isManager && (
                          <p className="text-[9px] font-black text-[#223f7a] truncate">
                            {s.profiles?.display_name?.split(' ')[0] ?? '—'}
                          </p>
                        )}
                        <p className="text-[9px] font-semibold text-slate-600">
                          {s.shift_start?.slice(0, 5)} – {s.shift_end?.slice(0, 5)}
                        </p>
                        <span className="text-[8px] font-bold text-slate-400">{SHIFT_TYPE_LABELS[s.shift_type]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Add Shift Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-black text-slate-900 mb-4">Add Shift</h3>
            <div className="space-y-3">
              <div>
                <label className={ui.label}>Employee</label>
                <select value={formProfileId} onChange={e => setFormProfileId(e.target.value)} className={ui.select}>
                  <option value="">Select...</option>
                  {profiles.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
                </select>
              </div>
              <div>
                <label className={ui.label}>Date</label>
                <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)} className={ui.input} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={ui.label}>Start</label><input type="time" value={formStart} onChange={e => setFormStart(e.target.value)} className={ui.input} /></div>
                <div><label className={ui.label}>End</label><input type="time" value={formEnd} onChange={e => setFormEnd(e.target.value)} className={ui.input} /></div>
              </div>
              <div>
                <label className={ui.label}>Type</label>
                <select value={formType} onChange={e => setFormType(e.target.value)} className={ui.select}>
                  {Object.entries(SHIFT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
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

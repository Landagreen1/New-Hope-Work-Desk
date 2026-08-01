'use client';

import { AlertCircle, Calendar, Check, ChevronLeft, ChevronRight, Copy, Plus, RefreshCw, Trash2, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { canAdministerAttendance } from '@/lib/permissions';

import DatePicker from '../nhwd-shared/DatePicker';
import TimePicker from '../nhwd-shared/TimePicker';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import { formatScheduledTimeOfDay, formatTimeZoneName } from './shared/format';
import type { EmployeeSchedule } from './types';
import { SHIFT_TYPE_LABELS } from './types';

interface ScheduleManagerProps {
  initialProfile: ProfileLite;
  /**
   * `attendance_policy.business_timezone`: the zone `shift_start` and `shift_end`
   * are written in, and so the zone a stored shift time has to be read in before
   * it can be shown on an employee's own clock (Requirement 3, criterion 7).
   *
   * Optional because the workspace takes it off `/api/attendance/day` and that
   * read may still be outstanding on first render. Until it arrives, and for an
   * employee whose zone is the business zone, times show exactly as stored.
   */
  businessTimeZone?: string;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ─── Timezone Conversion ──────────────────────────────────────────────────────
//
// There is none here any more. A stored shift time is placed on an employee's
// clock by `formatScheduledTimeOfDay`, which composes the module's two zone
// conversions from `domain/work-date.ts`, and the zone is named by
// `formatTimeZoneName`. Both live in `shared/format.ts`, which is the one place
// the module spells a time (Requirement 19, criterion 9).
//
// What was here was a table of hour offsets — minus one for Guayaquil, minus two
// for Tegucigalpa — applied against a fixed Eastern Daylight Time baseline. It
// ignored daylight saving in all three zones, so it was wrong for roughly half
// the year, and it silently answered zero for any zone not in its table.

// ─── Schedule Templates ───────────────────────────────────────────────────────

interface ScheduleTemplate {
  id: string;
  label: string;
  description: string;
  shifts: Array<{ dayOfWeek: number; start: string; end: string }>; // 0=Mon, 5=Sat, 6=Sun
}

const TEMPLATES: ScheduleTemplate[] = [
  {
    id: 'regular_weekday',
    label: 'Regular (Mon-Fri)',
    description: '09:00 - 17:30, Monday through Friday',
    shifts: [
      { dayOfWeek: 0, start: '09:00', end: '17:30' },
      { dayOfWeek: 1, start: '09:00', end: '17:30' },
      { dayOfWeek: 2, start: '09:00', end: '17:30' },
      { dayOfWeek: 3, start: '09:00', end: '17:30' },
      { dayOfWeek: 4, start: '09:00', end: '17:30' },
    ],
  },
  {
    id: 'regular_with_saturday',
    label: 'Regular + Saturday',
    description: '09:00 - 17:30 weekdays, 10:00 - 17:30 Saturday',
    shifts: [
      { dayOfWeek: 0, start: '09:00', end: '17:30' },
      { dayOfWeek: 1, start: '09:00', end: '17:30' },
      { dayOfWeek: 2, start: '09:00', end: '17:30' },
      { dayOfWeek: 3, start: '09:00', end: '17:30' },
      { dayOfWeek: 4, start: '09:00', end: '17:30' },
      { dayOfWeek: 5, start: '10:00', end: '17:30' },
    ],
  },
  {
    id: 'saturday_only',
    label: 'Saturday Only',
    description: '10:00 - 17:30, Saturday',
    shifts: [
      { dayOfWeek: 5, start: '10:00', end: '17:30' },
    ],
  },
  {
    id: 'after_hours_weekday',
    label: 'After Hours (Mon-Fri)',
    description: '12:00 - 20:30, Monday through Friday',
    shifts: [
      { dayOfWeek: 0, start: '12:00', end: '20:30' },
      { dayOfWeek: 1, start: '12:00', end: '20:30' },
      { dayOfWeek: 2, start: '12:00', end: '20:30' },
      { dayOfWeek: 3, start: '12:00', end: '20:30' },
      { dayOfWeek: 4, start: '12:00', end: '20:30' },
    ],
  },
  {
    id: 'after_hours_saturday',
    label: 'After Hours + Saturday',
    description: '12:00 - 20:30 weekdays, 12:00 - 20:30 Saturday',
    shifts: [
      { dayOfWeek: 0, start: '12:00', end: '20:30' },
      { dayOfWeek: 1, start: '12:00', end: '20:30' },
      { dayOfWeek: 2, start: '12:00', end: '20:30' },
      { dayOfWeek: 3, start: '12:00', end: '20:30' },
      { dayOfWeek: 4, start: '12:00', end: '20:30' },
      { dayOfWeek: 5, start: '12:00', end: '20:30' },
    ],
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScheduleManager({ initialProfile, businessTimeZone }: ScheduleManagerProps) {
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
  const [schedules, setSchedules] = useState<EmployeeSchedule[]>([]);
  const [profiles, setProfiles] = useState<Array<{ id: string; display_name: string; initials: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Add shift form
  const [showAddForm, setShowAddForm] = useState(false);
  const [formProfileId, setFormProfileId] = useState('');
  const [formDate, setFormDate] = useState('');
  const [formStart, setFormStart] = useState('09:00');
  const [formEnd, setFormEnd] = useState('17:30');
  const [formType, setFormType] = useState('regular');
  const [saving, setSaving] = useState(false);

  // Template apply modal
  const [showTemplate, setShowTemplate] = useState(false);
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  const [templateProfiles, setTemplateProfiles] = useState<string[]>([]);
  const [applyingTemplate, setApplyingTemplate] = useState(false);

  const canAdminister = canAdministerAttendance(initialProfile.role);

  const weekDates = useMemo(() =>
    Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]
  );

  // ─── Data loading ─────────────────────────────────────────────────────────

  const fetchSchedules = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ week: formatDate(weekStart) });
      if (!canAdminister) params.set('profile_id', initialProfile.id);
      const res = await fetch(`/api/schedules?${params}`);
      if (!res.ok) throw new Error('Failed to load schedules.');
      const body = await res.json();
      setSchedules(body.schedules as EmployeeSchedule[]);
    } catch (err) { setError(err instanceof Error ? err.message : 'Load failed.'); }
    finally { setLoading(false); }
  }, [weekStart, canAdminister, initialProfile.id]);

  useEffect(() => { void fetchSchedules(); }, [fetchSchedules]);

  useEffect(() => {
    if (!canAdminister) return;
    fetch('/api/admin/users').then(r => r.json()).then((body) => {
      const users = (body.users ?? []) as Array<{ id: string; display_name: string; initials: string; is_active: boolean }>;
      setProfiles(users.filter(u => u.is_active).map(u => ({ id: u.id, display_name: u.display_name, initials: u.initials || u.display_name.slice(0, 2).toUpperCase() })));
    }).catch(() => {});
  }, [canAdminister]);

  // ─── Actions ──────────────────────────────────────────────────────────────

  const prevWeek = () => setWeekStart(addDays(weekStart, -7));
  const nextWeek = () => setWeekStart(addDays(weekStart, 7));
  const goToday = () => setWeekStart(getMonday(new Date()));

  const handleCreateShift = async () => {
    if (!formProfileId || !formDate) return;
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
      setShowAddForm(false);
      setNotice('Shift added.');
      await fetchSchedules();
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed.'); }
    finally { setSaving(false); }
  };

  const handleDeleteShift = async (scheduleId: string) => {
    if (!window.confirm('Delete this shift?')) return;
    try {
      const res = await fetch('/api/schedules', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule_id: scheduleId }),
      });
      if (!res.ok) throw new Error('Delete failed.');
      await fetchSchedules();
    } catch (err) { setError(err instanceof Error ? err.message : 'Delete failed.'); }
  };

  /**
   * Apply the selected template to the selected employees, as one request.
   *
   * Requirement 20, criterion 7: the whole set goes in a single POST. It used to
   * be one request per employee per shift — thirty employees on a six-day
   * template was 180 requests, fired at once and settled individually, so a
   * partial application was the normal outcome of any interruption. One request
   * is one upsert: every row lands or none does.
   */
  const handleApplyTemplate = async () => {
    const template = TEMPLATES.find(t => t.id === templateId);
    if (!templateProfiles.length || !template) return;

    const rows = templateProfiles.flatMap(profileId =>
      template.shifts.map(shift => ({
        profile_id: profileId,
        schedule_date: formatDate(addDays(weekStart, shift.dayOfWeek)),
        shift_start: shift.start,
        shift_end: shift.end,
        shift_type: 'regular',
      })),
    );

    setApplyingTemplate(true); setError(null);
    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rows),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Template apply failed.'); }
      const applied = (await res.json().catch(() => ({}))) as { created?: number };
      const count = typeof applied.created === 'number' ? applied.created : rows.length;
      setShowTemplate(false);
      setTemplateProfiles([]);
      setNotice(`Template applied: ${count} shift${count !== 1 ? 's' : ''} scheduled.`);
      await fetchSchedules();
    } catch (err) { setError(err instanceof Error ? err.message : 'Template apply failed.'); }
    finally { setApplyingTemplate(false); }
  };

  // ─── Derived data ─────────────────────────────────────────────────────────

  // Group schedules: { [date]: { [profileId]: EmployeeSchedule[] } }
  const scheduleGrid = useMemo(() => {
    const grid: Record<string, Record<string, EmployeeSchedule[]>> = {};
    for (const date of weekDates) {
      grid[formatDate(date)] = {};
    }
    for (const s of schedules) {
      const key = s.schedule_date;
      if (!grid[key]) grid[key] = {};
      if (!grid[key][s.profile_id]) grid[key][s.profile_id] = [];
      grid[key][s.profile_id].push(s);
    }
    return grid;
  }, [schedules, weekDates]);

  // Unique employees who have at least one shift this week
  const scheduledEmployees = useMemo(() => {
    const idSet = new Set<string>();
    for (const s of schedules) idSet.add(s.profile_id);
    // If attendance admin, also show all active employees
    if (canAdminister) {
      for (const p of profiles) idSet.add(p.id);
    }
    const list = Array.from(idSet).map(id => {
      const profile = profiles.find(p => p.id === id);
      const fromSchedule = schedules.find(s => s.profile_id === id);
      return {
        id,
        display_name: profile?.display_name ?? fromSchedule?.profiles?.display_name ?? 'Unknown',
        initials: profile?.initials ?? fromSchedule?.profiles?.initials ?? '??',
        // `profiles.timezone`, carried on the joined schedule row. An employee with
        // no shift this week has no row to carry it, and the business zone is the
        // right answer there: it is the zone the grid's own times are stored in.
        timezone: fromSchedule?.profiles?.timezone ?? businessTimeZone,
      };
    });
    return list.sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [schedules, profiles, canAdminister, businessTimeZone]);

  // Count per day
  const dailyCounts = useMemo(() => {
    return weekDates.map(date => {
      const dateStr = formatDate(date);
      const uniqueProfiles = new Set<string>();
      for (const s of schedules) {
        if (s.schedule_date === dateStr) uniqueProfiles.add(s.profile_id);
      }
      return uniqueProfiles.size;
    });
  }, [schedules, weekDates]);

  const todayStr = formatDate(new Date());

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {error && <div className={ui.error}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}
      {notice && <div className={ui.success} onClick={() => setNotice(null)}>{notice}</div>}

      {/* Week navigation + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <Calendar className="h-5 w-5 text-[#223f7a]" />
          <div>
            <h3 className="text-sm font-black text-slate-900">
              {formatShortDate(weekStart)} – {formatShortDate(addDays(weekStart, 6))}
            </h3>
            <p className="text-xs font-semibold text-slate-400">Weekly Schedule</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={prevWeek} className={ui.btnSecondary + ' !px-2.5 !py-2'}><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" onClick={goToday} className={ui.btnSecondary + ' !text-xs'}>This Week</button>
          <button type="button" onClick={nextWeek} className={ui.btnSecondary + ' !px-2.5 !py-2'}><ChevronRight className="h-4 w-4" /></button>
          {canAdminister && (
            <>
              <button type="button" onClick={() => setShowTemplate(true)} className={ui.btnSecondary + ' !text-xs'}>
                <Copy className="h-3.5 w-3.5" /> Apply Template
              </button>
              <button type="button" onClick={() => { setShowAddForm(true); setFormDate(formatDate(weekStart)); }} className={ui.btnPrimary + ' !text-xs'}>
                <Plus className="h-3.5 w-3.5" /> Add Shift
              </button>
            </>
          )}
        </div>
      </div>

      {/* Weekly grid */}
      {loading ? (
        <div className="flex items-center justify-center py-12"><RefreshCw className="h-5 w-5 animate-spin text-slate-400" /></div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          {/* Day headers */}
          <div className="grid grid-cols-[180px_repeat(7,1fr)] border-b border-slate-100 bg-slate-50">
            <div className="flex items-center gap-2 px-4 py-3">
              <Users className="h-4 w-4 text-slate-400" />
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Employee</span>
            </div>
            {weekDates.map((date, i) => {
              const dateStr = formatDate(date);
              const isToday = dateStr === todayStr;
              const isSat = i === 5;
              const isSun = i === 6;
              return (
                <div
                  key={dateStr}
                  className={`px-2 py-3 text-center border-l border-slate-100 ${isToday ? 'bg-[#eef3fb]' : ''}`}
                >
                  <p className={`text-[10px] font-black uppercase tracking-wider ${isToday ? 'text-[#223f7a]' : isSat || isSun ? 'text-violet-600' : 'text-slate-400'}`}>
                    {WEEKDAYS[i]}
                  </p>
                  <p className={`text-sm font-black ${isToday ? 'text-[#223f7a]' : 'text-slate-700'}`}>
                    {date.getDate()}
                  </p>
                  <p className="mt-1 text-[10px] font-bold text-slate-400">
                    {dailyCounts[i]} staff
                  </p>
                </div>
              );
            })}
          </div>

          {/* Employee rows */}
          <div className="divide-y divide-slate-100">
            {scheduledEmployees.map((emp) => (
              <div key={emp.id} className="grid grid-cols-[180px_repeat(7,1fr)] min-h-[60px]">
                {/* Employee name */}
                <div className="flex items-center gap-3 px-4 py-3 border-r border-slate-100">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#223f7a] text-[10px] font-black text-white">
                    {emp.initials}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-black text-slate-800 truncate">{emp.display_name}</p>
                    <p className="text-[9px] font-bold text-slate-400">{formatTimeZoneName(emp.timezone)}</p>
                  </div>
                </div>

                {/* Day cells */}
                {weekDates.map((date) => {
                  const dateStr = formatDate(date);
                  const isToday = dateStr === todayStr;
                  const shifts = scheduleGrid[dateStr]?.[emp.id] ?? [];
                  return (
                    <div
                      key={dateStr}
                      className={`relative px-1.5 py-2 border-l border-slate-100 ${isToday ? 'bg-[#f8faff]' : ''}`}
                    >
                      {shifts.length > 0 ? (
                        <div className="space-y-1">
                          {shifts.map((s) => (
                            <div
                              key={s.id}
                              className="group relative rounded-lg bg-gradient-to-r from-[#223f7a]/10 to-[#223f7a]/5 border border-[#223f7a]/15 px-2 py-1.5"
                            >
                              <p className="text-[11px] font-black text-[#223f7a]">
                                {formatScheduledTimeOfDay(s.schedule_date, s.shift_start, businessTimeZone, emp.timezone)}
                                {' – '}
                                {formatScheduledTimeOfDay(s.schedule_date, s.shift_end, businessTimeZone, emp.timezone)}
                              </p>
                              <p className="text-[9px] font-bold text-slate-500">{SHIFT_TYPE_LABELS[s.shift_type]}</p>
                              {canAdminister && (
                                <button
                                  onClick={() => void handleDeleteShift(s.id)}
                                  className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-white group-hover:flex"
                                  title="Delete shift"
                                >
                                  <X className="h-2.5 w-2.5" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex h-full items-center justify-center">
                          {canAdminister ? (
                            <button
                              onClick={() => {
                                setFormProfileId(emp.id);
                                setFormDate(dateStr);
                                setFormStart('09:00');
                                setFormEnd('17:30');
                                setShowAddForm(true);
                              }}
                              className="rounded-lg border border-dashed border-slate-200 p-2 text-slate-300 transition hover:border-[#223f7a] hover:text-[#223f7a]"
                              title="Add shift"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-300">Off</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

            {!scheduledEmployees.length && (
              <div className="p-8 text-center text-sm font-bold text-slate-400">
                No employees scheduled this week. Use &quot;Apply Template&quot; to set up the week.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Add Shift Modal ────────────────────────────────────────────── */}
      {showAddForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={() => setShowAddForm(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl" onMouseDown={e => e.stopPropagation()}>
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
                <DatePicker value={formDate} onChange={setFormDate} placeholder="Select date" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={ui.label}>Start</label><TimePicker value={formStart} onChange={setFormStart} /></div>
                <div><label className={ui.label}>End</label><TimePicker value={formEnd} onChange={setFormEnd} /></div>
              </div>
              <div>
                <label className={ui.label}>Type</label>
                <select value={formType} onChange={e => setFormType(e.target.value)} className={ui.select}>
                  {Object.entries(SHIFT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>
            <div className="mt-5 flex gap-3">
              <button type="button" onClick={() => void handleCreateShift()} disabled={saving || !formProfileId || !formDate} className={ui.btnPrimary}>{saving ? 'Saving...' : 'Save Shift'}</button>
              <button type="button" onClick={() => setShowAddForm(false)} className={ui.btnSecondary}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Apply Template Modal ───────────────────────────────────────── */}
      {showTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={() => setShowTemplate(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl" onMouseDown={e => e.stopPropagation()}>
            <h3 className="text-lg font-black text-slate-900">Apply Schedule Template</h3>
            <p className="mt-1 text-sm text-slate-500">
              Select a template and employees to schedule for the week of{' '}
              <span className="font-bold">{formatShortDate(weekStart)} – {formatShortDate(addDays(weekStart, 6))}</span>.
            </p>

            {/* Template selection */}
            <div className="mt-5 space-y-2">
              <label className={ui.label}>Template</label>
              <div className="mt-2 space-y-2">
                {TEMPLATES.map((t) => (
                  <label
                    key={t.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${templateId === t.id ? 'border-[#223f7a] bg-[#f0f4ff]' : 'border-slate-200 hover:border-slate-300'}`}
                  >
                    <input
                      type="radio"
                      name="template"
                      value={t.id}
                      checked={templateId === t.id}
                      onChange={() => setTemplateId(t.id)}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-black text-slate-900">{t.label}</p>
                      <p className="text-xs text-slate-500">{t.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Employee selection */}
            <div className="mt-5">
              <label className={ui.label}>Assign To</label>
              <div className="mt-2 grid grid-cols-2 gap-2 max-h-[200px] overflow-y-auto rounded-xl border border-slate-200 p-3">
                {profiles.map((p) => {
                  const selected = templateProfiles.includes(p.id);
                  return (
                    <label
                      key={p.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition ${selected ? 'bg-[#223f7a] text-white' : 'hover:bg-slate-50'}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => setTemplateProfiles(prev =>
                          selected ? prev.filter(id => id !== p.id) : [...prev, p.id]
                        )}
                        className="sr-only"
                      />
                      <div className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[8px] font-black ${selected ? 'bg-white/20 text-white' : 'bg-[#223f7a] text-white'}`}>
                        {p.initials}
                      </div>
                      <span className={`text-xs font-bold truncate ${selected ? 'text-white' : 'text-slate-700'}`}>
                        {p.display_name}
                      </span>
                      {selected && <Check className="ml-auto h-3.5 w-3.5 shrink-0" />}
                    </label>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => setTemplateProfiles(profiles.map(p => p.id))}
                className="mt-2 text-xs font-bold text-[#223f7a] hover:underline"
              >
                Select all
              </button>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => void handleApplyTemplate()}
                disabled={applyingTemplate || !templateProfiles.length}
                className={ui.btnPrimary}
              >
                {applyingTemplate ? 'Applying...' : `Apply to ${templateProfiles.length} employee${templateProfiles.length !== 1 ? 's' : ''}`}
              </button>
              <button type="button" onClick={() => setShowTemplate(false)} className={ui.btnSecondary}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

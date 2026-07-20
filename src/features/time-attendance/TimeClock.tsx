'use client';

import {
  AlertCircle,
  Clock,
  Coffee,
  LogIn,
  LogOut,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import type { ClockStatus, TimeClockEntry } from './types';
import { CLOCK_STATUS_STYLES } from './types';

interface TimeClockProps {
  initialProfile: ProfileLite;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
}

function formatHours(hours: number | null): string {
  if (hours === null) return '—';
  return `${hours.toFixed(2)} hrs`;
}

export default function TimeClock({ initialProfile }: TimeClockProps) {
  const [clockedIn, setClockedIn] = useState(false);
  const [currentEntry, setCurrentEntry] = useState<{ id: string; clock_in: string; clock_status: ClockStatus; break_minutes: number } | null>(null);
  const [activeBreak, setActiveBreak] = useState<{ id: string; break_start: string; break_type: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [breakElapsed, setBreakElapsed] = useState(0);
  const [todayEntries, setTodayEntries] = useState<TimeClockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const breakTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Fetch active state ─────────────────────────────────────────────────────
  const fetchActive = useCallback(async () => {
    try {
      const res = await fetch('/api/time-clock/active');
      if (!res.ok) throw new Error('Failed to get clock status.');
      const body = await res.json();
      setClockedIn(body.clocked_in);
      setCurrentEntry(body.entry);
      setActiveBreak(body.active_break);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed.');
    }
  }, []);

  const fetchToday = useCallback(async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const res = await fetch(`/api/time-clock?date=${today}&range=week`);
      if (!res.ok) throw new Error('Failed to load history.');
      const body = await res.json();
      setTodayEntries(body.entries as TimeClockEntry[]);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    void Promise.all([fetchActive(), fetchToday()]).finally(() => setLoading(false));
  }, [fetchActive, fetchToday]);

  // ─── Timer ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (clockedIn && currentEntry) {
      const start = new Date(currentEntry.clock_in).getTime();
      const tick = () => setElapsed(Date.now() - start);
      tick();
      timerRef.current = setInterval(tick, 1000);
      return () => { if (timerRef.current) clearInterval(timerRef.current); };
    } else {
      setElapsed(0);
    }
  }, [clockedIn, currentEntry]);

  useEffect(() => {
    if (activeBreak) {
      const start = new Date(activeBreak.break_start).getTime();
      const tick = () => setBreakElapsed(Date.now() - start);
      tick();
      breakTimerRef.current = setInterval(tick, 1000);
      return () => { if (breakTimerRef.current) clearInterval(breakTimerRef.current); };
    } else {
      setBreakElapsed(0);
    }
  }, [activeBreak]);

  // ─── Actions ────────────────────────────────────────────────────────────────
  const handleClockIn = async (status: ClockStatus = 'available') => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/time-clock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Clock in failed.'); }
      await fetchActive();
      await fetchToday();
    } catch (err) { setError(err instanceof Error ? err.message : 'Clock in failed.'); }
    finally { setBusy(false); }
  };

  const handleClockOut = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/time-clock', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clock_out' }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Clock out failed.'); }
      setClockedIn(false); setCurrentEntry(null); setActiveBreak(null);
      await fetchToday();
    } catch (err) { setError(err instanceof Error ? err.message : 'Clock out failed.'); }
    finally { setBusy(false); }
  };

  const handleChangeStatus = async (status: ClockStatus) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/time-clock', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'change_status', status }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Status change failed.'); }
      await fetchActive();
    } catch (err) { setError(err instanceof Error ? err.message : 'Status change failed.'); }
    finally { setBusy(false); }
  };

  const handleStartBreak = async (type: string = 'lunch') => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/time-clock/breaks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ break_type: type }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Break start failed.'); }
      await fetchActive();
    } catch (err) { setError(err instanceof Error ? err.message : 'Break start failed.'); }
    finally { setBusy(false); }
  };

  const handleEndBreak = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/time-clock/breaks', { method: 'PATCH' });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Break end failed.'); }
      await fetchActive();
    } catch (err) { setError(err instanceof Error ? err.message : 'Break end failed.'); }
    finally { setBusy(false); }
  };

  // ─── Computed ───────────────────────────────────────────────────────────────
  const todayHours = todayEntries
    .filter((e) => e.total_hours !== null)
    .reduce((sum, e) => sum + (e.total_hours ?? 0), 0);

  const weekHours = todayEntries
    .filter((e) => e.total_hours !== null)
    .reduce((sum, e) => sum + (e.total_hours ?? 0), 0);

  const statusStyle = currentEntry ? CLOCK_STATUS_STYLES[currentEntry.clock_status] : null;

  // ─── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
        <span className="ml-2 text-sm font-semibold text-slate-500">Loading clock...</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Error */}
      {error && (
        <div className={ui.error}>
          <AlertCircle className="mr-2 inline h-4 w-4" />{error}
          <button type="button" onClick={() => setError(null)} className="ml-3 text-xs underline">Dismiss</button>
        </div>
      )}

      {/* Main Clock Card */}
      <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col items-center gap-5 lg:flex-row lg:items-start lg:justify-between">
          {/* Left: Status + Timer */}
          <div className="text-center lg:text-left">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
              {clockedIn ? 'Currently Clocked In' : 'Not Clocked In'}
            </p>
            {clockedIn && statusStyle && (
              <div className="mt-2 flex items-center justify-center gap-2 lg:justify-start">
                <span className={`h-3 w-3 rounded-full ${statusStyle.dot} animate-pulse`} />
                <span className={`rounded-full px-3 py-1 text-xs font-black ${statusStyle.bg} ${statusStyle.text}`}>
                  {statusStyle.label}
                </span>
              </div>
            )}
            {/* Live timer */}
            <p className="mt-3 font-mono text-4xl font-black tracking-tight text-slate-900 sm:text-5xl">
              {clockedIn ? formatElapsed(elapsed) : '00:00:00'}
            </p>
            {clockedIn && currentEntry && (
              <p className="mt-2 text-xs font-semibold text-slate-500">
                Clocked in at {formatTime(currentEntry.clock_in)}
                {currentEntry.break_minutes > 0 && ` · ${currentEntry.break_minutes} min break`}
              </p>
            )}
            {/* Break timer */}
            {activeBreak && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2">
                <p className="text-xs font-black text-amber-700">On Break · {formatElapsed(breakElapsed)}</p>
              </div>
            )}
          </div>

          {/* Right: Actions */}
          <div className="flex flex-col items-center gap-3">
            {!clockedIn ? (
              /* Clock In Button */
              <button
                type="button"
                onClick={() => void handleClockIn('available')}
                disabled={busy}
                className="grid h-28 w-28 place-items-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-200 transition hover:bg-emerald-600 hover:shadow-xl disabled:opacity-50"
              >
                <LogIn className="h-10 w-10" />
              </button>
            ) : (
              /* Clock Out Button */
              <button
                type="button"
                onClick={() => void handleClockOut()}
                disabled={busy}
                className="grid h-28 w-28 place-items-center rounded-full bg-rose-500 text-white shadow-lg shadow-rose-200 transition hover:bg-rose-600 hover:shadow-xl disabled:opacity-50"
              >
                <LogOut className="h-10 w-10" />
              </button>
            )}
            <p className="text-xs font-black text-slate-500">
              {!clockedIn ? 'Clock In' : 'Clock Out'}
            </p>

            {/* Break & Status controls (only when clocked in) */}
            {clockedIn && (
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {!activeBreak ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleStartBreak('lunch')}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-black text-amber-700 transition hover:bg-amber-100 disabled:opacity-50"
                    >
                      <Coffee className="h-3.5 w-3.5" /> Lunch
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleStartBreak('short')}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      <Pause className="h-3.5 w-3.5" /> Short Break
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleEndBreak()}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50"
                  >
                    <Play className="h-3.5 w-3.5" /> End Break
                  </button>
                )}
              </div>
            )}

            {/* Status switcher */}
            {clockedIn && !activeBreak && (
              <div className="mt-2 flex gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
                {(['available', 'lunch', 'unavailable'] as ClockStatus[]).map((s) => {
                  const style = CLOCK_STATUS_STYLES[s];
                  const isActive = currentEntry?.clock_status === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void handleChangeStatus(s)}
                      disabled={busy || isActive}
                      className={`rounded-lg px-2.5 py-1.5 text-[10px] font-black transition ${
                        isActive ? `${style.bg} ${style.text}` : 'text-slate-500 hover:bg-white'
                      } disabled:opacity-50`}
                    >
                      {style.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className={ui.stat}>
          <p className={ui.statLabel}>Today</p>
          <p className={ui.statValue + ' text-2xl'}>{todayHours.toFixed(1)}h</p>
        </div>
        <div className={ui.stat}>
          <p className={ui.statLabel}>This Week</p>
          <p className={ui.statValue + ' text-2xl'}>{weekHours.toFixed(1)}h</p>
        </div>
        <div className={ui.stat}>
          <p className={ui.statLabel}>Breaks Today</p>
          <p className={ui.statValue + ' text-2xl'}>{currentEntry?.break_minutes ?? 0}m</p>
        </div>
        <div className={ui.stat}>
          <p className={ui.statLabel}>Entries This Week</p>
          <p className={ui.statValue + ' text-2xl'}>{todayEntries.length}</p>
        </div>
      </div>

      {/* Recent History */}
      <div className={ui.card + ' overflow-hidden'}>
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 className="text-sm font-black text-slate-800">
            <Clock className="inline h-4 w-4 mr-1.5 text-[#223f7a]" />
            Recent Clock History
          </h3>
        </div>
        <div className="divide-y divide-slate-100">
          {todayEntries.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm font-semibold text-slate-400">
              No clock entries this week.
            </div>
          ) : (
            todayEntries.slice(0, 10).map((entry) => (
              <div key={entry.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <p className="text-sm font-bold text-slate-800">
                    {formatTime(entry.clock_in)}
                    {entry.clock_out ? ` — ${formatTime(entry.clock_out)}` : ' — Active'}
                  </p>
                  <p className="mt-0.5 text-[10px] font-semibold text-slate-400">
                    {new Date(entry.clock_in).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                    {entry.break_minutes > 0 && ` · ${entry.break_minutes}m break`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${CLOCK_STATUS_STYLES[entry.clock_status].bg} ${CLOCK_STATUS_STYLES[entry.clock_status].text}`}>
                    {CLOCK_STATUS_STYLES[entry.clock_status].label}
                  </span>
                  <span className="text-xs font-black text-slate-600">
                    {formatHours(entry.total_hours)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

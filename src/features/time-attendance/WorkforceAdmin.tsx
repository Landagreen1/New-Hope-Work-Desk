'use client';

import { AlertCircle, Check, Clock, DollarSign, Edit3, PalmtreeIcon, RefreshCw, Save, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import DatePicker from '../nhwd-shared/DatePicker';
import DateTimePicker from '../nhwd-shared/DateTimePicker';
import { ui } from '../nhwd-shared/ui';
import { PTO_STATUS_STYLES, PTO_TYPE_LABELS } from './types';

interface PaySettings {
  profile_id: string;
  display_name: string;
  hourly_rate: number | null;
  salary_amount: number | null;
  pay_type: 'hourly' | 'salary';
}

interface PTORow {
  id: string;
  profile_id: string;
  pto_type: string;
  start_date: string;
  end_date: string;
  total_days: number;
  reason: string | null;
  status: string;
  profiles?: { display_name: string };
}

interface ClockEntry {
  id: string;
  profile_id: string;
  clock_in: string;
  clock_out: string | null;
  break_minutes: number;
  total_hours: number | null;
  notes: string | null;
  adjusted_by: string | null;
  adjustment_reason: string | null;
  profiles?: { display_name: string; initials: string };
}

type Section = 'pay' | 'timeoff' | 'clock';

export default function WorkforceAdmin({ initialProfile }: { initialProfile: ProfileLite }) {
  const [section, setSection] = useState<Section>('pay');

  return (
    <div className="space-y-5">
      {/* Section selector */}
      <div className="flex gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        {([
          { id: 'pay' as Section, label: 'Pay Rates', icon: DollarSign },
          { id: 'timeoff' as Section, label: 'Time Off', icon: PalmtreeIcon },
          { id: 'clock' as Section, label: 'Clock Edits', icon: Clock },
        ]).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setSection(id)}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black transition ${
              section === id
                ? 'bg-[#223f7a] text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Icon className="h-4 w-4" />{label}
          </button>
        ))}
      </div>

      {section === 'pay' && <PayRatesSection />}
      {section === 'timeoff' && <TimeOffSection />}
      {section === 'clock' && <ClockEditSection />}
    </div>
  );
}

// ─── Pay Rates ────────────────────────────────────────────────────────────────

function PayRatesSection() {
  const [employees, setEmployees] = useState<PaySettings[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editRate, setEditRate] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const usersRes = await fetch('/api/admin/users');
      const { users } = await usersRes.json() as { users: Array<{ id: string; display_name: string; is_active: boolean }> };
      const active = users.filter(u => u.is_active);

      // Fetch pay settings for each user
      const settings = await Promise.all(
        active.map(async (u) => {
          const res = await fetch(`/api/payroll/settings?profile_id=${u.id}`);
          const { settings: s } = await res.json();
          return { profile_id: u.id, display_name: u.display_name, hourly_rate: s.hourly_rate, salary_amount: s.salary_amount, pay_type: s.pay_type };
        })
      );
      setEmployees(settings);
    } catch (err) { setError(err instanceof Error ? err.message : 'Load failed.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async (profileId: string) => {
    const rate = parseFloat(editRate);
    if (isNaN(rate) || rate < 0) { setError('Enter a valid pay rate.'); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/payroll/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, hourly_rate: rate, pay_type: 'hourly' }),
      });
      if (!res.ok) throw new Error('Save failed.');
      setEditId(null);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed.'); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="flex justify-center py-12"><RefreshCw className="h-5 w-5 animate-spin text-slate-400" /></div>;

  return (
    <div className="rounded-[28px] border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-slate-100 p-5">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Workforce</p>
        <h3 className="mt-1 text-xl font-black">Employee Pay Rates</h3>
        <p className="mt-1 text-sm text-slate-500">Set hourly rates for each employee. Changes take effect on the next payroll period.</p>
      </div>
      {error && <div className={`${ui.error} mx-5 mt-4`}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}
      <div className="overflow-x-auto">
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>Employee</th>
              <th className={ui.th}>Pay Type</th>
              <th className={ui.th}>Hourly Rate</th>
              <th className={ui.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((emp) => (
              <tr key={emp.profile_id} className="hover:bg-[#f8faff]">
                <td className={`${ui.td} font-black text-slate-900`}>{emp.display_name}</td>
                <td className={ui.td}>
                  <span className={`${ui.badge} ${ui.badgeTone.info}`}>{emp.pay_type === 'salary' ? 'Salary' : 'Hourly'}</span>
                </td>
                <td className={ui.td}>
                  {editId === emp.profile_id ? (
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editRate}
                      onChange={(e) => setEditRate(e.target.value)}
                      className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-bold outline-none focus:border-[#223f7a]"
                      autoFocus
                    />
                  ) : (
                    <span className="text-lg font-black text-slate-900">
                      {emp.hourly_rate != null ? `$${emp.hourly_rate.toFixed(2)}` : '—'}
                    </span>
                  )}
                </td>
                <td className={ui.td}>
                  {editId === emp.profile_id ? (
                    <div className="flex gap-2">
                      <button onClick={() => void handleSave(emp.profile_id)} disabled={saving} className={ui.btnPrimary + ' !px-3 !py-1.5 !text-xs'}>
                        <Save className="h-3.5 w-3.5" />{saving ? '...' : 'Save'}
                      </button>
                      <button onClick={() => setEditId(null)} className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setEditId(emp.profile_id); setEditRate(emp.hourly_rate?.toString() ?? ''); }}
                      className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}
                    >
                      <Edit3 className="h-3.5 w-3.5" />Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Time Off ─────────────────────────────────────────────────────────────────

function TimeOffSection() {
  const [requests, setRequests] = useState<PTORow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);

  // Balance management
  const [employees, setEmployees] = useState<Array<{ id: string; display_name: string }>>([]);
  const [balances, setBalances] = useState<Record<string, { vacation_days: number; personal_days: number; vacation_used: number; personal_used: number }>>({});
  const [editBalanceId, setEditBalanceId] = useState<string | null>(null);
  const [editVacation, setEditVacation] = useState('');
  const [editBirthday, setEditBirthday] = useState('');
  const [savingBalance, setSavingBalance] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/pto');
      const { requests: data } = await res.json();
      setRequests(data ?? []);
    } catch (err) { setError(err instanceof Error ? err.message : 'Load failed.'); }
    finally { setLoading(false); }
  }, []);

  // Load employees and their balances
  const loadBalances = useCallback(async () => {
    try {
      const usersRes = await fetch('/api/admin/users');
      const { users } = await usersRes.json() as { users: Array<{ id: string; display_name: string; is_active: boolean }> };
      const active = users.filter(u => u.is_active).sort((a, b) => a.display_name.localeCompare(b.display_name));
      setEmployees(active);

      const year = new Date().getFullYear();
      const balMap: Record<string, { vacation_days: number; personal_days: number; vacation_used: number; personal_used: number }> = {};
      await Promise.all(active.map(async (u) => {
        const res = await fetch(`/api/pto/balance?profile_id=${u.id}&year=${year}`);
        if (res.ok) {
          const { balance } = await res.json();
          balMap[u.id] = { vacation_days: balance.vacation_days ?? 10, personal_days: balance.personal_days ?? 1, vacation_used: balance.vacation_used ?? 0, personal_used: balance.personal_used ?? 0 };
        }
      }));
      setBalances(balMap);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { void load(); void loadBalances(); }, [load, loadBalances]);

  const handleDecision = async (requestId: string, decision: 'approved' | 'denied') => {
    setProcessing(requestId); setError(null);
    try {
      const denialReason = decision === 'denied' ? window.prompt('Denial reason:') : null;
      if (decision === 'denied' && !denialReason?.trim()) { setProcessing(null); return; }

      const res = await fetch('/api/pto', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: requestId, decision, denial_reason: denialReason }),
      });
      if (!res.ok) throw new Error('Action failed.');
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Action failed.'); }
    finally { setProcessing(null); }
  };

  const handleSaveBalance = async (profileId: string) => {
    setSavingBalance(true); setError(null);
    try {
      const res = await fetch('/api/pto/balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, vacation_days: Number(editVacation), personal_days: Number(editBirthday) }),
      });
      if (!res.ok) throw new Error('Save failed.');
      setEditBalanceId(null);
      await loadBalances();
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed.'); }
    finally { setSavingBalance(false); }
  };

  if (loading) return <div className="flex justify-center py-12"><RefreshCw className="h-5 w-5 animate-spin text-slate-400" /></div>;

  return (
    <div className="space-y-5">
      {error && <div className={ui.error}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}

      {/* ─── PTO Balances Editor (super_admin) ─── */}
      <div className="rounded-[28px] border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-slate-100 p-5">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Workforce</p>
          <h3 className="mt-1 text-xl font-black">Employee PTO Balances</h3>
          <p className="mt-1 text-sm text-slate-500">Edit vacation days and birthday day allocation for each employee ({new Date().getFullYear()}).</p>
        </div>
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Employee</th>
                <th className={ui.th}>Vacation Days</th>
                <th className={ui.th}>Vacation Used</th>
                <th className={ui.th}>Birthday Day</th>
                <th className={ui.th}>Birthday Used</th>
                <th className={ui.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => {
                const bal = balances[emp.id] ?? { vacation_days: 10, personal_days: 1, vacation_used: 0, personal_used: 0 };
                const isEditing = editBalanceId === emp.id;
                return (
                  <tr key={emp.id} className="hover:bg-[#f8faff]">
                    <td className={`${ui.td} font-black text-slate-900`}>{emp.display_name}</td>
                    <td className={ui.td}>
                      {isEditing ? (
                        <input type="number" min="0" step="1" value={editVacation} onChange={e => setEditVacation(e.target.value)} className="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-bold outline-none focus:border-[#223f7a]" />
                      ) : (
                        <span className="text-sm font-black">{bal.vacation_days}</span>
                      )}
                    </td>
                    <td className={`${ui.td} text-sm font-bold text-slate-500`}>{bal.vacation_used}</td>
                    <td className={ui.td}>
                      {isEditing ? (
                        <input type="number" min="0" max="5" step="1" value={editBirthday} onChange={e => setEditBirthday(e.target.value)} className="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-bold outline-none focus:border-[#223f7a]" />
                      ) : (
                        <span className="text-sm font-black">{bal.personal_days}</span>
                      )}
                    </td>
                    <td className={`${ui.td} text-sm font-bold text-slate-500`}>{bal.personal_used}</td>
                    <td className={ui.td}>
                      {isEditing ? (
                        <div className="flex gap-2">
                          <button onClick={() => void handleSaveBalance(emp.id)} disabled={savingBalance} className={ui.btnPrimary + ' !px-3 !py-1.5 !text-xs'}>
                            <Save className="h-3.5 w-3.5" />{savingBalance ? '...' : 'Save'}
                          </button>
                          <button onClick={() => setEditBalanceId(null)} className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}>
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditBalanceId(emp.id); setEditVacation(String(bal.vacation_days)); setEditBirthday(String(bal.personal_days)); }}
                          className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}
                        >
                          <Edit3 className="h-3.5 w-3.5" />Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── PTO Requests ─── */}
      <div className="rounded-[28px] border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-slate-100 p-5">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Workforce</p>
          <h3 className="mt-1 text-xl font-black">Time Off Requests</h3>
          <p className="mt-1 text-sm text-slate-500">Approve or deny employee PTO requests.</p>
        </div>
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Employee</th>
                <th className={ui.th}>Type</th>
                <th className={ui.th}>Dates</th>
                <th className={ui.th}>Days</th>
                <th className={ui.th}>Reason</th>
                <th className={ui.th}>Status</th>
                <th className={ui.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
            {requests.map((req) => {
              const style = PTO_STATUS_STYLES[req.status as keyof typeof PTO_STATUS_STYLES] ?? PTO_STATUS_STYLES.pending;
              return (
                <tr key={req.id} className="hover:bg-[#f8faff]">
                  <td className={`${ui.td} font-black`}>{req.profiles?.display_name ?? '—'}</td>
                  <td className={ui.td}>{PTO_TYPE_LABELS[req.pto_type as keyof typeof PTO_TYPE_LABELS] ?? req.pto_type}</td>
                  <td className={`${ui.td} text-xs`}>{req.start_date} → {req.end_date}</td>
                  <td className={`${ui.td} font-bold`}>{req.total_days}</td>
                  <td className={`${ui.td} text-xs text-slate-500 max-w-[200px] truncate`}>{req.reason || '—'}</td>
                  <td className={ui.td}><span className={`${ui.badge} ${style.bg} ${style.text}`}>{style.label}</span></td>
                  <td className={ui.td}>
                    {req.status === 'pending' ? (
                      <div className="flex gap-2">
                        <button
                          onClick={() => void handleDecision(req.id, 'approved')}
                          disabled={processing === req.id}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[10px] font-black text-emerald-700 hover:bg-emerald-100"
                        >
                          <Check className="h-3 w-3" />Approve
                        </button>
                        <button
                          onClick={() => void handleDecision(req.id, 'denied')}
                          disabled={processing === req.id}
                          className="inline-flex items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[10px] font-black text-rose-700 hover:bg-rose-100"
                        >
                          <X className="h-3 w-3" />Deny
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!requests.length && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-sm font-bold text-slate-400">No time-off requests found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
    </div>
  );
}

// ─── Clock Edits ──────────────────────────────────────────────────────────────

function ClockEditSection() {
  const [employees, setEmployees] = useState<Array<{ id: string; display_name: string }>>([]);
  const [selectedProfile, setSelectedProfile] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [entries, setEntries] = useState<ClockEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editClockIn, setEditClockIn] = useState('');
  const [editClockOut, setEditClockOut] = useState('');
  const [editBreakMin, setEditBreakMin] = useState('');
  const [saving, setSaving] = useState(false);

  // Load employee list on mount
  useEffect(() => {
    fetch('/api/admin/users').then(r => r.json()).then((body) => {
      const users = (body.users ?? []) as Array<{ id: string; display_name: string; is_active: boolean }>;
      setEmployees(users.filter(u => u.is_active).sort((a, b) => a.display_name.localeCompare(b.display_name)));
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!selectedProfile) return;
    setLoading(true); setError(null);
    try {
      const dateParam = filterDate || new Date().toISOString().split('T')[0];
      const res = await fetch(`/api/time-clock?profile_id=${selectedProfile}&date=${dateParam}&range=month`);
      const { entries: data } = await res.json();
      let filtered = (data ?? []) as ClockEntry[];
      // If a specific date is selected, filter to just that day
      if (filterDate) {
        filtered = filtered.filter(e => e.clock_in.startsWith(filterDate));
      }
      setEntries(filtered);
      setLoaded(true);
    } catch (err) { setError(err instanceof Error ? err.message : 'Load failed.'); }
    finally { setLoading(false); }
  }, [selectedProfile, filterDate]);

  const handleSave = async (entryId: string) => {
    setSaving(true); setError(null);
    try {
      const reason = window.prompt('Reason for time adjustment:');
      if (!reason?.trim()) { setSaving(false); return; }
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
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed.'); }
    finally { setSaving(false); }
  };

  const formatDT = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="rounded-[28px] border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-slate-100 p-5">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Workforce</p>
        <h3 className="mt-1 text-xl font-black">Clock-In/Out Edits</h3>
        <p className="mt-1 text-sm text-slate-500">Select an employee to view and adjust their clock entries. All edits are audited.</p>
      </div>

      {/* Filters */}
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_200px_auto]">
          <div>
            <label className={ui.label}>Employee</label>
            <select
              value={selectedProfile}
              onChange={(e) => { setSelectedProfile(e.target.value); setLoaded(false); setEntries([]); }}
              className={ui.select}
            >
              <option value="">Select an employee...</option>
              {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.display_name}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>Date (optional)</label>
            <DatePicker value={filterDate} onChange={(v) => { setFilterDate(v); setLoaded(false); }} placeholder="All month" className="mt-2" />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => void load()}
              disabled={!selectedProfile || loading}
              className={ui.btnPrimary + ' mt-2'}
            >
              {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : 'Load Entries'}
            </button>
          </div>
        </div>
      </div>

      {error && <div className={`${ui.error} mx-5 mt-4`}><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}

      {/* Results */}
      {!loaded && !loading && (
        <div className="px-5 py-10 text-center text-sm font-bold text-slate-400">Select an employee and click &quot;Load Entries&quot; to view their clock data.</div>
      )}

      {loaded && (
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Date</th>
                <th className={ui.th}>Clock In</th>
                <th className={ui.th}>Clock Out</th>
                <th className={ui.th}>Hours</th>
                <th className={ui.th}>Breaks</th>
                <th className={ui.th}>Adjusted</th>
                <th className={ui.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-[#f8faff]">
                  <td className={`${ui.td} text-xs font-bold text-slate-700`}>{new Date(entry.clock_in).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                  <td className={ui.td}>
                    {editId === entry.id ? (
                      <DateTimePicker value={editClockIn} onChange={setEditClockIn} />
                    ) : (
                      <span className="text-xs">{formatDT(entry.clock_in)}</span>
                    )}
                  </td>
                  <td className={ui.td}>
                    {editId === entry.id ? (
                      <DateTimePicker value={editClockOut} onChange={setEditClockOut} />
                    ) : (
                      <span className="text-xs">{formatDT(entry.clock_out)}</span>
                    )}
                  </td>
                  <td className={`${ui.td} font-bold`}>{entry.total_hours != null ? `${entry.total_hours.toFixed(1)}h` : '—'}</td>
                  <td className={ui.td}>
                    {editId === entry.id ? (
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={editBreakMin}
                        onChange={e => setEditBreakMin(e.target.value)}
                        className="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-bold outline-none focus:border-[#223f7a]"
                      />
                    ) : (
                      <span className="text-xs font-bold">{entry.break_minutes}m</span>
                    )}
                  </td>
                  <td className={ui.td}>
                    {entry.adjusted_by ? (
                      <span className={`${ui.badge} ${ui.badgeTone.progress}`}>Edited</span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className={ui.td}>
                    {editId === entry.id ? (
                      <div className="flex gap-2">
                        <button onClick={() => void handleSave(entry.id)} disabled={saving} className={ui.btnPrimary + ' !px-3 !py-1.5 !text-xs'}>
                          <Save className="h-3.5 w-3.5" />{saving ? '...' : 'Save'}
                        </button>
                        <button onClick={() => setEditId(null)} className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}>
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setEditId(entry.id);
                          setEditClockIn(entry.clock_in ? new Date(entry.clock_in).toISOString().slice(0, 16) : '');
                          setEditClockOut(entry.clock_out ? new Date(entry.clock_out).toISOString().slice(0, 16) : '');
                          setEditBreakMin(String(entry.break_minutes ?? 0));
                        }}
                        className={ui.btnSecondary + ' !px-3 !py-1.5 !text-xs'}
                      >
                        <Edit3 className="h-3.5 w-3.5" />Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!entries.length && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-sm font-bold text-slate-400">No clock entries found for this selection.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

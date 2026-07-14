'use client';

import { CheckCircle2, Eye, RefreshCw, Search, UserCheck, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { getSupabase, listActiveAgents } from '../nhwd-shared/client';
import type { ProfileLite } from '../nhwd-shared/types';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import { csIntakeStatusTone, statusLabel, ui } from '../nhwd-shared/ui';
import IntakeForm from './IntakeForm';
import {
  claimIntake,
  convertIntake,
  getIntake,
  listQueue,
  managerAssignIntake,
  profileName,
  returnIntake,
  type CsIntakeDriver,
  type CsIntakeSubmission,
  type CsIntakeVehicle,
} from './api';

type LoadedIntake = {
  submission: CsIntakeSubmission;
  drivers: CsIntakeDriver[];
  vehicles: CsIntakeVehicle[];
};

function QueueModal({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 p-3 backdrop-blur-sm sm:p-6" onMouseDown={onClose}>
      <div className="mx-auto max-w-6xl rounded-[30px] bg-[#f3f5f9] p-3 shadow-2xl sm:p-5" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-3 flex justify-end"><button className={ui.btnGhost} onClick={onClose}><X className="h-4 w-4" />Close</button></div>
        {children}
      </div>
    </div>
  );
}

export default function IntakeQueue({
  initialProfile: profile,
  embedded = false,
}: {
  initialProfile: ProfileLite;
  embedded?: boolean;
}) {
  const [agents, setAgents] = useState<ProfileLite[]>([]);
  const [rows, setRows] = useState<CsIntakeSubmission[]>([]);
  const [selected, setSelected] = useState<LoadedIntake | null>(null);
  const [search, setSearch] = useState('');
  const [coverage, setCoverage] = useState('all');
  const [priority, setPriority] = useState('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [queueRows, activeAgents] = await Promise.all([
        listQueue(),
        listActiveAgents(),
      ]);
      setRows(queueRows);
      setAgents(activeAgents);
      setLastUpdated(new Date());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load the Sales Intake Queue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel('sales-intake-queue-v097')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cs_intake_submissions' }, () => void refresh())
      .subscribe();
    const interval = window.setInterval(() => void refresh(), 60_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch = !needle || [row.insured_first_name, row.insured_last_name, row.business_name, row.insured_phone_primary, row.dot_number].some((value) => value?.toLowerCase().includes(needle));
      const matchesCoverage = coverage === 'all'
        || (coverage === 'personal_auto' && ['auto', 'personal_auto'].includes(row.line_of_business))
        || row.line_of_business === coverage;
      return matchesSearch && matchesCoverage && (priority === 'all' || row.priority === priority);
    });
  }, [coverage, priority, rows, search]);

  async function show(row: CsIntakeSubmission) {
    try {
      const detail = await getIntake(row.id);
      if (detail) setSelected({ submission: detail.submission, drivers: detail.drivers, vehicles: detail.vehicles });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to open the intake.');
    }
  }

  async function action(id: string, task: () => Promise<void>, success: string) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      await task();
      setNotice(success);
      setSelected(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The action could not be completed. Another agent may have claimed the intake first.');
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function assign(row: CsIntakeSubmission, agentId: string) {
    if (!agentId) return;
    await action(row.id, () => managerAssignIntake(row.id, agentId), `Intake assigned to ${profileName(agents, agentId)}.`);
  }

  async function requestReturn(row: CsIntakeSubmission) {
    if (!profile) return;
    const reason = window.prompt('What information must Customer Service correct or complete?');
    if (!reason?.trim()) return;
    await action(row.id, () => returnIntake(row.id, profile.id, reason.trim()), 'Intake returned to Customer Service.');
  }

  if (loading) return <div className="grid min-h-screen place-items-center bg-[#f3f5f9] font-black text-slate-500">Loading Sales Intake Queue…</div>;
  if (!['agent', 'manager'].includes(profile.role)) return <div className="grid min-h-screen place-items-center bg-[#f3f5f9]"><div className={ui.error}>The Sales Intake Queue is available to Agents and Managers.</div></div>;

  const submittedCount = rows.filter((row) => row.status === 'submitted').length;
  const claimedCount = rows.filter((row) => row.status === 'claimed').length;
  const mine = rows.filter((row) => row.claimed_by === profile.id).length;

  return (
    <ModuleShell
      title="Sales Intake Queue"
      subtitle="Claim a complete Customer Service intake or let a Manager assign it directly. Converting the intake creates the quote and makes the Sales Agent the owner."
      role={profile.role}
      lastUpdated={lastUpdated}
      onRefresh={() => void refresh()}
      embedded={embedded}
    >
      {error ? <div className={`${ui.error} mb-5`}>{error}</div> : null}
      {notice ? <div className={`${ui.success} mb-5`}>{notice}</div> : null}

      <section className="grid gap-4 sm:grid-cols-3">
        <div className={ui.stat}><p className={ui.statLabel}>Unclaimed</p><p className={ui.statValue}>{submittedCount}</p><p className="mt-1 text-xs font-semibold text-slate-500">Available to eligible Sales Agents</p></div>
        <div className={ui.stat}><p className={ui.statLabel}>Claimed</p><p className={ui.statValue}>{claimedCount}</p><p className="mt-1 text-xs font-semibold text-slate-500">Waiting to convert into Quotes Database</p></div>
        <div className={ui.stat}><p className={ui.statLabel}>Assigned to Me</p><p className={ui.statValue}>{mine}</p><p className="mt-1 text-xs font-semibold text-slate-500">You become Sales owner after conversion</p></div>
      </section>

      <section className={`${ui.card} mt-5 overflow-hidden`}>
        <div className={ui.cardHeader}>
          <div><p className={ui.sectionTitle}>Shared Queue</p><h2 className="mt-1 text-xl font-black">Customer Service submissions</h2><p className="mt-1 text-sm font-semibold text-slate-500">Claiming is atomic—only one Agent can win when multiple people click at the same time.</p></div>
          <button type="button" className={ui.btnSecondary} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" />Refresh</button>
        </div>
        <div className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-[1fr_210px_180px]">
          <label className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 text-sm font-semibold outline-none focus:border-[#7890bc]" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search customer, business, phone or DOT" /></label>
          <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={coverage} onChange={(event) => setCoverage(event.target.value)}><option value="all">All coverage types</option><option value="personal_auto">Personal Auto</option><option value="commercial_auto">Commercial Auto</option></select>
          <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={priority} onChange={(event) => setPriority(event.target.value)}><option value="all">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option></select>
        </div>
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead><tr><th className={ui.th}>Customer</th><th className={ui.th}>Coverage</th><th className={ui.th}>Status</th><th className={ui.th}>Waiting</th><th className={ui.th}>Sales owner</th><th className={ui.th}>Actions</th></tr></thead>
            <tbody>
              {visible.map((row) => {
                const customer = row.business_name || `${row.insured_first_name} ${row.insured_last_name}`.trim();
                const isMine = row.claimed_by === profile.id;
                const canConvert = isMine || profile.role === 'manager';
                return (
                  <tr key={row.id} className="hover:bg-[#f8faff]">
                    <td className={ui.td}><p className="font-black text-slate-900">{customer || 'Unnamed intake'}</p><p className="mt-1 text-xs font-semibold text-slate-400">{row.insured_phone_primary || 'No phone'}{row.dot_number ? ` · DOT ${row.dot_number}` : ''}</p></td>
                    <td className={ui.td}><p className="font-bold">{row.line_of_business === 'commercial_auto' ? 'Commercial Auto' : 'Personal Auto'}</p><p className="mt-1 text-xs text-slate-400">{row.desired_coverage ? statusLabel(row.desired_coverage) : 'Coverage to review'}</p></td>
                    <td className={ui.td}><div className="flex flex-wrap gap-2"><span className={`${ui.badge} ${ui.badgeTone[csIntakeStatusTone[row.status] || 'neutral']}`}>{statusLabel(row.status)}</span><span className={`${ui.badge} ${row.priority === 'urgent' ? ui.badgeTone.danger : row.priority === 'high' ? ui.badgeTone.progress : ui.badgeTone.neutral}`}>{statusLabel(row.priority)}</span></div></td>
                    <td className={ui.td}><p className="text-xs font-bold text-slate-500">{row.submitted_at ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-Math.max(0, Math.round((Date.now() - new Date(row.submitted_at).getTime()) / 3_600_000)), 'hour') : 'Not submitted'}</p></td>
                    <td className={ui.td}><p className="font-bold text-slate-700">{profileName(agents, row.claimed_by)}</p></td>
                    <td className={ui.td}>
                      <div className="flex min-w-[260px] flex-wrap gap-2">
                        <button type="button" className={ui.btnSecondary} onClick={() => void show(row)}><Eye className="h-4 w-4" />View</button>
                        {row.status === 'submitted' && profile.role === 'agent' ? <button type="button" className={ui.btnPrimary} disabled={busyId === row.id} onClick={() => void action(row.id, () => claimIntake(row.id), 'Intake claimed. Review and convert it to create the quote.')}><UserCheck className="h-4 w-4" />Claim</button> : null}
                        {canConvert && row.status === 'claimed' ? <button type="button" className={ui.btnPrimary} disabled={busyId === row.id} onClick={() => void action(row.id, async () => { await convertIntake(row.id); }, 'Quote created in Quotes Database.')}><CheckCircle2 className="h-4 w-4" />Create Quote</button> : null}
                        {profile.role === 'manager' && row.status === 'submitted' ? (
                          <select className="rounded-xl border border-[#c9d5e9] bg-white px-3 py-2 text-xs font-black text-[#223f7a]" defaultValue="" onChange={(event) => void assign(row, event.target.value)}>
                            <option value="" disabled>Assign to…</option>
                            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.display_name}</option>)}
                          </select>
                        ) : null}
                        {(row.status === 'submitted' || canConvert) ? <button type="button" className={ui.btnDanger} disabled={busyId === row.id} onClick={() => void requestReturn(row)}>Return</button> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!visible.length ? <div className={ui.empty}>No intakes match the current filters.</div> : null}
        </div>
      </section>

      <QueueModal open={Boolean(selected)} onClose={() => setSelected(null)}>
        {selected ? (
          <div className="space-y-4">
            <IntakeForm profileId={profile.id} initial={selected} readOnly onDone={() => setSelected(null)} />
            <div className="sticky bottom-4 flex flex-wrap justify-end gap-2 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-xl">
              {selected.submission.status === 'submitted' && profile.role === 'agent' ? <button className={ui.btnPrimary} disabled={busyId === selected.submission.id} onClick={() => void action(selected.submission.id, () => claimIntake(selected.submission.id), 'Intake claimed.')}><UserCheck className="h-4 w-4" />Claim Intake</button> : null}
              {(selected.submission.claimed_by === profile.id || profile.role === 'manager') && selected.submission.status === 'claimed' ? <button className={ui.btnPrimary} disabled={busyId === selected.submission.id} onClick={() => void action(selected.submission.id, async () => { await convertIntake(selected.submission.id); }, 'Quote created in Quotes Database.')}><CheckCircle2 className="h-4 w-4" />Create Quote</button> : null}
            </div>
          </div>
        ) : null}
      </QueueModal>
    </ModuleShell>
  );
}

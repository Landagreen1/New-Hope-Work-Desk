'use client';

import { ClipboardList, FilePlus2, RefreshCw, Search, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { getSupabase } from '../nhwd-shared/client';
import type { ProfileLite } from '../nhwd-shared/types';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import { csIntakeStatusTone, statusLabel, ui } from '../nhwd-shared/ui';
import IntakeForm from './IntakeForm';
import {
  getIntake,
  listAllIntakes,
  listMyIntakes,
  type CsIntakeDriver,
  type CsIntakeSubmission,
  type CsIntakeVehicle,
} from './api';

type LoadedIntake = {
  submission: CsIntakeSubmission;
  drivers: CsIntakeDriver[];
  vehicles: CsIntakeVehicle[];
};

function IntakeModal({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 p-3 backdrop-blur-sm sm:p-6" onMouseDown={onClose}>
      <div className="mx-auto max-w-6xl rounded-[30px] bg-[#f3f5f9] p-3 shadow-2xl sm:p-5" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-3 flex justify-end"><button type="button" className={ui.btnGhost} onClick={onClose}><X className="h-4 w-4" />Close</button></div>
        {children}
      </div>
    </div>
  );
}

export default function CsIntakeLanding({ initialProfile: profile }: { initialProfile: ProfileLite }) {
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<CsIntakeSubmission[]>([]);
  const [selected, setSelected] = useState<LoadedIntake | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoOpened, setAutoOpened] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = profile.role === 'manager' ? await listAllIntakes() : await listMyIntakes(profile.id);
      setRows(data);
      setLastUpdated(new Date());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load quote intakes.');
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel('cs-intake-landing-v097')
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

  useEffect(() => {
    const editId = searchParams.get('edit');
    if (!profile || !editId || autoOpened) return;
    setAutoOpened(true);
    getIntake(editId)
      .then((data) => {
        if (data) setSelected({ submission: data.submission, drivers: data.drivers, vehicles: data.vehicles });
        else setError('The linked re-quote intake could not be found.');
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to open the linked re-quote intake.'));
  }, [autoOpened, profile, searchParams]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesStatus = status === 'all' || row.status === status;
      const matchesSearch = !needle || [
        row.insured_first_name,
        row.insured_last_name,
        row.business_name,
        row.insured_phone_primary,
        row.current_policy_number,
        row.dot_number,
      ].some((value) => value?.toLowerCase().includes(needle));
      return matchesStatus && matchesSearch;
    });
  }, [rows, search, status]);

  async function openExisting(row: CsIntakeSubmission) {
    try {
      setError(null);
      const data = await getIntake(row.id);
      if (data) setSelected({ submission: data.submission, drivers: data.drivers, vehicles: data.vehicles });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to open the intake.');
    }
  }

  function closeForm() {
    setCreating(false);
    setSelected(null);
    void refresh();
  }

  if (loading) return <div className="grid min-h-screen place-items-center bg-[#f3f5f9] font-black text-slate-500">Loading Quote Intake…</div>;

  if (!['customer_service', 'manager'].includes(profile.role)) {
    return <div className="grid min-h-screen place-items-center bg-[#f3f5f9] p-6"><div className={ui.error}>Quote Intake is available to Customer Service and Managers.</div></div>;
  }

  const drafts = rows.filter((row) => row.status === 'draft' || row.status === 'returned').length;
  const submitted = rows.filter((row) => row.status === 'submitted').length;
  const converted = rows.filter((row) => row.status === 'converted').length;

  return (
    <ModuleShell
      title="Customer Service Quote Intake"
      subtitle="Collect the essential Personal or Commercial Auto information, save drafts, and submit complete intakes to the Sales team."
      role={profile.role}
      lastUpdated={lastUpdated}
      onRefresh={() => void refresh()}
    >
      {error ? <div className={`${ui.error} mb-5`}>{error}</div> : null}

      <section className="grid gap-4 sm:grid-cols-3">
        <div className={ui.stat}><p className={ui.statLabel}>Drafts / Returned</p><p className={ui.statValue}>{drafts}</p><p className="mt-1 text-xs font-semibold text-slate-500">Needs Customer Service attention</p></div>
        <div className={ui.stat}><p className={ui.statLabel}>Waiting for Sales</p><p className={ui.statValue}>{submitted}</p><p className="mt-1 text-xs font-semibold text-slate-500">Shared queue, manager can assign</p></div>
        <div className={ui.stat}><p className={ui.statLabel}>Converted to Quotes</p><p className={ui.statValue}>{converted}</p><p className="mt-1 text-xs font-semibold text-slate-500">CSR intake credit preserved</p></div>
      </section>

      <section className={`${ui.card} mt-5 overflow-hidden`}>
        <div className={ui.cardHeader}>
          <div>
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]"><ClipboardList className="h-4 w-4" /> Intake Workspace</div>
            <h2 className="mt-1 text-xl font-black">{profile.role === 'manager' ? 'All quote intakes' : 'My quote intakes'}</h2>
            <p className="mt-1 text-sm font-semibold text-slate-500">Drafts can be edited. Submitted and converted records remain visible for follow-up and credit.</p>
          </div>
          <button type="button" className={ui.btnPrimary} onClick={() => setCreating(true)}><FilePlus2 className="h-4 w-4" /> New Quote Intake</button>
        </div>
        <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-[1fr_220px_auto] sm:p-5">
          <label className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 text-sm font-semibold outline-none focus:border-[#7890bc]" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search customer, business, phone, DOT or policy" /></label>
          <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="draft">Draft</option><option value="returned">Returned</option><option value="submitted">Submitted</option><option value="claimed">Claimed</option><option value="converted">Converted</option><option value="rejected">Rejected</option></select>
          <button type="button" className={ui.btnSecondary} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" />Refresh</button>
        </div>
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead><tr><th className={ui.th}>Customer</th><th className={ui.th}>Coverage</th><th className={ui.th}>Priority</th><th className={ui.th}>Status</th><th className={ui.th}>Updated</th><th className={ui.th}>Action</th></tr></thead>
            <tbody>
              {visible.map((row) => {
                const editable = row.status === 'draft' || row.status === 'returned';
                const customer = row.business_name || `${row.insured_first_name} ${row.insured_last_name}`.trim();
                return (
                  <tr key={row.id} className="hover:bg-[#f8faff]">
                    <td className={ui.td}><p className="font-black text-slate-900">{customer || 'Unnamed intake'}</p><p className="mt-1 text-xs font-semibold text-slate-400">{row.insured_phone_primary || 'No phone'}{row.dot_number ? ` · DOT ${row.dot_number}` : ''}</p></td>
                    <td className={ui.td}><p className="font-bold">{row.line_of_business === 'commercial_auto' ? 'Commercial Auto' : 'Personal Auto'}</p><p className="mt-1 text-xs text-slate-400">{row.desired_coverage ? statusLabel(row.desired_coverage) : 'Coverage not selected'}</p></td>
                    <td className={ui.td}><span className={`${ui.badge} ${row.priority === 'urgent' ? ui.badgeTone.danger : row.priority === 'high' ? ui.badgeTone.progress : ui.badgeTone.neutral}`}>{statusLabel(row.priority)}</span></td>
                    <td className={ui.td}><span className={`${ui.badge} ${ui.badgeTone[csIntakeStatusTone[row.status] || 'neutral']}`}>{statusLabel(row.status)}</span></td>
                    <td className={ui.td}><p className="text-xs font-semibold text-slate-500">{new Date(row.updated_at).toLocaleString()}</p></td>
                    <td className={ui.td}><button type="button" className={editable ? ui.btnPrimary : ui.btnSecondary} onClick={() => void openExisting(row)}>{editable ? 'Continue' : 'View'}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!visible.length ? <div className={ui.empty}>No quote intakes match the current filters.</div> : null}
        </div>
      </section>

      <IntakeModal open={creating || Boolean(selected)} onClose={closeForm}>
        {creating ? <IntakeForm profileId={profile.id} onDone={closeForm} /> : null}
        {selected ? <IntakeForm profileId={profile.id} initial={selected} readOnly={!['draft', 'returned'].includes(selected.submission.status)} onDone={closeForm} /> : null}
      </IntakeModal>
    </ModuleShell>
  );
}

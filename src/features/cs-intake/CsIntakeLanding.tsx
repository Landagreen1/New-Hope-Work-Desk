// src/features/cs-intake/CsIntakeLanding.tsx
// Landing page for Customer Service: create intakes, track their status,
// and resubmit anything an agent returned. Managers see the same page plus
// every CSR's intakes.
'use client';

import { useCallback, useEffect, useState } from 'react';
import { getCurrentProfile, getSupabase, ProfileLite } from '../nhwd-shared/client';
import { csIntakeStatusTone, statusLabel, ui } from '../nhwd-shared/ui';
import IntakeForm from './IntakeForm';
import {
  CsIntakeDriver, CsIntakeSubmission, CsIntakeVehicle,
  getIntake, listAllIntakes, listMyIntakes,
} from './api';

type Loaded = { submission: CsIntakeSubmission; drivers: CsIntakeDriver[]; vehicles: CsIntakeVehicle[] };

export default function CsIntakeLanding() {
  const [profile, setProfile] = useState<ProfileLite | null>(null);
  const [rows, setRows] = useState<CsIntakeSubmission[]>([]);
  const [mode, setMode] = useState<'list' | 'new' | 'edit'>('list');
  const [editing, setEditing] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (p?: ProfileLite | null) => {
    const prof = p ?? profile;
    if (!prof) return;
    const data = prof.role === 'manager'
      ? await listAllIntakes()
      : await listMyIntakes(prof.id);
    // Returned items first so nothing sits unfixed, then drafts, then the rest.
    const order: Record<string, number> = { returned: 0, draft: 1, submitted: 2, claimed: 3, converted: 4, rejected: 5 };
    data.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)
      || (b.updated_at > a.updated_at ? 1 : -1));
    setRows(data);
    setLoading(false);
  }, [profile]);

  useEffect(() => {
    getCurrentProfile().then((p) => { setProfile(p); refresh(p); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Realtime + the platform's 60-second fallback pattern.
  useEffect(() => {
    if (!profile) return;
    const supabase = getSupabase();
    const channel = supabase
      .channel('cs-intake-landing')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'cs_intake_submissions' },
        () => refresh())
      .subscribe();
    const interval = setInterval(() => refresh(), 60_000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
    };
  }, [profile, refresh]);

  async function openIntake(id: string) {
    const loaded = await getIntake(id);
    if (loaded) { setEditing(loaded); setMode('edit'); }
  }

  if (!profile) {
    return <div className={ui.page}><div className={ui.empty}>{loading ? 'Loading…' : 'Sign in to use Quote Intake.'}</div></div>;
  }
  if (!['customer_service', 'manager'].includes(profile.role)) {
    return (
      <div className={ui.page}>
        <div className={ui.empty}>
          Quote Intake is for Customer Service and Managers. Agents claim intakes
          from the Intake Queue instead.
        </div>
      </div>
    );
  }

  const counts = {
    returned: rows.filter((r) => r.status === 'returned').length,
    draft: rows.filter((r) => r.status === 'draft').length,
    inQueue: rows.filter((r) => r.status === 'submitted').length,
    converted: rows.filter((r) => r.status === 'converted').length,
  };

  if (mode !== 'list') {
    const editable = mode === 'new'
      || ['draft', 'returned'].includes(editing?.submission.status ?? '');
    return (
      <div className={ui.page}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className={ui.pageTitle}>
              {mode === 'new' ? 'New quote intake' : `Intake — ${editing?.submission.insured_first_name} ${editing?.submission.insured_last_name}`}
            </h1>
            <p className={ui.pageSubtitle}>
              Fill every field you can. Agents work from these fields, and they map into carrier sites — notes alone are not enough.
            </p>
          </div>
          <button className={ui.btnGhost} onClick={() => { setMode('list'); setEditing(null); refresh(); }}>
            ← Back to my intakes
          </button>
        </div>
        <IntakeForm
          profileId={profile.id}
          initial={mode === 'edit' && editing ? editing : undefined}
          readOnly={!editable}
          onDone={() => { setMode('list'); setEditing(null); refresh(); }}
        />
      </div>
    );
  }

  return (
    <div className={ui.page}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className={ui.pageTitle}>Quote Intake</h1>
          <p className={ui.pageSubtitle}>
            {profile.role === 'manager'
              ? 'All customer service intakes across the team.'
              : 'Collect the customer\u2019s information and send it to the sales queue.'}
          </p>
        </div>
        <button className={ui.btnPrimary} onClick={() => setMode('new')}>+ New intake</button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className={ui.stat}><div className={ui.statLabel}>Needs attention (returned)</div>
          <div className={ui.statValue}>{counts.returned}</div></div>
        <div className={ui.stat}><div className={ui.statLabel}>Drafts</div>
          <div className={ui.statValue}>{counts.draft}</div></div>
        <div className={ui.stat}><div className={ui.statLabel}>Waiting in queue</div>
          <div className={ui.statValue}>{counts.inQueue}</div></div>
        <div className={ui.stat}><div className={ui.statLabel}>Converted to quotes</div>
          <div className={ui.statValue}>{counts.converted}</div></div>
      </div>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>Customer</th>
              <th className={ui.th}>Line</th>
              <th className={ui.th}>Priority</th>
              <th className={ui.th}>Status</th>
              <th className={ui.th}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={ui.trHover} onClick={() => openIntake(r.id)}>
                <td className={ui.td}>
                  <span className="font-medium">{r.insured_first_name} {r.insured_last_name}</span>
                  <span className="ml-2 text-xs text-slate-500">{r.insured_phone_primary ?? ''}</span>
                </td>
                <td className={ui.td}>{r.line_of_business.replace(/_/g, ' ')}</td>
                <td className={ui.td}>{r.priority}</td>
                <td className={ui.td}>
                  <span className={`${ui.badge} ${ui.badgeTone[csIntakeStatusTone[r.status]]}`}>
                    {statusLabel(r.status)}
                  </span>
                  {r.status === 'returned' && r.return_reason && (
                    <div className="mt-1 text-xs text-slate-500">{r.return_reason}</div>
                  )}
                </td>
                <td className={ui.td}>{new Date(r.updated_at).toLocaleString()}</td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr><td colSpan={5} className={ui.empty}>
                No intakes yet. Click “New intake” to collect your first quote opportunity.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

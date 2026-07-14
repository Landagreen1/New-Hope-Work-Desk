// src/features/cs-intake/IntakeQueue.tsx
// Agent queue: claim submitted intakes, review details, convert to a quote.
// Managers additionally can return an intake to the CSR or reject it.
'use client';

import { useCallback, useEffect, useState } from 'react';
import { getCurrentProfile, getSupabase, ProfileLite } from '../nhwd-shared/client';
import { csIntakeStatusTone, statusLabel, ui } from '../nhwd-shared/ui';
import IntakeForm from './IntakeForm';
import {
  CsIntakeDriver, CsIntakeSubmission, CsIntakeVehicle,
  claimIntake, convertIntake, getIntake, listQueue, rejectIntake, returnIntake,
} from './api';

type Loaded = { submission: CsIntakeSubmission; drivers: CsIntakeDriver[]; vehicles: CsIntakeVehicle[] };

export default function IntakeQueue() {
  const [profile, setProfile] = useState<ProfileLite | null>(null);
  const [rows, setRows] = useState<CsIntakeSubmission[]>([]);
  const [open, setOpen] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const refresh = useCallback(async () => {
    setRows(await listQueue());
  }, []);

  useEffect(() => {
    getCurrentProfile().then(setProfile);
    refresh();
  }, [refresh]);

  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel('cs-intake-queue')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'cs_intake_submissions' },
        () => refresh())
      .subscribe();
    const interval = setInterval(refresh, 60_000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
    };
  }, [refresh]);

  async function run(fn: () => Promise<unknown>, okMsg: string) {
    setBusy(true); setError(null); setNotice(null);
    try {
      await fn();
      setNotice(okMsg);
      await refresh();
      if (open) {
        const reloaded = await getIntake(open.submission.id);
        setOpen(reloaded);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return <div className={ui.page}><div className={ui.empty}>Loading…</div></div>;
  if (!['agent', 'manager'].includes(profile.role)) {
    return <div className={ui.page}><div className={ui.empty}>The Intake Queue is for Agents and Managers.</div></div>;
  }

  const isManager = profile.role === 'manager';
  const mine = rows.filter((r) => r.status === 'claimed' && r.claimed_by === profile.id);
  const available = rows.filter((r) => r.status === 'submitted');
  const othersClaimed = rows.filter((r) => r.status === 'claimed' && r.claimed_by !== profile.id);

  if (open) {
    const s = open.submission;
    const canConvert = s.status === 'claimed' && s.claimed_by === profile.id;
    const canClaim = s.status === 'submitted';
    return (
      <div className={ui.page}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className={ui.pageTitle}>{s.insured_first_name} {s.insured_last_name}</h1>
            <p className={ui.pageSubtitle}>
              <span className={`${ui.badge} ${ui.badgeTone[csIntakeStatusTone[s.status]]}`}>{statusLabel(s.status)}</span>
              <span className="ml-2">{s.line_of_business.replace(/_/g, ' ')} · priority {s.priority}</span>
            </p>
          </div>
          <button className={ui.btnGhost} onClick={() => { setOpen(null); setError(null); setNotice(null); }}>
            ← Back to queue
          </button>
        </div>

        {error && <div className={`${ui.error} mb-3`}>{error}</div>}
        {notice && <div className={`${ui.success} mb-3`}>{notice}</div>}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {canClaim && (
            <button className={ui.btnPrimary} disabled={busy}
              onClick={() => run(() => claimIntake(s.id), 'Intake claimed. It\u2019s yours.')}>
              Claim intake
            </button>
          )}
          {canConvert && (
            <button className={ui.btnPrimary} disabled={busy}
              onClick={() => run(() => convertIntake(s.id), 'Quote created in the Quotes Database.')}>
              Convert to quote
            </button>
          )}
          {(canConvert || isManager) && s.status !== 'converted' && (
            <>
              <input className={`${ui.input} !mt-0 w-64`} placeholder="Reason (required to return/reject)"
                value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className={ui.btnSecondary} disabled={busy || !reason.trim()}
                onClick={() => run(() => returnIntake(s.id, profile.id, reason.trim()), 'Returned to the CSR with your reason.')}>
                Return to CSR
              </button>
              {isManager && (
                <button className={ui.btnDanger} disabled={busy || !reason.trim()}
                  onClick={() => run(() => rejectIntake(s.id, profile.id, reason.trim()), 'Intake rejected.')}>
                  Reject
                </button>
              )}
            </>
          )}
        </div>

        <IntakeForm profileId={profile.id} initial={open} readOnly onDone={() => setOpen(null)} />
      </div>
    );
  }

  const Section = ({ title, data, emptyText }: { title: string; data: CsIntakeSubmission[]; emptyText: string }) => (
    <div className={`${ui.card} mb-4`}>
      <div className={ui.cardHeader}><h3 className={ui.sectionTitle}>{title} ({data.length})</h3></div>
      <table className={ui.table}>
        <thead>
          <tr>
            <th className={ui.th}>Customer</th>
            <th className={ui.th}>Line</th>
            <th className={ui.th}>Priority</th>
            <th className={ui.th}>Waiting since</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.id} className={ui.trHover}
              onClick={async () => setOpen(await getIntake(r.id))}>
              <td className={ui.td}><span className="font-medium">{r.insured_first_name} {r.insured_last_name}</span></td>
              <td className={ui.td}>{r.line_of_business.replace(/_/g, ' ')}</td>
              <td className={ui.td}>
                <span className={`${ui.badge} ${r.priority === 'urgent' ? ui.badgeTone.danger : r.priority === 'high' ? ui.badgeTone.progress : ui.badgeTone.neutral}`}>
                  {r.priority}
                </span>
              </td>
              <td className={ui.td}>{r.submitted_at ? new Date(r.submitted_at).toLocaleString() : '—'}</td>
            </tr>
          ))}
          {!data.length && <tr><td colSpan={4} className={ui.empty}>{emptyText}</td></tr>}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className={ui.page}>
      <div className="mb-4">
        <h1 className={ui.pageTitle}>Intake Queue</h1>
        <p className={ui.pageSubtitle}>Quote opportunities collected by Customer Service, ready to claim.</p>
      </div>
      {error && <div className={`${ui.error} mb-3`}>{error}</div>}
      {notice && <div className={`${ui.success} mb-3`}>{notice}</div>}
      <Section title="My claimed intakes" data={mine}
        emptyText="Nothing claimed. Claim an available intake below." />
      <Section title="Available to claim" data={available}
        emptyText="The queue is clear." />
      {isManager && (
        <Section title="Claimed by other agents" data={othersClaimed}
          emptyText="No intakes are being worked right now." />
      )}
    </div>
  );
}

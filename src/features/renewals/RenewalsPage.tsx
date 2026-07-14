// src/features/renewals/RenewalsPage.tsx
// Renewals Management. Managers: import the HawkSoft/Power BI CSV, assign
// records, monitor the pipeline. Agents: work their assigned renewals,
// document contacts, set follow-ups, send to re-quote.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCurrentProfile, getSupabase, listActiveAgents, ProfileLite } from '../nhwd-shared/client';
import { renewalStatusTone, statusLabel, ui } from '../nhwd-shared/ui';
import {
  addContact, assignRenewal, guessMapping, importBatch, listContacts,
  listRenewals, NormalizedImportRow, normalizeDate, parseCsv, RenewalContact,
  RenewalRecord, RenewalStatus, sendToRequote, updateRecord,
} from './api';

const OPEN_STATUSES: RenewalStatus[] = ['imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent'];
const FIELD_LABELS: Record<string, string> = {
  policy_number: 'Policy number *',
  renewal_date: 'Renewal date *',
  customer_name: 'Customer name *',
  customer_phone: 'Phone',
  customer_email: 'Email',
  carrier: 'Carrier',
  line_of_business: 'Line of business',
  hawksoft_client_id: 'HawkSoft client ID',
  premium_current: 'Current premium',
  premium_renewal: 'Renewal premium',
};

function daysUntil(date: string): number {
  return Math.ceil((new Date(date + 'T00:00:00').getTime() - Date.now()) / 86_400_000);
}
function premiumDelta(r: RenewalRecord): string {
  if (r.premium_current == null || r.premium_renewal == null || Number(r.premium_current) === 0) return '—';
  const pct = ((Number(r.premium_renewal) - Number(r.premium_current)) / Number(r.premium_current)) * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export default function RenewalsPage() {
  const [profile, setProfile] = useState<ProfileLite | null>(null);
  const [agents, setAgents] = useState<ProfileLite[]>([]);
  const [rows, setRows] = useState<RenewalRecord[]>([]);
  const [tab, setTab] = useState<'pipeline' | 'import'>('pipeline');
  const [statusFilter, setStatusFilter] = useState<RenewalStatus | 'all' | 'open'>('open');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [openRec, setOpenRec] = useState<RenewalRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const data = await listRenewals({
      status: statusFilter === 'open' ? 'all' : statusFilter,
      assignedTo: agentFilter as 'all' | 'unassigned' | string,
    });
    setRows(statusFilter === 'open' ? data.filter((r) => OPEN_STATUSES.includes(r.status)) : data);
  }, [statusFilter, agentFilter]);

  useEffect(() => {
    getCurrentProfile().then((p) => {
      setProfile(p);
      if (p?.role === 'agent') setAgentFilter(p.id);
    });
    listActiveAgents().then(setAgents);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel('renewals-page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'renewal_records' }, () => refresh())
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

  const agentName = useCallback(
    (id: string | null) => agents.find((a) => a.id === id)?.display_name ?? '—',
    [agents],
  );

  if (!profile) return <div className={ui.page}><div className={ui.empty}>Loading…</div></div>;
  const isManager = profile.role === 'manager';

  const overdue = rows.filter((r) =>
    r.next_follow_up_at && new Date(r.next_follow_up_at) < new Date()
    && OPEN_STATUSES.includes(r.status)).length;
  const unassigned = rows.filter((r) => !r.assigned_to && r.status === 'imported').length;
  const dueSoon = rows.filter((r) => OPEN_STATUSES.includes(r.status) && daysUntil(r.renewal_date) <= 14).length;

  return (
    <div className={ui.page}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className={ui.pageTitle}>Renewals</h1>
          <p className={ui.pageSubtitle}>
            {isManager
              ? 'Import the HawkSoft report, assign renewals, and monitor the pipeline.'
              : 'Your assigned renewals. Document every contact and send uncompetitive pricing to re-quote.'}
          </p>
        </div>
        {isManager && (
          <div className="flex gap-2">
            <button className={tab === 'pipeline' ? ui.btnPrimary : ui.btnSecondary}
              onClick={() => setTab('pipeline')}>Pipeline</button>
            <button className={tab === 'import' ? ui.btnPrimary : ui.btnSecondary}
              onClick={() => setTab('import')}>Import report</button>
          </div>
        )}
      </div>

      {error && <div className={`${ui.error} mb-3`}>{error}</div>}
      {notice && <div className={`${ui.success} mb-3`}>{notice}</div>}

      {tab === 'import' && isManager ? (
        <ImportWizard onDone={(msg) => { setNotice(msg); setTab('pipeline'); refresh(); }}
          onError={setError} />
      ) : openRec ? (
        <RecordDrawer
          record={openRec}
          profile={profile}
          agents={agents}
          agentName={agentName}
          onBack={() => { setOpenRec(null); refresh(); }}
          onChanged={async () => {
            await refresh();
            const fresh = (await listRenewals({ status: 'all', assignedTo: 'all' }))
              .find((r) => r.id === openRec.id);
            if (fresh) setOpenRec(fresh);
          }}
          onError={setError}
          onNotice={setNotice}
        />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-3 gap-3">
            <div className={ui.stat}><div className={ui.statLabel}>Overdue follow-ups</div>
              <div className={ui.statValue}>{overdue}</div></div>
            <div className={ui.stat}><div className={ui.statLabel}>Renewing within 14 days</div>
              <div className={ui.statValue}>{dueSoon}</div></div>
            {isManager && (
              <div className={ui.stat}><div className={ui.statLabel}>Unassigned</div>
                <div className={ui.statValue}>{unassigned}</div></div>
            )}
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select className={`${ui.select} !mt-0 w-44`} value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as RenewalStatus | 'all' | 'open')}>
              <option value="open">Open (all working)</option>
              <option value="all">All statuses</option>
              {['imported','assigned','in_progress','monitoring','requote_sent','renewed','lost','cancelled']
                .map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
            {isManager && (
              <select className={`${ui.select} !mt-0 w-52`} value={agentFilter}
                onChange={(e) => setAgentFilter(e.target.value)}>
                <option value="all">All agents</option>
                <option value="unassigned">Unassigned</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
              </select>
            )}
          </div>

          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>Customer / Policy</th>
                  <th className={ui.th}>Carrier</th>
                  <th className={ui.th}>Renews</th>
                  <th className={ui.th}>Premium Δ</th>
                  <th className={ui.th}>Assigned</th>
                  <th className={ui.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const d = daysUntil(r.renewal_date);
                  return (
                    <tr key={r.id} className={ui.trHover} onClick={() => setOpenRec(r)}>
                      <td className={ui.td}>
                        <span className="font-medium">{r.customer_name}</span>
                        <div className="text-xs text-slate-500">{r.policy_number}</div>
                      </td>
                      <td className={ui.td}>{r.carrier ?? '—'}</td>
                      <td className={ui.td}>
                        {new Date(r.renewal_date + 'T00:00:00').toLocaleDateString()}
                        {OPEN_STATUSES.includes(r.status) && (
                          <div className={`text-xs ${d < 0 ? 'text-red-600' : d <= 14 ? 'text-amber-600' : 'text-slate-500'}`}>
                            {d < 0 ? `${-d}d past` : `in ${d}d`}
                          </div>
                        )}
                      </td>
                      <td className={ui.td}>{premiumDelta(r)}</td>
                      <td className={ui.td}>{agentName(r.assigned_to)}</td>
                      <td className={ui.td}>
                        <span className={`${ui.badge} ${ui.badgeTone[renewalStatusTone[r.status]]}`}>
                          {statusLabel(r.status)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr><td colSpan={6} className={ui.empty}>
                    {isManager
                      ? 'No renewals match these filters. Import the HawkSoft report to load the next batch.'
                      : 'No renewals assigned to you right now.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------ Record drawer ------------------------------ */

function RecordDrawer({ record: r, profile, agents, agentName, onBack, onChanged, onError, onNotice }: {
  record: RenewalRecord;
  profile: ProfileLite;
  agents: ProfileLite[];
  agentName: (id: string | null) => string;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onError: (m: string | null) => void;
  onNotice: (m: string | null) => void;
}) {
  const [contacts, setContacts] = useState<RenewalContact[]>([]);
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<RenewalContact['channel']>('call');
  const [outcome, setOutcome] = useState('reached');
  const [contactNotes, setContactNotes] = useState('');
  const [followUp, setFollowUp] = useState(r.next_follow_up_at?.slice(0, 16) ?? '');
  const [closeReason, setCloseReason] = useState('');
  const [assignTo, setAssignTo] = useState(r.assigned_to ?? '');

  const isManager = profile.role === 'manager';
  const canWork = isManager || r.assigned_to === profile.id;
  const isOpen = OPEN_STATUSES.includes(r.status);

  const loadContacts = useCallback(() => listContacts(r.id).then(setContacts), [r.id]);
  useEffect(() => { loadContacts(); }, [loadContacts]);

  async function run(fn: () => Promise<unknown>, okMsg: string) {
    setBusy(true); onError(null); onNotice(null);
    try { await fn(); onNotice(okMsg); await onChanged(); await loadContacts(); }
    catch (e: unknown) { onError(e instanceof Error ? e.message : 'Action failed.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className={ui.pageTitle}>{r.customer_name}</h2>
          <p className={ui.pageSubtitle}>
            <span className={`${ui.badge} ${ui.badgeTone[renewalStatusTone[r.status]]}`}>{statusLabel(r.status)}</span>
            <span className="ml-2">Policy {r.policy_number} · {r.carrier ?? 'carrier unknown'} · renews {new Date(r.renewal_date + 'T00:00:00').toLocaleDateString()}</span>
          </p>
        </div>
        <button className={ui.btnGhost} onClick={onBack}>← Back to renewals</button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className={ui.stat}><div className={ui.statLabel}>Current premium</div>
          <div className={ui.statValue}>{r.premium_current != null ? `$${Number(r.premium_current).toFixed(2)}` : '—'}</div></div>
        <div className={ui.stat}><div className={ui.statLabel}>Renewal premium</div>
          <div className={ui.statValue}>{r.premium_renewal != null ? `$${Number(r.premium_renewal).toFixed(2)}` : '—'}</div></div>
        <div className={ui.stat}><div className={ui.statLabel}>Change</div>
          <div className={ui.statValue}>{premiumDelta(r)}</div></div>
        <div className={ui.stat}><div className={ui.statLabel}>Assigned to</div>
          <div className="mt-1 text-lg font-semibold text-slate-900">{agentName(r.assigned_to)}</div></div>
      </div>

      <div className="text-sm text-slate-600">
        {r.customer_phone && <span className="mr-4">📞 {r.customer_phone}</span>}
        {r.customer_email && <span>✉️ {r.customer_email}</span>}
      </div>

      {/* Manager: assign */}
      {isManager && isOpen && (
        <div className={`${ui.card} ${ui.cardPad} flex flex-wrap items-end gap-2`}>
          <div className="w-56">
            <label className={ui.label}>Assign to agent</label>
            <select className={ui.select} value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
              <option value="">— choose —</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
            </select>
          </div>
          <button className={ui.btnPrimary} disabled={busy || !assignTo}
            onClick={() => run(() => assignRenewal(r.id, assignTo),
              'Renewal assigned. The agent was notified.')}>
            {r.assigned_to ? 'Reassign' : 'Assign'}
          </button>
        </div>
      )}

      {/* Work actions */}
      {canWork && isOpen && (
        <div className={`${ui.card} ${ui.cardPad} space-y-3`}>
          <h3 className={ui.sectionTitle}>Actions</h3>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className={ui.label}>Next follow-up</label>
              <input type="datetime-local" className={ui.input} value={followUp}
                onChange={(e) => setFollowUp(e.target.value)} />
            </div>
            <button className={ui.btnSecondary} disabled={busy || !followUp}
              onClick={() => run(
                () => updateRecord(r.id, profile.id, {
                  next_follow_up_at: new Date(followUp).toISOString(),
                  status: r.status === 'assigned' || r.status === 'in_progress' ? 'monitoring' : r.status,
                }),
                'Follow-up saved. The record is in Monitoring.')}>
              Set follow-up
            </button>
            <button className={ui.btnPrimary} disabled={busy || r.status === 'requote_sent'}
              onClick={() => run(() => sendToRequote(r.id),
                'Re-quote created in the Quotes Database.')}>
              Send to re-quote
            </button>
          </div>
          <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
            <div className="w-64">
              <label className={ui.label}>Close reason</label>
              <input className={ui.input} placeholder="e.g. price accepted / moved carriers"
                value={closeReason} onChange={(e) => setCloseReason(e.target.value)} />
            </div>
            <button className={ui.btnSecondary} disabled={busy}
              onClick={() => run(
                () => updateRecord(r.id, profile.id, {
                  status: 'renewed', outcome_reason: closeReason || null,
                  closed_at: new Date().toISOString(),
                }), 'Marked renewed.')}>
              Mark renewed
            </button>
            <button className={ui.btnDanger} disabled={busy || !closeReason.trim()}
              onClick={() => run(
                () => updateRecord(r.id, profile.id, {
                  status: 'lost', outcome_reason: closeReason.trim(),
                  closed_at: new Date().toISOString(),
                }), 'Marked lost.')}>
              Mark lost
            </button>
            <button className={ui.btnDanger} disabled={busy || !closeReason.trim()}
              onClick={() => run(
                () => updateRecord(r.id, profile.id, {
                  status: 'cancelled', outcome_reason: closeReason.trim(),
                  closed_at: new Date().toISOString(),
                }), 'Marked cancelled.')}>
              Mark cancelled
            </button>
          </div>
        </div>
      )}

      {/* Contact log */}
      <div className={ui.card}>
        <div className={ui.cardHeader}><h3 className={ui.sectionTitle}>Contact log ({contacts.length})</h3></div>
        {canWork && isOpen && (
          <div className={`${ui.cardPad} flex flex-wrap items-end gap-2 border-b border-slate-100`}>
            <div>
              <label className={ui.label}>Channel</label>
              <select className={ui.select} value={channel}
                onChange={(e) => setChannel(e.target.value as RenewalContact['channel'])}>
                {['call','sms','whatsapp','email','in_person','other'].map((c) =>
                  <option key={c} value={c}>{statusLabel(c)}</option>)}
              </select>
            </div>
            <div>
              <label className={ui.label}>Outcome</label>
              <select className={ui.select} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                {['reached','left_voicemail','no_answer','wrong_number','callback_scheduled','not_interested','other']
                  .map((o) => <option key={o} value={o}>{statusLabel(o)}</option>)}
              </select>
            </div>
            <div className="min-w-56 flex-1">
              <label className={ui.label}>Notes</label>
              <input className={ui.input} value={contactNotes} placeholder="What was discussed"
                onChange={(e) => setContactNotes(e.target.value)} />
            </div>
            <button className={ui.btnPrimary} disabled={busy}
              onClick={() => run(async () => {
                await addContact({
                  record_id: r.id, contacted_by: profile.id, channel,
                  direction: 'outbound', outcome, notes: contactNotes || null,
                });
                setContactNotes('');
              }, 'Contact logged.')}>
              Log contact
            </button>
          </div>
        )}
        <div className="divide-y divide-slate-100">
          {contacts.map((c) => (
            <div key={c.id} className="px-4 py-2.5 text-sm">
              <span className="font-medium text-slate-800">{statusLabel(c.channel)}</span>
              <span className="mx-1 text-slate-400">·</span>
              <span className="text-slate-700">{c.outcome ? statusLabel(c.outcome) : c.direction}</span>
              <span className="mx-1 text-slate-400">·</span>
              <span className="text-slate-500">{new Date(c.occurred_at).toLocaleString()}</span>
              {c.entry_source === 'ringcentral_api' && (
                <span className={`${ui.badge} ${ui.badgeTone.info} ml-2`}>RingCentral</span>
              )}
              {c.notes && <div className="mt-0.5 text-slate-600">{c.notes}</div>}
            </div>
          ))}
          {!contacts.length && <div className={ui.empty}>No contacts logged yet.</div>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Import wizard ------------------------------ */

function ImportWizard({ onDone, onError }: {
  onDone: (msg: string) => void;
  onError: (m: string | null) => void;
}) {
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  function handleFile(f: File) {
    setFileName(f.name);
    f.text().then((text) => {
      const { headers: h, rows } = parseCsv(text);
      setHeaders(h);
      setDataRows(rows);
      setMapping(guessMapping(h));
      onError(null);
    });
  }

  const preview: (NormalizedImportRow & { _error?: string })[] = useMemo(() => {
    if (!dataRows.length) return [];
    const idx = (field: string) => headers.indexOf(mapping[field] ?? '');
    const val = (row: string[], field: string) => {
      const i = idx(field);
      return i >= 0 ? (row[i] ?? '').trim() : '';
    };
    return dataRows.map((row) => {
      const rawDate = val(row, 'renewal_date');
      const date = normalizeDate(rawDate);
      const out: NormalizedImportRow & { _error?: string } = {
        policy_number: val(row, 'policy_number'),
        renewal_date: date ?? '',
        customer_name: val(row, 'customer_name'),
        customer_phone: val(row, 'customer_phone') || undefined,
        customer_email: val(row, 'customer_email') || undefined,
        carrier: val(row, 'carrier') || undefined,
        line_of_business: val(row, 'line_of_business') || undefined,
        hawksoft_client_id: val(row, 'hawksoft_client_id') || undefined,
        premium_current: val(row, 'premium_current').replace(/[$,]/g, '') || undefined,
        premium_renewal: val(row, 'premium_renewal').replace(/[$,]/g, '') || undefined,
        raw: Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])),
      };
      if (!out.policy_number) out._error = 'Missing policy number';
      else if (!date) out._error = rawDate ? `Unreadable date "${rawDate}"` : 'Missing renewal date';
      else if (!out.customer_name) out._error = 'Missing customer name';
      return out;
    });
  }, [dataRows, headers, mapping]);

  const valid = preview.filter((p) => !p._error);
  const invalid = preview.filter((p) => p._error);

  async function commit() {
    setBusy(true); onError(null);
    try {
      const result = await importBatch(fileName, mapping,
        valid.map(({ _error, ...row }) => row));
      onDone(`Import complete: ${result.rows_inserted} added, ${result.rows_updated} premium-updated, ${result.rows_skipped} skipped as duplicates.${invalid.length ? ` ${invalid.length} invalid rows were not sent.` : ''}`);
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : 'Import failed. No rows were saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className={`${ui.card} ${ui.cardPad}`}>
        <h3 className={ui.sectionTitle}>1 — Upload the HawkSoft / Power BI export (CSV)</h3>
        <input type="file" accept=".csv,text/csv" className="mt-2 text-sm"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
        {fileName && <p className="mt-1 text-xs text-slate-500">{fileName} · {dataRows.length} rows</p>}
      </div>

      {headers.length > 0 && (
        <div className={`${ui.card} ${ui.cardPad}`}>
          <h3 className={ui.sectionTitle}>2 — Match the report columns</h3>
          <p className="mt-1 text-xs text-slate-500">
            Matched automatically where possible — correct anything that looks wrong.
          </p>
          <div className={`mt-3 ${ui.fieldRow}`}>
            {Object.entries(FIELD_LABELS).map(([field, label]) => (
              <div key={field}>
                <label className={ui.label}>{label}</label>
                <select className={ui.select} value={mapping[field] ?? ''}
                  onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))}>
                  <option value="">— not in this report —</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {preview.length > 0 && (
        <div className={ui.card}>
          <div className={ui.cardHeader}>
            <h3 className={ui.sectionTitle}>
              3 — Preview: {valid.length} ready{invalid.length ? `, ${invalid.length} invalid` : ''}
            </h3>
            <button className={ui.btnPrimary} disabled={busy || !valid.length} onClick={commit}>
              Import {valid.length} renewals
            </button>
          </div>
          <div className="max-h-80 overflow-auto">
            <table className={ui.table}>
              <thead><tr>
                <th className={ui.th}>Policy</th><th className={ui.th}>Customer</th>
                <th className={ui.th}>Renews</th><th className={ui.th}>Carrier</th>
                <th className={ui.th}>Premium</th><th className={ui.th}>Issue</th>
              </tr></thead>
              <tbody>
                {preview.slice(0, 100).map((p, i) => (
                  <tr key={i} className={p._error ? 'bg-red-50' : ''}>
                    <td className={ui.td}>{p.policy_number || '—'}</td>
                    <td className={ui.td}>{p.customer_name || '—'}</td>
                    <td className={ui.td}>{p.renewal_date || '—'}</td>
                    <td className={ui.td}>{p.carrier ?? '—'}</td>
                    <td className={ui.td}>
                      {p.premium_current ?? '—'} → {p.premium_renewal ?? '—'}
                    </td>
                    <td className={`${ui.td} text-red-600`}>{p._error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.length > 100 && (
              <p className="px-3 py-2 text-xs text-slate-500">
                Showing the first 100 of {preview.length} rows. All valid rows will be imported.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

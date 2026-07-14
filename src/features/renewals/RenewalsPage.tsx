'use client';

import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  FileClock,
  FileUp,
  Mail,
  MessageSquareText,
  Paperclip,
  Pencil,
  Phone,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  UploadCloud,
  UserCheck,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  getSupabase,
  listRenewalAssignees,
} from '../nhwd-shared/client';
import type { ProfileLite } from '../nhwd-shared/types';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import { renewalStatusTone, statusLabel, ui } from '../nhwd-shared/ui';
import {
  addContact,
  assignRenewal,
  buildNormalizedRows,
  generateDueNotifications,
  getEvidenceUrl,
  guessMapping,
  importBatch,
  listContacts,
  listRenewalEvents,
  listRenewals,
  managerUpdateRecord,
  normalizeDate,
  parseCsv,
  sendToRequote,
  updateWorkflow,
  type ImportBatchResult,
  type NormalizedImportRow,
  type RenewalChannel,
  type RenewalContact,
  type RenewalEvent,
  type RenewalRecord,
  type RenewalStatus,
} from './api';

const OPEN_STATUSES: RenewalStatus[] = ['imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent'];
const CLOSED_STATUSES: RenewalStatus[] = ['renewed', 'lost', 'cancelled'];
const IMPORT_FIELDS: Array<{ key: keyof NormalizedImportRow; label: string; required?: boolean }> = [
  { key: 'policy_number', label: 'Policy number', required: true },
  { key: 'renewal_date', label: 'Renewal / expiration date', required: true },
  { key: 'customer_name', label: 'Customer name', required: true },
  { key: 'customer_phone', label: 'Phone' },
  { key: 'customer_email', label: 'Email' },
  { key: 'carrier', label: 'Carrier' },
  { key: 'line_of_business', label: 'Line of business' },
  { key: 'hawksoft_client_id', label: 'HawkSoft client ID' },
  { key: 'premium_current', label: 'Current premium' },
  { key: 'premium_renewal', label: 'Renewal premium' },
];

function daysUntil(date: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(`${date}T00:00:00`).getTime() - today.getTime()) / 86_400_000);
}

function warningLabel(row: RenewalRecord): { label: string; tone: keyof typeof ui.badgeTone } {
  const days = daysUntil(row.renewal_date);
  if (!OPEN_STATUSES.includes(row.status)) return { label: statusLabel(row.status), tone: renewalStatusTone[row.status] as keyof typeof ui.badgeTone };
  if (days < 0) return { label: `${Math.abs(days)}d overdue`, tone: 'danger' };
  if (days <= 7) return { label: `${days} days`, tone: 'danger' };
  if (days <= 15) return { label: `${days} days`, tone: 'progress' };
  if (days <= 30) return { label: `${days} days`, tone: 'info' };
  return { label: `${days} days`, tone: 'neutral' };
}

function money(value: number | null): string {
  if (value === null || Number.isNaN(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));
}

function premiumDelta(row: RenewalRecord): string {
  if (row.premium_current === null || row.premium_renewal === null || Number(row.premium_current) === 0) return '—';
  const percent = ((Number(row.premium_renewal) - Number(row.premium_current)) / Number(row.premium_current)) * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

function assigneeName(assignees: ProfileLite[], id: string | null): string {
  return assignees.find((profile) => profile.id === id)?.display_name || 'Unassigned';
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`rounded-xl px-4 py-2.5 text-sm font-black transition ${active ? 'bg-[#223f7a] text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-[#223f7a]'}`}>{children}</button>;
}

function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-sm" onMouseDown={onClose}>
      <div className="ml-auto h-full w-full max-w-3xl overflow-y-auto bg-[#f3f5f9] shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur">
          <div><p className="text-xs font-black uppercase tracking-[0.15em] text-[#223f7a]">Renewal Record</p><p className="text-sm font-semibold text-slate-500">All contacts, proof, follow-up, and changes stay attached here.</p></div>
          <button type="button" className={ui.btnGhost} onClick={onClose}><X className="h-4 w-4" />Close</button>
        </div>
        <div className="p-4 sm:p-6">{children}</div>
      </div>
    </div>
  );
}

function RenewalDrawer({
  record,
  profile,
  assignees,
  onChanged,
  onClose,
}: {
  record: RenewalRecord;
  profile: ProfileLite;
  assignees: ProfileLite[];
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [contacts, setContacts] = useState<RenewalContact[]>([]);
  const [events, setEvents] = useState<RenewalEvent[]>([]);
  const [tab, setTab] = useState<'work' | 'history' | 'edit'>('work');
  const [channel, setChannel] = useState<RenewalChannel>('call');
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const [outcome, setOutcome] = useState('No answer');
  const [notes, setNotes] = useState('');
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidenceReference, setEvidenceReference] = useState('');
  const [nextFollowUp, setNextFollowUp] = useState(record.next_follow_up_at ? record.next_follow_up_at.slice(0, 16) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [edit, setEdit] = useState({
    hawksoft_client_id: record.hawksoft_client_id || '',
    policy_number: record.policy_number,
    line_of_business: record.line_of_business || '',
    carrier: record.carrier || '',
    customer_name: record.customer_name,
    customer_phone: record.customer_phone || '',
    customer_email: record.customer_email || '',
    renewal_date: record.renewal_date,
    premium_current: record.premium_current?.toString() || '',
    premium_renewal: record.premium_renewal?.toString() || '',
  });

  const isManager = profile.role === 'manager';
  const activeRecord = OPEN_STATUSES.includes(record.status);
  const requiresEvidence = ['call', 'sms', 'email'].includes(channel);

  const loadHistory = useCallback(async () => {
    try {
      const [contactRows, eventRows] = await Promise.all([listContacts(record.id), listRenewalEvents(record.id)]);
      setContacts(contactRows);
      setEvents(eventRows);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load renewal history.');
    }
  }, [record.id]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  async function run(task: () => Promise<void>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await task();
      setNotice(success);
      await loadHistory();
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The renewal could not be updated.');
    } finally {
      setBusy(false);
    }
  }

  async function saveContact() {
    if (!notes.trim()) return setError('Contact notes are required.');
    if (requiresEvidence && !evidenceFile && !evidenceReference.trim()) return setError('Attach proof or enter a contact/reference record for calls, SMS, and email.');
    await run(async () => {
      await addContact({
        recordId: record.id,
        channel,
        direction,
        outcome,
        notes: notes.trim(),
        evidenceFile,
        evidenceReference: evidenceReference.trim() || null,
      });
      setNotes('');
      setEvidenceFile(null);
      setEvidenceReference('');
    }, 'Customer interaction recorded with timestamp and proof.');
  }

  async function saveFollowUp() {
    if (!nextFollowUp) return setError('Select the next follow-up date and time.');
    await run(() => updateWorkflow(record.id, { status: 'monitoring', nextFollowUpAt: new Date(nextFollowUp).toISOString() }), 'Next follow-up scheduled.');
  }

  async function closeRecord(status: 'renewed' | 'lost' | 'cancelled') {
    const reason = window.prompt(status === 'renewed' ? 'Renewal completion note:' : `Reason the renewal is ${status}:`);
    if (!reason?.trim()) return;
    await run(() => updateWorkflow(record.id, { status, outcomeReason: reason.trim() }), `Renewal marked ${statusLabel(status)}.`);
  }

  async function prepareRequote() {
    setBusy(true);
    setError(null);
    try {
      const intakeId = record.requote_intake_id || await sendToRequote(record.id);
      window.location.assign(`/tools/cs-intake?edit=${encodeURIComponent(intakeId)}&from=renewal`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The re-quote intake could not be prepared.');
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!edit.policy_number.trim() || !edit.customer_name.trim() || !normalizeDate(edit.renewal_date)) return setError('Policy number, customer name, and a valid renewal date are required.');
    await run(() => managerUpdateRecord(record.id, {
      hawksoft_client_id: edit.hawksoft_client_id.trim() || null,
      policy_number: edit.policy_number.trim(),
      line_of_business: edit.line_of_business.trim() || null,
      carrier: edit.carrier.trim() || null,
      customer_name: edit.customer_name.trim(),
      customer_phone: edit.customer_phone.trim() || null,
      customer_email: edit.customer_email.trim() || null,
      renewal_date: edit.renewal_date,
      premium_current: edit.premium_current === '' ? null : Number(edit.premium_current),
      premium_renewal: edit.premium_renewal === '' ? null : Number(edit.premium_renewal),
    }), 'Manager corrections saved and logged.');
  }

  const warning = warningLabel(record);

  return (
    <div className="space-y-5">
      {error ? <div className={ui.error}>{error}</div> : null}
      {notice ? <div className={ui.success}>{notice}</div> : null}

      <section className={`${ui.card} ${ui.cardPad}`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div><p className="text-2xl font-black text-slate-950">{record.customer_name}</p><p className="mt-1 text-sm font-semibold text-slate-500">Policy {record.policy_number} · {record.carrier || 'Carrier not recorded'}</p><div className="mt-3 flex flex-wrap gap-2"><span className={`${ui.badge} ${ui.badgeTone[renewalStatusTone[record.status] || 'neutral']}`}>{statusLabel(record.status)}</span><span className={`${ui.badge} ${ui.badgeTone[warning.tone]}`}>{warning.label}</span></div></div>
          <div className="rounded-2xl bg-[#eef3fb] p-4 text-right"><p className="text-xs font-black uppercase tracking-wider text-[#223f7a]">Renewal date</p><p className="mt-1 text-xl font-black text-slate-950">{new Date(`${record.renewal_date}T00:00:00`).toLocaleDateString()}</p></div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-black uppercase text-slate-400">Assigned to</p><p className="mt-1 font-black">{assigneeName(assignees, record.assigned_to)}</p></div>
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-black uppercase text-slate-400">Current premium</p><p className="mt-1 font-black">{money(record.premium_current)}</p></div>
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-black uppercase text-slate-400">Renewal premium</p><p className="mt-1 font-black">{money(record.premium_renewal)}</p></div>
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-black uppercase text-slate-400">Change</p><p className={`mt-1 font-black ${premiumDelta(record).startsWith('+') ? 'text-rose-700' : 'text-emerald-700'}`}>{premiumDelta(record)}</p></div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2"><p className="rounded-xl border border-slate-200 bg-white p-3 text-sm font-semibold"><Phone className="mr-2 inline h-4 w-4 text-[#223f7a]" />{record.customer_phone || 'No phone recorded'}</p><p className="rounded-xl border border-slate-200 bg-white p-3 text-sm font-semibold"><Mail className="mr-2 inline h-4 w-4 text-[#223f7a]" />{record.customer_email || 'No email recorded'}</p></div>
      </section>

      <div className="flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1.5">
        <TabButton active={tab === 'work'} onClick={() => setTab('work')}>Work Renewal</TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>History & Evidence</TabButton>
        {isManager ? <TabButton active={tab === 'edit'} onClick={() => setTab('edit')}>Manager Edit</TabButton> : null}
      </div>

      {tab === 'work' ? (
        <div className="space-y-5">
          {isManager ? (
            <section className={`${ui.card} ${ui.cardPad}`}>
              <p className={ui.sectionTitle}>Assignment</p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <select className={ui.select} value={record.assigned_to || ''} disabled={busy} onChange={(event) => void run(() => assignRenewal(record.id, event.target.value), `Renewal assigned to ${assigneeName(assignees, event.target.value)}.`)}><option value="" disabled>Assign to Agent or Customer Service</option>{assignees.map((person) => <option key={person.id} value={person.id}>{person.display_name} · {person.role === 'customer_service' ? 'Customer Service' : 'Sales Agent'}</option>)}</select>
              </div>
            </section>
          ) : null}

          <section className={`${ui.card} ${ui.cardPad}`}>
            <div className="flex items-start gap-3"><div className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan-50 text-cyan-700"><MessageSquareText className="h-5 w-5" /></div><div><h3 className="font-black text-slate-950">Log customer contact</h3><p className="mt-1 text-sm font-semibold text-slate-500">Notes are always required. Calls, SMS, and email also require proof or a contact reference.</p></div></div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label><span className={ui.label}>Method</span><select className={ui.select} disabled={busy || !activeRecord} value={channel} onChange={(event) => setChannel(event.target.value as RenewalChannel)}><option value="call">Call</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="in_person">In Person</option><option value="other">Other</option></select></label>
              <label><span className={ui.label}>Direction</span><select className={ui.select} disabled={busy || !activeRecord} value={direction} onChange={(event) => setDirection(event.target.value as 'outbound' | 'inbound')}><option value="outbound">Outbound</option><option value="inbound">Inbound</option></select></label>
              <label className="sm:col-span-2"><span className={ui.label}>Outcome</span><select className={ui.select} disabled={busy || !activeRecord} value={outcome} onChange={(event) => setOutcome(event.target.value)}><option>No answer</option><option>Left voicemail</option><option>Customer reached</option><option>Customer requested callback</option><option>Customer reviewing renewal</option><option>Customer wants re-quote</option><option>Wrong number</option><option>Other</option></select></label>
            </div>
            <label className="mt-4 block"><span className={ui.label}>Mandatory notes</span><textarea className={ui.textarea} rows={4} disabled={busy || !activeRecord} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What happened, what the customer said, and the next step." /></label>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label><span className={ui.label}>Upload proof</span><input type="file" className={`${ui.input} file:mr-3 file:rounded-lg file:border-0 file:bg-[#eef3fb] file:px-3 file:py-1.5 file:text-xs file:font-black file:text-[#223f7a]`} disabled={busy || !activeRecord} onChange={(event) => setEvidenceFile(event.target.files?.[0] || null)} /></label>
              <label><span className={ui.label}>Or contact/reference record</span><input className={ui.input} disabled={busy || !activeRecord} value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} placeholder="RingCentral ID, attachment reference, email message ID…" /></label>
            </div>
            <button type="button" className={`${ui.btnPrimary} mt-4`} disabled={busy || !activeRecord} onClick={() => void saveContact()}><ClipboardCheck className="h-4 w-4" />Save Interaction</button>
          </section>

          <section className={`${ui.card} ${ui.cardPad}`}>
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <p className={ui.sectionTitle}>Next follow-up</p>
                <input type="datetime-local" className={ui.input} disabled={busy || !activeRecord} value={nextFollowUp} onChange={(event) => setNextFollowUp(event.target.value)} />
                <button type="button" className={`${ui.btnSecondary} mt-3`} disabled={busy || !activeRecord} onClick={() => void saveFollowUp()}><CalendarClock className="h-4 w-4" />Schedule and Monitor</button>
              </div>
              <div>
                <p className={ui.sectionTitle}>Send to Sales</p>
                <p className="mt-2 text-sm font-semibold leading-6 text-slate-500">Creates a linked Requote Intake in the shared Sales Intake Queue. Customer Service keeps renewal-contact credit; Sales claims ownership.</p>
                <button type="button" className={`${ui.btnPrimary} mt-3`} disabled={busy || !activeRecord || Boolean(record.requote_work_item_id)} onClick={() => void prepareRequote()}><Send className="h-4 w-4" />{record.requote_work_item_id ? 'Quote Already Created' : record.requote_intake_id ? 'Continue Requote Intake' : 'Prepare Requote Intake'}</button>
              </div>
            </div>
          </section>

          <section className={`${ui.card} ${ui.cardPad}`}>
            <p className={ui.sectionTitle}>Close renewal</p>
            <div className="mt-3 flex flex-wrap gap-2"><button className={ui.btnPrimary} disabled={busy || !activeRecord} onClick={() => void closeRecord('renewed')}><CheckCircle2 className="h-4 w-4" />Renewed</button><button className={ui.btnDanger} disabled={busy || !activeRecord} onClick={() => void closeRecord('lost')}><XCircle className="h-4 w-4" />Lost</button><button className={ui.btnSecondary} disabled={busy || !activeRecord} onClick={() => void closeRecord('cancelled')}>Cancelled</button></div>
          </section>
        </div>
      ) : null}

      {tab === 'history' ? (
        <section className={`${ui.card} overflow-hidden`}>
          <div className={ui.cardHeader}><div><p className={ui.sectionTitle}>Audit history</p><h3 className="mt-1 text-xl font-black">Contacts, proof, uploads and manager changes</h3></div><button type="button" className={ui.btnSecondary} onClick={() => void loadHistory()}><RefreshCw className="h-4 w-4" />Refresh</button></div>
          <div className="space-y-3 p-5">
            {contacts.map((contact) => (
              <div key={contact.id} className="rounded-2xl border border-cyan-100 bg-cyan-50/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-black text-slate-900">{statusLabel(contact.channel)} · {contact.outcome || 'Contact logged'}</p><p className="mt-1 text-xs font-semibold text-slate-500">{new Date(contact.occurred_at).toLocaleString()} · {statusLabel(contact.direction)}</p></div><span className={`${ui.badge} ${ui.badgeTone.cyan}`}>{contact.entry_source === 'ringcentral_api' ? 'RingCentral' : 'Manual'}</span></div>
                <p className="mt-3 whitespace-pre-wrap text-sm font-semibold leading-6 text-slate-700">{contact.notes}</p>
                {(contact.evidence_path || contact.evidence_reference || contact.rc_recording_content_uri) ? <button type="button" className={`${ui.btnSecondary} mt-3`} onClick={() => void getEvidenceUrl(contact).then((url) => { if (url) window.open(url, '_blank', 'noopener,noreferrer'); })}><Paperclip className="h-4 w-4" />Open Evidence{contact.evidence_name ? ` · ${contact.evidence_name}` : ''}</button> : null}
              </div>
            ))}
            {events.map((event) => <div key={event.id} className="rounded-2xl border border-slate-200 bg-white p-4"><div className="flex items-center justify-between gap-3"><p className="font-black text-slate-900">{statusLabel(event.event_type)}</p><p className="text-xs font-bold text-slate-400">{new Date(event.created_at).toLocaleString()}</p></div>{event.detail ? <pre className="mt-3 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-600">{JSON.stringify(event.detail, null, 2)}</pre> : null}</div>)}
            {!contacts.length && !events.length ? <div className={ui.empty}>No renewal history has been recorded yet.</div> : null}
          </div>
        </section>
      ) : null}

      {tab === 'edit' && isManager ? (
        <section className={`${ui.card} ${ui.cardPad}`}>
          <div className="flex items-start gap-3"><div className="grid h-10 w-10 place-items-center rounded-2xl bg-violet-50 text-violet-700"><Pencil className="h-5 w-5" /></div><div><h3 className="font-black">Manager record correction</h3><p className="mt-1 text-sm font-semibold text-slate-500">Every changed value is written to the renewal event log. Closed records remain protected from CSV overwrite.</p></div></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {([
              ['customer_name', 'Customer name', 'text'],
              ['policy_number', 'Policy number', 'text'],
              ['renewal_date', 'Renewal date', 'date'],
              ['carrier', 'Carrier', 'text'],
              ['line_of_business', 'Line of business', 'text'],
              ['hawksoft_client_id', 'HawkSoft client ID', 'text'],
              ['customer_phone', 'Phone', 'tel'],
              ['customer_email', 'Email', 'email'],
              ['premium_current', 'Current premium', 'number'],
              ['premium_renewal', 'Renewal premium', 'number'],
            ] as const).map(([key, label, type]) => <label key={key}><span className={ui.label}>{label}</span><input type={type} step={type === 'number' ? '0.01' : undefined} className={ui.input} disabled={busy} value={edit[key]} onChange={(event) => setEdit((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
          </div>
          <button type="button" className={`${ui.btnPrimary} mt-5`} disabled={busy} onClick={() => void saveEdit()}><ShieldCheck className="h-4 w-4" />Save Manager Corrections</button>
        </section>
      ) : null}
    </div>
  );
}

function ImportWizard({ onComplete }: { onComplete: () => Promise<void> }) {
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<NormalizedImportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportBatchResult | null>(null);

  async function loadFile(file: File | null) {
    if (!file) return;
    setError(null);
    setResult(null);
    const parsed = parseCsv(await file.text());
    if (!parsed.headers.length) return setError('The CSV did not contain headers.');
    const guessed = guessMapping(parsed.headers);
    setFileName(file.name);
    setHeaders(parsed.headers);
    setRawRows(parsed.rows);
    setMapping(guessed);
    setPreview(buildNormalizedRows(parsed.headers, parsed.rows, guessed).slice(0, 15));
  }

  function changeMapping(field: string, header: string) {
    const next = { ...mapping, [field]: header };
    if (!header) delete next[field];
    setMapping(next);
    setPreview(buildNormalizedRows(headers, rawRows, next).slice(0, 15));
  }

  async function commit() {
    const rows = buildNormalizedRows(headers, rawRows, mapping);
    if (!mapping.policy_number || !mapping.renewal_date || !mapping.customer_name) return setError('Map Policy number, Renewal date, and Customer name before importing.');
    if (!rows.length) return setError('No valid rows were found after mapping.');
    setBusy(true);
    setError(null);
    try {
      const imported = await importBatch(fileName, mapping, rows);
      setResult(imported);
      await onComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The renewal file could not be imported.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className={`${ui.card} ${ui.cardPad}`}>
        <div className="flex items-start gap-3"><div className="grid h-10 w-10 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]"><UploadCloud className="h-5 w-5" /></div><div><h2 className="text-xl font-black">Upload or update HawkSoft / Power BI renewal data</h2><p className="mt-1 text-sm font-semibold leading-6 text-slate-500">Open records are matched by policy number + renewal date and updated with a full change log. Closed records are never overwritten.</p></div></div>
        <label className="mt-5 block rounded-2xl border-2 border-dashed border-[#b5c4df] bg-[#f8faff] p-8 text-center"><FileUp className="mx-auto h-8 w-8 text-[#223f7a]" /><p className="mt-3 font-black text-slate-900">Choose CSV export</p><p className="mt-1 text-sm font-semibold text-slate-500">The file is previewed before anything is committed.</p><input type="file" accept=".csv,text/csv" className="mt-4 block w-full text-sm font-semibold" onChange={(event) => void loadFile(event.target.files?.[0] || null)} /></label>
      </section>
      {error ? <div className={ui.error}>{error}</div> : null}
      {result ? <div className={ui.success}>Import complete: {result.rows_inserted} new, {result.rows_updated} updated, {result.rows_skipped} skipped{result.rows_closed_preserved ? `, ${result.rows_closed_preserved} closed records preserved` : ''}.</div> : null}

      {headers.length ? (
        <section className={`${ui.card} ${ui.cardPad}`}>
          <p className={ui.sectionTitle}>Column mapping</p><h3 className="mt-1 text-xl font-black">Confirm how the file maps to Renewals</h3>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {IMPORT_FIELDS.map((field) => <label key={field.key}><span className={ui.label}>{field.label}{field.required ? ' *' : ''}</span><select className={ui.select} value={mapping[field.key] || ''} onChange={(event) => changeMapping(field.key, event.target.value)}><option value="">Do not import</option>{headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></label>)}
          </div>
        </section>
      ) : null}

      {preview.length ? (
        <section className={`${ui.card} overflow-hidden`}>
          <div className={ui.cardHeader}><div><p className={ui.sectionTitle}>Preview</p><h3 className="mt-1 text-xl font-black">First {preview.length} valid rows</h3></div><button type="button" className={ui.btnPrimary} disabled={busy} onClick={() => void commit()}><UploadCloud className="h-4 w-4" />Commit {buildNormalizedRows(headers, rawRows, mapping).length} Rows</button></div>
          <div className="overflow-x-auto"><table className={ui.table}><thead><tr><th className={ui.th}>Customer</th><th className={ui.th}>Policy</th><th className={ui.th}>Renewal</th><th className={ui.th}>Carrier</th><th className={ui.th}>Premium</th></tr></thead><tbody>{preview.map((row, index) => <tr key={`${row.policy_number}-${index}`}><td className={ui.td}>{row.customer_name}</td><td className={ui.td}>{row.policy_number}</td><td className={ui.td}>{row.renewal_date}</td><td className={ui.td}>{row.carrier || '—'}</td><td className={ui.td}>{row.premium_renewal || row.premium_current || '—'}</td></tr>)}</tbody></table></div>
        </section>
      ) : null}
    </div>
  );
}

export default function RenewalsPage({ initialProfile: profile }: { initialProfile: ProfileLite }) {
  const [assignees, setAssignees] = useState<ProfileLite[]>([]);
  const [rows, setRows] = useState<RenewalRecord[]>([]);
  const [tab, setTab] = useState<'overview' | 'pipeline' | 'import'>('overview');
  const [statusFilter, setStatusFilter] = useState<'open' | 'all' | RenewalStatus>('open');
  const [assignedFilter, setAssignedFilter] = useState('all');
  const [dueFilter, setDueFilter] = useState<'all' | 'active30' | 'overdue'>('active30');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const effectiveAssignee = profile.role === 'manager' ? assignedFilter : profile.id;
      const [renewalRows, people] = await Promise.all([
        listRenewals({ status: statusFilter, assignedTo: effectiveAssignee, dueWindow: dueFilter, search }),
        profile.role === 'manager' ? listRenewalAssignees() : Promise.resolve([]),
      ]);
      setRows(renewalRows);
      setAssignees(people);
      setLastUpdated(new Date());
      if (profile.role === 'manager') void generateDueNotifications().catch(() => undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load Renewals.');
    } finally {
      setLoading(false);
    }
  }, [assignedFilter, dueFilter, profile, search, statusFilter]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel('renewals-v097')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'renewal_records' }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'renewal_contacts' }, () => void refresh())
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

  const selected = rows.find((row) => row.id === selectedId) || null;
  const metrics = useMemo(() => {
    const active = rows.filter((row) => OPEN_STATUSES.includes(row.status));
    return {
      due30: active.filter((row) => daysUntil(row.renewal_date) >= 0 && daysUntil(row.renewal_date) <= 30).length,
      due15: active.filter((row) => daysUntil(row.renewal_date) >= 0 && daysUntil(row.renewal_date) <= 15).length,
      due7: active.filter((row) => daysUntil(row.renewal_date) >= 0 && daysUntil(row.renewal_date) <= 7).length,
      overdue: active.filter((row) => daysUntil(row.renewal_date) < 0).length,
      unassigned: active.filter((row) => !row.assigned_to).length,
      followUps: active.filter((row) => row.next_follow_up_at && new Date(row.next_follow_up_at).getTime() <= Date.now() + 86_400_000).length,
    };
  }, [rows]);

  if (loading) return <div className="grid min-h-screen place-items-center bg-[#f3f5f9] font-black text-slate-500">Loading Renewals…</div>;
  if (!['agent', 'manager', 'customer_service'].includes(profile.role)) return <div className="grid min-h-screen place-items-center bg-[#f3f5f9]"><div className={ui.error}>Your account does not have Renewals access.</div></div>;

  return (
    <ModuleShell
      title="Renewals Management"
      subtitle="Start 30 days before expiration, document every contact with proof, schedule follow-up, and send customers to the shared Sales Intake Queue when a re-quote is needed."
      role={profile.role}
      lastUpdated={lastUpdated}
      onRefresh={() => void refresh()}
    >
      {error ? <div className={`${ui.error} mb-5`}>{error}</div> : null}
      {notice ? <div className={`${ui.success} mb-5`}>{notice}</div> : null}

      <div className="mb-5 flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm">
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabButton>
        <TabButton active={tab === 'pipeline'} onClick={() => setTab('pipeline')}>Renewal Pipeline</TabButton>
        {profile.role === 'manager' ? <TabButton active={tab === 'import'} onClick={() => setTab('import')}>Import & Update Data</TabButton> : null}
      </div>

      {tab === 'overview' ? (
        <div className="space-y-5">
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            <div className={ui.stat}><p className={ui.statLabel}>30-Day Window</p><p className={ui.statValue}>{metrics.due30}</p></div>
            <div className={ui.stat}><p className={ui.statLabel}>15-Day Warning</p><p className={ui.statValue}>{metrics.due15}</p></div>
            <div className={ui.stat}><p className={ui.statLabel}>7-Day Warning</p><p className={ui.statValue}>{metrics.due7}</p></div>
            <div className={ui.stat}><p className={ui.statLabel}>Overdue</p><p className="mt-1 text-3xl font-black text-rose-700">{metrics.overdue}</p></div>
            <div className={ui.stat}><p className={ui.statLabel}>Unassigned</p><p className="mt-1 text-3xl font-black text-amber-700">{metrics.unassigned}</p></div>
            <div className={ui.stat}><p className={ui.statLabel}>Follow-Up Due</p><p className="mt-1 text-3xl font-black text-violet-700">{metrics.followUps}</p></div>
          </section>
          <section className="grid gap-5 lg:grid-cols-3">
            <div className={`${ui.card} ${ui.cardPad} lg:col-span-2`}><div className="flex items-start gap-3"><div className="grid h-10 w-10 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]"><FileClock className="h-5 w-5" /></div><div><h2 className="text-xl font-black">30-day renewal workflow</h2><p className="mt-1 text-sm font-semibold leading-6 text-slate-500">At 30 days the record becomes active. The assignee contacts the customer, logs proof, schedules follow-up, and either closes the renewal or sends it to Sales for re-quoting.</p></div></div><div className="mt-5 grid gap-3 sm:grid-cols-4">{['Assigned','Contact & Proof','Monitor / Requote','Renewed or Closed'].map((step, index) => <div key={step} className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-black text-[#223f7a]">0{index + 1}</p><p className="mt-2 font-black text-slate-800">{step}</p></div>)}</div></div>
            <div className={`${ui.card} ${ui.cardPad}`}><p className={ui.sectionTitle}>Quick access</p><button className={`${ui.btnPrimary} mt-4 w-full`} onClick={() => setTab('pipeline')}><ClipboardCheck className="h-4 w-4" />Open Renewal Pipeline</button>{profile.role === 'manager' ? <button className={`${ui.btnSecondary} mt-3 w-full`} onClick={() => setTab('import')}><FileUp className="h-4 w-4" />Upload Updated Data</button> : null}</div>
          </section>
          <section className={`${ui.card} overflow-hidden`}><div className={ui.cardHeader}><div><p className={ui.sectionTitle}>Priority list</p><h2 className="mt-1 text-xl font-black">Closest deadlines</h2></div><button className={ui.btnSecondary} onClick={() => setTab('pipeline')}>View All <ChevronRight className="h-4 w-4" /></button></div><div className="divide-y divide-slate-100">{rows.slice(0, 8).map((row) => { const warning = warningLabel(row); return <button key={row.id} className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-[#f8faff]" onClick={() => setSelectedId(row.id)}><div><p className="font-black text-slate-900">{row.customer_name}</p><p className="mt-1 text-xs font-semibold text-slate-500">{row.policy_number} · {assigneeName(assignees, row.assigned_to)}</p></div><span className={`${ui.badge} ${ui.badgeTone[warning.tone]}`}>{warning.label}</span></button>})}{!rows.length ? <div className={ui.empty}>No renewal records in this view.</div> : null}</div></section>
        </div>
      ) : null}

      {tab === 'pipeline' ? (
        <section className={`${ui.card} overflow-hidden`}>
          <div className={ui.cardHeader}><div><p className={ui.sectionTitle}>Renewal Pipeline</p><h2 className="mt-1 text-xl font-black">{profile.role === 'manager' ? 'Agency renewal workload' : 'My assigned renewals'}</h2></div><button type="button" className={ui.btnSecondary} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" />Refresh</button></div>
          <div className="grid gap-3 border-b border-slate-100 p-4 xl:grid-cols-[1fr_180px_190px_190px]">
            <label className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 text-sm font-semibold outline-none" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search customer, policy, carrier, phone or email" /></label>
            <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="open">Open statuses</option><option value="all">All statuses</option>{[...OPEN_STATUSES, ...CLOSED_STATUSES].map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select>
            <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={dueFilter} onChange={(event) => setDueFilter(event.target.value as typeof dueFilter)}><option value="active30">Active 30-day window</option><option value="overdue">Overdue</option><option value="all">All dates</option></select>
            {profile.role === 'manager' ? <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={assignedFilter} onChange={(event) => setAssignedFilter(event.target.value)}><option value="all">All assignees</option><option value="unassigned">Unassigned</option>{assignees.map((person) => <option key={person.id} value={person.id}>{person.display_name}</option>)}</select> : <div className="rounded-xl bg-[#eef3fb] px-3 py-2.5 text-sm font-black text-[#223f7a]">Assigned to {profile.display_name}</div>}
          </div>
          <div className="overflow-x-auto"><table className={ui.table}><thead><tr><th className={ui.th}>Deadline</th><th className={ui.th}>Customer / Policy</th><th className={ui.th}>Carrier</th><th className={ui.th}>Premium</th><th className={ui.th}>Status</th><th className={ui.th}>Assigned</th><th className={ui.th}>Next follow-up</th><th className={ui.th}>Action</th></tr></thead><tbody>{rows.map((row) => { const warning = warningLabel(row); return <tr key={row.id} className={ui.trHover} onClick={() => setSelectedId(row.id)}><td className={ui.td}><span className={`${ui.badge} ${ui.badgeTone[warning.tone]}`}>{warning.label}</span><p className="mt-2 text-xs font-semibold text-slate-400">{new Date(`${row.renewal_date}T00:00:00`).toLocaleDateString()}</p></td><td className={ui.td}><p className="font-black text-slate-900">{row.customer_name}</p><p className="mt-1 text-xs font-semibold text-slate-500">{row.policy_number}</p></td><td className={ui.td}><p className="font-bold">{row.carrier || '—'}</p><p className="mt-1 text-xs text-slate-400">{row.line_of_business || 'Line not recorded'}</p></td><td className={ui.td}><p className="font-black">{money(row.premium_renewal)}</p><p className={`mt-1 text-xs font-black ${premiumDelta(row).startsWith('+') ? 'text-rose-700' : 'text-emerald-700'}`}>{premiumDelta(row)}</p></td><td className={ui.td}><span className={`${ui.badge} ${ui.badgeTone[renewalStatusTone[row.status] || 'neutral']}`}>{statusLabel(row.status)}</span></td><td className={ui.td}><p className="font-bold">{assigneeName(assignees, row.assigned_to)}</p></td><td className={ui.td}><p className="text-xs font-semibold text-slate-500">{row.next_follow_up_at ? new Date(row.next_follow_up_at).toLocaleString() : 'Not scheduled'}</p></td><td className={ui.td}><button className={ui.btnSecondary} onClick={(event) => { event.stopPropagation(); setSelectedId(row.id); }}>Open</button></td></tr>})}</tbody></table>{!rows.length ? <div className={ui.empty}>No renewals match these filters.</div> : null}</div>
        </section>
      ) : null}

      {tab === 'import' && profile.role === 'manager' ? <ImportWizard onComplete={async () => { setNotice('Renewal data imported/updated. Closed records remained unchanged.'); await refresh(); }} /> : null}

      <Drawer open={Boolean(selected)} onClose={() => setSelectedId(null)}>
        {selected ? <RenewalDrawer record={selected} profile={profile} assignees={assignees} onChanged={async () => { await refresh(); }} onClose={() => setSelectedId(null)} /> : null}
      </Drawer>
    </ModuleShell>
  );
}

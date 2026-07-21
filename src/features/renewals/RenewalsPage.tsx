'use client';

import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  Download,
  Eye,
  FileAudio,
  FileClock,
  FileImage,
  FileText,
  FileUp,
  Mail,
  LoaderCircle,
  MessageSquareText,
  Paperclip,
  Play,
  Pencil,
  Phone,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  UploadCloud,
  UserCheck,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { getSupabase } from '../nhwd-shared/client';
import type { ProfileLite } from '../nhwd-shared/types';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import { renewalStatusTone, statusLabel, ui } from '../nhwd-shared/ui';
import {
  addContact,
  assignRenewal,
  buildNormalizedRows,
  deleteRenewalAssignmentAlias,
  downloadEvidenceFile,
  extractDistinctAssignmentLabels,
  generateDueNotifications,
  getEvidenceUrl,
  guessMapping,
  importBatch,
  listContacts,
  listRenewalAssignees,
  listRenewalAssignmentAliases,
  listRenewalEvents,
  listRenewals,
  managerUpdateRecord,
  normalizeAssignmentLabel,
  normalizeDate,
  parseCsv,
  listSmsLogs,
  sendRenewalSms,
  sendToRequote,
  updateRenewalContactInfo,
  updateWorkflow,
  upsertRenewalAssignmentAlias,
  type ImportBatchResult,
  type NormalizedImportRow,
  type RenewalAssignee,
  type RenewalAssignmentAlias,
  type RenewalChannel,
  type RenewalContact,
  type RenewalEvent,
  type RenewalRecord,
  type RenewalSmsLog,
  type RenewalStatus,
} from './api';

const OPEN_STATUSES: RenewalStatus[] = ['imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent'];
const CLOSED_STATUSES: RenewalStatus[] = ['renewed', 'lost', 'cancelled'];

type AgentRenewalPriorityFilter =
  | 'all'
  | 'days_30_plus'
  | 'days_16_30'
  | 'days_8_15'
  | 'days_4_7'
  | 'days_0_3'
  | 'no_follow_up';

type ManagerRenewalDueWindow = 3 | 7 | 15 | 30;
const IMPORT_FIELDS: Array<{ key: keyof NormalizedImportRow; label: string; required?: boolean; group: 'required' | 'contact' | 'powerbi' | 'premium' }> = [
  { key: 'policy_number', label: 'Policy', required: true, group: 'required' },
  { key: 'renewal_date', label: 'Renewal Date', required: true, group: 'required' },
  { key: 'customer_name', label: 'Named Insured', required: true, group: 'required' },
  { key: 'carrier', label: 'Company / Carrier', group: 'required' },
  { key: 'line_of_business', label: 'Lobs / Line of Business', group: 'required' },
  { key: 'notice_call_date', label: 'Aviso Call', group: 'powerbi' },
  { key: 'notes', label: 'Notes', group: 'powerbi' },
  { key: 'eft', label: 'EFT', group: 'powerbi' },
  { key: 'requote', label: 'REQUOTE', group: 'powerbi' },
  { key: 'requote_note', label: 'NOTA REQUOTE', group: 'powerbi' },
  { key: 'assigned_name', label: 'ASIGNACIONTXT / Responsible', group: 'powerbi' },
  { key: 'customer_phone', label: 'Phone', group: 'contact' },
  { key: 'customer_email', label: 'Email', group: 'contact' },
  { key: 'hawksoft_client_id', label: 'HawkSoft client ID', group: 'contact' },
  { key: 'premium_current', label: 'Current premium', group: 'premium' },
  { key: 'premium_renewal', label: 'Renewal premium', group: 'premium' },
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

function assigneeName(assignees: RenewalAssignee[], id: string | null): string {
  return assignees.find((profile) => profile.id === id)?.display_name || 'Unassigned';
}


type HistoryItem =
  | { kind: 'contact'; id: string; occurredAt: string; contact: RenewalContact }
  | { kind: 'event'; id: string; occurredAt: string; event: RenewalEvent };

const INTERNAL_POWERBI_EVENTS = new Set([
  'powerbi_record_created',
  'powerbi_record_updated',
  'powerbi_record_missing',
  'powerbi_record_restored',
  'import_record_created',
  'import_record_updated',
  'premium_update',
]);

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function readableFieldLabel(value: string): string {
  return value
    .replace(/^p_/, '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function readableDetailValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  if (typeof value === 'object') return null;
  if (key.includes('at') || key.includes('date')) {
    const parsed = new Date(String(value));
    if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
  }
  if (key === 'status') return statusLabel(String(value));
  return String(value);
}

function eventPresentation(event: RenewalEvent): {
  title: string;
  description: string | null;
  details: Array<{ label: string; value: string }>;
} {
  const detail = event.detail || {};
  const details: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown, key = label) => {
    const rendered = readableDetailValue(key, value);
    if (rendered) details.push({ label, value: rendered });
  };

  switch (event.event_type) {
    case 'workflow_updated':
      add('Status', detail.status, 'status');
      add('Next follow-up', detail.next_follow_up_at, 'next_follow_up_at');
      add('Outcome note', detail.outcome_reason, 'outcome_reason');
      return {
        title: 'Renewal workflow updated',
        description: detail.status ? `Status changed to ${statusLabel(String(detail.status))}.` : 'Renewal workflow information was updated.',
        details,
      };
    case 'assigned':
    case 'manager_assigned':
      add('Assigned employee', detail.assigned_name, 'assigned_name');
      add('Role', detail.role, 'role');
      return {
        title: 'Renewal assigned',
        description: detail.assigned_name ? `Assigned to ${String(detail.assigned_name)}.` : 'The renewal assignment was updated.',
        details,
      };
    case 'requote_intake_draft_created':
      return {
        title: 'Requote intake draft created',
        description: 'A linked Customer Service intake was created so the missing quote information can be completed.',
        details: [],
      };
    case 'requote_intake_submitted':
      return {
        title: 'Requote intake submitted to Sales',
        description: 'The linked renewal intake entered the shared Sales Intake Queue.',
        details: [],
      };
    case 'requote_created':
    case 'requote_work_item_created':
      return {
        title: 'Requote created in Quotes Database',
        description: 'Sales ownership was created from this renewal record.',
        details: [],
      };
    case 'contact_information_added':
      if (detail.phone_added) details.push({ label: 'Phone', value: 'Added' });
      if (detail.email_added) details.push({ label: 'Email', value: 'Added' });
      return {
        title: 'Customer contact information added',
        description: 'Missing contact information was saved to this renewal record.',
        details,
      };
    case 'manager_record_updated':
      return {
        title: 'Manager corrected renewal information',
        description: 'One or more renewal fields were corrected by Management.',
        details: Object.entries(detail)
          .map(([key, value]) => ({ label: readableFieldLabel(key), value: readableDetailValue(key, value) }))
          .filter((entry): entry is { label: string; value: string } => Boolean(entry.value)),
      };
    case 'powerbi_record_created':
    case 'import_record_created':
      add('File', detail.file_name, 'file_name');
      add('Imported responsible name', detail.assigned_import_label, 'assigned_import_label');
      return {
        title: 'Power BI renewal record created',
        description: 'This renewal was added from the monthly Power BI export.',
        details,
      };
    case 'powerbi_record_updated':
    case 'import_record_updated':
      add('File', detail.file_name, 'file_name');
      return {
        title: 'Power BI renewal record updated',
        description: 'The monthly upload refreshed the open renewal information.',
        details,
      };
    case 'premium_update':
      add('Previous premium', detail.previous_premium, 'previous_premium');
      add('Updated premium', detail.new_premium, 'new_premium');
      return {
        title: 'Renewal premium updated',
        description: 'The monthly Power BI upload contained a different renewal premium.',
        details,
      };
    default:
      return {
        title: statusLabel(event.event_type),
        description: null,
        details: Object.entries(detail)
          .map(([key, value]) => ({ label: readableFieldLabel(key), value: readableDetailValue(key, value) }))
          .filter((entry): entry is { label: string; value: string } => Boolean(entry.value)),
      };
  }
}

function evidenceDescription(contact: RenewalContact): string | null {
  if (contact.evidence_name) {
    let size = '';
    if (contact.evidence_size_bytes) {
      size = contact.evidence_size_bytes >= 1_048_576
        ? ` · ${(contact.evidence_size_bytes / 1_048_576).toFixed(1)} MB`
        : ` · ${(contact.evidence_size_bytes / 1024).toFixed(1)} KB`;
    }
    return `${contact.evidence_name}${size}`;
  }
  if (contact.evidence_reference) return `Reference: ${contact.evidence_reference}`;
  if (contact.rc_recording_content_uri) return 'RingCentral recording';
  return null;
}


type EvidenceKind = 'image' | 'audio' | 'video' | 'pdf' | 'file';

function evidenceKind(contact: RenewalContact): EvidenceKind {
  const mime = contact.evidence_mime_type?.toLowerCase() || '';
  const name = contact.evidence_name?.toLowerCase() || '';
  const source = `${mime} ${name}`;

  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(name)) return 'image';
  if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|opus|wma)$/i.test(name)) return 'audio';
  if (mime.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)$/i.test(name)) return 'video';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (contact.channel === 'call' || contact.rc_recording_content_uri || source.includes('recording')) return 'audio';
  return 'file';
}

function evidenceIcon(kind: EvidenceKind) {
  if (kind === 'image') return FileImage;
  if (kind === 'audio' || kind === 'video') return FileAudio;
  return FileText;
}

function EvidenceAttachment({ contact }: { contact: RenewalContact }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const kind = evidenceKind(contact);
  const Icon = evidenceIcon(kind);
  const description = evidenceDescription(contact);
  const hasStoredOrLinkedFile = Boolean(
    contact.evidence_path
    || contact.rc_recording_content_uri
    || (contact.evidence_reference && /^https?:\/\//i.test(contact.evidence_reference)),
  );
  const previewLabel = kind === 'image'
    ? 'View Image'
    : kind === 'audio'
      ? contact.channel === 'call' || contact.rc_recording_content_uri
        ? 'Play Call'
        : 'Play Audio'
      : kind === 'video'
        ? 'Play Video'
        : kind === 'pdf'
          ? 'View PDF'
          : 'Open File';
  const downloadLabel = kind === 'audio' && (contact.channel === 'call' || contact.rc_recording_content_uri)
    ? 'Download Call'
    : 'Download File';

  async function togglePreview() {
    if (previewOpen) {
      setPreviewOpen(false);
      return;
    }

    if (!previewUrl) {
      setLoadingPreview(true);
      setEvidenceError(null);
      try {
        const url = await getEvidenceUrl(contact);
        if (!url) throw new Error('No previewable file URL is attached to this interaction.');
        setPreviewUrl(url);
      } catch (caught) {
        setEvidenceError(caught instanceof Error ? caught.message : 'The file preview could not be opened.');
        setLoadingPreview(false);
        return;
      }
      setLoadingPreview(false);
    }

    setPreviewOpen(true);
  }

  async function downloadFile() {
    setDownloading(true);
    setEvidenceError(null);
    try {
      await downloadEvidenceFile(contact);
    } catch (caught) {
      setEvidenceError(caught instanceof Error ? caught.message : 'The file could not be downloaded.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-cyan-100 bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-50 text-cyan-700">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Evidence</p>
            <p className="mt-1 break-words text-sm font-bold text-slate-700">{description || 'Attached evidence'}</p>
            {contact.evidence_mime_type ? <p className="mt-1 text-xs font-semibold text-slate-400">{contact.evidence_mime_type}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasStoredOrLinkedFile ? (
            <button type="button" className={ui.btnSecondary} disabled={loadingPreview} onClick={() => void togglePreview()}>
              {loadingPreview
                ? <LoaderCircle className="h-4 w-4 animate-spin" />
                : kind === 'audio' || kind === 'video'
                  ? <Play className="h-4 w-4" />
                  : <Eye className="h-4 w-4" />}
              {previewOpen ? 'Hide Preview' : previewLabel}
            </button>
          ) : null}
          {hasStoredOrLinkedFile ? (
            <button type="button" className={ui.btnSecondary} disabled={downloading} onClick={() => void downloadFile()}>
              {downloading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {downloadLabel}
            </button>
          ) : null}
        </div>
      </div>

      {evidenceError ? <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{evidenceError}</p> : null}

      {previewOpen && previewUrl ? (
        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 p-3">
          {kind === 'image' ? (
            <img
              src={previewUrl}
              alt={contact.evidence_name || 'Renewal evidence'}
              className="max-h-[32rem] w-full rounded-lg object-contain"
            />
          ) : null}
          {kind === 'audio' ? (
            <audio className="w-full" controls preload="metadata" src={previewUrl}>
              Your browser does not support audio playback.
            </audio>
          ) : null}
          {kind === 'video' ? (
            <video className="max-h-[32rem] w-full rounded-lg" controls preload="metadata" src={previewUrl}>
              Your browser does not support video playback.
            </video>
          ) : null}
          {kind === 'pdf' ? (
            <iframe
              title={contact.evidence_name || 'Renewal evidence PDF'}
              src={previewUrl}
              className="h-[34rem] w-full rounded-lg bg-white"
            />
          ) : null}
          {kind === 'file' ? (
            <a className={ui.btnSecondary} href={previewUrl} target="_blank" rel="noreferrer">
              <Paperclip className="h-4 w-4" />
              Open File in New Tab
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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
}: {
  record: RenewalRecord;
  profile: ProfileLite;
  assignees: RenewalAssignee[];
  onChanged: () => Promise<void>;
}) {
  const [contacts, setContacts] = useState<RenewalContact[]>([]);
  const [events, setEvents] = useState<RenewalEvent[]>([]);
  const [smsLogs, setSmsLogs] = useState<RenewalSmsLog[]>([]);
  const [tab, setTab] = useState<'work' | 'history' | 'edit'>('work');
  const [channel, setChannel] = useState<RenewalChannel>('call');
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const [outcome, setOutcome] = useState('No answer');
  const [notes, setNotes] = useState('');
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidenceReference, setEvidenceReference] = useState('');
  const [nextFollowUp, setNextFollowUp] = useState(record.next_follow_up_at ? record.next_follow_up_at.slice(0, 16) : '');
  const [contactInfo, setContactInfo] = useState({
    phone: record.customer_phone || '',
    email: record.customer_email || '',
  });
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

  const isManager = profile.role === 'manager' || profile.role === 'super_admin';
  const activeRecord = OPEN_STATUSES.includes(record.status);
  const requiresEvidence = ['call', 'sms', 'email'].includes(channel);

  const loadHistory = useCallback(async () => {
    try {
      const [contactRows, eventRows, smsRows] = await Promise.all([listContacts(record.id), listRenewalEvents(record.id), listSmsLogs(record.id)]);
      setContacts(contactRows);
      setEvents(eventRows);
      setSmsLogs(smsRows);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load renewal history.');
    }
  }, [record.id]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  useEffect(() => {
    setContactInfo({
      phone: record.customer_phone || '',
      email: record.customer_email || '',
    });
  }, [record.customer_email, record.customer_phone, record.id]);

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
    }, 'Contact update recorded. The renewal remains open until a final outcome is selected.');
  }

  async function saveFollowUp() {
    if (!nextFollowUp) return setError('Select the next follow-up date and time.');
    await run(() => updateWorkflow(record.id, { status: 'monitoring', nextFollowUpAt: new Date(nextFollowUp).toISOString() }), 'Next follow-up scheduled.');
  }

  async function saveMissingContactInfo() {
    const phone = contactInfo.phone.trim();
    const email = contactInfo.email.trim();
    const phoneToSave = record.customer_phone ? null : phone || null;
    const emailToSave = record.customer_email ? null : email || null;
    if (!phoneToSave && !emailToSave) return setError('Enter the missing phone number or email address.');
    await run(
      () => updateRenewalContactInfo(record.id, { phone: phoneToSave, email: emailToSave }),
      'Customer contact information saved.',
    );
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

  async function handleSendSms() {
    await run(async () => {
      await sendRenewalSms(record.id);
    }, 'Text message sent successfully.');
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
  const historyItems = useMemo<HistoryItem[]>(() => {
    const visibleEvents = isManager
      ? events
      : events.filter((event) => !INTERNAL_POWERBI_EVENTS.has(event.event_type));
    return [
      ...contacts.map((contact) => ({ kind: 'contact' as const, id: `contact-${contact.id}`, occurredAt: contact.occurred_at, contact })),
      ...visibleEvents.map((event) => ({ kind: 'event' as const, id: `event-${event.id}`, occurredAt: event.created_at, event })),
    ].sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
  }, [contacts, events, isManager]);

  const hasMissingContactInfo = !record.customer_phone || !record.customer_email;

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

        {isManager && (record.notice_call_at || record.import_notes || record.assigned_import_label || record.requote_requested || record.requote_note || record.eft_enabled !== null) ? (
          <details className="mt-4 rounded-2xl border border-[#c9d5e9] bg-[#f8faff]">
            <summary className="cursor-pointer list-none p-4 [&::-webkit-details-marker]:hidden">
              <p className="font-black text-[#223f7a]">Imported Power BI information</p>
              <p className="mt-1 text-xs font-semibold text-slate-500">Click to review Aviso Call, Notes, EFT, REQUOTE and the imported assignment.</p>
            </summary>
            <div className="grid gap-3 border-t border-[#dbe3f0] bg-white p-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-black uppercase text-slate-400">Aviso Call</p><p className="mt-1 font-black">{record.notice_call_at ? new Date(`${record.notice_call_at}T00:00:00`).toLocaleDateString() : '—'}</p></div>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-black uppercase text-slate-400">EFT</p><p className="mt-1 font-black">{record.eft_enabled === null ? 'Not provided' : record.eft_enabled ? 'Yes' : 'No'}</p></div>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-black uppercase text-slate-400">Imported assignment</p><p className="mt-1 font-black">{record.assigned_import_label || '—'}</p></div>
              <div className="rounded-xl bg-slate-50 p-3 sm:col-span-2"><p className="text-[10px] font-black uppercase text-slate-400">Notes</p><p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-slate-700">{record.import_notes || '—'}</p></div>
              <div className={`rounded-xl p-3 ${record.requote_requested ? 'bg-amber-50 text-amber-900' : 'bg-slate-50'}`}><p className="text-[10px] font-black uppercase opacity-60">REQUOTE</p><p className="mt-1 font-black">{record.requote_requested ? 'Requested' : 'Not flagged'}</p><p className="mt-1 text-xs font-semibold">{record.requote_note || ''}</p></div>
            </div>
          </details>
        ) : null}
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

          {hasMissingContactInfo ? (
            <section className={`${ui.card} ${ui.cardPad}`}>
              <div className="flex items-start gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-2xl bg-amber-50 text-amber-700"><Phone className="h-5 w-5" /></div>
                <div>
                  <h3 className="font-black text-slate-950">Add missing customer contact information</h3>
                  <p className="mt-1 text-sm font-semibold text-slate-500">The assigned employee may fill an empty phone number or email. Existing information can only be replaced by Management.</p>
                </div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label>
                  <span className={ui.label}>Phone</span>
                  <input className={ui.input} disabled={busy || Boolean(record.customer_phone)} value={contactInfo.phone} onChange={(event) => setContactInfo((current) => ({ ...current, phone: event.target.value }))} placeholder="Customer phone number" />
                </label>
                <label>
                  <span className={ui.label}>Email</span>
                  <input type="email" className={ui.input} disabled={busy || Boolean(record.customer_email)} value={contactInfo.email} onChange={(event) => setContactInfo((current) => ({ ...current, email: event.target.value }))} placeholder="Customer email address" />
                </label>
              </div>
              <button type="button" className={`${ui.btnPrimary} mt-4`} disabled={busy} onClick={() => void saveMissingContactInfo()}><UserCheck className="h-4 w-4" />Save Contact Information</button>
            </section>
          ) : null}

          <section className={`${ui.card} ${ui.cardPad}`}>
            <div className="flex items-start gap-3"><div className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan-50 text-cyan-700"><MessageSquareText className="h-5 w-5" /></div><div><h3 className="font-black text-slate-950">Log customer contact</h3><p className="mt-1 text-sm font-semibold text-slate-500">Notes are always required. Calls, SMS, and email also require proof or a contact reference.</p></div></div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label><span className={ui.label}>Method</span><select className={ui.select} disabled={busy || !activeRecord} value={channel} onChange={(event) => setChannel(event.target.value as RenewalChannel)}><option value="call">Call</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="in_person">In Person</option><option value="other">Other</option></select></label>
              <label><span className={ui.label}>Direction</span><select className={ui.select} disabled={busy || !activeRecord} value={direction} onChange={(event) => setDirection(event.target.value as 'outbound' | 'inbound')}><option value="outbound">Outbound</option><option value="inbound">Inbound</option></select></label>
              <label className="sm:col-span-2">
                <span className={ui.label}>Contact result — does not close the renewal</span>
                <select className={ui.select} disabled={busy || !activeRecord} value={outcome} onChange={(event) => setOutcome(event.target.value)}>
                  <option>No answer</option>
                  <option>Left voicemail</option>
                  <option>Customer reached</option>
                  <option>Customer requested callback</option>
                  <option>Customer reviewing renewal</option>
                  <option>Customer wants re-quote</option>
                  <option>Wrong number</option>
                  <option>Other</option>
                </select>
                <p className="mt-2 text-xs font-semibold leading-5 text-slate-500">
                  This records what happened during this contact attempt. Use Renewed, Lost, or Cancelled only after the customer has made a final decision.
                </p>
              </label>
            </div>
            <label className="mt-4 block"><span className={ui.label}>Mandatory notes</span><textarea className={ui.textarea} rows={4} disabled={busy || !activeRecord} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What happened, what the customer said, and the next step." /></label>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label><span className={ui.label}>Upload proof or call recording</span><input type="file" accept="image/*,application/pdf,audio/*,video/*,.txt,.csv,.doc,.docx" className={`${ui.input} file:mr-3 file:rounded-lg file:border-0 file:bg-[#eef3fb] file:px-3 file:py-1.5 file:text-xs file:font-black file:text-[#223f7a]`} disabled={busy || !activeRecord} onChange={(event) => setEvidenceFile(event.target.files?.[0] || null)} />{evidenceFile ? <p className="mt-2 text-xs font-bold text-emerald-700">Selected: {evidenceFile.name} · {(evidenceFile.size / 1_048_576).toFixed(1)} MB</p> : <p className="mt-2 text-xs font-semibold text-slate-400">Images, PDFs, documents, audio, and video up to 100 MB.</p>}</label>
              <label><span className={ui.label}>Or contact/reference record</span><input className={ui.input} disabled={busy || !activeRecord} value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} placeholder="RingCentral ID, attachment reference, email message ID…" /></label>
            </div>
            <button type="button" className={`${ui.btnPrimary} mt-4`} disabled={busy || !activeRecord} onClick={() => void saveContact()}><ClipboardCheck className="h-4 w-4" />Save Contact Update</button>
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
            <div className="flex items-start gap-3"><div className="grid h-10 w-10 place-items-center rounded-2xl bg-violet-50 text-violet-700"><Smartphone className="h-5 w-5" /></div><div><h3 className="font-black text-slate-950">Text Message Reminders</h3><p className="mt-1 text-sm font-semibold text-slate-500">Send an SMS reminder or view sent messages. Auto and manual texts are tracked separately.</p></div></div>
            {smsLogs.length > 0 ? (
              <div className="mt-4 space-y-2">
                {smsLogs.slice(0, 5).map((log) => (
                  <div key={log.id} className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-xs">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-black ${log.trigger_type === 'manual' ? 'bg-violet-100 text-violet-700' : 'bg-blue-100 text-blue-700'}`}>{log.trigger_type === 'manual' ? 'Manual' : log.trigger_type.replace('auto_', '').toUpperCase()}</span>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-bold ${log.delivery_status === 'sent' || log.delivery_status === 'delivered' ? 'bg-emerald-100 text-emerald-700' : log.delivery_status === 'failed' || log.delivery_status === 'rejected' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>{log.delivery_status}</span>
                    <span className="truncate font-semibold text-slate-600">{log.message_text.slice(0, 60)}…</span>
                    <span className="ml-auto shrink-0 font-semibold text-slate-400">{new Date(log.sent_at).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm font-semibold text-slate-400">No text messages have been sent for this renewal yet.</p>
            )}
            <button type="button" className={`${ui.btnPrimary} mt-4`} disabled={busy || !activeRecord || !record.customer_phone} onClick={() => void handleSendSms()}><Smartphone className="h-4 w-4" />Send Text Reminder Now</button>
            {!record.customer_phone ? <p className="mt-2 text-xs font-semibold text-amber-600">Add a phone number above before sending a text.</p> : null}
          </section>

          <section className={`${ui.card} ${ui.cardPad}`}>
            <p className={ui.sectionTitle}>Close renewal</p>
            <div className="mt-3 flex flex-wrap gap-2"><button className={ui.btnPrimary} disabled={busy || !activeRecord} onClick={() => void closeRecord('renewed')}><CheckCircle2 className="h-4 w-4" />Renewed</button><button className={ui.btnDanger} disabled={busy || !activeRecord} onClick={() => void closeRecord('lost')}><XCircle className="h-4 w-4" />Lost</button><button className={ui.btnSecondary} disabled={busy || !activeRecord} onClick={() => void closeRecord('cancelled')}>Cancelled</button></div>
          </section>
        </div>
      ) : null}

      {tab === 'history' ? (
        <section className={`${ui.card} overflow-hidden`}>
          <div className={ui.cardHeader}>
            <div>
              <p className={ui.sectionTitle}>History & Evidence</p>
              <h3 className="mt-1 text-xl font-black">Customer notes, uploaded proof, and readable workflow activity</h3>
            </div>
            <button type="button" className={ui.btnSecondary} onClick={() => void loadHistory()}><RefreshCw className="h-4 w-4" />Refresh</button>
          </div>
          <div className="space-y-3 p-5">
            {historyItems.map((item) => {
              if (item.kind === 'contact') {
                const contact = item.contact;
                const evidence = evidenceDescription(contact);
                return (
                  <article key={item.id} className="rounded-2xl border border-cyan-100 bg-cyan-50/40 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-black text-slate-900">{statusLabel(contact.channel)} · {contact.outcome || 'Customer interaction'}</p>
                        <p className="mt-1 text-xs font-semibold text-slate-500">{formatDateTime(contact.occurred_at)} · {statusLabel(contact.direction)}</p>
                      </div>
                      <span className={`${ui.badge} ${ui.badgeTone.cyan}`}>{contact.entry_source === 'ringcentral_api' ? 'RingCentral' : 'Recorded by employee'}</span>
                    </div>
                    <div className="mt-3 rounded-xl bg-white/80 p-3">
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Actual notes</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm font-semibold leading-6 text-slate-700">{contact.notes || 'No note was entered.'}</p>
                    </div>
                    {evidence ? <EvidenceAttachment contact={contact} /> : null}
                  </article>
                );
              }

              const presentation = eventPresentation(item.event);
              return (
                <article key={item.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-black text-slate-900">{presentation.title}</p>
                      {presentation.description ? <p className="mt-1 text-sm font-semibold text-slate-500">{presentation.description}</p> : null}
                    </div>
                    <p className="text-xs font-bold text-slate-400">{formatDateTime(item.event.created_at)}</p>
                  </div>
                  {presentation.details.length ? (
                    <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                      {presentation.details.map((detail) => (
                        <div key={`${item.id}-${detail.label}`} className="rounded-xl bg-slate-50 p-3">
                          <dt className="text-[10px] font-black uppercase tracking-wider text-slate-400">{detail.label}</dt>
                          <dd className="mt-1 whitespace-pre-wrap text-sm font-bold text-slate-700">{detail.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </article>
              );
            })}
            {!historyItems.length ? <div className={ui.empty}>No customer contacts, evidence, or workflow activity has been recorded yet.</div> : null}
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

function ImportWizard({
  assignees,
  onComplete,
  onRefreshAssignees,
}: {
  assignees: RenewalAssignee[];
  onComplete: () => Promise<void>;
  onRefreshAssignees: () => Promise<void>;
}) {
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [aliases, setAliases] = useState<RenewalAssignmentAlias[]>([]);
  const [assignmentSelections, setAssignmentSelections] = useState<Record<string, string>>({});
  const [savingLabel, setSavingLabel] = useState<string | null>(null);
  const [aliasNotice, setAliasNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportBatchResult | null>(null);

  const normalizedRows = useMemo(
    () => buildNormalizedRows(headers, rawRows, mapping),
    [headers, rawRows, mapping],
  );
  const preview = normalizedRows.slice(0, 15);
  const assignmentLabels = useMemo(
    () => extractDistinctAssignmentLabels(normalizedRows),
    [normalizedRows],
  );
  const aliasByLabel = useMemo(
    () => new Map(aliases.map((alias) => [alias.normalized_label, alias])),
    [aliases],
  );
  const assignmentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of normalizedRows) {
      if (!row.assigned_name?.trim()) continue;
      const key = normalizeAssignmentLabel(row.assigned_name);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [normalizedRows]);

  const refreshAliases = useCallback(async () => {
    try {
      setAliases(await listRenewalAssignmentAliases());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Assignment links could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void refreshAliases();
  }, [refreshAliases]);

  useEffect(() => {
    setAssignmentSelections((current) => {
      const next = { ...current };
      for (const label of assignmentLabels) {
        const key = normalizeAssignmentLabel(label);
        const alias = aliasByLabel.get(key);
        if (!next[key] && alias) next[key] = alias.profile_id;
      }
      return next;
    });
  }, [aliasByLabel, assignmentLabels]);

  async function loadFile(file: File | null) {
    if (!file) return;
    setError(null);
    setResult(null);
    setAliasNotice(null);
    const parsed = parseCsv(await file.text());
    if (!parsed.headers.length) return setError('The CSV did not contain headers.');
    const guessed = guessMapping(parsed.headers);
    setFileName(file.name);
    setHeaders(parsed.headers);
    setRawRows(parsed.rows);
    setMapping(guessed);
  }

  function changeMapping(field: string, header: string) {
    const next = { ...mapping, [field]: header };
    if (!header) delete next[field];
    setMapping(next);
  }

  async function saveAssignmentLink(label: string) {
    const key = normalizeAssignmentLabel(label);
    const profileId = assignmentSelections[key];
    if (!profileId) return setError(`Choose a Work Desk username for ${label}.`);
    setSavingLabel(key);
    setError(null);
    setAliasNotice(null);
    try {
      const saved = await upsertRenewalAssignmentAlias(label, profileId);
      const person = assignees.find((item) => item.id === profileId);
      setAliasNotice(
        `${label} is now linked to @${person?.username || person?.display_name || 'selected user'}. ${saved.rows_assigned} existing open renewal${saved.rows_assigned === 1 ? '' : 's'} were assigned.`,
      );
      await refreshAliases();
      await onComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The assignment link could not be saved.');
    } finally {
      setSavingLabel(null);
    }
  }

  async function removeAssignmentLink(alias: RenewalAssignmentAlias) {
    setSavingLabel(alias.normalized_label);
    setError(null);
    setAliasNotice(null);
    try {
      await deleteRenewalAssignmentAlias(alias.id);
      setAssignmentSelections((current) => ({ ...current, [alias.normalized_label]: '' }));
      setAliasNotice(`${alias.import_label} is no longer linked automatically. Existing assigned records were not changed.`);
      await refreshAliases();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The assignment link could not be removed.');
    } finally {
      setSavingLabel(null);
    }
  }

  async function commit() {
    if (!mapping.policy_number || !mapping.renewal_date || !mapping.customer_name) return setError('Map Policy number, Renewal date, and Customer name before importing.');
    if (!normalizedRows.length) return setError('No valid rows were found after mapping.');
    setBusy(true);
    setError(null);
    try {
      const imported = await importBatch(fileName, mapping, normalizedRows);
      setResult(imported);
      await onComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The renewal file could not be imported.');
    } finally {
      setBusy(false);
    }
  }

  const aliasesOutsideFile = aliases.filter(
    (alias) => !assignmentLabels.some((label) => normalizeAssignmentLabel(label) === alias.normalized_label),
  );

  return (
    <div className="space-y-5">
      <section className={`${ui.card} ${ui.cardPad}`}>
        <div className="flex items-start gap-3"><div className="grid h-10 w-10 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]"><UploadCloud className="h-5 w-5" /></div><div><h2 className="text-xl font-black">Upload or update HawkSoft / Power BI renewal data</h2><p className="mt-1 text-sm font-semibold leading-6 text-slate-500">Open records are matched by policy number + renewal date and updated with a full change log. Closed records are never overwritten.</p></div></div>
        <label className="mt-5 block rounded-2xl border-2 border-dashed border-[#b5c4df] bg-[#f8faff] p-8 text-center"><FileUp className="mx-auto h-8 w-8 text-[#223f7a]" /><p className="mt-3 font-black text-slate-900">Choose weekly CSV export</p><p className="mt-1 text-sm font-semibold text-slate-500">ASIGNACIONTXT names are extracted automatically before the import is committed.</p><input type="file" accept=".csv,text/csv" className="mt-4 block w-full text-sm font-semibold" onChange={(event) => void loadFile(event.target.files?.[0] || null)} /></label>
      </section>
      {error ? <div className={ui.error}>{error}</div> : null}
      {aliasNotice ? <div className={ui.success}>{aliasNotice}</div> : null}
      {result ? (
        <div className={ui.success}>
          <p className="font-black">
            Import complete: {result.rows_inserted} new, {result.rows_updated} updated, {result.rows_skipped} skipped
            {result.rows_closed_preserved ? `, ${result.rows_closed_preserved} closed records preserved` : ''}.
          </p>
          <p className="mt-1 text-xs font-bold">
            {result.rows_assigned || 0} rows matched to an active employee · {result.rows_requote_flagged || 0} rows flagged for re-quote.
          </p>
          {result.unmatched_assignees?.length ? (
            <p className="mt-2 rounded-xl bg-white/70 px-3 py-2 text-xs font-bold text-amber-800">
              Still unlinked: {result.unmatched_assignees.join(', ')}. Create those users, return to this screen, and link each imported name to its username. Existing open records will then be assigned automatically.
            </p>
          ) : null}
        </div>
      ) : null}

      {headers.length ? (
        <section className={`${ui.card} ${ui.cardPad}`}>
          <p className={ui.sectionTitle}>Column mapping</p>
          <h3 className="mt-1 text-xl font-black">Confirm the weekly export columns</h3>
          <p className="mt-1 text-sm font-semibold text-slate-500">ASIGNACIONTXT, ASIGNACION, ASIGNADO, Responsible, and Assigned To are recognized as the responsible employee field.</p>

          {([
            ['required', 'Required policy information', 'Named Insured, Company, Lobs, Policy and Renewal Date.', true],
            ['powerbi', 'Current workflow fields', 'Aviso Call, Notes, EFT, REQUOTE, NOTA REQUOTE and ASIGNACIONTXT.', true],
            ['contact', 'Helpful customer contact fields', 'Phone, email and HawkSoft client ID improve follow-up and matching.', false],
            ['premium', 'Optional premium comparison', 'Current and renewal premiums support increase alerts and reporting.', false],
          ] as const).map(([group, title, description, open]) => (
            <details key={group} open={open} className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70">
              <summary className="cursor-pointer list-none px-4 py-4 [&::-webkit-details-marker]:hidden"><p className="font-black text-slate-900">{title}</p><p className="mt-1 text-xs font-semibold text-slate-500">{description}</p></summary>
              <div className="grid gap-4 border-t border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-3">
                {IMPORT_FIELDS.filter((field) => field.group === group).map((field) => (
                  <label key={field.key}><span className={ui.label}>{field.label}{field.required ? ' *' : ''}</span><select className={ui.select} value={mapping[field.key] || ''} onChange={(event) => changeMapping(field.key, event.target.value)}><option value="">Do not import</option>{headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></label>
                ))}
              </div>
            </details>
          ))}
        </section>
      ) : null}

      {headers.length && mapping.assigned_name ? (
        <section className={`${ui.card} ${ui.cardPad}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div><p className={ui.sectionTitle}>Responsible-name links</p><h3 className="mt-1 text-xl font-black">Link ASIGNACIONTXT names to Work Desk usernames</h3><p className="mt-1 text-sm font-semibold text-slate-500">The link is saved once and reused on every weekly upload. Sales Agents and Customer Service users are both eligible.</p></div>
            <button type="button" className={ui.btnSecondary} onClick={() => void onRefreshAssignees()}><RefreshCw className="h-4 w-4" />Refresh usernames</button>
          </div>

          {assignmentLabels.length ? (
            <div className="mt-5 space-y-3">
              {assignmentLabels.map((label) => {
                const key = normalizeAssignmentLabel(label);
                const alias = aliasByLabel.get(key);
                const selectedProfileId = assignmentSelections[key] || alias?.profile_id || '';
                const linkedPerson = assignees.find((person) => person.id === alias?.profile_id);
                return (
                  <div key={key} className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 lg:grid-cols-[minmax(180px,1fr)_minmax(260px,1.4fr)_auto] lg:items-end">
                    <div><p className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">Imported name · {assignmentCounts.get(key) || 0} rows</p><p className="mt-1 text-lg font-black text-slate-900">{label}</p>{alias ? <p className="mt-1 text-xs font-bold text-emerald-700">Saved: @{linkedPerson?.username || linkedPerson?.display_name || 'inactive user'}</p> : <p className="mt-1 text-xs font-bold text-amber-700">Not linked yet</p>}</div>
                    <label><span className={ui.label}>Work Desk username</span><select className={ui.select} value={selectedProfileId} onChange={(event) => setAssignmentSelections((current) => ({ ...current, [key]: event.target.value }))}><option value="">Choose after the user is created</option>{assignees.map((person) => <option key={person.id} value={person.id}>@{person.username} · {person.display_name} · {person.role === 'agent' ? 'Sales Agent' : 'Customer Service'}</option>)}</select></label>
                    <div className="flex gap-2"><button type="button" className={ui.btnPrimary} disabled={!selectedProfileId || savingLabel === key} onClick={() => void saveAssignmentLink(label)}><UserCheck className="h-4 w-4" />{savingLabel === key ? 'Saving…' : 'Save link'}</button>{alias ? <button type="button" className={ui.btnGhost} disabled={savingLabel === key} onClick={() => void removeAssignmentLink(alias)}><X className="h-4 w-4" />Remove</button> : null}</div>
                  </div>
                );
              })}
            </div>
          ) : <div className={`${ui.empty} mt-5`}>No responsible names were found in the mapped assignment column.</div>}

          {aliasesOutsideFile.length ? (
            <details className="mt-5 rounded-2xl border border-slate-200 bg-white">
              <summary className="cursor-pointer list-none px-4 py-4 font-black text-slate-700 [&::-webkit-details-marker]:hidden">Saved links not present in this file · {aliasesOutsideFile.length}</summary>
              <div className="divide-y divide-slate-100 border-t border-slate-200">{aliasesOutsideFile.map((alias) => { const person = assignees.find((item) => item.id === alias.profile_id); return <div key={alias.id} className="flex items-center justify-between gap-4 px-4 py-3"><div><p className="font-black">{alias.import_label}</p><p className="mt-1 text-xs font-semibold text-slate-500">@{person?.username || person?.display_name || 'inactive user'}</p></div><button type="button" className={ui.btnGhost} onClick={() => void removeAssignmentLink(alias)}>Remove</button></div>; })}</div>
            </details>
          ) : null}
        </section>
      ) : null}

      {preview.length ? (
        <section className={`${ui.card} overflow-hidden`}>
          <div className={ui.cardHeader}><div><p className={ui.sectionTitle}>Preview</p><h3 className="mt-1 text-xl font-black">First {preview.length} valid rows</h3></div><button type="button" className={ui.btnPrimary} disabled={busy} onClick={() => void commit()}><UploadCloud className="h-4 w-4" />Commit {normalizedRows.length} Rows</button></div>
          <div className="overflow-x-auto"><table className={ui.table}><thead><tr><th className={ui.th}>Named Insured</th><th className={ui.th}>Company / LOB</th><th className={ui.th}>Policy / Renewal</th><th className={ui.th}>Aviso / Notes</th><th className={ui.th}>Requote</th><th className={ui.th}>Responsible</th></tr></thead><tbody>{preview.map((row, index) => { const alias = row.assigned_name ? aliasByLabel.get(normalizeAssignmentLabel(row.assigned_name)) : undefined; const person = assignees.find((item) => item.id === alias?.profile_id); return <tr key={`${row.policy_number}-${index}`}><td className={ui.td}>{row.customer_name}</td><td className={ui.td}><p className="font-bold">{row.carrier || '—'}</p><p className="mt-1 text-xs text-slate-400">{row.line_of_business || '—'}</p></td><td className={ui.td}><p className="font-bold">{row.policy_number}</p><p className="mt-1 text-xs text-slate-400">{row.renewal_date}</p></td><td className={ui.td}><p className="font-bold">{row.notice_call_date || '—'}</p><p className="mt-1 max-w-xs truncate text-xs text-slate-500">{row.notes || 'No imported note'}</p></td><td className={ui.td}><p className="font-bold">{row.requote || '—'}</p><p className="mt-1 max-w-xs truncate text-xs text-slate-500">{row.requote_note || ''}</p></td><td className={ui.td}><p className="font-bold">{row.assigned_name || 'Unassigned'}</p><p className={`mt-1 text-xs font-bold ${alias ? 'text-emerald-700' : 'text-amber-700'}`}>{alias ? `@${person?.username || person?.display_name || 'linked user'}` : row.assigned_name ? 'Link before or after import' : ''}</p></td></tr>; })}</tbody></table></div>
        </section>
      ) : null}
    </div>
  );
}

export default function RenewalsPage({
  initialProfile: profile,
  embedded = false,
  initialTab = 'overview',
  showImportTab = true,
  importOnly = false,
}: {
  initialProfile: ProfileLite;
  embedded?: boolean;
  initialTab?: 'overview' | 'pipeline' | 'import';
  showImportTab?: boolean;
  importOnly?: boolean;
}) {
  const [assignees, setAssignees] = useState<RenewalAssignee[]>([]);
  const [rows, setRows] = useState<RenewalRecord[]>([]);
  const [tab, setTab] = useState<'overview' | 'pipeline' | 'import'>(importOnly ? 'import' : initialTab);
  const [statusFilter, setStatusFilter] = useState<'open' | 'all' | RenewalStatus>('open');
  const [assignedFilter, setAssignedFilter] = useState('all');
  const [dueFilter, setDueFilter] = useState<'all' | 'active30' | 'overdue'>('active30');
  const [search, setSearch] = useState('');
  const [phoneFilter, setPhoneFilter] = useState<'all' | 'missing_phone' | 'has_phone'>('all');
  const [agentPriorityFilter, setAgentPriorityFilter] = useState<AgentRenewalPriorityFilter>('all');
  const [managerDueWindow, setManagerDueWindow] = useState<ManagerRenewalDueWindow>(30);
  const [managerReportRows, setManagerReportRows] = useState<RenewalRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [smsSchedulerResult, setSmsSchedulerResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const effectiveAssignee = (profile.role === 'manager' || profile.role === 'super_admin') ? assignedFilter : profile.id;
      const [renewalRows, people, agencyReportRows] = await Promise.all([
        listRenewals({
          status: statusFilter,
          assignedTo: effectiveAssignee,
          dueWindow: profile.role === 'agent' ? 'all' : dueFilter,
          search,
        }),
        (profile.role === 'manager' || profile.role === 'super_admin') ? listRenewalAssignees() : Promise.resolve([]),
        (profile.role === 'manager' || profile.role === 'super_admin')
          ? listRenewals({
              status: 'open',
              assignedTo: 'all',
              dueWindow: 'active30',
              search: '',
            })
          : Promise.resolve([]),
      ]);
      setRows(renewalRows);
      setAssignees(people);
      setManagerReportRows(agencyReportRows);
      setLastUpdated(new Date());
      if (profile.role === 'manager' || profile.role === 'super_admin') void generateDueNotifications().catch(() => undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load Renewals.');
    } finally {
      setLoading(false);
    }
  }, [assignedFilter, dueFilter, profile, search, statusFilter]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function runSmsScheduler() {
    setBusy(true);
    setSmsSchedulerResult(null);
    try {
      const response = await fetch('/api/renewals/sms/scheduler', { method: 'POST' });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Scheduler failed.');
      const s = json.summary;
      setSmsSchedulerResult(`Done — ${s.sent} sent, ${s.skipped} already sent, ${s.failed} failed (${s.total} total evaluated).`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'SMS scheduler failed.');
    } finally {
      setBusy(false);
    }
  }

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

  const agentPriorityMetrics = useMemo(() => {
    const active = rows.filter((row) => OPEN_STATUSES.includes(row.status));
    return {
      all: active.length,
      days_30_plus: active.filter((row) => daysUntil(row.renewal_date) > 30).length,
      days_16_30: active.filter((row) => {
        const days = daysUntil(row.renewal_date);
        return days >= 16 && days <= 30;
      }).length,
      days_8_15: active.filter((row) => {
        const days = daysUntil(row.renewal_date);
        return days >= 8 && days <= 15;
      }).length,
      days_4_7: active.filter((row) => {
        const days = daysUntil(row.renewal_date);
        return days >= 4 && days <= 7;
      }).length,
      days_0_3: active.filter((row) => {
        const days = daysUntil(row.renewal_date);
        return days >= 0 && days <= 3;
      }).length,
      no_follow_up: active.filter((row) => !row.next_follow_up_at).length,
    };
  }, [rows]);

  const displayedRows = useMemo(() => {
    let filtered = rows;

    // Manager phone/SMS filter
    if (profile.role === 'manager' && phoneFilter === 'missing_phone') {
      filtered = filtered.filter((row) => !row.customer_phone);
    } else if (profile.role === 'manager' && phoneFilter === 'has_phone') {
      filtered = filtered.filter((row) => Boolean(row.customer_phone));
    }

    if (profile.role !== 'agent' || agentPriorityFilter === 'all') return filtered;

    return filtered.filter((row) => {
      if (!OPEN_STATUSES.includes(row.status)) return false;
      const days = daysUntil(row.renewal_date);

      switch (agentPriorityFilter) {
        case 'days_30_plus':
          return days > 30;
        case 'days_16_30':
          return days >= 16 && days <= 30;
        case 'days_8_15':
          return days >= 8 && days <= 15;
        case 'days_4_7':
          return days >= 4 && days <= 7;
        case 'days_0_3':
          return days >= 0 && days <= 3;
        case 'no_follow_up':
          return !row.next_follow_up_at;
        default:
          return true;
      }
    });
  }, [agentPriorityFilter, phoneFilter, profile.role, rows]);

  const managerDueMetrics = useMemo(() => {
    const active = managerReportRows.filter((row) => OPEN_STATUSES.includes(row.status));
    const countWithin = (windowDays: ManagerRenewalDueWindow) =>
      active.filter((row) => {
        const days = daysUntil(row.renewal_date);
        return days >= 0 && days <= windowDays;
      });

    return {
      3: countWithin(3),
      7: countWithin(7),
      15: countWithin(15),
      30: countWithin(30),
    };
  }, [managerReportRows]);

  const managerSelectedRows = managerDueMetrics[managerDueWindow];

  const managerAgentBreakdown = useMemo(() => {
    const totals = new Map<string, {
      id: string;
      name: string;
      total: number;
      noFollowUp: number;
    }>();

    for (const row of managerSelectedRows) {
      const key = row.assigned_to || 'unassigned';
      const current = totals.get(key) || {
        id: key,
        name: row.assigned_to ? assigneeName(assignees, row.assigned_to) : 'Unassigned',
        total: 0,
        noFollowUp: 0,
      };
      current.total += 1;
      if (!row.next_follow_up_at) current.noFollowUp += 1;
      totals.set(key, current);
    }

    return Array.from(totals.values()).sort((left, right) =>
      right.total - left.total || left.name.localeCompare(right.name),
    );
  }, [assignees, managerSelectedRows]);

  const managerNoFollowUpCount = managerSelectedRows.filter(
    (row) => !row.next_follow_up_at,
  ).length;

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
      title={importOnly ? 'Power BI Renewal Import' : 'Renewals Management'}
      subtitle={importOnly
        ? 'Upload the Power BI renewal report, confirm its columns, update open records, preserve closed records, and match ASIGNADO names to active employees.'
        : 'Start 30 days before expiration, document every contact with proof, schedule follow-up, and send customers to the shared Sales Intake Queue when a re-quote is needed.'}
      role={profile.role}
      lastUpdated={lastUpdated}
      onRefresh={() => void refresh()}
      embedded={embedded}
    >
      {error ? <div className={`${ui.error} mb-5`}>{error}</div> : null}
      {notice ? <div className={`${ui.success} mb-5`}>{notice}</div> : null}

      {!importOnly ? (
        <div className="mb-5 flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm">
          {profile.role === 'manager' ? <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabButton> : null}
          <TabButton active={tab === 'pipeline'} onClick={() => setTab('pipeline')}>Renewal Pipeline</TabButton>
          {profile.role === 'manager' && showImportTab ? <TabButton active={tab === 'import'} onClick={() => setTab('import')}>Import & Update Data</TabButton> : null}
        </div>
      ) : null}

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
          <section className={`${ui.card} overflow-hidden`}><div className={ui.cardHeader}><div><p className={ui.sectionTitle}>Priority list</p><h2 className="mt-1 text-xl font-black">Closest deadlines</h2></div><button className={ui.btnSecondary} onClick={() => setTab('pipeline')}>View All <ChevronRight className="h-4 w-4" /></button></div><div className="divide-y divide-slate-100">{rows.slice(0, 8).map((row) => { const warning = warningLabel(row); return <button key={row.id} className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-[#f8faff]" onClick={() => setSelectedId(row.id)}><div><p className="font-black text-slate-900">{row.customer_name}</p><p className="mt-1 text-xs font-semibold text-slate-500">{row.policy_number} · {assigneeName(assignees, row.assigned_to)}</p></div><span className={`${ui.badge} ${ui.badgeTone[warning.tone]}`}>{warning.label}</span></button>})}{!rows.length ? <div className={ui.empty}>No renewal records in this view.</div> : null}</div></section>
        </div>
      ) : null}

      {tab === 'pipeline' ? (
        <section className={`${ui.card} overflow-hidden`}>
          {profile.role === 'manager' ? (
            <div className="border-b border-slate-100 bg-slate-50/70 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className={ui.sectionTitle}>Renewal due report</p>
                  <h2 className="mt-1 text-xl font-black text-slate-950">
                    Agency renewal workload by deadline
                  </h2>
                  <p className="mt-1 max-w-3xl text-xs font-semibold leading-5 text-slate-500">
                    Select a deadline window to see the agency total, the workload assigned to each employee, and renewals without a scheduled follow-up.
                  </p>
                </div>
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="text-xs font-black uppercase tracking-wide text-amber-700">
                    No follow-up · selected period
                  </p>
                  <p className="mt-1 text-2xl font-black text-amber-900">
                    {managerNoFollowUpCount}
                  </p>
                </div>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {([3, 7, 15, 30] as ManagerRenewalDueWindow[]).map((windowDays) => {
                  const windowRows = managerDueMetrics[windowDays];
                  const noFollowUp = windowRows.filter((row) => !row.next_follow_up_at).length;
                  const active = managerDueWindow === windowDays;
                  return (
                    <button
                      key={windowDays}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setManagerDueWindow(windowDays)}
                      className={`rounded-2xl border p-3 text-left transition ${
                        active
                          ? 'border-[#223f7a] bg-[#223f7a] text-white shadow-sm'
                          : 'border-slate-200 bg-white text-slate-900 hover:border-[#8da4cf] hover:bg-[#f8faff]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className={`text-xs font-black uppercase tracking-wide ${active ? 'text-blue-100' : 'text-slate-500'}`}>
                            Next {windowDays} days
                          </p>
                          <p className={`mt-1 text-[11px] font-semibold ${active ? 'text-blue-100' : 'text-slate-400'}`}>
                            {noFollowUp} without follow-up
                          </p>
                        </div>
                        <span className={`text-2xl font-black ${active ? 'text-white' : 'text-[#223f7a]'}`}>
                          {windowRows.length}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
                  <div>
                    <p className="text-sm font-black text-slate-900">
                      Due within the next {managerDueWindow} days
                    </p>
                    <p className="mt-0.5 text-xs font-semibold text-slate-500">
                      Agent assignment and missing follow-up totals
                    </p>
                  </div>
                  <span className="rounded-full bg-[#eef3fb] px-3 py-1 text-xs font-black text-[#223f7a]">
                    {managerSelectedRows.length} renewals
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className={ui.table}>
                    <thead>
                      <tr>
                        <th className={ui.th}>Agent / Employee</th>
                        <th className={ui.th}>Renewals Due</th>
                        <th className={ui.th}>No Follow-up</th>
                        <th className={ui.th}>Follow-up Coverage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {managerAgentBreakdown.map((entry) => {
                        const coverage = entry.total
                          ? Math.round(((entry.total - entry.noFollowUp) / entry.total) * 100)
                          : 0;
                        return (
                          <tr key={entry.id}>
                            <td className={ui.td}>
                              <p className="font-black text-slate-900">{entry.name}</p>
                              <p className="mt-1 text-xs font-semibold text-slate-400">
                                {entry.id === 'unassigned' ? 'Needs assignment' : 'Assigned workload'}
                              </p>
                            </td>
                            <td className={ui.td}>
                              <span className="text-lg font-black text-[#223f7a]">{entry.total}</span>
                            </td>
                            <td className={ui.td}>
                              <span className={`text-lg font-black ${entry.noFollowUp ? 'text-amber-700' : 'text-emerald-700'}`}>
                                {entry.noFollowUp}
                              </span>
                            </td>
                            <td className={ui.td}>
                              <div className="min-w-[150px]">
                                <div className="flex items-center justify-between gap-2 text-xs font-black">
                                  <span className="text-slate-500">{coverage}%</span>
                                  <span className="text-slate-400">
                                    {entry.total - entry.noFollowUp}/{entry.total}
                                  </span>
                                </div>
                                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                                  <div
                                    className="h-full rounded-full bg-[#223f7a]"
                                    style={{ width: `${coverage}%` }}
                                  />
                                </div>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!managerAgentBreakdown.length ? (
                  <div className={ui.empty}>No open renewals are due in this period.</div>
                ) : null}
              </div>

              <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50/50 p-4">
                <div className="flex items-start gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-2xl bg-violet-100 text-violet-700"><Smartphone className="h-5 w-5" /></div>
                  <div className="flex-1">
                    <h3 className="font-black text-slate-950">Send Renewal Text Reminders</h3>
                    <p className="mt-1 text-sm font-semibold text-slate-500">Sends SMS reminders to all assigned renewals due within 30, 15, and 7 days that haven't received a text yet. Only renewals with a phone number on file will get a message.</p>
                    <button type="button" className={`${ui.btnPrimary} mt-3`} disabled={busy} onClick={() => void runSmsScheduler()}><Smartphone className="h-4 w-4" />Send All Due Reminders Now</button>
                    {smsSchedulerResult ? <p className="mt-2 text-xs font-bold text-emerald-700">{smsSchedulerResult}</p> : null}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {profile.role === 'agent' ? (
            <div className="border-b border-slate-100 bg-slate-50/70 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className={ui.sectionTitle}>My renewal priorities</p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    Select a counter to filter your assigned renewals. Select it again to show all.
                  </p>
                </div>
                {agentPriorityFilter !== 'all' ? (
                  <button
                    type="button"
                    className={ui.btnSecondary}
                    onClick={() => setAgentPriorityFilter('all')}
                  >
                    Clear filter
                  </button>
                ) : null}
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                {([
                  ['days_30_plus', '30+ days', 'More than 30 days', agentPriorityMetrics.days_30_plus],
                  ['days_16_30', '30 days', '16–30 days', agentPriorityMetrics.days_16_30],
                  ['days_8_15', '15 days', '8–15 days', agentPriorityMetrics.days_8_15],
                  ['days_4_7', '7 days', '4–7 days', agentPriorityMetrics.days_4_7],
                  ['days_0_3', '3 days', '0–3 days', agentPriorityMetrics.days_0_3],
                  ['no_follow_up', 'No follow-up', 'Nothing scheduled', agentPriorityMetrics.no_follow_up],
                ] as Array<[AgentRenewalPriorityFilter, string, string, number]>).map(([value, label, description, count]) => {
                  const active = agentPriorityFilter === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setAgentPriorityFilter((current) => current === value ? 'all' : value)}
                      className={`rounded-2xl border p-3 text-left transition ${
                        active
                          ? 'border-[#223f7a] bg-[#223f7a] text-white shadow-sm'
                          : 'border-slate-200 bg-white text-slate-900 hover:border-[#8da4cf] hover:bg-[#f8faff]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className={`text-xs font-black uppercase tracking-wide ${active ? 'text-blue-100' : 'text-slate-500'}`}>{label}</p>
                          <p className={`mt-1 text-[11px] font-semibold ${active ? 'text-blue-100' : 'text-slate-400'}`}>{description}</p>
                        </div>
                        <span className={`text-2xl font-black ${active ? 'text-white' : 'text-[#223f7a]'}`}>{count}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className={ui.cardHeader}><div><p className={ui.sectionTitle}>Renewal Pipeline</p><h2 className="mt-1 text-xl font-black">{profile.role === 'manager' ? 'Agency renewal workload' : 'My assigned renewals'}</h2></div><button type="button" className={ui.btnSecondary} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" />Refresh</button></div>
          <div className="grid gap-3 border-b border-slate-100 p-4 xl:grid-cols-[1fr_180px_190px_190px]">
            <label className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 text-sm font-semibold outline-none" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search customer, policy, carrier, phone or email" /></label>
            <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="open">Open statuses</option><option value="all">All statuses</option>{[...OPEN_STATUSES, ...CLOSED_STATUSES].map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select>
            {profile.role === 'manager' ? (
              <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={dueFilter} onChange={(event) => setDueFilter(event.target.value as typeof dueFilter)}><option value="active30">Active 30-day window</option><option value="overdue">Overdue</option><option value="all">All dates</option></select>
            ) : (
              <div className="rounded-xl bg-[#eef3fb] px-3 py-2.5 text-sm font-black text-[#223f7a]">
                Showing {displayedRows.length} of {rows.length}
              </div>
            )}
            {profile.role === 'manager' ? <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={assignedFilter} onChange={(event) => setAssignedFilter(event.target.value)}><option value="all">All assignees</option><option value="unassigned">Unassigned</option>{assignees.map((person) => <option key={person.id} value={person.id}>{person.display_name}</option>)}</select> : <div className="rounded-xl bg-[#eef3fb] px-3 py-2.5 text-sm font-black text-[#223f7a]">Assigned to {profile.display_name}</div>}
            {profile.role === 'manager' ? <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={phoneFilter} onChange={(event) => setPhoneFilter(event.target.value as typeof phoneFilter)}><option value="all">All records</option><option value="missing_phone">Missing phone</option><option value="has_phone">Has phone</option></select> : null}
          </div>
          <div className="overflow-x-auto"><table className={ui.table}><thead><tr><th className={ui.th}>Deadline</th><th className={ui.th}>Customer / Policy</th><th className={ui.th}>Carrier</th><th className={ui.th}>Premium</th><th className={ui.th}>Status</th><th className={ui.th}>Assigned</th><th className={ui.th}>Next follow-up</th><th className={ui.th}>Action</th></tr></thead><tbody>{displayedRows.map((row) => { const warning = warningLabel(row); return <tr key={row.id} className={ui.trHover} onClick={() => setSelectedId(row.id)}><td className={ui.td}><span className={`${ui.badge} ${ui.badgeTone[warning.tone]}`}>{warning.label}</span><p className="mt-2 text-xs font-semibold text-slate-400">{new Date(`${row.renewal_date}T00:00:00`).toLocaleDateString()}</p></td><td className={ui.td}><p className="font-black text-slate-900">{row.customer_name}</p><div className="mt-1 flex flex-wrap items-center gap-2"><p className="text-xs font-semibold text-slate-500">{row.policy_number}</p>{row.requote_requested ? <span className={`${ui.badge} ${ui.badgeTone.progress}`}>Requote flagged</span> : null}{row.source_sync_state === 'missing_from_latest_file' ? <span className={`${ui.badge} ${ui.badgeTone.progress}`}>Missing from latest file</span> : null}</div></td><td className={ui.td}><p className="font-bold">{row.carrier || '—'}</p><p className="mt-1 text-xs text-slate-400">{row.line_of_business || 'Line not recorded'}</p></td><td className={ui.td}><p className="font-black">{money(row.premium_renewal)}</p><p className={`mt-1 text-xs font-black ${premiumDelta(row).startsWith('+') ? 'text-rose-700' : 'text-emerald-700'}`}>{premiumDelta(row)}</p></td><td className={ui.td}><span className={`${ui.badge} ${ui.badgeTone[renewalStatusTone[row.status] || 'neutral']}`}>{statusLabel(row.status)}</span></td><td className={ui.td}><p className="font-bold">{assigneeName(assignees, row.assigned_to)}</p></td><td className={ui.td}><p className="text-xs font-semibold text-slate-500">{row.next_follow_up_at ? new Date(row.next_follow_up_at).toLocaleString() : 'Not scheduled'}</p></td><td className={ui.td}><button className={ui.btnSecondary} onClick={(event) => { event.stopPropagation(); setSelectedId(row.id); }}>Open</button></td></tr>})}</tbody></table>{!displayedRows.length ? <div className={ui.empty}>No renewals match this priority filter.</div> : null}</div>
        </section>
      ) : null}

      {(tab === 'import' || importOnly) && profile.role === 'manager' ? <ImportWizard assignees={assignees} onRefreshAssignees={refresh} onComplete={async () => { setNotice('Renewal data imported/updated. Closed records remained unchanged.'); await refresh(); }} /> : null}

      <Drawer open={Boolean(selected)} onClose={() => setSelectedId(null)}>
        {selected ? <RenewalDrawer record={selected} profile={profile} assignees={assignees} onChanged={async () => { await refresh(); }} /> : null}
      </Drawer>
    </ModuleShell>
  );
}

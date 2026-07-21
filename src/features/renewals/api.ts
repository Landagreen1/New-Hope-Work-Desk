'use client';

import { getSupabase } from '../nhwd-shared/client';

export type RenewalStatus =
  | 'imported'
  | 'assigned'
  | 'in_progress'
  | 'monitoring'
  | 'requote_sent'
  | 'renewed'
  | 'lost'
  | 'cancelled';

export type RenewalChannel = 'call' | 'sms' | 'whatsapp' | 'email' | 'in_person' | 'other';
export type RenewalDirection = 'outbound' | 'inbound';

export interface RenewalRecord {
  id: string;
  status: RenewalStatus;
  hawksoft_client_id: string | null;
  policy_number: string;
  line_of_business: string | null;
  carrier: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  renewal_date: string;
  premium_current: number | null;
  premium_renewal: number | null;
  notice_call_at: string | null;
  import_notes: string | null;
  eft_enabled: boolean | null;
  requote_requested: boolean;
  requote_note: string | null;
  assigned_import_label: string | null;
  powerbi_raw: Record<string, string> | null;
  assignment_source: 'powerbi' | 'manager' | 'manual' | null;
  last_seen_import_run_id: string | null;
  last_seen_imported_at: string | null;
  source_sync_state: 'present' | 'missing_from_latest_file';
  missing_since_import_run_id: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  dealer_id: string | null;
  salesperson_id: string | null;
  next_follow_up_at: string | null;
  requote_work_item_id: string | null;
  requote_intake_id: string | null;
  requote_sent_at: string | null;
  outcome_reason: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RenewalContact {
  id: string;
  record_id: string;
  contacted_by: string | null;
  channel: RenewalChannel;
  direction: RenewalDirection;
  outcome: string | null;
  notes: string | null;
  occurred_at: string;
  entry_source: 'manual' | 'ringcentral_api';
  rc_call_id: string | null;
  rc_session_id: string | null;
  rc_recording_content_uri: string | null;
  evidence_path: string | null;
  evidence_name: string | null;
  evidence_reference: string | null;
  evidence_mime_type: string | null;
  evidence_size_bytes: number | null;
}

export interface RenewalEvent {
  id: string;
  record_id: string;
  actor_id: string | null;
  event_type: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface ImportBatchResult {
  id: string;
  rows_total: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
  rows_closed_preserved?: number;
  rows_assigned?: number;
  rows_requote_flagged?: number;
  rows_missing_in_window?: number;
  rows_restored_present?: number;
  distinct_assignee_labels?: number;
  file_date_min?: string | null;
  file_date_max?: string | null;
  unmatched_assignees?: string[];
}

export interface RenewalAssignee {
  id: string;
  username: string;
  display_name: string;
  initials: string;
  role: 'agent' | 'customer_service';
  is_active: boolean;
}

export interface RenewalAssignmentAlias {
  id: string;
  import_label: string;
  normalized_label: string;
  profile_id: string;
  created_at: string;
  updated_at: string;
}

export interface AssignmentAliasResult {
  alias: RenewalAssignmentAlias;
  rows_assigned: number;
}

export interface RenewalImportRun {
  id: string;
  file_name: string;
  imported_by: string;
  column_mapping: Record<string, string>;
  rows_total: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
  rows_closed_preserved: number;
  rows_assigned: number;
  rows_requote_flagged: number;
  rows_missing_in_window: number;
  rows_restored_present: number;
  distinct_assignee_labels: number;
  unmatched_assignees: string[];
  file_date_min: string | null;
  file_date_max: string | null;
  created_at: string;
}

export interface RenewalSyncException {
  id: string;
  customer_name: string;
  policy_number: string;
  renewal_date: string;
  carrier: string | null;
  line_of_business: string | null;
  assigned_import_label: string | null;
  assigned_to: string | null;
  source_sync_state: 'missing_from_latest_file';
  last_seen_imported_at: string | null;
  missing_since_import_run_id: string | null;
  status: RenewalStatus;
}

export interface NormalizedImportRow {
  policy_number: string;
  renewal_date: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  carrier?: string;
  line_of_business?: string;
  hawksoft_client_id?: string;
  premium_current?: string;
  premium_renewal?: string;
  notice_call_date?: string;
  notes?: string;
  eft?: string;
  requote?: string;
  requote_note?: string;
  assigned_name?: string;
  raw?: Record<string, string>;
}

export interface RenewalFilters {
  status?: RenewalStatus | 'all' | 'open';
  assignedTo?: string | 'all' | 'unassigned';
  dueWindow?: 'all' | 'active30' | 'overdue';
  search?: string;
}

const OPEN_STATUSES: RenewalStatus[] = ['imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent'];
const MAX_EVIDENCE_SIZE_BYTES = 100 * 1024 * 1024;

function throwIfError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || 'The renewal request could not be completed.');
}

export async function listRenewals(filter: RenewalFilters = {}): Promise<RenewalRecord[]> {
  let query = getSupabase()
    .from('renewal_records')
    .select('*')
    .order('renewal_date', { ascending: true })
    .limit(2000);

  if (filter.status && filter.status !== 'all' && filter.status !== 'open') query = query.eq('status', filter.status);
  if (filter.status === 'open') query = query.in('status', OPEN_STATUSES);
  if (filter.assignedTo === 'unassigned') query = query.is('assigned_to', null);
  else if (filter.assignedTo && filter.assignedTo !== 'all') query = query.eq('assigned_to', filter.assignedTo);

  const { data, error } = await query;
  throwIfError(error);
  let rows = (data as RenewalRecord[]) ?? [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (filter.dueWindow === 'active30') {
    const max = new Date(today);
    max.setDate(max.getDate() + 30);
    rows = rows.filter((row) => {
      const renewal = new Date(`${row.renewal_date}T00:00:00`);
      return renewal >= today && renewal <= max;
    });
  }
  if (filter.dueWindow === 'overdue') rows = rows.filter((row) => new Date(`${row.renewal_date}T00:00:00`) < today && OPEN_STATUSES.includes(row.status));
  if (filter.search?.trim()) {
    const needle = filter.search.trim().toLowerCase();
    rows = rows.filter((row) => [row.customer_name, row.policy_number, row.carrier, row.customer_phone, row.customer_email].some((value) => value?.toLowerCase().includes(needle)));
  }
  return rows;
}

export async function listContacts(recordId: string): Promise<RenewalContact[]> {
  const { data, error } = await getSupabase()
    .from('renewal_contacts')
    .select('*')
    .eq('record_id', recordId)
    .order('occurred_at', { ascending: false });
  throwIfError(error);
  return (data as RenewalContact[]) ?? [];
}

export async function listRenewalEvents(recordId: string): Promise<RenewalEvent[]> {
  const { data, error } = await getSupabase()
    .from('renewal_events')
    .select('*')
    .eq('record_id', recordId)
    .order('created_at', { ascending: false });
  throwIfError(error);
  return (data as RenewalEvent[]) ?? [];
}

export async function addContact(input: {
  recordId: string;
  channel: RenewalChannel;
  direction: RenewalDirection;
  outcome: string;
  notes: string;
  occurredAt?: string;
  evidenceFile?: File | null;
  evidenceReference?: string | null;
}): Promise<void> {
  const supabase = getSupabase();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  throwIfError(authError);
  if (!auth.user) throw new Error('Your session expired. Sign in again.');

  let evidencePath: string | null = null;
  let evidenceName: string | null = null;
  let evidenceMimeType: string | null = null;
  let evidenceSizeBytes: number | null = null;

  if (input.evidenceFile) {
    if (input.evidenceFile.size > MAX_EVIDENCE_SIZE_BYTES) {
      throw new Error('The evidence file is larger than 100 MB. Compress it or upload a smaller file.');
    }

    const extension = input.evidenceFile.name.includes('.')
      ? input.evidenceFile.name.split('.').pop()?.toLowerCase()
      : 'bin';
    const safeName = `${crypto.randomUUID()}.${extension || 'bin'}`;
    evidencePath = `${input.recordId}/${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from('renewal-contact-evidence')
      .upload(evidencePath, input.evidenceFile, {
        upsert: false,
        cacheControl: '3600',
        contentType: input.evidenceFile.type || 'application/octet-stream',
      });

    if (uploadError) {
      throw new Error(`Evidence upload failed: ${uploadError.message}`);
    }

    evidenceName = input.evidenceFile.name;
    evidenceMimeType = input.evidenceFile.type || null;
    evidenceSizeBytes = input.evidenceFile.size;
  }

  const { error } = await supabase.from('renewal_contacts').insert({
    record_id: input.recordId,
    contacted_by: auth.user.id,
    channel: input.channel,
    direction: input.direction,
    outcome: input.outcome,
    notes: input.notes,
    occurred_at: input.occurredAt || new Date().toISOString(),
    entry_source: 'manual',
    evidence_path: evidencePath,
    evidence_name: evidenceName,
    evidence_reference: input.evidenceReference || null,
    evidence_mime_type: evidenceMimeType,
    evidence_size_bytes: evidenceSizeBytes,
  });

  if (error && evidencePath) {
    await supabase.storage.from('renewal-contact-evidence').remove([evidencePath]);
  }

  if (error) {
    throw new Error(`The customer contact could not be saved: ${error.message}`);
  }
}

function isHttpUrl(value: string | null | undefined): value is string {
  return Boolean(value && /^https?:\/\//i.test(value));
}

function evidenceDownloadName(contact: RenewalContact): string {
  if (contact.evidence_name?.trim()) return contact.evidence_name.trim();

  const timestamp = contact.occurred_at
    ? new Date(contact.occurred_at).toISOString().replaceAll(':', '-')
    : new Date().toISOString().replaceAll(':', '-');

  if (contact.channel === 'call' || contact.rc_recording_content_uri) {
    return `renewal-call-${timestamp}.mp3`;
  }

  return `renewal-evidence-${timestamp}`;
}

export async function getEvidenceUrl(contact: RenewalContact): Promise<string | null> {
  if (contact.evidence_path) {
    const { data, error } = await getSupabase().storage
      .from('renewal-contact-evidence')
      .createSignedUrl(contact.evidence_path, 900);
    throwIfError(error);
    return data?.signedUrl || null;
  }

  if (isHttpUrl(contact.rc_recording_content_uri)) return contact.rc_recording_content_uri;
  if (isHttpUrl(contact.evidence_reference)) return contact.evidence_reference;
  return null;
}

export async function downloadEvidenceFile(contact: RenewalContact): Promise<void> {
  const fileName = evidenceDownloadName(contact);

  if (contact.evidence_path) {
    const { data, error } = await getSupabase().storage
      .from('renewal-contact-evidence')
      .download(contact.evidence_path);

    if (error) throw new Error(`The uploaded file could not be downloaded: ${error.message}`);
    if (!data) throw new Error('The uploaded file was not returned by storage.');

    const objectUrl = URL.createObjectURL(data);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    return;
  }

  const externalUrl = isHttpUrl(contact.rc_recording_content_uri)
    ? contact.rc_recording_content_uri
    : isHttpUrl(contact.evidence_reference)
      ? contact.evidence_reference
      : null;

  if (!externalUrl) {
    throw new Error('No downloadable file or recording is attached to this interaction.');
  }

  try {
    const response = await fetch(externalUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  } catch {
    window.open(externalUrl, '_blank', 'noopener,noreferrer');
  }
}

export async function updateWorkflow(recordId: string, patch: {
  status?: RenewalStatus;
  nextFollowUpAt?: string | null;
  outcomeReason?: string | null;
}): Promise<void> {
  const { error } = await getSupabase().rpc('renewal_update_workflow', {
    p_record_id: recordId,
    p_status: patch.status || null,
    p_next_follow_up_at: patch.nextFollowUpAt || null,
    p_outcome_reason: patch.outcomeReason || null,
  });
  throwIfError(error);
}


export async function updateRenewalContactInfo(
  recordId: string,
  input: { phone?: string | null; email?: string | null },
): Promise<void> {
  const { error } = await getSupabase().rpc('renewal_update_contact_info', {
    p_record_id: recordId,
    p_phone: input.phone || null,
    p_email: input.email || null,
  });
  throwIfError(error);
}

export async function managerUpdateRecord(recordId: string, patch: Partial<Pick<RenewalRecord,
  | 'hawksoft_client_id'
  | 'policy_number'
  | 'line_of_business'
  | 'carrier'
  | 'customer_name'
  | 'customer_phone'
  | 'customer_email'
  | 'renewal_date'
  | 'premium_current'
  | 'premium_renewal'
  | 'dealer_id'
  | 'salesperson_id'
>>): Promise<void> {
  const { error } = await getSupabase().rpc('renewal_manager_update', {
    p_record_id: recordId,
    p_patch: patch,
  });
  throwIfError(error);
}

export async function assignRenewal(recordId: string, profileId: string): Promise<void> {
  const { error } = await getSupabase().rpc('renewal_assign', {
    p_record_id: recordId,
    p_agent_id: profileId,
  });
  throwIfError(error);
}

export async function listRenewalAssignees(): Promise<RenewalAssignee[]> {
  const { data, error } = await getSupabase()
    .from('profiles')
    .select('id,username,display_name,initials,role,is_active')
    .eq('is_active', true)
    .in('role', ['agent', 'customer_service'])
    .order('role')
    .order('display_name');
  throwIfError(error);
  return (data as RenewalAssignee[]) ?? [];
}

export async function listRenewalAssignmentAliases(): Promise<RenewalAssignmentAlias[]> {
  const { data, error } = await getSupabase()
    .from('renewal_assignment_aliases')
    .select('id,import_label,normalized_label,profile_id,created_at,updated_at')
    .order('import_label');
  throwIfError(error);
  return (data as RenewalAssignmentAlias[]) ?? [];
}

export async function listRenewalImportRuns(limit = 12): Promise<RenewalImportRun[]> {
  const { data, error } = await getSupabase()
    .from('renewal_import_runs')
    .select(
      'id,file_name,imported_by,column_mapping,rows_total,rows_inserted,rows_updated,rows_skipped,rows_closed_preserved,rows_assigned,rows_requote_flagged,rows_missing_in_window,rows_restored_present,distinct_assignee_labels,unmatched_assignees,file_date_min,file_date_max,created_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  throwIfError(error);
  return (data as RenewalImportRun[]) ?? [];
}

export async function listRenewalSyncExceptions(): Promise<RenewalSyncException[]> {
  const { data, error } = await getSupabase()
    .from('renewal_records')
    .select(
      'id,customer_name,policy_number,renewal_date,carrier,line_of_business,assigned_import_label,assigned_to,source_sync_state,last_seen_imported_at,missing_since_import_run_id,status',
    )
    .eq('source_sync_state', 'missing_from_latest_file')
    .in('status', OPEN_STATUSES)
    .order('renewal_date', { ascending: true })
    .limit(2000);
  throwIfError(error);
  return (data as RenewalSyncException[]) ?? [];
}

export async function upsertRenewalAssignmentAlias(
  importLabel: string,
  profileId: string,
): Promise<AssignmentAliasResult> {
  const { data, error } = await getSupabase().rpc('renewal_upsert_assignment_alias', {
    p_import_label: importLabel,
    p_profile_id: profileId,
  });
  throwIfError(error);
  return data as AssignmentAliasResult;
}

export async function deleteRenewalAssignmentAlias(aliasId: string): Promise<void> {
  const { error } = await getSupabase().rpc('renewal_delete_assignment_alias', {
    p_alias_id: aliasId,
  });
  throwIfError(error);
}

export async function sendToRequote(recordId: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('renewal_send_to_requote', {
    p_record_id: recordId,
  });
  throwIfError(error);
  return data as string;
}

export async function generateDueNotifications(): Promise<number> {
  const { data, error } = await getSupabase().rpc('renewal_generate_due_notifications');
  throwIfError(error);
  return Number(data || 0);
}

export async function importBatch(
  fileName: string,
  columnMapping: Record<string, string>,
  rows: NormalizedImportRow[],
): Promise<ImportBatchResult> {
  const { data, error } = await getSupabase().rpc('renewal_import_batch', {
    p_file_name: fileName,
    p_column_mapping: columnMapping,
    p_rows: rows,
  });
  throwIfError(error);
  return data as ImportBatchResult;
}

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else inQuotes = false;
      } else field += character;
    } else if (character === '"') inQuotes = true;
    else if (character === ',') pushField();
    else if (character === '\n') { pushField(); pushRow(); }
    else if (character !== '\r') field += character;
  }
  pushField();
  pushRow();
  const headers = rows.shift()?.map((header, index) => {
    const trimmed = header.trim();
    return index === 0 ? trimmed.replace(/^\uFEFF/, '') : trimmed;
  }) ?? [];
  return { headers, rows };
}

export function normalizeDate(value: string): string | null {
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const match = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!match) return null;
  const [, month, day, rawYear] = match;
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

const GUESSES: Record<string, RegExp> = {
  policy_number: /^(policy#?|policy\s*(number|no\.?|#))$/i,
  renewal_date: /^(renewal\s*date|renewal|expiration\s*date|exp\.?\s*date)$/i,
  customer_name: /^(named\s*insured|insured|customer|client|name)$/i,
  customer_phone: /^(phone|telephone|tel|customer\s*phone)$/i,
  customer_email: /^(email|customer\s*email)$/i,
  carrier: /^(company|carrier)$/i,
  line_of_business: /^(lob|lobs|line\s*of\s*business|policy\s*type)$/i,
  hawksoft_client_id: /^(hawksoft\s*)?client\s*(id|no\.?|#)|^cms$/i,
  premium_current: /current.*prem|prem.*current|old.*prem/i,
  premium_renewal: /renew.*prem|prem.*renew|new.*prem/i,
  notice_call_date: /^(aviso\s*call|notice\s*call|last\s*call|contact\s*date)$/i,
  notes: /^notes?$|status\s*note|contact\s*note/i,
  eft: /^eft$|electronic\s*fund/i,
  requote: /^requote$|re[-\s]?quote\s*(needed|flag)?/i,
  requote_note: /nota\s*requote|requote\s*note/i,
  assigned_name: /^(asignacion\s*txt|asignació?n\s*txt|asignaciontxt|asignado|asignaci[oó]n|responsable|responsible|assigned\s*(to|agent)?|assignee)$/i,
};

export function guessMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const [field, expression] of Object.entries(GUESSES)) {
    const match = headers.find((header) => expression.test(header) && !Object.values(mapping).includes(header));
    if (match) mapping[field] = match;
  }
  return mapping;
}

export function normalizeAssignmentLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
}

export function extractDistinctAssignmentLabels(rows: NormalizedImportRow[]): string[] {
  const labels = new Map<string, string>();
  for (const row of rows) {
    const label = row.assigned_name?.trim();
    if (!label) continue;
    const normalized = normalizeAssignmentLabel(label);
    if (normalized && !labels.has(normalized)) labels.set(normalized, label);
  }
  return Array.from(labels.values()).sort((left, right) => left.localeCompare(right));
}

export function buildNormalizedRows(headers: string[], rawRows: string[][], mapping: Record<string, string>): NormalizedImportRow[] {
  const indexByHeader = new Map(headers.map((header, index) => [header, index]));
  const value = (row: string[], field: string) => {
    const header = mapping[field];
    const index = header ? indexByHeader.get(header) : undefined;
    return index === undefined ? '' : (row[index] || '').trim();
  };

  return rawRows.map((row) => ({
    policy_number: value(row, 'policy_number'),
    renewal_date: normalizeDate(value(row, 'renewal_date')) || '',
    customer_name: value(row, 'customer_name'),
    customer_phone: value(row, 'customer_phone'),
    customer_email: value(row, 'customer_email'),
    carrier: value(row, 'carrier'),
    line_of_business: value(row, 'line_of_business'),
    hawksoft_client_id: value(row, 'hawksoft_client_id'),
    premium_current: value(row, 'premium_current').replace(/[$,]/g, ''),
    premium_renewal: value(row, 'premium_renewal').replace(/[$,]/g, ''),
    notice_call_date: normalizeDate(value(row, 'notice_call_date')) || '',
    notes: value(row, 'notes'),
    eft: value(row, 'eft'),
    requote: value(row, 'requote'),
    requote_note: value(row, 'requote_note'),
    assigned_name: value(row, 'assigned_name'),
    raw: Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])),
  })).filter((row) => row.policy_number && row.renewal_date);
}

// ---------------------------------------------------------------------------
// Renewal SMS Log
// ---------------------------------------------------------------------------

export type SmsTriggerType = 'auto_30d' | 'auto_15d' | 'auto_7d' | 'manual';
export type SmsDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'rejected';

export interface RenewalSmsLog {
  id: string;
  record_id: string;
  phone: string;
  message_text: string;
  trigger_type: SmsTriggerType;
  rc_message_id: string | null;
  rc_batch_id: string | null;
  delivery_status: SmsDeliveryStatus;
  error_detail: string | null;
  sent_by: string | null;
  sent_at: string;
  created_at: string;
}

export async function listSmsLogs(recordId: string): Promise<RenewalSmsLog[]> {
  const { data, error } = await getSupabase()
    .from('renewal_sms_log')
    .select('*')
    .eq('record_id', recordId)
    .order('sent_at', { ascending: false });
  throwIfError(error);
  return (data as RenewalSmsLog[]) ?? [];
}

export async function sendRenewalSms(recordId: string, message?: string): Promise<{ success: boolean; error?: string }> {
  const response = await fetch('/api/renewals/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recordId, message: message || undefined }),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || 'The text message could not be sent.');
  }
  return { success: true };
}

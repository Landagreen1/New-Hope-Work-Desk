// src/features/renewals/api.ts
// Data layer for Renewals Management. Targets the v0.9.5-r3 schema:
// renewal_imports / renewal_records / renewal_contacts / renewal_events
// and the RPCs renewal_import_batch, renewal_assign, renewal_send_to_requote.
'use client';

import { getSupabase } from '../nhwd-shared/client';

export type RenewalStatus =
  | 'imported' | 'assigned' | 'in_progress' | 'monitoring'
  | 'requote_sent' | 'renewed' | 'lost' | 'cancelled';

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
  assigned_to: string | null;
  assigned_at: string | null;
  dealer_id: string | null;
  salesperson_id: string | null;
  next_follow_up_at: string | null;
  requote_work_item_id: string | null;
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
  channel: 'call' | 'sms' | 'whatsapp' | 'email' | 'in_person' | 'other';
  direction: 'outbound' | 'inbound';
  outcome: string | null;
  notes: string | null;
  occurred_at: string;
  entry_source: 'manual' | 'ringcentral_api';
}

export interface ImportBatchResult {
  id: string;
  rows_total: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
}

export interface NormalizedImportRow {
  policy_number: string;
  renewal_date: string;         // YYYY-MM-DD
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  carrier?: string;
  line_of_business?: string;
  hawksoft_client_id?: string;
  premium_current?: string;
  premium_renewal?: string;
  raw?: Record<string, string>;
}

export async function listRenewals(filter: {
  status?: RenewalStatus | 'all';
  assignedTo?: string | 'all' | 'unassigned';
}): Promise<RenewalRecord[]> {
  let q = getSupabase()
    .from('renewal_records')
    .select('*')
    .order('renewal_date', { ascending: true })
    .limit(500);
  if (filter.status && filter.status !== 'all') q = q.eq('status', filter.status);
  if (filter.assignedTo === 'unassigned') q = q.is('assigned_to', null);
  else if (filter.assignedTo && filter.assignedTo !== 'all') q = q.eq('assigned_to', filter.assignedTo);
  const { data, error } = await q;
  if (error) throw error;
  return (data as RenewalRecord[]) ?? [];
}

export async function listContacts(recordId: string): Promise<RenewalContact[]> {
  const { data } = await getSupabase()
    .from('renewal_contacts')
    .select('*')
    .eq('record_id', recordId)
    .order('occurred_at', { ascending: false });
  return (data as RenewalContact[]) ?? [];
}

export async function addContact(c: {
  record_id: string; contacted_by: string;
  channel: RenewalContact['channel']; direction: RenewalContact['direction'];
  outcome: string | null; notes: string | null;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('renewal_contacts').insert({ ...c, entry_source: 'manual' });
  if (error) throw error;
  // First manual touch moves an assigned record into In Progress.
  await supabase
    .from('renewal_records')
    .update({ status: 'in_progress' })
    .eq('id', c.record_id)
    .eq('status', 'assigned');
}

export async function updateRecord(id: string, actorId: string, patch: Partial<RenewalRecord>): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('renewal_records').update(patch).eq('id', id);
  if (error) throw error;
  await supabase.from('renewal_events').insert({
    record_id: id, actor_id: actorId, event_type: 'status_change', detail: patch as Record<string, unknown>,
  });
}

export async function assignRenewal(recordId: string, agentId: string): Promise<void> {
  const { error } = await getSupabase().rpc('renewal_assign', {
    p_record_id: recordId, p_agent_id: agentId,
  });
  if (error) throw error;
}

export async function sendToRequote(recordId: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('renewal_send_to_requote', {
    p_record_id: recordId,
  });
  if (error) throw error;
  return data as string;
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
  if (error) throw error;
  return data as ImportBatchResult;
}

// ---------------------------------------------------------------------------
// Minimal CSV parsing (handles quoted fields; no new dependency).
// If PapaParse is already in package.json, feel free to swap it in.
// ---------------------------------------------------------------------------
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let field = '', row: string[] = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\n') { pushField(); pushRow(); }
    else if (c !== '\r') field += c;
  }
  pushField(); pushRow();
  const headers = rows.shift()?.map((h) => h.trim()) ?? [];
  return { headers, rows };
}

// Accepts M/D/YYYY, MM/DD/YYYY, YYYY-MM-DD; returns YYYY-MM-DD or null.
export function normalizeDate(v: string): string | null {
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const [, mo, d, y] = m;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

// Header auto-guessing for the HawkSoft / Power BI export.
const GUESSES: Record<string, RegExp> = {
  policy_number: /policy/i,
  renewal_date: /renew|expiration|exp\s*date|eff/i,
  customer_name: /insured|customer|client|name/i,
  customer_phone: /phone|tel/i,
  customer_email: /email/i,
  carrier: /carrier|company/i,
  line_of_business: /line|lob|type/i,
  hawksoft_client_id: /client\s*(id|no|#)|cms/i,
  premium_current: /current.*prem|prem.*current|old.*prem/i,
  premium_renewal: /renew.*prem|prem.*renew|new.*prem/i,
};

export function guessMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const [field, re] of Object.entries(GUESSES)) {
    const hit = headers.find((h) => re.test(h) && !Object.values(mapping).includes(h));
    if (hit) mapping[field] = hit;
  }
  return mapping;
}

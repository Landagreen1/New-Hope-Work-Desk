// Renewal activity merge and ordering (Requirement 5.8).
//
// A sibling of `derive.ts` and `format.ts`, held to the same rules: no React, no JSX, no
// Supabase, no clock read, no I/O, and no mutation of any input. `RenewalTimeline.tsx` renders
// what `buildRenewalTimeline` returns and re-exports it, so the ordering rule of Requirement 5.8
// and the classification of every `renewal_events` row are testable without rendering anything.

import { statusLabel } from '../nhwd-shared/ui';
import type { RenewalChannel, RenewalContact, RenewalEvent, RenewalSmsLog } from './api';
import { RENEWAL_OUTCOME_STATUSES, REQUOTE_EVENT_TYPES } from './derive';
import { displayText, evidenceSize, formatTimestamp, readableLabel, timeValue } from './format';

/** Detail lines per entry, so one noisy event payload cannot flood the timeline. */
const MAX_DETAIL_LINES = 6;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** The six event kinds Requirement 5.8 names, plus text messages and remaining activity. */
export type RenewalTimelineEntryKind =
  | 'contact' | 'status' | 'assignment' | 'follow-up' | 'requote' | 'outcome' | 'sms' | 'activity';

/** One attachment reference handed back through `onOpenEvidence` verbatim. */
export interface RenewalTimelineEvidence {
  /** `renewal_contacts.evidence_path`, or the stored external reference when no file was uploaded. */
  reference: string;
  /** Names this specific attachment; used as the accessible name of the evidence control. */
  name: string;
  /** Stored file size as readable text, `null` when the row carries no size. */
  size: string | null;
}

/** One merged, ordered timeline entry. Every field is display-ready. */
export interface RenewalTimelineEntry {
  /** Stable per source row: `contact-…`, `event-…`, or `sms-…`. */
  id: string;
  kind: RenewalTimelineEntryKind;
  /** Stored event time as written, `null` when absent or unreadable. */
  eventTime: string | null;
  /** Epoch milliseconds of `eventTime`, the primary sort key. `null` sorts last. */
  eventTimeValue: number | null;
  /** Epoch milliseconds of the recorded time, the tie-break on equal event times. */
  recordedTimeValue: number | null;
  /** Ingestion index, the final tie-break so the comparator is a total order. */
  sequence: number;
  /** What happened, in one line. */
  label: string;
  /** Who recorded it, `null` when the row names nobody. */
  actor: string | null;
  channel: RenewalChannel | null;
  /** Contact notes or the text message body. */
  notes: string | null;
  details: readonly { label: string; value: string }[];
  evidence: RenewalTimelineEvidence | null;
}

export interface RenewalTimelineInput {
  contacts?: readonly RenewalContact[];
  events?: readonly RenewalEvent[];
  smsLogs?: readonly RenewalSmsLog[];
  /** Profile id to display name. An unresolved id never renders, so no raw identifier is shown. */
  actorNames?: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

const REQUOTE_TYPES = new Set<string>(REQUOTE_EVENT_TYPES);
const OUTCOME_STATUSES = new Set<string>(RENEWAL_OUTCOME_STATUSES);
const ASSIGNMENT_TYPES = new Set<string>([
  'assigned', 'manager_assigned', 'renewal_assigned', 'assignment_changed', 'reassigned',
]);

/** Labels for the event types this feature writes; anything else falls back to its type name. */
const EVENT_LABELS: Record<string, string> = {
  contact_information_added: 'Customer contact information added',
  manager_record_updated: 'Manager corrected renewal information',
  requote_intake_draft_created: 'Requote intake draft created',
  requote_intake_submitted: 'Requote intake submitted to Sales',
  requote_quote_created: 'Requote created in Quotes Database',
  requote_created: 'Requote created in Quotes Database',
  requote_work_item_created: 'Requote created in Quotes Database',
  powerbi_record_created: 'Renewal record created from import',
  powerbi_record_updated: 'Renewal record updated from import',
  powerbi_record_missing: 'Renewal missing from the latest import file',
  powerbi_record_restored: 'Renewal present again in the import file',
  import_record_created: 'Renewal record created from import',
  import_record_updated: 'Renewal record updated from import',
  premium_update: 'Renewal premium updated',
};

const DETAIL_LABELS: Record<string, string> = {
  status: 'Status',
  next_follow_up_at: 'Next follow-up',
  outcome_reason: 'Outcome note',
  assigned_name: 'Assigned employee',
  role: 'Role',
  file_name: 'File',
  assigned_import_label: 'Imported responsible name',
  previous_premium: 'Previous premium',
  new_premium: 'Updated premium',
};

function detailValue(key: string, value: unknown): string | null {
  const text = displayText(value);
  if (!text) return null;
  if (key.endsWith('_at') || key.includes('date')) return formatTimestamp(text) ?? text;
  if (key === 'status') return statusLabel(text);
  return text;
}

/** Detail lines from a stored payload, skipping keys already carried by the entry label. */
function eventDetails(detail: Record<string, unknown> | null, skip: readonly string[]): { label: string; value: string }[] {
  if (!detail) return [];
  const skipped = new Set(skip);
  const lines: { label: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(detail)) {
    if (lines.length >= MAX_DETAIL_LINES) break;
    if (skipped.has(key)) continue;
    const value = detailValue(key, raw);
    if (!value) continue;
    lines.push({ label: DETAIL_LABELS[key] ?? readableLabel(key), value });
  }
  return lines;
}

/**
 * The kind of one `renewal_events` row. A workflow update that carries both a status and a
 * follow-up date is classified by this precedence — outcome, status, then follow-up — and
 * every changed field still renders in the detail lines, so nothing in the payload is lost.
 */
function eventKind(event: RenewalEvent, status: string | null, followUp: string | null): RenewalTimelineEntryKind {
  if (REQUOTE_TYPES.has(event.event_type)) return 'requote';
  if (ASSIGNMENT_TYPES.has(event.event_type)) return 'assignment';
  if (status && OUTCOME_STATUSES.has(status.toLowerCase())) return 'outcome';
  if (status) return 'status';
  if (followUp) return 'follow-up';
  return 'activity';
}

function eventEntryLabel(
  event: RenewalEvent,
  kind: RenewalTimelineEntryKind,
  status: string | null,
  followUp: string | null,
  assignedName: string | null,
): string {
  if (kind === 'outcome' && status) return `Renewal marked ${statusLabel(status)}`;
  if (kind === 'status' && status) return `Status changed to ${statusLabel(status)}`;
  if (kind === 'follow-up' && followUp) return `Next follow-up set to ${formatTimestamp(followUp) ?? followUp}`;
  if (kind === 'assignment') return assignedName ? `Assigned to ${assignedName}` : 'Renewal assignment updated';
  return EVENT_LABELS[event.event_type] ?? statusLabel(event.event_type);
}

function contactEvidence(contact: RenewalContact): RenewalTimelineEvidence | null {
  const path = displayText(contact.evidence_path);
  const reference = displayText(contact.evidence_reference);
  const recording = displayText(contact.rc_recording_content_uri);
  const target = path ?? reference ?? recording;
  if (!target) return null;

  const stored = displayText(contact.evidence_name);
  const name = stored
    ?? (path ? 'Uploaded evidence file' : target === recording ? 'RingCentral call recording' : `Reference ${target}`);

  return { reference: target, name, size: evidenceSize(contact.evidence_size_bytes) };
}

function actorLabel(
  id: string | null | undefined,
  actorNames: ReadonlyMap<string, string> | undefined,
  fallback: string | null,
): string | null {
  const resolved = id ? actorNames?.get(id) : undefined;
  return displayText(resolved) ?? fallback;
}

// ---------------------------------------------------------------------------
// Merge and ordering (Requirement 5.8)
// ---------------------------------------------------------------------------

/**
 * Ordering rule of Requirement 5.8: event time descending, and on equal event times the
 * later-recorded entry first.
 *
 * The recorded time is the row's own recorded timestamp where it holds one distinct from the
 * event time — `renewal_sms_log` carries both `sent_at` and `created_at` — otherwise the event
 * time itself. When both keys tie, the ingestion index decides, which preserves input order;
 * `listContacts`, `listRenewalEvents`, and `listSmsLogs` all return rows most recent first, so
 * the row the database returned as the later record stays ahead of its tie. Entries with no
 * readable event time sort last.
 */
function compareTimelineEntries(left: RenewalTimelineEntry, right: RenewalTimelineEntry): number {
  if (left.eventTimeValue === null || right.eventTimeValue === null) {
    if (left.eventTimeValue !== right.eventTimeValue) return left.eventTimeValue === null ? 1 : -1;
  } else if (left.eventTimeValue !== right.eventTimeValue) {
    return right.eventTimeValue - left.eventTimeValue;
  }

  const leftRecorded = left.recordedTimeValue ?? left.eventTimeValue;
  const rightRecorded = right.recordedTimeValue ?? right.eventTimeValue;
  if (leftRecorded !== null && rightRecorded !== null && leftRecorded !== rightRecorded) {
    return rightRecorded - leftRecorded;
  }

  return left.sequence - right.sequence;
}

/**
 * Merges contact entries, status changes, assignment changes, follow-up date changes, requote
 * activity, recorded outcomes, and text messages into one ordered list (Requirement 5.8).
 * Pure: no clock, no I/O, no mutation of the inputs. Role-based hiding of internal import
 * events stays with the caller; every row handed in is rendered.
 */
export function buildRenewalTimeline(input: RenewalTimelineInput): RenewalTimelineEntry[] {
  const { contacts = [], events = [], smsLogs = [], actorNames } = input;
  const entries: RenewalTimelineEntry[] = [];

  for (const contact of contacts) {
    const outcome = displayText(contact.outcome);
    const direction = displayText(contact.direction);
    entries.push({
      id: `contact-${contact.id}`,
      kind: 'contact',
      eventTime: displayText(contact.occurred_at),
      eventTimeValue: timeValue(contact.occurred_at),
      recordedTimeValue: null,
      sequence: entries.length,
      label: outcome ?? 'Customer contact recorded',
      actor: actorLabel(
        contact.contacted_by,
        actorNames,
        contact.entry_source === 'ringcentral_api' ? 'RingCentral' : null,
      ),
      channel: contact.channel ?? null,
      notes: displayText(contact.notes),
      details: direction ? [{ label: 'Direction', value: statusLabel(direction) }] : [],
      evidence: contactEvidence(contact),
    });
  }

  for (const event of events) {
    const detail = event.detail ?? null;
    const status = displayText(detail?.status);
    const followUp = displayText(detail?.next_follow_up_at);
    const assignedName = displayText(detail?.assigned_name);
    const kind = eventKind(event, status, followUp);
    const skip = kind === 'assignment' ? ['assigned_name'] : kind === 'follow-up' ? ['next_follow_up_at'] : ['status'];
    entries.push({
      id: `event-${event.id}`,
      kind,
      eventTime: displayText(event.created_at),
      eventTimeValue: timeValue(event.created_at),
      recordedTimeValue: null,
      sequence: entries.length,
      label: eventEntryLabel(event, kind, status, followUp, assignedName),
      actor: actorLabel(event.actor_id, actorNames, event.actor_id ? null : 'System'),
      channel: null,
      notes: null,
      details: eventDetails(detail, skip),
      evidence: null,
    });
  }

  for (const log of smsLogs) {
    const trigger = log.trigger_type === 'manual'
      ? 'Manual text message'
      : `Automatic reminder ${log.trigger_type.replace('auto_', '')}`;
    const phone = displayText(log.phone);
    const failure = displayText(log.error_detail);
    entries.push({
      id: `sms-${log.id}`,
      kind: 'sms',
      eventTime: displayText(log.sent_at),
      eventTimeValue: timeValue(log.sent_at),
      recordedTimeValue: timeValue(log.created_at),
      sequence: entries.length,
      label: `${trigger} · ${statusLabel(log.delivery_status)}`,
      actor: actorLabel(log.sent_by, actorNames, log.trigger_type === 'manual' ? null : 'Automatic reminder'),
      channel: 'sms',
      notes: displayText(log.message_text),
      details: [
        ...(phone ? [{ label: 'Sent to', value: phone }] : []),
        ...(failure ? [{ label: 'Failure reason', value: failure }] : []),
      ],
      evidence: null,
    });
  }

  return entries.sort(compareTimelineEntries);
}

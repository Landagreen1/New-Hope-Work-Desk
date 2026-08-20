/**
 * Reading a specialty timeline entry.
 *
 * `specialty_activity_timeline` already merges three histories — the opportunity's
 * own `specialty_activity`, the linked intake's event log, and the shared notes — so
 * there is one chronological story per quote and nothing here queries or duplicates
 * it. What this module owns is the humanising: an entry's `detail` is JSON whose keys
 * differ by event type, and dumping it raw is not a timeline anyone reads.
 *
 * Extracted so the Log modal and the workspace's Activity tab cannot drift into two
 * different accounts of the same event.
 */

import { eventLabel } from './status';
import type { TimelineEntry } from './types';

export const ORIGIN_LABELS: Record<TimelineEntry['origin'], string> = {
  specialty: 'Specialty',
  intake: 'Intake',
  note: 'Note',
};

export function originLabel(origin: TimelineEntry['origin']): string {
  return ORIGIN_LABELS[origin];
}

function statusWords(from: string | null): string {
  return from ? `${from.replace(/_/g, ' ')} → ` : '';
}

/**
 * The specifics of one event, in a sentence.
 *
 * Returns null when the entry's label already says everything, so the timeline does
 * not print a second line that repeats the first.
 */
export function describeTimelineDetail(entry: TimelineEntry): string | null {
  const detail = entry.detail;
  if (!detail) return null;

  const pick = (key: string): string | null => {
    const value = detail[key];
    if (value === null || value === undefined || value === '') return null;
    return String(value);
  };

  const parts: string[] = [];

  const note = pick('note');
  if (note) parts.push(note);

  const carrier = pick('carrier_name');
  const from = pick('from_status') ?? pick('from_stage');
  const to = pick('to_status') ?? pick('to_stage');
  if (carrier && to) parts.push(`${carrier}: ${statusWords(from)}${to.replace(/_/g, ' ')}`);
  else if (carrier) parts.push(carrier);
  else if (to) parts.push(`${statusWords(from)}${to.replace(/_/g, ' ')}`);

  const label = pick('label');
  if (label) parts.push(label);

  const premium = pick('premium') ?? pick('sold_premium');
  if (premium) parts.push(`$${Number(premium).toLocaleString()}`);

  const lostReason = pick('lost_reason');
  if (lostReason) parts.push(lostReason.replace(/_/g, ' '));

  const optionCount = pick('option_count');
  if (optionCount) parts.push(`${optionCount} option(s)`);

  const fields = detail.fields;
  if (Array.isArray(fields) && fields.length > 0) {
    parts.push(`${fields.length} field(s): ${fields.slice(0, 6).join(', ')}`);
  }

  const changes = detail.changes;
  if (Array.isArray(changes) && changes.length > 0) {
    parts.push(
      changes
        .map((change) => {
          const record = change as Record<string, unknown>;
          return `${String(record.field ?? '')} → ${String(record.new_value ?? '')}`;
        })
        .join('; '),
    );
  }

  const reason = pick('reason');
  if (reason) parts.push(reason);

  if (detail.automatic === true) parts.push('automatic');
  if (detail.via === 'customer_service') parts.push('via Customer Service');
  if (detail.legacy === true) parts.push('from the Commercial Board');

  return parts.length > 0 ? parts.join(' · ') : null;
}

/** A day heading and the entries under it, newest day first. */
export interface TimelineDay {
  /** `YYYY-MM-DD`, for the key. */
  key: string;
  /** TODAY, YESTERDAY, or the date. */
  label: string;
  entries: TimelineEntry[];
}

/**
 * Groups a timeline by day.
 *
 * A single flat list of two hundred entries is a wall. Days are how someone actually
 * asks the question — "what happened today, what happened yesterday" — which is the
 * shape the spec's Activity example shows.
 */
export function groupTimelineByDay(entries: readonly TimelineEntry[]): TimelineDay[] {
  const now = new Date();
  const today = now.toDateString();
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1);
  const yesterday = yesterdayDate.toDateString();

  const days: TimelineDay[] = [];
  for (const entry of entries) {
    const when = new Date(entry.occurred_at);
    if (Number.isNaN(when.getTime())) continue;

    const stamp = when.toDateString();
    /*
     * The key is the *local* day, matching the label.
     *
     * `toISOString()` would give the UTC day, and for a US-timezone evening the two
     * disagree — one local Tuesday would split into two groups both headed "Tuesday",
     * because groups only merge with the one immediately before them.
     */
    const key = stamp;
    const label =
      stamp === today
        ? 'Today'
        : stamp === yesterday
          ? 'Yesterday'
          : when.toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              year: when.getFullYear() === now.getFullYear() ? undefined : 'numeric',
            });

    const last = days[days.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else days.push({ key, label, entries: [entry] });
  }
  return days;
}

/** The clock time on an entry, which is what a day-grouped timeline needs. */
export function timeOfDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** A one-line title for an entry, carrier named when there is one. */
export function timelineTitle(entry: TimelineEntry, carrierName: string | null): string {
  const base = eventLabel(entry.event_type);
  return carrierName ? `${base} — ${carrierName}` : base;
}

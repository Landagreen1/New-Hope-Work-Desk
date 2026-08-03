// Display formatting for the renewal surfaces.
//
// A sibling of `derive.ts` and held to the same rules: no React, no JSX, no Supabase, no clock
// read, and no I/O. `derive.ts` decides what a value is; this module decides how that value
// reads on screen. The drawer, the timeline, and the list table each carried their own copy of
// every rule below, so each rule now has exactly one implementation:
//
//   - an absent value renders an em dash (Req 4.4, 4.9, 5.1)
//   - an absent assigned employee reads `Unassigned` (Req 4.3, 5.1)
//   - the literals `null`, `undefined`, `nan`, and `NaN` never reach the screen (Req 5.1)
//   - a premium movement carries a minus below zero, a plus above zero, no sign at zero (Req 4.8)

import type { RenewalPremiumChange } from './derive';

/** Rendered in place of every absent value except the assigned employee (Req 4.4, 4.9, 5.1). */
export const EM_DASH = '—';

/** Rendered when a renewal has no assigned employee (Req 4.3, 5.1). */
export const UNASSIGNED = 'Unassigned';

/**
 * Literals that must never reach the screen, so a stored `null`, `undefined`, `nan`, or `NaN` —
 * the shape the Power BI export writes for an absent field — renders as an em dash instead.
 */
export const FORBIDDEN_TEXT = /^(null|undefined|nan)$/i;

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** A stored `date` column, which carries no time of day. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const BYTES_PER_MEGABYTE = 1_048_576;
const BYTES_PER_KILOBYTE = 1_024;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Trimmed display text, or `null` when the value is absent, blank, or a forbidden literal. */
export function displayText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (Array.isArray(value)) {
    const joined = value.map((entry) => displayText(entry)).filter(Boolean).join(', ');
    return joined || null;
  }
  if (typeof value === 'object') return null;
  const trimmed = String(value).trim();
  return !trimmed || FORBIDDEN_TEXT.test(trimmed) ? null : trimmed;
}

/** The same text as `displayText`, with an em dash in place of an absent value. */
export function text(value: unknown): string {
  return displayText(value) ?? EM_DASH;
}

/** An assigned employee's display name, or `Unassigned` when the record names nobody (Req 4.3). */
export function assignedText(value: unknown): string {
  return displayText(value) ?? UNASSIGNED;
}

/** `p_next_follow_up_at` reads as `Next Follow Up At`: a payload key as a readable label. */
export function readableLabel(value: string): string {
  return value.replace(/^p_/, '').replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

// ---------------------------------------------------------------------------
// Numbers and money
// ---------------------------------------------------------------------------

/** Signed prefix: minus below zero, plus above zero, nothing at exactly zero (Req 4.8). */
export function signOf(value: number): string {
  return value < 0 ? '-' : value > 0 ? '+' : '';
}

/** US dollars, em dash when absent; `signed` adds the Requirement 4.8 sign prefix. */
export function money(value: number | null | undefined, signed = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return signed ? `${signOf(value)}${CURRENCY.format(Math.abs(value))}` : CURRENCY.format(value);
}

/** Premium movement, em dash when either premium was absent (Req 4.4, 4.8). */
export function signedMoney(change: RenewalPremiumChange | null | undefined): string {
  return money(change?.amount, true);
}

/** Premium movement as a signed percentage to one decimal place (Req 4.8). */
export function signedPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${signOf(value)}${Math.abs(value).toFixed(1)}%`;
}

/** Signed whole number, em dash when absent (Req 4.7, 4.9). */
export function wholeNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return String(Math.trunc(value));
}

/** A file size in megabytes to one decimal place. */
export function megabytes(bytes: number): string {
  return `${(bytes / BYTES_PER_MEGABYTE).toFixed(1)} MB`;
}

/** A stored evidence size as readable text, `null` when the row carries no usable size. */
export function evidenceSize(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return null;
  return bytes >= BYTES_PER_MEGABYTE ? megabytes(bytes) : `${(bytes / BYTES_PER_KILOBYTE).toFixed(1)} KB`;
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

/** Epoch milliseconds of a stored timestamp, or `null` when absent or unreadable. */
export function timeValue(value: string | null | undefined): number | null {
  const stored = displayText(value);
  if (!stored) return null;
  const parsed = Date.parse(CALENDAR_DATE.test(stored) ? `${stored}T00:00:00` : stored);
  return Number.isNaN(parsed) ? null : parsed;
}

/** A stored calendar date or timestamp as readable text, em dash when absent or unreadable. */
export function calendarText(value: string | null | undefined, withTime = false): string {
  const stored = displayText(value);
  if (!stored) return EM_DASH;
  const parsed = new Date(CALENDAR_DATE.test(stored) ? `${stored}T00:00:00` : stored);
  if (Number.isNaN(parsed.getTime())) return EM_DASH;
  const day = parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (!withTime || CALENDAR_DATE.test(stored)) return day;
  return `${day} at ${parsed.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
}

/** `Mar 4, 2026 at 2:30 PM`, or `null` when the value is not a readable timestamp. */
export function formatTimestamp(value: string | null | undefined): string | null {
  const at = timeValue(value);
  if (at === null) return null;
  const date = new Date(at);
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${day} at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
}

/** ISO 8601 value for the `datetime` attribute of `<time>`. */
export function machineTimestamp(value: string | null | undefined): string | null {
  const at = timeValue(value);
  return at === null ? null : new Date(at).toISOString();
}

// ---------------------------------------------------------------------------
// Failure text
// ---------------------------------------------------------------------------

/** Failure text always names the attempted renewal operation first (Req 2.7). */
export function failureText(caught: unknown, operation: string): string {
  const detail = caught instanceof Error ? caught.message.trim() : '';
  return detail ? `${operation} ${detail}` : operation;
}

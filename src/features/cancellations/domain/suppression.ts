// Cancellations domain: channel suppression, customer opt-out, and per-channel recipient
// eligibility.
//
// Requirement 21 is the contract for suppression, Requirement 10.10 for eligibility:
// - 21.1 / 21.2  a user-recorded opt-out sets the channel flag on every Contact_Recipient row
//                holding that normalized value in every Cancellation_Case, stores the
//                suppression time, the recording profile, and the source `user-recorded`,
//                audits every affected case, and leaves the other channel alone
// - 21.3 / 21.4  a stored suppression sends zero messages on that channel to that value for
//                every later send attempt — automatic Touchpoints, Send Reminder Now, and
//                Retry Failed Communication alike — including contact rows created by imports
//                that completed after the suppression, and creates no Communication_Record
// - 21.8         an inbound SMS from a stored contact's phone value whose text, trimmed and
//                case-folded, equals STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, or QUIT
//                suppresses SMS with source `customer inbound message` and no actor; any
//                other text changes nothing
// - 21.9         a Manager_Role clear requires reason text of 1 to 2,000 non-whitespace-bearing
//                characters, sets `cleared_at`, `cleared_by`, `clear_reason`, clears the flag on
//                every matching contact row, audits every affected case, and leaves every
//                stored Communication_Record unchanged
// - 10.10        a Touchpoint on a channel includes exactly the Contact_Recipient rows of that
//                channel whose validation status is valid, whose authorization status permits
//                contact, and whose channel suppression flag is not set
//
// **Pure module.** No React, no Supabase client, no network, no file system, no clock, no
// randomness. Every function is a total transform over its parameters, and the current time
// arrives as `SuppressionContext.now`. The functions here return *plans*: the row payloads a
// route or the scheduler writes. Nothing in this file writes anything, which is what lets the
// property tests drive it with an in-memory world.
//
// **Storage contract.** `public.cancellation_suppressions` (`v1.10.0-cancellation-core-tables.sql`)
// holds `channel`, `normalized_value`, `source`, `suppressed_at`, `actor_id` (null for a
// customer inbound message), `reason`, `cleared_at`, `cleared_by`, `clear_reason`, under
// `create unique index ... (channel, normalized_value) where cleared_at is null`. That partial
// index is the reason `suppressChannel` returns a null insert for a value already suppressed:
// a second active row would fail with `23505`. It is also why a cleared row is never deleted —
// one value can be suppressed, cleared, and suppressed again with both records retained.
//
// **Keyed by value, not by contact row.** Suppression matches on the normalized contact value,
// so one opt-out reaches every case holding that value, including contact rows a later import
// creates with their flags cleared (Req 21.3, 21.4). The per-contact `sms_suppressed` /
// `email_suppressed` booleans on `cancellation_contacts` are a denormalized mirror kept in step
// by the plans here; `eligibleContacts` checks the flag *and* the active suppression list, so a
// contact row created after the opt-out is excluded from sends before its flag is ever written.
//
// **Two channel vocabularies.** `cancellation_contacts.channel` is `'phone' | 'email'` while
// `cancellation_suppressions.channel` and `cancellation_communications.channel` are
// `'sms' | 'email'`. A phone contact is suppressed on the `sms` channel. The mapping is
// explicit — `suppressionChannelForContactChannel` and `contactChannelForSuppressionChannel` —
// and every function here states which vocabulary it takes, so no caller has to guess whether
// `'phone'` or `'sms'` is wanted.
//
// **Normalization is imported, never reimplemented.** An inbound opt-out arrives as a raw
// phone string and has to reduce to the exact value the importer stored, or the suppression
// matches nothing. So the E.164 and lower-cased-email rules come from `../import/contacts`
// (Req 10.4, 10.5), and `suppressChannel` normalizes the value it is handed. Those normalizers
// are idempotent on stored values — a stored value is already trimmed, already lower-cased if
// email, and already E.164 if it is a valid phone — so normalizing a value that came out of
// `cancellation_contacts` returns it unchanged, including a phone value retained as an invalid
// trimmed segment under Requirement 10.11.

import { isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import type {
  ContactAuthorizationStatus,
  ContactChannel,
  ContactValidationStatus,
} from '../import/contacts';
import {
  isValidEmailValue,
  isValidPhoneValue,
  normalizeEmailSegment,
  normalizePhoneSegment,
} from '../import/contacts';

// ---------------------------------------------------------------------------
// Stored value domain
// ---------------------------------------------------------------------------

/**
 * `cancellation_suppressions.channel`, the same vocabulary as
 * `cancellation_communications.channel`. Note the deliberate mismatch with
 * `cancellation_contacts.channel`, which is `'phone' | 'email'`.
 */
export type SuppressionChannel = 'sms' | 'email';

export const SUPPRESSION_CHANNELS = ['sms', 'email'] as const satisfies readonly SuppressionChannel[];

/** `cancellation_suppressions.source` (Req 21.1, 21.2, 21.8). */
export type SuppressionSource = 'user-recorded' | 'customer inbound message';

export const SUPPRESSION_SOURCES = [
  'user-recorded',
  'customer inbound message',
] as const satisfies readonly SuppressionSource[];

/** Source of an opt-out a user recorded on behalf of the customer (Req 21.1, 21.2). */
export const USER_RECORDED_SOURCE: SuppressionSource = 'user-recorded';

/** Source of an opt-out the customer sent themselves; carries no actor (Req 21.8). */
export const INBOUND_MESSAGE_SOURCE: SuppressionSource = 'customer inbound message';

/** The `cancellation_contacts` boolean mirroring a suppression channel. */
export type ContactSuppressionColumn = 'sms_suppressed' | 'email_suppressed';

/** The six inbound keywords of Requirement 21.8, upper-cased for folded comparison. */
export const OPT_OUT_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'] as const;

export type OptOutKeyword = (typeof OPT_OUT_KEYWORDS)[number];

/** Longest clear reason accepted, measured after trimming (Req 21.9). */
export const MAX_CLEAR_REASON_LENGTH = 2000;

/** The authorization statuses that permit contact; `Not Authorized` prohibits it (Req 10.10). */
export const AUTHORIZATION_STATUSES_PERMITTING_CONTACT = [
  'Authorized',
  'Unknown',
] as const satisfies readonly ContactAuthorizationStatus[];

/** `cancellation_events.event_type` for a recorded opt-out (Req 21.1, 21.2, 21.8). */
export const OPT_OUT_EVENT_TYPE = 'contact_opt_out_recorded';

/** `cancellation_events.event_type` for a manager clear (Req 21.9). */
export const SUPPRESSION_CLEARED_EVENT_TYPE = 'contact_suppression_cleared';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * The `cancellation_contacts` columns a channel eligibility decision reads (Req 10.10).
 * Structural, so a full database row, an `ImportedContactRow` from the importer, and a test
 * fixture all satisfy it without conversion.
 */
export interface ChannelEligibilityContact {
  channel: ContactChannel;
  normalized_value: string;
  validation_status: ContactValidationStatus;
  authorization_status: ContactAuthorizationStatus;
  sms_suppressed: boolean;
  email_suppressed: boolean;
}

/** An eligibility contact that also identifies its row and its case, as a stored row does. */
export interface SuppressionContact extends ChannelEligibilityContact {
  id: string;
  case_id: string;
}

/**
 * The `cancellation_suppressions` columns this module reads. `cleared_at` absent or null means
 * the row is active; a cleared row is history and is ignored by every check here.
 */
export interface SuppressionRecord {
  id?: string;
  channel: SuppressionChannel;
  normalized_value: string;
  cleared_at?: string | null;
}

/** One `cancellation_suppressions` insert; the database owns `id` and the column defaults. */
export interface SuppressionInsert {
  channel: SuppressionChannel;
  normalized_value: string;
  source: SuppressionSource;
  suppressed_at: string;
  actor_id: string | null;
  reason: string | null;
}

/**
 * The clear of one active `cancellation_suppressions` row (Req 21.9). `suppression_id` is the
 * stored row when the caller supplied it; the channel and value identify the row either way,
 * matched against `cleared_at is null` so a cleared history row is never rewritten.
 */
export interface SuppressionClearUpdate {
  suppression_id: string | null;
  channel: SuppressionChannel;
  normalized_value: string;
  cleared_at: string;
  cleared_by: string;
  clear_reason: string;
}

/** One `cancellation_contacts` flag write, `true` for an opt-out and `false` for a clear. */
export interface ContactFlagUpdate {
  contact_id: string;
  case_id: string;
  column: ContactSuppressionColumn;
  value: boolean;
}

/** One `cancellation_events` insert; `sequence` and the time default are the database's. */
export interface CancellationEventInsert<TDetail> {
  case_id: string;
  actor_id: string | null;
  event_type: string;
  event_time: string;
  detail: TDetail;
}

/** `detail` of an opt-out audit entry. `keyword` is present only for an inbound opt-out. */
export interface OptOutEventDetail {
  channel: SuppressionChannel;
  contact_channel: ContactChannel;
  contact_id: string;
  normalized_value: string;
  source: SuppressionSource;
  reason: string | null;
  keyword: OptOutKeyword | null;
}

/** `detail` of a clear audit entry (Req 21.9). */
export interface SuppressionClearedEventDetail {
  channel: SuppressionChannel;
  contact_channel: ContactChannel;
  contact_id: string;
  normalized_value: string;
  clear_reason: string;
}

/**
 * Everything a plan needs beyond its own arguments.
 *
 * `now` is the caller's clock: the recording time for a user-recorded opt-out, the inbound
 * message time for Requirement 21.8, the clearing time for Requirement 21.9. `contacts` is
 * every contact row that could hold the value — across every case, not one case — because a
 * suppression is keyed by value. `suppressions` may be the whole table; rows of another channel
 * and rows already cleared are ignored.
 */
export interface SuppressionContext {
  now: Date;
  contacts: readonly SuppressionContact[];
  suppressions?: readonly SuppressionRecord[];
}

/** The profile a Requirement 21.9 clear is attributed to. */
export interface SuppressionActor {
  id: string;
  role: AppRole;
}

// ---------------------------------------------------------------------------
// Channel vocabulary mapping
// ---------------------------------------------------------------------------

const CONTACT_CHANNEL_BY_SUPPRESSION_CHANNEL: Record<SuppressionChannel, ContactChannel> = {
  sms: 'phone',
  email: 'email',
};

const SUPPRESSION_CHANNEL_BY_CONTACT_CHANNEL: Record<ContactChannel, SuppressionChannel> = {
  phone: 'sms',
  email: 'email',
};

const CONTACT_FLAG_COLUMN_BY_SUPPRESSION_CHANNEL: Record<SuppressionChannel, ContactSuppressionColumn> = {
  sms: 'sms_suppressed',
  email: 'email_suppressed',
};

/** The suppression channel a contact row is suppressed on: a phone contact is suppressed on `sms`. */
export function suppressionChannelForContactChannel(channel: ContactChannel): SuppressionChannel {
  return SUPPRESSION_CHANNEL_BY_CONTACT_CHANNEL[channel];
}

/** The contact channel a suppression channel addresses: `sms` addresses `phone` contact rows. */
export function contactChannelForSuppressionChannel(channel: SuppressionChannel): ContactChannel {
  return CONTACT_CHANNEL_BY_SUPPRESSION_CHANNEL[channel];
}

/** The `cancellation_contacts` boolean column mirroring a suppression channel. */
export function contactSuppressionColumn(channel: SuppressionChannel): ContactSuppressionColumn {
  return CONTACT_FLAG_COLUMN_BY_SUPPRESSION_CHANNEL[channel];
}

// ---------------------------------------------------------------------------
// Value normalization (Req 10.4, 10.5, 21.8)
// ---------------------------------------------------------------------------

/** A contact value reduced to the form `cancellation_contacts.normalized_value` stores. */
export interface NormalizedSuppressionValue {
  normalizedValue: string;
  /** True when the normalized value is a sendable phone or email value (Req 10.7, 10.12). */
  isValid: boolean;
}

/**
 * Normalizes a raw contact value for the given suppression channel with the importer's own
 * rules: E.164 for `sms` (Req 10.4) and trimmed, lower-cased for `email` (Req 10.3, 10.5).
 *
 * This is the join between an inbound message and the stored rows. A webhook hands over
 * `"(305) 555-0147"`; the importer stored `"+13055550147"`; only running the same normalizer
 * makes those the same key. Normalizing an already-stored value is a no-op, so callers that
 * read the value straight off a contact row can pass it through safely.
 *
 * A value that matches no accepted form is returned as the importer would store it — trimmed
 * and unchanged for a phone segment (Req 10.11), trimmed and lower-cased for an email — with
 * `isValid: false`. Suppressing such a value is still meaningful: it keeps the flags and the
 * audit trail consistent for a contact row that could never be sent to anyway.
 */
export function normalizeSuppressionValue(
  channel: SuppressionChannel,
  rawValue: string,
): NormalizedSuppressionValue {
  if (channel === 'sms') {
    const normalizedValue = normalizePhoneSegment(rawValue).normalizedValue;
    return { normalizedValue, isValid: isValidPhoneValue(normalizedValue) };
  }
  const normalizedValue = normalizeEmailSegment(rawValue).normalizedValue;
  return { normalizedValue, isValid: isValidEmailValue(normalizedValue) };
}

// ---------------------------------------------------------------------------
// Inbound opt-out keywords (Req 21.8)
// ---------------------------------------------------------------------------

const OPT_OUT_KEYWORD_SET = new Set<string>(OPT_OUT_KEYWORDS);

/**
 * The opt-out keyword an inbound message equals, or `null` for every other text (Req 21.8).
 *
 * The comparison is equality of the whole message after removing leading and trailing
 * whitespace and folding case — not a substring search. "Please stop by tomorrow" carries the
 * word `stop` and is not an opt-out; `" stop "` and `"Stop"` are.
 *
 * `String.prototype.trim` is used deliberately here, unlike `trimContactSegment`, which
 * removes only the four characters Requirement 10.3 enumerates for an import cell.
 * Requirement 21.8 says whitespace without qualification, and a customer whose keyboard sent a
 * non-breaking space after STOP still opted out.
 */
export function matchesOptOutKeyword(text: string | null | undefined): OptOutKeyword | null {
  if (text === null || text === undefined) return null;
  const folded = text.trim().toUpperCase();
  return OPT_OUT_KEYWORD_SET.has(folded) ? (folded as OptOutKeyword) : null;
}

// ---------------------------------------------------------------------------
// Reading the active suppression list
// ---------------------------------------------------------------------------

/** True for a suppression row that has not been cleared, which the partial unique index counts. */
export function isActiveSuppression(row: SuppressionRecord): boolean {
  return row.cleared_at === null || row.cleared_at === undefined;
}

/**
 * The active suppression row for a channel and value, or `null`. At most one can exist: the
 * partial unique index on `(channel, normalized_value) where cleared_at is null` guarantees it,
 * and where a caller passes duplicates the first is returned.
 */
export function findActiveSuppression(
  suppressions: readonly SuppressionRecord[],
  channel: SuppressionChannel,
  normalizedValue: string,
): SuppressionRecord | null {
  for (const row of suppressions) {
    if (row.channel !== channel) continue;
    if (row.normalized_value !== normalizedValue) continue;
    if (isActiveSuppression(row)) return row;
  }
  return null;
}

/** Every value actively suppressed on one channel, as a set for repeated lookups. */
export function activeSuppressedValues(
  suppressions: readonly SuppressionRecord[],
  channel: SuppressionChannel,
): Set<string> {
  const values = new Set<string>();
  for (const row of suppressions) {
    if (row.channel === channel && isActiveSuppression(row)) values.add(row.normalized_value);
  }
  return values;
}

/** True when a value is actively suppressed on a channel (Req 21.3, 21.4). */
export function isValueSuppressed(
  normalizedValue: string,
  suppressions: readonly SuppressionRecord[],
  channel: SuppressionChannel,
): boolean {
  return findActiveSuppression(suppressions, channel, normalizedValue) !== null;
}

// ---------------------------------------------------------------------------
// Per-channel eligibility (Req 10.10, 21.3, 21.4)
// ---------------------------------------------------------------------------

/** Why a contact row is not a recipient for a channel; `null` means it is one. */
export type ContactExclusionReason =
  | 'channel_mismatch'
  | 'validation_invalid'
  | 'authorization_not_permitted'
  | 'contact_flag_suppressed'
  | 'value_suppressed';

const PERMITTING_AUTHORIZATION_STATUSES = new Set<string>(AUTHORIZATION_STATUSES_PERMITTING_CONTACT);

/** True for `Authorized` and `Unknown`; `Not Authorized` prohibits contact (Req 10.9, 10.10). */
export function authorizationPermitsContact(status: ContactAuthorizationStatus): boolean {
  return PERMITTING_AUTHORIZATION_STATUSES.has(status);
}

/** The contact row's own suppression flag for a channel, the denormalized mirror of a suppression. */
export function isContactFlagSuppressed(
  contact: ChannelEligibilityContact,
  channel: SuppressionChannel,
): boolean {
  return channel === 'sms' ? contact.sms_suppressed : contact.email_suppressed;
}

/**
 * The first reason a contact row is excluded from a channel, or `null` when it is a recipient
 * (Req 10.10, 21.3, 21.4). Reasons are ordered cheapest first; a row can break several rules
 * and only the first is reported, which is all a skip count needs.
 *
 * `suppressions` may be the whole table. Checking the active list as well as the flag is what
 * makes Requirement 21.3 hold for a contact row an import created after the opt-out: its flag
 * is cleared on creation, and the value match excludes it anyway.
 */
export function contactExclusionReason(
  contact: ChannelEligibilityContact,
  suppressions: readonly SuppressionRecord[],
  channel: SuppressionChannel,
): ContactExclusionReason | null {
  if (contact.channel !== contactChannelForSuppressionChannel(channel)) return 'channel_mismatch';
  if (contact.validation_status !== 'valid') return 'validation_invalid';
  if (!authorizationPermitsContact(contact.authorization_status)) return 'authorization_not_permitted';
  if (isContactFlagSuppressed(contact, channel)) return 'contact_flag_suppressed';
  if (isValueSuppressed(contact.normalized_value, suppressions, channel)) return 'value_suppressed';
  return null;
}

/** True when a contact row is a recipient for the channel (Req 10.10). */
export function isEligibleContact(
  contact: ChannelEligibilityContact,
  suppressions: readonly SuppressionRecord[],
  channel: SuppressionChannel,
): boolean {
  return contactExclusionReason(contact, suppressions, channel) === null;
}

/**
 * The recipients of one send channel, in the order given (Req 10.10, 21.3, 21.4).
 *
 * `channel` is the send channel — `'sms'` selects phone contact rows, `'email'` selects email
 * contact rows. A row is kept only when its validation status is `valid`, its authorization
 * status is `Authorized` or `Unknown`, its channel flag is not set, and its normalized value
 * carries no active suppression. Every other row of the input is dropped, which is the
 * exclusion Requirement 10.10 requires and the zero-send guarantee Requirements 21.3 and 21.4
 * require for the scheduler, Send Reminder Now, and Retry Failed Communication alike.
 *
 * Generic in the row type, so a caller gets its own rows back with `id` and `case_id` intact.
 */
export function eligibleContacts<TContact extends ChannelEligibilityContact>(
  contacts: readonly TContact[],
  activeSuppressions: readonly SuppressionRecord[],
  channel: SuppressionChannel,
): TContact[] {
  return contacts.filter((contact) => isEligibleContact(contact, activeSuppressions, channel));
}

// ---------------------------------------------------------------------------
// Recording a suppression (Req 21.1, 21.2, 21.8)
// ---------------------------------------------------------------------------

/** Why a suppression could not be planned. */
export type SuppressionRejectionCode = 'value_empty' | 'actor_required';

export interface SuppressionRejection {
  code: SuppressionRejectionCode;
  message: string;
}

/**
 * The writes one recorded opt-out produces. The plan carries no Communication_Record write of
 * any kind: an opt-out creates no communication (Req 21.3, 21.4) and no stored communication is
 * modifiable in any case (Req 22.8).
 */
export interface SuppressChannelPlan {
  channel: SuppressionChannel;
  contactChannel: ContactChannel;
  contactFlagColumn: ContactSuppressionColumn;
  normalizedValue: string;
  /** False when the value matches no accepted phone or email form (Req 10.11, 10.12). */
  valueIsValid: boolean;
  source: SuppressionSource;
  /** The recording profile; always `null` for a customer inbound message (Req 21.8). */
  actorId: string | null;
  reason: string | null;
  /** The matched keyword for an inbound opt-out, `null` for a user-recorded one. */
  keyword: OptOutKeyword | null;
  suppressedAt: string;
  /** True when an active suppression already existed, so no second row is inserted. */
  alreadyActive: boolean;
  /** The row to insert, or `null` when the value is already actively suppressed. */
  suppressionInsert: SuppressionInsert | null;
  /** Every contact row holding the value on this channel, whatever its current flag. */
  matchedContactIds: string[];
  /** Every case holding such a contact row. */
  matchedCaseIds: string[];
  /** The flag writes needed: the matched rows whose flag is not already set. */
  contactUpdates: ContactFlagUpdate[];
  /** The cases a flag write touches — the affected cases of Requirements 21.1 and 21.2. */
  affectedCaseIds: string[];
  /** One audit entry per affected case, carrying that case's contact row. */
  events: CancellationEventInsert<OptOutEventDetail>[];
}

export type SuppressChannelResult =
  | { ok: true; plan: SuppressChannelPlan }
  | { ok: false; rejection: SuppressionRejection };

/**
 * Plans the suppression of one channel and value (Req 21.1, 21.2, 21.8).
 *
 * `normalizedValue` is normalized again here, so a raw inbound phone string and a value read
 * off a contact row both resolve to the key the importer stored. Matching against contact rows
 * is then exact string equality on `normalized_value`, per channel: `'sms'` matches `'phone'`
 * contact rows and leaves every email row — and every email flag — untouched, and `'email'`
 * does the reverse. That channel isolation is Requirement 21.1's "leave email suppression
 * unchanged" and Requirement 21.2's converse.
 *
 * The suppression row is the durable fact and it is keyed by value alone, so it reaches every
 * case holding the value including contact rows created by later imports (Req 21.3, 21.4). The
 * per-contact flags are the mirror: only rows whose flag is not already set are returned as
 * writes, and only their cases get an audit entry, so re-recording an opt-out that is already
 * fully applied plans nothing and appends nothing to the append-only timeline. Where the value
 * is already actively suppressed, `suppressionInsert` is `null` — the partial unique index
 * permits one active row per channel and value — while a contact row that appeared since the
 * opt-out still gets its flag write.
 *
 * A `user-recorded` suppression requires a recording profile (Req 21.1, 21.2). A
 * `customer inbound message` stores none, so any actor passed with that source is dropped
 * rather than written (Req 21.8).
 */
export function suppressChannel(
  channel: SuppressionChannel,
  normalizedValue: string,
  source: SuppressionSource,
  actorId: string | null,
  reason: string | null | undefined,
  context: SuppressionContext,
  keyword: OptOutKeyword | null = null,
): SuppressChannelResult {
  const { normalizedValue: value, isValid } = normalizeSuppressionValue(channel, normalizedValue);
  if (value.length === 0) {
    return {
      ok: false,
      rejection: {
        code: 'value_empty',
        message: 'A suppression needs a contact value carrying at least one character.',
      },
    };
  }

  const inbound = source === INBOUND_MESSAGE_SOURCE;
  const recordingActorId = inbound ? null : trimToNull(actorId);
  if (!inbound && recordingActorId === null) {
    return {
      ok: false,
      rejection: {
        code: 'actor_required',
        message: 'A user-recorded opt-out must store the recording profile.',
      },
    };
  }

  const contactChannel = contactChannelForSuppressionChannel(channel);
  const column = contactSuppressionColumn(channel);
  const suppressedAt = context.now.toISOString();
  const storedReason = trimToNull(reason);
  const matched = matchContacts(context.contacts, contactChannel, value, column, true);
  const active = findActiveSuppression(context.suppressions ?? [], channel, value);

  const events: CancellationEventInsert<OptOutEventDetail>[] = matched.updates.map((update) => ({
    case_id: update.case_id,
    actor_id: recordingActorId,
    event_type: OPT_OUT_EVENT_TYPE,
    event_time: suppressedAt,
    detail: {
      channel,
      contact_channel: contactChannel,
      contact_id: update.contact_id,
      normalized_value: value,
      source,
      reason: storedReason,
      keyword,
    },
  }));

  return {
    ok: true,
    plan: {
      channel,
      contactChannel,
      contactFlagColumn: column,
      normalizedValue: value,
      valueIsValid: isValid,
      source,
      actorId: recordingActorId,
      reason: storedReason,
      keyword,
      suppressedAt,
      alreadyActive: active !== null,
      suppressionInsert:
        active !== null
          ? null
          : {
              channel,
              normalized_value: value,
              source,
              suppressed_at: suppressedAt,
              actor_id: recordingActorId,
              reason: storedReason,
            },
      matchedContactIds: matched.contactIds,
      matchedCaseIds: matched.caseIds,
      contactUpdates: matched.updates,
      affectedCaseIds: distinct(matched.updates.map((update) => update.case_id)),
      events,
    },
  };
}

// ---------------------------------------------------------------------------
// Inbound opt-out (Req 21.8)
// ---------------------------------------------------------------------------

/** Why an inbound message produced no suppression. */
export type InboundOptOutSkipReason = 'no_keyword_match' | 'no_matching_contact' | 'rejected';

export type InboundOptOutResult =
  | {
      suppressed: true;
      keyword: OptOutKeyword;
      normalizedValue: string;
      plan: SuppressChannelPlan;
    }
  | {
      suppressed: false;
      keyword: OptOutKeyword | null;
      normalizedValue: string;
      skipped: InboundOptOutSkipReason;
      rejection: SuppressionRejection | null;
    };

/**
 * Evaluates one inbound SMS against Requirement 21.8 and plans the SMS suppression it calls
 * for.
 *
 * Both of the requirement's conditions are checked and neither is assumed. The message text
 * must equal an opt-out keyword after trimming and case folding, and the sending number must
 * normalize to the phone value of a stored Contact_Recipient — a keyword from a number the
 * agency holds no contact row for stores nothing. `context.now` is the inbound message time,
 * which is what the suppression stores, and the plan carries no actor because the customer, not
 * an employee, made the request.
 *
 * Every other message text leaves suppression unchanged, which is the second half of
 * Requirement 21.8: a reply of "stop by the office" or "ok" plans nothing.
 */
export function recordInboundOptOut(
  fromPhoneValue: string,
  messageText: string,
  context: SuppressionContext,
): InboundOptOutResult {
  const { normalizedValue } = normalizeSuppressionValue('sms', fromPhoneValue);
  const keyword = matchesOptOutKeyword(messageText);
  if (keyword === null) {
    return { suppressed: false, keyword: null, normalizedValue, skipped: 'no_keyword_match', rejection: null };
  }

  const hasStoredContact = context.contacts.some(
    (contact) => contact.channel === 'phone' && contact.normalized_value === normalizedValue,
  );
  if (!hasStoredContact) {
    return { suppressed: false, keyword, normalizedValue, skipped: 'no_matching_contact', rejection: null };
  }

  const result = suppressChannel(
    'sms',
    normalizedValue,
    INBOUND_MESSAGE_SOURCE,
    null,
    null,
    context,
    keyword,
  );
  if (!result.ok) {
    return { suppressed: false, keyword, normalizedValue, skipped: 'rejected', rejection: result.rejection };
  }
  return { suppressed: true, keyword, normalizedValue, plan: result.plan };
}

// ---------------------------------------------------------------------------
// Clearing a suppression (Req 21.9)
// ---------------------------------------------------------------------------

/** Why a clear was refused. */
export type ClearSuppressionRejectionCode =
  | 'role_not_permitted'
  | 'actor_required'
  | 'value_empty'
  | 'reason_text_empty'
  | 'reason_text_too_long';

export interface ClearSuppressionRejection {
  code: ClearSuppressionRejectionCode;
  message: string;
}

/**
 * The writes one clear produces. As with a suppression, no Communication_Record write appears
 * here: Requirement 21.9 leaves every stored communication unchanged.
 */
export interface ClearSuppressionPlan {
  channel: SuppressionChannel;
  contactChannel: ContactChannel;
  contactFlagColumn: ContactSuppressionColumn;
  normalizedValue: string;
  clearedAt: string;
  clearedBy: string;
  clearReason: string;
  /** True when no active suppression was stored, so only stale contact flags are repaired. */
  alreadyCleared: boolean;
  /** The row to clear, or `null` when nothing was active. */
  suppressionUpdate: SuppressionClearUpdate | null;
  matchedContactIds: string[];
  matchedCaseIds: string[];
  /** The flag writes needed, each setting the channel flag back to `false`. */
  contactUpdates: ContactFlagUpdate[];
  affectedCaseIds: string[];
  events: CancellationEventInsert<SuppressionClearedEventDetail>[];
}

export type ClearSuppressionResult =
  | { ok: true; plan: ClearSuppressionPlan }
  | { ok: false; rejection: ClearSuppressionRejection };

/**
 * Plans the clearing of one channel and value at a customer's request (Req 21.9).
 *
 * Manager_Role only: `manager` and `super_admin` hold it, every other role is refused so the
 * route can answer 403 with nothing written (Req 22.5, 22.6). Reason text is required — at
 * least one non-whitespace character and at most 2,000 characters, measured and stored after
 * trimming, matching the `char_length(btrim(...)) between 1 and 2000` shape the cancellation
 * tables use for note text.
 *
 * The active row is closed rather than deleted, so the suppression stays in the history and the
 * value can be suppressed again later; `cleared_at`, `cleared_by`, and `clear_reason` are the
 * three columns written. Every matching contact row of that channel has its flag returned to
 * `false` and every case that touches gets one audit entry. Where no active suppression exists,
 * the plan is not an error: `suppressionUpdate` is `null`, `alreadyCleared` is true, and any
 * contact flag still set is repaired.
 */
export function clearSuppression(
  channel: SuppressionChannel,
  normalizedValue: string,
  actor: SuppressionActor,
  reason: string | null | undefined,
  context: SuppressionContext,
): ClearSuppressionResult {
  if (!isBroadManagerRole(actor.role)) {
    return {
      ok: false,
      rejection: {
        code: 'role_not_permitted',
        message: 'Clearing a suppressed channel is reserved to a manager.',
      },
    };
  }

  const clearedBy = trimToNull(actor.id);
  if (clearedBy === null) {
    return {
      ok: false,
      rejection: { code: 'actor_required', message: 'A clear must store the clearing profile.' },
    };
  }

  const { normalizedValue: value } = normalizeSuppressionValue(channel, normalizedValue);
  if (value.length === 0) {
    return {
      ok: false,
      rejection: {
        code: 'value_empty',
        message: 'A clear needs a contact value carrying at least one character.',
      },
    };
  }

  const clearReason = (reason ?? '').trim();
  if (clearReason.length === 0) {
    return {
      ok: false,
      rejection: {
        code: 'reason_text_empty',
        message: 'Clearing a suppressed channel requires reason text of at least one non-whitespace character.',
      },
    };
  }
  if (clearReason.length > MAX_CLEAR_REASON_LENGTH) {
    return {
      ok: false,
      rejection: {
        code: 'reason_text_too_long',
        message: `Reason text must be ${MAX_CLEAR_REASON_LENGTH} characters or fewer; this one is ${clearReason.length}.`,
      },
    };
  }

  const contactChannel = contactChannelForSuppressionChannel(channel);
  const column = contactSuppressionColumn(channel);
  const clearedAt = context.now.toISOString();
  const matched = matchContacts(context.contacts, contactChannel, value, column, false);
  const active = findActiveSuppression(context.suppressions ?? [], channel, value);

  const events: CancellationEventInsert<SuppressionClearedEventDetail>[] = matched.updates.map((update) => ({
    case_id: update.case_id,
    actor_id: clearedBy,
    event_type: SUPPRESSION_CLEARED_EVENT_TYPE,
    event_time: clearedAt,
    detail: {
      channel,
      contact_channel: contactChannel,
      contact_id: update.contact_id,
      normalized_value: value,
      clear_reason: clearReason,
    },
  }));

  return {
    ok: true,
    plan: {
      channel,
      contactChannel,
      contactFlagColumn: column,
      normalizedValue: value,
      clearedAt,
      clearedBy,
      clearReason,
      alreadyCleared: active === null,
      suppressionUpdate:
        active === null
          ? null
          : {
              suppression_id: active.id ?? null,
              channel,
              normalized_value: value,
              cleared_at: clearedAt,
              cleared_by: clearedBy,
              clear_reason: clearReason,
            },
      matchedContactIds: matched.contactIds,
      matchedCaseIds: matched.caseIds,
      contactUpdates: matched.updates,
      affectedCaseIds: distinct(matched.updates.map((update) => update.case_id)),
      events,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MatchedContacts {
  /** Every contact row of the channel holding the value, in the order given. */
  contactIds: string[];
  /** Every case holding such a row, in first-seen order. */
  caseIds: string[];
  /** The subset whose flag differs from the target value, one write each. */
  updates: ContactFlagUpdate[];
}

/**
 * Contact rows of one channel holding one normalized value, across every case, and the flag
 * writes that bring them to `targetFlag`.
 *
 * Comparison is exact equality on `normalized_value`: the stored values are already normalized
 * by the importer and the caller's value was normalized on the way in, so there is nothing left
 * to fold. A row already at the target value produces no write, which keeps a repeated
 * recording from appending duplicate entries to the append-only audit timeline. A duplicate
 * contact id in the input is counted once — `unique (case_id, channel, normalized_value)` means
 * one case holds at most one such row per channel.
 */
function matchContacts(
  contacts: readonly SuppressionContact[],
  contactChannel: ContactChannel,
  normalizedValue: string,
  column: ContactSuppressionColumn,
  targetFlag: boolean,
): MatchedContacts {
  const contactIds: string[] = [];
  const caseIds: string[] = [];
  const updates: ContactFlagUpdate[] = [];
  const seenContacts = new Set<string>();
  const seenCases = new Set<string>();

  for (const contact of contacts) {
    if (contact.channel !== contactChannel) continue;
    if (contact.normalized_value !== normalizedValue) continue;
    if (seenContacts.has(contact.id)) continue;

    seenContacts.add(contact.id);
    contactIds.push(contact.id);
    if (!seenCases.has(contact.case_id)) {
      seenCases.add(contact.case_id);
      caseIds.push(contact.case_id);
    }

    const currentFlag = column === 'sms_suppressed' ? contact.sms_suppressed : contact.email_suppressed;
    if (currentFlag !== targetFlag) {
      updates.push({ contact_id: contact.id, case_id: contact.case_id, column, value: targetFlag });
    }
  }

  return { contactIds, caseIds, updates };
}

/** The distinct values of a list, in first-seen order. */
function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Trimmed text, or `null` when it is absent or carries no non-whitespace character. */
function trimToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

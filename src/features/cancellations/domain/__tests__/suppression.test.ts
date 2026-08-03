// src/features/cancellations/domain/__tests__/suppression.test.ts
//
// Feature: policy-follow-up-renewals-cancellations, task 10.4 — suppression tests over the
// pure module `src/features/cancellations/domain/suppression.ts`.
//
// **Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.8, 21.9, 25.2**
//
// The module is pure: no clock, no Supabase client, no provider, no I/O. Its write-path
// functions return *plans* — the row payloads a route or the scheduler writes — so every case
// here drives it with an in-memory world (`makeWorld`) and asserts the returned plan, then
// applies the plan and asserts the world. No mock is used and none is needed; the current time
// arrives as `SuppressionContext.now`, so no fake timer is needed either, and Requirement 25.3
// has nothing to hold against this file. `isBroadManagerRole` is the real implementation over
// the real `APP_ROLES` values, which is the only way the role test is worth anything.
//
// The in-memory store deliberately raises on a second active suppression for one channel and
// value, mirroring `create unique index ... (channel, normalized_value) where cleared_at is
// null`. A regression that stopped returning a null `suppressionInsert` for an already
// suppressed value would therefore fail loudly here rather than only in production.
//
// No property test lives in this file. The design document names exactly three `fast-check`
// properties — CSV raw-row round trip, scheduler idempotency, forbidden tokens in rendered
// output — and none of them is about suppression; the criteria of Requirement 21 are covered
// by example and boundary cases, which is what the testing strategy assigns to this file.
//
// Beyond the coverage list of task 10.4, these cases pin nine decisions of the implementation
// that a later change could reverse while everything else still passed:
//
//  1. suppression is keyed by **normalized value, not contact row**, so `eligibleContacts`
//     checks the active list as well as the flag and a contact row a later import created is
//     excluded from sends before its flag is ever written (Req 21.3, 21.4);
//  2. only a contact row whose flag actually changes produces a `ContactFlagUpdate` and an
//     audit event, so re-recording an applied opt-out plans nothing and appends nothing to the
//     append-only timeline;
//  3. `suppressionInsert` is `null` where an active suppression exists, while a contact row
//     that appeared since the opt-out still gets its flag write;
//  4. a clear with no active suppression is not a rejection: `alreadyCleared`,
//     `suppressionUpdate: null`, stale contact flags still repaired;
//  5. `matchesOptOutKeyword` is whole-message equality after trim and case fold, never a
//     substring search;
//  6. channel isolation in both directions (Req 21.1, 21.2);
//  7. a clear is Manager_Role only, and reason text is measured after trimming;
//  8. neither plan carries a Communication_Record write of any kind (Req 21.9);
//  9. an inbound opt-out enforces **both** guards of Requirement 21.8 — keyword equality and a
//     stored phone contact holding that value.

import { describe, expect, it } from 'vitest';

import { APP_ROLES, isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import { normalizeEmailSegment, normalizePhoneSegment } from '../../import/contacts';
import type { ContactChannel } from '../../import/contacts';
import {
  AUTHORIZATION_STATUSES_PERMITTING_CONTACT,
  INBOUND_MESSAGE_SOURCE,
  MAX_CLEAR_REASON_LENGTH,
  OPT_OUT_EVENT_TYPE,
  OPT_OUT_KEYWORDS,
  SUPPRESSION_CHANNELS,
  SUPPRESSION_CLEARED_EVENT_TYPE,
  USER_RECORDED_SOURCE,
  activeSuppressedValues,
  authorizationPermitsContact,
  clearSuppression,
  contactChannelForSuppressionChannel,
  contactExclusionReason,
  contactSuppressionColumn,
  eligibleContacts,
  findActiveSuppression,
  isActiveSuppression,
  isContactFlagSuppressed,
  isEligibleContact,
  isValueSuppressed,
  matchesOptOutKeyword,
  normalizeSuppressionValue,
  recordInboundOptOut,
  suppressChannel,
  suppressionChannelForContactChannel,
} from '../suppression';
import type {
  CancellationEventInsert,
  ClearSuppressionPlan,
  ContactFlagUpdate,
  SuppressChannelPlan,
  SuppressionActor,
  SuppressionChannel,
  SuppressionContact,
  SuppressionContext,
  SuppressionRecord,
  SuppressionSource,
} from '../suppression';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The phone value the importer stored for the customer two cases share. */
const PHONE_VALUE = '+13055550147';
/** The same number as a webhook delivers it, before normalization (Req 21.8). */
const RAW_PHONE_VALUE = '(305) 555-0147';
/** The email value the same two cases share. */
const EMAIL_VALUE = 'ana@example.com';
/** A third case's contact values, which no suppression here touches. */
const OTHER_PHONE_VALUE = '+13055559999';
const OTHER_EMAIL_VALUE = 'luis@example.com';

const RECORDING_PROFILE = 'profile-agent-1';
const MANAGER: SuppressionActor = { id: 'profile-manager-1', role: 'manager' };
const SUPER_ADMIN: SuppressionActor = { id: 'profile-super-admin-1', role: 'super_admin' };

const OPT_OUT_TIME = new Date('2026-03-04T15:30:00.000Z');
const IMPORT_TIME = new Date('2026-03-06T11:00:00.000Z');
const INBOUND_TIME = new Date('2026-03-05T09:15:00.000Z');
const CLEAR_TIME = new Date('2026-03-11T18:00:00.000Z');

/** The two roles holding Manager_Role, and every role that does not (Req 22.5, 22.6). */
const MANAGER_ROLES: readonly AppRole[] = APP_ROLES.filter((role) => isBroadManagerRole(role));
const NON_MANAGER_ROLES: readonly AppRole[] = APP_ROLES.filter((role) => !isBroadManagerRole(role));

function contact(
  id: string,
  caseId: string,
  channel: ContactChannel,
  normalizedValue: string,
  overrides: Partial<SuppressionContact> = {},
): SuppressionContact {
  return {
    id,
    case_id: caseId,
    channel,
    normalized_value: normalizedValue,
    validation_status: 'valid',
    authorization_status: 'Unknown',
    sms_suppressed: false,
    email_suppressed: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory world
// ---------------------------------------------------------------------------

/** A stored `cancellation_suppressions` row, with every column the plans write. */
interface StoredSuppression extends SuppressionRecord {
  id: string;
  source: SuppressionSource;
  suppressed_at: string;
  actor_id: string | null;
  reason: string | null;
  cleared_at: string | null;
  cleared_by: string | null;
  clear_reason: string | null;
}

/** The three send paths Requirements 21.3 and 21.4 name together. */
type SendTrigger = 'automatic_touchpoint' | 'send_reminder_now' | 'retry_failed_communication';

/** A stored `cancellation_communications` row. Nothing in the module may create one. */
interface StoredCommunication {
  id: string;
  case_id: string;
  contact_id: string;
  channel: SuppressionChannel;
  touchpoint: number;
  delivery_result: 'Sent' | 'Failed';
  trigger: SendTrigger;
}

interface World {
  contacts: SuppressionContact[];
  suppressions: StoredSuppression[];
  communications: StoredCommunication[];
  events: CancellationEventInsert<unknown>[];
}

/**
 * Two cases holding one shared phone value and one shared email value, plus a third case whose
 * contacts share nothing — the shape Requirements 21.1 and 21.2 are written about.
 */
function makeWorld(): World {
  return {
    contacts: [
      contact('contact-a-phone', 'case-a', 'phone', PHONE_VALUE),
      contact('contact-a-email', 'case-a', 'email', EMAIL_VALUE),
      contact('contact-b-phone', 'case-b', 'phone', PHONE_VALUE),
      contact('contact-b-email', 'case-b', 'email', EMAIL_VALUE),
      contact('contact-c-phone', 'case-c', 'phone', OTHER_PHONE_VALUE),
      contact('contact-c-email', 'case-c', 'email', OTHER_EMAIL_VALUE),
    ],
    suppressions: [],
    communications: [],
    events: [],
  };
}

function contextFor(world: World, now: Date): SuppressionContext {
  return { now, contacts: world.contacts, suppressions: world.suppressions };
}

function applyContactUpdates(world: World, updates: readonly ContactFlagUpdate[]): void {
  for (const update of updates) {
    const row = world.contacts.find((candidate) => candidate.id === update.contact_id);
    if (row === undefined) throw new Error(`plan named an absent contact row ${update.contact_id}`);
    if (row.case_id !== update.case_id) throw new Error(`plan named the wrong case for ${update.contact_id}`);
    if (update.column === 'sms_suppressed') row.sms_suppressed = update.value;
    else row.email_suppressed = update.value;
  }
}

/**
 * Writes a suppression plan into the world. The insert is guarded exactly as the partial unique
 * index guards it, so a plan that tried to insert a second active row for one channel and value
 * raises here instead of passing.
 */
function applySuppressPlan(world: World, plan: SuppressChannelPlan): void {
  const insert = plan.suppressionInsert;
  if (insert !== null) {
    if (findActiveSuppression(world.suppressions, insert.channel, insert.normalized_value) !== null) {
      throw new Error('23505 duplicate key value violates unique index on (channel, normalized_value)');
    }
    world.suppressions.push({
      id: `suppression-${world.suppressions.length + 1}`,
      channel: insert.channel,
      normalized_value: insert.normalized_value,
      source: insert.source,
      suppressed_at: insert.suppressed_at,
      actor_id: insert.actor_id,
      reason: insert.reason,
      cleared_at: null,
      cleared_by: null,
      clear_reason: null,
    });
  }
  applyContactUpdates(world, plan.contactUpdates);
  world.events.push(...plan.events);
}

/** Writes a clear plan into the world. A cleared row is closed, never deleted (Req 21.9). */
function applyClearPlan(world: World, plan: ClearSuppressionPlan): void {
  const update = plan.suppressionUpdate;
  if (update !== null) {
    const row = world.suppressions.find(
      (candidate) =>
        candidate.channel === update.channel &&
        candidate.normalized_value === update.normalized_value &&
        isActiveSuppression(candidate),
    );
    if (row === undefined) throw new Error('clear plan matched no active suppression row');
    row.cleared_at = update.cleared_at;
    row.cleared_by = update.cleared_by;
    row.clear_reason = update.clear_reason;
  }
  applyContactUpdates(world, plan.contactUpdates);
  world.events.push(...plan.events);
}

/**
 * One send attempt on one channel of one case, gated only by `eligibleContacts` — the gate the
 * scheduler and the Send Reminder Now route share. A Communication_Record is created for each
 * recipient the gate returns, so a suppressed value showing up here is exactly the failure
 * Requirements 21.3 and 21.4 forbid.
 */
function attemptSend(
  world: World,
  channel: SuppressionChannel,
  caseId: string,
  touchpoint: number,
  trigger: SendTrigger,
): StoredCommunication[] {
  const caseContacts = world.contacts.filter((row) => row.case_id === caseId);
  const created = eligibleContacts(caseContacts, world.suppressions, channel).map((row, index) => ({
    id: `communication-${world.communications.length + index + 1}`,
    case_id: caseId,
    contact_id: row.id,
    channel,
    touchpoint,
    delivery_result: 'Sent' as const,
    trigger,
  }));
  world.communications.push(...created);
  return created;
}

/** Retry Failed Communication: every stored failure re-checked against the same gate. */
function retryFailedCommunications(world: World, channel: SuppressionChannel): StoredCommunication[] {
  const failed = world.communications.filter(
    (row) => row.channel === channel && row.delivery_result === 'Failed',
  );
  const created: StoredCommunication[] = [];
  for (const row of failed) {
    const target = world.contacts.find((candidate) => candidate.id === row.contact_id);
    if (target === undefined) continue;
    if (!isEligibleContact(target, world.suppressions, channel)) continue;
    created.push({
      id: `communication-${world.communications.length + created.length + 1}`,
      case_id: row.case_id,
      contact_id: row.contact_id,
      channel,
      touchpoint: row.touchpoint,
      delivery_result: 'Sent',
      trigger: 'retry_failed_communication',
    });
  }
  world.communications.push(...created);
  return created;
}

function flagsOf(world: World, contactId: string): { sms: boolean; email: boolean } {
  const row = world.contacts.find((candidate) => candidate.id === contactId);
  if (row === undefined) throw new Error(`no contact row ${contactId}`);
  return { sms: row.sms_suppressed, email: row.email_suppressed };
}

/** Fails the test rather than narrowing by hand, so a rejection reports its own code. */
function planOfSuppress(
  result: ReturnType<typeof suppressChannel>,
): SuppressChannelPlan {
  if (!result.ok) throw new Error(`expected a suppression plan, got ${result.rejection.code}`);
  return result.plan;
}

function planOfClear(result: ReturnType<typeof clearSuppression>): ClearSuppressionPlan {
  if (!result.ok) throw new Error(`expected a clear plan, got ${result.rejection.code}`);
  return result.plan;
}

/** Records a user opt-out on the world and returns the plan that was applied. */
function recordUserOptOut(
  world: World,
  channel: SuppressionChannel,
  value: string,
  reason: string | null = 'Customer asked us to stop texting.',
  now: Date = OPT_OUT_TIME,
): SuppressChannelPlan {
  const plan = planOfSuppress(
    suppressChannel(channel, value, USER_RECORDED_SOURCE, RECORDING_PROFILE, reason, contextFor(world, now)),
  );
  applySuppressPlan(world, plan);
  return plan;
}

// ---------------------------------------------------------------------------
// Channel vocabulary and constants
// ---------------------------------------------------------------------------

describe('channel vocabulary mapping', () => {
  it('suppresses a phone contact on the sms channel and an email contact on email', () => {
    expect(suppressionChannelForContactChannel('phone')).toBe('sms');
    expect(suppressionChannelForContactChannel('email')).toBe('email');
    expect(contactChannelForSuppressionChannel('sms')).toBe('phone');
    expect(contactChannelForSuppressionChannel('email')).toBe('email');
  });

  it('round-trips both vocabularies', () => {
    for (const channel of SUPPRESSION_CHANNELS) {
      expect(suppressionChannelForContactChannel(contactChannelForSuppressionChannel(channel))).toBe(channel);
    }
    for (const channel of ['phone', 'email'] as const) {
      expect(contactChannelForSuppressionChannel(suppressionChannelForContactChannel(channel))).toBe(channel);
    }
  });

  it('maps each suppression channel to its mirroring contact column', () => {
    expect(contactSuppressionColumn('sms')).toBe('sms_suppressed');
    expect(contactSuppressionColumn('email')).toBe('email_suppressed');
  });
});

describe('suppression constants', () => {
  it('holds the six keywords of Requirement 21.8 in upper case', () => {
    expect([...OPT_OUT_KEYWORDS]).toEqual(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
  });

  it('holds the two sources, the two event types, and the 2,000 character clear reason bound', () => {
    expect(USER_RECORDED_SOURCE).toBe('user-recorded');
    expect(INBOUND_MESSAGE_SOURCE).toBe('customer inbound message');
    expect(OPT_OUT_EVENT_TYPE).toBe('contact_opt_out_recorded');
    expect(SUPPRESSION_CLEARED_EVENT_TYPE).toBe('contact_suppression_cleared');
    expect(MAX_CLEAR_REASON_LENGTH).toBe(2000);
  });

  it('permits contact for Authorized and Unknown only', () => {
    expect([...AUTHORIZATION_STATUSES_PERMITTING_CONTACT]).toEqual(['Authorized', 'Unknown']);
  });
});

// ---------------------------------------------------------------------------
// Value normalization (Req 10.4, 10.5, 21.8)
// ---------------------------------------------------------------------------

describe('normalizeSuppressionValue (Req 10.4, 10.5, 21.8)', () => {
  // The join between an inbound webhook and the stored rows. If these two ever diverge, every
  // inbound opt-out silently matches nothing, so the assertion is against the importer's own
  // normalizer rather than against a hand-written literal.
  it('reduces a raw inbound phone string to the exact value the importer stored', () => {
    const result = normalizeSuppressionValue('sms', RAW_PHONE_VALUE);

    expect(result).toEqual({ normalizedValue: PHONE_VALUE, isValid: true });
    expect(result.normalizedValue).toBe(normalizePhoneSegment(RAW_PHONE_VALUE).normalizedValue);
  });

  it.each([
    ['ten digits', '3055550147'],
    ['eleven digits leading one', '13055550147'],
    ['already E.164', '+13055550147'],
    ['spaces and punctuation', ' (305) 555-0147 '],
    ['dotted', '305.555.0147'],
  ])('normalizes a %s phone form to the stored E.164 value', (_label, raw) => {
    expect(normalizeSuppressionValue('sms', raw)).toEqual({ normalizedValue: PHONE_VALUE, isValid: true });
  });

  it('is a no-op on a value read straight off a contact row', () => {
    expect(normalizeSuppressionValue('sms', PHONE_VALUE).normalizedValue).toBe(PHONE_VALUE);
    expect(normalizeSuppressionValue('email', EMAIL_VALUE).normalizedValue).toBe(EMAIL_VALUE);
  });

  it('trims and lower-cases an email value with the importer rules', () => {
    const result = normalizeSuppressionValue('email', '  Ana@Example.COM  ');

    expect(result).toEqual({ normalizedValue: EMAIL_VALUE, isValid: true });
    expect(result.normalizedValue).toBe(normalizeEmailSegment('  Ana@Example.COM  ').normalizedValue);
  });

  it('returns an unmatched phone segment trimmed and invalid, stably (Req 10.11)', () => {
    const first = normalizeSuppressionValue('sms', '  555-0147  ');

    expect(first).toEqual({ normalizedValue: '555-0147', isValid: false });
    expect(normalizeSuppressionValue('sms', first.normalizedValue)).toEqual(first);
  });

  it('returns an unmatched email value lower-cased and invalid (Req 10.12)', () => {
    expect(normalizeSuppressionValue('email', ' NotAnEmail ')).toEqual({
      normalizedValue: 'notanemail',
      isValid: false,
    });
  });

  it('reduces an empty or whitespace value to zero characters', () => {
    expect(normalizeSuppressionValue('sms', '   ')).toEqual({ normalizedValue: '', isValid: false });
    expect(normalizeSuppressionValue('email', '')).toEqual({ normalizedValue: '', isValid: false });
  });
});

// ---------------------------------------------------------------------------
// Opt-out keywords (Req 21.8)
// ---------------------------------------------------------------------------

describe('matchesOptOutKeyword (Req 21.8)', () => {
  it.each(OPT_OUT_KEYWORDS)('matches %s exactly, lower-cased, and padded', (keyword) => {
    expect(matchesOptOutKeyword(keyword)).toBe(keyword);
    expect(matchesOptOutKeyword(keyword.toLowerCase())).toBe(keyword);
    expect(matchesOptOutKeyword(`  ${keyword.toLowerCase()}  `)).toBe(keyword);
  });

  it('matches a mixed-case keyword after folding', () => {
    expect(matchesOptOutKeyword('Stop')).toBe('STOP');
    expect(matchesOptOutKeyword('sToPaLl')).toBe('STOPALL');
    expect(matchesOptOutKeyword(' stop ')).toBe('STOP');
  });

  it('removes non-breaking whitespace a phone keyboard may add', () => {
    expect(matchesOptOutKeyword('\u00a0STOP\u00a0')).toBe('STOP');
    expect(matchesOptOutKeyword('\r\nquit\t')).toBe('QUIT');
  });

  // Whole-message equality, not a substring search. A customer writing about stopping by is
  // not opting out, and reading this as `includes` would suppress a paying customer's texts.
  it.each([
    ['a sentence carrying the word', 'Please stop by tomorrow'],
    ['a keyword with trailing punctuation', 'stop.'],
    ['a keyword inside a longer word', 'stopwatch'],
    ['two keywords', 'STOP STOP'],
    ['a keyword with a following word', 'cancel my policy'],
    ['an unrelated reply', 'ok'],
    ['whitespace only', '   '],
    ['zero characters', ''],
  ])('does not match %s', (_label, text) => {
    expect(matchesOptOutKeyword(text)).toBeNull();
  });

  it('treats an absent message as no match', () => {
    expect(matchesOptOutKeyword(null)).toBeNull();
    expect(matchesOptOutKeyword(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reading the active list
// ---------------------------------------------------------------------------

describe('active suppression list readers', () => {
  const active: SuppressionRecord = { id: 'sup-1', channel: 'sms', normalized_value: PHONE_VALUE };
  const activeExplicitNull: SuppressionRecord = {
    id: 'sup-2',
    channel: 'email',
    normalized_value: EMAIL_VALUE,
    cleared_at: null,
  };
  const cleared: SuppressionRecord = {
    id: 'sup-3',
    channel: 'sms',
    normalized_value: OTHER_PHONE_VALUE,
    cleared_at: '2026-02-01T00:00:00.000Z',
  };
  const rows = [active, activeExplicitNull, cleared];

  it('counts an absent and an explicitly null cleared_at as active, a timestamp as history', () => {
    expect(isActiveSuppression(active)).toBe(true);
    expect(isActiveSuppression(activeExplicitNull)).toBe(true);
    expect(isActiveSuppression(cleared)).toBe(false);
  });

  it('finds the active row for a channel and value and ignores the other channel', () => {
    expect(findActiveSuppression(rows, 'sms', PHONE_VALUE)).toBe(active);
    expect(findActiveSuppression(rows, 'email', PHONE_VALUE)).toBeNull();
    expect(findActiveSuppression(rows, 'sms', OTHER_PHONE_VALUE)).toBeNull();
  });

  it('collects the actively suppressed values of one channel', () => {
    expect([...activeSuppressedValues(rows, 'sms')]).toEqual([PHONE_VALUE]);
    expect([...activeSuppressedValues(rows, 'email')]).toEqual([EMAIL_VALUE]);
  });

  it('reports a value suppressed only on the channel that carries the active row', () => {
    expect(isValueSuppressed(PHONE_VALUE, rows, 'sms')).toBe(true);
    expect(isValueSuppressed(PHONE_VALUE, rows, 'email')).toBe(false);
    expect(isValueSuppressed(OTHER_PHONE_VALUE, rows, 'sms')).toBe(false);
    expect(isValueSuppressed(EMAIL_VALUE, [], 'email')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-channel eligibility (Req 10.10, 21.3, 21.4)
// ---------------------------------------------------------------------------

describe('contact eligibility (Req 10.10)', () => {
  it('permits contact for Authorized and Unknown and prohibits it for Not Authorized', () => {
    expect(authorizationPermitsContact('Authorized')).toBe(true);
    expect(authorizationPermitsContact('Unknown')).toBe(true);
    expect(authorizationPermitsContact('Not Authorized')).toBe(false);
  });

  it('reads the contact flag of the channel asked about, not the other one', () => {
    const smsOnly = contact('c1', 'case-a', 'phone', PHONE_VALUE, { sms_suppressed: true });
    const emailOnly = contact('c2', 'case-a', 'email', EMAIL_VALUE, { email_suppressed: true });

    expect(isContactFlagSuppressed(smsOnly, 'sms')).toBe(true);
    expect(isContactFlagSuppressed(smsOnly, 'email')).toBe(false);
    expect(isContactFlagSuppressed(emailOnly, 'email')).toBe(true);
    expect(isContactFlagSuppressed(emailOnly, 'sms')).toBe(false);
  });

  it('returns null for a row that meets every clause', () => {
    const row = contact('c1', 'case-a', 'phone', PHONE_VALUE, { authorization_status: 'Authorized' });

    expect(contactExclusionReason(row, [], 'sms')).toBeNull();
    expect(isEligibleContact(row, [], 'sms')).toBe(true);
  });

  it.each([
    ['channel_mismatch', contact('c1', 'case-a', 'email', EMAIL_VALUE), 'sms'],
    [
      'validation_invalid',
      contact('c2', 'case-a', 'phone', '555-0147', { validation_status: 'invalid' }),
      'sms',
    ],
    [
      'authorization_not_permitted',
      contact('c3', 'case-a', 'phone', PHONE_VALUE, { authorization_status: 'Not Authorized' }),
      'sms',
    ],
    ['contact_flag_suppressed', contact('c4', 'case-a', 'phone', PHONE_VALUE, { sms_suppressed: true }), 'sms'],
  ] as const)('excludes a row for %s', (reason, row, channel) => {
    expect(contactExclusionReason(row, [], channel)).toBe(reason);
    expect(isEligibleContact(row, [], channel)).toBe(false);
  });

  it('excludes a row for value_suppressed when only the active list carries the value', () => {
    const row = contact('c1', 'case-a', 'phone', PHONE_VALUE);
    const rows: SuppressionRecord[] = [{ channel: 'sms', normalized_value: PHONE_VALUE }];

    expect(row.sms_suppressed).toBe(false);
    expect(contactExclusionReason(row, rows, 'sms')).toBe('value_suppressed');
  });

  it('reports the first reason when a row breaks several rules', () => {
    const row = contact('c1', 'case-a', 'phone', '555-0147', {
      validation_status: 'invalid',
      authorization_status: 'Not Authorized',
      sms_suppressed: true,
    });

    expect(contactExclusionReason(row, [], 'sms')).toBe('validation_invalid');
  });

  it('keeps the recipients of one channel in the order given, with id and case intact', () => {
    const world = makeWorld();
    world.contacts.push(
      contact('contact-d-phone', 'case-d', 'phone', '555-0147', { validation_status: 'invalid' }),
      contact('contact-e-phone', 'case-e', 'phone', OTHER_PHONE_VALUE, { authorization_status: 'Not Authorized' }),
      contact('contact-f-phone', 'case-f', 'phone', OTHER_PHONE_VALUE, { sms_suppressed: true }),
    );

    const smsRecipients = eligibleContacts(world.contacts, world.suppressions, 'sms');
    const emailRecipients = eligibleContacts(world.contacts, world.suppressions, 'email');

    expect(smsRecipients.map((row) => row.id)).toEqual([
      'contact-a-phone',
      'contact-b-phone',
      'contact-c-phone',
    ]);
    expect(smsRecipients.map((row) => row.case_id)).toEqual(['case-a', 'case-b', 'case-c']);
    expect(emailRecipients.map((row) => row.id)).toEqual([
      'contact-a-email',
      'contact-b-email',
      'contact-c-email',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Recording an opt-out (Req 21.1, 21.2)
// ---------------------------------------------------------------------------

describe('suppressChannel: SMS opt-out across every case holding the value (Req 21.1)', () => {
  it('sets the sms flag on both cases, stores time, profile, and source, and audits both cases', () => {
    const world = makeWorld();
    const plan = recordUserOptOut(world, 'sms', PHONE_VALUE);

    expect(plan.channel).toBe('sms');
    expect(plan.contactChannel).toBe('phone');
    expect(plan.contactFlagColumn).toBe('sms_suppressed');
    expect(plan.normalizedValue).toBe(PHONE_VALUE);
    expect(plan.valueIsValid).toBe(true);
    expect(plan.alreadyActive).toBe(false);
    expect(plan.matchedContactIds).toEqual(['contact-a-phone', 'contact-b-phone']);
    expect(plan.matchedCaseIds).toEqual(['case-a', 'case-b']);
    expect(plan.affectedCaseIds).toEqual(['case-a', 'case-b']);
    expect(plan.suppressedAt).toBe(OPT_OUT_TIME.toISOString());
    expect(plan.suppressionInsert).toEqual({
      channel: 'sms',
      normalized_value: PHONE_VALUE,
      source: USER_RECORDED_SOURCE,
      suppressed_at: OPT_OUT_TIME.toISOString(),
      actor_id: RECORDING_PROFILE,
      reason: 'Customer asked us to stop texting.',
    });
    expect(plan.contactUpdates).toEqual([
      { contact_id: 'contact-a-phone', case_id: 'case-a', column: 'sms_suppressed', value: true },
      { contact_id: 'contact-b-phone', case_id: 'case-b', column: 'sms_suppressed', value: true },
    ]);

    expect(flagsOf(world, 'contact-a-phone')).toEqual({ sms: true, email: false });
    expect(flagsOf(world, 'contact-b-phone')).toEqual({ sms: true, email: false });
    expect(world.suppressions).toHaveLength(1);
    expect(world.suppressions[0].cleared_at).toBeNull();
  });

  it('adds one audit entry per affected case carrying that case\u2019s contact row', () => {
    const world = makeWorld();
    const plan = recordUserOptOut(world, 'sms', PHONE_VALUE);

    expect(plan.events).toEqual([
      {
        case_id: 'case-a',
        actor_id: RECORDING_PROFILE,
        event_type: OPT_OUT_EVENT_TYPE,
        event_time: OPT_OUT_TIME.toISOString(),
        detail: {
          channel: 'sms',
          contact_channel: 'phone',
          contact_id: 'contact-a-phone',
          normalized_value: PHONE_VALUE,
          source: USER_RECORDED_SOURCE,
          reason: 'Customer asked us to stop texting.',
          keyword: null,
        },
      },
      {
        case_id: 'case-b',
        actor_id: RECORDING_PROFILE,
        event_type: OPT_OUT_EVENT_TYPE,
        event_time: OPT_OUT_TIME.toISOString(),
        detail: {
          channel: 'sms',
          contact_channel: 'phone',
          contact_id: 'contact-b-phone',
          normalized_value: PHONE_VALUE,
          source: USER_RECORDED_SOURCE,
          reason: 'Customer asked us to stop texting.',
          keyword: null,
        },
      },
    ]);
    expect(world.events).toHaveLength(2);
  });

  it('leaves every email flag and the email suppression list untouched', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);

    for (const row of world.contacts) {
      expect(row.email_suppressed).toBe(false);
    }
    expect(activeSuppressedValues(world.suppressions, 'email').size).toBe(0);
    expect(isValueSuppressed(EMAIL_VALUE, world.suppressions, 'email')).toBe(false);
    expect(eligibleContacts(world.contacts, world.suppressions, 'email').map((row) => row.id)).toEqual([
      'contact-a-email',
      'contact-b-email',
      'contact-c-email',
    ]);
  });

  it('touches no case whose contacts hold a different value', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);

    expect(flagsOf(world, 'contact-c-phone')).toEqual({ sms: false, email: false });
    expect(isEligibleContact(world.contacts[4], world.suppressions, 'sms')).toBe(true);
  });

  it('accepts a raw phone string and matches the rows the importer stored', () => {
    const world = makeWorld();
    const plan = recordUserOptOut(world, 'sms', RAW_PHONE_VALUE);

    expect(plan.normalizedValue).toBe(PHONE_VALUE);
    expect(plan.matchedContactIds).toEqual(['contact-a-phone', 'contact-b-phone']);
  });
});

describe('suppressChannel: email opt-out across every case holding the value (Req 21.2)', () => {
  it('sets the email flag on both cases and leaves every sms flag and sms suppression alone', () => {
    const world = makeWorld();
    const plan = recordUserOptOut(world, 'email', ' Ana@Example.com ', 'Customer asked for no more email.');

    expect(plan.channel).toBe('email');
    expect(plan.contactChannel).toBe('email');
    expect(plan.contactFlagColumn).toBe('email_suppressed');
    expect(plan.normalizedValue).toBe(EMAIL_VALUE);
    expect(plan.matchedContactIds).toEqual(['contact-a-email', 'contact-b-email']);
    expect(plan.affectedCaseIds).toEqual(['case-a', 'case-b']);
    expect(plan.contactUpdates.every((update) => update.column === 'email_suppressed')).toBe(true);

    expect(flagsOf(world, 'contact-a-email')).toEqual({ sms: false, email: true });
    expect(flagsOf(world, 'contact-b-email')).toEqual({ sms: false, email: true });
    for (const row of world.contacts) {
      expect(row.sms_suppressed).toBe(false);
    }
    expect(activeSuppressedValues(world.suppressions, 'sms').size).toBe(0);
    expect(eligibleContacts(world.contacts, world.suppressions, 'sms').map((row) => row.id)).toEqual([
      'contact-a-phone',
      'contact-b-phone',
      'contact-c-phone',
    ]);
  });

  it('audits every affected case with the email channel detail', () => {
    const world = makeWorld();
    const plan = recordUserOptOut(world, 'email', EMAIL_VALUE, 'Customer asked for no more email.');

    expect(plan.events.map((event) => event.case_id)).toEqual(['case-a', 'case-b']);
    for (const event of plan.events) {
      expect(event.event_type).toBe(OPT_OUT_EVENT_TYPE);
      expect(event.detail.channel).toBe('email');
      expect(event.detail.contact_channel).toBe('email');
      expect(event.detail.keyword).toBeNull();
    }
  });
});

describe('suppressChannel: repeated recording (append-only timeline)', () => {
  it('plans nothing and appends nothing when the opt-out is already fully applied', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);
    const eventCountAfterFirst = world.events.length;

    const second = planOfSuppress(
      suppressChannel(
        'sms',
        PHONE_VALUE,
        USER_RECORDED_SOURCE,
        RECORDING_PROFILE,
        'Customer called again.',
        contextFor(world, new Date('2026-03-07T12:00:00.000Z')),
      ),
    );

    expect(second.alreadyActive).toBe(true);
    expect(second.suppressionInsert).toBeNull();
    expect(second.contactUpdates).toEqual([]);
    expect(second.affectedCaseIds).toEqual([]);
    expect(second.events).toEqual([]);
    // The matched rows are still reported; it is the *writes* that are empty.
    expect(second.matchedContactIds).toEqual(['contact-a-phone', 'contact-b-phone']);
    expect(second.matchedCaseIds).toEqual(['case-a', 'case-b']);

    applySuppressPlan(world, second);

    expect(world.events).toHaveLength(eventCountAfterFirst);
    expect(world.suppressions).toHaveLength(1);
  });

  it('writes no second active row while still flagging a contact row a later import created', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);

    // An import that completed after the opt-out creates a new case holding the same phone
    // value, with both flags cleared as Requirement 10.13 requires on creation.
    world.contacts.push(contact('contact-d-phone', 'case-d', 'phone', PHONE_VALUE));

    const second = planOfSuppress(
      suppressChannel(
        'sms',
        PHONE_VALUE,
        USER_RECORDED_SOURCE,
        RECORDING_PROFILE,
        null,
        contextFor(world, IMPORT_TIME),
      ),
    );

    expect(second.alreadyActive).toBe(true);
    expect(second.suppressionInsert).toBeNull();
    expect(second.contactUpdates).toEqual([
      { contact_id: 'contact-d-phone', case_id: 'case-d', column: 'sms_suppressed', value: true },
    ]);
    expect(second.affectedCaseIds).toEqual(['case-d']);
    expect(second.events.map((event) => event.case_id)).toEqual(['case-d']);

    applySuppressPlan(world, second);

    expect(world.suppressions).toHaveLength(1);
    expect(flagsOf(world, 'contact-d-phone')).toEqual({ sms: true, email: false });
  });
});

describe('suppressChannel: rejections and stored values', () => {
  it('refuses a value carrying zero characters', () => {
    const world = makeWorld();
    const result = suppressChannel(
      'sms',
      '   ',
      USER_RECORDED_SOURCE,
      RECORDING_PROFILE,
      null,
      contextFor(world, OPT_OUT_TIME),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.rejection.code).toBe('value_empty');
    expect(world.suppressions).toEqual([]);
    expect(world.events).toEqual([]);
  });

  it.each([
    ['null', null],
    ['whitespace', '   '],
  ])('refuses a user-recorded opt-out whose recording profile is %s (Req 21.1, 21.2)', (_label, actorId) => {
    const world = makeWorld();
    const result = suppressChannel(
      'sms',
      PHONE_VALUE,
      USER_RECORDED_SOURCE,
      actorId,
      null,
      contextFor(world, OPT_OUT_TIME),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.rejection.code).toBe('actor_required');
    expect(world.contacts.every((row) => !row.sms_suppressed)).toBe(true);
  });

  it('stores no actor for a customer inbound message even when one is passed (Req 21.8)', () => {
    const world = makeWorld();
    const plan = planOfSuppress(
      suppressChannel(
        'sms',
        PHONE_VALUE,
        INBOUND_MESSAGE_SOURCE,
        RECORDING_PROFILE,
        null,
        contextFor(world, INBOUND_TIME),
        'STOP',
      ),
    );

    expect(plan.actorId).toBeNull();
    expect(plan.suppressionInsert?.actor_id).toBeNull();
    expect(plan.events.every((event) => event.actor_id === null)).toBe(true);
  });

  it('stores whitespace-only reason text as absent', () => {
    const world = makeWorld();
    const plan = recordUserOptOut(world, 'sms', PHONE_VALUE, '   ');

    expect(plan.reason).toBeNull();
    expect(plan.suppressionInsert?.reason).toBeNull();
  });

  it('still plans a suppression for a retained invalid contact value (Req 10.11)', () => {
    const world = makeWorld();
    world.contacts.push(
      contact('contact-g-phone', 'case-g', 'phone', '555-0147', { validation_status: 'invalid' }),
    );

    const plan = recordUserOptOut(world, 'sms', '555-0147', null);

    expect(plan.valueIsValid).toBe(false);
    expect(plan.matchedContactIds).toEqual(['contact-g-phone']);
    expect(flagsOf(world, 'contact-g-phone')).toEqual({ sms: true, email: false });
  });
});

// ---------------------------------------------------------------------------
// Zero sends for a suppressed value (Req 21.3, 21.4)
// ---------------------------------------------------------------------------

describe('a suppressed value sends nothing on any path (Req 21.3, 21.4)', () => {
  it('sends zero SMS and creates zero Communication_Record rows for automatic touchpoints', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);

    const sentA = attemptSend(world, 'sms', 'case-a', 15, 'automatic_touchpoint');
    const sentB = attemptSend(world, 'sms', 'case-b', 10, 'automatic_touchpoint');

    expect(sentA).toEqual([]);
    expect(sentB).toEqual([]);
    expect(world.communications).toEqual([]);
  });

  it('sends zero SMS for Send Reminder Now (Req 17.5)', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);

    expect(attemptSend(world, 'sms', 'case-a', 5, 'send_reminder_now')).toEqual([]);
    expect(world.communications).toEqual([]);
  });

  it('sends zero SMS for Retry Failed Communication and leaves the stored failure unchanged (Req 17.6)', () => {
    const world = makeWorld();
    world.communications.push({
      id: 'communication-1',
      case_id: 'case-a',
      contact_id: 'contact-a-phone',
      channel: 'sms',
      touchpoint: 15,
      delivery_result: 'Failed',
      trigger: 'automatic_touchpoint',
    });
    const storedBefore = structuredClone(world.communications);

    recordUserOptOut(world, 'sms', PHONE_VALUE);

    expect(retryFailedCommunications(world, 'sms')).toEqual([]);
    expect(world.communications).toEqual(storedBefore);
  });

  it('still sends email to the same customer while SMS is suppressed', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);

    const emailed = attemptSend(world, 'email', 'case-a', 15, 'automatic_touchpoint');

    expect(emailed.map((row) => row.contact_id)).toEqual(['contact-a-email']);
  });

  it('sends zero email and creates zero rows on every path once the email value is suppressed', () => {
    const world = makeWorld();
    world.communications.push({
      id: 'communication-1',
      case_id: 'case-b',
      contact_id: 'contact-b-email',
      channel: 'email',
      touchpoint: 10,
      delivery_result: 'Failed',
      trigger: 'automatic_touchpoint',
    });
    const storedBefore = structuredClone(world.communications);

    recordUserOptOut(world, 'email', EMAIL_VALUE, 'Customer asked for no more email.');

    expect(attemptSend(world, 'email', 'case-a', 15, 'automatic_touchpoint')).toEqual([]);
    expect(attemptSend(world, 'email', 'case-b', 5, 'send_reminder_now')).toEqual([]);
    expect(retryFailedCommunications(world, 'email')).toEqual([]);
    expect(world.communications).toEqual(storedBefore);
    // SMS to the same customer is unaffected.
    expect(attemptSend(world, 'sms', 'case-a', 15, 'automatic_touchpoint').map((row) => row.contact_id)).toEqual([
      'contact-a-phone',
    ]);
  });

  // Requirement 21.3 and 21.4 both name contact rows created by an import that completed after
  // the suppression time. The row's own flag is cleared on creation, so only the value match can
  // exclude it, and it must be excluded before any flag write ever reaches it.
  it('excludes a contact row created by a later import before its flag is written', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);

    const laterRow = contact('contact-d-phone', 'case-d', 'phone', PHONE_VALUE);
    world.contacts.push(laterRow);

    expect(laterRow.sms_suppressed).toBe(false);
    expect(contactExclusionReason(laterRow, world.suppressions, 'sms')).toBe('value_suppressed');
    expect(isEligibleContact(laterRow, world.suppressions, 'sms')).toBe(false);
    expect(attemptSend(world, 'sms', 'case-d', 15, 'automatic_touchpoint')).toEqual([]);
    expect(attemptSend(world, 'sms', 'case-d', 15, 'send_reminder_now')).toEqual([]);
    expect(world.communications).toEqual([]);
  });

  it('carries no Communication_Record write in the suppression plan itself', () => {
    const world = makeWorld();
    const plan = recordUserOptOut(world, 'sms', PHONE_VALUE);

    expect(Object.keys(plan).filter((key) => /communication/i.test(key))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Inbound opt-out (Req 21.8)
// ---------------------------------------------------------------------------

describe('recordInboundOptOut (Req 21.8)', () => {
  it('suppresses SMS for a keyword from a stored contact number, with the inbound time and no actor', () => {
    const world = makeWorld();
    const result = recordInboundOptOut(RAW_PHONE_VALUE, 'STOP', contextFor(world, INBOUND_TIME));

    expect(result.suppressed).toBe(true);
    if (!result.suppressed) throw new Error('expected a suppression');
    expect(result.keyword).toBe('STOP');
    expect(result.normalizedValue).toBe(PHONE_VALUE);
    expect(result.plan.source).toBe(INBOUND_MESSAGE_SOURCE);
    expect(result.plan.actorId).toBeNull();
    expect(result.plan.keyword).toBe('STOP');
    expect(result.plan.suppressedAt).toBe(INBOUND_TIME.toISOString());
    expect(result.plan.suppressionInsert).toEqual({
      channel: 'sms',
      normalized_value: PHONE_VALUE,
      source: INBOUND_MESSAGE_SOURCE,
      suppressed_at: INBOUND_TIME.toISOString(),
      actor_id: null,
      reason: null,
    });
    expect(result.plan.affectedCaseIds).toEqual(['case-a', 'case-b']);
    expect(result.plan.events.map((event) => event.detail.keyword)).toEqual(['STOP', 'STOP']);
    expect(result.plan.events.every((event) => event.actor_id === null)).toBe(true);

    applySuppressPlan(world, result.plan);

    expect(flagsOf(world, 'contact-a-phone')).toEqual({ sms: true, email: false });
    expect(flagsOf(world, 'contact-b-phone')).toEqual({ sms: true, email: false });
    expect(attemptSend(world, 'sms', 'case-a', 15, 'automatic_touchpoint')).toEqual([]);
  });

  it.each(OPT_OUT_KEYWORDS)('suppresses SMS for the keyword %s', (keyword) => {
    const world = makeWorld();
    const result = recordInboundOptOut(PHONE_VALUE, ` ${keyword.toLowerCase()} `, contextFor(world, INBOUND_TIME));

    expect(result.suppressed).toBe(true);
    if (!result.suppressed) throw new Error('expected a suppression');
    expect(result.keyword).toBe(keyword);

    applySuppressPlan(world, result.plan);

    expect(isValueSuppressed(PHONE_VALUE, world.suppressions, 'sms')).toBe(true);
  });

  it.each([
    ['a sentence carrying the word', 'Please stop by tomorrow'],
    ['an unrelated reply', 'ok'],
    ['a keyword with punctuation', 'stop!'],
    ['whitespace only', '  '],
  ])('leaves suppression unchanged for %s', (_label, text) => {
    const world = makeWorld();
    const result = recordInboundOptOut(RAW_PHONE_VALUE, text, contextFor(world, INBOUND_TIME));

    expect(result.suppressed).toBe(false);
    if (result.suppressed) throw new Error('expected no suppression');
    expect(result.keyword).toBeNull();
    expect(result.skipped).toBe('no_keyword_match');
    expect(result.normalizedValue).toBe(PHONE_VALUE);

    expect(world.suppressions).toEqual([]);
    expect(world.events).toEqual([]);
    expect(world.contacts.every((row) => !row.sms_suppressed)).toBe(true);
    expect(attemptSend(world, 'sms', 'case-a', 15, 'automatic_touchpoint').map((row) => row.contact_id)).toEqual([
      'contact-a-phone',
    ]);
  });

  // The second guard of Requirement 21.8: the sending number must be the normalized phone value
  // of a stored Contact_Recipient. A keyword from a number the agency holds no row for is not an
  // opt-out for anybody.
  it('stores nothing for a keyword from a number no contact row holds', () => {
    const world = makeWorld();
    const result = recordInboundOptOut('(786) 555-0000', 'STOP', contextFor(world, INBOUND_TIME));

    expect(result.suppressed).toBe(false);
    if (result.suppressed) throw new Error('expected no suppression');
    expect(result.keyword).toBe('STOP');
    expect(result.skipped).toBe('no_matching_contact');
    expect(result.normalizedValue).toBe('+17865550000');
    expect(world.suppressions).toEqual([]);
    expect(world.events).toEqual([]);
    expect(world.contacts.every((row) => !row.sms_suppressed)).toBe(true);
  });

  it('does not treat an email contact holding the value as a stored phone contact', () => {
    const world: World = {
      contacts: [contact('contact-h-email', 'case-h', 'email', EMAIL_VALUE)],
      suppressions: [],
      communications: [],
      events: [],
    };

    const result = recordInboundOptOut(RAW_PHONE_VALUE, 'STOP', contextFor(world, INBOUND_TIME));

    expect(result.suppressed).toBe(false);
    if (result.suppressed) throw new Error('expected no suppression');
    expect(result.skipped).toBe('no_matching_contact');
  });

  it('leaves email suppression untouched when an inbound STOP arrives', () => {
    const world = makeWorld();
    const result = recordInboundOptOut(PHONE_VALUE, 'STOP', contextFor(world, INBOUND_TIME));
    if (!result.suppressed) throw new Error('expected a suppression');
    applySuppressPlan(world, result.plan);

    expect(activeSuppressedValues(world.suppressions, 'email').size).toBe(0);
    expect(world.contacts.every((row) => !row.email_suppressed)).toBe(true);
    expect(attemptSend(world, 'email', 'case-a', 15, 'automatic_touchpoint').map((row) => row.contact_id)).toEqual([
      'contact-a-email',
    ]);
  });

  it('appends nothing on a second identical inbound message', () => {
    const world = makeWorld();
    const first = recordInboundOptOut(PHONE_VALUE, 'STOP', contextFor(world, INBOUND_TIME));
    if (!first.suppressed) throw new Error('expected a suppression');
    applySuppressPlan(world, first.plan);

    const second = recordInboundOptOut(PHONE_VALUE, 'stop', contextFor(world, new Date('2026-03-05T10:00:00.000Z')));
    if (!second.suppressed) throw new Error('expected a suppression');

    expect(second.plan.alreadyActive).toBe(true);
    expect(second.plan.suppressionInsert).toBeNull();
    expect(second.plan.contactUpdates).toEqual([]);
    expect(second.plan.events).toEqual([]);

    applySuppressPlan(world, second.plan);

    expect(world.suppressions).toHaveLength(1);
    expect(world.events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Clearing a suppression (Req 21.9)
// ---------------------------------------------------------------------------

describe('clearSuppression: Manager_Role only (Req 21.9, 22.5, 22.6)', () => {
  it('holds Manager_Role for manager and super_admin only', () => {
    expect([...MANAGER_ROLES]).toEqual(['manager', 'super_admin']);
  });

  it.each(MANAGER_ROLES)('permits %s to clear', (role) => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);

    const result = clearSuppression(
      'sms',
      PHONE_VALUE,
      { id: `profile-${role}`, role },
      'Customer called to ask for texts again.',
      contextFor(world, CLEAR_TIME),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected a plan, got ${result.rejection.code}`);
    expect(result.plan.clearedBy).toBe(`profile-${role}`);
  });

  it.each(NON_MANAGER_ROLES)('refuses %s and plans nothing', (role) => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);
    const suppressionsBefore = structuredClone(world.suppressions);
    const eventsBefore = world.events.length;

    const result = clearSuppression(
      'sms',
      PHONE_VALUE,
      { id: `profile-${role}`, role },
      'Customer called to ask for texts again.',
      contextFor(world, CLEAR_TIME),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.rejection.code).toBe('role_not_permitted');
    expect(world.suppressions).toEqual(suppressionsBefore);
    expect(world.events).toHaveLength(eventsBefore);
    expect(flagsOf(world, 'contact-a-phone')).toEqual({ sms: true, email: false });
    expect(isValueSuppressed(PHONE_VALUE, world.suppressions, 'sms')).toBe(true);
  });
});

describe('clearSuppression: reason text (Req 21.9)', () => {
  function clearWithReason(reason: string | null | undefined) {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);
    return { world, result: clearSuppression('sms', PHONE_VALUE, MANAGER, reason, contextFor(world, CLEAR_TIME)) };
  }

  it.each([
    ['absent', null],
    ['undefined', undefined],
    ['zero characters', ''],
    ['whitespace only', ' \t\r\n '],
  ])('refuses reason text that is %s', (_label, reason) => {
    const { world, result } = clearWithReason(reason);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.rejection.code).toBe('reason_text_empty');
    expect(isValueSuppressed(PHONE_VALUE, world.suppressions, 'sms')).toBe(true);
    expect(flagsOf(world, 'contact-a-phone')).toEqual({ sms: true, email: false });
  });

  it('accepts one non-whitespace character', () => {
    const { result } = clearWithReason('x');

    expect(planOfClear(result).clearReason).toBe('x');
  });

  it('accepts 2,000 characters and stores them trimmed', () => {
    const reason = 'r'.repeat(MAX_CLEAR_REASON_LENGTH);
    const { result } = clearWithReason(`   ${reason}   `);

    expect(planOfClear(result).clearReason).toBe(reason);
    expect(planOfClear(result).clearReason).toHaveLength(MAX_CLEAR_REASON_LENGTH);
  });

  it('refuses 2,001 characters, measured after trimming', () => {
    const { world, result } = clearWithReason(`  ${'r'.repeat(MAX_CLEAR_REASON_LENGTH + 1)}  `);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.rejection.code).toBe('reason_text_too_long');
    expect(result.rejection.message).toContain(String(MAX_CLEAR_REASON_LENGTH + 1));
    expect(isValueSuppressed(PHONE_VALUE, world.suppressions, 'sms')).toBe(true);
  });

  it('refuses a clear whose profile or value is absent', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);

    const noActor = clearSuppression(
      'sms',
      PHONE_VALUE,
      { id: '   ', role: 'manager' },
      'Customer called.',
      contextFor(world, CLEAR_TIME),
    );
    const noValue = clearSuppression('sms', '  ', MANAGER, 'Customer called.', contextFor(world, CLEAR_TIME));

    expect(noActor.ok).toBe(false);
    if (noActor.ok) throw new Error('expected a rejection');
    expect(noActor.rejection.code).toBe('actor_required');
    expect(noValue.ok).toBe(false);
    if (noValue.ok) throw new Error('expected a rejection');
    expect(noValue.rejection.code).toBe('value_empty');
    expect(isValueSuppressed(PHONE_VALUE, world.suppressions, 'sms')).toBe(true);
  });
});

describe('clearSuppression: the writes a clear produces (Req 21.9)', () => {
  it('closes the active row, clears every matching flag, and audits every affected case', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);
    const suppressionId = world.suppressions[0].id;

    const plan = planOfClear(
      clearSuppression('sms', PHONE_VALUE, MANAGER, ' Customer asked for texts again. ', contextFor(world, CLEAR_TIME)),
    );

    expect(plan.alreadyCleared).toBe(false);
    expect(plan.clearedAt).toBe(CLEAR_TIME.toISOString());
    expect(plan.clearedBy).toBe(MANAGER.id);
    expect(plan.clearReason).toBe('Customer asked for texts again.');
    expect(plan.suppressionUpdate).toEqual({
      suppression_id: suppressionId,
      channel: 'sms',
      normalized_value: PHONE_VALUE,
      cleared_at: CLEAR_TIME.toISOString(),
      cleared_by: MANAGER.id,
      clear_reason: 'Customer asked for texts again.',
    });
    expect(plan.matchedContactIds).toEqual(['contact-a-phone', 'contact-b-phone']);
    expect(plan.contactUpdates).toEqual([
      { contact_id: 'contact-a-phone', case_id: 'case-a', column: 'sms_suppressed', value: false },
      { contact_id: 'contact-b-phone', case_id: 'case-b', column: 'sms_suppressed', value: false },
    ]);
    expect(plan.affectedCaseIds).toEqual(['case-a', 'case-b']);
    expect(plan.events).toEqual([
      {
        case_id: 'case-a',
        actor_id: MANAGER.id,
        event_type: SUPPRESSION_CLEARED_EVENT_TYPE,
        event_time: CLEAR_TIME.toISOString(),
        detail: {
          channel: 'sms',
          contact_channel: 'phone',
          contact_id: 'contact-a-phone',
          normalized_value: PHONE_VALUE,
          clear_reason: 'Customer asked for texts again.',
        },
      },
      {
        case_id: 'case-b',
        actor_id: MANAGER.id,
        event_type: SUPPRESSION_CLEARED_EVENT_TYPE,
        event_time: CLEAR_TIME.toISOString(),
        detail: {
          channel: 'sms',
          contact_channel: 'phone',
          contact_id: 'contact-b-phone',
          normalized_value: PHONE_VALUE,
          clear_reason: 'Customer asked for texts again.',
        },
      },
    ]);

    applyClearPlan(world, plan);

    expect(flagsOf(world, 'contact-a-phone')).toEqual({ sms: false, email: false });
    expect(flagsOf(world, 'contact-b-phone')).toEqual({ sms: false, email: false });
    expect(world.events).toHaveLength(4);
  });

  it('keeps the cleared row as history and lets the value be suppressed again', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);
    applyClearPlan(
      world,
      planOfClear(
        clearSuppression('sms', PHONE_VALUE, MANAGER, 'Customer asked for texts again.', contextFor(world, CLEAR_TIME)),
      ),
    );

    expect(world.suppressions).toHaveLength(1);
    expect(world.suppressions[0].cleared_at).toBe(CLEAR_TIME.toISOString());
    expect(world.suppressions[0].cleared_by).toBe(MANAGER.id);
    expect(world.suppressions[0].clear_reason).toBe('Customer asked for texts again.');
    expect(isValueSuppressed(PHONE_VALUE, world.suppressions, 'sms')).toBe(false);

    // The customer is sendable again on that channel.
    expect(attemptSend(world, 'sms', 'case-a', 5, 'automatic_touchpoint').map((row) => row.contact_id)).toEqual([
      'contact-a-phone',
    ]);

    // And a later opt-out inserts a second row rather than reusing the cleared one.
    const second = recordUserOptOut(world, 'sms', PHONE_VALUE, null, new Date('2026-04-01T14:00:00.000Z'));

    expect(second.alreadyActive).toBe(false);
    expect(world.suppressions).toHaveLength(2);
    expect(isValueSuppressed(PHONE_VALUE, world.suppressions, 'sms')).toBe(true);
  });

  // Not a rejection. The customer asked for the channel back, and a stale flag left behind by a
  // partially applied write would keep silently blocking sends if this returned an error.
  it('repairs stale contact flags when no active suppression is stored', () => {
    const world = makeWorld();
    world.contacts[0].sms_suppressed = true;

    const plan = planOfClear(
      clearSuppression('sms', PHONE_VALUE, MANAGER, 'Customer asked for texts again.', contextFor(world, CLEAR_TIME)),
    );

    expect(plan.alreadyCleared).toBe(true);
    expect(plan.suppressionUpdate).toBeNull();
    expect(plan.matchedContactIds).toEqual(['contact-a-phone', 'contact-b-phone']);
    expect(plan.contactUpdates).toEqual([
      { contact_id: 'contact-a-phone', case_id: 'case-a', column: 'sms_suppressed', value: false },
    ]);
    expect(plan.affectedCaseIds).toEqual(['case-a']);
    expect(plan.events.map((event) => event.case_id)).toEqual(['case-a']);

    applyClearPlan(world, plan);

    expect(flagsOf(world, 'contact-a-phone')).toEqual({ sms: false, email: false });
    expect(world.suppressions).toEqual([]);
  });

  it('plans no flag write and no audit entry when nothing is suppressed at all', () => {
    const world = makeWorld();

    const plan = planOfClear(
      clearSuppression('sms', PHONE_VALUE, MANAGER, 'Customer asked for texts again.', contextFor(world, CLEAR_TIME)),
    );

    expect(plan.alreadyCleared).toBe(true);
    expect(plan.suppressionUpdate).toBeNull();
    expect(plan.contactUpdates).toEqual([]);
    expect(plan.events).toEqual([]);

    applyClearPlan(world, plan);

    expect(world.events).toEqual([]);
  });

  it('clears one channel only, leaving the other channel suppressed', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'sms', PHONE_VALUE);
    recordUserOptOut(world, 'email', EMAIL_VALUE, 'Customer asked for no more email.');

    applyClearPlan(
      world,
      planOfClear(
        clearSuppression('sms', PHONE_VALUE, MANAGER, 'Customer asked for texts again.', contextFor(world, CLEAR_TIME)),
      ),
    );

    expect(isValueSuppressed(PHONE_VALUE, world.suppressions, 'sms')).toBe(false);
    expect(isValueSuppressed(EMAIL_VALUE, world.suppressions, 'email')).toBe(true);
    expect(flagsOf(world, 'contact-a-phone')).toEqual({ sms: false, email: false });
    expect(flagsOf(world, 'contact-a-email')).toEqual({ sms: false, email: true });
    expect(attemptSend(world, 'email', 'case-a', 15, 'automatic_touchpoint')).toEqual([]);
    expect(attemptSend(world, 'sms', 'case-a', 15, 'automatic_touchpoint').map((row) => row.contact_id)).toEqual([
      'contact-a-phone',
    ]);
  });

  it('accepts a raw contact value and clears the rows the importer stored', () => {
    const world = makeWorld();
    recordUserOptOut(world, 'email', EMAIL_VALUE, 'Customer asked for no more email.');

    const plan = planOfClear(
      clearSuppression(
        'email',
        '  Ana@Example.COM ',
        SUPER_ADMIN,
        'Customer asked for email again.',
        contextFor(world, CLEAR_TIME),
      ),
    );

    expect(plan.normalizedValue).toBe(EMAIL_VALUE);
    expect(plan.matchedContactIds).toEqual(['contact-a-email', 'contact-b-email']);

    applyClearPlan(world, plan);

    expect(isValueSuppressed(EMAIL_VALUE, world.suppressions, 'email')).toBe(false);
  });

  it('leaves every stored Communication_Record unchanged (Req 21.9)', () => {
    const world = makeWorld();
    world.communications.push(
      {
        id: 'communication-1',
        case_id: 'case-a',
        contact_id: 'contact-a-phone',
        channel: 'sms',
        touchpoint: 15,
        delivery_result: 'Sent',
        trigger: 'automatic_touchpoint',
      },
      {
        id: 'communication-2',
        case_id: 'case-b',
        contact_id: 'contact-b-email',
        channel: 'email',
        touchpoint: 10,
        delivery_result: 'Failed',
        trigger: 'send_reminder_now',
      },
    );
    const storedBefore = structuredClone(world.communications);

    recordUserOptOut(world, 'sms', PHONE_VALUE);
    const plan = planOfClear(
      clearSuppression('sms', PHONE_VALUE, MANAGER, 'Customer asked for texts again.', contextFor(world, CLEAR_TIME)),
    );
    applyClearPlan(world, plan);

    expect(Object.keys(plan).filter((key) => /communication/i.test(key))).toEqual([]);
    expect(world.communications).toEqual(storedBefore);
  });
});

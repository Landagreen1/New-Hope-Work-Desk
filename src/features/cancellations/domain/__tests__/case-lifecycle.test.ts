// src/features/cancellations/domain/__tests__/case-lifecycle.test.ts
//
// Feature: policy-follow-up-renewals-cancellations, task 13.3 — status tests over the pure
// module `src/features/cancellations/domain/communication-status.ts`.
//
// **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 16.9, 16.10,
// 20.11, 25.2**
//
// The module is pure: no React, no Supabase client, no provider, no clock, no randomness. The
// current business date and every row arrive as parameters, so every case here hands it an
// in-memory world and asserts the derived value. No mock is used and none is needed — the roles
// are the real `APP_ROLES` values read through the real `canAccessRenewals` and
// `isBroadManagerRole`, which is the only way the Requirement 17.10 gate is worth testing.
//
// No property test lives in this file. The design names exactly three `fast-check` properties —
// CSV raw-row round trip, scheduler idempotency, forbidden tokens in rendered output — and none
// of them is about status derivation; Requirement 15 is a decision table, which the testing
// strategy assigns to enumerated boundary cases.
//
// Beyond the coverage list of task 13.3, these cases pin the readings the implementation
// records, each of which a later change could reverse while everything else still passed:
//
//  1. `Failed` and `Partially Failed` outrank `Partially Sent`, so one failed record beside
//     three pending sends reads `Failed` (Requirement 15.9's order, not intuition);
//  2. a channel cell whose records are all `Sent` reads `Sent`, completing the ladder that
//     Requirement 16.9's "criteria 5 through 8" leaves open for an all-Sent set;
//  3. a channel cell reads `Suppressed` ahead of `Not Scheduled`, and ahead of `Scheduled`;
//  4. Requirement 20.11 holds the *case* value only — the two channel cells stay truthful about
//     their own channel, and the row surfaces the escalation through `Call Customer`;
//  5. the next required action reads as cleared only where the stored column is null *and*
//     Case_Status is Reinstated, Cancelled, or Resolved; a null column on any other status is an
//     action never set and is derived;
//  6. `Sent` requires at least one stored record, so it cannot shadow `Not Scheduled` on a
//     freshly imported case (Requirement 15.10).
//
// The Requirements 15.3 and 15.4 guarantee is asserted twice over: once in the type system —
// `CommunicationStatusUpdate` has no `case_status` key, so a recompute has nowhere to put one —
// and once at run time over every (Case_Status, delivery result) pair.

import { describe, expect, it } from 'vitest';

import { APP_ROLES, canAccessRenewals, isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import type { Touchpoint } from '../../render/renderMessage';
import {
  ACTION_CLEARING_CASE_STATUSES,
  CASE_STATUSES,
  CHANNEL_SCHEDULED_CELL,
  COMMUNICATION_STATUSES,
  COMMUNICATION_STATUS_PRECEDENCE,
  DELIVERY_RESULTS,
  EM_DASH,
  MANAGER_ONLY_ACTIONS,
  NEXT_REQUIRED_ACTIONS,
  OPEN_CASE_STATUSES,
  cellText,
  currentTouchpoint,
  currentTouchpointForCase,
  daysRemaining,
  deriveCaseCommunicationStatus,
  deriveChannelStatusCell,
  deriveCommunicationStatus,
  deriveEmailStatusCell,
  deriveLastContact,
  deriveNextRequiredAction,
  deriveRowCells,
  deriveSmsStatusCell,
  everyContactSuppressed,
  hasContactableContact,
  hasRecordForTouchpoint,
  hasUnclearedEscalation,
  isCaseStatus,
  isCommunicationStatus,
  isContactSuppressed,
  isContactable,
  isDeliveryResult,
  isNextRequiredAction,
  isOpenCaseStatus,
  isUnclearedEscalation,
  mostRecentTouchpoint,
  nextRequiredActionCleared,
  pendingTouchpointChannelSends,
  planCommunicationStatusUpdate,
  validateCaseStatus,
  validateCommunicationStatus,
  validateDeliveryResult,
} from '../communication-status';
import type {
  CaseCommunicationState,
  CaseStatus,
  CommunicationRecord,
  CommunicationStatus,
  CommunicationStatusCase,
  CommunicationStatusUpdate,
  DeliveryResult,
  EscalationRecord,
  NextRequiredAction,
  ScheduledSend,
  StatusRejection,
  StatusValidation,
} from '../communication-status';
import type { ChannelEligibilityContact, SuppressionRecord } from '../suppression';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CASE_ID = 'case-0001';
/** The cancellation effective date every world here shares. */
const EFFECTIVE_DATE = '2026-07-31';
/** A business date 15 days before it, so the current Touchpoint is the 15-day one. */
const BUSINESS_DATE_15 = '2026-07-16';
/** A business date 1 day before it, so the current Touchpoint is the 1-day one. */
const BUSINESS_DATE_1 = '2026-07-30';

const PHONE_VALUE = '+13055550147';
const EMAIL_VALUE = 'ana@example.com';

/** Uncleared: `cleared_at` absent is the whole of Requirement 20.11 as a status reads it. */
const UNCLEARED_ESCALATION: EscalationRecord = {
  id: 'esc-1',
  case_id: CASE_ID,
  reason: 'No Valid Contact',
  raised_at: '2026-07-20T12:00:00.000Z',
};

const CLEARED_ESCALATION: EscalationRecord = {
  ...UNCLEARED_ESCALATION,
  cleared_at: '2026-07-21T12:00:00.000Z',
  cleared_by: 'profile-manager-1',
};

/** The three roles holding Policy_Follow_Up access without Manager_Role (Requirement 17.10). */
const AGENT_ROLES: readonly AppRole[] = APP_ROLES.filter(
  (role) => canAccessRenewals(role) && !isBroadManagerRole(role),
);
/** The two roles holding Manager_Role. */
const MANAGER_ROLES: readonly AppRole[] = APP_ROLES.filter((role) => isBroadManagerRole(role));

function phoneContact(overrides: Partial<ChannelEligibilityContact> = {}): ChannelEligibilityContact {
  return {
    channel: 'phone',
    normalized_value: PHONE_VALUE,
    validation_status: 'valid',
    authorization_status: 'Authorized',
    sms_suppressed: false,
    email_suppressed: false,
    ...overrides,
  };
}

function emailContact(overrides: Partial<ChannelEligibilityContact> = {}): ChannelEligibilityContact {
  return {
    channel: 'email',
    normalized_value: EMAIL_VALUE,
    validation_status: 'valid',
    authorization_status: 'Authorized',
    sms_suppressed: false,
    email_suppressed: false,
    ...overrides,
  };
}

function record(
  touchpoint: Touchpoint,
  channel: 'sms' | 'email',
  deliveryResult: DeliveryResult,
  overrides: Partial<CommunicationRecord> = {},
): CommunicationRecord {
  return {
    id: `comm-${touchpoint}-${channel}-${deliveryResult}`,
    case_id: CASE_ID,
    contact_id: channel === 'sms' ? 'contact-phone-1' : 'contact-email-1',
    touchpoint,
    channel,
    delivery_result: deliveryResult,
    send_time: '2026-07-16T14:00:00.000Z',
    ...overrides,
  };
}

function caseRow(overrides: Partial<CommunicationStatusCase> = {}): CommunicationStatusCase {
  return {
    id: CASE_ID,
    case_status: 'Open',
    communication_status: 'Not Scheduled',
    cancellation_effective_date: EFFECTIVE_DATE,
    next_required_action: null,
    ...overrides,
  };
}

function world(overrides: Partial<CaseCommunicationState> = {}): CaseCommunicationState {
  return {
    case: caseRow(),
    contacts: [phoneContact(), emailContact()],
    communications: [],
    scheduledSends: [],
    escalations: [],
    responses: [],
    suppressions: [],
    businessDate: BUSINESS_DATE_15,
    ...overrides,
  };
}

/** The ladder over one world, through the design's positional entry point. */
function statusOf(state: CaseCommunicationState): CommunicationStatus {
  return deriveCommunicationStatus(
    state.case,
    state.contacts ?? [],
    state.communications ?? [],
    state.scheduledSends ?? [],
    state.escalations ?? [],
    state.suppressions ?? [],
  );
}

function acceptedValue<TValue>(result: StatusValidation<TValue>): TValue {
  if (!result.ok) throw new Error(`expected the write to be accepted: ${result.rejection.message}`);
  return result.value;
}

function refusalOf<TValue>(result: StatusValidation<TValue>): StatusRejection {
  if (result.ok) throw new Error(`expected the write to be refused, got ${String(result.value)}`);
  return result.rejection;
}

/** A caller that writes only on acceptance — which is what leaves a stored value unchanged. */
function writeCaseStatus(stored: CommunicationStatusCase, value: unknown): CommunicationStatusCase {
  const result = validateCaseStatus(value);
  return result.ok ? { ...stored, case_status: result.value } : stored;
}

function writeCommunicationStatus(
  stored: CommunicationStatusCase,
  value: unknown,
): CommunicationStatusCase {
  const result = validateCommunicationStatus(value);
  return result.ok ? { ...stored, communication_status: result.value } : stored;
}

/** A recompute applied to a stored row: the plan carries the only column it may touch. */
function applyRecompute(
  stored: CommunicationStatusCase,
  update: CommunicationStatusUpdate,
): CommunicationStatusCase {
  return { ...stored, communication_status: update.communication_status };
}

/** Values no `cancellation_cases` status column may hold (Requirements 15.1, 15.2). */
const OUT_OF_SET_VALUES: readonly unknown[] = [
  'Escalated',
  'open',
  'Imported ',
  'manual follow-up required',
  '',
  '   ',
  null,
  undefined,
  42,
  {},
  ['Open'],
];

// ---------------------------------------------------------------------------
// The stored value domain (Requirements 15.1, 15.2, 15.3)
// ---------------------------------------------------------------------------

describe('stored value domain', () => {
  it('restricts Case_Status to exactly the ten values of Requirement 15.1', () => {
    expect(CASE_STATUSES).toHaveLength(10);
    expect(new Set(CASE_STATUSES).size).toBe(10);
    expect([...CASE_STATUSES]).toEqual([
      'Imported',
      'Open',
      'Payment Reported',
      'Verification Pending',
      'Reinstatement Pending',
      'Reinstated',
      'Cancelled',
      'Resolved',
      'Invalid',
      'Duplicate',
    ]);
    for (const status of CASE_STATUSES) expect(isCaseStatus(status)).toBe(true);
  });

  it('treats only Imported and Open as open Case_Status values (Requirement 15.1)', () => {
    expect([...OPEN_CASE_STATUSES]).toEqual(['Imported', 'Open']);
    for (const status of CASE_STATUSES) {
      expect(isOpenCaseStatus(status)).toBe(status === 'Imported' || status === 'Open');
    }
  });

  it('restricts Communication_Status to exactly the nine values of Requirement 15.2', () => {
    expect(COMMUNICATION_STATUSES).toHaveLength(9);
    expect(new Set(COMMUNICATION_STATUSES).size).toBe(9);
    for (const status of COMMUNICATION_STATUSES) expect(isCommunicationStatus(status)).toBe(true);
  });

  it('restricts a delivery result to Sent, Delivered, and Failed (Requirement 15.3)', () => {
    expect([...DELIVERY_RESULTS]).toEqual(['Sent', 'Delivered', 'Failed']);
    for (const result of DELIVERY_RESULTS) expect(isDeliveryResult(result)).toBe(true);
    expect(isDeliveryResult('Bounced')).toBe(false);
    expect(isDeliveryResult('sent')).toBe(false);
  });

  it('names the nine next required actions of Requirements 16.9 and 17.3', () => {
    expect(NEXT_REQUIRED_ACTIONS).toHaveLength(9);
    expect(new Set(NEXT_REQUIRED_ACTIONS).size).toBe(9);
    for (const action of NEXT_REQUIRED_ACTIONS) expect(isNextRequiredAction(action)).toBe(true);
    // The four Requirement 17.10 hides from Agent_Role are among the nine.
    for (const action of MANAGER_ONLY_ACTIONS) expect(NEXT_REQUIRED_ACTIONS).toContain(action);
  });

  it('renders an absent derived cell as the em dash of Requirement 16.9', () => {
    expect(EM_DASH).toBe('\u2014');
    expect(EM_DASH).toHaveLength(1);
    expect(cellText(null)).toBe(EM_DASH);
    expect(cellText('Send Reminder Now')).toBe('Send Reminder Now');
  });
});

// ---------------------------------------------------------------------------
// Rejecting an out-of-set write (Requirements 15.1, 15.2, 15.3)
// ---------------------------------------------------------------------------

describe('rejecting an out-of-set status write', () => {
  it('accepts each of the ten Case_Status values', () => {
    for (const status of CASE_STATUSES) {
      expect(acceptedValue(validateCaseStatus(status))).toBe(status);
    }
  });

  it('refuses a Case_Status outside the ten and leaves the stored value unchanged', () => {
    const stored = caseRow({ case_status: 'Open' });
    for (const value of OUT_OF_SET_VALUES) {
      const rejection = refusalOf(validateCaseStatus(value));
      expect(rejection.code).toBe('case_status_not_allowed');
      expect(rejection.message).toContain('not an allowed Case_Status');
      expect(writeCaseStatus(stored, value).case_status).toBe('Open');
    }
    // An accepted value does reach the stored row, so the guard is not refusing everything.
    expect(writeCaseStatus(stored, 'Payment Reported').case_status).toBe('Payment Reported');
  });

  it('accepts each of the nine Communication_Status values', () => {
    for (const status of COMMUNICATION_STATUSES) {
      expect(acceptedValue(validateCommunicationStatus(status))).toBe(status);
    }
  });

  it('refuses a Communication_Status outside the nine and leaves the stored value unchanged', () => {
    const stored = caseRow({ communication_status: 'Delivered' });
    for (const value of OUT_OF_SET_VALUES) {
      const rejection = refusalOf(validateCommunicationStatus(value));
      expect(rejection.code).toBe('communication_status_not_allowed');
      expect(rejection.message).toContain('not an allowed Communication_Status');
      expect(writeCommunicationStatus(stored, value).communication_status).toBe('Delivered');
    }
    expect(writeCommunicationStatus(stored, 'Failed').communication_status).toBe('Failed');
  });

  it('refuses a delivery result outside Sent, Delivered, and Failed (Requirement 15.3)', () => {
    for (const result of DELIVERY_RESULTS) {
      expect(acceptedValue(validateDeliveryResult(result))).toBe(result);
    }
    for (const value of ['Bounced', 'Queued', 'delivered', '', null, undefined, 7]) {
      const rejection = refusalOf(validateDeliveryResult(value));
      expect(rejection.code).toBe('delivery_result_not_allowed');
      expect(rejection.message).toContain('not an allowed Communication_Record delivery result');
    }
  });

  it('clips a long refused value in the message rather than echoing it whole', () => {
    const rejection = refusalOf(validateCaseStatus('X'.repeat(200)));
    expect(rejection.message.length).toBeLessThan(120);
    expect(rejection.message).toContain('\u2026');
  });
});

// ---------------------------------------------------------------------------
// The nine-step ladder (Requirement 15.9)
// ---------------------------------------------------------------------------

describe('Communication_Status ladder', () => {
  it('writes the nine steps of Requirement 15.9 down in order', () => {
    expect([...COMMUNICATION_STATUS_PRECEDENCE]).toEqual([
      'Manual Follow-up Required',
      'Failed',
      'Partially Failed',
      'Suppressed',
      'Partially Sent',
      'Delivered',
      'Sent',
      'Scheduled',
      'Not Scheduled',
    ]);
    // The order is a permutation of the nine allowed values, so every step is reachable.
    expect(new Set(COMMUNICATION_STATUS_PRECEDENCE)).toEqual(new Set(COMMUNICATION_STATUSES));
  });

  it('step 1: an uncleared escalation reason gives Manual Follow-up Required (Req 20.11)', () => {
    const state = world({
      communications: [record(15, 'sms', 'Delivered'), record(15, 'email', 'Delivered')],
      escalations: [UNCLEARED_ESCALATION],
    });
    expect(statusOf(state)).toBe('Manual Follow-up Required');
  });

  it('step 2: at least one record and every record Failed gives Failed (Req 15.7)', () => {
    const state = world({
      communications: [record(15, 'sms', 'Failed'), record(15, 'email', 'Failed')],
    });
    expect(statusOf(state)).toBe('Failed');
  });

  it('step 3: one Failed beside one other result gives Partially Failed (Req 15.6)', () => {
    const state = world({
      communications: [record(15, 'sms', 'Failed'), record(15, 'email', 'Sent')],
    });
    expect(statusOf(state)).toBe('Partially Failed');
  });

  it('step 4: zero records with every contact suppressed gives Suppressed (Req 15.8)', () => {
    const state = world({
      contacts: [
        phoneContact({ sms_suppressed: true }),
        emailContact({ email_suppressed: true }),
      ],
    });
    expect(statusOf(state)).toBe('Suppressed');
  });

  it('step 5: one record beside one pending send gives Partially Sent (Req 15.9)', () => {
    const state = world({
      communications: [record(15, 'sms', 'Sent')],
      // The scheduled set, not the pending set: the subtraction happens inside.
      scheduledSends: [
        { touchpoint: 15, channel: 'sms' },
        { touchpoint: 10, channel: 'sms' },
      ],
    });
    expect(statusOf(state)).toBe('Partially Sent');
  });

  it('step 6: every record Delivered with zero pending gives Delivered (Req 15.5)', () => {
    const state = world({
      communications: [record(15, 'sms', 'Delivered'), record(15, 'email', 'Delivered')],
      scheduledSends: [
        { touchpoint: 15, channel: 'sms' },
        { touchpoint: 15, channel: 'email' },
      ],
    });
    expect(statusOf(state)).toBe('Delivered');
  });

  it('step 7: Sent or Delivered with zero pending gives Sent (Req 15.9)', () => {
    const state = world({
      communications: [record(15, 'sms', 'Sent'), record(15, 'email', 'Delivered')],
    });
    expect(statusOf(state)).toBe('Sent');
  });

  it('step 8: zero records with one pending send gives Scheduled (Req 15.9)', () => {
    const state = world({ scheduledSends: [{ touchpoint: 15, channel: 'sms' }] });
    expect(statusOf(state)).toBe('Scheduled');
  });

  it('step 9: zero records and zero pending sends gives Not Scheduled (Req 15.9, 15.10)', () => {
    expect(statusOf(world())).toBe('Not Scheduled');
  });

  it('agrees with the state-bundle entry point on every step', () => {
    const worlds: CaseCommunicationState[] = [
      world({ escalations: [UNCLEARED_ESCALATION] }),
      world({ communications: [record(15, 'sms', 'Failed')] }),
      world({ communications: [record(15, 'sms', 'Failed'), record(15, 'email', 'Delivered')] }),
      world({ contacts: [phoneContact({ sms_suppressed: true })] }),
      world({
        communications: [record(15, 'sms', 'Sent')],
        scheduledSends: [{ touchpoint: 10, channel: 'sms' }],
      }),
      world({ communications: [record(15, 'sms', 'Delivered')] }),
      world({ communications: [record(15, 'sms', 'Sent')] }),
      world({ scheduledSends: [{ touchpoint: 15, channel: 'email' }] }),
      world(),
    ];
    for (const state of worlds) {
      expect(deriveCaseCommunicationStatus(state)).toBe(statusOf(state));
    }
  });
});

// ---------------------------------------------------------------------------
// Precedence between the steps (Requirement 15.9, Requirement 20.11)
// ---------------------------------------------------------------------------

describe('ladder precedence', () => {
  it('holds Manual Follow-up Required above Delivered (Requirement 20.11)', () => {
    const delivered = world({
      communications: [record(15, 'sms', 'Delivered'), record(15, 'email', 'Delivered')],
    });
    expect(statusOf(delivered)).toBe('Delivered');
    expect(statusOf({ ...delivered, escalations: [UNCLEARED_ESCALATION] })).toBe(
      'Manual Follow-up Required',
    );
  });

  it('holds Manual Follow-up Required above Suppressed and Not Scheduled', () => {
    const suppressed = world({ contacts: [phoneContact({ sms_suppressed: true })] });
    expect(statusOf(suppressed)).toBe('Suppressed');
    expect(statusOf({ ...suppressed, escalations: [UNCLEARED_ESCALATION] })).toBe(
      'Manual Follow-up Required',
    );
    expect(statusOf(world({ escalations: [UNCLEARED_ESCALATION] }))).toBe(
      'Manual Follow-up Required',
    );
  });

  it('drops the override once the reason is cleared (Requirement 20.12)', () => {
    const state = world({
      communications: [record(15, 'sms', 'Delivered')],
      escalations: [CLEARED_ESCALATION],
    });
    expect(statusOf(state)).toBe('Delivered');
  });

  it('holds Failed above Partially Sent', () => {
    // One failed record and three pending sends reads Failed, not Partially Sent: the order of
    // Requirement 15.9 is explicit and a failure is the fact worth surfacing.
    const state = world({
      communications: [record(15, 'sms', 'Failed')],
      scheduledSends: [
        { touchpoint: 15, channel: 'sms' },
        { touchpoint: 10, channel: 'sms' },
        { touchpoint: 5, channel: 'sms' },
        { touchpoint: 1, channel: 'sms' },
      ],
    });
    expect(statusOf(state)).toBe('Failed');
  });

  it('holds Partially Failed above Partially Sent and above Delivered', () => {
    const pending = world({
      communications: [record(15, 'sms', 'Failed'), record(15, 'email', 'Sent')],
      scheduledSends: [{ touchpoint: 10, channel: 'sms' }],
    });
    expect(statusOf(pending)).toBe('Partially Failed');

    const settled = world({
      communications: [record(15, 'sms', 'Failed'), record(15, 'email', 'Delivered')],
    });
    expect(statusOf(settled)).toBe('Partially Failed');
  });

  it('holds Suppressed above Scheduled and above Not Scheduled', () => {
    const contacts = [phoneContact({ sms_suppressed: true }), emailContact({ email_suppressed: true })];
    expect(statusOf(world({ contacts, scheduledSends: [{ touchpoint: 15, channel: 'sms' }] }))).toBe(
      'Suppressed',
    );
    expect(statusOf(world({ contacts }))).toBe('Suppressed');
  });

  it('requires at least one record for Sent, so it cannot shadow Not Scheduled', () => {
    // Requirement 15.9's Sent clause — zero pending, every record Sent or Delivered — is
    // vacuously true for a case with no records at all. Reading 6: at least one record is
    // required, which is the only reading that leaves the Not Scheduled clause reachable.
    const fresh = world({ case: caseRow({ case_status: 'Imported' }), contacts: [] });
    expect(statusOf(fresh)).toBe('Not Scheduled');
    expect(statusOf(world({ contacts: [] }))).toBe('Not Scheduled');
  });

  it('reads Suppressed only with zero records, however the flags stand', () => {
    const contacts = [phoneContact({ sms_suppressed: true }), emailContact({ email_suppressed: true })];
    expect(statusOf(world({ contacts }))).toBe('Suppressed');
    expect(statusOf(world({ contacts, communications: [record(15, 'sms', 'Delivered')] }))).toBe(
      'Delivered',
    );
    expect(statusOf(world({ contacts, communications: [record(15, 'sms', 'Failed')] }))).toBe('Failed');
  });

  it('reads suppression from the suppression list as well as the contact flags', () => {
    const suppressions: SuppressionRecord[] = [
      { id: 'sup-1', channel: 'sms', normalized_value: PHONE_VALUE },
    ];
    // A phone row an import created after the opt-out carries a cleared flag (Req 21.3, 21.4).
    const state = world({ contacts: [phoneContact()], suppressions });
    expect(statusOf(state)).toBe('Suppressed');

    const cleared: SuppressionRecord[] = [{ ...suppressions[0], cleared_at: '2026-07-20T00:00:00.000Z' }];
    expect(statusOf(world({ contacts: [phoneContact()], suppressions: cleared }))).toBe('Not Scheduled');
  });
});

// ---------------------------------------------------------------------------
// Case_Status is never derived (Requirements 15.3, 15.4)
// ---------------------------------------------------------------------------

/** Compile-time guarantee: the shape forbids the key outright. */
type ForbidsKey<TShape, TKey extends string> = TKey extends keyof TShape ? false : true;
const RECOMPUTE_FORBIDS_CASE_STATUS: ForbidsKey<CommunicationStatusUpdate, 'case_status'> = true;

describe('a recompute never carries a Case_Status', () => {
  it('has no case_status key in the type or in the plan (Requirements 15.3, 15.4)', () => {
    expect(RECOMPUTE_FORBIDS_CASE_STATUS).toBe(true);
    const plan = planCommunicationStatusUpdate(world({ communications: [record(15, 'sms', 'Sent')] }));
    expect(Object.keys(plan).sort()).toEqual(['case_id', 'changed', 'communication_status']);
    expect('case_status' in plan).toBe(false);
  });

  it('leaves Case_Status unchanged for every delivery result and every Case_Status (Req 15.4)', () => {
    for (const status of CASE_STATUSES) {
      for (const result of DELIVERY_RESULTS) {
        const stored = caseRow({ case_status: status, communication_status: 'Scheduled' });
        const plan = planCommunicationStatusUpdate(
          world({ case: stored, communications: [record(15, 'sms', result)] }),
        );
        const written = applyRecompute(stored, plan);
        expect(written.case_status).toBe(status);
        expect(stored.case_status).toBe(status);
      }
    }
  });

  it('reports whether the recompute changes the stored Communication_Status', () => {
    const unchanged = planCommunicationStatusUpdate(
      world({ case: caseRow({ communication_status: 'Not Scheduled' }) }),
    );
    expect(unchanged).toEqual({
      case_id: CASE_ID,
      communication_status: 'Not Scheduled',
      changed: false,
    });

    const changed = planCommunicationStatusUpdate(
      world({
        case: caseRow({ communication_status: 'Not Scheduled' }),
        communications: [record(15, 'sms', 'Failed')],
      }),
    );
    expect(changed.communication_status).toBe('Failed');
    expect(changed.changed).toBe(true);

    // A case row carrying no stored value at all is a change to whatever is derived.
    const absent = planCommunicationStatusUpdate(
      world({ case: caseRow({ communication_status: null }) }),
    );
    expect(absent.changed).toBe(true);
  });

  it('carries a null case id where the case row has none', () => {
    const plan = planCommunicationStatusUpdate(world({ case: caseRow({ id: null }) }));
    expect(plan.case_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pending Touchpoint channel sends (Requirement 15.3)
// ---------------------------------------------------------------------------

describe('pending Touchpoint channel sends', () => {
  const scheduled: ScheduledSend[] = [
    { touchpoint: 15, channel: 'sms' },
    { touchpoint: 15, channel: 'email' },
    { touchpoint: 10, channel: 'sms' },
  ];

  it('subtracts the stored records from the scheduled pairs', () => {
    const pending = pendingTouchpointChannelSends(scheduled, [record(15, 'sms', 'Sent')]);
    expect(pending).toEqual([
      { touchpoint: 15, channel: 'email' },
      { touchpoint: 10, channel: 'sms' },
    ]);
  });

  it('is idempotent, so the scheduled set and the pending set give the same answer', () => {
    const communications = [record(15, 'sms', 'Sent')];
    const once = pendingTouchpointChannelSends(scheduled, communications);
    expect(pendingTouchpointChannelSends(once, communications)).toEqual(once);
  });

  it('collapses duplicate pairs and returns only the two keys', () => {
    const pending = pendingTouchpointChannelSends(
      [
        { touchpoint: 5, channel: 'sms' },
        { touchpoint: 5, channel: 'sms' },
      ],
      [],
    );
    expect(pending).toEqual([{ touchpoint: 5, channel: 'sms' }]);
    expect(Object.keys(pending[0]).sort()).toEqual(['channel', 'touchpoint']);
  });

  it('counts a record of another channel or Touchpoint as no cover', () => {
    expect(pendingTouchpointChannelSends([{ touchpoint: 15, channel: 'sms' }], [record(15, 'email', 'Sent')])).toEqual([
      { touchpoint: 15, channel: 'sms' },
    ]);
    expect(pendingTouchpointChannelSends([{ touchpoint: 15, channel: 'sms' }], [record(10, 'sms', 'Sent')])).toEqual([
      { touchpoint: 15, channel: 'sms' },
    ]);
    expect(pendingTouchpointChannelSends([], [record(15, 'sms', 'Sent')])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Escalation, suppression, and contactability reads
// ---------------------------------------------------------------------------

describe('escalation and contact state reads', () => {
  it('reads an absent or null cleared_at as uncleared (Requirement 20.12)', () => {
    expect(isUnclearedEscalation({ reason: 'Payment Reported' })).toBe(true);
    expect(isUnclearedEscalation({ reason: 'Payment Reported', cleared_at: null })).toBe(true);
    expect(isUnclearedEscalation(CLEARED_ESCALATION)).toBe(false);
    expect(hasUnclearedEscalation([])).toBe(false);
    expect(hasUnclearedEscalation([CLEARED_ESCALATION])).toBe(false);
    expect(hasUnclearedEscalation([CLEARED_ESCALATION, UNCLEARED_ESCALATION])).toBe(true);
  });

  it('tests each contact row against its own channel only (Requirement 15.8)', () => {
    // `sms_suppressed` on an email row and `email_suppressed` on a phone row say nothing.
    expect(isContactSuppressed(phoneContact({ email_suppressed: true }))).toBe(false);
    expect(isContactSuppressed(phoneContact({ sms_suppressed: true }))).toBe(true);
    expect(isContactSuppressed(emailContact({ sms_suppressed: true }))).toBe(false);
    expect(isContactSuppressed(emailContact({ email_suppressed: true }))).toBe(true);
  });

  it('requires at least one contact for every-contact-suppressed (Requirement 15.8)', () => {
    expect(everyContactSuppressed([])).toBe(false);
    expect(everyContactSuppressed([phoneContact({ sms_suppressed: true })])).toBe(true);
    expect(
      everyContactSuppressed([phoneContact({ sms_suppressed: true }), emailContact()]),
    ).toBe(false);
    // A case holding only phone rows satisfies the email clause with nothing in it.
    expect(
      everyContactSuppressed([
        phoneContact({ sms_suppressed: true }),
        phoneContact({ normalized_value: '+13055559999', sms_suppressed: true }),
      ]),
    ).toBe(true);
  });

  it('reads contactability from validity and authorization alone (Requirement 17.4(c))', () => {
    expect(isContactable(phoneContact())).toBe(true);
    // Unknown permits contact (Requirements 10.9, 10.10).
    expect(isContactable(phoneContact({ authorization_status: 'Unknown' }))).toBe(true);
    expect(isContactable(phoneContact({ authorization_status: 'Not Authorized' }))).toBe(false);
    expect(isContactable(phoneContact({ validation_status: 'invalid' }))).toBe(false);
    // Deliberately not suppression-scoped: the question is whether any usable detail is held.
    expect(isContactable(phoneContact({ sms_suppressed: true }))).toBe(true);

    expect(hasContactableContact([])).toBe(false);
    expect(hasContactableContact([phoneContact({ validation_status: 'invalid' })])).toBe(false);
    expect(
      hasContactableContact([phoneContact({ validation_status: 'invalid' }), emailContact()]),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The business date and the Touchpoints (Requirements 16.1, 17.5)
// ---------------------------------------------------------------------------

describe('days remaining and the current Touchpoint', () => {
  it('computes the whole-day difference of Requirement 16.1', () => {
    expect(daysRemaining(EFFECTIVE_DATE, EFFECTIVE_DATE)).toBe(0);
    expect(daysRemaining(EFFECTIVE_DATE, BUSINESS_DATE_1)).toBe(1);
    expect(daysRemaining(EFFECTIVE_DATE, BUSINESS_DATE_15)).toBe(15);
    expect(daysRemaining(EFFECTIVE_DATE, '2026-08-02')).toBe(-2);
    // `M/D/YYYY` parses through the import parser.
    expect(daysRemaining('7/31/2026', BUSINESS_DATE_15)).toBe(15);
  });

  it('carries no dependence on daylight saving', () => {
    expect(daysRemaining('2026-03-31', '2026-03-01')).toBe(30);
    expect(daysRemaining('2026-11-05', '2026-10-30')).toBe(6);
  });

  it('gives null where either date is absent or names no calendar date', () => {
    expect(daysRemaining(null, BUSINESS_DATE_15)).toBeNull();
    expect(daysRemaining(EFFECTIVE_DATE, undefined)).toBeNull();
    expect(daysRemaining('July 31, 2026', BUSINESS_DATE_15)).toBeNull();
    expect(daysRemaining('2026-02-30', BUSINESS_DATE_15)).toBeNull();
  });

  it('resolves the current Touchpoint of Requirement 17.5 at each boundary', () => {
    const expected: readonly [number, Touchpoint][] = [
      [20, 15],
      [16, 15],
      [15, 15],
      [11, 15],
      [10, 10],
      [6, 10],
      [5, 5],
      [2, 5],
      [1, 1],
      [0, 1],
      [-3, 1],
    ];
    for (const [remaining, touchpoint] of expected) {
      expect(currentTouchpoint(remaining)).toBe(touchpoint);
    }
  });

  it('falls back to the 15-day Touchpoint where no date is known', () => {
    expect(currentTouchpointForCase(world({ businessDate: BUSINESS_DATE_1 }))).toBe(1);
    expect(currentTouchpointForCase(world({ businessDate: BUSINESS_DATE_15 }))).toBe(15);
    expect(currentTouchpointForCase(world({ businessDate: null }))).toBe(15);
    expect(
      currentTouchpointForCase(world({ case: caseRow({ cancellation_effective_date: null }) })),
    ).toBe(15);
  });

  it('reads the most recent Touchpoint as the one with the fewest days remaining', () => {
    expect(mostRecentTouchpoint([])).toBeNull();
    expect(mostRecentTouchpoint([record(15, 'sms', 'Sent'), record(5, 'email', 'Failed')])).toBe(5);
    expect(mostRecentTouchpoint([record(1, 'sms', 'Sent'), record(10, 'sms', 'Sent')])).toBe(1);
  });

  it('finds a record for a Touchpoint on any channel (Requirement 17.4(f))', () => {
    const communications = [record(15, 'email', 'Sent')];
    expect(hasRecordForTouchpoint(communications, 15)).toBe(true);
    expect(hasRecordForTouchpoint(communications, 10)).toBe(false);
    expect(hasRecordForTouchpoint([], 15)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The two channel status cells (Requirements 16.9, 16.10)
// ---------------------------------------------------------------------------

describe('channel status cells', () => {
  it('derives each channel from its own records', () => {
    const state = world({
      communications: [record(5, 'sms', 'Failed'), record(5, 'email', 'Delivered')],
    });
    expect(deriveSmsStatusCell(state)).toBe('Failed');
    expect(deriveEmailStatusCell(state)).toBe('Delivered');
    expect(deriveChannelStatusCell('sms', state)).toBe('Failed');
    expect(deriveChannelStatusCell('email', state)).toBe('Delivered');
  });

  it('reads the most recent Touchpoint of that channel only', () => {
    // An older Touchpoint's failure is not carried forward: the cell answers "how did the
    // latest attempt on this channel go".
    const state = world({
      communications: [record(15, 'sms', 'Failed'), record(5, 'sms', 'Sent')],
    });
    expect(deriveSmsStatusCell(state)).toBe('Sent');
  });

  it('applies Requirement 15 criteria 5 through 7 to that Touchpoint', () => {
    const failed = world({ communications: [record(1, 'sms', 'Failed')] });
    expect(deriveSmsStatusCell(failed)).toBe('Failed');

    const partiallyFailed = world({
      communications: [
        record(1, 'sms', 'Failed', { contact_id: 'contact-phone-1' }),
        record(1, 'sms', 'Delivered', { contact_id: 'contact-phone-2' }),
      ],
    });
    expect(deriveSmsStatusCell(partiallyFailed)).toBe('Partially Failed');

    const delivered = world({ communications: [record(1, 'sms', 'Delivered')] });
    expect(deriveSmsStatusCell(delivered)).toBe('Delivered');

    // Reading 2: an all-Sent set is left undefined by criteria 5 through 8; the ladder is
    // completed with Sent from Requirement 15.9.
    const sent = world({
      communications: [
        record(1, 'sms', 'Sent', { contact_id: 'contact-phone-1' }),
        record(1, 'sms', 'Sent', { contact_id: 'contact-phone-2' }),
      ],
    });
    expect(deriveSmsStatusCell(sent)).toBe('Sent');
  });

  it('reads the exact character sequence Scheduled for a scheduled channel with no records', () => {
    const state = world({ scheduledSends: [{ touchpoint: 15, channel: 'email' }] });
    expect(deriveEmailStatusCell(state)).toBe('Scheduled');
    expect(deriveEmailStatusCell(state)).toBe(CHANNEL_SCHEDULED_CELL);
    // Requirement 16.10 fixes the sequence: no per-channel label such as `Scheduled (email)`.
    expect(deriveSmsStatusCell(state)).toBe('Not Scheduled');
  });

  it('reads Not Scheduled with zero scheduled Touchpoints and zero records', () => {
    const state = world();
    expect(deriveSmsStatusCell(state)).toBe('Not Scheduled');
    expect(deriveEmailStatusCell(state)).toBe('Not Scheduled');
  });

  it('prefers Suppressed to Scheduled and to Not Scheduled where both hold', () => {
    // Reading 3: Suppressed sits ahead of Not Scheduled in the Requirement 15.9 order and says
    // more about the row.
    const contacts = [phoneContact({ sms_suppressed: true }), emailContact({ email_suppressed: true })];
    expect(deriveSmsStatusCell(world({ contacts }))).toBe('Suppressed');
    expect(
      deriveSmsStatusCell(world({ contacts, scheduledSends: [{ touchpoint: 15, channel: 'sms' }] })),
    ).toBe('Suppressed');
  });

  it('leaves the channel cells truthful under an uncleared escalation (Requirement 20.11)', () => {
    // Reading 4: Requirement 20.11 holds the case value. The row surfaces the escalation
    // through the next required action instead.
    const state = world({
      communications: [record(15, 'sms', 'Delivered'), record(15, 'email', 'Delivered')],
      escalations: [UNCLEARED_ESCALATION],
    });
    expect(deriveCaseCommunicationStatus(state)).toBe('Manual Follow-up Required');
    expect(deriveSmsStatusCell(state)).toBe('Delivered');
    expect(deriveEmailStatusCell(state)).toBe('Delivered');
    expect(deriveNextRequiredAction(state)).toBe('Call Customer');
  });
});

// ---------------------------------------------------------------------------
// The last contact cell (Requirement 16.9)
// ---------------------------------------------------------------------------

describe('last contact cell', () => {
  it('takes the most recent send or response time and ignores a failed record', () => {
    const state = world({
      communications: [
        record(15, 'sms', 'Sent', { send_time: '2026-07-16T14:00:00.000Z' }),
        record(15, 'email', 'Delivered', { send_time: '2026-07-16T15:00:00.000Z' }),
        record(10, 'sms', 'Failed', { send_time: '2026-07-21T10:00:00.000Z' }),
      ],
      responses: [{ id: 'resp-1', case_id: CASE_ID, response_time: '2026-07-18T09:00:00.000Z' }],
    });
    expect(deriveLastContact(state)).toBe('2026-07-18T09:00:00.000Z');
  });

  it('returns the stored text of the latest instant, compared across offsets', () => {
    const state = world({
      communications: [
        record(15, 'sms', 'Sent', { send_time: '2026-07-16T09:00:00.000Z' }),
        record(15, 'email', 'Sent', { send_time: '2026-07-16T05:30:00-04:00' }),
      ],
    });
    expect(deriveLastContact(state)).toBe('2026-07-16T05:30:00-04:00');
  });

  it('skips an absent or unparseable time rather than treating it as the epoch', () => {
    const state = world({
      communications: [
        record(15, 'sms', 'Sent', { send_time: 'yesterday afternoon' }),
        record(15, 'email', 'Sent', { send_time: null }),
        record(10, 'sms', 'Sent', { send_time: '2026-07-21T08:00:00.000Z' }),
      ],
    });
    expect(deriveLastContact(state)).toBe('2026-07-21T08:00:00.000Z');
  });

  it('gives null where no such event exists, which the cell renders as an em dash', () => {
    expect(deriveLastContact(world())).toBeNull();
    expect(
      deriveLastContact(world({ communications: [record(15, 'sms', 'Failed')] })),
    ).toBeNull();
    expect(
      deriveLastContact(world({ communications: [record(15, 'sms', 'Sent', { send_time: 'soon' })] })),
    ).toBeNull();
    expect(cellText(deriveLastContact(world()))).toBe(EM_DASH);
  });
});

// ---------------------------------------------------------------------------
// The next required action cell (Requirements 16.9, 17.4, 17.10)
// ---------------------------------------------------------------------------

describe('next required action cell', () => {
  it('(a) offers Verify Payment to a manager on a payment status', () => {
    for (const role of MANAGER_ROLES) {
      for (const status of ['Payment Reported', 'Verification Pending'] as const) {
        const state = world({ case: caseRow({ case_status: status }), viewerRole: role });
        expect(deriveNextRequiredAction(state)).toBe('Verify Payment');
      }
    }
    // Requirement 17.10 hides it from Agent_Role, which then sees the action it can take.
    for (const role of AGENT_ROLES) {
      const state = world({ case: caseRow({ case_status: 'Payment Reported' }), viewerRole: role });
      expect(deriveNextRequiredAction(state)).toBe('Record Customer Response');
    }
  });

  it('(b) offers Confirm Reinstatement to a manager on Reinstatement Pending', () => {
    const state = world({ case: caseRow({ case_status: 'Reinstatement Pending' }) });
    expect(deriveNextRequiredAction({ ...state, viewerRole: 'manager' })).toBe('Confirm Reinstatement');
    expect(deriveNextRequiredAction({ ...state, viewerRole: 'agent' })).toBe('Record Customer Response');
  });

  it('(c) offers Add Contact Information where no contact is contactable', () => {
    const worlds: CaseCommunicationState[] = [
      world({ contacts: [] }),
      world({ contacts: [phoneContact({ validation_status: 'invalid' })] }),
      world({ contacts: [emailContact({ authorization_status: 'Not Authorized' })] }),
    ];
    for (const state of worlds) {
      expect(deriveNextRequiredAction({ ...state, viewerRole: 'manager' })).toBe(
        'Add Contact Information',
      );
      expect(deriveNextRequiredAction({ ...state, viewerRole: 'agent' })).toBe(
        'Add Contact Information',
      );
    }
    // It sits behind (a) for a manager, and in front of everything an agent can see.
    const payment = world({
      case: caseRow({ case_status: 'Payment Reported' }),
      contacts: [phoneContact({ validation_status: 'invalid' })],
    });
    expect(deriveNextRequiredAction({ ...payment, viewerRole: 'manager' })).toBe('Verify Payment');
    expect(deriveNextRequiredAction({ ...payment, viewerRole: 'agent' })).toBe(
      'Add Contact Information',
    );
  });

  it('(d) offers Retry Failed Communication to a manager on a failed status', () => {
    const failed = world({
      communications: [record(1, 'sms', 'Failed')],
      businessDate: BUSINESS_DATE_1,
    });
    expect(deriveNextRequiredAction({ ...failed, viewerRole: 'super_admin' })).toBe(
      'Retry Failed Communication',
    );

    const partiallyFailed = world({
      communications: [record(1, 'sms', 'Failed'), record(1, 'email', 'Delivered')],
      businessDate: BUSINESS_DATE_1,
    });
    expect(deriveNextRequiredAction({ ...partiallyFailed, viewerRole: 'manager' })).toBe(
      'Retry Failed Communication',
    );

    // Hidden from Agent_Role, so an agent is offered an action they can actually take.
    for (const role of AGENT_ROLES) {
      const derived = deriveNextRequiredAction({ ...failed, viewerRole: role });
      expect(derived).toBe('Record Customer Response');
      expect(MANAGER_ONLY_ACTIONS).not.toContain(derived);
    }
  });

  it('(e) offers Call Customer on Manual Follow-up Required, to both role sets', () => {
    const state = world({ escalations: [UNCLEARED_ESCALATION] });
    expect(deriveNextRequiredAction({ ...state, viewerRole: 'manager' })).toBe('Call Customer');
    for (const role of AGENT_ROLES) {
      expect(deriveNextRequiredAction({ ...state, viewerRole: role })).toBe('Call Customer');
    }
  });

  it('(f) offers Send Reminder Now on an open case with no record for the current Touchpoint', () => {
    const state = world({
      scheduledSends: [{ touchpoint: 1, channel: 'sms' }],
      businessDate: BUSINESS_DATE_1,
    });
    expect(deriveCaseCommunicationStatus(state)).toBe('Scheduled');
    expect(deriveNextRequiredAction({ ...state, viewerRole: 'manager' })).toBe('Send Reminder Now');
    expect(deriveNextRequiredAction({ ...state, viewerRole: 'agent' })).toBe('Send Reminder Now');

    // A record for the current Touchpoint takes it off the table.
    const sent = world({
      communications: [record(1, 'sms', 'Sent')],
      businessDate: BUSINESS_DATE_1,
    });
    expect(deriveNextRequiredAction(sent)).not.toBe('Send Reminder Now');
  });

  it('(g) offers Mark Resolved on Reinstated, Cancelled, Invalid, and Duplicate', () => {
    for (const status of ['Invalid', 'Duplicate'] as const) {
      expect(deriveNextRequiredAction(world({ case: caseRow({ case_status: status }) }))).toBe(
        'Mark Resolved',
      );
    }
    // Reinstated and Cancelled with a stored action are not cleared rows, so they derive too.
    for (const status of ['Reinstated', 'Cancelled'] as const) {
      const state = world({
        case: caseRow({ case_status: status, next_required_action: 'Mark Resolved' }),
      });
      expect(deriveNextRequiredAction(state)).toBe('Mark Resolved');
    }
  });

  it('(h) falls back to Record Customer Response', () => {
    const state = world({
      case: caseRow({ case_status: 'Resolved', next_required_action: 'Mark Resolved' }),
    });
    expect(deriveNextRequiredAction(state)).toBe('Record Customer Response');
  });

  it('reads an action as cleared only on Reinstated, Cancelled, or Resolved (reading 5)', () => {
    expect([...ACTION_CLEARING_CASE_STATUSES]).toEqual(['Reinstated', 'Cancelled', 'Resolved']);
    for (const status of CASE_STATUSES) {
      const cleared = nextRequiredActionCleared(caseRow({ case_status: status, next_required_action: null }));
      expect(cleared).toBe(ACTION_CLEARING_CASE_STATUSES.includes(status as never));
    }
    // A stored value is never a cleared cell.
    expect(
      nextRequiredActionCleared(
        caseRow({ case_status: 'Reinstated', next_required_action: 'Mark Resolved' }),
      ),
    ).toBe(false);

    const clearedState = world({ case: caseRow({ case_status: 'Resolved', next_required_action: null }) });
    expect(deriveNextRequiredAction(clearedState)).toBeNull();
    expect(cellText(deriveNextRequiredAction(clearedState))).toBe(EM_DASH);

    // A freshly imported case has an action never set, so its cell is derived.
    const fresh = world({ case: caseRow({ case_status: 'Imported', next_required_action: null }) });
    expect(nextRequiredActionCleared(fresh.case)).toBe(false);
    expect(deriveNextRequiredAction(fresh)).not.toBeNull();
  });

  it('never derives Confirm Cancellation and always names one of the nine or nothing', () => {
    const recordSets: readonly CommunicationRecord[][] = [
      [],
      [record(1, 'sms', 'Delivered')],
      [record(1, 'sms', 'Failed')],
      [record(1, 'sms', 'Failed'), record(1, 'email', 'Sent')],
    ];
    const derived: (NextRequiredAction | null)[] = [];
    for (const status of CASE_STATUSES) {
      for (const role of [...MANAGER_ROLES, ...AGENT_ROLES]) {
        for (const communications of recordSets) {
          for (const contacts of [[phoneContact()], []]) {
            derived.push(
              deriveNextRequiredAction(
                world({
                  case: caseRow({ case_status: status, next_required_action: 'Call Customer' }),
                  contacts,
                  communications,
                  businessDate: BUSINESS_DATE_1,
                  viewerRole: role,
                }),
              ),
            );
          }
        }
      }
    }
    expect(derived.length).toBeGreaterThan(100);
    for (const action of derived) {
      expect(action).not.toBe('Confirm Cancellation');
      if (action !== null) expect(NEXT_REQUIRED_ACTIONS).toContain(action);
    }
  });

  it('treats an absent viewer role as the unrestricted Manager_Role view', () => {
    const state = world({ case: caseRow({ case_status: 'Payment Reported' }) });
    expect(deriveNextRequiredAction({ ...state, viewerRole: null })).toBe('Verify Payment');
    expect(deriveNextRequiredAction(state)).toBe('Verify Payment');
  });
});

// ---------------------------------------------------------------------------
// One entry point over one world (Requirements 15.9, 16.9, 16.10)
// ---------------------------------------------------------------------------

describe('row cells', () => {
  it('derives the four cells and the case value from one state bundle', () => {
    const state = world({
      case: caseRow({ case_status: 'Open', communication_status: 'Scheduled' }),
      communications: [
        record(5, 'sms', 'Failed', { send_time: '2026-07-26T14:00:00.000Z' }),
        record(5, 'email', 'Delivered', { send_time: '2026-07-26T14:05:00.000Z' }),
      ],
      scheduledSends: [
        { touchpoint: 5, channel: 'sms' },
        { touchpoint: 5, channel: 'email' },
        { touchpoint: 1, channel: 'sms' },
      ],
      businessDate: '2026-07-26',
      viewerRole: 'manager',
    });

    const cells = deriveRowCells(state);
    expect(cells).toEqual({
      communicationStatus: 'Partially Failed',
      smsStatus: 'Failed',
      emailStatus: 'Delivered',
      lastContact: '2026-07-26T14:05:00.000Z',
      nextRequiredAction: 'Retry Failed Communication',
    });

    // The list surface and the drawer cannot disagree: the cells are the same derivations.
    expect(cells.communicationStatus).toBe(deriveCaseCommunicationStatus(state));
    expect(cells.smsStatus).toBe(deriveSmsStatusCell(state));
    expect(cells.emailStatus).toBe(deriveEmailStatusCell(state));
    expect(cells.lastContact).toBe(deriveLastContact(state));
    expect(cells.nextRequiredAction).toBe(deriveNextRequiredAction(state));
  });

  it('derives a freshly imported case as Not Scheduled with two em dashes', () => {
    const state = world({
      case: caseRow({ case_status: 'Imported', communication_status: 'Not Scheduled' }),
      contacts: [],
      businessDate: BUSINESS_DATE_15,
    });
    const cells = deriveRowCells(state);
    expect(cells.communicationStatus).toBe('Not Scheduled');
    expect(cells.smsStatus).toBe('Not Scheduled');
    expect(cells.emailStatus).toBe('Not Scheduled');
    expect(cellText(cells.lastContact)).toBe(EM_DASH);
    expect(cells.nextRequiredAction).toBe('Add Contact Information');
  });

  it('is a pure derivation: the same world derives the same cells and mutates nothing', () => {
    const state = world({
      communications: [record(10, 'sms', 'Sent')],
      scheduledSends: [{ touchpoint: 5, channel: 'sms' }],
      escalations: [CLEARED_ESCALATION],
    });
    const snapshot = JSON.stringify(state);
    expect(deriveRowCells(state)).toEqual(deriveRowCells(state));
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Case_Status and Communication_Status stay two separate values (Req 15.3)
// ---------------------------------------------------------------------------

describe('the two statuses stay separate', () => {
  it('derives the same Communication_Status under every Case_Status', () => {
    const derived = new Set<CommunicationStatus>();
    for (const status of CASE_STATUSES) {
      derived.add(
        deriveCaseCommunicationStatus(
          world({
            case: caseRow({ case_status: status as CaseStatus }),
            communications: [record(15, 'sms', 'Delivered')],
          }),
        ),
      );
    }
    // Communication_Status reads the records, never the case state.
    expect([...derived]).toEqual(['Delivered']);
  });
});

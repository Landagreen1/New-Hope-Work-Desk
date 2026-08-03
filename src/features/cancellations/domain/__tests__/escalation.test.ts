// src/features/cancellations/domain/__tests__/escalation.test.ts
//
// Feature: policy-follow-up-renewals-cancellations, task 13.3 — escalation tests over the pure
// module `src/features/cancellations/domain/escalation.ts`.
//
// **Validates: Requirements 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8, 20.9, 20.10, 20.11,
// 20.12, 25.2**
//
// The module is pure: no React, no Supabase client, no provider, no clock, no randomness. The
// business date arrives as a parameter, the escalation time as `EscalationPlanOptions.now`, the
// clearing time as the `now` argument of `clearEscalations`, and every write path returns a
// *plan* rather than performing a write. Every case here therefore drives it with an in-memory
// world and asserts the plan, and the Requirement 20.10 cases apply the plan to a store that
// mirrors `unique (case_id, reason)` so a regression that wrote a second notification would fail
// loudly here rather than only in production.
//
// No mock is used and none is needed. `@/lib/permissions` is the real implementation over the
// real `APP_ROLES` values — the only way the Requirement 20.12 role gate is worth testing.
//
// No property test lives in this file. The design names exactly three `fast-check` properties
// and none of them is about escalation; Requirement 20 is a set of seven predicates, which the
// testing strategy covers by enumerated boundary cases.
//
// Two of the readings the implementation records are material enough that these cases pin them,
// because a later change could reverse either while everything else still passed:
//
//  1. **Requirement 20.7 is unsatisfiable as literally written.** It asks for at least one valid
//     row, "0 Contact_Recipient rows whose authorization status permits contact", and every
//     valid row carrying `Unknown` — but Requirements 10.9 and 10.10 make `Unknown` a status
//     that *does* permit contact, so clauses 2 and 3 can hold together only where there is no
//     valid row at all, contradicting clause 1. The implementation reads clause 2 as "0 rows are
//     `Authorized`". `authorizationUnknown` below tests that reading, and states at each case
//     that it is a reading rather than the literal text.
//  2. **Requirement 20.2** is read over `eligibleContacts` — valid, authorized, *and*
//     unsuppressed — rather than the literal "every valid authorized Contact_Recipient"; it
//     requires every eligible pair to carry a record for the Touchpoint; and it is existential
//     over Touchpoints. All three decisions are tested, each stated as a reading.

import { describe, expect, it } from 'vitest';

import { APP_ROLES, canAccessRenewals, isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import type { Touchpoint } from '../../render/renderMessage';
import type {
  CommunicationRecord,
  DeliveryResult,
  EscalationRecord,
  ScheduledSend,
} from '../communication-status';
import {
  ASSISTANCE_RESPONSE_TYPES,
  AUTHORIZED_STATUS,
  CANCELLATION_CASE_ENTITY_TYPE,
  CANCELLATION_FOLLOW_UP_NOTIFICATION_TYPE,
  ESCALATION_CLEARED_EVENT_TYPE,
  ESCALATION_RAISED_EVENT_TYPE,
  ESCALATION_REASONS,
  FOLLOW_UP_WINDOW_MS,
  MANUAL_FOLLOW_UP_STATUS,
  MAX_CONTACT_OUTCOME_NOTE_LENGTH,
  NO_DELIVERED_CONTACT_DAYS_REMAINING,
  PAYMENT_REPORTED_CASE_STATUS,
  UNKNOWN_AUTHORIZATION_STATUS,
  clearEscalations,
  escalationReasonHolds,
  evaluateCaseEscalations,
  evaluateEscalations,
  followUpAssignee,
  followUpDeadline,
  followUpRecipients,
  isEscalationReason,
  isValidContactRow,
  planEscalations,
} from '../escalation';
import type {
  ClearEscalationsPlan,
  ClearEscalationsResult,
  ClearEscalationsCaseUpdate,
  ContactOutcomeActor,
  EscalationAssignee,
  EscalationCase,
  EscalationCaseUpdate,
  EscalationContact,
  EscalationPlan,
  EscalationPlanOptions,
  EscalationPlanResult,
  EscalationReason,
  EscalationRecipientProfile,
  EscalationResponseRecord,
  EscalationState,
  NewEscalationRaise,
  ReopenedEscalationRaise,
  UserNotificationInsert,
} from '../escalation';
import { authorizationPermitsContact } from '../suppression';
import type { SuppressionRecord } from '../suppression';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CASE_ID = 'case-0001';
const EFFECTIVE_DATE = '2026-07-31';
/** 15 days before the effective date: no Touchpoint deadline of Requirement 20.5 has arrived. */
const BUSINESS_DATE_15 = '2026-07-16';
/** Exactly 1 day before the effective date: Requirement 20.5's evaluation date. */
const BUSINESS_DATE_1 = '2026-07-30';

const PHONE_CONTACT_ID = 'contact-phone-1';
const SECOND_PHONE_CONTACT_ID = 'contact-phone-2';
const EMAIL_CONTACT_ID = 'contact-email-1';
const PHONE_VALUE = '+13055550147';
const SECOND_PHONE_VALUE = '+13055559999';
const EMAIL_VALUE = 'ana@example.com';

const ESCALATION_TIME = new Date('2026-07-20T12:00:00.000Z');
const CLEAR_TIME = new Date('2026-07-21T18:30:00.000Z');

const ASSIGNEE: EscalationAssignee = {
  id: 'profile-employee-1',
  display_name: 'Lisandro Figueroa',
  is_active: true,
  is_deleted: false,
};

const MANAGER_PROFILES: readonly EscalationRecipientProfile[] = [
  { id: 'profile-manager-1', role: 'manager' },
  { id: 'profile-super-admin-1', role: 'super_admin' },
];

const AGENT_ACTOR: ContactOutcomeActor = { id: 'profile-agent-1', role: 'agent' };

/** The five roles holding Policy_Follow_Up_Workspace access (Requirement 20.12). */
const PERMITTED_CLEAR_ROLES: readonly AppRole[] = APP_ROLES.filter((role) => canAccessRenewals(role));
const REFUSED_CLEAR_ROLES: readonly AppRole[] = APP_ROLES.filter((role) => !canAccessRenewals(role));

function phoneContact(overrides: Partial<EscalationContact> = {}): EscalationContact {
  return {
    id: PHONE_CONTACT_ID,
    case_id: CASE_ID,
    channel: 'phone',
    normalized_value: PHONE_VALUE,
    validation_status: 'valid',
    authorization_status: 'Authorized',
    sms_suppressed: false,
    email_suppressed: false,
    ...overrides,
  };
}

function emailContact(overrides: Partial<EscalationContact> = {}): EscalationContact {
  return {
    id: EMAIL_CONTACT_ID,
    case_id: CASE_ID,
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
  contactId: string,
  touchpoint: Touchpoint,
  channel: 'sms' | 'email',
  deliveryResult: DeliveryResult,
  overrides: Partial<CommunicationRecord> = {},
): CommunicationRecord {
  return {
    id: `comm-${contactId}-${touchpoint}-${channel}-${deliveryResult}`,
    case_id: CASE_ID,
    contact_id: contactId,
    touchpoint,
    channel,
    delivery_result: deliveryResult,
    send_time: '2026-07-16T14:00:00.000Z',
    ...overrides,
  };
}

function caseRow(overrides: Partial<EscalationCase> = {}): EscalationCase {
  return {
    id: CASE_ID,
    case_status: 'Open',
    communication_status: 'Scheduled',
    cancellation_effective_date: EFFECTIVE_DATE,
    next_required_action: null,
    assistance_requested: false,
    assigned_to: null,
    follow_up_deadline: null,
    policy_number: 'POL-100238',
    customer_name: 'Ana Rivera',
    ...overrides,
  };
}

function world(overrides: Partial<EscalationState> = {}): EscalationState {
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

function uncleared(reason: string, overrides: Partial<EscalationRecord> = {}): EscalationRecord {
  return {
    id: `esc-${reason}`,
    case_id: CASE_ID,
    reason,
    raised_at: '2026-07-18T09:00:00.000Z',
    notified_at: '2026-07-18T09:00:00.000Z',
    cleared_at: null,
    ...overrides,
  };
}

function cleared(reason: string, overrides: Partial<EscalationRecord> = {}): EscalationRecord {
  return uncleared(reason, {
    cleared_at: '2026-07-19T16:00:00.000Z',
    cleared_by: 'profile-agent-1',
    ...overrides,
  });
}

function planOf(result: EscalationPlanResult): EscalationPlan {
  if (!result.ok) throw new Error(`expected a plan, got ${result.rejection.code}`);
  return result.plan;
}

function clearPlanOf(result: ClearEscalationsResult): ClearEscalationsPlan {
  if (!result.ok) throw new Error(`expected a clear plan, got ${result.rejection.code}`);
  return result.plan;
}

function rejectionOf(result: EscalationPlanResult | ClearEscalationsResult): string {
  if (result.ok) throw new Error('expected the plan to be refused');
  return result.rejection.code;
}

function newRaise(plan: EscalationPlan, reason: EscalationReason): NewEscalationRaise {
  const raise = plan.raises.find((entry) => entry.reason === reason);
  if (raise === undefined || raise.kind !== 'new') {
    throw new Error(`expected a new raise for ${reason}, got ${raise?.kind ?? 'nothing'}`);
  }
  return raise;
}

function reopenedRaise(plan: EscalationPlan, reason: EscalationReason): ReopenedEscalationRaise {
  const raise = plan.raises.find((entry) => entry.reason === reason);
  if (raise === undefined || raise.kind !== 'reopened') {
    throw new Error(`expected a reopened raise for ${reason}, got ${raise?.kind ?? 'nothing'}`);
  }
  return raise;
}

const PLAN_OPTIONS: EscalationPlanOptions = {
  now: ESCALATION_TIME,
  assignedEmployee: ASSIGNEE,
  managerProfiles: MANAGER_PROFILES,
};

// ---------------------------------------------------------------------------
// The reason vocabulary
// ---------------------------------------------------------------------------

describe('the seven escalation reasons', () => {
  it('lists the seven of Requirement 20 criteria 1 through 7, in criteria order', () => {
    expect([...ESCALATION_REASONS]).toEqual([
      'No Valid Contact',
      'All Channels Failed',
      'SMS Suppressed Without Email',
      'Customer Assistance Requested',
      'No Delivered Contact',
      'Payment Reported',
      'Authorization Unknown',
    ]);
    expect(new Set(ESCALATION_REASONS).size).toBe(7);
  });

  it('accepts the seven and refuses every other reason text', () => {
    for (const reason of ESCALATION_REASONS) expect(isEscalationReason(reason)).toBe(true);
    for (const value of ['no valid contact', 'Escalated', '', null, undefined, 7, {}]) {
      expect(isEscalationReason(value)).toBe(false);
    }
  });

  it('names the stored constants Requirement 20 fixes', () => {
    expect(MANUAL_FOLLOW_UP_STATUS).toBe('Manual Follow-up Required');
    expect(PAYMENT_REPORTED_CASE_STATUS).toBe('Payment Reported');
    expect(CANCELLATION_FOLLOW_UP_NOTIFICATION_TYPE).toBe('cancellation_follow_up');
    expect(CANCELLATION_CASE_ENTITY_TYPE).toBe('cancellation_case');
    expect(FOLLOW_UP_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(NO_DELIVERED_CONTACT_DAYS_REMAINING).toBe(1);
    expect(MAX_CONTACT_OUTCOME_NOTE_LENGTH).toBe(4000);
    expect([...ASSISTANCE_RESPONSE_TYPES]).toEqual(['Assistance requested', 'Callback requested']);
  });

  it('reads a valid contact row from validation status alone', () => {
    expect(isValidContactRow(phoneContact())).toBe(true);
    expect(isValidContactRow(phoneContact({ validation_status: 'invalid' }))).toBe(false);
    // Validity is not authorization and not suppression: both rows below are still valid.
    expect(isValidContactRow(phoneContact({ authorization_status: 'Unknown' }))).toBe(true);
    expect(isValidContactRow(phoneContact({ authorization_status: 'Not Authorized' }))).toBe(true);
    expect(isValidContactRow(phoneContact({ sms_suppressed: true }))).toBe(true);
    expect(isValidContactRow(emailContact())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Requirement 20.1: No Valid Contact
// ---------------------------------------------------------------------------

describe('No Valid Contact (Requirement 20.1)', () => {
  const holds = (state: EscalationState): boolean => escalationReasonHolds('No Valid Contact', state);

  it('holds with zero valid phone rows and zero valid email rows', () => {
    expect(holds(world({ contacts: [] }))).toBe(true);
    expect(
      holds(
        world({
          contacts: [
            phoneContact({ validation_status: 'invalid' }),
            emailContact({ validation_status: 'invalid' }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it('does not hold where any row is valid, whatever its authorization or suppression', () => {
    expect(holds(world())).toBe(false);
    expect(holds(world({ contacts: [phoneContact({ sms_suppressed: true })] }))).toBe(false);
    expect(holds(world({ contacts: [emailContact({ authorization_status: 'Not Authorized' })] }))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 20.2: All Channels Failed
// ---------------------------------------------------------------------------

describe('All Channels Failed (Requirement 20.2)', () => {
  const holds = (state: EscalationState): boolean =>
    escalationReasonHolds('All Channels Failed', state);

  it('holds where every eligible pair failed for one Touchpoint and nothing delivered', () => {
    const state = world({
      communications: [
        record(PHONE_CONTACT_ID, 5, 'sms', 'Failed'),
        record(EMAIL_CONTACT_ID, 5, 'email', 'Failed'),
      ],
    });
    expect(holds(state)).toBe(true);
  });

  it('does not hold where a record of that Touchpoint delivered', () => {
    const state = world({
      communications: [
        record(PHONE_CONTACT_ID, 5, 'sms', 'Failed'),
        record(EMAIL_CONTACT_ID, 5, 'email', 'Delivered'),
      ],
    });
    expect(holds(state)).toBe(false);
  });

  it('does not hold with zero records or zero eligible pairs', () => {
    expect(holds(world())).toBe(false);
    expect(
      holds(
        world({
          contacts: [phoneContact({ validation_status: 'invalid' })],
          communications: [record(PHONE_CONTACT_ID, 5, 'sms', 'Failed')],
        }),
      ),
    ).toBe(false);
  });

  it('does not hold while an eligible pair has no record for the Touchpoint (reading 3)', () => {
    // A pair with no record is a send still pending, not a failure. The email contact is
    // eligible and carries nothing, so the reason waits.
    const state = world({ communications: [record(PHONE_CONTACT_ID, 5, 'sms', 'Failed')] });
    expect(holds(state)).toBe(false);

    // With email not an enabled channel — no email credentials under Requirement 12.13 — the
    // email pair does not exist and the SMS failure is the whole picture.
    expect(holds({ ...state, enabledChannels: ['sms'] })).toBe(true);
  });

  it('reads the contact set as the eligible set, not every valid authorized row (reading 2)', () => {
    // A suppressed row is valid and authorized yet can never carry a record (Requirements 21.3,
    // 21.4), so requiring a failed record from it would make the reason unreachable for exactly
    // the cases that need a person. This is a reading of "every valid authorized
    // Contact_Recipient", not the literal text.
    const suppressedByFlag = world({
      contacts: [
        phoneContact(),
        phoneContact({
          id: SECOND_PHONE_CONTACT_ID,
          normalized_value: SECOND_PHONE_VALUE,
          sms_suppressed: true,
        }),
      ],
      communications: [record(PHONE_CONTACT_ID, 5, 'sms', 'Failed')],
    });
    expect(holds(suppressedByFlag)).toBe(true);

    // The same holds where the suppression lives in `cancellation_suppressions` rather than on
    // the contact row.
    const suppressions: SuppressionRecord[] = [
      { id: 'sup-1', channel: 'sms', normalized_value: SECOND_PHONE_VALUE },
    ];
    const suppressedByValue = world({
      contacts: [
        phoneContact(),
        phoneContact({ id: SECOND_PHONE_CONTACT_ID, normalized_value: SECOND_PHONE_VALUE }),
      ],
      communications: [record(PHONE_CONTACT_ID, 5, 'sms', 'Failed')],
      suppressions,
    });
    expect(holds(suppressedByValue)).toBe(true);

    // An unsuppressed second phone row with no record does keep the reason waiting.
    const unsuppressed = world({
      contacts: [
        phoneContact(),
        phoneContact({ id: SECOND_PHONE_CONTACT_ID, normalized_value: SECOND_PHONE_VALUE }),
      ],
      communications: [record(PHONE_CONTACT_ID, 5, 'sms', 'Failed')],
      enabledChannels: ['sms'],
    });
    expect(holds(unsuppressed)).toBe(false);
  });

  it('is existential over Touchpoints (reading 4)', () => {
    // "for the same Touchpoint" binds a Touchpoint rather than naming the current one, and that
    // is also the only monotone reading: a raise is a one-time event cleared only by Requirement
    // 20.12, so a later Touchpoint delivering must not silently un-raise the reason.
    const state = world({
      contacts: [phoneContact()],
      enabledChannels: ['sms'],
      communications: [
        record(PHONE_CONTACT_ID, 15, 'sms', 'Failed'),
        record(PHONE_CONTACT_ID, 5, 'sms', 'Delivered'),
      ],
    });
    expect(holds(state)).toBe(true);
  });

  it('reads the most recent record of a pair, not any record of it', () => {
    const failedLast = world({
      contacts: [phoneContact()],
      enabledChannels: ['sms'],
      communications: [
        record(PHONE_CONTACT_ID, 1, 'sms', 'Sent', { send_time: '2026-07-30T09:00:00.000Z' }),
        record(PHONE_CONTACT_ID, 1, 'sms', 'Failed', { send_time: '2026-07-30T10:00:00.000Z' }),
      ],
    });
    expect(holds(failedLast)).toBe(true);

    const sentLast = world({
      contacts: [phoneContact()],
      enabledChannels: ['sms'],
      communications: [
        record(PHONE_CONTACT_ID, 1, 'sms', 'Failed', { send_time: '2026-07-30T09:00:00.000Z' }),
        record(PHONE_CONTACT_ID, 1, 'sms', 'Sent', { send_time: '2026-07-30T10:00:00.000Z' }),
      ],
    });
    expect(holds(sentLast)).toBe(false);
  });

  it('pairs a record with the contact it was addressed to', () => {
    // A record carrying another contact's id covers no pair of this contact.
    const state = world({
      contacts: [phoneContact()],
      enabledChannels: ['sms'],
      communications: [record(SECOND_PHONE_CONTACT_ID, 5, 'sms', 'Failed')],
    });
    expect(holds(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requirement 20.3: SMS Suppressed Without Email
// ---------------------------------------------------------------------------

describe('SMS Suppressed Without Email (Requirement 20.3)', () => {
  const holds = (state: EscalationState): boolean =>
    escalationReasonHolds('SMS Suppressed Without Email', state);

  it('holds with every phone row SMS suppressed and zero valid email rows', () => {
    expect(holds(world({ contacts: [phoneContact({ sms_suppressed: true })] }))).toBe(true);
    expect(
      holds(
        world({
          contacts: [
            phoneContact({ sms_suppressed: true }),
            phoneContact({
              id: SECOND_PHONE_CONTACT_ID,
              normalized_value: SECOND_PHONE_VALUE,
              sms_suppressed: true,
            }),
          ],
        }),
      ),
    ).toBe(true);
    // An invalid email row is not a valid email row, so it does not block the reason.
    expect(
      holds(
        world({
          contacts: [
            phoneContact({ sms_suppressed: true }),
            emailContact({ validation_status: 'invalid' }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it('reads the suppression list as well as the contact flag', () => {
    const suppressions: SuppressionRecord[] = [
      { id: 'sup-1', channel: 'sms', normalized_value: PHONE_VALUE },
    ];
    expect(holds(world({ contacts: [phoneContact()], suppressions }))).toBe(true);
    // A cleared suppression row suppresses nothing.
    expect(
      holds(
        world({
          contacts: [phoneContact()],
          suppressions: [{ ...suppressions[0], cleared_at: '2026-07-19T00:00:00.000Z' }],
        }),
      ),
    ).toBe(false);
  });

  it('does not hold where a valid email row exists or a phone row is unsuppressed', () => {
    expect(
      holds(world({ contacts: [phoneContact({ sms_suppressed: true }), emailContact()] })),
    ).toBe(false);
    expect(
      holds(
        world({
          contacts: [
            phoneContact({ sms_suppressed: true }),
            phoneContact({ id: SECOND_PHONE_CONTACT_ID, normalized_value: SECOND_PHONE_VALUE }),
          ],
        }),
      ),
    ).toBe(false);
  });

  it('scopes "every Contact_Recipient" to the phone rows over a non-empty set (reading 5)', () => {
    // `sms_suppressed` exists on an email row too, so the literal reading would let an
    // unsuppressed email row block the reason. Requirement 15.8 states the same test
    // channel-scoped, and this follows it.
    const state = world({
      contacts: [
        phoneContact({ sms_suppressed: true }),
        emailContact({ validation_status: 'invalid', sms_suppressed: false }),
      ],
    });
    expect(state.contacts?.every((contact) => contact.sms_suppressed)).toBe(false);
    expect(holds(state)).toBe(true);

    // At least one phone row is required: a case with no phone contact at all is Requirement
    // 20.1's No Valid Contact, and naming it here would describe a suppression that does not
    // exist.
    const noPhone = world({ contacts: [emailContact({ validation_status: 'invalid' })] });
    expect(holds(noPhone)).toBe(false);
    expect(escalationReasonHolds('No Valid Contact', noPhone)).toBe(true);
    expect(holds(world({ contacts: [] }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requirement 20.4: Customer Assistance Requested
// ---------------------------------------------------------------------------

describe('Customer Assistance Requested (Requirement 20.4)', () => {
  const holds = (state: EscalationState): boolean =>
    escalationReasonHolds('Customer Assistance Requested', state);

  it('holds for each response type Requirement 21.7 promotes to an assistance request', () => {
    for (const responseType of ASSISTANCE_RESPONSE_TYPES) {
      const responses: EscalationResponseRecord[] = [
        { id: 'resp-1', case_id: CASE_ID, response_time: '2026-07-19T12:00:00.000Z', response_type: responseType },
      ];
      expect(holds(world({ responses }))).toBe(true);
    }
  });

  it('holds on the stored flag alone, so a caller that read no response rows still escalates', () => {
    expect(holds(world({ case: caseRow({ assistance_requested: true }) }))).toBe(true);
  });

  it('does not hold for another response type or with nothing recorded', () => {
    expect(holds(world())).toBe(false);
    expect(
      holds(
        world({
          responses: [
            { id: 'resp-2', case_id: CASE_ID, response_time: '2026-07-19T12:00:00.000Z', response_type: 'Payment reported' },
          ],
        }),
      ),
    ).toBe(false);
    expect(holds(world({ case: caseRow({ assistance_requested: null }) }))).toBe(false);
    expect(holds(world({ responses: [{ id: 'resp-3', case_id: CASE_ID, response_type: null }] }))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 20.5: No Delivered Contact
// ---------------------------------------------------------------------------

describe('No Delivered Contact (Requirement 20.5)', () => {
  const holds = (state: EscalationState): boolean =>
    escalationReasonHolds('No Delivered Contact', state);

  it('holds one day before the effective date on an open case with nothing delivered', () => {
    for (const status of ['Imported', 'Open'] as const) {
      const state = world({
        case: caseRow({ case_status: status }),
        businessDate: BUSINESS_DATE_1,
        communications: [record(PHONE_CONTACT_ID, 1, 'sms', 'Failed')],
      });
      expect(holds(state)).toBe(true);
    }
    // A sent record is not a delivered record.
    expect(
      holds(
        world({
          businessDate: BUSINESS_DATE_1,
          communications: [record(PHONE_CONTACT_ID, 1, 'sms', 'Sent')],
        }),
      ),
    ).toBe(true);
  });

  it('is exactly one day, not one day or fewer (reading 6)', () => {
    // The criterion names "the calendar date exactly 1 day before the cancellation effective
    // date", so an evaluation two days out, on the effective date, or after it does not raise.
    expect(holds(world({ businessDate: '2026-07-29' }))).toBe(false);
    expect(holds(world({ businessDate: EFFECTIVE_DATE }))).toBe(false);
    expect(holds(world({ businessDate: '2026-08-05' }))).toBe(false);
    expect(holds(world({ businessDate: BUSINESS_DATE_15 }))).toBe(false);
  });

  it('does not hold on a closed case, on a delivered record, or with no date to compare', () => {
    expect(
      holds(world({ case: caseRow({ case_status: 'Payment Reported' }), businessDate: BUSINESS_DATE_1 })),
    ).toBe(false);
    expect(
      holds(
        world({
          businessDate: BUSINESS_DATE_1,
          communications: [record(PHONE_CONTACT_ID, 5, 'sms', 'Delivered')],
        }),
      ),
    ).toBe(false);
    expect(holds(world({ businessDate: null }))).toBe(false);
    expect(
      holds(
        world({
          case: caseRow({ cancellation_effective_date: null }),
          businessDate: BUSINESS_DATE_1,
        }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requirement 20.6: Payment Reported
// ---------------------------------------------------------------------------

describe('Payment Reported (Requirement 20.6)', () => {
  it('holds exactly where Case_Status reached Payment Reported', () => {
    expect(
      escalationReasonHolds('Payment Reported', world({ case: caseRow({ case_status: 'Payment Reported' }) })),
    ).toBe(true);
    for (const status of ['Imported', 'Open', 'Verification Pending', 'Reinstated', 'Resolved'] as const) {
      expect(escalationReasonHolds('Payment Reported', world({ case: caseRow({ case_status: status }) }))).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Requirement 20.7: Authorization Unknown
// ---------------------------------------------------------------------------

describe('Authorization Unknown (Requirement 20.7)', () => {
  const holds = (state: EscalationState): boolean =>
    escalationReasonHolds('Authorization Unknown', state);

  it('is unsatisfiable as literally written, so the middle clause reads "none Authorized"', () => {
    // Clause 2 of the criterion is "0 Contact_Recipient rows whose authorization status permits
    // contact" and clause 3 is "every valid row carries an unknown authorization status". But
    // `Unknown` *does* permit contact under Requirements 10.9 and 10.10, so a world satisfying
    // clause 3 with at least one valid row (clause 1) always breaks clause 2 read literally.
    expect(authorizationPermitsContact(UNKNOWN_AUTHORIZATION_STATUS)).toBe(true);
    expect(AUTHORIZED_STATUS).toBe('Authorized');

    const state = world({ contacts: [phoneContact({ authorization_status: 'Unknown' })] });
    const permitting = (state.contacts ?? []).filter((contact) =>
      authorizationPermitsContact(contact.authorization_status),
    );
    // The literal clause 2 fails here — one row permits contact — yet clauses 1 and 3 hold.
    expect(permitting).toHaveLength(1);
    // This is the implemented reading, not the literal text: no row is `Authorized`.
    expect(holds(state)).toBe(true);
  });

  it('holds with at least one valid row, none Authorized, and every valid row Unknown', () => {
    expect(
      holds(
        world({
          contacts: [
            phoneContact({ authorization_status: 'Unknown' }),
            emailContact({ authorization_status: 'Unknown' }),
          ],
        }),
      ),
    ).toBe(true);
    // An invalid row outside the third clause's scope does not have to be Unknown.
    expect(
      holds(
        world({
          contacts: [
            phoneContact({ authorization_status: 'Unknown' }),
            emailContact({ validation_status: 'invalid', authorization_status: 'Not Authorized' }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it('keeps the quantifier scopes of the criterion as written', () => {
    // The middle clause is over *every* contact row, so an invalid Authorized row blocks it.
    expect(
      holds(
        world({
          contacts: [
            phoneContact({ authorization_status: 'Unknown' }),
            emailContact({ validation_status: 'invalid', authorization_status: 'Authorized' }),
          ],
        }),
      ),
    ).toBe(false);
    // The third clause is over the valid rows, so a valid Not Authorized row blocks it.
    expect(
      holds(
        world({
          contacts: [
            phoneContact({ authorization_status: 'Unknown' }),
            emailContact({ authorization_status: 'Not Authorized' }),
          ],
        }),
      ),
    ).toBe(false);
  });

  it('does not hold without a valid row', () => {
    expect(holds(world({ contacts: [] }))).toBe(false);
    expect(
      holds(
        world({
          contacts: [phoneContact({ validation_status: 'invalid', authorization_status: 'Unknown' })],
        }),
      ),
    ).toBe(false);
    expect(holds(world())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The evaluation over one case
// ---------------------------------------------------------------------------

describe('evaluating one Cancellation_Case', () => {
  it('returns every reason that holds, in Requirement 20 criteria order', () => {
    const state = world({
      case: caseRow({ case_status: 'Payment Reported', assistance_requested: true }),
      contacts: [],
    });
    expect(evaluateCaseEscalations(state)).toEqual([
      'No Valid Contact',
      'Customer Assistance Requested',
      'Payment Reported',
    ]);
  });

  it('returns nothing where no reason holds', () => {
    expect(evaluateCaseEscalations(world())).toEqual([]);
  });

  it('agrees with the positional entry point of the design', () => {
    const state = world({
      case: caseRow({ case_status: 'Payment Reported' }),
      contacts: [phoneContact({ sms_suppressed: true })],
      communications: [record(PHONE_CONTACT_ID, 5, 'sms', 'Failed')],
      responses: [
        { id: 'resp-1', case_id: CASE_ID, response_time: '2026-07-19T12:00:00.000Z', response_type: 'Callback requested' },
      ],
      businessDate: BUSINESS_DATE_1,
    });
    expect(
      evaluateEscalations(
        state.case,
        state.contacts ?? [],
        state.communications ?? [],
        state.responses ?? [],
        state.businessDate,
        state.suppressions ?? [],
      ),
    ).toEqual(evaluateCaseEscalations(state));
  });

  it('defaults the trailing parameters to the unrestricted case', () => {
    const contacts = [phoneContact()];
    const communications = [record(PHONE_CONTACT_ID, 5, 'sms', 'Failed')];
    // Both channels enabled by default, and this case holds no email contact, so the single SMS
    // pair decides All Channels Failed.
    expect(
      evaluateEscalations(caseRow(), contacts, communications, [], BUSINESS_DATE_15),
    ).toEqual(['All Channels Failed']);
  });
});

// ---------------------------------------------------------------------------
// The follow-up deadline (Requirement 20.8)
// ---------------------------------------------------------------------------

describe('follow-up deadline', () => {
  it('takes escalation time + 24 hours where that is the earlier instant', () => {
    expect(followUpDeadline(ESCALATION_TIME, EFFECTIVE_DATE)).toBe('2026-07-21T12:00:00.000Z');
  });

  it('clamps to the effective date where that is the earlier instant', () => {
    const late = new Date('2026-07-30T18:00:00.000Z');
    expect(followUpDeadline(late, EFFECTIVE_DATE)).toBe('2026-07-31T00:00:00.000Z');
  });

  it('leaves the window unclamped where the effective date is absent or unparseable', () => {
    expect(followUpDeadline(ESCALATION_TIME, null)).toBe('2026-07-21T12:00:00.000Z');
    expect(followUpDeadline(ESCALATION_TIME, undefined)).toBe('2026-07-21T12:00:00.000Z');
    expect(followUpDeadline(ESCALATION_TIME, 'July 31, 2026')).toBe('2026-07-21T12:00:00.000Z');
  });

  it('reads as overdue where the escalation time is already past the effective date', () => {
    const afterCancellation = new Date('2026-08-02T09:00:00.000Z');
    const deadline = followUpDeadline(afterCancellation, EFFECTIVE_DATE);
    expect(deadline).toBe('2026-07-31T00:00:00.000Z');
    expect(Date.parse(deadline)).toBeLessThan(afterCancellation.getTime());
  });

  it('accepts the M/D/YYYY effective date the importer also parses', () => {
    expect(followUpDeadline(new Date('2026-07-30T18:00:00.000Z'), '7/31/2026')).toBe(
      '2026-07-31T00:00:00.000Z',
    );
  });
});

// ---------------------------------------------------------------------------
// Notification recipients (Requirements 20.8, 20.9)
// ---------------------------------------------------------------------------

describe('notification recipients', () => {
  it('notifies the assigned employee where present, active, and not deleted', () => {
    expect(followUpAssignee(ASSIGNEE)).toBe(ASSIGNEE);
    expect(followUpRecipients(ASSIGNEE, MANAGER_PROFILES)).toEqual({
      rule: 'assigned_employee',
      profileIds: [ASSIGNEE.id],
    });
    // Absent activity columns read as present, active, and not deleted.
    const bare: EscalationAssignee = { id: 'profile-employee-2' };
    expect(followUpRecipients(bare, MANAGER_PROFILES)).toEqual({
      rule: 'assigned_employee',
      profileIds: ['profile-employee-2'],
    });
  });

  it('falls back to the Manager_Role fan-out where the assignee fails the test', () => {
    const failing: readonly (EscalationAssignee | null | undefined)[] = [
      null,
      undefined,
      { ...ASSIGNEE, is_active: false },
      { ...ASSIGNEE, is_deleted: true },
      { ...ASSIGNEE, id: '   ' },
    ];
    for (const assignee of failing) {
      expect(followUpAssignee(assignee)).toBeNull();
      expect(followUpRecipients(assignee, MANAGER_PROFILES)).toEqual({
        rule: 'manager_role',
        profileIds: ['profile-manager-1', 'profile-super-admin-1'],
      });
    }
  });

  it('creates exactly one recipient per Manager_Role profile and no one else', () => {
    const supplied: readonly EscalationRecipientProfile[] = [
      { id: 'profile-manager-1', role: 'manager' },
      { id: 'profile-manager-1', role: 'manager' },
      { id: 'profile-super-admin-1', role: 'super_admin' },
      { id: 'profile-agent-1', role: 'agent' },
      { id: 'profile-cs-1', role: 'customer_service' },
      { id: 'profile-sales-sup-1', role: 'sales_supervisor' },
      { id: '  ', role: 'manager' },
    ];
    const { rule, profileIds } = followUpRecipients(null, supplied);
    expect(rule).toBe('manager_role');
    expect(profileIds).toEqual(['profile-manager-1', 'profile-super-admin-1']);
    // Every notified profile holds Manager_Role, read through the real role predicate.
    const notifiedRoles = supplied
      .filter((entry) => profileIds.includes(entry.id))
      .map((entry) => entry.role);
    expect(notifiedRoles.length).toBeGreaterThan(0);
    for (const role of notifiedRoles) expect(isBroadManagerRole(role)).toBe(true);
  });

  it('notifies nobody where no assignee and no Manager_Role profile was supplied', () => {
    expect(followUpRecipients(null, [])).toEqual({ rule: 'manager_role', profileIds: [] });
    expect(followUpRecipients(null)).toEqual({ rule: 'manager_role', profileIds: [] });
  });
});

// ---------------------------------------------------------------------------
// The raise plan (Requirements 20.8, 20.9, 20.10)
// ---------------------------------------------------------------------------

/** Compile-time guarantee: the shape forbids the key outright. */
type ForbidsKey<TShape, TKey extends string> = TKey extends keyof TShape ? false : true;
const RAISE_UPDATE_FORBIDS_CASE_STATUS: ForbidsKey<EscalationCaseUpdate, 'case_status'> = true;
const RAISE_UPDATE_FORBIDS_ASSIGNMENT: ForbidsKey<EscalationCaseUpdate, 'assigned_to'> = true;
const CLEAR_UPDATE_FORBIDS_CASE_STATUS: ForbidsKey<ClearEscalationsCaseUpdate, 'case_status'> = true;

describe('the raise plan', () => {
  /** A world whose only reason is Payment Reported (Requirement 20.6). */
  const paymentReported = (overrides: Partial<EscalationState> = {}): EscalationState =>
    world({ case: caseRow({ case_status: 'Payment Reported' }), ...overrides });

  it('plans a new raise carrying the insert, the stamp, and the notifications', () => {
    const plan = planOf(planEscalations(paymentReported(), PLAN_OPTIONS));
    expect(plan.caseId).toBe(CASE_ID);
    expect(plan.reasons).toEqual(['Payment Reported']);
    expect(plan.alreadyRaised).toEqual([]);
    expect(plan.raises).toHaveLength(1);

    const raise = newRaise(plan, 'Payment Reported');
    expect(raise.insert).toEqual({
      case_id: CASE_ID,
      reason: 'Payment Reported',
      raised_at: '2026-07-20T12:00:00.000Z',
    });
    expect(raise.raisedAt).toBe('2026-07-20T12:00:00.000Z');
    expect(raise.notifiedAt).toBe(raise.raisedAt);
    expect(raise.followUpDeadline).toBe('2026-07-21T12:00:00.000Z');
    expect(raise.recipients).toBe('assigned_employee');
    expect(raise.notifications).toHaveLength(1);
    const notification = raise.notifications[0];
    expect(notification.recipient_profile_id).toBe(ASSIGNEE.id);
    expect(notification.notification_type).toBe(CANCELLATION_FOLLOW_UP_NOTIFICATION_TYPE);
    expect(notification.title).toBe('Cancellation follow-up required: Payment Reported');
    expect(notification.entity_type).toBe(CANCELLATION_CASE_ENTITY_TYPE);
    expect(notification.entity_id).toBe(CASE_ID);
    expect(notification.message).toContain('Ana Rivera');
    expect(notification.message).toContain('POL-100238');
    expect(notification.message).toContain(raise.followUpDeadline);
    expect(raise.event).toEqual({
      case_id: CASE_ID,
      actor_id: null,
      event_type: ESCALATION_RAISED_EVENT_TYPE,
      event_time: raise.raisedAt,
      detail: {
        reason: 'Payment Reported',
        raised_at: raise.raisedAt,
        follow_up_deadline: raise.followUpDeadline,
        recipients: 'assigned_employee',
        notified_profile_ids: [ASSIGNEE.id],
        reopened: false,
      },
    });
  });

  it('writes one case update carrying no Case_Status and no assignment', () => {
    expect(RAISE_UPDATE_FORBIDS_CASE_STATUS).toBe(true);
    expect(RAISE_UPDATE_FORBIDS_ASSIGNMENT).toBe(true);

    const plan = planOf(planEscalations(paymentReported(), PLAN_OPTIONS));
    expect(plan.caseUpdate).toEqual({
      case_id: CASE_ID,
      communication_status: MANUAL_FOLLOW_UP_STATUS,
      follow_up_deadline: '2026-07-21T12:00:00.000Z',
      deadlineChanged: true,
    });
    expect(Object.keys(plan.caseUpdate ?? {}).sort()).toEqual([
      'case_id',
      'communication_status',
      'deadlineChanged',
      'follow_up_deadline',
    ]);
    expect('case_status' in (plan.caseUpdate ?? {})).toBe(false);
    expect('assigned_to' in (plan.caseUpdate ?? {})).toBe(false);
  });

  it('reports an unchanged deadline where the stored value already matches', () => {
    const plan = planOf(
      planEscalations(
        paymentReported({
          case: caseRow({
            case_status: 'Payment Reported',
            follow_up_deadline: '2026-07-21T12:00:00.000Z',
          }),
        }),
        PLAN_OPTIONS,
      ),
    );
    expect(plan.caseUpdate?.deadlineChanged).toBe(false);
  });

  it('fans out to Manager_Role where the case has no usable assignee (Requirement 20.9)', () => {
    const plan = planOf(
      planEscalations(paymentReported(), {
        now: ESCALATION_TIME,
        assignedEmployee: { ...ASSIGNEE, is_deleted: true },
        managerProfiles: MANAGER_PROFILES,
      }),
    );
    const raise = newRaise(plan, 'Payment Reported');
    expect(raise.recipients).toBe('manager_role');
    expect(raise.notifications.map((row) => row.recipient_profile_id)).toEqual([
      'profile-manager-1',
      'profile-super-admin-1',
    ]);
    for (const notification of raise.notifications) {
      expect(notification.notification_type).toBe(CANCELLATION_FOLLOW_UP_NOTIFICATION_TYPE);
      expect(notification.entity_type).toBe(CANCELLATION_CASE_ENTITY_TYPE);
      expect(notification.entity_id).toBe(CASE_ID);
    }
    expect(raise.event.detail.notified_profile_ids).toEqual([
      'profile-manager-1',
      'profile-super-admin-1',
    ]);
  });

  it('drops an absent policy number and customer name instead of rendering them', () => {
    const plan = planOf(
      planEscalations(
        paymentReported({
          case: caseRow({ case_status: 'Payment Reported', policy_number: null, customer_name: null }),
        }),
        PLAN_OPTIONS,
      ),
    );
    const message = newRaise(plan, 'Payment Reported').notifications[0].message;
    expect(message).not.toContain('null');
    expect(message).not.toContain('undefined');
    expect(message).toContain('Payment Reported');
  });

  it('plans one raise per reason, in criteria order', () => {
    const plan = planOf(
      planEscalations(
        world({ case: caseRow({ case_status: 'Payment Reported', assistance_requested: true }), contacts: [] }),
        PLAN_OPTIONS,
      ),
    );
    expect(plan.reasons).toEqual([
      'No Valid Contact',
      'Customer Assistance Requested',
      'Payment Reported',
    ]);
    expect(plan.raises.map((raise) => raise.reason)).toEqual(plan.reasons);
    for (const raise of plan.raises) expect(raise.kind).toBe('new');
  });

  it('reopens a cleared row and notifies nobody (Requirement 20.10, reading 9)', () => {
    const plan = planOf(
      planEscalations(
        paymentReported({ escalations: [cleared('Payment Reported')] }),
        PLAN_OPTIONS,
      ),
    );
    expect(plan.alreadyRaised).toEqual([]);
    const raise = reopenedRaise(plan, 'Payment Reported');
    expect(raise.reopen).toEqual({
      escalation_id: 'esc-Payment Reported',
      case_id: CASE_ID,
      reason: 'Payment Reported',
      raised_at: '2026-07-20T12:00:00.000Z',
      cleared_at: null,
      cleared_by: null,
    });
    // The pair has already had its one notification, and Requirement 20.10 caps it there.
    expect(raise.notifications).toEqual([]);
    expect(raise.event.detail.reopened).toBe(true);
    expect(raise.event.detail.recipients).toBeNull();
    expect(raise.event.detail.notified_profile_ids).toEqual([]);
    // The reopen still restores the Requirement 20.11 hold on Communication_Status.
    expect(plan.caseUpdate?.communication_status).toBe(MANUAL_FOLLOW_UP_STATUS);
  });

  it('reports an already uncleared reason and writes nothing at all', () => {
    const stored = '2026-07-18T09:00:00.000Z';
    const plan = planOf(
      planEscalations(
        paymentReported({
          case: caseRow({ case_status: 'Payment Reported', follow_up_deadline: stored }),
          escalations: [uncleared('Payment Reported')],
        }),
        PLAN_OPTIONS,
      ),
    );
    expect(plan.reasons).toEqual(['Payment Reported']);
    expect(plan.alreadyRaised).toEqual(['Payment Reported']);
    expect(plan.raises).toEqual([]);
    // Requirement 20.8 sets the deadline when Communication_Status *becomes* Manual Follow-up
    // Required, so a repeat evaluation must not push it forward.
    expect(plan.caseUpdate).toBeNull();
  });

  it('splits a mixed set into raises and already-raised reasons', () => {
    const plan = planOf(
      planEscalations(
        world({
          case: caseRow({ case_status: 'Payment Reported', assistance_requested: true }),
          contacts: [],
          escalations: [uncleared('No Valid Contact'), cleared('Payment Reported')],
        }),
        PLAN_OPTIONS,
      ),
    );
    expect(plan.alreadyRaised).toEqual(['No Valid Contact']);
    expect(plan.raises.map((raise) => `${raise.kind}:${raise.reason}`)).toEqual([
      'new:Customer Assistance Requested',
      'reopened:Payment Reported',
    ]);
    expect(plan.caseUpdate).not.toBeNull();
  });

  it('plans nothing where no reason holds', () => {
    const plan = planOf(planEscalations(world(), PLAN_OPTIONS));
    expect(plan.reasons).toEqual([]);
    expect(plan.raises).toEqual([]);
    expect(plan.alreadyRaised).toEqual([]);
    expect(plan.caseUpdate).toBeNull();
  });

  it('refuses to plan without the stored case id', () => {
    expect(rejectionOf(planEscalations(paymentReported({ case: caseRow({ id: null }) }), PLAN_OPTIONS))).toBe(
      'case_id_required',
    );
    expect(
      rejectionOf(planEscalations(paymentReported({ case: caseRow({ id: '   ' }) }), PLAN_OPTIONS)),
    ).toBe('case_id_required');
  });
});

// ---------------------------------------------------------------------------
// One notification per (case, reason) pair (Requirement 20.10)
// ---------------------------------------------------------------------------

/**
 * An in-memory world that mirrors the storage contract: `cancellation_escalations` is
 * `unique (case_id, reason)`, so a second insert for a pair changes nothing, which is what caps
 * the notifications at one.
 */
interface StoredWorld {
  case: EscalationCase;
  rows: EscalationRecord[];
  notifications: UserNotificationInsert[];
  nextId: number;
}

function storedWorld(caseOverrides: Partial<EscalationCase> = {}): StoredWorld {
  return { case: caseRow(caseOverrides), rows: [], notifications: [], nextId: 1 };
}

function stateOf(store: StoredWorld, overrides: Partial<EscalationState> = {}): EscalationState {
  return world({ case: store.case, escalations: store.rows, ...overrides });
}

/** The documented write order: insert on conflict do nothing, then notify only if it inserted. */
function applyRaisePlan(store: StoredWorld, plan: EscalationPlan): void {
  for (const raise of plan.raises) {
    if (raise.kind === 'new') {
      const conflict = store.rows.some((row) => row.reason === raise.insert.reason);
      if (conflict) continue; // `returning id` returned no row: another evaluation won the race
      const inserted: EscalationRecord = {
        id: `esc-${store.nextId}`,
        case_id: raise.insert.case_id,
        reason: raise.insert.reason,
        raised_at: raise.insert.raised_at,
        cleared_at: null,
      };
      store.nextId += 1;
      store.rows.push(inserted);
      store.notifications.push(...raise.notifications);
      inserted.notified_at = raise.notifiedAt;
      continue;
    }
    const row = store.rows.find(
      (candidate) => candidate.reason === raise.reopen.reason && candidate.cleared_at !== null,
    );
    if (row === undefined) continue;
    row.raised_at = raise.reopen.raised_at;
    row.cleared_at = null;
    row.cleared_by = null;
    store.notifications.push(...raise.notifications);
  }
  if (plan.caseUpdate !== null) {
    store.case = {
      ...store.case,
      communication_status: plan.caseUpdate.communication_status,
      follow_up_deadline: plan.caseUpdate.follow_up_deadline,
    };
  }
}

function applyClearPlan(store: StoredWorld, plan: ClearEscalationsPlan): void {
  for (const update of plan.updates) {
    const row = store.rows.find(
      (candidate) => candidate.reason === update.reason && candidate.cleared_at === null,
    );
    if (row === undefined) continue;
    row.cleared_at = update.cleared_at;
    row.cleared_by = update.cleared_by;
  }
  store.case = {
    ...store.case,
    communication_status: plan.caseUpdate.communication_status,
    follow_up_deadline: plan.caseUpdate.follow_up_deadline,
  };
}

describe('at most one notification per case and reason (Requirement 20.10)', () => {
  it('notifies once across repeated evaluations, a clear, and a reopen', () => {
    const store = storedWorld({ case_status: 'Payment Reported' });

    // Evaluation 1 — import load completion.
    applyRaisePlan(store, planOf(planEscalations(stateOf(store), PLAN_OPTIONS)));
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].notified_at).toBe('2026-07-20T12:00:00.000Z');
    expect(store.notifications).toHaveLength(1);
    expect(store.case.communication_status).toBe(MANUAL_FOLLOW_UP_STATUS);
    expect(store.case.follow_up_deadline).toBe('2026-07-21T12:00:00.000Z');

    // Evaluations 2 and 3 — two later Notification_Scheduler runs.
    for (const now of [new Date('2026-07-21T06:00:00.000Z'), new Date('2026-07-22T06:00:00.000Z')]) {
      const plan = planOf(planEscalations(stateOf(store), { ...PLAN_OPTIONS, now }));
      expect(plan.alreadyRaised).toEqual(['Payment Reported']);
      expect(plan.caseUpdate).toBeNull();
      applyRaisePlan(store, plan);
    }
    expect(store.rows).toHaveLength(1);
    expect(store.notifications).toHaveLength(1);
    // The deadline was not pushed forward by either run.
    expect(store.case.follow_up_deadline).toBe('2026-07-21T12:00:00.000Z');

    // A manual contact outcome clears the reason (Requirement 20.12).
    applyClearPlan(
      store,
      clearPlanOf(clearEscalations(stateOf(store), AGENT_ACTOR, 'Spoke with the customer.', CLEAR_TIME)),
    );
    expect(store.rows[0].cleared_at).toBe(CLEAR_TIME.toISOString());
    expect(store.case.follow_up_deadline).toBeNull();

    // Evaluation 4 — the reason still holds, so the row reopens and notifies nobody.
    const reopenPlan = planOf(
      planEscalations(stateOf(store), { ...PLAN_OPTIONS, now: new Date('2026-07-23T06:00:00.000Z') }),
    );
    expect(reopenedRaise(reopenPlan, 'Payment Reported').notifications).toEqual([]);
    applyRaisePlan(store, reopenPlan);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].cleared_at).toBeNull();
    expect(store.case.communication_status).toBe(MANUAL_FOLLOW_UP_STATUS);

    // One notification for the pair across all four evaluations.
    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0].entity_id).toBe(CASE_ID);
  });

  it('notifies once where two concurrent evaluations both plan the same new raise', () => {
    const store = storedWorld({ case_status: 'Payment Reported' });
    // Both plans are computed before either is written, which is the race the unique key settles.
    const first = planOf(planEscalations(stateOf(store), PLAN_OPTIONS));
    const second = planOf(planEscalations(stateOf(store), PLAN_OPTIONS));
    expect(newRaise(first, 'Payment Reported').notifications).toHaveLength(1);
    expect(newRaise(second, 'Payment Reported').notifications).toHaveLength(1);

    applyRaisePlan(store, first);
    applyRaisePlan(store, second);

    expect(store.rows).toHaveLength(1);
    expect(store.notifications).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The clear (Requirement 20.12)
// ---------------------------------------------------------------------------

describe('clearing every escalation reason', () => {
  const escalated = (overrides: Partial<EscalationState> = {}): EscalationState =>
    world({
      case: caseRow({
        communication_status: MANUAL_FOLLOW_UP_STATUS,
        follow_up_deadline: '2026-07-21T12:00:00.000Z',
      }),
      escalations: [uncleared('Payment Reported')],
      ...overrides,
    });

  it('is permitted to the whole Policy_Follow_Up access set and refused to every other role', () => {
    expect([...PERMITTED_CLEAR_ROLES]).toEqual([
      'agent',
      'manager',
      'customer_service',
      'sales_supervisor',
      'super_admin',
    ]);
    for (const role of PERMITTED_CLEAR_ROLES) {
      const result = clearEscalations(escalated(), { id: `profile-${role}`, role }, 'Called.', CLEAR_TIME);
      expect(result.ok).toBe(true);
      expect(clearPlanOf(result).clearedBy).toBe(`profile-${role}`);
    }
    expect(REFUSED_CLEAR_ROLES.length).toBeGreaterThan(0);
    for (const role of REFUSED_CLEAR_ROLES) {
      expect(rejectionOf(clearEscalations(escalated(), { id: `profile-${role}`, role }, 'Called.', CLEAR_TIME))).toBe(
        'role_not_permitted',
      );
    }
  });

  it('requires note text of 1 to 4,000 characters, measured after trimming', () => {
    for (const note of ['', '   ', '\n\t ', null, undefined]) {
      expect(rejectionOf(clearEscalations(escalated(), AGENT_ACTOR, note, CLEAR_TIME))).toBe(
        'note_text_empty',
      );
    }

    const tooLong = 'x'.repeat(MAX_CONTACT_OUTCOME_NOTE_LENGTH + 1);
    const result = clearEscalations(escalated(), AGENT_ACTOR, tooLong, CLEAR_TIME);
    expect(rejectionOf(result)).toBe('note_text_too_long');
    if (!result.ok) expect(result.rejection.message).toContain('4000');

    const atLimit = `  ${'x'.repeat(MAX_CONTACT_OUTCOME_NOTE_LENGTH)}  `;
    expect(clearPlanOf(clearEscalations(escalated(), AGENT_ACTOR, atLimit, CLEAR_TIME)).note).toHaveLength(
      MAX_CONTACT_OUTCOME_NOTE_LENGTH,
    );
    expect(
      clearPlanOf(clearEscalations(escalated(), AGENT_ACTOR, '  Reached the customer.  ', CLEAR_TIME)).note,
    ).toBe('Reached the customer.');
  });

  it('clears only a case whose Communication_Status is Manual Follow-up Required', () => {
    for (const status of ['Delivered', 'Failed', 'Not Scheduled'] as const) {
      const state = escalated({
        case: caseRow({ communication_status: status, follow_up_deadline: '2026-07-21T12:00:00.000Z' }),
      });
      expect(rejectionOf(clearEscalations(state, AGENT_ACTOR, 'Called.', CLEAR_TIME))).toBe(
        'case_not_escalated',
      );
    }
    const absent = escalated({ case: caseRow({ communication_status: null }) });
    expect(rejectionOf(clearEscalations(absent, AGENT_ACTOR, 'Called.', CLEAR_TIME))).toBe(
      'case_not_escalated',
    );
  });

  it('requires the recording profile and the stored case id', () => {
    expect(rejectionOf(clearEscalations(escalated(), { id: '   ', role: 'agent' }, 'Called.', CLEAR_TIME))).toBe(
      'actor_required',
    );
    const noId = escalated({
      case: caseRow({ id: null, communication_status: MANUAL_FOLLOW_UP_STATUS }),
    });
    expect(rejectionOf(clearEscalations(noId, AGENT_ACTOR, 'Called.', CLEAR_TIME))).toBe(
      'case_id_required',
    );
  });

  it('marks every uncleared reason cleared and leaves a cleared row alone', () => {
    const state = escalated({
      escalations: [
        uncleared('No Valid Contact'),
        cleared('All Channels Failed'),
        uncleared('Payment Reported'),
      ],
    });
    const plan = clearPlanOf(clearEscalations(state, AGENT_ACTOR, 'Reached the customer.', CLEAR_TIME));
    expect(plan.clearedReasons).toEqual(['No Valid Contact', 'Payment Reported']);
    expect(plan.clearedAt).toBe('2026-07-21T18:30:00.000Z');
    expect(plan.clearedBy).toBe(AGENT_ACTOR.id);
    expect(plan.updates).toEqual([
      {
        escalation_id: 'esc-No Valid Contact',
        case_id: CASE_ID,
        reason: 'No Valid Contact',
        cleared_at: plan.clearedAt,
        cleared_by: AGENT_ACTOR.id,
      },
      {
        escalation_id: 'esc-Payment Reported',
        case_id: CASE_ID,
        reason: 'Payment Reported',
        cleared_at: plan.clearedAt,
        cleared_by: AGENT_ACTOR.id,
      },
    ]);
  });

  it('clears the follow-up deadline and recomputes Communication_Status under Requirement 15', () => {
    expect(CLEAR_UPDATE_FORBIDS_CASE_STATUS).toBe(true);

    const delivered = escalated({
      communications: [
        record(PHONE_CONTACT_ID, 15, 'sms', 'Delivered'),
        record(EMAIL_CONTACT_ID, 15, 'email', 'Delivered'),
      ],
      scheduledSends: [
        { touchpoint: 15, channel: 'sms' },
        { touchpoint: 15, channel: 'email' },
      ] as ScheduledSend[],
    });
    const plan = clearPlanOf(clearEscalations(delivered, AGENT_ACTOR, 'Customer paid.', CLEAR_TIME));
    expect(plan.caseUpdate).toEqual({
      case_id: CASE_ID,
      follow_up_deadline: null,
      communication_status: 'Delivered',
    });
    expect('case_status' in plan.caseUpdate).toBe(false);

    // A case with nothing sent recomputes to the value Requirement 15.9's last step gives.
    const fresh = clearPlanOf(clearEscalations(escalated(), AGENT_ACTOR, 'Called.', CLEAR_TIME));
    expect(fresh.caseUpdate.communication_status).toBe('Not Scheduled');

    // A reason still stored uncleared would hold the status, so the recompute reads the rows as
    // this clear leaves them, not as it found them.
    expect(fresh.caseUpdate.communication_status).not.toBe(MANUAL_FOLLOW_UP_STATUS);
  });

  it('records the clearing profile, time, and reasons in the audit timeline', () => {
    const plan = clearPlanOf(
      clearEscalations(escalated(), AGENT_ACTOR, '  Spoke with Ana.  ', CLEAR_TIME),
    );
    expect(plan.event).toEqual({
      case_id: CASE_ID,
      actor_id: AGENT_ACTOR.id,
      event_type: ESCALATION_CLEARED_EVENT_TYPE,
      event_time: '2026-07-21T18:30:00.000Z',
      detail: {
        reasons: ['Payment Reported'],
        note: 'Spoke with Ana.',
        recomputed_communication_status: 'Not Scheduled',
      },
    });
  });

  it('is not an error where the case carries no uncleared reason', () => {
    const drifted = escalated({ escalations: [cleared('Payment Reported')] });
    const plan = clearPlanOf(clearEscalations(drifted, AGENT_ACTOR, 'Called.', CLEAR_TIME));
    expect(plan.clearedReasons).toEqual([]);
    expect(plan.updates).toEqual([]);
    // The deadline still clears and the drifted status is still repaired.
    expect(plan.caseUpdate).toEqual({
      case_id: CASE_ID,
      follow_up_deadline: null,
      communication_status: 'Not Scheduled',
    });
  });

  it('clears a stored reason outside the seven rather than leaving it uncleared', () => {
    const state = escalated({ escalations: [uncleared('Legacy reason text')] });
    const plan = clearPlanOf(clearEscalations(state, AGENT_ACTOR, 'Called.', CLEAR_TIME));
    expect(plan.clearedReasons).toEqual(['Legacy reason text']);
    expect(plan.updates[0].reason).toBe('Legacy reason text');
  });

  it('mutates nothing it was handed', () => {
    const state = escalated({
      escalations: [uncleared('Payment Reported'), cleared('No Valid Contact')],
    });
    const snapshot = JSON.stringify(state);
    clearEscalations(state, AGENT_ACTOR, 'Called.', CLEAR_TIME);
    planEscalations(state, PLAN_OPTIONS);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

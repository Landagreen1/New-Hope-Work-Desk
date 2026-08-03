// src/features/cancellations/__tests__/derive.test.ts
//
// Feature: policy-follow-up-renewals-cancellations, task 16.3 — unit tests over the pure module
// `src/features/cancellations/derive.ts`.
//
// **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.5, 16.7, 16.8, 17.4, 25.2**
//
// The module is pure: no React, no Supabase client, no provider, no clock, no randomness. The
// current business date arrives as a parameter on every path, so every case here hands it an
// in-memory world and asserts the derived value. No mock is used and none is needed — the roles
// are the real `APP_ROLES` values read through the real `canAccessRenewals` and
// `isBroadManagerRole`, which is the only way the Requirement 17.10 gate is worth testing.
//
// No property test lives in this file. The design names exactly three `fast-check` properties —
// CSV raw-row round trip, scheduler idempotency, forbidden tokens in rendered output — and none
// of them is about the list surface; Requirements 16 and 17.4 are decision tables, which the
// testing strategy assigns to enumerated boundary cases. The Requirement 16.5 total order is
// asserted the same way: antisymmetry, totality, and transitivity over a fixture set chosen to
// reach every one of the five comparison keys.
//
// Beyond the coverage list of task 16.3, these cases pin the readings `derive.ts` records, each
// of which a later change could reverse while everything else still passed:
//
//  1. *active is not open.* Requirement 16.3's active set has five members and Requirement
//     15.1's open set has two, so `Messages Scheduled Today` refuses a Payment Reported case
//     that the four date windows accept.
//  2. *`Messages Scheduled Today` is decided by the Touchpoint due dates alone* — days remaining
//     of 15, 10, 5, or 1 — with no eligible-contact condition folded in.
//  3. *A stored follow-up deadline is compared as its UTC calendar date*, so a deadline equal to
//     the business date has arrived.
//  4. *`Payment Verification Required` reads the case, not the caller's role*: the same case
//     matches for every role, including the roles that cannot see a Verify Payment control.
//  5. *Every absent text cell reads as one em dash*, the cancellation reason and the amount due
//     among them.
//  6. *An assigned case whose employee row was not supplied reads as an em dash, not
//     `Unassigned`* — `Unassigned` is reserved for a case that has no assigned employee.
//  7. *The case id is a fifth sort key*, so the comparator is a total order and the sort is
//     deterministic for any input permutation.
//  8. *The digit-only phone comparison is added to the substring comparison*, so `+1305` and
//     `(305)` each find the same row, and the digit path is not applied to an email value.
//  9. *Role visibility is applied before each step's condition*: a hidden step is skipped and
//     the next is considered, so an `agent` looking at a Partially Failed case is offered
//     Record Customer Response rather than a Retry Failed Communication control that is not on
//     their screen.
// 10. *A cleared next required action does not reach step (g)*: a Reinstated or Cancelled case
//     with a null stored column has no primary action at all, while Invalid and Duplicate — which
//     no criterion clears — do reach it.

import { describe, expect, it } from 'vitest';

import { APP_ROLES, canAccessRenewals, isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import {
  CASE_STATUSES,
  OPEN_CASE_STATUSES,
  isOpenCaseStatus,
} from '../domain/communication-status';
import type {
  CommunicationRecord,
  CustomerResponseRecord,
  DeliveryResult,
  EscalationRecord,
  ScheduledSend,
} from '../domain/communication-status';
import type { Touchpoint } from '../render/renderMessage';
import {
  ACTIVE_CASE_STATUSES,
  CANCELLATION_PAGE_SIZE,
  CANCELLATION_ROW_CELL_ORDER,
  CANCELLATION_SAVED_FILTERS,
  COMMUNICATION_FAILED_STATUSES,
  DEFAULT_CANCELLATION_FILTER,
  EM_DASH,
  MANAGER_ONLY_ACTIONS,
  MAX_SEARCH_LENGTH,
  NEEDS_ACTION_COMMUNICATION_STATUSES,
  NEXT_REQUIRED_ACTIONS,
  PAYMENT_VERIFICATION_CASE_STATUSES,
  PRIMARY_ACTION_STEPS,
  RESOLVED_FILTER_CASE_STATUSES,
  UNASSIGNED,
  amountDueCell,
  amountDueCents,
  assignedEmployeeCell,
  canReadCancellationCase,
  cancellationFilterCounts,
  cancellationRowCellValues,
  cancellationRowCells,
  cellText,
  compareCancellationRows,
  daysRemaining,
  daysRemainingCell,
  digitsOnly,
  effectiveCalendarDate,
  effectiveSearchText,
  filterCancellationRows,
  followUpDeadlinePassed,
  hasTouchpointDueToday,
  isActionVisibleToRole,
  isActiveCancellationCase,
  matchesSavedFilter,
  matchesSearch,
  primaryAction,
  primaryActionStep,
  readableCancellationRows,
  rowDaysRemaining,
  sortCancellationRows,
  visibleCancellationActions,
} from '../derive';
import type {
  CancellationRowCase,
  CancellationRowContact,
  CancellationRowState,
  CancellationSavedFilterId,
  CaseStatus,
  NextRequiredAction,
  PrimaryActionStep,
} from '../derive';

// ---------------------------------------------------------------------------
// Pinned dates and fixtures
// ---------------------------------------------------------------------------

const CASE_ID = 'case-0001';

/** The cancellation effective date every world here shares. July 2026 has 31 days. */
const EFFECTIVE_DATE = '2026-07-31';

/** Business dates named by the days remaining they produce against `EFFECTIVE_DATE`. */
const DAY = {
  /** Outside every date window and off every Touchpoint due date. */
  remaining16: '2026-07-15',
  remaining15: '2026-07-16',
  remaining10: '2026-07-21',
  remaining8: '2026-07-23',
  remaining7: '2026-07-24',
  remaining5: '2026-07-26',
  remaining4: '2026-07-27',
  remaining3: '2026-07-28',
  remaining1: '2026-07-30',
  remaining0: '2026-07-31',
  remainingMinus2: '2026-08-02',
} as const;

const PHONE_VALUE = '+13055550147';
const PHONE_SEGMENT = '(305) 555-0147';
const EMAIL_VALUE = 'ana.reyes@example.com';

const ALL_FILTER_IDS: readonly CancellationSavedFilterId[] = CANCELLATION_SAVED_FILTERS.map(
  (filter) => filter.id,
);

/** Uncleared: `cleared_at` absent is the whole of Requirement 20.11 as a status reads it. */
const UNCLEARED_ESCALATION: EscalationRecord = {
  id: 'esc-1',
  case_id: CASE_ID,
  reason: 'No Valid Contact',
  raised_at: '2026-07-14T12:00:00.000Z',
};

function phoneContact(overrides: Partial<CancellationRowContact> = {}): CancellationRowContact {
  return {
    id: 'contact-phone-1',
    case_id: CASE_ID,
    channel: 'phone',
    normalized_value: PHONE_VALUE,
    raw_segment: PHONE_SEGMENT,
    validation_status: 'valid',
    authorization_status: 'Authorized',
    sms_suppressed: false,
    email_suppressed: false,
    ...overrides,
  };
}

function emailContact(overrides: Partial<CancellationRowContact> = {}): CancellationRowContact {
  return {
    id: 'contact-email-1',
    case_id: CASE_ID,
    channel: 'email',
    normalized_value: EMAIL_VALUE,
    raw_segment: EMAIL_VALUE,
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

function caseRow(overrides: Partial<CancellationRowCase> = {}): CancellationRowCase {
  return {
    id: CASE_ID,
    case_status: 'Open',
    communication_status: null,
    cancellation_effective_date: EFFECTIVE_DATE,
    next_required_action: null,
    customer_name: 'Ana Reyes',
    policy_number: 'POL-1000',
    carrier: 'Acme Mutual',
    cancellation_reason: 'Non-payment',
    amount_due: '412.50',
    assigned_to: null,
    follow_up_deadline: null,
    ...overrides,
  };
}

/**
 * The baseline world: an Open case 16 days out, two valid authorized contacts, one delivered
 * 15-day SMS record, no response, no escalation, no deadline. It matches the All filter and
 * nothing else, so every filter case below flips exactly one fact away from it.
 */
function world(overrides: Partial<CancellationRowState> = {}): CancellationRowState {
  return {
    case: caseRow(),
    contacts: [phoneContact(), emailContact()],
    communications: [record(15, 'sms', 'Delivered')],
    scheduledSends: [],
    escalations: [],
    responses: [],
    suppressions: [],
    businessDate: DAY.remaining16,
    ...overrides,
  };
}

/** A world differing from the baseline only in its case columns. */
function caseWorld(
  overrides: Partial<CancellationRowCase>,
  rest: Partial<CancellationRowState> = {},
): CancellationRowState {
  return world({ case: caseRow(overrides), ...rest });
}

/** Every saved filter the case matches, in the fixed Requirement 16.2 order. */
function matchedFilters(state: CancellationRowState): CancellationSavedFilterId[] {
  return ALL_FILTER_IDS.filter((id) => matchesSavedFilter(state, id));
}

function responseAt(time: string): CustomerResponseRecord {
  return { id: 'resp-1', case_id: CASE_ID, response_time: time };
}

function scheduled(touchpoint: Touchpoint, channel: 'sms' | 'email'): ScheduledSend {
  return { touchpoint, channel };
}

/** One world per step of Requirement 17.4, each reaching that step and no earlier one. */
const PRIMARY_ACTION_WORLDS: Record<PrimaryActionStep, CancellationRowState> = {
  // (a) Case_Status is Payment Reported or Verification Pending.
  a: caseWorld({ case_status: 'Payment Reported' }),
  // (b) Case_Status is Reinstatement Pending.
  b: caseWorld({ case_status: 'Reinstatement Pending' }),
  // (c) Zero contact rows whose validation status is valid and whose authorization permits contact.
  c: world({ contacts: [] }),
  // (d) Communication_Status is Failed or Partially Failed, with the current Touchpoint recorded
  //     so that step (f) cannot fire behind it.
  d: world({ businessDate: DAY.remaining15, communications: [record(15, 'sms', 'Failed')] }),
  // (e) Communication_Status is Manual Follow-up Required.
  e: world({ businessDate: DAY.remaining15, escalations: [UNCLEARED_ESCALATION] }),
  // (f) Case_Status is Imported or Open and no record exists for the current Touchpoint.
  f: world({ businessDate: DAY.remaining15, communications: [], scheduledSends: [scheduled(15, 'sms')] }),
  // (g) Case_Status is Reinstated, Cancelled, Invalid, or Duplicate.
  g: caseWorld({ case_status: 'Invalid' }),
  // (h) Every remaining case.
  h: world({ businessDate: DAY.remaining15 }),
};

/** The three workspace roles holding Policy_Follow_Up access without Manager_Role. */
const AGENT_ROLES: readonly AppRole[] = APP_ROLES.filter(
  (role) => canAccessRenewals(role) && !isBroadManagerRole(role),
);
/** The two roles holding Manager_Role: `manager` and `super_admin`. */
const MANAGER_ROLES: readonly AppRole[] = APP_ROLES.filter((role) => isBroadManagerRole(role));

// ---------------------------------------------------------------------------
// Days remaining (Requirement 16.1)
// ---------------------------------------------------------------------------

describe('days remaining', () => {
  it('is 0 where the effective date equals the current business date', () => {
    expect(daysRemaining(EFFECTIVE_DATE, DAY.remaining0)).toBe(0);
    expect(rowDaysRemaining(world({ businessDate: DAY.remaining0 }))).toBe(0);
    expect(daysRemainingCell(world({ businessDate: DAY.remaining0 }))).toBe('0');
  });

  it('is negative where the effective date is earlier than the current business date', () => {
    expect(daysRemaining(EFFECTIVE_DATE, DAY.remainingMinus2)).toBe(-2);
    expect(rowDaysRemaining(world({ businessDate: DAY.remainingMinus2 }))).toBe(-2);
    expect(daysRemainingCell(world({ businessDate: DAY.remainingMinus2 }))).toBe('-2');
    // One day past the effective date is -1, not 0: the count crosses zero exactly once.
    expect(daysRemaining(EFFECTIVE_DATE, '2026-08-01')).toBe(-1);
  });

  it('counts whole days forward across a month boundary', () => {
    expect(daysRemaining(EFFECTIVE_DATE, DAY.remaining1)).toBe(1);
    expect(daysRemaining(EFFECTIVE_DATE, DAY.remaining15)).toBe(15);
    expect(daysRemaining(EFFECTIVE_DATE, DAY.remaining16)).toBe(16);
    expect(daysRemaining('2026-08-02', '2026-07-31')).toBe(2);
  });

  it('reads an M/D/YYYY effective date and shows the canonical calendar date', () => {
    const state = caseWorld({ cancellation_effective_date: '7/31/2026' });
    expect(rowDaysRemaining(state)).toBe(16);
    expect(effectiveCalendarDate(state.case)).toBe('2026-07-31');
    expect(cancellationRowCells(state).cancellationEffectiveDate).toBe('2026-07-31');
  });

  it('has no value where either date is absent or names no calendar date', () => {
    expect(daysRemaining(null, DAY.remaining0)).toBeNull();
    expect(daysRemaining(EFFECTIVE_DATE, null)).toBeNull();
    expect(daysRemaining('July 31, 2026', DAY.remaining0)).toBeNull();
    expect(daysRemaining('2026-02-30', DAY.remaining0)).toBeNull();
    expect(rowDaysRemaining(caseWorld({ cancellation_effective_date: null }))).toBeNull();
    expect(daysRemainingCell(caseWorld({ cancellation_effective_date: null }))).toBe(EM_DASH);
    expect(effectiveCalendarDate({ cancellation_effective_date: '31/07/2026' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The thirteen row cells (Requirement 16.1)
// ---------------------------------------------------------------------------

describe('the thirteen row cells', () => {
  it('names the thirteen cells in the Requirement 16.1 order', () => {
    expect(CANCELLATION_ROW_CELL_ORDER).toHaveLength(13);
    expect([...CANCELLATION_ROW_CELL_ORDER]).toEqual([
      'customerName',
      'policyNumber',
      'carrier',
      'cancellationEffectiveDate',
      'daysRemaining',
      'cancellationReason',
      'amountDue',
      'assignedEmployee',
      'smsStatus',
      'emailStatus',
      'lastContact',
      'caseStatus',
      'nextRequiredAction',
    ]);
  });

  it('renders one row as thirteen display values in that order', () => {
    const state = world({
      businessDate: DAY.remaining15,
      assignedEmployee: { id: 'profile-2', display_name: 'Bea Cruz' },
    });
    const cells = cancellationRowCells(state);
    const values = cancellationRowCellValues(cells);

    expect(values).toHaveLength(13);
    expect(values).toEqual([
      'Ana Reyes',
      'POL-1000',
      'Acme Mutual',
      '2026-07-31',
      '15',
      'Non-payment',
      '$412.50',
      'Bea Cruz',
      cells.smsStatus,
      cells.emailStatus,
      cells.lastContact,
      'Open',
      cells.nextRequiredAction,
    ]);
    expect(values).toEqual(CANCELLATION_ROW_CELL_ORDER.map((key) => cells[key]));
  });

  it('shows an em dash for an absent cancellation reason and an absent amount due', () => {
    const cells = cancellationRowCells(
      caseWorld({ cancellation_reason: null, amount_due: null }),
    );
    expect(cells.cancellationReason).toBe(EM_DASH);
    expect(cells.amountDue).toBe(EM_DASH);

    // Reading 5: the same absent marker covers every other text cell.
    const sparse = cancellationRowCells(
      caseWorld({ customer_name: null, carrier: '   ', cancellation_reason: '' }),
    );
    expect(sparse.customerName).toBe(EM_DASH);
    expect(sparse.carrier).toBe(EM_DASH);
    expect(sparse.cancellationReason).toBe(EM_DASH);
    expect(cellText(null)).toBe(EM_DASH);
  });

  it('formats the amount due in US dollars from a string, a number, or neither', () => {
    expect(amountDueCell({ amount_due: '412.50' })).toBe('$412.50');
    expect(amountDueCell({ amount_due: 1234.56 })).toBe('$1,234.56');
    expect(amountDueCell({ amount_due: '$1,234.56' })).toBe('$1,234.56');
    expect(amountDueCell({ amount_due: null })).toBe(EM_DASH);
    // A value the importer would have refused is an absent amount, not a formatted zero.
    expect(amountDueCell({ amount_due: 'nan' })).toBe(EM_DASH);
    expect(amountDueCell({ amount_due: '   ' })).toBe(EM_DASH);

    expect(amountDueCents({ amount_due: '1,234.56' })).toBe(123_456);
    expect(amountDueCents({ amount_due: 1234.56 })).toBe(123_456);
    expect(amountDueCents({ amount_due: '412.5' })).toBe(41_250);
    expect(amountDueCents({ amount_due: null })).toBeNull();
    expect(amountDueCents({ amount_due: 'nan' })).toBeNull();
  });

  it('reads Unassigned only where the case has no assigned employee', () => {
    expect(assignedEmployeeCell(world())).toBe(UNASSIGNED);
    expect(UNASSIGNED).toBe('Unassigned');
    expect(
      assignedEmployeeCell(world({ assignedEmployee: { display_name: 'Bea Cruz' } })),
    ).toBe('Bea Cruz');

    // Reading 6: an assigned case whose employee row was not supplied has an assigned employee
    // whose name is unknown, which is an em dash rather than a false `Unassigned`.
    expect(assignedEmployeeCell(caseWorld({ assigned_to: 'profile-2' }))).toBe(EM_DASH);
    expect(
      assignedEmployeeCell(caseWorld({ assigned_to: 'profile-2' }, { assignedEmployee: null })),
    ).toBe(EM_DASH);
  });

  it('names in the next required action cell the action the drawer makes primary', () => {
    for (const state of Object.values(PRIMARY_ACTION_WORLDS)) {
      expect(cancellationRowCells(state).nextRequiredAction).toBe(cellText(primaryAction(state)));
    }
    const cleared = caseWorld({ case_status: 'Resolved', next_required_action: null });
    expect(primaryAction(cleared)).toBeNull();
    expect(cancellationRowCells(cleared).nextRequiredAction).toBe(EM_DASH);
  });
});

// ---------------------------------------------------------------------------
// The fourteen saved filters (Requirements 16.2, 16.7, 16.8)
// ---------------------------------------------------------------------------

describe('the fourteen saved filters', () => {
  it('provides exactly the fourteen filters of Requirement 16.2 in that order', () => {
    expect(CANCELLATION_SAVED_FILTERS).toHaveLength(14);
    expect(new Set(ALL_FILTER_IDS).size).toBe(14);
    expect(CANCELLATION_SAVED_FILTERS.map((filter) => filter.label)).toEqual([
      'Needs Action',
      'Cancellation Today',
      'Next 3 Days',
      'Next 7 Days',
      'Next 15 Days',
      'Contact Missing',
      'Messages Scheduled Today',
      'Communication Failed',
      'Customer Responded',
      'Payment Verification Required',
      'Reinstatement Pending',
      'No Successful Contact',
      'Resolved',
      'All',
    ]);
  });

  it('is Needs Action until the user selects a saved filter in the session', () => {
    expect(DEFAULT_CANCELLATION_FILTER).toBe('needs-action');
    const needsAction = caseWorld({
      id: 'case-needs',
      customer_name: 'Ana Reyes',
      follow_up_deadline: '2026-07-15T00:00:00.000Z',
    });
    const quiet = world({ case: caseRow({ id: 'case-quiet', customer_name: 'Bea Cruz' }) });
    const rows = [needsAction, quiet];

    expect(filterCancellationRows(rows)).toEqual(filterCancellationRows(rows, { filterId: 'needs-action' }));
    expect(filterCancellationRows(rows).map((row) => row.case.id)).toEqual(['case-needs']);
    expect(filterCancellationRows(rows, { filterId: 'all' }).map((row) => row.case.id)).toEqual([
      'case-needs',
      'case-quiet',
    ]);
  });

  it('treats the five active Case_Status values as active and only Imported and Open as open', () => {
    expect([...ACTIVE_CASE_STATUSES]).toEqual([
      'Imported',
      'Open',
      'Payment Reported',
      'Verification Pending',
      'Reinstatement Pending',
    ]);
    for (const status of CASE_STATUSES) {
      expect(isActiveCancellationCase({ case_status: status })).toBe(
        (ACTIVE_CASE_STATUSES as readonly CaseStatus[]).includes(status),
      );
    }
    // Reading 1: the open set is a strict subset of the active set, so the two are not
    // interchangeable.
    expect([...OPEN_CASE_STATUSES]).toEqual(['Imported', 'Open']);
    for (const status of OPEN_CASE_STATUSES) {
      expect(isActiveCancellationCase({ case_status: status })).toBe(true);
    }
    expect(isOpenCaseStatus('Payment Reported')).toBe(false);
  });

  it('matches the baseline case to the All filter and to nothing else', () => {
    expect(matchedFilters(world())).toEqual(['all']);
  });

  // -- 1. Needs Action -----------------------------------------------------

  it('matches Needs Action on any of the four Requirement 16.8 conditions', () => {
    expect([...NEEDS_ACTION_COMMUNICATION_STATUSES]).toEqual([
      'Partially Failed',
      'Failed',
      'Suppressed',
      'Manual Follow-up Required',
    ]);

    // Communication_Status Partially Failed.
    expect(
      matchedFilters(
        world({ communications: [record(15, 'sms', 'Failed'), record(15, 'email', 'Delivered')] }),
      ),
    ).toEqual(['needs-action', 'communication-failed', 'all']);

    // Communication_Status Failed.
    expect(matchedFilters(world({ communications: [record(15, 'sms', 'Failed')] }))).toEqual([
      'needs-action',
      'communication-failed',
      'no-successful-contact',
      'all',
    ]);

    // Communication_Status Suppressed: no record, every contact suppressed on its own channel.
    expect(
      matchedFilters(
        world({
          communications: [],
          contacts: [
            phoneContact({ sms_suppressed: true }),
            emailContact({ email_suppressed: true }),
          ],
        }),
      ),
    ).toEqual(['needs-action', 'no-successful-contact', 'all']);

    // Communication_Status Manual Follow-up Required, held by an uncleared escalation.
    expect(matchedFilters(world({ escalations: [UNCLEARED_ESCALATION] }))).toEqual([
      'needs-action',
      'all',
    ]);

    // Zero contact rows whose validation status is valid and whose authorization permits contact.
    expect(matchedFilters(world({ contacts: [] }))).toEqual([
      'needs-action',
      'contact-missing',
      'all',
    ]);

    // One day or less remaining with nothing delivered.
    expect(
      matchesSavedFilter(
        world({ businessDate: DAY.remaining1, communications: [record(1, 'sms', 'Sent')] }),
        'needs-action',
      ),
    ).toBe(true);

    // A stored follow-up deadline that has arrived (reading 3: compared as its UTC date).
    expect(
      matchedFilters(caseWorld({ follow_up_deadline: '2026-07-15T00:00:00.000Z' })),
    ).toEqual(['needs-action', 'all']);
  });

  it('refuses Needs Action where a delivered record exists and no other condition holds', () => {
    const delivered = world({
      businessDate: DAY.remaining1,
      communications: [record(1, 'sms', 'Delivered')],
    });
    expect(rowDaysRemaining(delivered)).toBe(1);
    expect(matchesSavedFilter(delivered, 'needs-action')).toBe(false);
  });

  it('refuses Needs Action and Contact Missing for a case that is not active', () => {
    const resolved = caseWorld({ case_status: 'Resolved' }, { contacts: [] });
    expect(isActiveCancellationCase(resolved.case)).toBe(false);
    expect(matchedFilters(resolved)).toEqual(['resolved', 'all']);
  });

  it('compares a stored follow-up deadline as its UTC calendar date', () => {
    expect(followUpDeadlinePassed({ follow_up_deadline: '2026-07-15T00:00:00.000Z' }, '2026-07-15')).toBe(true);
    expect(followUpDeadlinePassed({ follow_up_deadline: '2026-07-14' }, '2026-07-15')).toBe(true);
    expect(followUpDeadlinePassed({ follow_up_deadline: '2026-07-16T00:00:00.000Z' }, '2026-07-15')).toBe(false);
    expect(followUpDeadlinePassed({ follow_up_deadline: null }, '2026-07-15')).toBe(false);
    expect(followUpDeadlinePassed({ follow_up_deadline: '2026-07-15T00:00:00.000Z' }, null)).toBe(false);
  });

  // -- 2 to 5. The four date windows --------------------------------------

  it('matches Cancellation Today only at exactly 0 days remaining', () => {
    expect(matchedFilters(world({ businessDate: DAY.remaining0 }))).toEqual([
      'cancellation-today',
      'next-3-days',
      'next-7-days',
      'next-15-days',
      'all',
    ]);
    expect(matchesSavedFilter(world({ businessDate: DAY.remaining1 }), 'cancellation-today')).toBe(false);
  });

  it('excludes a past effective date and an unreadable one from every date window', () => {
    // Negative days remaining is outside the inclusive 0-through-N windows.
    expect(matchedFilters(world({ businessDate: DAY.remainingMinus2 }))).toEqual(['all']);
    expect(matchedFilters(caseWorld({ cancellation_effective_date: null }))).toEqual(['all']);
    // With no business date at all the windows match nothing rather than guessing a date.
    expect(matchesSavedFilter(world(), 'next-15-days', null)).toBe(false);
  });

  it('matches Next 3 Days over 0 through 3 inclusive', () => {
    expect(matchedFilters(world({ businessDate: DAY.remaining3 }))).toEqual([
      'next-3-days',
      'next-7-days',
      'next-15-days',
      'all',
    ]);
    expect(matchesSavedFilter(world({ businessDate: DAY.remaining4 }), 'next-3-days')).toBe(false);
    expect(matchesSavedFilter(world({ businessDate: DAY.remaining0 }), 'next-3-days')).toBe(true);
  });

  it('matches Next 7 Days over 0 through 7 inclusive', () => {
    expect(matchedFilters(world({ businessDate: DAY.remaining7 }))).toEqual([
      'next-7-days',
      'next-15-days',
      'all',
    ]);
    expect(matchesSavedFilter(world({ businessDate: DAY.remaining8 }), 'next-7-days')).toBe(false);
  });

  it('matches Next 15 Days over 0 through 15 inclusive', () => {
    expect(matchedFilters(world({ businessDate: DAY.remaining15 }))).toEqual([
      'next-15-days',
      'messages-scheduled-today',
      'all',
    ]);
    expect(matchesSavedFilter(world({ businessDate: DAY.remaining16 }), 'next-15-days')).toBe(false);
  });

  it('reads the business date handed to it over the one carried by the state bundle', () => {
    const state = world();
    expect(matchesSavedFilter(state, 'cancellation-today')).toBe(false);
    expect(matchesSavedFilter(state, 'cancellation-today', DAY.remaining0)).toBe(true);
    expect(state.businessDate).toBe(DAY.remaining16);
  });

  // -- 6. Contact Missing --------------------------------------------------

  it('matches Contact Missing on validity and authorization alone', () => {
    expect(matchesSavedFilter(world({ contacts: [] }), 'contact-missing')).toBe(true);
    expect(
      matchesSavedFilter(
        world({ contacts: [phoneContact({ validation_status: 'invalid' })] }),
        'contact-missing',
      ),
    ).toBe(true);
    expect(
      matchesSavedFilter(
        world({ contacts: [phoneContact({ authorization_status: 'Not Authorized' })] }),
        'contact-missing',
      ),
    ).toBe(true);
    // `Unknown` permits contact (Requirement 10.9), so it is not a missing contact.
    expect(
      matchesSavedFilter(
        world({ contacts: [phoneContact({ authorization_status: 'Unknown' })] }),
        'contact-missing',
      ),
    ).toBe(false);
    // Suppression is not part of Requirement 16.7's condition: the detail is still held.
    expect(
      matchedFilters(
        world({
          contacts: [
            phoneContact({ sms_suppressed: true }),
            emailContact({ email_suppressed: true }),
          ],
        }),
      ),
    ).toEqual(['all']);
  });

  // -- 7. Messages Scheduled Today ----------------------------------------

  it('matches Messages Scheduled Today at each of the four Touchpoint due dates', () => {
    for (const [businessDate, remaining] of [
      [DAY.remaining15, 15],
      [DAY.remaining10, 10],
      [DAY.remaining5, 5],
      [DAY.remaining1, 1],
    ] as const) {
      const state = world({ businessDate });
      expect(rowDaysRemaining(state)).toBe(remaining);
      expect(hasTouchpointDueToday(state)).toBe(true);
      expect(matchesSavedFilter(state, 'messages-scheduled-today')).toBe(true);
      expect(
        matchesSavedFilter(caseWorld({ case_status: 'Imported' }, { businessDate }), 'messages-scheduled-today'),
      ).toBe(true);
    }

    for (const businessDate of [DAY.remaining16, DAY.remaining8, DAY.remaining3, DAY.remaining0]) {
      const state = world({ businessDate });
      expect(hasTouchpointDueToday(state)).toBe(false);
      expect(matchesSavedFilter(state, 'messages-scheduled-today')).toBe(false);
    }
    expect(hasTouchpointDueToday(caseWorld({ cancellation_effective_date: null }))).toBe(false);
  });

  it('reads the open Case_Status set for Messages Scheduled Today, not the active set', () => {
    // Reading 1. Each of these three is active, so the date windows accept it, and none is open.
    for (const status of ['Payment Reported', 'Verification Pending', 'Reinstatement Pending'] as const) {
      const state = caseWorld({ case_status: status }, { businessDate: DAY.remaining15 });
      expect(isActiveCancellationCase(state.case)).toBe(true);
      expect(matchesSavedFilter(state, 'next-15-days')).toBe(true);
      expect(hasTouchpointDueToday(state)).toBe(true);
      expect(matchesSavedFilter(state, 'messages-scheduled-today')).toBe(false);
    }
  });

  it('does not fold an eligible-contact condition into Messages Scheduled Today', () => {
    // Reading 2: a case with no eligible contact is what Contact Missing and Needs Action are
    // for; the Touchpoint due date alone decides this filter.
    const state = world({ businessDate: DAY.remaining10, contacts: [] });
    expect(matchesSavedFilter(state, 'messages-scheduled-today')).toBe(true);
    expect(matchesSavedFilter(state, 'contact-missing')).toBe(true);
  });

  // -- 8. Communication Failed --------------------------------------------

  it('matches Communication Failed on the status or on the latest record of a Touchpoint', () => {
    expect([...COMMUNICATION_FAILED_STATUSES]).toEqual(['Partially Failed', 'Failed']);

    expect(matchesSavedFilter(world({ communications: [record(15, 'sms', 'Failed')] }), 'communication-failed')).toBe(true);
    expect(
      matchesSavedFilter(
        world({ communications: [record(15, 'sms', 'Failed'), record(15, 'email', 'Delivered')] }),
        'communication-failed',
      ),
    ).toBe(true);

    // The second clause on its own: an uncleared escalation holds the status at Manual Follow-up
    // Required, and the most recent record of the 15-day SMS Touchpoint still failed.
    const escalated = world({
      escalations: [UNCLEARED_ESCALATION],
      communications: [record(15, 'sms', 'Failed')],
    });
    expect(matchesSavedFilter(escalated, 'communication-failed')).toBe(true);

    // The same two records with the failure superseded by a later delivery on the same Touchpoint
    // and channel: the latest attempt did not fail, so the filter refuses the case.
    const superseded = world({
      escalations: [UNCLEARED_ESCALATION],
      communications: [
        record(15, 'sms', 'Failed', {
          id: 'comm-a',
          contact_id: 'contact-phone-1',
          send_time: '2026-07-16T10:00:00.000Z',
        }),
        record(15, 'sms', 'Delivered', {
          id: 'comm-b',
          contact_id: 'contact-phone-2',
          send_time: '2026-07-16T12:00:00.000Z',
        }),
      ],
    });
    expect(matchesSavedFilter(superseded, 'communication-failed')).toBe(false);
  });

  it('applies no active-case gate to Communication Failed', () => {
    const cancelled = caseWorld(
      { case_status: 'Cancelled', next_required_action: 'Mark Resolved' },
      { communications: [record(15, 'sms', 'Failed')] },
    );
    expect(isActiveCancellationCase(cancelled.case)).toBe(false);
    expect(matchesSavedFilter(cancelled, 'communication-failed')).toBe(true);
  });

  // -- 9. Customer Responded ---------------------------------------------

  it('matches Customer Responded for an active case with a recorded response', () => {
    expect(matchedFilters(world({ responses: [responseAt('2026-07-14T18:00:00.000Z')] }))).toEqual([
      'customer-responded',
      'all',
    ]);
    expect(matchesSavedFilter(world({ responses: [] }), 'customer-responded')).toBe(false);
    expect(
      matchesSavedFilter(
        caseWorld({ case_status: 'Resolved' }, { responses: [responseAt('2026-07-14T18:00:00.000Z')] }),
        'customer-responded',
      ),
    ).toBe(false);
  });

  // -- 10. Payment Verification Required ---------------------------------

  it('matches Payment Verification Required on the Case_Status or the next required action', () => {
    expect([...PAYMENT_VERIFICATION_CASE_STATUSES]).toEqual(['Payment Reported', 'Verification Pending']);

    for (const status of PAYMENT_VERIFICATION_CASE_STATUSES) {
      expect(matchedFilters(caseWorld({ case_status: status }))).toEqual([
        'payment-verification-required',
        'all',
      ]);
    }

    // The stored column carries the filter on a case whose status does not.
    expect(
      matchedFilters(caseWorld({ case_status: 'Open', next_required_action: 'Verify Payment' })),
    ).toEqual(['payment-verification-required', 'all']);
    expect(
      matchesSavedFilter(
        caseWorld({ case_status: 'Open', next_required_action: 'Send Reminder Now' }),
        'payment-verification-required',
      ),
    ).toBe(false);
  });

  it('answers Payment Verification Required about the case, not about the caller role', () => {
    // Reading 4: Requirement 17.10 hides Verify Payment from Agent_Role, and a saved filter must
    // not change meaning per role.
    for (const role of APP_ROLES) {
      expect(
        matchesSavedFilter(caseWorld({ case_status: 'Payment Reported' }, { viewerRole: role }), 'payment-verification-required'),
      ).toBe(true);
      expect(
        matchesSavedFilter(
          caseWorld({ case_status: 'Open', next_required_action: 'Verify Payment' }, { viewerRole: role }),
          'payment-verification-required',
        ),
      ).toBe(true);
    }
  });

  // -- 11. Reinstatement Pending -----------------------------------------

  it('matches Reinstatement Pending on that Case_Status alone', () => {
    expect(matchedFilters(caseWorld({ case_status: 'Reinstatement Pending' }))).toEqual([
      'reinstatement-pending',
      'all',
    ]);
    expect(
      matchesSavedFilter(
        caseWorld({ case_status: 'Reinstated', next_required_action: 'Mark Resolved' }),
        'reinstatement-pending',
      ),
    ).toBe(false);
  });

  // -- 12. No Successful Contact -----------------------------------------

  it('matches No Successful Contact where nothing was sent, delivered, or answered', () => {
    expect(matchedFilters(world({ communications: [] }))).toEqual(['no-successful-contact', 'all']);

    // A failed record is neither sent nor delivered, so the case still has no successful contact.
    expect(
      matchesSavedFilter(world({ communications: [record(15, 'sms', 'Failed')] }), 'no-successful-contact'),
    ).toBe(true);

    expect(
      matchesSavedFilter(world({ communications: [record(15, 'sms', 'Sent')] }), 'no-successful-contact'),
    ).toBe(false);
    expect(
      matchesSavedFilter(
        world({ communications: [], responses: [responseAt('2026-07-14T18:00:00.000Z')] }),
        'no-successful-contact',
      ),
    ).toBe(false);
    expect(
      matchesSavedFilter(
        caseWorld({ case_status: 'Cancelled', next_required_action: 'Mark Resolved' }, { communications: [] }),
        'no-successful-contact',
      ),
    ).toBe(false);
  });

  // -- 13. Resolved -------------------------------------------------------

  it('matches Resolved for Reinstated, Cancelled, and Resolved only', () => {
    expect([...RESOLVED_FILTER_CASE_STATUSES]).toEqual(['Reinstated', 'Cancelled', 'Resolved']);
    for (const status of CASE_STATUSES) {
      expect(matchesSavedFilter(caseWorld({ case_status: status }), 'resolved')).toBe(
        (RESOLVED_FILTER_CASE_STATUSES as readonly CaseStatus[]).includes(status),
      );
    }
    // Invalid and Duplicate are neither active nor resolved: only All matches them.
    expect(matchedFilters(caseWorld({ case_status: 'Invalid' }))).toEqual(['all']);
    expect(matchedFilters(caseWorld({ case_status: 'Duplicate' }))).toEqual(['all']);
  });

  // -- 14. All ------------------------------------------------------------

  it('matches All regardless of Case_Status, Communication_Status, and effective date', () => {
    for (const status of CASE_STATUSES) {
      expect(matchesSavedFilter(caseWorld({ case_status: status }), 'all')).toBe(true);
    }
    expect(
      matchesSavedFilter(caseWorld({ cancellation_effective_date: null }), 'all', null),
    ).toBe(true);
    expect(
      matchesSavedFilter(world({ escalations: [UNCLEARED_ESCALATION], contacts: [] }), 'all'),
    ).toBe(true);
  });

  it('counts every filter independently of which one is active', () => {
    const needsAction = caseWorld({ id: 'case-needs', follow_up_deadline: '2026-07-15T00:00:00.000Z' });
    const quiet = world({ case: caseRow({ id: 'case-quiet' }) });
    const counts = cancellationFilterCounts([needsAction, quiet]);

    expect(Object.keys(counts)).toHaveLength(14);
    expect(counts['all']).toBe(2);
    expect(counts['needs-action']).toBe(1);
    expect(counts['cancellation-today']).toBe(0);
    expect(counts['resolved']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Search (Requirement 16.4)
// ---------------------------------------------------------------------------

describe('the search text', () => {
  const searchable = world();
  /** A phone row carrying no source segment, so only the normalized value is searchable. */
  const phoneOnly = world({ contacts: [phoneContact({ raw_segment: null })] });

  it('applies no restriction where the effective text has zero characters', () => {
    expect(matchesSearch(searchable, '')).toBe(true);
    expect(matchesSearch(searchable, '    ')).toBe(true);
    expect(matchesSearch(searchable, '\t\n ')).toBe(true);
    expect(matchesSearch(searchable, null)).toBe(true);
    expect(matchesSearch(searchable, undefined)).toBe(true);
    expect(effectiveSearchText('  ')).toBe('');
  });

  it('trims, caps at 100 characters, and compares without case sensitivity', () => {
    expect(effectiveSearchText('  Reyes  ')).toBe('reyes');
    expect(effectiveSearchText('x'.repeat(140))).toHaveLength(MAX_SEARCH_LENGTH);
    expect(MAX_SEARCH_LENGTH).toBe(100);

    expect(matchesSearch(searchable, '  reyes  ')).toBe(true);
    expect(matchesSearch(searchable, 'ANA REYES')).toBe(true);

    const long = 'z'.repeat(100);
    const longNamed = world({ case: caseRow({ customer_name: long }) });
    // The needle is truncated to its first 100 characters, so the trailing text is dropped.
    expect(matchesSearch(longNamed, `${long}qqq`)).toBe(true);
    expect(matchesSearch(longNamed, `${'z'.repeat(99)}q`)).toBe(false);
  });

  it('searches the customer name, policy number, and carrier', () => {
    expect(matchesSearch(searchable, 'reyes')).toBe(true);
    expect(matchesSearch(searchable, 'pol-10')).toBe(true);
    expect(matchesSearch(searchable, 'acme mutual')).toBe(true);
    expect(matchesSearch(searchable, 'no-such-customer')).toBe(false);
  });

  it('searches the Contact_Recipient phone and email, stored value and source segment', () => {
    expect(matchesSearch(searchable, 'ana.reyes@example.com')).toBe(true);
    expect(matchesSearch(searchable, 'ANA.REYES@EXAMPLE.COM')).toBe(true);
    expect(matchesSearch(phoneOnly, '+1305')).toBe(true);
    // The segment as it appeared in the source file reads back.
    expect(matchesSearch(searchable, '(305) 555-0147')).toBe(true);
  });

  it('compares a search text carrying a digit against the phone with every non-digit removed', () => {
    expect(digitsOnly('(305) 555-0147')).toBe('3055550147');
    expect(digitsOnly(null)).toBe('');

    // None of these three is a substring of the stored `+13055550147`.
    for (const needle of ['(305) 555-0147', '305.555.0147', '305-555-0147']) {
      expect(PHONE_VALUE.includes(needle)).toBe(false);
      expect(matchesSearch(phoneOnly, needle)).toBe(true);
    }
  });

  it('adds the digit-only comparison to the substring comparison rather than replacing it', () => {
    // Reading 8: `+1305` matches as a substring and `(305)` matches on digits alone; both find
    // the same row.
    expect(matchesSearch(phoneOnly, '+1305')).toBe(true);
    expect(matchesSearch(phoneOnly, '(305)')).toBe(true);
    expect(matchesSearch(phoneOnly, '(407)')).toBe(false);
  });

  it('applies the digit-only comparison to the phone, not to an email value', () => {
    const digitEmail = world({
      contacts: [emailContact({ normalized_value: 'a.1.2.3@example.com', raw_segment: null })],
    });
    expect(matchesSearch(digitEmail, '123')).toBe(false);
    expect(matchesSearch(digitEmail, '1.2.3@')).toBe(true);
  });

  it('searches invalid contact rows and suppressed contact rows', () => {
    const invalid = world({
      contacts: [phoneContact({ validation_status: 'invalid', raw_segment: null })],
    });
    expect(matchesSearch(invalid, '(305) 555-0147')).toBe(true);

    const suppressed = world({
      contacts: [
        phoneContact({ sms_suppressed: true, raw_segment: null }),
        emailContact({ email_suppressed: true }),
      ],
    });
    expect(matchesSearch(suppressed, '(305) 555-0147')).toBe(true);
    expect(matchesSearch(suppressed, 'ana.reyes@example.com')).toBe(true);
  });

  it('refuses a case whose searched values carry the text nowhere', () => {
    expect(matchesSearch(searchable, 'zzz-nothing')).toBe(false);
    expect(matchesSearch({ case: caseRow({ customer_name: null, policy_number: null, carrier: null }) }, 'ana')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The read scope and the list (Requirements 16.3, 22.1, 22.3, 22.12)
// ---------------------------------------------------------------------------

describe('the read scope of the cancellation list', () => {
  it('lets an agent read a case assigned to that profile and a case with no assigned employee', () => {
    const viewer = { role: 'agent' as AppRole, profileId: 'profile-agent' };
    expect(canReadCancellationCase(viewer, { assigned_to: 'profile-agent' })).toBe(true);
    expect(canReadCancellationCase(viewer, { assigned_to: null })).toBe(true);
    expect(canReadCancellationCase(viewer, { assigned_to: 'profile-other' })).toBe(false);
  });

  it('lets every other workspace role read a case assigned to another profile', () => {
    for (const role of APP_ROLES) {
      expect(canReadCancellationCase({ role, profileId: 'profile-1' }, { assigned_to: 'profile-2' })).toBe(
        canAccessRenewals(role) && role !== 'agent',
      );
      expect(canReadCancellationCase({ role, profileId: 'profile-1' }, { assigned_to: null })).toBe(
        canAccessRenewals(role),
      );
    }
    for (const role of MANAGER_ROLES) {
      expect(canReadCancellationCase({ role }, { assigned_to: 'profile-2' })).toBe(true);
    }
    // A role with no access to the workspace reads nothing.
    expect(canReadCancellationCase({ role: 'commercial' }, { assigned_to: null })).toBe(false);
  });

  it('restricts the list to the readable rows that satisfy both the filter and the search', () => {
    const mine = caseWorld({ id: 'case-mine', assigned_to: 'profile-agent', customer_name: 'Ana Reyes' });
    const theirs = caseWorld({ id: 'case-theirs', assigned_to: 'profile-other', customer_name: 'Ana Reyes' });
    const unassigned = caseWorld({ id: 'case-open', assigned_to: null, customer_name: 'Bea Cruz' });
    const rows = [mine, theirs, unassigned];
    const viewer = { role: 'agent' as AppRole, profileId: 'profile-agent' };

    expect(readableCancellationRows(rows, viewer).map((row) => row.case.id)).toEqual([
      'case-mine',
      'case-open',
    ]);
    expect(readableCancellationRows(rows, undefined)).toHaveLength(3);

    expect(filterCancellationRows(rows, { filterId: 'all', viewer }).map((row) => row.case.id)).toEqual([
      'case-mine',
      'case-open',
    ]);
    expect(
      filterCancellationRows(rows, { filterId: 'all', viewer, searchText: 'bea' }).map((row) => row.case.id),
    ).toEqual(['case-open']);
    expect(
      filterCancellationRows(rows, { filterId: 'cancellation-today', viewer }).map((row) => row.case.id),
    ).toEqual([]);
    expect(
      filterCancellationRows(rows, { filterId: 'cancellation-today', viewer, businessDate: DAY.remaining0 })
        .map((row) => row.case.id),
    ).toEqual(['case-mine', 'case-open']);
  });

  it('loads the list in pages of at most 50 rows', () => {
    expect(CANCELLATION_PAGE_SIZE).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// The sort order (Requirement 16.5)
// ---------------------------------------------------------------------------

function sortRow(
  id: string,
  keys: {
    date?: string | null;
    amount?: number | string | null;
    name?: string | null;
    policy?: string | null;
  },
): CancellationRowState {
  return {
    case: {
      id,
      case_status: 'Open',
      cancellation_effective_date: keys.date ?? null,
      amount_due: keys.amount ?? null,
      customer_name: keys.name ?? null,
      policy_number: keys.policy ?? null,
    },
    businessDate: DAY.remaining16,
  };
}

/**
 * Ten rows reaching every one of the five comparison keys: two dates and an absent date, four
 * distinct amounts and an absent amount, names differing only in case, policy numbers differing
 * only in case, and one pair equal on all four stated keys so the case id has to break the tie.
 */
const SORT_ROWS: readonly CancellationRowState[] = [
  sortRow('r1', { date: '2026-07-10', amount: '900.00', name: 'Ana', policy: 'A-1' }),
  sortRow('r2', { date: '2026-07-10', amount: '1000.50', name: 'Ana', policy: 'A-1' }),
  sortRow('r3', { date: '2026-07-10', amount: null, name: 'Ana', policy: 'A-1' }),
  sortRow('r4', { date: '2026-07-31', amount: '5.00', name: 'Bea', policy: 'B-1' }),
  sortRow('r5', { date: null, amount: '9999.00', name: 'Zoe', policy: 'Z-1' }),
  sortRow('r6', { date: '2026-07-10', amount: '900.00', name: 'ana', policy: 'A-2' }),
  sortRow('r7', { date: '2026-07-10', amount: '900.00', name: 'ANA', policy: 'a-2' }),
  sortRow('r8', { date: '2026-07-10', amount: 412.5, name: 'Ana', policy: 'A-1' }),
  sortRow('r9', { date: '2026-07-10', amount: 'nan', name: 'Ana', policy: 'A-1' }),
  sortRow('r10', { date: '2026-07-09', amount: null, name: 'Yves', policy: 'Y-1' }),
];

const EXPECTED_SORT_ORDER = ['r10', 'r2', 'r1', 'r6', 'r7', 'r8', 'r3', 'r9', 'r4', 'r5'];

function ids(rows: readonly CancellationRowState[]): string[] {
  return rows.map((row) => row.case.id ?? '');
}

/** Every rotation of the fixture set, plus its reverse, as input permutations. */
function permutations(rows: readonly CancellationRowState[]): CancellationRowState[][] {
  const rotations = rows.map((_, index) => [...rows.slice(index), ...rows.slice(0, index)]);
  return [...rotations, [...rows].reverse()];
}

describe('the sort order', () => {
  it('orders by effective date, amount due descending, customer name, then policy number', () => {
    expect(ids(sortCancellationRows(SORT_ROWS))).toEqual(EXPECTED_SORT_ORDER);
  });

  it('orders an absent amount due after every present amount due of the same date', () => {
    const present = sortRow('present', { date: '2026-07-10', amount: '0.01', name: 'Ana', policy: 'A-1' });
    const absent = sortRow('absent', { date: '2026-07-10', amount: null, name: 'Ana', policy: 'A-1' });
    // A value the importer would have refused is an absent amount, ordered with it.
    const unparseable = sortRow('token', { date: '2026-07-10', amount: 'nan', name: 'Ana', policy: 'A-1' });

    expect(compareCancellationRows(present, absent)).toBeLessThan(0);
    expect(compareCancellationRows(absent, present)).toBeGreaterThan(0);
    expect(ids(sortCancellationRows([absent, unparseable, present]))).toEqual([
      'present',
      'absent',
      'token',
    ]);
  });

  it('orders an absent or unreadable effective date after every readable one', () => {
    const dated = sortRow('dated', { date: '2026-07-31', amount: '1.00', name: 'Ana', policy: 'A-1' });
    const undated = sortRow('undated', { date: null, amount: '9999.00', name: 'Ana', policy: 'A-1' });
    const unreadable = sortRow('unreadable', { date: 'July 2026', amount: '9999.00', name: 'Ana', policy: 'A-1' });

    expect(compareCancellationRows(dated, undated)).toBeLessThan(0);
    expect(compareCancellationRows(unreadable, dated)).toBeGreaterThan(0);
    expect(ids(sortCancellationRows([undated, dated]))).toEqual(['dated', 'undated']);
  });

  it('compares the customer name and the policy number without case sensitivity', () => {
    const lower = sortRow('lower', { date: '2026-07-10', amount: '1.00', name: 'ana', policy: 'a-1' });
    const upper = sortRow('upper', { date: '2026-07-10', amount: '1.00', name: 'ANA', policy: 'A-1' });
    // Equal on all four stated keys: only the case id separates them.
    expect(compareCancellationRows(lower, upper)).toBeLessThan(0);

    const later = sortRow('a-name', { date: '2026-07-10', amount: '1.00', name: 'bea', policy: 'A-1' });
    expect(compareCancellationRows(upper, later)).toBeLessThan(0);
  });

  it('is a total order over the fixture set', () => {
    for (const left of SORT_ROWS) {
      expect(compareCancellationRows(left, left)).toBe(0);
      for (const right of SORT_ROWS) {
        // Antisymmetry: the two directions carry opposite signs, and cancel where they are equal.
        // Summed rather than negated so that a comparison of 0 does not read as a signed zero.
        const forward = Math.sign(compareCancellationRows(left, right));
        const backward = Math.sign(compareCancellationRows(right, left));
        expect(forward + backward).toBe(0);
        expect(Math.abs(forward)).toBe(Math.abs(backward));
        // Totality: no two distinct rows compare equal, so the order of any two is determined.
        if (left !== right) expect(forward).not.toBe(0);
      }
    }

    for (const a of SORT_ROWS) {
      for (const b of SORT_ROWS) {
        if (compareCancellationRows(a, b) >= 0) continue;
        for (const c of SORT_ROWS) {
          // Transitivity.
          if (compareCancellationRows(b, c) < 0) {
            expect(compareCancellationRows(a, c)).toBeLessThan(0);
          }
        }
      }
    }
  });

  it('produces the same order for every input permutation and leaves the input unchanged', () => {
    const input = [...SORT_ROWS];
    const sorted = sortCancellationRows(input);
    expect(sorted).not.toBe(input);
    expect(ids(input)).toEqual(ids(SORT_ROWS));

    for (const permutation of permutations(SORT_ROWS)) {
      expect(ids(sortCancellationRows(permutation))).toEqual(EXPECTED_SORT_ORDER);
    }
    // Sorting an already sorted list changes nothing.
    expect(ids(sortCancellationRows(sorted))).toEqual(EXPECTED_SORT_ORDER);
  });

  it('returns the list in that order (Requirement 16.3)', () => {
    expect(
      filterCancellationRows(SORT_ROWS, { filterId: 'all', businessDate: DAY.remaining16 }).map(
        (row) => row.case.id,
      ),
    ).toEqual(EXPECTED_SORT_ORDER);
  });
});

// ---------------------------------------------------------------------------
// The primary action (Requirements 17.4, 17.10, 16.9)
// ---------------------------------------------------------------------------

describe('the primary action', () => {
  it('names the eight steps of Requirement 17.4 in order, with the manager-only three marked', () => {
    expect(PRIMARY_ACTION_STEPS).toHaveLength(8);
    expect(PRIMARY_ACTION_STEPS.map((entry) => entry.step)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(PRIMARY_ACTION_STEPS.map((entry) => entry.action)).toEqual([
      'Verify Payment',
      'Confirm Reinstatement',
      'Add Contact Information',
      'Retry Failed Communication',
      'Call Customer',
      'Send Reminder Now',
      'Mark Resolved',
      'Record Customer Response',
    ]);
    // The eight actions are distinct, so an action identifies the step that produced it.
    expect(new Set(PRIMARY_ACTION_STEPS.map((entry) => entry.action)).size).toBe(8);
    expect(PRIMARY_ACTION_STEPS.filter((entry) => entry.managerOnly).map((entry) => entry.step)).toEqual([
      'a',
      'b',
      'd',
    ]);
    for (const entry of PRIMARY_ACTION_STEPS) {
      expect(entry.managerOnly).toBe((MANAGER_ONLY_ACTIONS as readonly NextRequiredAction[]).includes(entry.action));
      expect(entry.condition.length).toBeGreaterThan(0);
    }
  });

  it('reaches each of the eight steps for a Manager_Role viewer', () => {
    const expected: Record<PrimaryActionStep, NextRequiredAction> = {
      a: 'Verify Payment',
      b: 'Confirm Reinstatement',
      c: 'Add Contact Information',
      d: 'Retry Failed Communication',
      e: 'Call Customer',
      f: 'Send Reminder Now',
      g: 'Mark Resolved',
      h: 'Record Customer Response',
    };

    for (const [step, state] of Object.entries(PRIMARY_ACTION_WORLDS) as [PrimaryActionStep, CancellationRowState][]) {
      expect(primaryAction(state, 'manager')).toBe(expected[step]);
      expect(primaryActionStep(state, 'manager')).toBe(step);
      // `super_admin` inherits every `manager` permission, so it reaches the same step.
      expect(primaryAction(state, 'super_admin')).toBe(expected[step]);
      expect(primaryActionStep(state, 'super_admin')).toBe(step);
      // An absent role reads as the unrestricted Manager_Role view.
      expect(primaryAction(state)).toBe(expected[step]);
      expect(primaryAction(state, null)).toBe(expected[step]);
    }
  });

  it('reaches step (a) from either payment Case_Status and step (g) from Invalid and Duplicate', () => {
    for (const status of PAYMENT_VERIFICATION_CASE_STATUSES) {
      expect(primaryAction(caseWorld({ case_status: status }), 'manager')).toBe('Verify Payment');
    }
    for (const status of ['Invalid', 'Duplicate'] as const) {
      expect(primaryActionStep(caseWorld({ case_status: status }))).toBe('g');
    }
    // Step (f) also covers an Imported case with no record for the current Touchpoint.
    expect(
      primaryActionStep(caseWorld({ case_status: 'Imported' }, { businessDate: DAY.remaining15, communications: [] })),
    ).toBe('f');
  });

  it('skips a step whose control is hidden from agent and considers the next one', () => {
    // Reading 9. A Failed case offers a manager Retry Failed Communication; the control is not on
    // an agent's screen, so the ladder continues past it and settles on Record Customer Response.
    const failed = PRIMARY_ACTION_WORLDS.d;
    expect(primaryAction(failed, 'manager')).toBe('Retry Failed Communication');
    for (const role of AGENT_ROLES) {
      expect(primaryAction(failed, role)).toBe('Record Customer Response');
      expect(primaryActionStep(failed, role)).toBe('h');
    }

    // The same skip on a Partially Failed case.
    const partiallyFailed = world({
      businessDate: DAY.remaining15,
      communications: [record(15, 'sms', 'Failed'), record(15, 'email', 'Delivered')],
    });
    expect(primaryAction(partiallyFailed, 'manager')).toBe('Retry Failed Communication');
    expect(primaryAction(partiallyFailed, 'agent')).toBe('Record Customer Response');

    // Steps (a) and (b) are hidden from an agent too.
    expect(primaryAction(PRIMARY_ACTION_WORLDS.a, 'agent')).toBe('Record Customer Response');
    expect(primaryAction(PRIMARY_ACTION_WORLDS.b, 'agent')).toBe('Record Customer Response');
  });

  it('offers an agent the same action as a manager where no hidden step precedes it', () => {
    for (const step of ['c', 'e', 'f', 'g', 'h'] as const) {
      const state = PRIMARY_ACTION_WORLDS[step];
      for (const role of AGENT_ROLES) {
        expect(primaryActionStep(state, role)).toBe(step);
        expect(primaryAction(state, role)).toBe(primaryAction(state, 'manager'));
      }
    }
  });

  it('takes the role from the state bundle and lets an explicit role override it', () => {
    const failed = world({
      viewerRole: 'agent',
      businessDate: DAY.remaining15,
      communications: [record(15, 'sms', 'Failed')],
    });
    expect(primaryAction(failed)).toBe('Record Customer Response');
    expect(primaryAction(failed, 'manager')).toBe('Retry Failed Communication');
  });

  it('has no primary action where the next required action has been cleared', () => {
    // Reading 10: a null stored column together with Reinstated, Cancelled, or Resolved is a
    // cleared action, and such a case does not reach step (g).
    for (const status of ['Reinstated', 'Cancelled', 'Resolved'] as const) {
      const cleared = caseWorld({ case_status: status, next_required_action: null });
      expect(primaryAction(cleared)).toBeNull();
      expect(primaryActionStep(cleared)).toBeNull();
    }
    // A stored action on the same status is not cleared, so the ladder runs and reaches (g).
    expect(
      primaryActionStep(caseWorld({ case_status: 'Reinstated', next_required_action: 'Mark Resolved' })),
    ).toBe('g');
    // Invalid and Duplicate are never cleared, so a null column there is an action never set.
    expect(primaryAction(caseWorld({ case_status: 'Invalid', next_required_action: null }))).toBe('Mark Resolved');
  });

  it('hides the four manager-only controls from Agent_Role and shows them to manager and super_admin', () => {
    expect([...MANAGER_ONLY_ACTIONS]).toEqual([
      'Verify Payment',
      'Confirm Reinstatement',
      'Confirm Cancellation',
      'Retry Failed Communication',
    ]);

    for (const action of MANAGER_ONLY_ACTIONS) {
      for (const role of MANAGER_ROLES) expect(isActionVisibleToRole(action, role)).toBe(true);
      for (const role of AGENT_ROLES) expect(isActionVisibleToRole(action, role)).toBe(false);
      // An absent role reads as the unrestricted Manager_Role view.
      expect(isActionVisibleToRole(action, null)).toBe(true);
      expect(isActionVisibleToRole(action, undefined)).toBe(true);
    }

    for (const action of NEXT_REQUIRED_ACTIONS) {
      if ((MANAGER_ONLY_ACTIONS as readonly NextRequiredAction[]).includes(action)) continue;
      for (const role of APP_ROLES) expect(isActionVisibleToRole(action, role)).toBe(true);
    }
  });

  it('shows an agent the five controls of Requirement 17.10 and a manager all nine', () => {
    for (const role of AGENT_ROLES) {
      expect(visibleCancellationActions(role)).toEqual([
        'Add Contact Information',
        'Send Reminder Now',
        'Call Customer',
        'Record Customer Response',
        'Mark Resolved',
      ]);
    }
    for (const role of MANAGER_ROLES) {
      expect(visibleCancellationActions(role)).toEqual([...NEXT_REQUIRED_ACTIONS]);
      expect(visibleCancellationActions(role)).toHaveLength(9);
    }
    expect(visibleCancellationActions('super_admin')).toEqual(visibleCancellationActions('manager'));
  });
});

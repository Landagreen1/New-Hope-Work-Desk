import { describe, expect, it } from 'vitest';

import { primaryAction, type CancellationRowState } from '../../cancellations/derive';
import { recommendedNextAction, type RenewalDeriveContact } from '../../renewals/derive';
import {
  cancellationWaitingReason,
  cancellationWorkItem,
  comparePolicyWorkItems,
  derivePolicyUrgency,
  isClosedWorkItem,
  openPolicyWorkItems,
  policyWorkBucket,
  policyWorkCounts,
  policyWorkForProfile,
  renewalNormalizedStatus,
  renewalWaitingReason,
  renewalWorkItem,
  sortPolicyWorkItems,
  type RenewalProjectionRecord,
} from '../work-projection';
import type { PolicyWorkItem } from '../types';

/** The business date every case below is projected against. */
const TODAY = '2026-02-10';

function inDays(days: number): string {
  return new Date(Date.UTC(2026, 1, 10) + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function renewalRecord(overrides: Partial<RenewalProjectionRecord> = {}): RenewalProjectionRecord {
  return {
    id: 'renewal-1',
    status: 'assigned',
    customer_name: 'Synthetic Alpha LLC',
    policy_number: 'POL-0001',
    renewal_date: inDays(45),
    carrier: 'Progressive',
    assigned_to: 'profile-a',
    ...overrides,
  };
}

function contactsAt(...times: readonly string[]): RenewalDeriveContact[] {
  return times.map((occurred_at) => ({ occurred_at }));
}

function validContact() {
  return {
    channel: 'phone' as const,
    normalized_value: '+13055550101',
    validation_status: 'valid' as const,
    authorization_status: 'Unknown' as const,
    sms_suppressed: false,
    email_suppressed: false,
  };
}

function cancellationState(
  caseOverrides: Partial<CancellationRowState['case']> = {},
  stateOverrides: Partial<CancellationRowState> = {},
): CancellationRowState {
  return {
    case: {
      id: 'case-1',
      case_status: 'Imported',
      cancellation_effective_date: inDays(20),
      policy_number: 'POL-0001',
      customer_name: 'Synthetic Alpha LLC',
      carrier: 'Progressive',
      assigned_to: 'profile-a',
      ...caseOverrides,
    },
    contacts: [validContact()],
    businessDate: TODAY,
    ...stateOverrides,
  };
}

// ---------------------------------------------------------------------------
// derivePolicyUrgency (Requirement 6.2, design 7.4)
// ---------------------------------------------------------------------------

describe('derivePolicyUrgency', () => {
  const urgency = (overrides: Partial<Parameters<typeof derivePolicyUrgency>[0]> = {}) =>
    derivePolicyUrgency({
      actionDueDate: null,
      eventDaysRemaining: 45,
      domain: 'renewal',
      actionRequired: true,
      requoteRequired: false,
      communicationFailed: false,
      waitingReason: null,
      businessDate: TODAY,
      ...overrides,
    });

  it('is critical for an overdue action', () => {
    const result = urgency({ actionDueDate: inDays(-1) });

    expect(result.urgency).toBe('critical');
    expect(result.criticalReasons).toContain('action_overdue');
  });

  it('is critical for an active cancellation inside three days that needs an employee', () => {
    const result = urgency({ domain: 'cancellation', eventDaysRemaining: 3 });

    expect(result.urgency).toBe('critical');
    expect(result.criticalReasons).toContain('cancellation_imminent');
  });

  it('is not critical for a cancellation inside three days that needs nobody', () => {
    expect(urgency({ domain: 'cancellation', eventDaysRemaining: 1, actionRequired: false }).urgency)
      .toBe('later');
  });

  it('does not apply the imminent clause to a renewal', () => {
    expect(urgency({ domain: 'renewal', eventDaysRemaining: 1 }).urgency).toBe('later');
  });

  it('is critical for a requote that has not been started', () => {
    const result = urgency({ requoteRequired: true });

    expect(result.urgency).toBe('critical');
    expect(result.criticalReasons).toContain('requote_required');
  });

  it('is critical for a failed communication', () => {
    const result = urgency({ communicationFailed: true });

    expect(result.urgency).toBe('critical');
    expect(result.criticalReasons).toContain('communication_failed');
  });

  it('collects every critical reason that holds, not only the first', () => {
    const result = urgency({
      actionDueDate: inDays(-2),
      domain: 'cancellation',
      eventDaysRemaining: 1,
      requoteRequired: true,
      communicationFailed: true,
    });

    expect(result.criticalReasons).toEqual([
      'action_overdue',
      'cancellation_imminent',
      'requote_required',
      'communication_failed',
    ]);
  });

  it('is today for an action due on the business date', () => {
    expect(urgency({ actionDueDate: TODAY }).urgency).toBe('today');
  });

  it('is upcoming for an action due inside seven days, inclusively', () => {
    expect(urgency({ actionDueDate: inDays(1) }).urgency).toBe('upcoming');
    expect(urgency({ actionDueDate: inDays(7) }).urgency).toBe('upcoming');
    expect(urgency({ actionDueDate: inDays(8) }).urgency).toBe('later');
  });

  it('is waiting for a recorded dependency with nothing due', () => {
    expect(urgency({ waitingReason: 'Waiting on the customer' }).urgency).toBe('waiting');
  });

  it('prefers a due date to a waiting reason, so somebody acts on it', () => {
    expect(urgency({ actionDueDate: TODAY, waitingReason: 'Waiting on the customer' }).urgency)
      .toBe('today');
  });

  it('is later for active work with nothing due inside a week', () => {
    expect(urgency({}).urgency).toBe('later');
  });
});

// ---------------------------------------------------------------------------
// The renewal adapter (Requirements 5.1, 5.2, 7.2)
// ---------------------------------------------------------------------------

describe('renewalWorkItem', () => {
  it('projects the identity, the customer, and the event date', () => {
    const item = renewalWorkItem({ record: renewalRecord(), businessDate: TODAY });

    expect(item.domain).toBe('renewal');
    expect(item.sourceId).toBe('renewal-1');
    expect(item.carrierKey).toBe('PROGRESSIVE');
    expect(item.policyNumberNormalized).toBe('POL-0001');
    expect(item.customerName).toBe('Synthetic Alpha LLC');
    expect(item.eventDate).toBe(inDays(45));
    expect(item.daysRemaining).toBe(45);
    expect(item.assignedTo).toBe('profile-a');
  });

  it('uses recommendedNextAction, so the shared view and the Renewals list agree', () => {
    const record = renewalRecord({ status: 'in_progress' });
    const contacts = contactsAt('2026-02-01T15:00:00Z');
    const item = renewalWorkItem({ record, contacts, businessDate: TODAY });

    expect(item.nextAction).toBe(recommendedNextAction(record, contacts, []));
  });

  it('shows Make first contact when the bulk summary reports no contact', () => {
    const item = renewalWorkItem({ record: renewalRecord(), contacts: [], businessDate: TODAY });

    expect(item.nextAction).toBe('Make first contact');
  });

  it('forces Prepare requote for a Carrier Non-Renewal with no requote activity (Req 7.2)', () => {
    const item = renewalWorkItem({
      record: renewalRecord({ source_state_normalized: 'carrier_nonrenewal' }),
      contacts: contactsAt('2026-02-01T15:00:00Z'),
      businessDate: TODAY,
    });

    expect(item.nextAction).toBe('Prepare requote');
    expect(item.normalizedStatus).toBe('Carrier Non-Renewal / Requote Required');
    expect(item.urgency).toBe('critical');
    expect(item.criticalReasons).toContain('requote_required');
  });

  it('never marks a Carrier Non-Renewal Lost (Req 7.2)', () => {
    const item = renewalWorkItem({
      record: renewalRecord({ source_state_normalized: 'carrier_nonrenewal' }),
      businessDate: TODAY,
    });

    expect(item.normalizedStatus).not.toContain('Lost');
    expect(isClosedWorkItem(item)).toBe(false);
  });

  it('stops forcing a requote once requote activity exists', () => {
    const item = renewalWorkItem({
      record: renewalRecord({
        source_state_normalized: 'carrier_nonrenewal',
        requote_sent_at: '2026-02-08T10:00:00Z',
      }),
      businessDate: TODAY,
    });

    expect(item.criticalReasons).not.toContain('requote_required');
    expect(item.nextAction).toBe('Review requote');
  });

  it('reports Review renewal for a contacted collector renewal with no scheduled follow-up', () => {
    const item = renewalWorkItem({
      record: renewalRecord({ status: 'in_progress', source_state_normalized: 'renewal' }),
      contacts: contactsAt('2026-02-08T15:00:00Z'),
      businessDate: TODAY,
    });

    expect(item.nextAction).toBe('Review renewal');
  });

  it('scores the item from the shared weight model', () => {
    expect(renewalWorkItem({
      record: renewalRecord({ renewal_date: inDays(2) }),
      businessDate: TODAY,
    }).workloadPoints).toBe(5);

    expect(renewalWorkItem({
      record: renewalRecord({ source_state_normalized: 'carrier_nonrenewal' }),
      businessDate: TODAY,
    }).workloadPoints).toBe(7);
  });

  it('reports a closed renewal as closed, with no action and no points', () => {
    const item = renewalWorkItem({ record: renewalRecord({ status: 'renewed' }), businessDate: TODAY });

    expect(item.nextAction).toBeNull();
    expect(item.workloadPoints).toBe(0);
    expect(isClosedWorkItem(item)).toBe(true);
  });

  it('reports the review and communication blocks from the stored source flags', () => {
    const item = renewalWorkItem({
      record: renewalRecord({
        source_review_required: true,
        source_communication_blocked: true,
      }),
      businessDate: TODAY,
    });

    expect(item.reviewRequired).toBe(true);
    expect(item.communicationBlocked).toBe(true);
  });

  it('reports the latest contact from the bulk summary', () => {
    const item = renewalWorkItem({
      record: renewalRecord(),
      contacts: contactsAt('2026-02-01T15:00:00Z'),
      lastContactAt: '2026-02-09T12:00:00Z',
      businessDate: TODAY,
    });

    expect(item.lastContactAt).toBe('2026-02-09T12:00:00Z');
  });
});

describe('renewalNormalizedStatus', () => {
  it('never exposes a raw stored enum or a Spanish source value (Req 1.2, 6.3)', () => {
    for (const status of ['imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent'] as const) {
      const text = renewalNormalizedStatus(renewalRecord({ status }));
      expect(text).not.toContain('_');
      expect(text[0]).toBe(text[0].toUpperCase());
    }
  });

  it('reads a review-required record as Review Required', () => {
    expect(renewalNormalizedStatus(renewalRecord({ source_state_normalized: 'review_required' })))
      .toBe('Review Required');
  });
});

describe('renewalWaitingReason', () => {
  it('names only the two statuses that record a dependency', () => {
    expect(renewalWaitingReason(renewalRecord({ status: 'monitoring' }))).toBe('Waiting on the customer');
    expect(renewalWaitingReason(renewalRecord({ status: 'requote_sent' })))
      .toBe('Requote is with the customer');
    expect(renewalWaitingReason(renewalRecord({ status: 'assigned' }))).toBeNull();
    expect(renewalWaitingReason(renewalRecord({ status: 'in_progress' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The cancellation adapter (Requirement 5.3, task 6.5)
// ---------------------------------------------------------------------------

describe('cancellationWorkItem', () => {
  it('projects the identity, the customer, and the effective date', () => {
    const item = cancellationWorkItem({ state: cancellationState(), businessDate: TODAY });

    expect(item.domain).toBe('cancellation');
    expect(item.sourceId).toBe('case-1');
    expect(item.carrierKey).toBe('PROGRESSIVE');
    expect(item.policyNumberNormalized).toBe('POL-0001');
    expect(item.eventDate).toBe(inDays(20));
    expect(item.daysRemaining).toBe(20);
  });

  it('reports the SAME next action the existing cancellation engine reports (Req 5.3)', () => {
    // The one assertion Requirement 5.3 turns on: the shared item and the drawer/list cell must
    // name one action for the same state and the same role, because they are one function call.
    const cases: readonly [string, CancellationRowState][] = [
      ['no contactable contact', cancellationState({}, { contacts: [] })],
      ['open with no record for the touchpoint', cancellationState()],
      ['payment reported', cancellationState({ case_status: 'Payment Reported' })],
      ['verification pending', cancellationState({ case_status: 'Verification Pending' })],
      ['reinstatement pending', cancellationState({ case_status: 'Reinstatement Pending' })],
      ['invalid', cancellationState({ case_status: 'Invalid' })],
      ['duplicate', cancellationState({ case_status: 'Duplicate' })],
    ];

    for (const role of ['agent', 'manager', 'super_admin', 'customer_service'] as const) {
      for (const [label, state] of cases) {
        const item = cancellationWorkItem({ state, viewerRole: role, businessDate: TODAY });

        expect(item.nextAction, `${label} as ${role}`)
          .toBe(primaryAction({ ...state, businessDate: TODAY }, role));
      }
    }
  });

  it('still offers Mark Resolved on an Invalid or Duplicate case, as the drawer does', () => {
    // Neither status is "active", but both still owe an employee one action. Excluding them would
    // hide real work and contradict the drawer (Requirement 5.3).
    for (const caseStatus of ['Invalid', 'Duplicate'] as const) {
      const item = cancellationWorkItem({
        state: cancellationState({ case_status: caseStatus }),
        viewerRole: 'agent',
        businessDate: TODAY,
      });

      expect(item.nextAction).toBe('Mark Resolved');
      expect(isClosedWorkItem(item)).toBe(false);
    }
  });

  it('does not call an inactive case imminent just because its date has passed', () => {
    const item = cancellationWorkItem({
      state: cancellationState({ case_status: 'Invalid', cancellation_effective_date: inDays(-2) }),
      viewerRole: 'agent',
      businessDate: TODAY,
    });

    expect(item.criticalReasons).not.toContain('cancellation_imminent');
  });

  it('withholds a manager-only action from an agent, exactly as the drawer does', () => {
    const state = cancellationState({ case_status: 'Payment Reported' });

    expect(cancellationWorkItem({ state, viewerRole: 'manager', businessDate: TODAY }).nextAction)
      .toBe('Verify Payment');
    expect(cancellationWorkItem({ state, viewerRole: 'agent', businessDate: TODAY }).nextAction)
      .not.toBe('Verify Payment');
  });

  it('keeps the stored case_status as the operational status', () => {
    expect(cancellationWorkItem({
      state: cancellationState({ case_status: 'Verification Pending' }),
      businessDate: TODAY,
    }).normalizedStatus).toBe('Verification Pending');
  });

  it('is critical inside three days of the effective date', () => {
    const item = cancellationWorkItem({
      state: cancellationState({ cancellation_effective_date: inDays(2) }),
      businessDate: TODAY,
    });

    expect(item.urgency).toBe('critical');
    expect(item.criticalReasons).toContain('cancellation_imminent');
  });

  it('is critical when the latest communication failed', () => {
    const item = cancellationWorkItem({
      state: cancellationState({}, {
        communications: [
          { touchpoint: 15, channel: 'sms', delivery_result: 'Failed', send_time: '2026-02-01T10:00:00Z' },
        ],
      }),
      businessDate: TODAY,
    });

    expect(item.urgency).toBe('critical');
    expect(item.criticalReasons).toContain('communication_failed');
  });

  it('is waiting on a payment awaiting verification, with nothing due', () => {
    const item = cancellationWorkItem({
      state: cancellationState({ case_status: 'Verification Pending', cancellation_effective_date: inDays(40) }),
      viewerRole: 'agent',
      businessDate: TODAY,
    });

    expect(item.waitingReason).toBe('Waiting on payment verification');
    expect(item.urgency).toBe('waiting');
  });

  it('scores the item from the shared weight model', () => {
    expect(cancellationWorkItem({
      state: cancellationState({ cancellation_effective_date: inDays(0) }),
      businessDate: TODAY,
    }).workloadPoints).toBe(10);

    expect(cancellationWorkItem({
      state: cancellationState({
        case_status: 'Payment Reported',
        cancellation_effective_date: inDays(40),
      }),
      businessDate: TODAY,
    }).workloadPoints).toBe(7);
  });

  it('reports a resolved case as closed, with no action and no points', () => {
    const item = cancellationWorkItem({
      state: cancellationState({ case_status: 'Resolved' }),
      businessDate: TODAY,
    });

    expect(item.nextAction).toBeNull();
    expect(item.waitingReason).toBeNull();
    expect(item.workloadPoints).toBe(0);
    expect(isClosedWorkItem(item)).toBe(true);
  });

  it('marks an Import Review case review-required and communication-blocked', () => {
    const item = cancellationWorkItem({
      state: cancellationState({ case_status: 'Import Review Required' }),
      businessDate: TODAY,
    });

    expect(item.reviewRequired).toBe(true);
    expect(item.communicationBlocked).toBe(true);
  });

  it('marks an estimated effective date communication-blocked (Req 8.3)', () => {
    const item = cancellationWorkItem({
      state: cancellationState(),
      eventDateEstimated: true,
      businessDate: TODAY,
    });

    expect(item.eventDateEstimated).toBe(true);
    expect(item.communicationBlocked).toBe(true);
  });
});

describe('cancellationWaitingReason', () => {
  it('names only the three statuses that record a dependency', () => {
    expect(cancellationWaitingReason('Payment Reported')).not.toBeNull();
    expect(cancellationWaitingReason('Verification Pending')).not.toBeNull();
    expect(cancellationWaitingReason('Reinstatement Pending')).not.toBeNull();
    expect(cancellationWaitingReason('Imported')).toBeNull();
    expect(cancellationWaitingReason('Open')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The combined list (Requirements 6.2, 7.3, 7.5)
// ---------------------------------------------------------------------------

describe('the combined work list', () => {
  function item(overrides: Partial<PolicyWorkItem>): PolicyWorkItem {
    return {
      domain: 'renewal',
      sourceId: 'x',
      carrier: 'Progressive',
      carrierKey: 'PROGRESSIVE',
      policyNumber: 'POL',
      policyNumberNormalized: 'POL',
      customerName: 'Customer',
      assignedTo: 'profile-a',
      assignedName: 'Agent A',
      eventDate: inDays(30),
      daysRemaining: 30,
      eventDateEstimated: false,
      normalizedStatus: 'Assigned — contact required',
      sourceState: 'renewal',
      nextAction: 'Complete follow-up',
      actionDueDate: null,
      lastContactAt: null,
      waitingReason: null,
      urgency: 'later',
      criticalReasons: [],
      workloadPoints: 1,
      reviewRequired: false,
      communicationBlocked: false,
      ...overrides,
    };
  }

  it('counts all five buckets', () => {
    const counts = policyWorkCounts([
      item({ urgency: 'critical' }),
      item({ urgency: 'critical' }),
      item({ urgency: 'today' }),
      item({ urgency: 'upcoming' }),
      item({ urgency: 'waiting' }),
      item({ urgency: 'later' }),
    ]);

    expect(counts).toEqual({ critical: 2, today: 1, upcoming: 1, waiting: 1, later: 1 });
  });

  it('orders Critical first, then the action date, then the event date, then the customer', () => {
    const ordered = sortPolicyWorkItems([
      item({ sourceId: 'later', urgency: 'later' }),
      item({ sourceId: 'today', urgency: 'today', actionDueDate: TODAY }),
      item({ sourceId: 'critical-late', urgency: 'critical', actionDueDate: inDays(-1) }),
      item({ sourceId: 'critical-later', urgency: 'critical', actionDueDate: inDays(-5) }),
      item({ sourceId: 'upcoming', urgency: 'upcoming', actionDueDate: inDays(3) }),
    ]);

    expect(ordered.map((entry) => entry.sourceId)).toEqual([
      'critical-later', 'critical-late', 'today', 'upcoming', 'later',
    ]);
  });

  it('puts an undated obligation after a dated one inside a bucket', () => {
    const ordered = sortPolicyWorkItems([
      item({ sourceId: 'undated', urgency: 'critical', actionDueDate: null }),
      item({ sourceId: 'dated', urgency: 'critical', actionDueDate: inDays(-1) }),
    ]);

    expect(ordered.map((entry) => entry.sourceId)).toEqual(['dated', 'undated']);
  });

  it('is a total order, so the list does not reshuffle between refreshes', () => {
    const a = item({ sourceId: 'a' });
    const b = item({ sourceId: 'b' });

    expect(comparePolicyWorkItems(a, b)).toBeLessThan(0);
    expect(comparePolicyWorkItems(b, a)).toBeGreaterThan(0);
    expect(comparePolicyWorkItems(a, a)).toBe(0);
  });

  it('returns one bucket in order', () => {
    const bucket = policyWorkBucket([
      item({ sourceId: 'c1', urgency: 'critical', actionDueDate: inDays(-1) }),
      item({ sourceId: 'l1', urgency: 'later' }),
      item({ sourceId: 'c2', urgency: 'critical', actionDueDate: inDays(-9) }),
    ], 'critical');

    expect(bucket.map((entry) => entry.sourceId)).toEqual(['c2', 'c1']);
  });

  it('filters to one employee', () => {
    const mine = policyWorkForProfile([
      item({ sourceId: 'mine', assignedTo: 'profile-a' }),
      item({ sourceId: 'theirs', assignedTo: 'profile-b' }),
      item({ sourceId: 'nobody', assignedTo: null }),
    ], 'profile-a');

    expect(mine.map((entry) => entry.sourceId)).toEqual(['mine']);
  });

  it('excludes closed items from My Work (task 6.8)', () => {
    const open = openPolicyWorkItems([
      item({ sourceId: 'open' }),
      item({ sourceId: 'closed', nextAction: null, waitingReason: null }),
      item({ sourceId: 'waiting', nextAction: null, waitingReason: 'Waiting on the customer' }),
    ]);

    expect(open.map((entry) => entry.sourceId)).toEqual(['open', 'waiting']);
  });
});

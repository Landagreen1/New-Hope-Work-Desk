// The drawer operational headers (Requirement 6.5, tasks 8.1 to 8.3).
//
// Both drawers gained a prominent header. Neither gained a second derivation: the values in the
// renewal header come from `renewalNormalizedStatus`, `renewalWaitingReason`, and
// `recommendedNextAction`, and the values in the cancellation header come from
// `cancellationRowCells` — all of which already existed and are already tested.
//
// This file pins the two claims that could regress silently:
//   1. the renewal header names the *operational* status, so a Carrier Non-Renewal reads as one
//      whatever its stored workflow status is (Requirement 7.2), and never reads `Lost`;
//   2. the cancellation drawer's promoted next action is still the one the list cell and the
//      drawer's own prominent control name — the same value, read once (Requirement 5.3).

import { describe, expect, it } from 'vitest';

import {
  cancellationRowCells,
  primaryAction,
  type CancellationRowState,
} from '../../cancellations/derive';
import { cancellationDrawerControls } from '../../cancellations/CancellationDrawer';
import {
  recommendedNextAction,
  renewalNormalizedStatus,
  renewalWaitingReason,
  type RenewalDeriveRecord,
} from '../../renewals/derive';

const TODAY = '2026-02-10';

function renewal(overrides: Partial<RenewalDeriveRecord> = {}): RenewalDeriveRecord {
  return {
    id: 'record-1',
    status: 'assigned',
    customer_name: 'Header Customer LLC',
    policy_number: 'POL-1',
    renewal_date: '2026-04-01',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The renewal header (task 8.1)
// ---------------------------------------------------------------------------

describe('the renewal drawer operational header', () => {
  it('names an operational status rather than a stored enum, for every workflow status', () => {
    for (const status of [
      'imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent', 'renewed', 'lost', 'cancelled',
    ] as const) {
      const text = renewalNormalizedStatus(renewal({ status }));

      expect(text).not.toContain('_');
      expect(text.length).toBeGreaterThan(0);
      expect(text[0]).toBe(text[0].toUpperCase());
    }
  });

  it('reads a Carrier Non-Renewal as one whatever the stored status says (Requirement 7.2)', () => {
    for (const status of ['imported', 'assigned', 'in_progress', 'monitoring'] as const) {
      expect(renewalNormalizedStatus(renewal({
        status,
        source_state_normalized: 'carrier_nonrenewal',
      }))).toBe('Carrier Non-Renewal / Requote Required');
    }
  });

  it('never presents a Carrier Non-Renewal as Lost', () => {
    const text = renewalNormalizedStatus(renewal({ source_state_normalized: 'carrier_nonrenewal' }));

    expect(text.toLowerCase()).not.toContain('lost');
  });

  it('reads an unrecognized imported status as Review Required', () => {
    expect(renewalNormalizedStatus(renewal({ source_state_normalized: 'review_required' })))
      .toBe('Review Required');
  });

  it('leaves a legacy record with no source state on its workflow status', () => {
    expect(renewalNormalizedStatus(renewal({ status: 'monitoring' }))).toBe('Waiting on customer');
  });

  it('names a waiting reason only for the two statuses that record a dependency', () => {
    expect(renewalWaitingReason(renewal({ status: 'monitoring' }))).toBe('Waiting on the customer');
    expect(renewalWaitingReason(renewal({ status: 'requote_sent' })))
      .toBe('Requote is with the customer');

    for (const status of ['imported', 'assigned', 'in_progress'] as const) {
      expect(renewalWaitingReason(renewal({ status }))).toBeNull();
    }
  });

  it('promotes the same action the list cell shows, not a second derivation', () => {
    const record = renewal({ status: 'in_progress', source_state_normalized: 'carrier_nonrenewal' });
    const contacts = [{ occurred_at: '2026-02-08T10:00:00Z' }];

    // The header renders `recommendedNextAction(record, contacts, requotes)` — the same call the
    // list row makes with the same inputs.
    expect(recommendedNextAction(record, contacts, [])).toBe('Prepare requote');
  });
});

// ---------------------------------------------------------------------------
// The cancellation header (task 8.3)
// ---------------------------------------------------------------------------

function cancellationState(
  caseOverrides: Partial<CancellationRowState['case']> = {},
  stateOverrides: Partial<CancellationRowState> = {},
): CancellationRowState {
  return {
    case: {
      id: 'case-1',
      case_status: 'Imported',
      communication_status: 'Not Scheduled',
      cancellation_effective_date: '2026-02-20',
      policy_number: 'POL-1',
      customer_name: 'Header Case LLC',
      carrier: 'Progressive',
      assigned_to: 'profile-a',
      ...caseOverrides,
    },
    contacts: [{
      channel: 'phone',
      normalized_value: '+13055550101',
      validation_status: 'valid',
      authorization_status: 'Unknown',
      sms_suppressed: false,
      email_suppressed: false,
    }],
    businessDate: TODAY,
    ...stateOverrides,
  };
}

describe('the cancellation drawer operational header', () => {
  it('promotes the value cancellationRowCells already derived, for every case status', () => {
    for (const caseStatus of [
      'Imported', 'Open', 'Payment Reported', 'Verification Pending', 'Reinstatement Pending',
      'Reinstated', 'Cancelled', 'Resolved', 'Invalid', 'Duplicate', 'Import Review Required',
    ] as const) {
      for (const role of ['agent', 'manager', 'super_admin'] as const) {
        const state = cancellationState({ case_status: caseStatus }, { viewerRole: role });
        const cells = cancellationRowCells(state);
        const action = primaryAction(state, role);

        // The header renders `cells.nextRequiredAction`. It must equal the ladder's answer, which is
        // what keeps the header, the list cell, and the prominent control naming one action.
        expect(cells.nextRequiredAction, `${caseStatus} as ${role}`)
          .toBe(action === null ? '\u2014' : action);
      }
    }
  });

  it('agrees with the drawer control the ladder promoted', () => {
    for (const caseStatus of ['Imported', 'Payment Reported', 'Reinstatement Pending'] as const) {
      for (const role of ['agent', 'manager'] as const) {
        const state = cancellationState({ case_status: caseStatus }, { viewerRole: role });
        const controls = cancellationDrawerControls(state, role);
        const prominent = controls.filter((control) => control.prominent);

        // At most one control is prominent, and where one is, the header names its action.
        expect(prominent.length, `${caseStatus} as ${role}`).toBeLessThanOrEqual(1);
        if (prominent.length === 1) {
          expect(cancellationRowCells(state).nextRequiredAction).toBe(prominent[0].action);
        }
      }
    }
  });

  it('still hides a manager-only action from an agent after the promotion', () => {
    const state = cancellationState({ case_status: 'Payment Reported' });

    expect(cancellationRowCells({ ...state, viewerRole: 'manager' }).nextRequiredAction)
      .toBe('Verify Payment');
    expect(cancellationRowCells({ ...state, viewerRole: 'agent' }).nextRequiredAction)
      .not.toBe('Verify Payment');
  });

  it('reads an em dash where the next action was cleared, promoting nothing', () => {
    const state = cancellationState({ case_status: 'Resolved', next_required_action: null });

    expect(cancellationRowCells(state).nextRequiredAction).toBe('\u2014');
    expect(primaryAction(state)).toBeNull();
    expect(cancellationDrawerControls(state, 'manager').filter((one) => one.prominent)).toHaveLength(0);
  });
});

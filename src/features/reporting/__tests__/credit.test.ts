/**
 * Agent credit rules.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 6.1-6.11, 16.2, 16.5
 *
 * The point of these tests is that six different questions get six different
 * answers. Today all of pricing credit, sale credit, and outcome credit resolve to
 * whichever `assigned_profile_id` the current lifecycle row happens to hold, so a
 * manager reassigning a sold quote silently moves the sale.
 */

import { describe, expect, it } from 'vitest';

import { CREDIT_ROLES, resolveCreditRoles } from '../definitions';
import type { CreditResolutionInput, QuoteEventLite } from '../types';

const ANA = 'profile-ana';
const BEN = 'profile-ben';
const CARLA = 'profile-carla';
const DIEGO = 'profile-diego';

function event(
  eventType: string,
  createdAt: string,
  actorProfileId: string | null = null,
  assignedProfileId: string | null = null,
): QuoteEventLite {
  return { eventType, createdAt, actorProfileId, assignedProfileId };
}

describe('credit roles', () => {
  it('declares exactly the six roles', () => {
    expect(CREDIT_ROLES).toEqual([
      'created_by',
      'claimed_by',
      'assigned_agent',
      'pricing_employee',
      'outcome_employee',
      'sales_credit_owner',
    ]);
  });

  it('separates creation from pricing when two employees are involved', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      priceSentAt: '2026-07-10T15:00:00Z',
      events: [
        event('created', '2026-07-10T14:00:00Z', ANA),
        event('assigned', '2026-07-10T14:01:00Z', ANA, BEN),
        event('accepted', '2026-07-10T14:05:00Z', BEN),
        event('price_sent', '2026-07-10T15:00:00Z', CARLA),
      ],
    });
    expect(credit.createdBy).toBe(ANA);
    expect(credit.claimedBy).toBe(BEN);
    expect(credit.assignedAgent).toBe(BEN);
    expect(credit.pricingEmployee).toBe(CARLA);
    expect(credit.missingPricingActor).toBe(false);
  });

  it('separates the assigned agent from the employee who entered the outcome', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      outcomeAssignedProfileId: BEN,
      finalOutcome: 'sold',
      events: [
        event('accepted', '2026-07-10T14:05:00Z', BEN),
        event('sold', '2026-07-12T16:00:00Z', DIEGO),
      ],
    });
    expect(credit.salesCreditOwner).toBe(BEN);
    expect(credit.outcomeEmployee).toBe(DIEGO);
    expect(credit.attributionConflict).toBe(true);
  });

  it('raises no attribution conflict when sales credit and the outcome actor agree', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      outcomeAssignedProfileId: BEN,
      finalOutcome: 'sold',
      events: [event('sold', '2026-07-12T16:00:00Z', BEN)],
    });
    expect(credit.salesCreditOwner).toBe(BEN);
    expect(credit.outcomeEmployee).toBe(BEN);
    expect(credit.attributionConflict).toBe(false);
  });

  it('raises no attribution conflict when the outcome actor is unknown', () => {
    // A missing actor is a documentation gap, not a conflicting attribution.
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      outcomeAssignedProfileId: BEN,
      finalOutcome: 'sold',
      events: [event('sold', '2026-07-12T16:00:00Z', null)],
    });
    expect(credit.outcomeEmployee).toBeNull();
    expect(credit.attributionConflict).toBe(false);
  });

  it('freezes sales credit at the agent the outcome record held, not the current agent', () => {
    // Requirement 6.7. A manager reassigns the quote after it sold; the sale stays
    // with the agent who was credited at finalization.
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: CARLA, // reassigned after the sale
      outcomeAssignedProfileId: BEN, // held by the outcome record
      finalOutcome: 'sold',
      events: [
        event('accepted', '2026-07-10T14:05:00Z', BEN),
        event('sold', '2026-07-12T16:00:00Z', BEN),
        event('reassigned', '2026-07-20T09:00:00Z', ANA, CARLA),
      ],
    });
    expect(credit.assignedAgent).toBe(CARLA);
    expect(credit.salesCreditOwner).toBe(BEN);
  });

  it('falls back to the current assigned agent when the outcome record carries none', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      outcomeAssignedProfileId: null,
      finalOutcome: 'not_sold',
      events: [event('not_sold', '2026-07-12T16:00:00Z', BEN)],
    });
    expect(credit.salesCreditOwner).toBe(BEN);
  });

  it('leaves sales credit null while the quote is not finalized', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      events: [event('accepted', '2026-07-10T14:05:00Z', BEN)],
    });
    expect(credit.salesCreditOwner).toBeNull();
    expect(credit.outcomeEmployee).toBeNull();
    expect(credit.attributionConflict).toBe(false);
  });
});

describe('claimed by', () => {
  it('takes the actor of the earliest acceptance', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: CARLA,
      events: [
        event('accepted', '2026-07-10T16:00:00Z', CARLA),
        event('accepted', '2026-07-10T14:05:00Z', BEN),
      ],
    });
    expect(credit.claimedBy).toBe(BEN);
  });

  it('falls back to the target of the earliest assignment when nothing was accepted', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: CARLA,
      events: [
        event('assigned', '2026-07-10T14:01:00Z', ANA, BEN),
        event('reassigned', '2026-07-11T10:00:00Z', ANA, CARLA),
      ],
    });
    expect(credit.claimedBy).toBe(BEN);
  });

  it('is null when neither an acceptance nor an assignment was recorded', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      events: [event('created', '2026-07-10T14:00:00Z', ANA)],
    });
    expect(credit.claimedBy).toBeNull();
  });

  it('is null when there are no events at all', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
    });
    expect(credit.claimedBy).toBeNull();
    expect(credit.pricingEmployee).toBeNull();
    expect(credit.assignedAgent).toBe(BEN);
  });
});

describe('pricing employee', () => {
  it('takes the actor of the earliest price_sent event', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      priceSentAt: '2026-07-10T15:00:00Z',
      events: [
        event('price_sent', '2026-07-11T09:00:00Z', DIEGO),
        event('price_sent', '2026-07-10T15:00:00Z', CARLA),
      ],
    });
    expect(credit.pricingEmployee).toBe(CARLA);
  });

  it('flags a price_sent_at with no event as missing documentation', () => {
    // Requirement 6.5: pricing happened, and nobody is recorded as having done it.
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      priceSentAt: '2026-07-10T15:00:00Z',
      events: [event('accepted', '2026-07-10T14:05:00Z', BEN)],
    });
    expect(credit.pricingEmployee).toBeNull();
    expect(credit.missingPricingActor).toBe(true);
  });

  it('does not flag a quote that was never priced', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      priceSentAt: null,
      events: [event('accepted', '2026-07-10T14:05:00Z', BEN)],
    });
    expect(credit.pricingEmployee).toBeNull();
    expect(credit.missingPricingActor).toBe(false);
  });

  it('flags an event that exists with no recorded actor', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      priceSentAt: '2026-07-10T15:00:00Z',
      events: [event('price_sent', '2026-07-10T15:00:00Z', null)],
    });
    expect(credit.pricingEmployee).toBeNull();
    expect(credit.missingPricingActor).toBe(true);
  });
});

describe('outcome employee', () => {
  it('reads the event matching the final outcome, not the other one', () => {
    // A quote that was recorded Not Sold and later Sold holds both events. The
    // outcome actor must come from the event that matches the authoritative
    // outcome, or the wrong person is credited.
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      outcomeAssignedProfileId: BEN,
      finalOutcome: 'sold',
      events: [
        event('not_sold', '2026-07-11T10:00:00Z', DIEGO),
        event('sold', '2026-07-12T16:00:00Z', BEN),
      ],
    });
    expect(credit.outcomeEmployee).toBe(BEN);
  });

  it('reads the not_sold event when the final outcome is Not Sold', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      outcomeAssignedProfileId: BEN,
      finalOutcome: 'not_sold',
      events: [
        event('sold', '2026-07-11T10:00:00Z', DIEGO),
        event('not_sold', '2026-07-12T16:00:00Z', CARLA),
      ],
    });
    expect(credit.outcomeEmployee).toBe(CARLA);
  });
});

describe('created by', () => {
  it('reads work_items.created_by, which no current report uses', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: ANA,
      assignedProfileId: BEN,
    });
    expect(credit.createdBy).toBe(ANA);
    expect(credit.createdBy).not.toBe(credit.assignedAgent);
  });

  it('is null once the work_items row has moved on', () => {
    const credit = resolveCreditRoles({
      createdByProfileId: null,
      assignedProfileId: BEN,
    });
    expect(credit.createdBy).toBeNull();
  });
});

describe('joins are by profile id', () => {
  it('never depends on a display name', () => {
    // Five current aggregations join agents by display-name string equality, so
    // renaming an employee detaches their history. Every value this function
    // returns is a profile identifier.
    const input: CreditResolutionInput = {
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      outcomeAssignedProfileId: BEN,
      finalOutcome: 'sold',
      priceSentAt: '2026-07-10T15:00:00Z',
      events: [
        event('accepted', '2026-07-10T14:05:00Z', BEN),
        event('price_sent', '2026-07-10T15:00:00Z', CARLA),
        event('sold', '2026-07-12T16:00:00Z', BEN),
      ],
    };
    const credit = resolveCreditRoles(input);
    for (const value of [
      credit.createdBy,
      credit.claimedBy,
      credit.assignedAgent,
      credit.pricingEmployee,
      credit.outcomeEmployee,
      credit.salesCreditOwner,
    ]) {
      if (value !== null) expect(value).toMatch(/^profile-/);
    }
  });

  it('is a pure function of its input', () => {
    const input: CreditResolutionInput = {
      createdByProfileId: ANA,
      assignedProfileId: BEN,
      events: [event('accepted', '2026-07-10T14:05:00Z', BEN)],
    };
    expect(resolveCreditRoles(input)).toEqual(resolveCreditRoles(input));
    expect(input.events).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';

import { buildAttentionCards, pressingAttentionCards } from '../attention';
import type { PolicyFollowUpManagerOverview } from '../types';

function overview(
  overrides: {
    renewals?: Partial<PolicyFollowUpManagerOverview['renewals']>;
    cancellations?: Partial<PolicyFollowUpManagerOverview['cancellations']>;
    attention?: Partial<PolicyFollowUpManagerOverview['attention']>;
  } = {},
): PolicyFollowUpManagerOverview {
  const zeroDomain = {
    active: 0, needActionToday: 0, overdue: 0, unassigned: 0,
    neverContacted: 0, waiting: 0, completedThisMonth: 0, reviewRequired: 0,
  };
  return {
    businessDate: '2026-02-10',
    renewals: { ...zeroDomain, ...overrides.renewals },
    cancellations: { ...zeroDomain, ...overrides.cancellations },
    attention: {
      carrierNonRenewalAwaitingRequote: 0,
      paymentVerificationRequired: 0,
      failedCommunications: 0,
      reviewRequiredImports: 0,
      unmatchedProducerLabels: 0,
      matchReviewRows: 0,
      missingValidContact: 0,
      unknownImportedStatus: 0,
      unassignedPolicies: 0,
      ownershipConflicts: 0,
      ...overrides.attention,
    },
    agents: [],
    fullPopulation: true,
  };
}

describe('buildAttentionCards', () => {
  it('covers every category Requirement 9.3 names', () => {
    const ids = buildAttentionCards(overview()).map((card) => card.id);

    expect(ids).toEqual([
      'cancellations-overdue',
      'renewals-overdue',
      'cancellations-no-contact',
      'renewals-no-contact',
      'carrier-non-renewals',
      'payment-verification',
      'failed-communications',
      'missing-contact',
      'match-review',
      'unknown-status',
      'review-required-imports',
      'unmatched-producers',
      'unassigned-policies',
      'ownership-conflicts',
    ]);
  });

  it('gives every card a drill-down target, because a count nobody can open is useless', () => {
    for (const card of buildAttentionCards(overview())) {
      expect(card.target.tab).toBeTruthy();
      // Either an existing saved filter of the target list, or a narrower selector the target
      // surface understands. Never neither.
      expect(card.target.filter ?? card.target.extra).toBeTruthy();
    }
  });

  it('gives every card a hint that says what the manager is looking at', () => {
    for (const card of buildAttentionCards(overview())) {
      expect(card.label.length).toBeGreaterThan(0);
      expect(card.hint.length).toBeGreaterThan(20);
    }
  });

  it('targets saved filters the cancellations module already has', () => {
    const cards = buildAttentionCards(overview());
    const byId = new Map(cards.map((card) => [card.id, card]));

    expect(byId.get('cancellations-overdue')?.target)
      .toEqual({ tab: 'cancellations', filter: 'needs-action', extra: 'overdue' });
    expect(byId.get('payment-verification')?.target)
      .toEqual({ tab: 'cancellations', filter: 'payment-verification-required' });
    expect(byId.get('failed-communications')?.target)
      .toEqual({ tab: 'cancellations', filter: 'communication-failed' });
    expect(byId.get('missing-contact')?.target)
      .toEqual({ tab: 'cancellations', filter: 'contact-missing' });
    expect(byId.get('cancellations-no-contact')?.target)
      .toEqual({ tab: 'cancellations', filter: 'no-successful-contact' });
  });

  it('targets saved filters the renewals module already has', () => {
    const byId = new Map(buildAttentionCards(overview()).map((card) => [card.id, card]));

    expect(byId.get('renewals-overdue')?.target)
      .toEqual({ tab: 'renewals', filter: 'overdue-follow-up' });
    expect(byId.get('renewals-no-contact')?.target)
      .toEqual({ tab: 'renewals', filter: 'no-contact-recorded' });
    expect(byId.get('carrier-non-renewals')?.target)
      .toEqual({ tab: 'renewals', filter: 'requote-requested' });
  });

  it('sends the ownership exceptions to the manager surface rather than to a domain filter', () => {
    const byId = new Map(buildAttentionCards(overview()).map((card) => [card.id, card]));

    expect(byId.get('unassigned-policies')?.target).toEqual({ tab: 'manager', extra: 'unassigned' });
    expect(byId.get('ownership-conflicts')?.target).toEqual({ tab: 'manager', extra: 'conflict' });
  });

  it('sends the import exceptions to the imports surface', () => {
    for (const id of ['match-review', 'unknown-status', 'review-required-imports', 'unmatched-producers']) {
      const card = buildAttentionCards(overview()).find((entry) => entry.id === id);
      expect(card?.target.tab).toBe('imports');
    }
  });

  it('reads each count from the overview it was given', () => {
    const cards = buildAttentionCards(overview({
      renewals: { overdue: 4, neverContacted: 9 },
      cancellations: { overdue: 8, neverContacted: 3 },
      attention: {
        carrierNonRenewalAwaitingRequote: 6,
        paymentVerificationRequired: 2,
        failedCommunications: 5,
        unassignedPolicies: 12,
        ownershipConflicts: 1,
      },
    }));
    const count = (id: string) => cards.find((card) => card.id === id)?.count;

    expect(count('cancellations-overdue')).toBe(8);
    expect(count('renewals-overdue')).toBe(4);
    expect(count('cancellations-no-contact')).toBe(3);
    expect(count('renewals-no-contact')).toBe(9);
    expect(count('carrier-non-renewals')).toBe(6);
    expect(count('payment-verification')).toBe(2);
    expect(count('failed-communications')).toBe(5);
    expect(count('unassigned-policies')).toBe(12);
    expect(count('ownership-conflicts')).toBe(1);
  });

  it('keeps a zero card, so its later appearance reads as a new problem not a new feature', () => {
    expect(buildAttentionCards(overview())).toHaveLength(14);
    expect(buildAttentionCards(overview()).every((card) => card.count === 0)).toBe(true);
  });

  it('never labels a carrier non-renewal as lost', () => {
    const card = buildAttentionCards(overview())
      .find((entry) => entry.id === 'carrier-non-renewals');

    expect(card?.label.toLowerCase()).not.toContain('lost');
    expect(card?.hint).toContain('Never a lost policy');
  });
});

describe('pressingAttentionCards', () => {
  it('keeps only the categories with something in them', () => {
    const cards = pressingAttentionCards(overview({
      cancellations: { overdue: 3 },
      attention: { ownershipConflicts: 1 },
    }));

    expect(cards.map((card) => card.id)).toEqual(['cancellations-overdue', 'ownership-conflicts']);
  });

  it('is empty when nothing needs a manager', () => {
    expect(pressingAttentionCards(overview())).toEqual([]);
  });
});

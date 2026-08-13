import { describe, expect, it } from 'vitest';

import {
  calendarDaysBetween,
  cancellationWorkloadPoints,
  compareAgentWorkload,
  followUpDue,
  POLICY_WORKLOAD_WEIGHTS,
  POLICY_WORKLOAD_WEIGHT_KEYS,
  renewalWorkloadPoints,
  selectLowestWorkload,
  type AgentWorkloadSummary,
} from '../workload';

/** The business date every case below is scored against. */
const TODAY = '2026-02-10';

/** `businessDate + days` as a calendar date. */
function inDays(days: number): string {
  const base = Date.UTC(2026, 1, 10);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The weight table (Requirement 4.2)
// ---------------------------------------------------------------------------

describe('POLICY_WORKLOAD_WEIGHTS', () => {
  it('holds the Requirement 4.2 defaults verbatim', () => {
    expect(POLICY_WORKLOAD_WEIGHTS).toEqual({
      renewal_open: 1,
      renewal_due_30: 2,
      renewal_due_15: 3,
      renewal_due_7: 4,
      renewal_due_3: 5,
      renewal_nonrenewal: 7,
      renewal_overdue_followup: 5,
      cancellation_active: 2,
      cancellation_due_15: 3,
      cancellation_due_10: 4,
      cancellation_due_5: 6,
      cancellation_due_1: 10,
      cancellation_payment_verification: 7,
      cancellation_communication_manual: 4,
      cancellation_overdue_followup: 5,
    });
  });

  it('exposes every key for the database seed comparison', () => {
    expect(POLICY_WORKLOAD_WEIGHT_KEYS).toHaveLength(15);
    for (const key of POLICY_WORKLOAD_WEIGHT_KEYS) {
      expect(POLICY_WORKLOAD_WEIGHTS[key]).toBeGreaterThan(0);
    }
  });

  it('rates an urgent cancellation above a distant renewal (Requirement 4.1)', () => {
    const fortyUrgentCancellations = 40 * POLICY_WORKLOAD_WEIGHTS.cancellation_due_5;
    const seventyDistantRenewals = 70 * POLICY_WORKLOAD_WEIGHTS.renewal_due_30;

    expect(fortyUrgentCancellations).toBeGreaterThan(seventyDistantRenewals);
  });
});

// ---------------------------------------------------------------------------
// calendarDaysBetween and followUpDue
// ---------------------------------------------------------------------------

describe('calendarDaysBetween', () => {
  it('is 0 on the business date and signed either side of it', () => {
    expect(calendarDaysBetween(TODAY, TODAY)).toBe(0);
    expect(calendarDaysBetween(TODAY, '2026-02-11')).toBe(1);
    expect(calendarDaysBetween(TODAY, '2026-02-09')).toBe(-1);
  });

  it('crosses a month boundary correctly', () => {
    expect(calendarDaysBetween('2026-02-25', '2026-03-02')).toBe(5);
  });

  it('is null when either value names no date', () => {
    expect(calendarDaysBetween(TODAY, null)).toBeNull();
    expect(calendarDaysBetween(null, TODAY)).toBeNull();
    expect(calendarDaysBetween(TODAY, 'not a date')).toBeNull();
  });

  it('reads the calendar date of a timestamp prefix', () => {
    expect(calendarDaysBetween(TODAY, '2026-02-12T23:59:59Z')).toBe(2);
  });
});

describe('followUpDue', () => {
  it('is true on the due date and after it', () => {
    expect(followUpDue(TODAY, TODAY)).toBe(true);
    expect(followUpDue('2026-02-09', TODAY)).toBe(true);
  });

  it('is false for a future follow-up and for no follow-up', () => {
    expect(followUpDue('2026-02-11', TODAY)).toBe(false);
    expect(followUpDue(null, TODAY)).toBe(false);
    expect(followUpDue('', TODAY)).toBe(false);
  });

  it('reduces a timestamp to its calendar date', () => {
    expect(followUpDue('2026-02-10T00:00:00Z', TODAY)).toBe(true);
    expect(followUpDue('2026-02-10T23:00:00Z', TODAY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renewalWorkloadPoints (Requirements 4.2, 4.4)
// ---------------------------------------------------------------------------

describe('renewalWorkloadPoints', () => {
  const score = (overrides: Partial<Parameters<typeof renewalWorkloadPoints>[0]> = {}) =>
    renewalWorkloadPoints({
      closed: false,
      renewalDate: inDays(90),
      carrierNonRenewal: false,
      nextFollowUpAt: null,
      businessDate: TODAY,
      ...overrides,
    });

  it('scores a closed renewal zero (Requirement 4.4)', () => {
    expect(score({ closed: true, renewalDate: inDays(1), carrierNonRenewal: true })).toBe(0);
  });

  it('scores an open renewal beyond 30 days at the floor', () => {
    expect(score({ renewalDate: inDays(31) })).toBe(1);
    expect(score({ renewalDate: inDays(365) })).toBe(1);
  });

  it('scores each band at its boundary, inclusively', () => {
    expect(score({ renewalDate: inDays(30) })).toBe(2);
    expect(score({ renewalDate: inDays(16) })).toBe(2);
    expect(score({ renewalDate: inDays(15) })).toBe(3);
    expect(score({ renewalDate: inDays(8) })).toBe(3);
    expect(score({ renewalDate: inDays(7) })).toBe(4);
    expect(score({ renewalDate: inDays(4) })).toBe(4);
    expect(score({ renewalDate: inDays(3) })).toBe(5);
    expect(score({ renewalDate: inDays(0) })).toBe(5);
  });

  it('bands rather than accumulates', () => {
    // 1 + 2 + 3 + 4 + 5 would be 15.
    expect(score({ renewalDate: inDays(1) })).toBe(5);
  });

  it('scores a renewal date already past at the tightest band', () => {
    expect(score({ renewalDate: inDays(-5) })).toBe(5);
  });

  it('scores a Carrier Non-Renewal at its floor', () => {
    expect(score({ renewalDate: inDays(90), carrierNonRenewal: true })).toBe(7);
    expect(score({ renewalDate: inDays(20), carrierNonRenewal: true })).toBe(7);
  });

  it('takes the higher of the band and the non-renewal floor rather than adding them', () => {
    // 7 + 5 would be 12; the floor is a floor.
    expect(score({ renewalDate: inDays(1), carrierNonRenewal: true })).toBe(7);
  });

  it('adds the overdue follow-up modifier', () => {
    expect(score({ renewalDate: inDays(90), nextFollowUpAt: '2026-02-09' })).toBe(6);
    expect(score({ renewalDate: inDays(1), nextFollowUpAt: TODAY })).toBe(10);
    expect(score({ renewalDate: inDays(1), carrierNonRenewal: true, nextFollowUpAt: TODAY })).toBe(12);
  });

  it('does not add the modifier for a future follow-up', () => {
    expect(score({ renewalDate: inDays(90), nextFollowUpAt: inDays(3) })).toBe(1);
  });

  it('keeps an open renewal with no readable date at the floor rather than at zero', () => {
    expect(score({ renewalDate: null })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cancellationWorkloadPoints (Requirements 4.2, 4.4)
// ---------------------------------------------------------------------------

describe('cancellationWorkloadPoints', () => {
  const score = (overrides: Partial<Parameters<typeof cancellationWorkloadPoints>[0]> = {}) =>
    cancellationWorkloadPoints({
      closed: false,
      effectiveDate: inDays(40),
      paymentVerificationRequired: false,
      manualCommunicationRequired: false,
      followUpDeadline: null,
      businessDate: TODAY,
      ...overrides,
    });

  it('scores a resolved case zero (Requirement 4.4)', () => {
    expect(score({ closed: true, effectiveDate: inDays(0), manualCommunicationRequired: true })).toBe(0);
  });

  it('scores an active case beyond 15 days at the floor', () => {
    expect(score({ effectiveDate: inDays(16) })).toBe(2);
  });

  it('scores each band at its boundary, inclusively', () => {
    expect(score({ effectiveDate: inDays(15) })).toBe(3);
    expect(score({ effectiveDate: inDays(11) })).toBe(3);
    expect(score({ effectiveDate: inDays(10) })).toBe(4);
    expect(score({ effectiveDate: inDays(6) })).toBe(4);
    expect(score({ effectiveDate: inDays(5) })).toBe(6);
    expect(score({ effectiveDate: inDays(2) })).toBe(6);
    expect(score({ effectiveDate: inDays(1) })).toBe(10);
    expect(score({ effectiveDate: inDays(0) })).toBe(10);
  });

  it('scores an effective date already past at the highest band', () => {
    expect(score({ effectiveDate: inDays(-3) })).toBe(10);
  });

  it('scores payment verification at its floor', () => {
    expect(score({ effectiveDate: inDays(40), paymentVerificationRequired: true })).toBe(7);
    // The 1-day band already exceeds the floor.
    expect(score({ effectiveDate: inDays(0), paymentVerificationRequired: true })).toBe(10);
  });

  it('adds the manual-communication modifier', () => {
    expect(score({ effectiveDate: inDays(40), manualCommunicationRequired: true })).toBe(6);
    expect(score({ effectiveDate: inDays(0), manualCommunicationRequired: true })).toBe(14);
  });

  it('adds the overdue follow-up modifier', () => {
    expect(score({ effectiveDate: inDays(40), followUpDeadline: '2026-02-08T00:00:00Z' })).toBe(7);
  });

  it('adds both modifiers on top of the band', () => {
    expect(score({
      effectiveDate: inDays(0),
      manualCommunicationRequired: true,
      followUpDeadline: TODAY,
    })).toBe(19);
  });

  it('rates an imminent cancellation above the tightest renewal band (Requirement 8.2)', () => {
    const cancellationTomorrow = score({ effectiveDate: inDays(1) });
    const renewalTomorrow = renewalWorkloadPoints({
      closed: false,
      renewalDate: inDays(1),
      carrierNonRenewal: false,
      nextFollowUpAt: null,
      businessDate: TODAY,
    });

    expect(cancellationTomorrow).toBeGreaterThan(renewalTomorrow);
  });
});

// ---------------------------------------------------------------------------
// Balancing selection (Requirement 4.3)
// ---------------------------------------------------------------------------

describe('selectLowestWorkload', () => {
  it('picks the lowest score', () => {
    const picked = selectLowestWorkload([
      { profileId: 'a', workloadScore: 20 },
      { profileId: 'b', workloadScore: 7 },
      { profileId: 'c', workloadScore: 12 },
    ]);

    expect(picked?.profileId).toBe('b');
  });

  it('breaks a score tie by the oldest last automatic assignment', () => {
    const picked = selectLowestWorkload([
      { profileId: 'a', workloadScore: 7, lastAutoAssignedAt: '2026-02-09T10:00:00Z' },
      { profileId: 'b', workloadScore: 7, lastAutoAssignedAt: '2026-02-01T10:00:00Z' },
    ]);

    expect(picked?.profileId).toBe('b');
  });

  it('puts an employee who has never received one ahead of everybody', () => {
    const picked = selectLowestWorkload([
      { profileId: 'a', workloadScore: 7, lastAutoAssignedAt: '2020-01-01T00:00:00Z' },
      { profileId: 'b', workloadScore: 7, lastAutoAssignedAt: null },
    ]);

    expect(picked?.profileId).toBe('b');
  });

  it('breaks a full tie by profile id, so the choice is deterministic', () => {
    const candidates = [
      { profileId: 'zeta', workloadScore: 7, lastAutoAssignedAt: null },
      { profileId: 'alpha', workloadScore: 7, lastAutoAssignedAt: null },
    ];

    expect(selectLowestWorkload(candidates)?.profileId).toBe('alpha');
    expect(selectLowestWorkload([...candidates].reverse())?.profileId).toBe('alpha');
  });

  it('returns null where no employee is eligible', () => {
    expect(selectLowestWorkload([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Team table order (Requirement 9.4, design 10.3)
// ---------------------------------------------------------------------------

describe('compareAgentWorkload', () => {
  const agent = (overrides: Partial<AgentWorkloadSummary>): AgentWorkloadSummary => ({
    profileId: 'p',
    displayName: 'Agent',
    username: null,
    role: 'agent',
    renewalsEnabled: true,
    cancellationsEnabled: true,
    autoAssignmentEnabled: true,
    assignmentMode: 'producer_preferred',
    activeRenewals: 0,
    activeCancellations: 0,
    dueToday: 0,
    overdue: 0,
    criticalCancellations: 0,
    carrierNonRenewals: 0,
    waiting: 0,
    workloadScore: 0,
    ...overrides,
  });

  it('sorts by overdue descending first', () => {
    const rows = [
      agent({ displayName: 'Low overdue', overdue: 1, workloadScore: 900 }),
      agent({ displayName: 'High overdue', overdue: 9, workloadScore: 1 }),
    ].sort(compareAgentWorkload);

    expect(rows[0].displayName).toBe('High overdue');
  });

  it('then critical cancellations, then score, then name', () => {
    const rows = [
      agent({ displayName: 'Bravo', criticalCancellations: 2, workloadScore: 10 }),
      agent({ displayName: 'Alpha', criticalCancellations: 2, workloadScore: 10 }),
      agent({ displayName: 'Charlie', criticalCancellations: 3, workloadScore: 1 }),
    ].sort(compareAgentWorkload);

    expect(rows.map((row) => row.displayName)).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });
});

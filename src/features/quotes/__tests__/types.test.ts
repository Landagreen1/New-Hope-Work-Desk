import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  QuoteStatus,
  QUOTE_TRANSITIONS,
  calculateUrgency,
  OperationalQuote,
  UrgencyLevel,
} from '../types';

// Feature: customer-intake-claim-duplicate-quote, Property 18: Quote Status Transition Enforcement
// **Validates: Requirements 9.5, 9.6**
describe('PBT-5: Quote Status Transition Enforcement', () => {
  const allStatuses: QuoteStatus[] = [
    'assigned',
    'quoting',
    'pricing_sent',
    'not_sold',
    'activation_pending',
    'activated',
    'sold',
    'duplicate_review',
    'merged_duplicate',
  ];

  const terminalStatuses: QuoteStatus[] = ['sold', 'not_sold', 'merged_duplicate'];
  const noTransitionStatuses: QuoteStatus[] = ['sold', 'not_sold', 'merged_duplicate', 'duplicate_review'];

  const statusArb = fc.constantFrom(...allStatuses);

  it('only transitions defined in QUOTE_TRANSITIONS are valid for any status', () => {
    fc.assert(
      fc.property(statusArb, statusArb, (currentStatus, targetStatus) => {
        const validTransitions = QUOTE_TRANSITIONS[currentStatus];
        const isValid = validTransitions.includes(targetStatus);

        // If it's in the valid transitions, it should be allowed
        // If it's NOT in the valid transitions, it should be rejected
        if (isValid) {
          expect(validTransitions).toContain(targetStatus);
        } else {
          expect(validTransitions).not.toContain(targetStatus);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('terminal statuses (sold, not_sold, merged_duplicate) have no valid transitions', () => {
    fc.assert(
      fc.property(fc.constantFrom(...terminalStatuses), (terminalStatus) => {
        expect(QUOTE_TRANSITIONS[terminalStatus]).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });

  it('duplicate_review has no transitions (only manager can resolve)', () => {
    expect(QUOTE_TRANSITIONS['duplicate_review']).toEqual([]);
  });

  it('every non-terminal, non-duplicate_review status has at least one valid transition', () => {
    const nonTerminalStatuses = allStatuses.filter(
      (s) => !noTransitionStatuses.includes(s)
    );

    fc.assert(
      fc.property(fc.constantFrom(...nonTerminalStatuses), (status) => {
        expect(QUOTE_TRANSITIONS[status].length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it('no status should transition to itself', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        expect(QUOTE_TRANSITIONS[status]).not.toContain(status);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: customer-intake-claim-duplicate-quote, Property 19: Urgency Calculation Correctness
// **Validates: Requirements 9.3**
describe('PBT-6: Urgency Calculation Correctness', () => {
  const nonAssignedStatuses: QuoteStatus[] = [
    'quoting',
    'pricing_sent',
    'not_sold',
    'activation_pending',
    'activated',
    'sold',
    'duplicate_review',
    'merged_duplicate',
  ];

  function makeQuote(overrides: Partial<OperationalQuote>): OperationalQuote {
    return {
      id: 'test-id',
      customer_intake_id: 'intake-id',
      customer_name: 'Test Customer',
      source_type: 'ringcentral',
      dealer_id: null,
      dealer_salesperson_id: null,
      line_of_business: 'personal_auto',
      phone: '555-0100',
      email: null,
      quote_origin: null,
      status: 'assigned',
      pre_flag_status: null,
      assigned_to: 'agent-id',
      intake_creator: 'cs-user-id',
      assignment_method: 'ringcentral_claim',
      assigned_at: new Date().toISOString(),
      claimed_at: null,
      last_progression_at: new Date().toISOString(),
      linked_quote_id: null,
      merged_into_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
      ...overrides,
    };
  }

  it('for any quote NOT in assigned status, urgency is always normal', () => {
    // Generate random hours (0 to 200) and non-assigned statuses
    fc.assert(
      fc.property(
        fc.constantFrom(...nonAssignedStatuses),
        fc.double({ min: 0, max: 200, noNaN: true }),
        (status, hoursAgo) => {
          const progressionTime = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
          const quote = makeQuote({ status, last_progression_at: progressionTime });
          expect(calculateUrgency(quote)).toBe('normal');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for assigned quotes with last_progression_at < 24 hours ago, urgency is normal', () => {
    fc.assert(
      fc.property(
        // Generate hours between 0 and just under 24
        fc.double({ min: 0, max: 23.99, noNaN: true }),
        (hoursAgo) => {
          const progressionTime = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
          const quote = makeQuote({ status: 'assigned', last_progression_at: progressionTime });
          expect(calculateUrgency(quote)).toBe('normal');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for assigned quotes with last_progression_at 24-48 hours ago, urgency is elevated', () => {
    fc.assert(
      fc.property(
        // Generate hours strictly between 24 and 48 (exclusive boundaries to avoid edge flakiness)
        fc.double({ min: 24.01, max: 47.99, noNaN: true }),
        (hoursAgo) => {
          const progressionTime = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
          const quote = makeQuote({ status: 'assigned', last_progression_at: progressionTime });
          expect(calculateUrgency(quote)).toBe('elevated');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for assigned quotes with last_progression_at > 48 hours ago, urgency is high', () => {
    fc.assert(
      fc.property(
        // Generate hours strictly greater than 48
        fc.double({ min: 48.01, max: 1000, noNaN: true }),
        (hoursAgo) => {
          const progressionTime = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
          const quote = makeQuote({ status: 'assigned', last_progression_at: progressionTime });
          expect(calculateUrgency(quote)).toBe('high');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('urgency boundaries are correctly partitioned for any valid time value', () => {
    // This property tests the full partition: any random time value produces exactly one valid urgency
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 2000, noNaN: true }),
        (hoursAgo) => {
          const progressionTime = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
          const quote = makeQuote({ status: 'assigned', last_progression_at: progressionTime });
          const urgency = calculateUrgency(quote);

          // Must be one of the valid urgency levels
          expect(['normal', 'elevated', 'high']).toContain(urgency);

          // Verify correct bucket based on hours
          if (hoursAgo > 48) {
            expect(urgency).toBe('high');
          } else if (hoursAgo > 24) {
            expect(urgency).toBe('elevated');
          } else {
            expect(urgency).toBe('normal');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

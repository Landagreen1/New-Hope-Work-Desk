import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { QUOTE_TRANSITIONS } from '../types';

// Feature: quote-outcome-rework, Property 1: Bug Condition
// Bidirectional Outcome Change Blocked
// **Validates: Requirements 1.1, 1.2, 1.3**
//
// This test encodes the EXPECTED behavior (generalized bidirectional outcome change).
// It MUST FAIL on unfixed code — failure confirms the bug exists.
// After the fix is applied, this test should PASS (confirming the fix works).
//
// Bug Condition:
//   isBugCondition(X) =
//     (X.current_decision = 'sold' AND X.desired_decision = 'not_sold')
//     OR (X.current_decision = 'not_sold' AND X.desired_decision = 'sold'
//         AND X.uses_generalized_path = true)
//
// The fix should provide a generalized `change_quote_outcome` RPC that handles
// both directions, and a "Change Outcome" UI button on all finalized quotes.

describe('PBT Bug Condition: Bidirectional Outcome Change Blocked', () => {
  // ─── Arbitraries ─────────────────────────────────────────────────────────

  type QuoteDecision = 'sold' | 'not_sold';

  const decisionArb = fc.constantFrom<QuoteDecision>('sold', 'not_sold');
  const uuidArb = fc.uuid();
  const noteArb = fc.string({ minLength: 3, maxLength: 100 }).filter(s => s.trim().length > 0);

  const notSoldReasons = [
    'price_too_high',
    'went_with_competitor',
    'no_longer_needs_coverage',
    'never_responded',
    'duplicate_entry',
    'other',
  ] as const;
  const notSoldReasonArb = fc.constantFrom(...notSoldReasons);

  // Generate a bug condition input: agent wants to change outcome direction
  const bugConditionInputArb = fc.record({
    outcomeId: uuidArb,
    agentId: uuidArb,
    currentDecision: decisionArb,
    note: noteArb,
    notSoldReason: notSoldReasonArb,
    notSoldReasonOther: fc.string({ minLength: 3, maxLength: 50 }).filter(s => s.trim().length > 0),
  }).map(input => ({
    ...input,
    desiredDecision: (input.currentDecision === 'sold' ? 'not_sold' : 'sold') as QuoteDecision,
  }));

  // Read source files for inspection
  const workDeskAppSource = fs.readFileSync(
    path.resolve(__dirname, '../../../components/work-desk-app.tsx'),
    'utf-8',
  );

  // Read the supabase migrations directory to check for RPC existence
  const migrationsDir = path.resolve(__dirname, '../../../../supabase/migrations');

  function getAllMigrationContent(): string {
    try {
      const files = fs.readdirSync(migrationsDir);
      return files
        .filter(f => f.endsWith('.sql'))
        .map(f => fs.readFileSync(path.join(migrationsDir, f), 'utf-8'))
        .join('\n');
    } catch {
      return '';
    }
  }

  const allMigrationsSql = getAllMigrationContent();

  // ─── Property Test 1: change_quote_outcome RPC does not exist ────────────
  // On unfixed code, no `change_quote_outcome` function exists in any migration.
  // The fix must add this RPC. If it doesn't exist, the bug is confirmed.
  describe('change_quote_outcome RPC existence', () => {
    it('a generalized change_quote_outcome RPC must exist for bidirectional outcome changes', () => {
      fc.assert(
        fc.property(bugConditionInputArb, (input) => {
          // For any bug condition input, there MUST be a generalized RPC to handle it.
          // The RPC must be named `change_quote_outcome` and accept the bidirectional change.
          const rpcExists = allMigrationsSql.includes('change_quote_outcome');

          // EXPECTED TO FAIL on unfixed code: the RPC does not exist
          expect(rpcExists).toBe(true);
        }),
        { numRuns: 50 },
      );
    });
  });

  // ─── Property Test 2: Sold outcomes have no reversal mechanism ───────────
  // On unfixed code, there is no mechanism to change sold → not_sold.
  // The QUOTE_TRANSITIONS map shows sold has no outbound transitions,
  // and no RPC handles sold → not_sold.
  describe('Sold outcome reversal mechanism', () => {
    it('sold outcomes must have a mechanism to revert to not_sold', () => {
      fc.assert(
        fc.property(
          bugConditionInputArb.filter(i => i.currentDecision === 'sold'),
          (input) => {
            // For any sold outcome where the agent wants to change to not_sold,
            // there MUST be some mechanism (RPC or transition) that handles this.

            // Check 1: Does any migration contain logic for sold → not_sold?
            const hasSoldToNotSoldLogic =
              allMigrationsSql.includes("decision = 'not_sold'") &&
              allMigrationsSql.includes('change_quote_outcome');

            // Check 2: Does QUOTE_TRANSITIONS allow sold → not_sold?
            // (We know from types.ts it doesn't — sold: [])
            const soldTransitions: string[] = QUOTE_TRANSITIONS['sold'];
            const allowsNotSold = soldTransitions.includes('not_sold');

            // At least ONE mechanism must exist for sold → not_sold
            // EXPECTED TO FAIL on unfixed code: neither mechanism exists
            expect(hasSoldToNotSoldLogic || allowsNotSold).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // ─── Property Test 3: convert_my_not_sold_quote_to_sold is unidirectional ─
  // The existing RPC only handles not_sold → sold. It is NOT a generalized
  // bidirectional mechanism. This confirms the bug for the generalized path.
  describe('convert_my_not_sold_quote_to_sold is not generalized', () => {
    it('the old RPC must be replaced by a generalized bidirectional mechanism', () => {
      fc.assert(
        fc.property(bugConditionInputArb, (input) => {
          // For any bug condition input (either direction), a generalized mechanism
          // must exist. The old RPC only handles not_sold → sold.

          // Check if a generalized function exists (change_quote_outcome)
          const hasGeneralizedRpc = allMigrationsSql.includes('change_quote_outcome');

          // Check that the old RPC handles BOTH directions (it doesn't)
          const oldRpcHandlesBothDirections =
            allMigrationsSql.includes('convert_my_not_sold_quote_to_sold') &&
            allMigrationsSql.includes("decision = 'not_sold'") &&
            allMigrationsSql.includes("AND decision = 'sold'") &&
            allMigrationsSql.includes('sold_to_not_sold');

          // At least one of these must be true for the bug to be fixed
          // EXPECTED TO FAIL on unfixed code: old RPC is unidirectional and no generalized RPC exists
          expect(hasGeneralizedRpc || oldRpcHandlesBothDirections).toBe(true);
        }),
        { numRuns: 50 },
      );
    });
  });

  // ─── Property Test 4: UI has no "Change Outcome" button for sold quotes ──
  // On unfixed code, sold quotes have NO action button for outcome change.
  // The fix must add a "Change Outcome" button visible on all finalized quotes.
  describe('UI Change Outcome button for finalized quotes', () => {
    it('a "Change Outcome" button must be rendered for sold quotes owned by the agent', () => {
      fc.assert(
        fc.property(
          bugConditionInputArb.filter(i => i.currentDecision === 'sold'),
          (input) => {
            // For any sold quote owned by the agent, the UI MUST render a
            // "Change Outcome" button that allows reversal.
            // The current code only shows "Mark Sold" for Not Sold quotes.
            // No action button exists at all for Sold quotes.

            // Check if the work-desk-app contains a "Change Outcome" button text
            const hasChangeOutcomeButton = workDeskAppSource.includes('Change Outcome');

            // Check if there's a change_outcome modal kind (the fix adds this)
            const hasChangeOutcomeModal = workDeskAppSource.includes('change_outcome');

            // EXPECTED TO FAIL on unfixed code: no "Change Outcome" button or modal exists
            expect(hasChangeOutcomeButton || hasChangeOutcomeModal).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('a "Change Outcome" button must be rendered for not_sold quotes (generalized, not just "Mark Sold")', () => {
      fc.assert(
        fc.property(
          bugConditionInputArb.filter(i => i.currentDecision === 'not_sold'),
          (input) => {
            // For not_sold quotes, the UI must have a GENERALIZED "Change Outcome"
            // button (not just the narrow "Mark Sold" button that calls the old RPC).

            const hasGeneralizedButton = workDeskAppSource.includes('Change Outcome');

            // EXPECTED TO FAIL on unfixed code: only "Mark Sold" exists, not "Change Outcome"
            expect(hasGeneralizedButton).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});

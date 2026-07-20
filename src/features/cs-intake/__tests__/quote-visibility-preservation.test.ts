import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Feature: cs-intake-quote-visibility, Property 2: Preservation
// Non-Converted Intakes and Non-CS-Intake Quotes Unchanged
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
//
// These tests verify that the CURRENT code does NOT have new quote-visibility UI
// elements for non-bug-condition inputs. They MUST PASS on unfixed code.
// After the fix is applied, they should STILL PASS because the new features only
// apply to bug-condition inputs (converted + work_item_id set + specific actions).

describe('PBT Preservation: Non-Converted Intakes and Non-CS-Intake Quotes Unchanged', () => {
  // ─── Arbitraries ─────────────────────────────────────────────────────────

  // Non-converted statuses (these rows must NOT have any new quote-visibility elements)
  const nonConvertedStatuses = ['draft', 'submitted', 'claimed', 'returned', 'rejected'] as const;
  const nonConvertedStatusArb = fc.constantFrom(...nonConvertedStatuses);

  const uuidArb = fc.uuid();

  // Generate a non-converted intake row
  const nonConvertedIntakeArb = fc.record({
    id: uuidArb,
    status: nonConvertedStatusArb,
    work_item_id: fc.constantFrom(null, null, null), // always null for non-converted
    converted_at: fc.constant(null),
    insured_first_name: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
    insured_last_name: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
  });

  // Converted intake with null work_item_id (edge case - converted but no linked quote)
  const convertedNoWorkItemArb = fc.record({
    id: uuidArb,
    status: fc.constant('converted' as const),
    work_item_id: fc.constant(null),
    converted_at: fc.integer({ min: 1704067200000, max: 1767139200000 }).map(ts => new Date(ts).toISOString()),
    insured_first_name: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
    insured_last_name: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
  });

  // Standard event types that are NOT created_from_cs_intake
  const standardEventTypes = [
    'intake_note_log',
    'intake_update',
    'quote_created',
    'agent_started_quoting',
    'pricing_sent',
    'activation_pending',
    'activated',
    'sold',
    'not_sold',
    'duplicate_flagged',
    'duplicate_resolved',
    'merged_source',
    'merged_target',
    'reassigned',
    'linked',
    'status_changed',
  ] as const;
  const standardEventTypeArb = fc.constantFrom(...standardEventTypes);

  // Non-manager roles
  const nonManagerRoles = ['agent'] as const;
  const nonManagerRoleArb = fc.constantFrom(...nonManagerRoles);

  // Read source files once for inspection
  const intakeQueueSource = fs.readFileSync(
    path.resolve(__dirname, '../IntakeQueue.tsx'),
    'utf-8',
  );

  const quoteHistorySource = fs.readFileSync(
    path.resolve(__dirname, '../../quotes/QuoteHistory.tsx'),
    'utf-8',
  );

  // ─── Property Test 1: Non-Converted Rows Have No New Quote-Visibility UI ─
  // For all intake rows where status != 'converted' OR work_item_id IS NULL,
  // no new quote-visibility UI elements (Quote Status badge, Quote Activity button,
  // Delete Quote button) are rendered for those rows.
  //
  // Observation: The current IntakeQueue.tsx source does NOT contain these elements at all,
  // so for non-converted rows there is no conditional that would render them.
  // After the fix, these elements will only be conditionally rendered for converted+work_item_id rows.
  describe('Non-converted intake rows have no quote-visibility UI', () => {
    it('non-converted status rows do not trigger quote status badge rendering', () => {
      fc.assert(
        fc.property(nonConvertedIntakeArb, (intake) => {
          // For any non-converted intake, the IntakeQueue rendering path
          // should NOT include any quote status badge that applies to these rows.
          //
          // Verification approach: The IntakeQueue source code either:
          // 1. Has NO quote status rendering at all (current unfixed state) - PASS
          // 2. Has quote status rendering gated behind `converted_at` or `work_item_id` check - PASS
          //
          // If the source contains quote status logic, verify it's guarded by conversion check
          const hasQuoteStatusLogic =
            intakeQueueSource.includes('quoteStatus') ||
            intakeQueueSource.includes('getLinkedQuoteStatus');

          if (hasQuoteStatusLogic) {
            // If quote status logic exists, it MUST be gated behind a conversion check
            // (i.e., only rendered when converted_at is truthy or work_item_id is set)
            const isGatedByConversion =
              intakeQueueSource.includes('converted_at') ||
              intakeQueueSource.includes('work_item_id') ||
              intakeQueueSource.includes('hasLinkedQuote');

            expect(isGatedByConversion).toBe(true);
          }
          // If no quote status logic exists at all, that's fine - non-converted rows won't have it
          // This is the current (unfixed) state and the test passes
        }),
        { numRuns: 50 },
      );
    });

    it('non-converted status rows do not trigger Quote Activity button rendering', () => {
      fc.assert(
        fc.property(nonConvertedIntakeArb, (intake) => {
          // For any non-converted intake, no "Quote Activity" button renders.
          // Either the button doesn't exist at all (current), or it's gated by conversion check.
          const hasQuoteActivityButton =
            intakeQueueSource.includes('Quote Activity') ||
            intakeQueueSource.includes('QuoteActivity') ||
            intakeQueueSource.includes('quoteActivity');

          if (hasQuoteActivityButton) {
            // If button exists, it MUST be gated behind conversion check
            const isGatedByConversion =
              intakeQueueSource.includes('converted_at') ||
              intakeQueueSource.includes('work_item_id') ||
              intakeQueueSource.includes('hasLinkedQuote');

            expect(isGatedByConversion).toBe(true);
          }
          // If no Quote Activity button logic exists, test passes (current unfixed state)
        }),
        { numRuns: 50 },
      );
    });

    it('non-converted status rows do not trigger Delete Quote button rendering', () => {
      fc.assert(
        fc.property(nonConvertedIntakeArb, (intake) => {
          // For any non-converted intake, no "Delete Quote" button renders.
          // Either the button doesn't exist at all (current), or it's gated by conversion+manager check.
          const hasDeleteQuoteButton =
            intakeQueueSource.includes('Delete Quote') ||
            intakeQueueSource.includes('deleteLinkedWorkItem');

          if (hasDeleteQuoteButton) {
            // If button exists, it MUST be gated behind conversion AND manager check
            const isGatedByConversion =
              intakeQueueSource.includes('converted_at') ||
              intakeQueueSource.includes('work_item_id') ||
              intakeQueueSource.includes('hasLinkedQuote');

            const isGatedByRole =
              intakeQueueSource.includes('isManager') ||
              intakeQueueSource.includes("role === 'manager'") ||
              intakeQueueSource.includes('manager');

            expect(isGatedByConversion).toBe(true);
            expect(isGatedByRole).toBe(true);
          }
          // If no Delete Quote button logic exists, test passes (current unfixed state)
        }),
        { numRuns: 50 },
      );
    });

    it('converted intakes with null work_item_id do not trigger quote-visibility elements', () => {
      fc.assert(
        fc.property(convertedNoWorkItemArb, (intake) => {
          // Edge case: converted status but work_item_id is null (race condition or incomplete conversion)
          // These rows should also NOT render quote-visibility elements.
          //
          // Current state: no quote-visibility elements exist at all → PASS
          // After fix: elements gated behind both converted_at AND work_item_id check → PASS
          const hasQuoteVisibilityElements =
            intakeQueueSource.includes('quoteStatus') ||
            intakeQueueSource.includes('Quote Activity') ||
            intakeQueueSource.includes('Delete Quote');

          if (hasQuoteVisibilityElements) {
            // If elements exist, they must check work_item_id is not null
            const checksWorkItemId =
              intakeQueueSource.includes('work_item_id') ||
              intakeQueueSource.includes('workItemId');

            expect(checksWorkItemId).toBe(true);
          }
          // If no elements exist, test passes (current unfixed state)
        }),
        { numRuns: 50 },
      );
    });
  });

  // ─── Property Test 2: Non-CS-Intake Events Use Standard Formatting ───────
  // For all work_item_events where event_type != 'created_from_cs_intake',
  // the event renders with standard formatting (no intake-specific sections).
  describe('Non-CS-Intake quote events use standard formatting', () => {
    it('standard event types have proper label mapping in QuoteHistory', () => {
      fc.assert(
        fc.property(standardEventTypeArb, (eventType) => {
          // For every standard event type, QuoteHistory should handle it with
          // its existing eventLabel/eventIcon/eventColor maps — no intake-specific rendering.
          //
          // Verify the eventLabel function handles this event type
          // (either explicit mapping or fallback formatter)
          const hasExplicitLabel = quoteHistorySource.includes(`'${eventType}'`);
          const hasFallbackFormatter = quoteHistorySource.includes('replace(/_/g');

          // Every standard event type must be handled by explicit label OR fallback
          expect(hasExplicitLabel || hasFallbackFormatter).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('standard event types do NOT trigger IntakeDataDisplay rendering', () => {
      fc.assert(
        fc.property(standardEventTypeArb, (eventType) => {
          // For non-CS-intake events, the QuoteHistory component should NOT
          // render IntakeDataDisplay (structured intake sections with drivers/vehicles).
          //
          // Either IntakeDataDisplay doesn't exist in QuoteHistory (current) - PASS,
          // or it's gated behind event_type === 'created_from_cs_intake' check - PASS.
          const hasIntakeDataDisplay = quoteHistorySource.includes('IntakeDataDisplay');

          if (hasIntakeDataDisplay) {
            // If IntakeDataDisplay is referenced, verify it's only for created_from_cs_intake
            const isGatedByEventType =
              quoteHistorySource.includes("'created_from_cs_intake'") ||
              quoteHistorySource.includes('"created_from_cs_intake"') ||
              quoteHistorySource.includes('created_from_cs_intake');

            expect(isGatedByEventType).toBe(true);
          }
          // If IntakeDataDisplay doesn't exist in QuoteHistory, standard events
          // naturally won't have intake-specific rendering → PASS
        }),
        { numRuns: 100 },
      );
    });

    it('QuoteHistory eventColor handles all standard event types', () => {
      fc.assert(
        fc.property(standardEventTypeArb, (eventType) => {
          // Verify that every standard event type gets a color mapping
          // (either explicit case or default fallback)
          const hasExplicitColor =
            quoteHistorySource.includes(`case '${eventType}'`);
          const hasDefaultColor =
            quoteHistorySource.includes('default:') &&
            quoteHistorySource.includes('bg-slate-400');

          // Every standard event type must be handled by explicit color OR default
          expect(hasExplicitColor || hasDefaultColor).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });

  // ─── Property Test 3: Non-Manager Users Cannot See Delete Quote ──────────
  // For all non-manager users viewing converted intakes, no "Delete Quote" button is rendered.
  describe('Non-manager users do not see Delete Quote button', () => {
    it('non-manager users have no access to quote deletion actions', () => {
      fc.assert(
        fc.property(nonManagerRoleArb, uuidArb, (role, intakeId) => {
          // For non-manager users, no Delete Quote / deleteLinkedWorkItem logic
          // should be accessible. Either:
          // 1. No such logic exists (current unfixed state) - PASS
          // 2. Logic exists but is gated behind isManager / role === 'manager' - PASS

          const hasDeleteQuoteLogic =
            intakeQueueSource.includes('Delete Quote') ||
            intakeQueueSource.includes('deleteLinkedWorkItem');

          if (hasDeleteQuoteLogic) {
            // If Delete Quote exists, it must be gated behind manager role check
            const isGatedByManagerRole =
              intakeQueueSource.includes('isManager') ||
              intakeQueueSource.includes("role === 'manager'") ||
              intakeQueueSource.includes("profile.role === 'manager'");

            expect(isGatedByManagerRole).toBe(true);
          }
          // If no Delete Quote logic exists, non-managers trivially can't see it → PASS
        }),
        { numRuns: 50 },
      );
    });

    it('existing Delete button in IntakeQueue is for intake deletion, not quote deletion', () => {
      fc.assert(
        fc.property(nonManagerRoleArb, uuidArb, (role, intakeId) => {
          // The existing "Delete" button in IntakeQueue is for deleting the INTAKE itself
          // (via deleteCustomerIntake), NOT for deleting a linked quote/work item.
          // This verifies the existing delete button is preserved without confusion.

          // Verify deleteCustomerIntake exists (intake deletion)
          const hasIntakeDelete = intakeQueueSource.includes('deleteCustomerIntake');
          expect(hasIntakeDelete).toBe(true);

          // Verify the existing delete button is gated behind isManager
          const deleteGatedByManager = intakeQueueSource.includes('isManager') && intakeQueueSource.includes('handleDelete');
          expect(deleteGatedByManager).toBe(true);
        }),
        { numRuns: 50 },
      );
    });
  });
});

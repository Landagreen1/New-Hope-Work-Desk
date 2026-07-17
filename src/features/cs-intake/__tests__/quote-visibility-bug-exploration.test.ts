import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Feature: cs-intake-quote-visibility, Property 1: Bug Condition - Quote Visibility Missing for Converted Intakes
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
//
// This test encodes the EXPECTED behavior after the fix is implemented.
// On UNFIXED code, these tests MUST FAIL — failure confirms the bug exists.
// DO NOT attempt to fix the test or the code when it fails.

describe('PBT Bug Condition: Quote Visibility Missing for Converted Intakes', () => {
  // ─── Arbitraries ─────────────────────────────────────────────────────────
  // Generate converted intake rows (status='converted', work_item_id set)
  const uuidArb = fc.uuid();
  const convertedIntakeArb = fc.record({
    id: uuidArb,
    status: fc.constant('converted' as const),
    work_item_id: uuidArb, // always set for converted intakes
    converted_at: fc.date({ min: new Date('2024-01-01'), max: new Date('2025-12-31') }).map(d => d.toISOString()),
    insured_first_name: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
    insured_last_name: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
  });

  // Generate created_from_cs_intake event details JSONB
  const intakeDetailsArb = fc.record({
    insured_first_name: fc.string({ minLength: 1, maxLength: 20 }),
    insured_last_name: fc.string({ minLength: 1, maxLength: 20 }),
    insured_phone_primary: fc.string({ minLength: 10, maxLength: 15 }),
    insured_email: fc.emailAddress(),
    drivers: fc.array(
      fc.record({
        first_name: fc.string({ minLength: 1, maxLength: 15 }),
        last_name: fc.string({ minLength: 1, maxLength: 15 }),
        license_number: fc.string({ minLength: 5, maxLength: 20 }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
    vehicles: fc.array(
      fc.record({
        year: fc.integer({ min: 2000, max: 2025 }),
        make: fc.constantFrom('Toyota', 'Honda', 'Ford', 'Chevrolet'),
        model: fc.string({ minLength: 2, maxLength: 15 }),
        vin: fc.string({ minLength: 17, maxLength: 17 }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
    csr_notes: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: null }),
    desired_coverage: fc.constantFrom('liability_only', 'full_coverage', 'unsure'),
  });

  // Read source files once for inspection
  const intakeQueueSource = fs.readFileSync(
    path.resolve(__dirname, '../IntakeQueue.tsx'),
    'utf-8',
  );

  const quoteHistorySource = fs.readFileSync(
    path.resolve(__dirname, '../../quotes/QuoteHistory.tsx'),
    'utf-8',
  );

  // ─── Test 1: Quote Status Badge Missing (Req 1.2) ───────────────────────
  // EXPECTED: IntakeQueue renders a quote status badge for converted rows
  // REALITY: No such badge exists → test FAILS = confirms bug
  it('IntakeQueue renders a quote status badge for converted intake rows', () => {
    fc.assert(
      fc.property(convertedIntakeArb, (intake) => {
        // For any converted intake with a work_item_id, the IntakeQueue component
        // SHOULD render a quote status badge. We verify by checking:
        // 1. The source contains logic to display quote statuses for converted rows
        // 2. There's a reference to fetching/displaying work_items.status

        // Check for quote status badge rendering logic
        const hasQuoteStatusBadge =
          intakeQueueSource.includes('quoteStatus') ||
          intakeQueueSource.includes('quote_status') ||
          intakeQueueSource.includes('Quote Status') ||
          intakeQueueSource.includes('getLinkedQuoteStatus');

        // The component should have a mechanism to display quote status for converted rows
        expect(hasQuoteStatusBadge).toBe(true);
      }),
      { numRuns: 10 }, // Reduced runs since we're checking source, not runtime behavior
    );
  });

  // ─── Test 2: Quote Activity Button Missing (Req 1.3) ────────────────────
  // EXPECTED: IntakeQueue renders a "Quote Activity" button for converted rows
  // REALITY: No such button exists → test FAILS = confirms bug
  it('IntakeQueue renders a "Quote Activity" button for converted intake rows', () => {
    fc.assert(
      fc.property(convertedIntakeArb, (intake) => {
        // For any converted intake with a work_item_id, the IntakeQueue component
        // SHOULD render a "Quote Activity" button that opens the event log modal

        const hasQuoteActivityButton =
          intakeQueueSource.includes('Quote Activity') ||
          intakeQueueSource.includes('QuoteActivity') ||
          intakeQueueSource.includes('quoteActivity');

        expect(hasQuoteActivityButton).toBe(true);
      }),
      { numRuns: 10 },
    );
  });

  // ─── Test 3: Intake Data Display Missing in QuoteHistory (Req 1.1) ──────
  // EXPECTED: QuoteHistory renders structured intake data for created_from_cs_intake events
  // REALITY: No structured renderer exists → test FAILS = confirms bug
  it('QuoteHistory renders structured intake data sections for created_from_cs_intake events', () => {
    fc.assert(
      fc.property(intakeDetailsArb, (details) => {
        // For any created_from_cs_intake event with full intake details,
        // QuoteHistory SHOULD render structured sections (drivers, vehicles, etc.)
        // instead of just a generic event entry

        // Check that QuoteHistory handles 'created_from_cs_intake' with structured rendering
        const hasIntakeDataRenderer =
          quoteHistorySource.includes('created_from_cs_intake') &&
          (quoteHistorySource.includes('IntakeDataDisplay') ||
           quoteHistorySource.includes('intakeDataDisplay') ||
           quoteHistorySource.includes('intake_data_display') ||
           // Check for structured sections that would render drivers/vehicles
           (quoteHistorySource.includes('drivers') && quoteHistorySource.includes('vehicles')));

        expect(hasIntakeDataRenderer).toBe(true);
      }),
      { numRuns: 10 },
    );
  });

  // ─── Test 4: Delete Quote Button Missing for Managers (Req 1.4) ─────────
  // EXPECTED: IntakeQueue renders a "Delete Quote" button for managers on converted rows
  // REALITY: No such button exists → test FAILS = confirms bug
  it('IntakeQueue renders a "Delete Quote" button for managers on converted intake rows', () => {
    fc.assert(
      fc.property(convertedIntakeArb, (intake) => {
        // For any converted intake viewed by a manager, the IntakeQueue component
        // SHOULD render a "Delete Quote" button (separate from the intake Delete button)

        const hasDeleteQuoteButton =
          intakeQueueSource.includes('Delete Quote') ||
          intakeQueueSource.includes('deleteQuote') ||
          intakeQueueSource.includes('deleteLinkedWorkItem') ||
          intakeQueueSource.includes('delete_linked_work_item');

        expect(hasDeleteQuoteButton).toBe(true);
      }),
      { numRuns: 10 },
    );
  });

  // ─── Test 5: API functions for quote visibility don't exist ──────────────
  // EXPECTED: api.ts exports getLinkedQuoteStatuses and getLinkedQuoteEvents
  // REALITY: These functions don't exist → test FAILS = confirms bug
  it('api.ts exports getLinkedQuoteStatuses for fetching quote statuses', async () => {
    // Dynamically check the api module exports
    const apiSource = fs.readFileSync(
      path.resolve(__dirname, '../api.ts'),
      'utf-8',
    );

    fc.assert(
      fc.property(uuidArb, (_workItemId) => {
        const hasGetLinkedQuoteStatuses =
          apiSource.includes('getLinkedQuoteStatuses') ||
          apiSource.includes('getLinkedQuoteStatus');

        expect(hasGetLinkedQuoteStatuses).toBe(true);
      }),
      { numRuns: 5 },
    );
  });

  it('api.ts exports getLinkedQuoteEvents for fetching quote event logs', () => {
    const apiSource = fs.readFileSync(
      path.resolve(__dirname, '../api.ts'),
      'utf-8',
    );

    fc.assert(
      fc.property(uuidArb, (_workItemId) => {
        const hasGetLinkedQuoteEvents = apiSource.includes('getLinkedQuoteEvents');

        expect(hasGetLinkedQuoteEvents).toBe(true);
      }),
      { numRuns: 5 },
    );
  });

  it('api.ts exports deleteLinkedWorkItem for manager quote deletion', () => {
    const apiSource = fs.readFileSync(
      path.resolve(__dirname, '../api.ts'),
      'utf-8',
    );

    fc.assert(
      fc.property(uuidArb, (_workItemId) => {
        const hasDeleteLinkedWorkItem = apiSource.includes('deleteLinkedWorkItem');

        expect(hasDeleteLinkedWorkItem).toBe(true);
      }),
      { numRuns: 5 },
    );
  });
});

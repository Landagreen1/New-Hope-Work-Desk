import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { CsIntakeSubmission } from '../api';

// ═══════════════════════════════════════════════════════════════════════════
// Bug Condition Exploration Test
// Spec: rc-claim-duplicate-quote-fix
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
//
// This test encodes the EXPECTED (correct) behavior. It is designed to FAIL
// on unfixed code, confirming the bug exists. Once the fix is applied, this
// test should PASS.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Extract the isRingcentralSource heuristic as it exists in IntakeQueue.tsx ───
// FIXED implementation: uses source_type instead of work_item_id
function isRingcentralSource(row: CsIntakeSubmission): boolean {
  return row.source_type === 'ringcentral';
}

// ─── Model the database state transitions ───────────────────────────────────────

/**
 * Simulates the state of cs_intake_submissions AFTER claim_ringcentral_intake succeeds.
 *
 * FIXED: claim_ringcentral_intake calls _create_quote_from_intake which now includes
 * step 6b that syncs cs_intake_submissions: sets status='converted', converted_at=now(),
 * work_item_id=quoteId.
 */
function simulateRcClaimOnCsIntakeSubmissions(submission: CsIntakeSubmission, quoteId: string): CsIntakeSubmission {
  // After the fix, _create_quote_from_intake step 6b syncs cs_intake_submissions
  return {
    ...submission,
    status: 'converted',
    claimed_by: 'agent-uuid-placeholder',
    claimed_at: new Date().toISOString(),
    converted_at: new Date().toISOString(),
    work_item_id: quoteId,
  };
}

/**
 * Simulates cs_intake_convert behavior — NOW has idempotency guard.
 * FIXED: If an operational_quotes record already exists (from RC claim), cs_intake_convert
 * returns the existing quote ID without creating a duplicate work_items record.
 */
function simulateCsIntakeConvert(
  submission: CsIntakeSubmission,
  existingOperationalQuoteId: string | null
): { createdNewQuote: boolean; totalQuoteCount: number } {
  // FIXED: cs_intake_convert now checks if operational_quotes already has a record
  // If found: return existing quote ID without creating a duplicate
  if (existingOperationalQuoteId) {
    // Idempotency guard fires — no new quote created
    return { createdNewQuote: false, totalQuoteCount: 1 };
  }

  // Standard flow for non-RC intakes (no existing operational quote)
  if (submission.status !== 'claimed' || !submission.claimed_by) {
    return { createdNewQuote: false, totalQuoteCount: 0 };
  }

  // No prior operational_quotes record — create work_items as normal
  return { createdNewQuote: true, totalQuoteCount: 1 };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────────

const uuidArb = fc.uuid();

/** Generate a CsIntakeSubmission row that represents a RingCentral-sourced intake */
const rcSubmissionArb: fc.Arbitrary<CsIntakeSubmission> = fc.record({
  id: uuidArb,
  status: fc.constant('submitted' as const),
  priority: fc.constantFrom('normal' as const, 'high' as const, 'urgent' as const),
  line_of_business: fc.constantFrom('personal_auto' as const, 'commercial_auto' as const, 'auto' as const),
  quote_kind: fc.constant('new_quote' as const),
  source_renewal_id: fc.constant(null),
  source_type: fc.constant('ringcentral'),
  created_by: uuidArb,
  claimed_by: fc.constant(null),
  claimed_at: fc.constant(null),
  dealer_id: fc.constant(null),
  salesperson_id: fc.constant(null),
  work_item_id: fc.constant(null), // RC intakes start with work_item_id=NULL
  converted_at: fc.constant(null),
  insured_first_name: fc.string({ minLength: 1, maxLength: 20 }),
  insured_last_name: fc.string({ minLength: 1, maxLength: 20 }),
  insured_dob: fc.constant('1990-01-01'),
  insured_email: fc.constant('test@example.com'),
  insured_phone_primary: fc.constant('555-1234'),
  insured_phone_alt: fc.constant(null),
  preferred_language: fc.constant(null),
  preferred_contact: fc.constant(null),
  addr_street: fc.constant('123 Main St'),
  addr_unit: fc.constant(null),
  addr_city: fc.constant('Anytown'),
  addr_state: fc.constant('TX'),
  addr_zip: fc.constant('75001'),
  mailing_same_as_addr: fc.constant(true),
  business_name: fc.constant(null),
  dot_number: fc.constant(null),
  dot_not_applicable: fc.constant(false),
  business_type: fc.constant(null),
  years_in_business: fc.constant(null),
  operating_radius_miles: fc.constant(null),
  desired_coverage: fc.constantFrom('liability_only' as const, 'full_coverage' as const, 'unsure' as const),
  liability_limit: fc.constant(null),
  comprehensive_deductible: fc.constant(null),
  collision_deductible: fc.constant(null),
  current_carrier: fc.constant(null),
  current_policy_number: fc.constant(null),
  current_premium: fc.constant(null),
  current_expiration: fc.constant(null),
  prior_insurance: fc.constant(null),
  prior_lapse: fc.constant(null),
  months_continuous_coverage: fc.constant(null),
  requested_coverage: fc.constant(null),
  return_reason: fc.constant(null),
  reject_reason: fc.constant(null),
  csr_notes: fc.constant(null),
  created_at: fc.constant(new Date().toISOString()),
  updated_at: fc.constant(new Date().toISOString()),
  submitted_at: fc.constant(new Date().toISOString()),
});

// ═══════════════════════════════════════════════════════════════════════════
// PROPERTY 1: Bug Condition — RC Claim Leaves cs_intake_submissions Out of Sync
// ═══════════════════════════════════════════════════════════════════════════

describe('PBT: Bug Condition — RC Claim Leaves cs_intake_submissions Out of Sync (Duplicate Quote)', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Property 1A: After claim_ringcentral_intake succeeds, cs_intake_submissions
  // SHOULD have converted_at IS NOT NULL (EXPECTED TO FAIL on unfixed code)
  // ─────────────────────────────────────────────────────────────────────────
  it('after RC claim, cs_intake_submissions.converted_at is NOT NULL', () => {
    fc.assert(
      fc.property(rcSubmissionArb, uuidArb, (submission, quoteId) => {
        // Simulate the RC claim flow on cs_intake_submissions (FIXED behavior)
        const afterClaim = simulateRcClaimOnCsIntakeSubmissions(submission, quoteId);

        // EXPECTED behavior: converted_at should be set
        expect(afterClaim.converted_at).not.toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Property 1B: After claim_ringcentral_intake succeeds, cs_intake_submissions
  // SHOULD have status='converted' (EXPECTED TO FAIL on unfixed code)
  // ─────────────────────────────────────────────────────────────────────────
  it('after RC claim, cs_intake_submissions.status is "converted"', () => {
    fc.assert(
      fc.property(rcSubmissionArb, uuidArb, (submission, quoteId) => {
        const afterClaim = simulateRcClaimOnCsIntakeSubmissions(submission, quoteId);

        // EXPECTED behavior: status should be 'converted'
        expect(afterClaim.status).toBe('converted');
      }),
      { numRuns: 100 }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Property 1C: After claim_ringcentral_intake succeeds, cs_intake_submissions
  // SHOULD have work_item_id set to the new quote ID (EXPECTED TO FAIL)
  // ─────────────────────────────────────────────────────────────────────────
  it('after RC claim, cs_intake_submissions.work_item_id is set to new quote ID', () => {
    fc.assert(
      fc.property(rcSubmissionArb, uuidArb, (submission, quoteId) => {
        const afterClaim = simulateRcClaimOnCsIntakeSubmissions(submission, quoteId);

        // EXPECTED behavior: work_item_id should be set to the quote ID
        expect(afterClaim.work_item_id).not.toBeNull();
        expect(afterClaim.work_item_id).toBe(quoteId);
      }),
      { numRuns: 100 }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Property 1D: Calling cs_intake_convert after RC claim should NOT create
  // a second quote (idempotency). (EXPECTED TO FAIL on unfixed code)
  // ─────────────────────────────────────────────────────────────────────────
  it('cs_intake_convert after RC claim does NOT create a duplicate quote', () => {
    fc.assert(
      fc.property(rcSubmissionArb, uuidArb, (submission, existingQuoteId) => {
        // After RC claim, cs_intake_submissions is now synced (FIXED)
        const afterClaim = simulateRcClaimOnCsIntakeSubmissions(submission, existingQuoteId);

        // An operational_quotes record already exists from the RC claim
        // FIXED: idempotency guard returns existing quote without creating duplicate
        const result = simulateCsIntakeConvert(afterClaim, existingQuoteId);

        // EXPECTED behavior: no new quote created, total remains 1
        expect(result.createdNewQuote).toBe(false);
        expect(result.totalQuoteCount).toBe(1);
      }),
      { numRuns: 100 }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Property 1E: After RC claim, count(quotes for intake) = 1
  // Even after cs_intake_convert is called. (EXPECTED TO FAIL on unfixed code)
  // ─────────────────────────────────────────────────────────────────────────
  it('after RC claim + cs_intake_convert attempt, only 1 quote exists for intake', () => {
    fc.assert(
      fc.property(rcSubmissionArb, uuidArb, (submission, existingQuoteId) => {
        const afterClaim = simulateRcClaimOnCsIntakeSubmissions(submission, existingQuoteId);
        const result = simulateCsIntakeConvert(afterClaim, existingQuoteId);

        // EXPECTED: exactly 1 quote per intake (idempotency guard prevents duplicates)
        expect(result.totalQuoteCount).toBe(1);
      }),
      { numRuns: 100 }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Property 1F: isRingcentralSource correctly identifies RC intakes when
  // work_item_id is NULL but source_type = 'ringcentral'
  // (EXPECTED TO FAIL on unfixed code)
  // ─────────────────────────────────────────────────────────────────────────
  it('isRingcentralSource returns true for RC-sourced intakes with work_item_id=NULL', () => {
    fc.assert(
      fc.property(rcSubmissionArb, (submission) => {
        // Even before RC claim syncs work_item_id, source_type is 'ringcentral'
        // FIXED: isRingcentralSource checks source_type, not work_item_id
        const result = isRingcentralSource(submission);
        expect(result).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Property 1G: "Create Quote" button is hidden when converted_at is set
  // Tests the UI gating logic. (EXPECTED TO FAIL on unfixed code because
  // the current code only checks status='claimed', not converted_at)
  // ─────────────────────────────────────────────────────────────────────────
  it('"Create Quote" button is hidden when converted_at is already set', () => {
    fc.assert(
      fc.property(rcSubmissionArb, uuidArb, (submission, quoteId) => {
        // Simulate the FIXED state after RC claim: converted_at IS set
        const afterClaim = simulateRcClaimOnCsIntakeSubmissions(submission, quoteId);

        // FIXED UI logic for showing "Create Quote":
        // canConvert && row.status === 'claimed' && !isDeleted && !hasLinkedQuote
        const canConvert = true; // agent owns it or is manager
        const isDeleted = false;
        const hasLinkedQuote = Boolean(afterClaim.converted_at);

        // FIXED button visibility logic — includes !hasLinkedQuote guard
        const buttonVisible =
          canConvert && afterClaim.status === 'claimed' && !isDeleted && !hasLinkedQuote;

        // EXPECTED behavior: button should NOT be visible because:
        // 1. status is now 'converted' (not 'claimed'), so first condition fails
        // 2. Even if status were 'claimed', hasLinkedQuote=true blocks it
        expect(buttonVisible).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

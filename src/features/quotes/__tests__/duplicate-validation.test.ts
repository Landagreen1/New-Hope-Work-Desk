// src/features/quotes/__tests__/duplicate-validation.test.ts
// Feature: customer-intake-claim-duplicate-quote
// Property-based tests for duplicate flag validation, restore, and merge operations

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  validateDuplicateFlag,
  canRestoreFromDuplicateReview,
  canMerge,
} from '../duplicate-validation';

const PBT_CONFIG = { numRuns: 100 };

// Arbitrary for UUIDs
const uuidArb = fc.uuid();

// Arbitrary for non-empty strings (trimmed)
const nonEmptyStringArb = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);

// All possible quote statuses
const allQuoteStatuses = [
  'assigned',
  'quoting',
  'pricing_sent',
  'not_sold',
  'activation_pending',
  'activated',
  'sold',
  'duplicate_review',
  'merged_duplicate',
] as const;

const quoteStatusArb = fc.constantFrom(...allQuoteStatuses);

// Statuses that are valid pre-flag statuses (statuses a quote can be in before being flagged)
const preFlagStatuses = [
  'assigned',
  'quoting',
  'pricing_sent',
  'activation_pending',
  'activated',
] as const;

const preFlagStatusArb = fc.constantFrom(...preFlagStatuses);

describe('Property 10 (PBT-10): Duplicate Flag Validation', () => {
  // **Validates: Requirements 13.2, 13.3, 13.6**

  it('rejects self-flagging (quoteId === originalId)', () => {
    fc.assert(
      fc.property(uuidArb, fc.string({ minLength: 10, maxLength: 500 }), (id, reason) => {
        const result = validateDuplicateFlag(id, id, reason);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Cannot flag a quote as a duplicate of itself');
      }),
      PBT_CONFIG
    );
  });

  it('rejects reasons shorter than 10 characters', () => {
    fc.assert(
      fc.property(
        uuidArb,
        uuidArb,
        fc.string({ minLength: 0, maxLength: 9 }),
        (quoteId, originalId, reason) => {
          fc.pre(quoteId !== originalId);
          const trimmedLen = reason.trim().length;
          fc.pre(trimmedLen < 10);
          const result = validateDuplicateFlag(quoteId, originalId, reason);
          expect(result.valid).toBe(false);
          expect(result.errors).toContain('Reason must be at least 10 characters');
        }
      ),
      PBT_CONFIG
    );
  });

  it('rejects reasons longer than 500 characters', () => {
    fc.assert(
      fc.property(
        uuidArb,
        uuidArb,
        fc.string({ minLength: 501, maxLength: 600 }),
        (quoteId, originalId, reason) => {
          fc.pre(quoteId !== originalId);
          const result = validateDuplicateFlag(quoteId, originalId, reason);
          expect(result.valid).toBe(false);
          expect(result.errors).toContain('Reason must be at most 500 characters');
        }
      ),
      PBT_CONFIG
    );
  });

  it('rejects empty quoteId', () => {
    fc.assert(
      fc.property(
        uuidArb,
        fc.string({ minLength: 10, maxLength: 500 }),
        (originalId, reason) => {
          const result = validateDuplicateFlag('', originalId, reason);
          expect(result.valid).toBe(false);
          expect(result.errors).toContain('Quote ID must be non-empty');
        }
      ),
      PBT_CONFIG
    );
  });

  it('rejects empty originalId', () => {
    fc.assert(
      fc.property(
        uuidArb,
        fc.string({ minLength: 10, maxLength: 500 }),
        (quoteId, reason) => {
          const result = validateDuplicateFlag(quoteId, '', reason);
          expect(result.valid).toBe(false);
          expect(result.errors).toContain('Original quote ID must be non-empty');
        }
      ),
      PBT_CONFIG
    );
  });

  it('accepts valid inputs (distinct IDs, reason 10-500 chars)', () => {
    fc.assert(
      fc.property(
        uuidArb,
        uuidArb,
        fc.string({ minLength: 10, maxLength: 500 }),
        (quoteId, originalId, reason) => {
          fc.pre(quoteId !== originalId);
          fc.pre(reason.trim().length >= 10 && reason.trim().length <= 500);
          const result = validateDuplicateFlag(quoteId, originalId, reason);
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        }
      ),
      PBT_CONFIG
    );
  });
});

describe('Property 11 (PBT-11): Not-A-Duplicate Restores Pre-Flag Status', () => {
  // **Validates: Requirements 16.2, 25.5**

  it('returns true only when status is duplicate_review AND pre_flag_status is not null', () => {
    fc.assert(
      fc.property(
        quoteStatusArb,
        fc.option(quoteStatusArb, { nil: null }),
        (status, preFlagStatus) => {
          const result = canRestoreFromDuplicateReview({ status, pre_flag_status: preFlagStatus });
          const expected = status === 'duplicate_review' && preFlagStatus !== null;
          expect(result).toBe(expected);
        }
      ),
      PBT_CONFIG
    );
  });

  it('returns false for any status that is not duplicate_review', () => {
    fc.assert(
      fc.property(
        quoteStatusArb.filter((s) => s !== 'duplicate_review'),
        fc.option(preFlagStatusArb, { nil: null }),
        (status, preFlagStatus) => {
          const result = canRestoreFromDuplicateReview({ status, pre_flag_status: preFlagStatus });
          expect(result).toBe(false);
        }
      ),
      PBT_CONFIG
    );
  });

  it('returns false when status is duplicate_review but pre_flag_status is null', () => {
    fc.assert(
      fc.property(fc.constant('duplicate_review'), () => {
        const result = canRestoreFromDuplicateReview({
          status: 'duplicate_review',
          pre_flag_status: null,
        });
        expect(result).toBe(false);
      }),
      PBT_CONFIG
    );
  });

  it('returns true when status is duplicate_review and pre_flag_status is a valid status', () => {
    fc.assert(
      fc.property(preFlagStatusArb, (preFlagStatus) => {
        const result = canRestoreFromDuplicateReview({
          status: 'duplicate_review',
          pre_flag_status: preFlagStatus,
        });
        expect(result).toBe(true);
      }),
      PBT_CONFIG
    );
  });
});

describe('Property 12 (PBT-12): Merge Cannot Target Self or Already-Merged', () => {
  // **Validates: Requirements 15.6**

  it('rejects self-merge (survivingId === mergedId)', () => {
    fc.assert(
      fc.property(uuidArb, quoteStatusArb, (id, status) => {
        const result = canMerge(id, id, status);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Cannot merge a quote with itself');
      }),
      PBT_CONFIG
    );
  });

  it('rejects merge when merged record is already merged_duplicate', () => {
    fc.assert(
      fc.property(uuidArb, uuidArb, (survivingId, mergedId) => {
        fc.pre(survivingId !== mergedId);
        const result = canMerge(survivingId, mergedId, 'merged_duplicate');
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Cannot merge an already-merged record');
      }),
      PBT_CONFIG
    );
  });

  it('accepts merge when IDs differ and merged status is not merged_duplicate', () => {
    fc.assert(
      fc.property(
        uuidArb,
        uuidArb,
        quoteStatusArb.filter((s) => s !== 'merged_duplicate'),
        (survivingId, mergedId, mergedStatus) => {
          fc.pre(survivingId !== mergedId);
          const result = canMerge(survivingId, mergedId, mergedStatus);
          expect(result.valid).toBe(true);
          expect(result.error).toBeUndefined();
        }
      ),
      PBT_CONFIG
    );
  });
});

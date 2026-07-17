// src/features/quotes/__tests__/duplicate-resolution.test.ts
// Unit tests for duplicate flagging and resolution
// Validates: Requirements 13.2, 13.6, 14.3, 15.2, 15.6, 16.2

import { describe, it, expect } from 'vitest';
import {
  validateDuplicateFlag,
  canRestoreFromDuplicateReview,
  canMerge,
} from '../duplicate-validation';

describe('validateDuplicateFlag', () => {
  it('returns valid=true for happy path: distinct IDs + reason 10-500 chars', () => {
    const result = validateDuplicateFlag(
      'quote-abc-123',
      'quote-xyz-789',
      'These two quotes have the same customer name and vehicle'
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid=false with self-flag error when quoteId === originalId', () => {
    const sameId = 'quote-same-id-001';
    const result = validateDuplicateFlag(
      sameId,
      sameId,
      'This is a valid reason with enough characters'
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Cannot flag a quote as a duplicate of itself');
  });

  it('returns error when reason is too short (< 10 chars)', () => {
    const result = validateDuplicateFlag(
      'quote-abc-123',
      'quote-xyz-789',
      'short'
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Reason must be at least 10 characters');
  });

  it('returns error when reason is too long (> 500 chars)', () => {
    const longReason = 'x'.repeat(501);
    const result = validateDuplicateFlag(
      'quote-abc-123',
      'quote-xyz-789',
      longReason
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Reason must be at most 500 characters');
  });
});

describe('canRestoreFromDuplicateReview', () => {
  it('returns true when status is duplicate_review and pre_flag_status is valid', () => {
    const result = canRestoreFromDuplicateReview({
      status: 'duplicate_review',
      pre_flag_status: 'quoting',
    });
    expect(result).toBe(true);
  });

  it('returns false when status is not duplicate_review', () => {
    const result = canRestoreFromDuplicateReview({
      status: 'assigned',
      pre_flag_status: 'quoting',
    });
    expect(result).toBe(false);
  });
});

describe('canMerge', () => {
  it('returns valid=false when survivingId equals mergedId (cannot target self)', () => {
    const sameId = 'quote-self-merge';
    const result = canMerge(sameId, sameId, 'quoting');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Cannot merge a quote with itself');
  });

  it('returns valid=false when merged record status is merged_duplicate', () => {
    const result = canMerge(
      'quote-survivor-001',
      'quote-merged-002',
      'merged_duplicate'
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Cannot merge an already-merged record');
  });

  it('returns valid=true for keep-both-link scenario: different IDs and non-merged status', () => {
    const result = canMerge(
      'quote-alpha-001',
      'quote-beta-002',
      'duplicate_review'
    );
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

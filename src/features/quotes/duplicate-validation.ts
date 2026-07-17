// src/features/quotes/duplicate-validation.ts
// Pure validation helpers for duplicate quote operations

/**
 * Validates a duplicate flag request.
 * - reason must be 10-500 chars
 * - quoteId !== originalId (cannot self-flag)
 * - Both IDs must be non-empty
 */
export function validateDuplicateFlag(
  quoteId: string,
  originalId: string,
  reason: string
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!quoteId || quoteId.trim().length === 0) {
    errors.push('Quote ID must be non-empty');
  }

  if (!originalId || originalId.trim().length === 0) {
    errors.push('Original quote ID must be non-empty');
  }

  if (quoteId && originalId && quoteId === originalId) {
    errors.push('Cannot flag a quote as a duplicate of itself');
  }

  const trimmedReason = reason?.trim() ?? '';
  if (trimmedReason.length < 10) {
    errors.push('Reason must be at least 10 characters');
  }
  if (trimmedReason.length > 500) {
    errors.push('Reason must be at most 500 characters');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Determines if a quote can be restored from duplicate review.
 * Only works when status='duplicate_review' and pre_flag_status is not null.
 */
export function canRestoreFromDuplicateReview(quote: {
  status: string;
  pre_flag_status: string | null;
}): boolean {
  return quote.status === 'duplicate_review' && quote.pre_flag_status !== null;
}

/**
 * Validates a merge operation.
 * - Cannot self-merge (survivingId === mergedId)
 * - Merged record cannot already be 'merged_duplicate'
 */
export function canMerge(
  survivingId: string,
  mergedId: string,
  mergedStatus: string
): { valid: boolean; error?: string } {
  if (survivingId === mergedId) {
    return { valid: false, error: 'Cannot merge a quote with itself' };
  }

  if (mergedStatus === 'merged_duplicate') {
    return { valid: false, error: 'Cannot merge an already-merged record' };
  }

  return { valid: true };
}

'use client';

import { getSupabase } from '../nhwd-shared/client';
import type { DuplicateDecision, DuplicateReview, OperationalQuote } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function throwIfError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || 'The quote request could not be completed.');
}

// ═══════════════════════════════════════════════════════════════════════════
// Quote Core (placeholder – expanded by task 6.2)
// ═══════════════════════════════════════════════════════════════════════════

/** Claim a RingCentral intake (agent action) */
export async function claimRingcentralIntake(intakeId: string): Promise<{ quote_id: string }> {
  const { data, error } = await getSupabase().rpc('claim_ringcentral_intake', {
    p_intake_id: intakeId,
  });
  throwIfError(error);
  return data as { quote_id: string };
}

/** Get quotes assigned to current user */
export async function getMyQuotes(): Promise<OperationalQuote[]> {
  const supabase = getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Your session expired. Sign in again.');

  const { data, error } = await supabase
    .from('operational_quotes')
    .select('*')
    .eq('assigned_to', auth.user.id)
    .order('last_progression_at', { ascending: false });
  throwIfError(error);
  return (data ?? []) as OperationalQuote[];
}

/** Change the status of a quote (agent progression) */
export async function changeQuoteStatus(
  quoteId: string,
  newStatus: string,
  reason?: string,
): Promise<void> {
  const { error } = await getSupabase().rpc('change_quote_status', {
    p_quote_id: quoteId,
    p_new_status: newStatus,
    p_reason: reason ?? null,
  });
  throwIfError(error);
}

/** Get quote history events */
export async function getQuoteHistory(quoteId: string) {
  const { data, error } = await getSupabase()
    .from('quote_history_events')
    .select('*')
    .eq('quote_id', quoteId)
    .order('created_at', { ascending: true });
  throwIfError(error);
  return data ?? [];
}

/** Get a single quote by ID */
export async function getQuoteDetail(quoteId: string): Promise<OperationalQuote | null> {
  const { data, error } = await getSupabase()
    .from('operational_quotes')
    .select('*')
    .eq('id', quoteId)
    .maybeSingle();
  throwIfError(error);
  return data as OperationalQuote | null;
}

/** Flag a quote as a possible duplicate */
export async function flagQuoteDuplicate(
  quoteId: string,
  originalQuoteId: string,
  reason: string,
): Promise<{ review_id: string }> {
  const { data, error } = await getSupabase().rpc('flag_quote_duplicate', {
    p_quote_id: quoteId,
    p_original_quote_id: originalQuoteId,
    p_reason: reason,
  });
  throwIfError(error);
  return data as { review_id: string };
}

// ═══════════════════════════════════════════════════════════════════════════
// Duplicate Resolution (Manager Actions)
// ═══════════════════════════════════════════════════════════════════════════

/** Get all pending duplicate reviews (Manager review queue) */
export async function getPendingDuplicateReviews(): Promise<DuplicateReview[]> {
  const { data, error } = await getSupabase()
    .from('duplicate_reviews')
    .select('*')
    .eq('status', 'pending')
    .order('flagged_at', { ascending: true });
  throwIfError(error);
  return (data ?? []) as DuplicateReview[];
}

/** Get a single duplicate review by ID */
export async function getDuplicateReviewDetail(reviewId: string): Promise<DuplicateReview | null> {
  const { data, error } = await getSupabase()
    .from('duplicate_reviews')
    .select('*')
    .eq('id', reviewId)
    .maybeSingle();
  throwIfError(error);
  return data as DuplicateReview | null;
}

/** Resolve a duplicate review (Manager decision) */
export async function resolveDuplicate(
  reviewId: string,
  decision: DuplicateDecision,
  fieldSelections?: Record<string, string>,
  reason?: string,
): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await getSupabase().rpc('resolve_quote_duplicate', {
    p_review_id: reviewId,
    p_decision: decision,
    p_field_selections: fieldSelections ?? null,
    p_reason: reason ?? null,
  });
  throwIfError(error);
  return data as { success: boolean; error?: string };
}

/** Merge two quote records (Manager action) */
export async function mergeQuotes(
  survivingId: string,
  mergedId: string,
  fieldSelections: Record<string, string>,
  reason: string,
): Promise<{ success: boolean; surviving_id?: string; merged_id?: string; error?: string }> {
  const { data, error } = await getSupabase().rpc('merge_quote_records', {
    p_surviving_id: survivingId,
    p_merged_id: mergedId,
    p_field_selections: fieldSelections,
    p_reason: reason,
  });
  throwIfError(error);
  return data as { success: boolean; surviving_id?: string; merged_id?: string; error?: string };
}

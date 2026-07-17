'use client';

import { getSupabase } from '../nhwd-shared/client';

// ═══════════════════════════════════════════════════════════════════════════
// Duplicate Rate Metrics — Requirements 16.5, 16.6
// ═══════════════════════════════════════════════════════════════════════════

export interface DuplicateRateMetrics {
  identified: number;     // Total flagged
  confirmed: number;      // Resolved as 'merge'
  notDuplicate: number;   // Resolved as 'not_duplicate'
  keepBothLinked: number; // Resolved as 'keep_both_link'
  pending: number;        // Unresolved
}

export interface DuplicateRateByDimension {
  dimension: string;  // source_type, creator name, or dealership name
  metrics: DuplicateRateMetrics;
}

export type DuplicateGroupBy = 'source' | 'creator' | 'dealership';

/**
 * Get duplicate rate metrics within a date range, grouped by a specified dimension.
 *
 * Queries the duplicate_reviews table joined with operational_quotes to aggregate
 * counts by source_type, intake_creator (profile display name), or dealership name.
 *
 * Date range is applied to `duplicate_reviews.flagged_at`.
 *
 * Requirement 16.5: duplicate rate metrics by source, intake creator, and dealership
 */
export async function getDuplicateRateMetrics(
  startDate: string,
  endDate: string,
  groupBy: DuplicateGroupBy,
): Promise<DuplicateRateByDimension[]> {
  const supabase = getSupabase();

  // Fetch all duplicate reviews within the date range, joined with the flagged quote
  // for dimension data. Supabase JS client supports foreign-key joins via select.
  const { data: reviews, error } = await supabase
    .from('duplicate_reviews')
    .select(`
      id,
      status,
      decision,
      flagged_at,
      flagged_quote_id,
      flagged_quote:operational_quotes!flagged_quote_id (
        source_type,
        intake_creator,
        dealer_id
      )
    `)
    .gte('flagged_at', startDate)
    .lte('flagged_at', endDate);

  if (error) throw new Error(error.message || 'Failed to load duplicate rate metrics.');

  if (!reviews || reviews.length === 0) return [];

  // The joined flagged_quote comes back as an object (single FK relationship)
  interface JoinedQuoteData {
    source_type: string | null;
    intake_creator: string | null;
    dealer_id: string | null;
  }

  type ReviewRow = (typeof reviews)[number];

  function extractQuoteData(review: ReviewRow): JoinedQuoteData | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (review as any).flagged_quote;
    if (!raw) return null;
    // Supabase returns single-FK joins as an object, not array
    if (Array.isArray(raw)) return raw[0] ?? null;
    return raw as JoinedQuoteData;
  }

  // If grouping by creator, we need profile display names
  // If grouping by dealership, we need dealer names
  let profileMap: Record<string, string> = {};
  let dealerMap: Record<string, string> = {};

  if (groupBy === 'creator') {
    const creatorIdSet = new Set<string>();
    for (const r of reviews) {
      const q = extractQuoteData(r);
      if (q?.intake_creator) creatorIdSet.add(q.intake_creator);
    }
    const creatorIds = Array.from(creatorIdSet);
    if (creatorIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name')
        .in('id', creatorIds);
      if (profiles) {
        profileMap = Object.fromEntries(profiles.map((p) => [p.id, p.display_name]));
      }
    }
  }

  if (groupBy === 'dealership') {
    const dealerIdSet = new Set<string>();
    for (const r of reviews) {
      const q = extractQuoteData(r);
      if (q?.dealer_id) dealerIdSet.add(q.dealer_id);
    }
    const dealerIds = Array.from(dealerIdSet);
    if (dealerIds.length > 0) {
      const { data: dealers } = await supabase
        .from('dealers')
        .select('id, name')
        .in('id', dealerIds);
      if (dealers) {
        dealerMap = Object.fromEntries(dealers.map((d) => [d.id, d.name]));
      }
    }
  }

  // Group reviews by dimension
  const grouped: Record<string, DuplicateRateMetrics> = {};

  for (const review of reviews) {
    const quote = extractQuoteData(review);
    let dimensionKey: string;

    switch (groupBy) {
      case 'source':
        dimensionKey = (quote?.source_type ?? 'unknown').replace(/_/g, ' ');
        break;
      case 'creator': {
        const creatorId = quote?.intake_creator;
        dimensionKey = creatorId ? (profileMap[creatorId] ?? 'Unknown Creator') : 'Unknown Creator';
        break;
      }
      case 'dealership': {
        const dealerId = quote?.dealer_id;
        if (!dealerId) {
          dimensionKey = 'No Dealership';
        } else {
          dimensionKey = dealerMap[dealerId] ?? 'Unknown Dealership';
        }
        break;
      }
      default:
        dimensionKey = 'unknown';
    }

    if (!grouped[dimensionKey]) {
      grouped[dimensionKey] = {
        identified: 0,
        confirmed: 0,
        notDuplicate: 0,
        keepBothLinked: 0,
        pending: 0,
      };
    }

    const metrics = grouped[dimensionKey];
    metrics.identified += 1;

    if (review.status === 'pending') {
      metrics.pending += 1;
    } else {
      switch (review.decision) {
        case 'merge':
          metrics.confirmed += 1;
          break;
        case 'not_duplicate':
          metrics.notDuplicate += 1;
          break;
        case 'keep_both_link':
          metrics.keepBothLinked += 1;
          break;
      }
    }
  }

  // Convert to array format
  return Object.entries(grouped).map(([dimension, metrics]) => ({
    dimension,
    metrics,
  }));
}

/**
 * Check if a duplicate review has exceeded the 72-hour aging threshold.
 *
 * Requirement 16.6: Visual aging indicator on items unresolved > 72 hours.
 */
export function isOverdue(flaggedAt: string): boolean {
  const hoursSinceFlagged = (Date.now() - new Date(flaggedAt).getTime()) / 3_600_000;
  return hoursSinceFlagged > 72;
}

/**
 * Calculate hours since a review was flagged — useful for displaying
 * how long an item has been pending in the review queue.
 */
export function hoursSinceFlagged(flaggedAt: string): number {
  return (Date.now() - new Date(flaggedAt).getTime()) / 3_600_000;
}

/**
 * Validate the date range for metrics queries.
 * Manager-selected date range must be 1-365 days.
 */
export function validateDateRange(startDate: string, endDate: string): { valid: boolean; error?: string } {
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { valid: false, error: 'Invalid date format.' };
  }

  if (start > end) {
    return { valid: false, error: 'Start date must be before end date.' };
  }

  const daysDiff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (daysDiff < 1) {
    return { valid: false, error: 'Date range must be at least 1 day.' };
  }
  if (daysDiff > 365) {
    return { valid: false, error: 'Date range cannot exceed 365 days.' };
  }

  return { valid: true };
}

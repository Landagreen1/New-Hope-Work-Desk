'use client';

import { getSupabase } from '../nhwd-shared/client';
import type { OperationalQuote, QuoteStatus } from './types';

/** Statuses excluded from reporting denominators and volume counts */
export const EXCLUDED_REPORTING_STATUSES: QuoteStatus[] = ['merged_duplicate', 'duplicate_review'];

/** Filter function to remove excluded statuses from a list of quotes */
export function filterForReporting(quotes: OperationalQuote[]): OperationalQuote[] {
  return quotes.filter((q) => !EXCLUDED_REPORTING_STATUSES.includes(q.status));
}

/** Check if a status should be included in reporting */
export function isReportableStatus(status: QuoteStatus): boolean {
  return !EXCLUDED_REPORTING_STATUSES.includes(status);
}

/** Get reportable quotes (excludes merged_duplicate and duplicate_review) */
export async function getReportableQuotes(filters?: {
  assignedTo?: string;
  startDate?: string;
  endDate?: string;
}): Promise<OperationalQuote[]> {
  const supabase = getSupabase();
  let query = supabase
    .from('operational_quotes')
    .select('*')
    .not('status', 'in', '("merged_duplicate","duplicate_review")');

  if (filters?.assignedTo) {
    query = query.eq('assigned_to', filters.assignedTo);
  }
  if (filters?.startDate) {
    query = query.gte('created_at', filters.startDate);
  }
  if (filters?.endDate) {
    query = query.lte('created_at', filters.endDate);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as OperationalQuote[];
}

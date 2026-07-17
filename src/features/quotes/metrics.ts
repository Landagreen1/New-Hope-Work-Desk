'use client';

import { getSupabase } from '../nhwd-shared/client';

export interface CsMetrics {
  userId: string;
  intakesCreated: number;
  intakesSubmitted: number;
  intakesClaimed: number;
  intakesConvertedToSold: number;
}

export interface AgentMetrics {
  userId: string;
  quotesAssigned: number;
  quotesInProgress: number;
  quotesPricingSent: number;
  quotesSold: number;
  quotesNotSold: number;
}

/** Get CS_User metrics for a specific user and date range */
export async function getCsMetrics(
  userId: string,
  startDate?: string,
  endDate?: string,
): Promise<CsMetrics> {
  const supabase = getSupabase();

  let query = supabase
    .from('customer_intakes')
    .select('id, status, converted_quote_id')
    .eq('created_by', userId);

  if (startDate) query = query.gte('created_at', startDate);
  if (endDate) query = query.lte('created_at', endDate);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const intakes = data ?? [];

  return {
    userId,
    intakesCreated: intakes.length,
    intakesSubmitted: intakes.filter((i) => i.status !== 'draft').length,
    intakesClaimed: intakes.filter((i) => ['claimed', 'assigned', 'converted'].includes(i.status)).length,
    intakesConvertedToSold: 0, // Would need to join with operational_quotes — simplified for now
  };
}

/** Get Agent metrics for a specific user and date range */
export async function getAgentMetrics(
  userId: string,
  startDate?: string,
  endDate?: string,
): Promise<AgentMetrics> {
  const supabase = getSupabase();

  let query = supabase
    .from('operational_quotes')
    .select('id, status')
    .eq('assigned_to', userId)
    .not('status', 'in', '("merged_duplicate","duplicate_review")');

  if (startDate) query = query.gte('created_at', startDate);
  if (endDate) query = query.lte('created_at', endDate);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const quotes = data ?? [];

  return {
    userId,
    quotesAssigned: quotes.length,
    quotesInProgress: quotes.filter((q) => ['quoting', 'pricing_sent', 'activation_pending', 'activated'].includes(q.status)).length,
    quotesPricingSent: quotes.filter((q) => q.status === 'pricing_sent').length,
    quotesSold: quotes.filter((q) => q.status === 'sold').length,
    quotesNotSold: quotes.filter((q) => q.status === 'not_sold').length,
  };
}

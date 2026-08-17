'use client';

/**
 * Quote Center data access.
 *
 * Every call goes to a security-definer RPC. Nothing here selects from a table
 * directly, and the underlying views are revoked from `authenticated`, so the
 * role gate cannot be bypassed by crafting a different query from the browser.
 *
 * Searching and paging happen in SQL. This is the opposite of how the quote
 * databases work today — `loadDashboardData` pulls 5,000 work items, 10,000
 * outcomes, 20,000 notes and 30,000 events into the browser and filters them in
 * JavaScript — and it is what makes the screen usable while a customer is waiting
 * on the line.
 */

import { getSupabase } from '../nhwd-shared/client';
import { addIntakeNote } from '../cs-intake/api';
import { noteTargetFor } from './status';
import type {
  DuplicateCandidate,
  DuplicateCheckInput,
  JourneyDetail,
  JourneyRecord,
  JourneySearchRow,
  StageCount,
  StageFilter,
  TimelineEntry,
} from './types';

function throwIfError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || 'The request could not be completed.');
}

export interface SearchJourneysOptions {
  query?: string | null;
  stage?: StageFilter;
  limit?: number;
  offset?: number;
}

export interface SearchJourneysResult {
  rows: JourneySearchRow[];
  /** Total matches across all pages, for "showing N of M". */
  totalCount: number;
}

/**
 * Searches every lifecycle stage at once and returns one row per journey.
 *
 * A converted intake and the quote it became come back as a single result. That
 * collapse happens in SQL rather than here, so the total count is also a count of
 * journeys and never double counts a customer who appears in two tables.
 */
export async function searchJourneys(
  options: SearchJourneysOptions = {},
): Promise<SearchJourneysResult> {
  const { data, error } = await getSupabase().rpc('quote_center_search', {
    p_query: options.query?.trim() || null,
    p_stage: options.stage ?? 'all',
    p_limit: options.limit ?? 25,
    p_offset: options.offset ?? 0,
  });
  throwIfError(error);

  const rows = (data as JourneySearchRow[]) ?? [];
  // total_count is a window function on the filtered set, so every row carries
  // the same value and an empty page legitimately means zero.
  return { rows, totalCount: rows[0]?.total_count ?? 0 };
}

/** Journey counts per stage, for the filter chips. Counts journeys, not rows. */
export async function getStageCounts(query?: string | null): Promise<StageCount[]> {
  const { data, error } = await getSupabase().rpc('quote_center_stage_counts', {
    p_query: query?.trim() || null,
  });
  throwIfError(error);
  return (data as StageCount[]) ?? [];
}

/** The full record behind the detail drawer. */
export async function getJourney(journeyKey: string): Promise<JourneyDetail | null> {
  const { data, error } = await getSupabase().rpc('quote_center_journey', {
    p_journey_key: journeyKey,
  });
  throwIfError(error);
  const rows = (data as JourneyDetail[]) ?? [];
  return rows[0] ?? null;
}

/**
 * The whole journey as one chronological list.
 *
 * Merges the intake's event log, the quote's event log and the quote notes. Lazy:
 * the search never pays for it, and it is only fetched when a journey is opened.
 */
export async function getJourneyTimeline(
  intakeId: string | null,
  workItemId: string | null,
): Promise<TimelineEntry[]> {
  if (!intakeId && !workItemId) return [];
  const { data, error } = await getSupabase().rpc('quote_center_timeline', {
    p_intake_id: intakeId,
    p_work_item_id: workItemId,
  });
  throwIfError(error);
  return (data as TimelineEntry[]) ?? [];
}

/**
 * The customer information behind a journey.
 *
 * Fetched when a journey is opened rather than with the search, because it is the
 * heaviest part of the record — the whole intake form with its drivers, vehicles and
 * owners — and a result card never shows it.
 */
export async function getJourneyRecord(
  intakeId: string | null,
  workItemId: string | null,
): Promise<JourneyRecord> {
  if (!intakeId && !workItemId) return { intake: null, quote: null };
  const { data, error } = await getSupabase().rpc('quote_center_journey_record', {
    p_intake_id: intakeId,
    p_work_item_id: workItemId,
  });
  throwIfError(error);
  return (data as JourneyRecord) ?? { intake: null, quote: null };
}

/**
 * Adds a note to a journey, whoever owns it.
 *
 * The target is chosen by lifecycle stage, not by the caller: before conversion
 * the note belongs on the intake, after conversion on the quote. Either way the
 * quote's assignment is untouched — writing a note never makes the author the
 * owner.
 */
export async function addJourneyNote(
  journey: Pick<JourneySearchRow, 'has_quote' | 'work_item_id' | 'intake_id'>,
  note: string,
): Promise<void> {
  const target = noteTargetFor(journey);
  if (!target) throw new Error('This record cannot accept notes.');

  if (target.kind === 'quote') {
    const { error } = await getSupabase().rpc('add_quote_note', {
      p_source_work_item_id: target.workItemId,
      p_note: note,
    });
    throwIfError(error);
    return;
  }

  await addIntakeNote(target.intakeId, note);
}

/**
 * Looks for existing records that might be the same customer.
 *
 * Reads the same journeys the search reads, so the warning panel can never
 * disagree with what the employee would find by searching for the customer
 * themselves.
 *
 * Returns nothing until at least one real identity signal is present. Matching on
 * a name alone would warn on every second customer, and two people sharing a name
 * is not a duplicate.
 */
export async function checkForDuplicates(
  input: DuplicateCheckInput,
): Promise<DuplicateCandidate[]> {
  const { data, error } = await getSupabase().rpc('quote_center_duplicate_check', {
    p_exclude_intake_id: input.excludeIntakeId ?? null,
    p_phone: input.phone?.trim() || null,
    p_email: input.email?.trim() || null,
    p_first_name: input.firstName?.trim() || null,
    p_last_name: input.lastName?.trim() || null,
    p_business_name: input.businessName?.trim() || null,
    p_dob: input.dob?.trim() || null,
    p_limit: 8,
  });
  throwIfError(error);
  return (data as DuplicateCandidate[]) ?? [];
}

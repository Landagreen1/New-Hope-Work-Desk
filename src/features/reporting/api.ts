'use client';

/**
 * Every Supabase call the Sales Reporting Center makes.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 17.1, 17.4
 *
 * No component calls `supabase.rpc` directly. Aggregation happens in the database, so
 * each function here is a thin wrapper that sends the normalized filter set and
 * returns typed rows. Nothing in this module aggregates.
 */

import { getSupabase } from '../nhwd-shared/client';
import { toFilterPayload } from './url-state';
import type {
  AfterHoursSummary,
  AgentReportRow,
  FilterOptions,
  IntegrityFlagRow,
  LifecycleSummary,
  NeedsAttentionRow,
  QuoteRecordRow,
  ReconciliationRow,
  ReportFilters,
  ReportSummary,
  ReviewAction,
  SourceReportRow,
} from './types';

function fail(action: string, message: string): never {
  throw new Error(`${action} failed: ${message}`);
}

export async function fetchFilterOptions(): Promise<FilterOptions> {
  const { data, error } = await getSupabase().rpc('report_filter_options');
  if (error) fail('Loading report filter options', error.message);
  return data as FilterOptions;
}

export async function fetchSummary(filters: ReportFilters): Promise<ReportSummary> {
  const { data, error } = await getSupabase().rpc('report_summary', {
    p_filters: toFilterPayload(filters),
  });
  if (error) fail('Loading the report summary', error.message);
  return data as ReportSummary;
}

export async function fetchLifecycle(filters: ReportFilters): Promise<LifecycleSummary> {
  const { data, error } = await getSupabase().rpc('report_lifecycle', {
    p_filters: toFilterPayload(filters),
  });
  if (error) fail('Loading the quote lifecycle', error.message);
  return data as LifecycleSummary;
}

export async function fetchNeedsAttention(
  filters: ReportFilters,
): Promise<NeedsAttentionRow[]> {
  const { data, error } = await getSupabase().rpc('report_needs_attention', {
    p_filters: toFilterPayload(filters),
  });
  if (error) fail('Loading the Needs Attention summary', error.message);
  return (data ?? []) as NeedsAttentionRow[];
}

export async function fetchAgentRows(filters: ReportFilters): Promise<AgentReportRow[]> {
  const { data, error } = await getSupabase().rpc('report_agent_rows', {
    p_filters: toFilterPayload(filters),
  });
  if (error) fail('Loading agent performance', error.message);
  return (data ?? []) as AgentReportRow[];
}

export async function fetchSourceRows(filters: ReportFilters): Promise<SourceReportRow[]> {
  const { data, error } = await getSupabase().rpc('report_source_rows', {
    p_filters: toFilterPayload(filters),
  });
  if (error) fail('Loading source performance', error.message);
  return (data ?? []) as SourceReportRow[];
}

export async function fetchAfterHoursSummary(
  filters: ReportFilters,
): Promise<AfterHoursSummary> {
  const { data, error } = await getSupabase().rpc('report_after_hours_summary', {
    p_filters: toFilterPayload(filters),
  });
  if (error) fail('Loading the after-hours summary', error.message);
  return data as AfterHoursSummary;
}

/**
 * A page of the records behind one metric.
 *
 * `metric` is the metric key the number came from. The function applies that metric's
 * own predicate to the same filtered set the number was computed over, which is what
 * makes the drawer and the KPI agree by construction rather than by care.
 */
export async function fetchRecords(
  filters: ReportFilters,
  metric: string,
  page: number,
  pageSize: number,
  sort: string,
): Promise<{ rows: QuoteRecordRow[]; totalCount: number }> {
  const { data, error } = await getSupabase().rpc('report_records', {
    p_filters: toFilterPayload(filters),
    p_metric: metric,
    p_limit: pageSize,
    p_offset: Math.max(0, (page - 1) * pageSize),
    p_sort: sort,
  });
  if (error) fail('Loading the underlying records', error.message);
  const rows = (data ?? []) as QuoteRecordRow[];
  return { rows, totalCount: rows.length > 0 ? Number(rows[0].total_count) : 0 };
}

export async function fetchIntegrityFlags(
  filters: ReportFilters,
  savedFilter: string,
  page: number,
  pageSize: number,
): Promise<{ rows: IntegrityFlagRow[]; totalCount: number }> {
  const { data, error } = await getSupabase().rpc('report_integrity_flags', {
    p_filters: toFilterPayload(filters),
    p_saved_filter: savedFilter,
    p_limit: pageSize,
    p_offset: Math.max(0, (page - 1) * pageSize),
  });
  if (error) fail('Loading integrity flags', error.message);
  const rows = (data ?? []) as IntegrityFlagRow[];
  return { rows, totalCount: rows.length > 0 ? Number(rows[0].total_count) : 0 };
}

export async function recordIntegrityReview(
  flagId: string,
  action: ReviewAction,
  explanation: string | null,
): Promise<{ success: boolean; error?: string; review_status?: string }> {
  const { data, error } = await getSupabase().rpc('report_integrity_review', {
    p_flag_id: flagId,
    p_action: action,
    p_explanation: explanation,
  });
  if (error) fail('Recording the review decision', error.message);
  return data as { success: boolean; error?: string; review_status?: string };
}

export async function runIntegrityDetection(
  startDate: string,
  endDate: string,
): Promise<number> {
  const { data, error } = await getSupabase().rpc('reporting_detect_integrity_flags', {
    p_start: startDate,
    p_end: endDate,
  });
  if (error) fail('Running integrity detection', error.message);
  return Number(data ?? 0);
}

export async function fetchReconciliation(
  startDate: string,
  endDate: string,
): Promise<ReconciliationRow[]> {
  const { data, error } = await getSupabase().rpc('report_reconciliation', {
    p_start: startDate,
    p_end: endDate,
  });
  if (error) fail('Loading the legacy comparison', error.message);
  return (data ?? []) as ReconciliationRow[];
}

/* -------------------------------------------------------------------------- */
/*  Business hours settings                                                    */
/* -------------------------------------------------------------------------- */

export async function fetchBusinessHours(): Promise<{
  days: Array<{ day_of_week: number; is_working_day: boolean; opens_at: string; closes_at: string }>;
  sundayIsWorkingDay: boolean;
  closures: Array<{ closure_date: string; label: string; closure_kind: string }>;
}> {
  const supabase = getSupabase();
  const [daysResult, settingsResult, closuresResult] = await Promise.all([
    supabase.from('business_hours_days').select('day_of_week,is_working_day,opens_at,closes_at').order('day_of_week'),
    supabase.from('business_hours_settings').select('sunday_is_working_day').eq('singleton_key', true).maybeSingle(),
    supabase.from('business_hours_closures').select('closure_date,label,closure_kind').order('closure_date'),
  ]);
  const firstError = daysResult.error ?? settingsResult.error ?? closuresResult.error;
  if (firstError) fail('Loading business hours', firstError.message);
  return {
    days: (daysResult.data ?? []) as Array<{
      day_of_week: number; is_working_day: boolean; opens_at: string; closes_at: string;
    }>,
    sundayIsWorkingDay: settingsResult.data?.sunday_is_working_day ?? false,
    closures: (closuresResult.data ?? []) as Array<{
      closure_date: string; label: string; closure_kind: string;
    }>,
  };
}

export async function saveBusinessHoursDay(
  dayOfWeek: number,
  isWorkingDay: boolean,
  opensAt: string,
  closesAt: string,
): Promise<void> {
  const { error } = await getSupabase()
    .from('business_hours_days')
    .update({ is_working_day: isWorkingDay, opens_at: opensAt, closes_at: closesAt, updated_at: new Date().toISOString() })
    .eq('day_of_week', dayOfWeek);
  if (error) fail('Saving business hours', error.message);
}

export async function saveSundayHandling(isWorkingDay: boolean): Promise<void> {
  const { error } = await getSupabase()
    .from('business_hours_settings')
    .update({ sunday_is_working_day: isWorkingDay, updated_at: new Date().toISOString() })
    .eq('singleton_key', true);
  if (error) fail('Saving Sunday handling', error.message);
}

export async function addBusinessHoursClosure(
  closureDate: string,
  label: string,
  kind: 'holiday' | 'special_closure',
): Promise<void> {
  const { error } = await getSupabase()
    .from('business_hours_closures')
    .upsert({ closure_date: closureDate, label, closure_kind: kind }, { onConflict: 'closure_date' });
  if (error) fail('Adding a closure', error.message);
}

export async function removeBusinessHoursClosure(closureDate: string): Promise<void> {
  const { error } = await getSupabase()
    .from('business_hours_closures')
    .delete()
    .eq('closure_date', closureDate);
  if (error) fail('Removing a closure', error.message);
}

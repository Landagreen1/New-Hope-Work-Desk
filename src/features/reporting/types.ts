/**
 * Shared types for the Sales Reporting Center.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 *
 * Closed value sets live in `definitions.ts` as `as const` arrays and are derived
 * into unions here, so the URL parser and the type system read the same list.
 * Adding a value in one place cannot leave the other behind.
 */

import type {
  AFTER_HOURS_DIMENSIONS,
  CREDIT_ROLES,
  HOURS_SEGMENTS,
  INTEGRITY_FLAG_TYPES,
  REPORT_MODES,
  REPORT_VIEWS,
  REVIEW_STATUSES,
} from './definitions';

export type ReportView = (typeof REPORT_VIEWS)[number];
export type ReportMode = (typeof REPORT_MODES)[number];
export type HoursSegment = (typeof HOURS_SEGMENTS)[number];
export type AfterHoursDimension = (typeof AFTER_HOURS_DIMENSIONS)[number];
export type CreditRole = (typeof CREDIT_ROLES)[number];
export type IntegrityFlagType = (typeof INTEGRITY_FLAG_TYPES)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export type MetricId =
  | 'quotes_received'
  | 'pricing_sent'
  | 'pending_pricing'
  | 'finalized'
  | 'sold'
  | 'not_sold'
  | 'conversion_rate'
  | 'quote_to_sale_rate'
  | 'median_time_to_pricing';

/**
 * Which timestamp a metric counts by.
 *
 * `report_end_instant` marks an as-of-date metric: it is evaluated at the last
 * instant of the Reporting_Window rather than by an event falling inside it. That
 * is the distinction the current Pending Pricing card loses, and losing it is why
 * three different numbers are all labeled "pending" today.
 */
export type MetricTimestamp =
  | 'created_at'
  | 'first_pricing_sent_at'
  | 'finalized_at'
  | 'report_end_instant'
  | 'derived';

export interface MetricDefinition {
  id: MetricId;
  label: string;
  /** Prose shown in the definition popover and written into every export header. */
  definition: string;
  countedBy: MetricTimestamp;
  /** Modes in which this metric is offered. */
  modes: readonly ReportMode[];
  /** Stated denominator for a ratio; `null` for a count. */
  denominator: string | null;
  /** The credit role a per-employee value of this metric is attributed to. */
  creditRole: CreditRole | null;
  /** True when the metric is evaluated at Report_End_Instant rather than by an event date. */
  asOfReportEnd: boolean;
}

/** Cohort state. Exactly one per quote in Quote Cohort mode. */
export type CohortState =
  | 'sold'
  | 'not_sold'
  | 'awaiting_customer_decision'
  | 'pending_pricing'
  | 'active';

export type QuoteDecisionValue = 'sold' | 'not_sold';

export type ClosureKind = 'holiday' | 'special_closure';

export interface BusinessHoursDay {
  /** 0 = Sunday through 6 = Saturday, matching `extract(dow …)` and `getUTCDay()`. */
  dayOfWeek: number;
  isWorkingDay: boolean;
  /** Wall-clock `HH:MM` in the business timezone. Inclusive. */
  opensAt: string;
  /** Wall-clock `HH:MM` in the business timezone. Exclusive. */
  closesAt: string;
}

export interface BusinessHoursClosure {
  /** `YYYY-MM-DD` in the business timezone. */
  date: string;
  label: string;
  kind: ClosureKind;
}

export interface BusinessHoursSettings {
  /** IANA zone, read from `attendance_policy.business_timezone`. Never an offset. */
  timeZone: string;
  days: readonly BusinessHoursDay[];
  /** Sunday handling is its own setting; the day-0 row supplies its hours. */
  sundayIsWorkingDay: boolean;
  closures: readonly BusinessHoursClosure[];
}

export interface InstantClassification {
  /** Calendar date of the instant in the business timezone, `YYYY-MM-DD`. */
  businessDate: string;
  /** Minutes since local midnight, 0–1439. */
  minuteOfDay: number;
  /** 0 = Sunday through 6 = Saturday. */
  dayOfWeek: number;
  isSunday: boolean;
  isWorkingDay: boolean;
  isBusinessHours: boolean;
  isAfterHours: boolean;
  /** Label of the holiday or special closure covering this date, else `null`. */
  closureLabel: string | null;
  closureKind: ClosureKind | null;
}

export interface AfterHoursFlags {
  receivedAfterHours: boolean;
  workedAfterHours: boolean;
  finalizedAfterHours: boolean;
  manualEntryAfterHours: boolean;
}

export interface AfterHoursInput {
  createdAt: string;
  finalizedAt?: string | null;
  /**
   * Instants of recorded work: claim, acceptance, note, pricing, follow-up.
   * The creation instant must not appear here — a quote is never classified as
   * after-hours *work* because it arrived after hours.
   */
  workEventAt?: readonly string[];
  isManualEntry?: boolean;
}

/** The subset of a `work_item_events` row the credit rules need. */
export interface QuoteEventLite {
  eventType: string;
  actorProfileId: string | null;
  assignedProfileId: string | null;
  createdAt: string;
}

export interface CreditResolutionInput {
  /** `work_items.created_by`. Null once the `work_items` row has moved on. */
  createdByProfileId: string | null;
  /** `assigned_profile_id` on the quote's current lifecycle row. Never null. */
  assignedProfileId: string;
  /** `assigned_profile_id` on the outcome record, read at finalization. */
  outcomeAssignedProfileId?: string | null;
  finalOutcome?: QuoteDecisionValue | null;
  /** The `price_sent_at` column value, independent of whether an event exists. */
  priceSentAt?: string | null;
  events?: readonly QuoteEventLite[];
}

export interface CreditAssignment {
  createdBy: string | null;
  claimedBy: string | null;
  assignedAgent: string;
  pricingEmployee: string | null;
  outcomeEmployee: string | null;
  salesCreditOwner: string | null;
  /** `price_sent_at` exists with no `price_sent` event: Missing Documentation. */
  missingPricingActor: boolean;
  /** Sales credit and outcome actor differ, both known: Attribution Conflict. */
  attributionConflict: boolean;
}

export interface CohortInput {
  finalOutcome?: QuoteDecisionValue | null;
  finalizedAt?: string | null;
  firstPricingSentAt?: string | null;
  acceptedAt?: string | null;
}

export interface ExclusionInput {
  /** `work_items.status`; `null` once the quote has left `work_items`. */
  workItemStatus?: string | null;
  /**
   * `work_items.is_voided`.
   *
   * This column, with `voided_at`, `voided_by`, and `void_reason`, exists in live
   * Supabase and in no repository migration. It is the real void mechanism, so a
   * status check alone does not exclude a voided quote.
   */
  isVoided?: boolean | null;
  isDuplicateRetry?: boolean;
}

export type IntegritySeverity = 'low' | 'medium' | 'high';

export type IntegritySignalCategory =
  | 'manual_activity'
  | 'queue_reconciliation'
  | 'documentation'
  | 'activity_pattern';

export interface IntegritySignalDefinition {
  key: string;
  category: IntegritySignalCategory;
  flagType: IntegrityFlagType;
  severity: IntegritySeverity;
  /** Neutral, investigable wording. Never asserts dishonesty. */
  explanation: string;
  /** Key into `IntegrityThresholds`, or `null` for a signal with no threshold. */
  thresholdKey: keyof IntegrityThresholds | null;
  /** Fields every flag of this signal must carry as evidence. */
  evidenceFields: readonly string[];
}

export interface IntegrityThresholds {
  manualQuoteRatePointsAboveBaseline: number;
  manualWorkloadRatePointsAboveBaseline: number;
  manualRateMinimumRecords: number;
  manualQuoteMinutesBeforeSold: number;
  unknownSourceRecordCount: number;
  pendingPricingDaysWithoutFollowUp: number;
  duplicateCustomerSourceHours: number;
  passesPerHundredEligibleTurns: number;
  missedTurnsPerHundredEligibleTurns: number;
  recoveriesPerHundredClaims: number;
  endOfDayClusterSharePercent: number;
  endOfPeriodClusterSharePercent: number;
  scheduleVolumeUpperMultiple: number;
  scheduleVolumeLowerMultiple: number;
  manualAfterHoursSharePercent: number;
}

export interface SourceHealthConditionDefinition {
  key: string;
  label: string;
  /** The data the view must show alongside the condition. */
  evidenceFields: readonly string[];
}

export interface LegacyReportMapping {
  /** The `ReportView` identifier used by `work-desk-app.tsx`. */
  legacyId: string;
  label: string;
  /** The Report_View that supersedes it, or `null` when it is retained as-is. */
  supersededBy: ReportView | null;
  /** Why it is retained rather than replaced. Required when `supersededBy` is null. */
  retentionReason: string | null;
}

/** Normalized filter state. The single argument shape for every reporting query. */
export interface ReportFilters {
  view: ReportView;
  mode: ReportMode;
  /** Inclusive `YYYY-MM-DD` in the business timezone. */
  startDate: string;
  endDate: string;
  compareToPreviousPeriod: boolean;
  hoursSegment: HoursSegment;
  afterHoursDimensions: readonly AfterHoursDimension[];
  agentProfileIds: readonly string[];
  teamIds: readonly string[];
  dealerIds: readonly string[];
  salespersonIds: readonly string[];
  channels: readonly string[];
  quoteKinds: readonly ('new_quote' | 'requote')[];
  assignmentMethods: readonly string[];
  statuses: readonly string[];
  outcomes: readonly QuoteDecisionValue[];
  sortColumn: string | null;
  sortDirection: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

/* -------------------------------------------------------------------------- */
/*  RPC response shapes                                                        */
/* -------------------------------------------------------------------------- */

export interface FilterOptions {
  authorized: boolean;
  can_manage_sales: boolean;
  self_profile_id: string | null;
  agents: Array<{
    id: string;
    name: string;
    username: string;
    role: string;
    is_active: boolean;
  }>;
  dealers: Array<{ id: string; name: string; is_active: boolean }>;
  /** Each salesperson carries its dealer so the two filters can be linked. */
  salespeople: Array<{
    id: string;
    dealer_id: string;
    name: string;
    is_active: boolean;
  }>;
  channels: string[];
  assignment_methods: string[];
  statuses: string[];
  outcomes: string[];
}

/** The eight KPIs over one window. A null rate is undefined, never zero. */
export interface KpiWindow {
  quotes_received: number;
  pricing_sent: number;
  pending_pricing: number;
  sold: number;
  not_sold: number;
  finalized: number;
  conversion_rate: number | null;
  quote_to_sale_rate: number | null;
  median_time_to_pricing_minutes: number | null;
}

export interface ReportSummary {
  authorized: boolean;
  mode?: ReportMode;
  start_date?: string;
  end_date?: string;
  timezone?: string;
  current?: KpiWindow;
  previous?: KpiWindow | null;
  compare?: boolean;
}

export interface LifecycleSummary {
  authorized: boolean;
  mode?: string;
  received?: number;
  accepted?: number;
  priced?: number;
  finalized?: number;
  sold?: number;
  not_sold?: number;
  awaiting_customer_decision?: number;
  still_pending_pricing?: number;
  still_active?: number;
  /** Returned so the caller can assert the invariant rather than trust it. */
  states_sum_to_received?: boolean;
}

export interface NeedsAttentionRow {
  condition_key: string;
  label: string;
  record_count: number;
  severity: IntegritySeverity;
}

export interface AgentReportRow {
  profile_id: string;
  display_name: string;
  username: string;
  role: string;
  quotes_received: number;
  pricing_sent: number;
  pending_pricing: number;
  sold: number;
  not_sold: number;
  finalized: number;
  conversion_rate: number | null;
  manual_quotes: number;
  manual_workloads: number;
  after_hours_activity: number;
  median_time_to_pricing_minutes: number | null;
  new_quotes: number;
  requotes: number;
  intake_claims: number;
  whatsapp_claims: number;
  ringcentral_claims: number;
  workload_queue_claims: number;
  passes: number;
  missed_turns: number;
  recovered_quotes: number;
  notes_coverage_percent: number | null;
  follow_ups_overdue: number;
  sold_without_pricing_evidence: number;
  not_sold_without_reason: number;
  scheduled_hours: number;
  quotes_per_scheduled_hour: number | null;
  sales_per_hundred_finalized: number | null;
  manual_per_hundred_activities: number | null;
  missed_turns_per_hundred_eligible: number | null;
  /** The five populations, reported separately. Requirement 12.6. */
  quotes_created: number;
  quotes_claimed: number;
  quotes_priced: number;
  quotes_sales_credited: number;
  quotes_outcome_entered: number;
}

export interface SourceReportRow {
  dealer_id: string | null;
  source_name: string;
  quotes: number;
  pricing_sent: number;
  pending_pricing: number;
  sold: number;
  not_sold: number;
  finalized: number;
  conversion_rate: number | null;
  median_time_to_pricing_minutes: number | null;
  manual_quote_share_percent: number | null;
  after_hours_share_percent: number | null;
  missing_salesperson_count: number;
  duplicate_count: number;
  no_response_count: number;
  median_days_pending: number | null;
  source_change_count: number;
}

export interface QuoteRecordRow {
  total_count: number;
  quote_id: string;
  customer_name: string | null;
  dealer_name: string | null;
  salesperson_name: string | null;
  channel: string | null;
  work_type: string | null;
  is_requote: boolean;
  assignment_method: string | null;
  is_manual_quote: boolean;
  is_cs_intake: boolean;
  assigned_agent_name: string | null;
  created_by_name: string | null;
  claimed_by_name: string | null;
  pricing_employee_name: string | null;
  outcome_employee_name: string | null;
  sales_credit_name: string | null;
  created_at: string;
  accepted_at: string | null;
  first_pricing_sent_at: string | null;
  finalized_at: string | null;
  lifecycle_stage: string;
  final_outcome: string | null;
  not_sold_reason: string | null;
  notes_count: number;
  follow_up_count: number;
  source_change_count: number;
  salesperson_change_count: number;
  received_after_hours: boolean;
  worked_after_hours: boolean;
  finalized_after_hours: boolean;
  manual_entry_after_hours: boolean;
  attribution_conflict: boolean;
  finalized_without_pricing: boolean;
  not_sold_without_reason: boolean;
  minutes_to_pricing: number | null;
}

export interface AfterHoursSummary {
  authorized: boolean;
  quotes_received_after_hours?: number;
  quotes_worked_after_hours?: number;
  quotes_finalized_after_hours?: number;
  manual_quotes_after_hours?: number;
  manual_workloads_after_hours?: number;
  after_hours_conversion_rate?: number | null;
  median_wait_to_first_action_minutes?: number | null;
  quotes_waiting_until_next_business_day?: number;
  sources?: Array<{ source_name: string; quotes: number }>;
  agents?: Array<{ agent_name: string; quotes: number }>;
}

export interface IntegrityFlagRow {
  total_count: number;
  id: string;
  subject_kind: string;
  subject_id: string;
  signal_key: string;
  flag_type: IntegrityFlagType;
  severity: IntegritySeverity;
  explanation: string;
  evidence: Record<string, unknown>;
  detected_on: string;
  review_status: ReviewStatus;
  reviewed_by: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  /** Null for a reader without review rights. Requirement 19.4. */
  manager_explanation: string | null;
  resolution: string | null;
  subject_label: string | null;
  subject_agent_name: string | null;
  review_count: number;
}

export type ReviewAction = 'Explained' | 'Confirmed Data Issue' | 'Dismissed' | 'Reopened';

export interface ReconciliationRow {
  metric: string;
  new_value: number | null;
  legacy_value: number | null;
  difference: number | null;
  note: string;
}

/** What the record drawer was opened from. */
export interface DrawerTarget {
  metricId: string;
  label: string;
  definition: string;
}

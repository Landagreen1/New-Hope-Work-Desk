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

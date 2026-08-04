/**
 * Authoritative metric definitions for the Sales Reporting Center.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Written definitions: .kiro/specs/sales-reporting-center-redesign/metric-definitions.md
 * Requirements: 3.5, 4.1-4.12, 5.1-5.7, 6.1-6.11, 7.5-7.9, 8.1-8.6, 13.4, 13.5, 14.2, 14.4, 1.4
 *
 * This module is the single written answer to "what does this number mean". The
 * `v1.12.*` SQL is written to match it, the tests pin it, and every metric shown on
 * screen carries its definition from here.
 *
 * PURE. No React, no Supabase, no fetch, no `Date.now()`. Every function is a
 * function of its arguments, which is what lets the whole metric layer be tested
 * without a database or a DOM.
 */

import type {
  AfterHoursFlags,
  AfterHoursInput,
  BusinessHoursSettings,
  CohortInput,
  CohortState,
  CreditAssignment,
  CreditResolutionInput,
  ExclusionInput,
  IntegritySignalDefinition,
  IntegrityThresholds,
  InstantClassification,
  LegacyReportMapping,
  MetricDefinition,
  MetricId,
  QuoteEventLite,
  SourceHealthConditionDefinition,
} from './types';

/* -------------------------------------------------------------------------- */
/*  Closed value sets                                                          */
/* -------------------------------------------------------------------------- */

/** The four Report_Views, in display order. Requirement 2.1. */
export const REPORT_VIEWS = ['overview', 'agents', 'sources', 'integrity'] as const;

/** Requirement 3.1. `activity` is Operational Activity; `cohort` is Quote Cohort. */
export const REPORT_MODES = ['activity', 'cohort'] as const;

/** Requirement 9.4. */
export const HOURS_SEGMENTS = ['all', 'business', 'after', 'sunday'] as const;

/** The four independent after-hours dimensions. Requirement 8.1. */
export const AFTER_HOURS_DIMENSIONS = [
  'received',
  'worked',
  'finalized',
  'manual_entry',
] as const;

/** The six credit roles. Requirement 6.1. */
export const CREDIT_ROLES = [
  'created_by',
  'claimed_by',
  'assigned_agent',
  'pricing_employee',
  'outcome_employee',
  'sales_credit_owner',
] as const;

/**
 * The seven neutral flag types. Requirement 14.2.
 *
 * Every one of these names a discrepancy to investigate. None asserts that an
 * employee acted dishonestly, and none may be renamed to something that does.
 */
export const INTEGRITY_FLAG_TYPES = [
  'Needs Review',
  'Attribution Conflict',
  'Missing Documentation',
  'Queue Mismatch',
  'Manual Entry Pattern',
  'Duplicate Activity',
  'Timing Conflict',
] as const;

export const REVIEW_STATUSES = [
  'Open',
  'Explained',
  'Confirmed Data Issue',
  'Dismissed',
] as const;

/** Report_Mode values that offer the lifecycle funnel. Requirement 3.4. */
export const FUNNEL_MODES = ['cohort'] as const;

/* -------------------------------------------------------------------------- */
/*  Metric catalog                                                             */
/* -------------------------------------------------------------------------- */

export const METRIC_DEFINITIONS: Record<MetricId, MetricDefinition> = {
  quotes_received: {
    id: 'quotes_received',
    label: 'Quotes Received',
    definition:
      'Distinct quotes created in the selected period. One record per quote, counted once. Excludes duplicate retries, cancelled records, workloads, and intakes that never became quotes.',
    countedBy: 'created_at',
    modes: ['activity', 'cohort'],
    denominator: null,
    creditRole: 'assigned_agent',
    asOfReportEnd: false,
  },
  pricing_sent: {
    id: 'pricing_sent',
    label: 'Pricing Sent',
    definition:
      'Distinct quotes whose first verified pricing-sent event falls in the selected period. Verified means a price-sent timestamp or a price_sent event; never a note, a status value, or an outcome.',
    countedBy: 'first_pricing_sent_at',
    modes: ['activity', 'cohort'],
    denominator: null,
    creditRole: 'pricing_employee',
    asOfReportEnd: false,
  },
  pending_pricing: {
    id: 'pending_pricing',
    // "Awaiting Pricing" rather than the bare "Pending Pricing", because the legacy
    // report used that phrase for the opposite population. See the note below.
    label: 'Awaiting Pricing',
    definition:
      'Quotes that, as of the end of the selected period, exist, are not finalized, and have had NO verified pricing sent. An as-of-date count, not a count of records created during the period. Note: the legacy report\u2019s card labelled "Pending Pricing" counted the opposite group \u2014 quotes that HAVE been priced and are waiting on the customer. That figure is shown here as Awaiting Customer Decision.',
    countedBy: 'report_end_instant',
    modes: ['activity', 'cohort'],
    denominator: null,
    creditRole: 'assigned_agent',
    asOfReportEnd: true,
  },
  finalized: {
    id: 'finalized',
    label: 'Finalized',
    definition: 'Sold plus Not Sold during the selected period.',
    countedBy: 'finalized_at',
    modes: ['activity', 'cohort'],
    denominator: null,
    creditRole: 'sales_credit_owner',
    asOfReportEnd: false,
  },
  sold: {
    id: 'sold',
    label: 'Sold',
    definition:
      'Distinct quotes whose final outcome became Sold during the selected period. Where a quote holds more than one outcome record, the latest is authoritative.',
    countedBy: 'finalized_at',
    modes: ['activity', 'cohort'],
    denominator: null,
    creditRole: 'sales_credit_owner',
    asOfReportEnd: false,
  },
  not_sold: {
    id: 'not_sold',
    label: 'Not Sold',
    definition:
      'Distinct quotes whose final outcome became Not Sold during the selected period.',
    countedBy: 'finalized_at',
    modes: ['activity', 'cohort'],
    denominator: null,
    creditRole: 'sales_credit_owner',
    asOfReportEnd: false,
  },
  conversion_rate: {
    id: 'conversion_rate',
    label: 'Conversion Rate',
    definition:
      'Sold divided by Finalized. Measures how well decided quotes close. Undefined when nothing was finalized.',
    countedBy: 'derived',
    modes: ['activity', 'cohort'],
    denominator: 'Finalized (Sold + Not Sold)',
    creditRole: 'sales_credit_owner',
    asOfReportEnd: false,
  },
  quote_to_sale_rate: {
    id: 'quote_to_sale_rate',
    label: 'Quote-to-Sale Rate',
    definition:
      'Sold divided by Quotes Received. Measures how much of the intake turns into business. A different question from Conversion Rate, and never a substitute for it.',
    countedBy: 'derived',
    modes: ['cohort'],
    denominator: 'Quotes Received',
    creditRole: 'sales_credit_owner',
    asOfReportEnd: false,
  },
  median_time_to_pricing: {
    id: 'median_time_to_pricing',
    label: 'Median Time to Pricing',
    definition:
      'Median interval from quote creation to first verified pricing sent, over exactly the quotes counted in Pricing Sent. Median rather than mean so a few very late quotes do not move the typical figure.',
    countedBy: 'derived',
    modes: ['activity', 'cohort'],
    denominator: null,
    creditRole: 'pricing_employee',
    asOfReportEnd: false,
  },
};

/** The eight KPI ribbon metrics, in display order. Requirement 11.1. */
export const KPI_RIBBON_METRICS: readonly MetricId[] = [
  'quotes_received',
  'pricing_sent',
  'pending_pricing',
  'finalized',
  'sold',
  'not_sold',
  'conversion_rate',
  'median_time_to_pricing',
];

/**
 * The stated denominator of a metric, or `null` for a count.
 *
 * Requirements 4.7 and 4.8: Conversion Rate and Quote-to-Sale Rate may never be
 * shown without their denominators, because the two ratios answer different
 * questions and the current reports show both without saying which is which.
 */
export function metricDenominatorLabel(id: MetricId): string | null {
  return METRIC_DEFINITIONS[id].denominator;
}

/** The timestamp a metric is counted by. Requirement 3.5. */
export function metricTimestampLabel(id: MetricId): string {
  switch (METRIC_DEFINITIONS[id].countedBy) {
    case 'created_at':
      return 'quote creation';
    case 'first_pricing_sent_at':
      return 'first pricing sent';
    case 'finalized_at':
      return 'final outcome';
    case 'report_end_instant':
      return 'state at period end';
    case 'derived':
      return 'derived from the metrics above';
  }
}

/* -------------------------------------------------------------------------- */
/*  Rates and medians                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A rate, or `null` when the denominator is zero.
 *
 * Requirement 12.8 and 4.7: an undefined rate renders as undefined. Returning 0
 * for "nothing was finalized" would read as "nothing converted", which is a
 * different and false claim.
 */
export function safeRate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

/** Conversion Rate as a percentage, or `null`. Requirement 4.7. */
export function conversionRate(sold: number, finalized: number): number | null {
  const rate = safeRate(sold, finalized);
  return rate === null ? null : rate * 100;
}

/** Quote-to-Sale Rate as a percentage, or `null`. Requirement 4.8. */
export function quoteToSaleRate(sold: number, quotesReceived: number): number | null {
  const rate = safeRate(sold, quotesReceived);
  return rate === null ? null : rate * 100;
}

/** Median of a sample, or `null` when empty. Even counts average the middle pair. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/* -------------------------------------------------------------------------- */
/*  Business hours                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The seeded configuration, reproducing what `isAfterHours` hard-codes today:
 * Monday–Saturday 08:30–17:30, Sunday closed.
 *
 * Seeding to parity is deliberate. It means the first legacy comparison starts
 * from the same window the old report used, so any difference it reports is a
 * definition difference rather than a settings difference.
 */
export const DEFAULT_BUSINESS_HOURS: BusinessHoursSettings = {
  timeZone: 'America/New_York',
  sundayIsWorkingDay: false,
  days: [
    { dayOfWeek: 0, isWorkingDay: false, opensAt: '08:30', closesAt: '17:30' },
    { dayOfWeek: 1, isWorkingDay: true, opensAt: '08:30', closesAt: '17:30' },
    { dayOfWeek: 2, isWorkingDay: true, opensAt: '08:30', closesAt: '17:30' },
    { dayOfWeek: 3, isWorkingDay: true, opensAt: '08:30', closesAt: '17:30' },
    { dayOfWeek: 4, isWorkingDay: true, opensAt: '08:30', closesAt: '17:30' },
    { dayOfWeek: 5, isWorkingDay: true, opensAt: '08:30', closesAt: '17:30' },
    { dayOfWeek: 6, isWorkingDay: true, opensAt: '08:30', closesAt: '17:30' },
  ],
  closures: [],
};

const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = PART_FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  PART_FORMATTERS.set(timeZone, formatter);
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * The wall-clock parts of an instant in a named zone.
 *
 * Reads `formatToParts` numerically and never re-parses a formatted string. The
 * current `getEstTime` does the opposite — `toLocaleString` then `new Date(...)` —
 * which depends on the host's locale output and misreads at daylight-saving
 * boundaries. `hourCycle: 'h23'` is what keeps midnight at 0 rather than 24.
 */
function zonedParts(instant: string | number | Date, timeZone: string): ZonedParts {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Cannot classify an invalid instant: ${String(instant)}`);
  }
  const parts = zoneFormatter(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new Error(`Time zone ${timeZone} produced no ${type} part.`);
    }
    return Number.parseInt(part.value, 10);
  };
  const hour = read('hour');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Guard against engines that emit 24 for midnight despite hourCycle h23.
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Minutes since midnight for an `HH:MM` wall-clock string. */
export function minutesFromClock(clock: string): number {
  const [hour, minute] = clock.split(':');
  const hours = Number.parseInt(hour, 10);
  const minutes = Number.parseInt(minute ?? '0', 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    throw new Error(`Not an HH:MM wall clock: ${clock}`);
  }
  return hours * 60 + minutes;
}

/** The calendar date of an instant in a named zone, as `YYYY-MM-DD`. */
export function resolveBusinessDate(
  instant: string | number | Date,
  timeZone: string,
): string {
  const parts = zonedParts(instant, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * Classify an instant against the stored business hours.
 *
 * Requirements 7.5, 7.6, 7.8, 7.9.
 *
 * - Opening time inclusive, closing time exclusive.
 * - A holiday or special closure is After_Hours all day, whatever the time.
 * - Sunday's working status comes from `sundayIsWorkingDay`, which is its own
 *   setting; the day-0 row supplies the hours it would keep if it were open. One
 *   authority per question.
 * - Day-of-week is computed from the zoned y/m/d through `Date.UTC`, so no locale
 *   weekday string is ever parsed.
 */
export function classifyInstant(
  instant: string | number | Date,
  settings: BusinessHoursSettings,
): InstantClassification {
  const parts = zonedParts(instant, settings.timeZone);
  const businessDate = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const dayOfWeek = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  ).getUTCDay();
  const minuteOfDay = parts.hour * 60 + parts.minute;
  const isSunday = dayOfWeek === 0;

  const closure =
    settings.closures.find((candidate) => candidate.date === businessDate) ?? null;
  const day = settings.days.find((candidate) => candidate.dayOfWeek === dayOfWeek) ?? null;

  const configuredWorking = isSunday
    ? settings.sundayIsWorkingDay
    : (day?.isWorkingDay ?? false);
  const isWorkingDay = configuredWorking && closure === null;

  const isBusinessHours =
    isWorkingDay &&
    day !== null &&
    minuteOfDay >= minutesFromClock(day.opensAt) &&
    minuteOfDay < minutesFromClock(day.closesAt);

  return {
    businessDate,
    minuteOfDay,
    dayOfWeek,
    isSunday,
    isWorkingDay,
    isBusinessHours,
    isAfterHours: !isBusinessHours,
    closureLabel: closure?.label ?? null,
    closureKind: closure?.kind ?? null,
  };
}

/** True when an instant falls outside configured business hours. */
export function isAfterHours(
  instant: string | number | Date,
  settings: BusinessHoursSettings,
): boolean {
  return classifyInstant(instant, settings).isAfterHours;
}

/**
 * The four independent after-hours dimensions.
 *
 * Requirements 8.1–8.6. `workEventAt` must exclude the creation instant: a quote
 * that arrives at 22:00 and is worked at 09:30 the next morning is Received After
 * Hours and *not* Worked After Hours. The current report filters on creation only,
 * so it reports that quote as after-hours activity across every metric.
 */
export function afterHoursDimensions(
  input: AfterHoursInput,
  settings: BusinessHoursSettings,
): AfterHoursFlags {
  const receivedAfterHours = isAfterHours(input.createdAt, settings);
  const workEvents = input.workEventAt ?? [];
  return {
    receivedAfterHours,
    workedAfterHours: workEvents.some((at) => isAfterHours(at, settings)),
    finalizedAfterHours:
      input.finalizedAt != null && isAfterHours(input.finalizedAt, settings),
    manualEntryAfterHours: (input.isManualEntry ?? false) && receivedAfterHours,
  };
}

/* -------------------------------------------------------------------------- */
/*  Record classification                                                      */
/* -------------------------------------------------------------------------- */

/** Assignment methods that create a quote. Requirement 5.6. */
export const QUOTE_WORK_TYPES = ['new_quote', 'requote'] as const;

/** Assignment methods that legitimately consume no rotation turn. Requirement 14.6. */
export const NON_CONSUMING_ASSIGNMENT_METHODS = [
  'manager_manual',
  'manual_quote',
  'manual_workload',
  'update_log',
  'payment_log',
  'owner',
  'customer_service',
] as const;

/** Requirement 5.1. Manual Quote is the stored assignment method and nothing else. */
export function isManualQuote(assignmentMethod: string, workType: string): boolean {
  return isQuoteWorkType(workType) && assignmentMethod === 'manual_quote';
}

/** Requirement 5.2. */
export function isManualWorkload(assignmentMethod: string, workType: string): boolean {
  return !isQuoteWorkType(workType) && assignmentMethod === 'manual_workload';
}

/** Requirement 5.3. A queue workload is never counted as a manual workload. */
export function isQueueWorkload(assignmentMethod: string, workType: string): boolean {
  return !isQuoteWorkType(workType) && assignmentMethod === 'workload_turn';
}

export function isQuoteWorkType(workType: string): boolean {
  return (QUOTE_WORK_TYPES as readonly string[]).includes(workType);
}

/** Requirement 5.4. A linked earlier quote makes a record a requote too. */
export function isRequote(
  workType: string,
  relatedQuoteSourceWorkItemId?: string | null,
): boolean {
  return workType === 'requote' || relatedQuoteSourceWorkItemId != null;
}

/**
 * Whether a record is excluded from every metric.
 *
 * A deleted quote needs no clause here: `manager_delete_quote` hard-deletes the
 * row from every quote table, so it cannot reach a metric. That is also why
 * deletion is a documented historical-accuracy limitation rather than something
 * this function can compensate for.
 *
 * `isVoided` reads `work_items.is_voided`, which exists live and in no repository
 * migration. Voiding was therefore invisible to every current report.
 */
export function isExcludedRecord(input: ExclusionInput): boolean {
  return (
    input.isVoided === true ||
    input.workItemStatus === 'cancelled' ||
    (input.isDuplicateRetry ?? false)
  );
}

/**
 * The `quote_decision` enum carries a stray `Sold` label alongside `sold`.
 *
 * No row uses it today — 599 `sold` and 613 `not_sold` as of 2026-08-03 — but the
 * label exists and can be written, and a `decision = 'sold'` comparison would miss
 * it. Every decision value passes through here first.
 */
export function normalizeDecision(
  decision: string | null | undefined,
): 'sold' | 'not_sold' | null {
  if (decision == null) return null;
  const lowered = decision.trim().toLowerCase();
  if (lowered === 'sold') return 'sold';
  if (lowered === 'not_sold' || lowered === 'not sold') return 'not_sold';
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Timestamps and cohort state                                                */
/* -------------------------------------------------------------------------- */

function earlier(left: string | null | undefined, right: string | null | undefined): string | null {
  if (left == null) return right ?? null;
  if (right == null) return left;
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

/**
 * First_Pricing_Sent_At: the earlier of the stored `price_sent_at` column and the
 * earliest `price_sent` event. Requirement 4.2.
 *
 * Returns `null` when neither exists, which is what keeps a quote out of Pricing
 * Sent. Requirement 4.3: nothing else — not a note, not a status, not an outcome —
 * may stand in for pricing evidence.
 */
export function resolveFirstPricingSentAt(
  priceSentAtColumn: string | null | undefined,
  earliestPriceSentEventAt: string | null | undefined,
): string | null {
  return earlier(priceSentAtColumn, earliestPriceSentEventAt);
}

/**
 * An `accepted_at` that equals the creation instant is not an acceptance.
 *
 * `v0.7.0` backfilled `accepted_at` from `quote_created_at` and
 * `src/lib/dashboard-data.ts` coalesces it again on read, which is why time-to-accept
 * currently reports zero for every backfilled row. Reporting the interval as
 * unknown is honest; reporting it as instant is not.
 */
export function normalizeAcceptedAt(
  acceptedAt: string | null | undefined,
  createdAt: string,
): string | null {
  if (acceptedAt == null) return null;
  return new Date(acceptedAt).getTime() === new Date(createdAt).getTime()
    ? null
    : acceptedAt;
}

function atOrBefore(instant: string | null | undefined, limit: string): boolean {
  return instant != null && new Date(instant).getTime() <= new Date(limit).getTime();
}

/**
 * The single cohort state of a quote as of the report end instant.
 *
 * Requirements 4.10, 4.11, 4.12. Exactly one of five states, so the five sum to
 * Quotes Received and nothing is double-counted. An outcome recorded after the
 * report end instant is ignored, which is what makes a closed period reproducible.
 */
export function classifyCohortState(
  input: CohortInput,
  reportEndInstant: string,
): CohortState {
  if (input.finalOutcome != null && atOrBefore(input.finalizedAt, reportEndInstant)) {
    return input.finalOutcome === 'sold' ? 'sold' : 'not_sold';
  }
  if (atOrBefore(input.firstPricingSentAt, reportEndInstant)) {
    return 'awaiting_customer_decision';
  }
  if (atOrBefore(input.acceptedAt, reportEndInstant)) {
    return 'pending_pricing';
  }
  return 'active';
}

/** Requirement 4.4, expressed over a single quote. */
export function isPendingPricingAsOf(
  input: CohortInput & ExclusionInput,
  reportEndInstant: string,
): boolean {
  if (isExcludedRecord(input)) return false;
  if (input.finalOutcome != null && atOrBefore(input.finalizedAt, reportEndInstant)) {
    return false;
  }
  return !atOrBefore(input.firstPricingSentAt, reportEndInstant);
}

/* -------------------------------------------------------------------------- */
/*  Agent credit                                                               */
/* -------------------------------------------------------------------------- */

function earliestEvent(
  events: readonly QuoteEventLite[],
  eventType: string,
): QuoteEventLite | undefined {
  return events
    .filter((event) => event.eventType === eventType)
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    )[0];
}

/**
 * The six credit roles of a quote.
 *
 * Requirements 6.2–6.8. One "agent" field cannot answer five different questions,
 * and today it is asked all five: pricing credit, sale credit, and outcome credit
 * all resolve to whichever `assigned_profile_id` the current lifecycle row holds.
 *
 * Two flags come out of this resolution rather than a separate pass, because both
 * are conclusions about the credit data itself:
 *
 * - `missingPricingActor` — a `price_sent_at` exists with no `price_sent` event, so
 *   pricing happened but nobody is recorded as having done it (Requirement 6.5).
 * - `attributionConflict` — sales credit and the outcome actor are different known
 *   people (Requirement 6.8). Not misconduct; a fact worth seeing.
 */
export function resolveCreditRoles(input: CreditResolutionInput): CreditAssignment {
  const events = input.events ?? [];

  const acceptedEvent = earliestEvent(events, 'accepted');
  const assignedEvent = earliestEvent(events, 'assigned');
  const priceSentEvent = earliestEvent(events, 'price_sent');
  const outcomeEvent =
    input.finalOutcome == null
      ? undefined
      : earliestEvent(events, input.finalOutcome === 'sold' ? 'sold' : 'not_sold');

  const pricingEmployee = priceSentEvent?.actorProfileId ?? null;
  const outcomeEmployee = outcomeEvent?.actorProfileId ?? null;
  const salesCreditOwner =
    input.finalOutcome == null
      ? null
      : (input.outcomeAssignedProfileId ?? input.assignedProfileId);

  return {
    createdBy: input.createdByProfileId,
    // Requirement 6.3: the acceptance actor, then the first assignment's target.
    claimedBy:
      acceptedEvent?.actorProfileId ?? assignedEvent?.assignedProfileId ?? null,
    assignedAgent: input.assignedProfileId,
    pricingEmployee,
    outcomeEmployee,
    salesCreditOwner,
    missingPricingActor: input.priceSentAt != null && pricingEmployee === null,
    attributionConflict:
      salesCreditOwner !== null &&
      outcomeEmployee !== null &&
      salesCreditOwner !== outcomeEmployee,
  };
}

/** The credit role a per-employee value of a metric is attributed to. Requirement 6.10. */
export function metricCreditRole(id: MetricId) {
  return METRIC_DEFINITIONS[id].creditRole;
}

/* -------------------------------------------------------------------------- */
/*  Integrity signals                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Seeded thresholds, mirrored by the `reporting_thresholds` singleton row.
 *
 * Requirement 14.4: every threshold is configuration. No signal has a literal
 * threshold in SQL or in a component, and no record is flagged merely for being
 * manual.
 */
export const DEFAULT_INTEGRITY_THRESHOLDS: IntegrityThresholds = {
  manualQuoteRatePointsAboveBaseline: 20,
  manualWorkloadRatePointsAboveBaseline: 20,
  manualRateMinimumRecords: 10,
  manualQuoteMinutesBeforeSold: 30,
  unknownSourceRecordCount: 5,
  pendingPricingDaysWithoutFollowUp: 3,
  duplicateCustomerSourceHours: 24,
  passesPerHundredEligibleTurns: 30,
  missedTurnsPerHundredEligibleTurns: 20,
  recoveriesPerHundredClaims: 25,
  endOfDayClusterSharePercent: 50,
  endOfPeriodClusterSharePercent: 40,
  scheduleVolumeUpperMultiple: 2,
  scheduleVolumeLowerMultiple: 0.25,
  manualAfterHoursSharePercent: 60,
};

export const INTEGRITY_SIGNALS: readonly IntegritySignalDefinition[] = [
  // ---- Manual activity -----------------------------------------------------
  {
    key: 'manual_quote_rate_above_baseline',
    category: 'manual_activity',
    flagType: 'Manual Entry Pattern',
    severity: 'medium',
    explanation:
      'Manual quote share is materially above the team baseline for this period.',
    thresholdKey: 'manualQuoteRatePointsAboveBaseline',
    evidenceFields: ['manualQuoteCount', 'totalQuoteCount', 'teamBaselinePercent'],
  },
  {
    key: 'manual_workload_rate_above_baseline',
    category: 'manual_activity',
    flagType: 'Manual Entry Pattern',
    severity: 'medium',
    explanation:
      'Manual workload share is materially above the team baseline for this period.',
    thresholdKey: 'manualWorkloadRatePointsAboveBaseline',
    evidenceFields: ['manualWorkloadCount', 'totalWorkloadCount', 'teamBaselinePercent'],
  },
  {
    key: 'manual_quote_shortly_before_sold',
    category: 'manual_activity',
    flagType: 'Timing Conflict',
    severity: 'high',
    explanation:
      'A manual quote was created shortly before its Sold outcome was recorded.',
    thresholdKey: 'manualQuoteMinutesBeforeSold',
    evidenceFields: ['createdAt', 'finalizedAt', 'minutesBetween'],
  },
  {
    key: 'manual_workload_without_notes',
    category: 'manual_activity',
    flagType: 'Missing Documentation',
    severity: 'medium',
    explanation: 'A manual workload was recorded with no notes.',
    thresholdKey: null,
    evidenceFields: ['workloadId', 'createdAt', 'notesCount'],
  },
  {
    key: 'manual_record_after_related_work',
    category: 'manual_activity',
    flagType: 'Timing Conflict',
    severity: 'medium',
    explanation:
      'A manual record was created after activity had already been recorded on the related work.',
    thresholdKey: null,
    evidenceFields: ['createdAt', 'relatedRecordId', 'earliestRelatedEventAt'],
  },
  {
    key: 'repeated_unknown_source',
    category: 'manual_activity',
    flagType: 'Needs Review',
    severity: 'low',
    explanation:
      'Repeated manual records in this period carry no source or an unknown source.',
    thresholdKey: 'unknownSourceRecordCount',
    evidenceFields: ['recordCount', 'recordIds'],
  },
  {
    key: 'manual_while_queue_eligible',
    category: 'manual_activity',
    flagType: 'Queue Mismatch',
    severity: 'medium',
    explanation:
      'A manual record was created while the employee held an eligible current turn in a normal queue.',
    thresholdKey: null,
    evidenceFields: ['createdAt', 'rotation', 'rotationCurrentProfileId'],
  },

  // ---- Queue reconciliation ------------------------------------------------
  {
    key: 'queue_claim_without_work_record',
    category: 'queue_reconciliation',
    flagType: 'Queue Mismatch',
    severity: 'high',
    explanation: 'A queue claim has no linked quote or workload record.',
    thresholdKey: null,
    evidenceFields: ['turnEventId', 'rotation', 'createdAt'],
  },
  {
    key: 'queue_assigned_without_turn_event',
    category: 'queue_reconciliation',
    flagType: 'Queue Mismatch',
    severity: 'high',
    explanation:
      'A record whose assignment method names a queue has no matching turn event.',
    thresholdKey: null,
    evidenceFields: ['recordId', 'assignmentMethod', 'createdAt'],
  },
  {
    key: 'turn_linked_to_multiple_quotes',
    category: 'queue_reconciliation',
    flagType: 'Duplicate Activity',
    severity: 'high',
    explanation: 'One turn event is linked to more than one quote.',
    thresholdKey: null,
    evidenceFields: ['turnEventId', 'quoteIds'],
  },
  {
    key: 'rotation_advanced_without_work_record',
    category: 'queue_reconciliation',
    flagType: 'Queue Mismatch',
    severity: 'medium',
    explanation: 'A rotation advanced with no work record created.',
    thresholdKey: null,
    evidenceFields: ['turnEventId', 'rotation', 'createdAt'],
  },
  {
    key: 'quote_without_assignment_history',
    category: 'queue_reconciliation',
    flagType: 'Queue Mismatch',
    severity: 'medium',
    explanation: 'A quote has no recorded assignment history.',
    thresholdKey: null,
    evidenceFields: ['quoteId', 'assignmentMethod', 'assignmentEventCount'],
  },
  {
    key: 'assignment_method_changed_after_creation',
    category: 'queue_reconciliation',
    flagType: 'Attribution Conflict',
    severity: 'medium',
    explanation: 'The assignment method changed after the record was created.',
    thresholdKey: null,
    evidenceFields: ['quoteId', 'originalAssignmentMethod', 'currentAssignmentMethod', 'changedAt'],
  },

  // ---- Documentation -------------------------------------------------------
  {
    key: 'sold_without_pricing_evidence',
    category: 'documentation',
    flagType: 'Missing Documentation',
    severity: 'high',
    explanation: 'A Sold quote has no verified pricing-sent event.',
    thresholdKey: null,
    evidenceFields: ['quoteId', 'finalizedAt', 'priceSentAt'],
  },
  {
    key: 'sold_without_notes',
    category: 'documentation',
    flagType: 'Missing Documentation',
    severity: 'medium',
    explanation: 'A Sold quote has no notes.',
    thresholdKey: null,
    evidenceFields: ['quoteId', 'finalizedAt', 'notesCount'],
  },
  {
    key: 'not_sold_without_reason',
    category: 'documentation',
    flagType: 'Missing Documentation',
    severity: 'high',
    explanation: 'A Not Sold quote has no reason recorded.',
    thresholdKey: null,
    evidenceFields: ['quoteId', 'finalizedAt', 'notSoldReason'],
  },
  {
    key: 'pending_pricing_without_follow_up',
    category: 'documentation',
    flagType: 'Missing Documentation',
    severity: 'medium',
    explanation:
      'A quote has been pending pricing beyond the configured interval with no follow-up recorded.',
    thresholdKey: 'pendingPricingDaysWithoutFollowUp',
    evidenceFields: ['quoteId', 'createdAt', 'daysWaiting', 'followUpCount'],
  },
  {
    key: 'outcome_changed_after_finalization',
    category: 'documentation',
    flagType: 'Timing Conflict',
    severity: 'high',
    explanation: 'The final outcome changed after the quote was finalized.',
    thresholdKey: null,
    evidenceFields: ['quoteId', 'finalizedAt', 'changedAt', 'previousOutcome', 'currentOutcome'],
  },
  {
    key: 'source_changed_after_finalization',
    category: 'documentation',
    flagType: 'Attribution Conflict',
    severity: 'medium',
    explanation: 'The source changed after the quote was finalized.',
    thresholdKey: null,
    evidenceFields: ['quoteId', 'finalizedAt', 'changedAt', 'previousDealerId', 'currentDealerId'],
  },
  {
    key: 'salesperson_changed_after_finalization',
    category: 'documentation',
    flagType: 'Attribution Conflict',
    severity: 'medium',
    explanation: 'The salesperson changed after the quote was finalized.',
    thresholdKey: null,
    evidenceFields: [
      'quoteId',
      'finalizedAt',
      'changedAt',
      'previousSalespersonId',
      'currentSalespersonId',
    ],
  },
  {
    key: 'duplicate_customer_source_quotes',
    category: 'documentation',
    flagType: 'Duplicate Activity',
    severity: 'low',
    explanation:
      'More than one quote exists for the same customer and source within the configured interval.',
    thresholdKey: 'duplicateCustomerSourceHours',
    evidenceFields: ['quoteIds', 'customerName', 'dealerId', 'hoursBetween'],
  },

  // ---- Activity patterns ---------------------------------------------------
  // Reported as Needs Review only. None of these is misconduct on its own, and
  // none may be given a flag type that implies it is (Requirement 14.8).
  {
    key: 'high_pass_rate',
    category: 'activity_pattern',
    flagType: 'Needs Review',
    severity: 'low',
    explanation: 'Passes per 100 eligible turns are above the configured level.',
    thresholdKey: 'passesPerHundredEligibleTurns',
    evidenceFields: ['passCount', 'eligibleTurnCount', 'ratePerHundred'],
  },
  {
    key: 'high_missed_turn_rate',
    category: 'activity_pattern',
    flagType: 'Needs Review',
    severity: 'low',
    explanation: 'Missed turns per 100 eligible turns are above the configured level.',
    thresholdKey: 'missedTurnsPerHundredEligibleTurns',
    evidenceFields: ['missedTurnCount', 'eligibleTurnCount', 'ratePerHundred'],
  },
  {
    key: 'high_recovery_rate',
    category: 'activity_pattern',
    flagType: 'Needs Review',
    severity: 'low',
    explanation: 'Recoveries per 100 claims are above the configured level.',
    thresholdKey: 'recoveriesPerHundredClaims',
    evidenceFields: ['recoveryCount', 'claimCount', 'ratePerHundred'],
  },
  {
    key: 'end_of_day_clustering',
    category: 'activity_pattern',
    flagType: 'Needs Review',
    severity: 'low',
    explanation:
      'A large share of a day\u2019s records were created in its final hour.',
    thresholdKey: 'endOfDayClusterSharePercent',
    evidenceFields: ['businessDate', 'finalHourCount', 'dayCount', 'sharePercent'],
  },
  {
    key: 'end_of_period_clustering',
    category: 'activity_pattern',
    flagType: 'Needs Review',
    severity: 'low',
    explanation:
      'A large share of the period\u2019s records were created on its final day.',
    thresholdKey: 'endOfPeriodClusterSharePercent',
    evidenceFields: ['finalDayCount', 'periodCount', 'sharePercent'],
  },
  {
    key: 'volume_inconsistent_with_schedule',
    category: 'activity_pattern',
    flagType: 'Needs Review',
    severity: 'low',
    explanation:
      'Quote volume per scheduled hour is outside the configured band for the team.',
    thresholdKey: 'scheduleVolumeUpperMultiple',
    evidenceFields: ['quoteCount', 'scheduledHours', 'quotesPerHour', 'teamMedianPerHour'],
  },
  {
    key: 'manual_activity_skewed_after_hours',
    category: 'activity_pattern',
    flagType: 'Needs Review',
    severity: 'low',
    explanation:
      'A large share of this employee\u2019s manual records were created after hours.',
    thresholdKey: 'manualAfterHoursSharePercent',
    evidenceFields: ['manualAfterHoursCount', 'manualCount', 'sharePercent'],
  },
];

/** Requirement 14.6: for these paths a missing turn event is expected, not a flag. */
export function turnEventExpected(assignmentMethod: string): boolean {
  return !(NON_CONSUMING_ASSIGNMENT_METHODS as readonly string[]).includes(
    assignmentMethod,
  );
}

/**
 * Requirement 14.4: manual entry alone is never a flag.
 *
 * Exists as a named predicate so the rule is testable rather than merely stated.
 */
export function manualAloneRaisesFlag(): false {
  return false;
}

export function integritySignal(key: string): IntegritySignalDefinition | undefined {
  return INTEGRITY_SIGNALS.find((signal) => signal.key === key);
}

/** The saved review filters of Requirement 15.1, in display order. */
export const REVIEW_SAVED_FILTERS = [
  'All Open Flags',
  'High Priority',
  'Manual Quote Review',
  'Manual Workload Review',
  'Queue Mismatch',
  'Missing Documentation',
  'Attribution Conflict',
  'Duplicate Activity',
  'Timing Conflict',
  'Finalized Without Pricing',
  'Not Sold Without Reason',
  'Explained',
  'Confirmed Data Issue',
  'Dismissed',
] as const;

/** Requirement 15.6: these two decisions require an explanation. */
export const REVIEW_STATUSES_REQUIRING_EXPLANATION = [
  'Explained',
  'Confirmed Data Issue',
] as const;

export function reviewActionRequiresExplanation(status: string): boolean {
  return (REVIEW_STATUSES_REQUIRING_EXPLANATION as readonly string[]).includes(status);
}

/* -------------------------------------------------------------------------- */
/*  Source health                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Requirements 13.4 and 13.5. Named conditions, each showing the data that caused
 * it. Deliberately not a composite score: a source scoring 62 tells a manager
 * nothing about what to do, whereas "high volume, low conversion" does.
 */
export const SOURCE_HEALTH_CONDITIONS: readonly SourceHealthConditionDefinition[] = [
  {
    key: 'high_volume_low_conversion',
    label: 'High volume with low conversion',
    evidenceFields: ['quoteCount', 'conversionRate', 'teamConversionRate'],
  },
  {
    key: 'high_pending_pricing_aging',
    label: 'High Pending Pricing aging',
    evidenceFields: ['pendingCount', 'medianDaysPending'],
  },
  {
    key: 'high_no_response_rate',
    label: 'High No Response rate',
    evidenceFields: ['noResponseCount', 'notSoldCount', 'sharePercent'],
  },
  {
    key: 'high_missing_salesperson_rate',
    label: 'High missing-salesperson rate',
    evidenceFields: ['missingSalespersonCount', 'quoteCount', 'sharePercent'],
  },
  {
    key: 'high_manual_entry_rate',
    label: 'High manual-entry rate',
    evidenceFields: ['manualQuoteCount', 'quoteCount', 'sharePercent'],
  },
  {
    key: 'sudden_volume_decline',
    label: 'Sudden volume decline',
    evidenceFields: ['quoteCount', 'previousPeriodQuoteCount', 'changePercent'],
  },
  {
    key: 'sudden_source_reassignment',
    label: 'Sudden source reassignment',
    evidenceFields: ['sourceChangeCount', 'quoteCount', 'changedQuoteIds'],
  },
  {
    key: 'high_duplicate_frequency',
    label: 'High duplicate frequency',
    evidenceFields: ['duplicateCount', 'quoteCount', 'sharePercent'],
  },
  {
    key: 'strong_conversion_low_volume',
    label: 'Strong conversion with low volume',
    evidenceFields: ['quoteCount', 'conversionRate'],
  },
];

/* -------------------------------------------------------------------------- */
/*  Legacy report mapping                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 1.4: every legacy view states that it is retained for comparison
 * and names the view that supersedes it, or states that none does.
 *
 * The four queue views and System Health supersede to nothing on purpose. Queue
 * Health, Recovered Quotes, Missed Turns, and Pass Behavior are queue-operations
 * reports rather than sales reports, and System Health is not a metric at all.
 */
export const LEGACY_REPORT_MAP: readonly LegacyReportMapping[] = [
  { legacyId: 'executive', label: 'Executive Overview', supersededBy: 'overview', retentionReason: null },
  { legacyId: 'not_sold', label: 'Not Sold Quotes', supersededBy: 'overview', retentionReason: null },
  { legacyId: 'trends', label: 'Daily Operations', supersededBy: 'overview', retentionReason: null },
  { legacyId: 'funnel', label: 'Sales Funnel', supersededBy: 'overview', retentionReason: null },
  { legacyId: 'exceptions', label: 'Needs Attention', supersededBy: 'overview', retentionReason: null },
  { legacyId: 'followup', label: 'Pending Follow-Up', supersededBy: 'overview', retentionReason: null },
  { legacyId: 'timing', label: 'Quote Timing', supersededBy: 'overview', retentionReason: null },
  { legacyId: 'activity', label: 'Raw Activity', supersededBy: 'overview', retentionReason: null },
  { legacyId: 'service', label: 'Service Work', supersededBy: 'overview', retentionReason: null },
  { legacyId: 'activation', label: 'Activation & Sold Audit', supersededBy: 'overview', retentionReason: null },
  { legacyId: 'agents', label: 'Agent Comparison', supersededBy: 'agents', retentionReason: null },
  { legacyId: 'scorecard', label: 'Agent 360', supersededBy: 'agents', retentionReason: null },
  { legacyId: 'workload', label: 'Workload Capacity', supersededBy: 'agents', retentionReason: null },
  { legacyId: 'documentation', label: 'Documentation Quality', supersededBy: 'agents', retentionReason: null },
  { legacyId: 'sources', label: 'Source Intelligence', supersededBy: 'sources', retentionReason: null },
  { legacyId: 'channels', label: 'Input Methods', supersededBy: 'sources', retentionReason: null },
  { legacyId: 'integrity', label: 'Data Integrity', supersededBy: 'integrity', retentionReason: null },
  { legacyId: 'manager', label: 'Manager Actions', supersededBy: 'integrity', retentionReason: null },
  {
    legacyId: 'after_hours',
    label: 'After Hours',
    supersededBy: 'overview',
    retentionReason: null,
  },
  {
    legacyId: 'queues',
    label: 'Queue Health',
    supersededBy: null,
    retentionReason:
      'Queue operations rather than sales reporting. Retained under Legacy Reports.',
  },
  {
    legacyId: 'taken',
    label: 'Recovered Quotes',
    supersededBy: null,
    retentionReason:
      'Queue operations rather than sales reporting. Retained under Legacy Reports.',
  },
  {
    legacyId: 'missed',
    label: 'Missed Turns',
    supersededBy: null,
    retentionReason:
      'Queue operations rather than sales reporting. Retained under Legacy Reports.',
  },
  {
    legacyId: 'passes',
    label: 'Pass Behavior',
    supersededBy: null,
    retentionReason:
      'Queue operations rather than sales reporting. Retained under Legacy Reports.',
  },
  {
    legacyId: 'system',
    label: 'System Health',
    supersededBy: null,
    retentionReason: 'Not a sales metric. Retained under Legacy Reports.',
  },
];

/** Metrics the new definitions retire rather than replace. Requirement 20.4. */
export const RETIRED_LEGACY_METRICS: readonly { label: string; reason: string }[] = [
  {
    label: 'Efficiency (finalized \u00f7 quotes)',
    reason:
      'Divides an Operational Activity numerator by a Quote Cohort denominator. Replaced by the Quote Cohort funnel, which answers the same question without the mixed denominator.',
  },
  {
    label: 'Agent 360 score',
    reason:
      'A single weighted composite is out of scope by requirement. The six underlying measures are reported separately.',
  },
  {
    label: 'Source category (High value / Needs attention / Low value / Monitor)',
    reason:
      'Replaced by nine named source health conditions, each stating its threshold and the data that caused it.',
  },
];

export function legacyReportMapping(legacyId: string): LegacyReportMapping | undefined {
  return LEGACY_REPORT_MAP.find((entry) => entry.legacyId === legacyId);
}

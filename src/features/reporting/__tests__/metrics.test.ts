/**
 * Authoritative metric definitions.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 3.5, 4.1-4.12, 5.1-5.6, 12.8, 20.4
 */

import { describe, expect, it } from 'vitest';

import {
  KPI_RIBBON_METRICS,
  LEGACY_REPORT_MAP,
  METRIC_DEFINITIONS,
  REPORT_MODES,
  REPORT_VIEWS,
  RETIRED_LEGACY_METRICS,
  classifyCohortState,
  conversionRate,
  isExcludedRecord,
  isManualQuote,
  isManualWorkload,
  isPendingPricingAsOf,
  isQueueWorkload,
  isRequote,
  legacyReportMapping,
  median,
  metricCreditRole,
  metricDenominatorLabel,
  metricTimestampLabel,
  normalizeAcceptedAt,
  normalizeDecision,
  quoteToSaleRate,
  resolveFirstPricingSentAt,
  safeRate,
} from '../definitions';
import type { CohortInput, MetricId } from '../types';

/**
 * The Reporting_Window used throughout: July 2026, evaluated at the last instant
 * of 31 July in New York, which is 04:00 UTC on 1 August (EDT, UTC-4).
 */
const PERIOD_START = '2026-07-01T04:00:00Z';
const PERIOD_END = '2026-08-01T03:59:59Z';

function inPeriod(instant: string | null | undefined): boolean {
  if (instant == null) return false;
  const at = new Date(instant).getTime();
  return (
    at >= new Date(PERIOD_START).getTime() && at <= new Date(PERIOD_END).getTime()
  );
}

describe('metric catalog', () => {
  it('offers exactly the eight KPI ribbon metrics in order', () => {
    expect(KPI_RIBBON_METRICS).toEqual([
      'quotes_received',
      'pricing_sent',
      'pending_pricing',
      'finalized',
      'sold',
      'not_sold',
      'conversion_rate',
      'median_time_to_pricing',
    ]);
    expect(KPI_RIBBON_METRICS.length).toBeLessThanOrEqual(8);
  });

  it('gives every metric a definition, a timestamp, and at least one mode', () => {
    for (const id of Object.keys(METRIC_DEFINITIONS) as MetricId[]) {
      const definition = METRIC_DEFINITIONS[id];
      expect(definition.id).toBe(id);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.definition.length).toBeGreaterThan(0);
      expect(definition.modes.length).toBeGreaterThan(0);
      for (const mode of definition.modes) {
        expect(REPORT_MODES).toContain(mode);
      }
      expect(metricTimestampLabel(id).length).toBeGreaterThan(0);
    }
  });

  it('marks Pending Pricing as the only as-of-date metric', () => {
    const asOf = (Object.keys(METRIC_DEFINITIONS) as MetricId[]).filter(
      (id) => METRIC_DEFINITIONS[id].asOfReportEnd,
    );
    expect(asOf).toEqual(['pending_pricing']);
    expect(METRIC_DEFINITIONS.pending_pricing.countedBy).toBe('report_end_instant');
  });

  it('states a denominator for every ratio and none for every count', () => {
    expect(metricDenominatorLabel('conversion_rate')).toBe(
      'Finalized (Sold + Not Sold)',
    );
    expect(metricDenominatorLabel('quote_to_sale_rate')).toBe('Quotes Received');
    expect(metricDenominatorLabel('sold')).toBeNull();
    expect(metricDenominatorLabel('quotes_received')).toBeNull();
  });

  it('keeps the two rates distinct so neither can stand in for the other', () => {
    expect(METRIC_DEFINITIONS.conversion_rate.label).toBe('Conversion Rate');
    expect(METRIC_DEFINITIONS.quote_to_sale_rate.label).toBe('Quote-to-Sale Rate');
    expect(metricDenominatorLabel('conversion_rate')).not.toBe(
      metricDenominatorLabel('quote_to_sale_rate'),
    );
  });

  it('attributes each metric to the credit role it measures', () => {
    expect(metricCreditRole('pricing_sent')).toBe('pricing_employee');
    expect(metricCreditRole('sold')).toBe('sales_credit_owner');
    expect(metricCreditRole('quotes_received')).toBe('assigned_agent');
  });

  it('offers Quote-to-Sale Rate in cohort mode only', () => {
    // Sold divided by every quote received is a cohort question. Offering it in
    // activity mode would divide an activity numerator by a cohort denominator,
    // which is the defect behind the retired Efficiency metric.
    expect(METRIC_DEFINITIONS.quote_to_sale_rate.modes).toEqual(['cohort']);
  });
});

describe('Quotes Received', () => {
  it('counts a quote created inside the period', () => {
    expect(inPeriod('2026-07-15T14:00:00Z')).toBe(true);
  });

  it('does not count a quote created before the period', () => {
    expect(inPeriod('2026-06-30T14:00:00Z')).toBe(false);
  });

  it('does not count a quote created after the period', () => {
    expect(inPeriod('2026-08-01T14:00:00Z')).toBe(false);
  });

  it('excludes a cancelled record', () => {
    expect(isExcludedRecord({ workItemStatus: 'cancelled' })).toBe(true);
  });

  it('excludes a voided record', () => {
    // work_items.is_voided exists live and in no repository migration, so voiding
    // was invisible to every current report.
    expect(isExcludedRecord({ workItemStatus: 'active', isVoided: true })).toBe(true);
    expect(isExcludedRecord({ workItemStatus: 'active', isVoided: false })).toBe(false);
    expect(isExcludedRecord({ workItemStatus: 'active', isVoided: null })).toBe(false);
  });

  it('excludes a duplicate retry', () => {
    expect(isExcludedRecord({ workItemStatus: 'active', isDuplicateRetry: true })).toBe(
      true,
    );
  });

  it('counts an ordinary active quote', () => {
    expect(isExcludedRecord({ workItemStatus: 'active' })).toBe(false);
  });

  it('counts a quote that has left work_items, where the status is null', () => {
    // A priced or finalized quote no longer has a work_items row.
    expect(isExcludedRecord({ workItemStatus: null })).toBe(false);
    expect(isExcludedRecord({})).toBe(false);
  });
});

describe('Pricing Sent', () => {
  it('takes the earlier of the price_sent_at column and the price_sent event', () => {
    expect(
      resolveFirstPricingSentAt('2026-07-10T12:00:00Z', '2026-07-09T12:00:00Z'),
    ).toBe('2026-07-09T12:00:00Z');
    expect(
      resolveFirstPricingSentAt('2026-07-08T12:00:00Z', '2026-07-09T12:00:00Z'),
    ).toBe('2026-07-08T12:00:00Z');
  });

  it('uses whichever source exists when only one does', () => {
    expect(resolveFirstPricingSentAt('2026-07-10T12:00:00Z', null)).toBe(
      '2026-07-10T12:00:00Z',
    );
    expect(resolveFirstPricingSentAt(null, '2026-07-10T12:00:00Z')).toBe(
      '2026-07-10T12:00:00Z',
    );
  });

  it('returns null when neither source exists, keeping the quote out of the metric', () => {
    expect(resolveFirstPricingSentAt(null, null)).toBeNull();
    expect(resolveFirstPricingSentAt(undefined, undefined)).toBeNull();
  });

  it('counts a quote created before the period but priced inside it', () => {
    const firstPricing = resolveFirstPricingSentAt('2026-07-05T14:00:00Z', null);
    expect(inPeriod('2026-06-20T14:00:00Z')).toBe(false);
    expect(inPeriod(firstPricing)).toBe(true);
  });
});

describe('Pending Pricing as of the period end', () => {
  it('counts a quote with no pricing and no outcome at the period end', () => {
    expect(
      isPendingPricingAsOf(
        { acceptedAt: '2026-07-20T14:00:00Z', firstPricingSentAt: null },
        PERIOD_END,
      ),
    ).toBe(true);
  });

  it('does not count a quote priced before the period end', () => {
    expect(
      isPendingPricingAsOf({ firstPricingSentAt: '2026-07-21T14:00:00Z' }, PERIOD_END),
    ).toBe(false);
  });

  it('counts a quote priced after the period end, because it was pending then', () => {
    // The whole point of an as-of-date metric: asking for July on 3 August and on
    // 30 August must give the same answer.
    expect(
      isPendingPricingAsOf({ firstPricingSentAt: '2026-08-05T14:00:00Z' }, PERIOD_END),
    ).toBe(true);
  });

  it('does not count a quote finalized before the period end', () => {
    expect(
      isPendingPricingAsOf(
        { finalOutcome: 'sold', finalizedAt: '2026-07-25T14:00:00Z' },
        PERIOD_END,
      ),
    ).toBe(false);
  });

  it('counts a quote finalized after the period end', () => {
    expect(
      isPendingPricingAsOf(
        { finalOutcome: 'sold', finalizedAt: '2026-08-10T14:00:00Z' },
        PERIOD_END,
      ),
    ).toBe(true);
  });

  it('does not count an excluded record', () => {
    expect(
      isPendingPricingAsOf({ isDuplicateRetry: true, firstPricingSentAt: null }, PERIOD_END),
    ).toBe(false);
    expect(
      isPendingPricingAsOf({ workItemStatus: 'cancelled', firstPricingSentAt: null }, PERIOD_END),
    ).toBe(false);
  });
});

describe('Sold, Not Sold, Finalized', () => {
  it('counts a quote created before the period but sold inside it', () => {
    expect(inPeriod('2026-06-15T14:00:00Z')).toBe(false);
    expect(inPeriod('2026-07-18T14:00:00Z')).toBe(true);
  });

  it('excludes an outcome recorded after the period end', () => {
    const state = classifyCohortState(
      { finalOutcome: 'sold', finalizedAt: '2026-08-10T14:00:00Z', firstPricingSentAt: '2026-07-20T14:00:00Z' },
      PERIOD_END,
    );
    expect(state).toBe('awaiting_customer_decision');
  });

  it('takes the latest outcome record where a quote holds more than one', () => {
    // The reporting layer resolves this by ordering on finalized_at desc. The
    // definition asserted here is that the later record wins and the quote is
    // counted exactly once.
    const outcomes = [
      { decision: 'not_sold' as const, finalizedAt: '2026-07-10T14:00:00Z' },
      { decision: 'sold' as const, finalizedAt: '2026-07-12T14:00:00Z' },
    ];
    const authoritative = [...outcomes].sort(
      (left, right) =>
        new Date(right.finalizedAt).getTime() - new Date(left.finalizedAt).getTime(),
    )[0];
    expect(authoritative.decision).toBe('sold');
    expect(outcomes).toHaveLength(2); // the superseded record still exists, and is flagged
  });
});

describe('normalizeDecision', () => {
  it('folds the stray Sold enum label onto sold', () => {
    // The live quote_decision enum carries 'Sold' alongside 'sold'. No row uses it
    // today, but a decision = 'sold' comparison would miss it if one did.
    expect(normalizeDecision('Sold')).toBe('sold');
    expect(normalizeDecision('sold')).toBe('sold');
    expect(normalizeDecision('not_sold')).toBe('not_sold');
    expect(normalizeDecision('Not Sold')).toBe('not_sold');
  });

  it('returns null for an absent or unrecognized decision', () => {
    expect(normalizeDecision(null)).toBeNull();
    expect(normalizeDecision(undefined)).toBeNull();
    expect(normalizeDecision('')).toBeNull();
    expect(normalizeDecision('pending')).toBeNull();
  });
});

describe('Conversion Rate and Quote-to-Sale Rate', () => {
  it('divides Sold by Finalized, not by Quotes Received', () => {
    expect(conversionRate(6, 10)).toBe(60);
    expect(quoteToSaleRate(6, 30)).toBe(20);
    expect(conversionRate(6, 10)).not.toBe(quoteToSaleRate(6, 30));
  });

  it('is undefined rather than zero when nothing was finalized', () => {
    expect(conversionRate(0, 0)).toBeNull();
    expect(safeRate(0, 0)).toBeNull();
  });

  it('is undefined rather than zero when no quotes were received', () => {
    expect(quoteToSaleRate(0, 0)).toBeNull();
  });

  it('reports 0 for a real zero numerator over a non-zero denominator', () => {
    expect(conversionRate(0, 10)).toBe(0);
  });

  it('reports 100 when every finalized quote sold', () => {
    expect(conversionRate(10, 10)).toBe(100);
  });
});

describe('median', () => {
  it('returns the middle value of an odd sample', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('averages the middle pair of an even sample', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns null for an empty sample rather than zero', () => {
    expect(median([])).toBeNull();
  });

  it('does not mutate its input', () => {
    const values = [5, 1, 3];
    median(values);
    expect(values).toEqual([5, 1, 3]);
  });

  it('is not dragged by a single very late outlier the way a mean is', () => {
    const sample = [10, 12, 14, 16, 4000];
    const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;
    expect(median(sample)).toBe(14);
    expect(mean).toBeGreaterThan(800);
  });
});

describe('cohort state', () => {
  const cases: Array<{ name: string; input: CohortInput; expected: string }> = [
    {
      name: 'sold before the period end',
      input: { finalOutcome: 'sold', finalizedAt: '2026-07-20T14:00:00Z' },
      expected: 'sold',
    },
    {
      name: 'not sold before the period end',
      input: { finalOutcome: 'not_sold', finalizedAt: '2026-07-20T14:00:00Z' },
      expected: 'not_sold',
    },
    {
      name: 'priced with no outcome',
      input: { firstPricingSentAt: '2026-07-20T14:00:00Z' },
      expected: 'awaiting_customer_decision',
    },
    {
      name: 'accepted but not priced',
      input: { acceptedAt: '2026-07-20T14:00:00Z' },
      expected: 'pending_pricing',
    },
    {
      name: 'neither accepted nor priced',
      input: {},
      expected: 'active',
    },
    {
      name: 'accepted after the period end',
      input: { acceptedAt: '2026-08-05T14:00:00Z' },
      expected: 'active',
    },
    {
      name: 'priced after the period end',
      input: { firstPricingSentAt: '2026-08-05T14:00:00Z', acceptedAt: '2026-07-20T14:00:00Z' },
      expected: 'pending_pricing',
    },
  ];

  for (const testCase of cases) {
    it(`classifies a quote ${testCase.name}`, () => {
      expect(classifyCohortState(testCase.input, PERIOD_END)).toBe(testCase.expected);
    });
  }

  it('assigns every quote to exactly one state, so the five states sum to Received', () => {
    const cohort: CohortInput[] = [
      { finalOutcome: 'sold', finalizedAt: '2026-07-05T14:00:00Z' },
      { finalOutcome: 'sold', finalizedAt: '2026-07-06T14:00:00Z' },
      { finalOutcome: 'not_sold', finalizedAt: '2026-07-07T14:00:00Z' },
      { firstPricingSentAt: '2026-07-08T14:00:00Z' },
      { acceptedAt: '2026-07-09T14:00:00Z' },
      {},
      { finalOutcome: 'sold', finalizedAt: '2026-08-20T14:00:00Z', acceptedAt: '2026-07-10T14:00:00Z' },
    ];
    const counts = cohort.reduce<Record<string, number>>((acc, quote) => {
      const state = classifyCohortState(quote, PERIOD_END);
      acc[state] = (acc[state] ?? 0) + 1;
      return acc;
    }, {});
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(cohort.length);
    expect(counts).toEqual({
      sold: 2,
      not_sold: 1,
      awaiting_customer_decision: 1,
      pending_pricing: 2,
      active: 1,
    });
  });

  it('prefers the outcome over pricing when both are before the period end', () => {
    expect(
      classifyCohortState(
        {
          finalOutcome: 'sold',
          finalizedAt: '2026-07-20T14:00:00Z',
          firstPricingSentAt: '2026-07-15T14:00:00Z',
          acceptedAt: '2026-07-10T14:00:00Z',
        },
        PERIOD_END,
      ),
    ).toBe('sold');
  });
});

describe('normalizeAcceptedAt', () => {
  it('treats an accepted_at equal to creation as unknown, not as instant', () => {
    // v0.7.0 backfilled accepted_at from quote_created_at and dashboard-data.ts
    // coalesces it again on read, which is why time-to-accept currently reports
    // zero for every backfilled row.
    const createdAt = '2026-07-10T14:00:00Z';
    expect(normalizeAcceptedAt(createdAt, createdAt)).toBeNull();
  });

  it('keeps a genuine acceptance', () => {
    expect(normalizeAcceptedAt('2026-07-10T14:05:00Z', '2026-07-10T14:00:00Z')).toBe(
      '2026-07-10T14:05:00Z',
    );
  });

  it('returns null for a missing acceptance', () => {
    expect(normalizeAcceptedAt(null, '2026-07-10T14:00:00Z')).toBeNull();
    expect(normalizeAcceptedAt(undefined, '2026-07-10T14:00:00Z')).toBeNull();
  });
});

describe('record classification', () => {
  it('classifies a Manual Quote from the stored assignment method alone', () => {
    expect(isManualQuote('manual_quote', 'new_quote')).toBe(true);
    expect(isManualQuote('manual_quote', 'requote')).toBe(true);
  });

  it('does not classify a queue claim or an intake claim as a Manual Quote', () => {
    expect(isManualQuote('whatsapp_turn', 'new_quote')).toBe(false);
    expect(isManualQuote('ringcentral_turn', 'new_quote')).toBe(false);
    expect(isManualQuote('manager_manual', 'new_quote')).toBe(false);
  });

  it('does not classify a manual workload as a Manual Quote', () => {
    expect(isManualQuote('manual_workload', 'activation')).toBe(false);
  });

  it('classifies a Manual Workload only for a non-quote manual record', () => {
    expect(isManualWorkload('manual_workload', 'activation')).toBe(true);
    expect(isManualWorkload('manual_workload', 'change')).toBe(true);
    expect(isManualWorkload('manual_workload', 'payment')).toBe(true);
    expect(isManualWorkload('manual_quote', 'new_quote')).toBe(false);
  });

  it('never counts a workload turn as a Manual Workload', () => {
    expect(isManualWorkload('workload_turn', 'activation')).toBe(false);
    expect(isQueueWorkload('workload_turn', 'activation')).toBe(true);
    expect(isQueueWorkload('manual_workload', 'activation')).toBe(false);
  });

  it('classifies a Requote by work type or by a linked earlier quote', () => {
    expect(isRequote('requote')).toBe(true);
    expect(isRequote('new_quote', 'a1b2c3')).toBe(true);
    expect(isRequote('new_quote', null)).toBe(false);
    expect(isRequote('new_quote')).toBe(false);
  });
});

describe('legacy mapping', () => {
  it('maps all 24 legacy report views', () => {
    expect(LEGACY_REPORT_MAP).toHaveLength(24);
    const ids = new Set(LEGACY_REPORT_MAP.map((entry) => entry.legacyId));
    expect(ids.size).toBe(LEGACY_REPORT_MAP.length);
  });

  it('names a superseding view or gives a retention reason for every entry', () => {
    for (const entry of LEGACY_REPORT_MAP) {
      if (entry.supersededBy === null) {
        expect(entry.retentionReason).not.toBeNull();
        expect(entry.retentionReason?.length ?? 0).toBeGreaterThan(0);
      } else {
        expect(REPORT_VIEWS).toContain(entry.supersededBy);
      }
    }
  });

  it('keeps the four queue views and System Health out of the four new views', () => {
    for (const legacyId of ['queues', 'taken', 'missed', 'passes', 'system']) {
      expect(legacyReportMapping(legacyId)?.supersededBy).toBeNull();
    }
  });

  it('gives a reason for every retired metric', () => {
    expect(RETIRED_LEGACY_METRICS.length).toBeGreaterThan(0);
    for (const retired of RETIRED_LEGACY_METRICS) {
      expect(retired.reason.length).toBeGreaterThan(0);
    }
  });
});

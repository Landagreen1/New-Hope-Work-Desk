/**
 * Integrity signal catalog, thresholds, and the review workflow rules.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 13.4, 13.5, 14.2-14.10, 15.1, 15.5, 15.6
 *
 * Two properties matter more than any individual threshold:
 *
 *  1. No flag type, explanation, or label asserts that an employee acted
 *     dishonestly. The purpose is a discrepancy management can investigate.
 *  2. A record is never flagged solely for being manual.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INTEGRITY_THRESHOLDS,
  INTEGRITY_FLAG_TYPES,
  INTEGRITY_SIGNALS,
  NON_CONSUMING_ASSIGNMENT_METHODS,
  REVIEW_SAVED_FILTERS,
  REVIEW_STATUSES,
  SOURCE_HEALTH_CONDITIONS,
  integritySignal,
  manualAloneRaisesFlag,
  reviewActionRequiresExplanation,
  turnEventExpected,
} from '../definitions';
import type { IntegrityThresholds } from '../types';

describe('flag types', () => {
  it('declares exactly the seven neutral types', () => {
    expect(INTEGRITY_FLAG_TYPES).toEqual([
      'Needs Review',
      'Attribution Conflict',
      'Missing Documentation',
      'Queue Mismatch',
      'Manual Entry Pattern',
      'Duplicate Activity',
      'Timing Conflict',
    ]);
  });

  it('uses no accusatory language in any flag type', () => {
    const accusatory =
      /fraud|dishonest|lying|liar|cheat|steal|stole|theft|falsif|fake|abuse|misconduct|manipulat/i;
    for (const flagType of INTEGRITY_FLAG_TYPES) {
      expect(flagType).not.toMatch(accusatory);
    }
  });

  it('uses no accusatory language in any signal explanation', () => {
    const accusatory =
      /fraud|dishonest|lying|liar|cheat|steal|stole|theft|falsif|fake|abuse|misconduct|manipulat|gaming/i;
    for (const signal of INTEGRITY_SIGNALS) {
      expect(signal.explanation).not.toMatch(accusatory);
    }
  });

  it('assigns every signal one of the seven types', () => {
    for (const signal of INTEGRITY_SIGNALS) {
      expect(INTEGRITY_FLAG_TYPES).toContain(signal.flagType);
    }
  });
});

describe('signal catalog', () => {
  it('gives every signal a unique key', () => {
    const keys = INTEGRITY_SIGNALS.map((signal) => signal.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every signal an explanation and at least one evidence field', () => {
    // Requirement 15.8: a flag is never presented without the data that caused it.
    for (const signal of INTEGRITY_SIGNALS) {
      expect(signal.explanation.length).toBeGreaterThan(0);
      expect(signal.evidenceFields.length).toBeGreaterThan(0);
    }
  });

  it('points every threshold key at a real threshold', () => {
    for (const signal of INTEGRITY_SIGNALS) {
      if (signal.thresholdKey !== null) {
        expect(DEFAULT_INTEGRITY_THRESHOLDS).toHaveProperty(signal.thresholdKey);
      }
    }
  });

  it('covers all four signal categories', () => {
    const categories = new Set(INTEGRITY_SIGNALS.map((signal) => signal.category));
    expect(categories).toEqual(
      new Set(['manual_activity', 'queue_reconciliation', 'documentation', 'activity_pattern']),
    );
  });

  it('detects the seven manual-activity signals of Requirement 14.3', () => {
    const manual = INTEGRITY_SIGNALS.filter(
      (signal) => signal.category === 'manual_activity',
    ).map((signal) => signal.key);
    expect(manual).toEqual([
      'manual_quote_rate_above_baseline',
      'manual_workload_rate_above_baseline',
      'manual_quote_shortly_before_sold',
      'manual_workload_without_notes',
      'manual_record_after_related_work',
      'repeated_unknown_source',
      'manual_while_queue_eligible',
    ]);
  });

  it('detects the six queue-reconciliation signals of Requirement 14.5', () => {
    const queue = INTEGRITY_SIGNALS.filter(
      (signal) => signal.category === 'queue_reconciliation',
    ).map((signal) => signal.key);
    expect(queue).toEqual([
      'queue_claim_without_work_record',
      'queue_assigned_without_turn_event',
      'turn_linked_to_multiple_quotes',
      'rotation_advanced_without_work_record',
      'quote_without_assignment_history',
      'assignment_method_changed_after_creation',
    ]);
  });

  it('detects the eight documentation signals of Requirement 14.7', () => {
    const documentation = INTEGRITY_SIGNALS.filter(
      (signal) => signal.category === 'documentation',
    ).map((signal) => signal.key);
    expect(documentation).toEqual([
      'sold_without_pricing_evidence',
      'sold_without_notes',
      'not_sold_without_reason',
      'pending_pricing_without_follow_up',
      'outcome_changed_after_finalization',
      'source_changed_after_finalization',
      'salesperson_changed_after_finalization',
      'duplicate_customer_source_quotes',
    ]);
  });

  it('reports every activity pattern as Needs Review only', () => {
    // Requirement 14.8: these are shown, not treated as misconduct.
    const patterns = INTEGRITY_SIGNALS.filter(
      (signal) => signal.category === 'activity_pattern',
    );
    expect(patterns).toHaveLength(7);
    for (const signal of patterns) {
      expect(signal.flagType).toBe('Needs Review');
      expect(signal.severity).toBe('low');
    }
  });

  it('resolves a signal by key and returns undefined for an unknown key', () => {
    expect(integritySignal('sold_without_notes')?.flagType).toBe('Missing Documentation');
    expect(integritySignal('no_such_signal')).toBeUndefined();
  });
});

describe('manual entry is never a flag on its own', () => {
  it('states the rule as a testable predicate', () => {
    expect(manualAloneRaisesFlag()).toBe(false);
  });

  it('pairs every manual-activity signal with a threshold or a second condition', () => {
    // Requirement 14.4. A signal with no threshold must name a second condition in
    // its evidence — notes, a related record, a rotation state — rather than firing
    // on the assignment method alone.
    for (const signal of INTEGRITY_SIGNALS.filter(
      (candidate) => candidate.category === 'manual_activity',
    )) {
      if (signal.thresholdKey === null) {
        expect(signal.evidenceFields.length).toBeGreaterThan(1);
      }
    }
  });
});

describe('threshold evaluation', () => {
  const thresholds = DEFAULT_INTEGRITY_THRESHOLDS;

  function aboveBaseline(
    ratePercent: number,
    baselinePercent: number,
    recordCount: number,
    limits: IntegrityThresholds,
  ): boolean {
    if (recordCount < limits.manualRateMinimumRecords) return false;
    return ratePercent - baselinePercent >= limits.manualQuoteRatePointsAboveBaseline;
  }

  it('does not fire just below the configured margin', () => {
    expect(aboveBaseline(29, 10, 20, thresholds)).toBe(false);
  });

  it('fires exactly at the configured margin', () => {
    expect(aboveBaseline(30, 10, 20, thresholds)).toBe(true);
  });

  it('fires above the configured margin', () => {
    expect(aboveBaseline(45, 10, 20, thresholds)).toBe(true);
  });

  it('does not fire below the minimum record count, however extreme the rate', () => {
    // A single manual quote out of one is a 100% rate and means nothing.
    expect(aboveBaseline(100, 10, 1, thresholds)).toBe(false);
    expect(aboveBaseline(100, 10, thresholds.manualRateMinimumRecords, thresholds)).toBe(
      true,
    );
  });

  it('honours a changed threshold rather than a literal', () => {
    const relaxed: IntegrityThresholds = {
      ...thresholds,
      manualQuoteRatePointsAboveBaseline: 50,
    };
    expect(aboveBaseline(45, 10, 20, thresholds)).toBe(true);
    expect(aboveBaseline(45, 10, 20, relaxed)).toBe(false);
  });

  it('seeds every threshold with a positive value', () => {
    for (const [key, value] of Object.entries(thresholds)) {
      expect(value, key).toBeGreaterThan(0);
    }
  });

  it('keeps the schedule band the right way round', () => {
    expect(thresholds.scheduleVolumeUpperMultiple).toBeGreaterThan(
      thresholds.scheduleVolumeLowerMultiple,
    );
  });
});

describe('queue reconciliation exclusions', () => {
  it('expects a turn event for the three consuming queue methods', () => {
    for (const method of ['whatsapp_turn', 'ringcentral_turn', 'workload_turn']) {
      expect(turnEventExpected(method)).toBe(true);
    }
  });

  it('expects no turn event for the non-consuming paths', () => {
    // Requirement 14.6. Flagging these would be noise: manager assignment, manual
    // logging, and an out-of-turn walk-in claim legitimately consume no turn.
    for (const method of NON_CONSUMING_ASSIGNMENT_METHODS) {
      expect(turnEventExpected(method)).toBe(false);
    }
  });

  it('covers manager assignment and both manual paths in the exclusion list', () => {
    expect(NON_CONSUMING_ASSIGNMENT_METHODS).toContain('manager_manual');
    expect(NON_CONSUMING_ASSIGNMENT_METHODS).toContain('manual_quote');
    expect(NON_CONSUMING_ASSIGNMENT_METHODS).toContain('manual_workload');
  });
});

describe('review workflow', () => {
  it('declares the four review statuses', () => {
    expect(REVIEW_STATUSES).toEqual([
      'Open',
      'Explained',
      'Confirmed Data Issue',
      'Dismissed',
    ]);
  });

  it('offers the fourteen saved filters of Requirement 15.1', () => {
    expect(REVIEW_SAVED_FILTERS).toHaveLength(14);
    expect(REVIEW_SAVED_FILTERS[0]).toBe('All Open Flags');
    for (const status of ['Explained', 'Confirmed Data Issue', 'Dismissed']) {
      expect(REVIEW_SAVED_FILTERS).toContain(status);
    }
  });

  it('requires an explanation for Explained and Confirmed Data Issue', () => {
    expect(reviewActionRequiresExplanation('Explained')).toBe(true);
    expect(reviewActionRequiresExplanation('Confirmed Data Issue')).toBe(true);
  });

  it('does not require an explanation to Dismiss or Reopen', () => {
    expect(reviewActionRequiresExplanation('Dismissed')).toBe(false);
    expect(reviewActionRequiresExplanation('Open')).toBe(false);
  });

  it('models re-detection as preserving review state', () => {
    // Requirement 14.10. The upsert writes explanation, evidence, and severity; it
    // never writes review_status, reviewed_by, reviewed_at, or manager_explanation.
    // An explained discrepancy must stay explained when detection runs again.
    const existing = {
      signalKey: 'sold_without_notes',
      explanation: 'A Sold quote has no notes.',
      severity: 'medium' as const,
      reviewStatus: 'Explained' as const,
      managerExplanation: 'Notes were recorded on the linked renewal instead.',
      reviewedBy: 'profile-manager',
    };
    const redetected = {
      signalKey: 'sold_without_notes',
      explanation: 'A Sold quote has no notes.',
      severity: 'high' as const,
    };
    const merged = {
      ...existing,
      explanation: redetected.explanation,
      severity: redetected.severity,
    };
    expect(merged.reviewStatus).toBe('Explained');
    expect(merged.managerExplanation).toBe(existing.managerExplanation);
    expect(merged.reviewedBy).toBe(existing.reviewedBy);
    expect(merged.severity).toBe('high');
  });

  it('models a reopen as retaining the earlier explanation and history', () => {
    // Requirement 15.5.
    const history = [
      { action: 'Explained', explanation: 'Handled off-system.', at: '2026-07-10T14:00:00Z' },
    ];
    const reopened = {
      reviewStatus: 'Open' as const,
      managerExplanation: 'Handled off-system.',
      history: [
        ...history,
        { action: 'Reopened', explanation: '', at: '2026-07-20T09:00:00Z' },
      ],
    };
    expect(reopened.reviewStatus).toBe('Open');
    expect(reopened.managerExplanation).toBe('Handled off-system.');
    expect(reopened.history).toHaveLength(2);
    expect(reopened.history[0]).toEqual(history[0]);
  });
});

describe('source health conditions', () => {
  it('declares the nine named conditions of Requirement 13.5', () => {
    expect(SOURCE_HEALTH_CONDITIONS).toHaveLength(9);
    expect(SOURCE_HEALTH_CONDITIONS.map((condition) => condition.key)).toEqual([
      'high_volume_low_conversion',
      'high_pending_pricing_aging',
      'high_no_response_rate',
      'high_missing_salesperson_rate',
      'high_manual_entry_rate',
      'sudden_volume_decline',
      'sudden_source_reassignment',
      'high_duplicate_frequency',
      'strong_conversion_low_volume',
    ]);
  });

  it('gives every condition the data the view must show alongside it', () => {
    // Requirement 13.4: a named condition, not a composite score, and it shows why.
    for (const condition of SOURCE_HEALTH_CONDITIONS) {
      expect(condition.label.length).toBeGreaterThan(0);
      expect(condition.evidenceFields.length).toBeGreaterThan(0);
    }
  });

  it('uses unique keys', () => {
    const keys = SOURCE_HEALTH_CONDITIONS.map((condition) => condition.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

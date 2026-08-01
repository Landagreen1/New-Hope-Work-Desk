// src/features/time-attendance/domain/__tests__/coverage-classification.test.ts
// Property test for the coverage rule: the Requirement 6 matrix, the
// unconfigured slot, and the severity ordering.
//
// The matrix is checked against the four criteria written as four independent
// conditions rather than against a second copy of the implementation's ordered
// comparison. Exactly one condition must hold for any headcount and threshold,
// and the reported status must be the one that condition names — so a reordered
// implementation, an off-by-one cut point, or a fifth outcome all fail here.
//
// Criteria 11 and 12 are read as the ordered matrix states them: a
// `warningThreshold` below `minimumStaff` is a configuration the database
// permits, and read in isolation criteria 9 and 12 would both apply to a
// headcount between the two. The order resolves it — below the minimum is
// Critical whatever the warning value says — so criterion 12's condition carries
// "and not below or at the minimum" here, which is exactly what the ordering
// means.
//
// The same headcount is put through both consumers that report a required
// figure, `buildCoverageIntervals` and `projectCoverage`, and both must return
// the status `classifyCoverage` assigns. That is the single-implementation claim
// of Requirement 19, criterion 8 read at the two call sites this module owns:
// the coverage rule is applied to a headcount, and no consumer may reach its own
// conclusion about the same number.
//
// Feature: time-attendance-ui-redesign, Property 10: Coverage status classification and severity monotonicity
// **Validates: Requirements 6.4, 6.9, 6.10, 6.11, 6.12, 6.13, 8.11**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  COVERAGE_SEVERITY,
  buildCoverageIntervals,
  classifyCoverage,
  projectCoverage,
  type CoverageStatus,
  type ShiftWindow,
} from '../coverage';
import type { Threshold } from '../types';
import { availableStaffArb, thresholdArb } from './arbitraries';

/** 2026-07-28 is a summer weekday, so New York is UTC-4 that day. */
const WORK_DATE = '2026-07-28';
const WINDOW_START = new Date(`${WORK_DATE}T09:00:00-04:00`);
const WINDOW_END = new Date(`${WORK_DATE}T17:00:00-04:00`);

const NOBODY_ABSENT: ReadonlySet<string> = new Set<string>();

/** `available` employees, each on the same shift, so the headcount is exact. */
function windowsFor(available: number): ShiftWindow[] {
  return Array.from({ length: available }, (_, index) => ({
    profileId: `a${index}`,
    start: WINDOW_START,
    end: WINDOW_END,
  }));
}

function profileIdsFor(available: number): string[] {
  return Array.from({ length: available }, (_, index) => `a${index}`);
}

/**
 * The four criteria as independent conditions. Not a transcription of the
 * implementation's comparison chain: each entry is its own predicate over
 * `available` and the pair, and the assertions check that exactly one holds and
 * that it is the one the reported status names.
 */
function criteriaMatches(
  available: number,
  threshold: Threshold | null,
): Record<CoverageStatus, boolean> {
  if (threshold === null) {
    // Criterion 4: an unconfigured slot is Healthy, never Critical.
    return { critical: false, at_minimum: false, warning: false, healthy: true };
  }

  const { minimumStaff, warningThreshold } = threshold;
  return {
    critical: available < minimumStaff, // 6.9
    at_minimum: available === minimumStaff, // 6.10
    warning: available > minimumStaff && available <= warningThreshold, // 6.11
    healthy: available > minimumStaff && available > warningThreshold, // 6.12
  };
}

describe('PBT-10: Coverage status classification and severity monotonicity', () => {
  it('assigns the Requirement 6 status for every headcount and threshold, reports an unconfigured slot as healthy with no required figure, and never improves as staffing falls', () => {
    const statusesSeen = new Set<CoverageStatus>();
    let unconfiguredCases = 0;
    let degenerateCases = 0;
    let strictWorsenings = 0;

    fc.assert(
      fc.property(
        availableStaffArb,
        availableStaffArb,
        thresholdArb,
        (staffingA, staffingB, threshold) => {
          const lower = Math.min(staffingA, staffingB);
          const higher = Math.max(staffingA, staffingB);

          if (threshold === null) unconfiguredCases += 1;
          else if (threshold.warningThreshold < threshold.minimumStaff) degenerateCases += 1;

          for (const available of [lower, higher]) {
            const status = classifyCoverage(available, threshold);
            statusesSeen.add(status);

            // Exactly one criterion applies, and it names the reported status.
            const matches = criteriaMatches(available, threshold);
            expect(Object.values(matches).filter(Boolean)).toHaveLength(1);
            expect(matches[status]).toBe(true);

            // Criterion 13 and criterion 8.11: the figure the rule is applied to
            // is a headcount, and each Coverage_Interval is classified from its
            // own available count against the same thresholds.
            const intervals = buildCoverageIntervals(
              windowsFor(available),
              NOBODY_ABSENT,
              threshold,
            );

            if (available === 0) {
              expect(intervals).toEqual([]);
            } else {
              expect(intervals).toHaveLength(1);
              expect(intervals[0].availableStaff).toBe(available);
              expect(intervals[0].profileIds).toHaveLength(available);
              expect(intervals[0].status).toBe(status);
              expect(intervals[0].requiredStaff).toBe(threshold ? threshold.minimumStaff : null);
            }

            // The projected figure for the same headcount reaches the same
            // status through the same rule, and reports the required figure as
            // unconfigured when there is no pair (criterion 4).
            const projected = projectCoverage({
              workDate: WORK_DATE,
              scheduledProfileIds: profileIdsFor(available),
              approvedAbsenceProfileIds: [],
              proposedAbsenceProfileIds: [],
              threshold,
            });

            expect(projected.available).toBe(available);
            expect(projected.status).toBe(status);
            expect(projected.requiredStaff).toBe(threshold ? threshold.minimumStaff : null);

            if (threshold === null) {
              expect(status).toBe('healthy');
              expect(projected.requiredStaff).toBeNull();
              if (available > 0) expect(intervals[0].requiredStaff).toBeNull();
            }
          }

          // Decreasing available staffing never improves the severity.
          const severityLower = COVERAGE_SEVERITY[classifyCoverage(lower, threshold)];
          const severityHigher = COVERAGE_SEVERITY[classifyCoverage(higher, threshold)];
          expect(severityLower).toBeGreaterThanOrEqual(severityHigher);
          if (severityLower > severityHigher) strictWorsenings += 1;

          // One step down is enough to see it: the rule is a step function of
          // the headcount, so it cannot dip and recover.
          if (lower > 0) {
            expect(COVERAGE_SEVERITY[classifyCoverage(lower - 1, threshold)]).toBeGreaterThanOrEqual(
              severityLower,
            );
          }
        },
      ),
      { numRuns: 200 },
    );

    // Guard against a vacuous pass. Every outcome of the matrix has to be
    // reached, both threshold shapes have to be generated, and the ordering
    // claim has to have been tested somewhere it could fail rather than only
    // where both counts landed in the same band.
    expect([...statusesSeen].sort()).toEqual(['at_minimum', 'critical', 'healthy', 'warning']);
    expect(unconfiguredCases).toBeGreaterThan(0);
    expect(degenerateCases).toBeGreaterThan(0);
    expect(strictWorsenings).toBeGreaterThan(0);

    // The ordering the monotonicity claim is read against: worse news is a
    // higher number, and at_minimum is worse than warning because a department
    // sitting on its minimum has no slack left.
    expect(COVERAGE_SEVERITY.critical).toBeGreaterThan(COVERAGE_SEVERITY.at_minimum);
    expect(COVERAGE_SEVERITY.at_minimum).toBeGreaterThan(COVERAGE_SEVERITY.warning);
    expect(COVERAGE_SEVERITY.warning).toBeGreaterThan(COVERAGE_SEVERITY.healthy);
  });
});

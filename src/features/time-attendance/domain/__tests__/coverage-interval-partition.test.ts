// src/features/time-attendance/domain/__tests__/coverage-interval-partition.test.ts
// Property test for the Coverage_Interval partition of one date.
//
// ## What "the number of shifts active across that interval" is asserted against
//
// The property's prose says each interval's available count equals the number of
// shifts active across it. `buildCoverageIntervals` counts distinct employees,
// not shift rows, so those two figures agree only when every window carries a
// different employee — a split shift recorded as two overlapping rows is one
// person, and counting it twice would inflate the coverage figure a leave
// decision is taken against.
//
// Both readings are asserted rather than either being dropped. The distinct
// employee count is checked on every generated case, recomputed here from the
// windows themselves. The shift-row count is checked on the cases the generator
// built with a distinct employee per window, where it is the same claim. The
// generator draws both kinds, and the guards at the end require both to have
// occurred, so neither reading is left untested and the row-count reading is not
// quietly weakened into the employee-count one.
//
// The other invariants — sorted, pairwise non-overlapping, contiguous within
// each block of activity, covering exactly the union of the windows — are checked
// against a merge of the input windows computed independently of the module. The
// partition claim itself is checked as: every interval boundary is a window edge,
// and no window edge falls strictly inside an interval. That is what "partition
// the date at every distinct scheduled start and end instant" means, and it is
// what an implementation that dropped a boundary would fail.
//
// Absences get their own clause because the Approval_Impact_Preview compares a
// date before and after a proposed absence interval for interval: an absent
// employee still contributes boundaries, so the split points do not move and
// every interval of the absent run is an interval of the present run with a lower
// count.
//
// Feature: time-attendance-ui-redesign, Property 14: Coverage interval partition
// **Validates: Requirements 8.9, 8.10, 9.4, 9.5**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildCoverageIntervals, classifyCoverage, type CoverageInterval } from '../coverage';
import { shiftWindowCaseArb, type GeneratedShiftWindow } from './arbitraries';

interface Range {
  startMs: number;
  endMs: number;
}

/** Overlapping and touching ranges merged into maximal blocks, ascending. */
function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges]
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function intervalRanges(intervals: readonly CoverageInterval[]): Range[] {
  return intervals.map((interval) => ({
    startMs: Date.parse(interval.start),
    endMs: Date.parse(interval.end),
  }));
}

function windowRanges(windows: readonly GeneratedShiftWindow[]): Range[] {
  return windows.map((window) => ({
    startMs: window.start.getTime(),
    endMs: window.end.getTime(),
  }));
}

/** The start and end pairs of an interval set, which is where the date was split. */
function boundaryPairs(intervals: readonly CoverageInterval[]): string[] {
  return intervals.map((interval) => `${interval.start}/${interval.end}`);
}

describe('PBT-14: Coverage interval partition', () => {
  it('returns a sorted, non-overlapping interval set split at every window edge, covering exactly the union of the windows, each interval counting the employees active across it', () => {
    let multiIntervalCases = 0;
    let gapCases = 0;
    let nestedCases = 0;
    let identicalCases = 0;
    let repeatedProfileCases = 0;
    let distinctProfileCases = 0;
    let absenceDroppedIntervals = 0;
    let degenerateWindowCases = 0;
    let sharedIntervals = 0;

    fc.assert(
      fc.property(shiftWindowCaseArb, (day) => {
        const { windows, absentProfileIds, threshold } = day;
        const intervals = buildCoverageIntervals(windows, absentProfileIds, threshold);

        // Windows covering no time are ignored entirely, boundaries included:
        // they can neither staff an interval nor bound one.
        const real = windows.filter((window) => window.end.getTime() > window.start.getTime());
        const active = real.filter((window) => !absentProfileIds.has(window.profileId));
        if (real.length !== windows.length) degenerateWindowCases += 1;
        if (windows.length !== new Set(windows.map((w) => w.profileId)).size) {
          repeatedProfileCases += 1;
        }
        if (day.distinctProfiles) distinctProfileCases += 1;

        const edges = new Set(
          real.flatMap((window) => [window.start.getTime(), window.end.getTime()]),
        );

        let previousEndMs = Number.NEGATIVE_INFINITY;
        for (const interval of intervals) {
          const startMs = Date.parse(interval.start);
          const endMs = Date.parse(interval.end);

          // Half-open and non-empty, sorted, and never overlapping its predecessor.
          expect(endMs).toBeGreaterThan(startMs);
          expect(startMs).toBeGreaterThanOrEqual(previousEndMs);

          // Criterion 8.9: the date is split at window edges and nowhere else, and
          // no edge falls strictly inside an interval.
          expect(edges.has(startMs)).toBe(true);
          expect(edges.has(endMs)).toBe(true);
          for (const edge of edges) {
            expect(edge > startMs && edge < endMs).toBe(false);
          }

          // Contiguous within each block of activity: a gap is only ever a
          // stretch no active window covers.
          if (previousEndMs !== Number.NEGATIVE_INFINITY && startMs > previousEndMs) {
            gapCases += 1;
            const gapStart = previousEndMs;
            for (const window of active) {
              expect(window.start.getTime() < startMs && window.end.getTime() > gapStart).toBe(
                false,
              );
            }
          }
          previousEndMs = endMs;

          // The employees active across the whole interval, recomputed here.
          const spanning = active.filter(
            (window) => window.start.getTime() <= startMs && window.end.getTime() >= endMs,
          );
          const employees = [...new Set(spanning.map((window) => window.profileId))].sort();

          expect(interval.profileIds).toEqual(employees);
          expect(interval.availableStaff).toBe(employees.length);
          expect(interval.availableStaff).toBeGreaterThan(0);
          if (interval.availableStaff > 1) sharedIntervals += 1;

          // With a distinct employee per window, the headcount is also the number
          // of shift rows spanning the interval.
          if (day.distinctProfiles) {
            expect(interval.availableStaff).toBe(spanning.length);
          }

          // Nobody absent is ever counted, whatever their schedule says.
          for (const profileId of interval.profileIds) {
            expect(absentProfileIds.has(profileId)).toBe(false);
          }

          // Criteria 8.10 and 8.11: available and required staffing per interval,
          // with the status the Requirement 6 rule assigns to that headcount.
          expect(interval.requiredStaff).toBe(threshold ? threshold.minimumStaff : null);
          expect(interval.status).toBe(classifyCoverage(interval.availableStaff, threshold));
        }

        if (intervals.length > 1) multiIntervalCases += 1;

        // The output covers exactly the union of the windows that staff the date.
        expect(mergeRanges(intervalRanges(intervals))).toEqual(mergeRanges(windowRanges(active)));

        // Nested and identical windows, the shapes the partition has to survive.
        for (let i = 0; i < real.length; i += 1) {
          for (let j = 0; j < real.length; j += 1) {
            if (i === j) continue;
            const outer = real[i];
            const inner = real[j];
            if (
              outer.start.getTime() < inner.start.getTime() &&
              inner.end.getTime() < outer.end.getTime()
            ) {
              nestedCases += 1;
            }
            if (
              i < j &&
              outer.start.getTime() === inner.start.getTime() &&
              outer.end.getTime() === inner.end.getTime()
            ) {
              identicalCases += 1;
            }
          }
        }

        // Marking employees absent changes counts without moving the split
        // points, which is what lets the Approval_Impact_Preview compare a date
        // before and after a proposed absence interval for interval.
        const present = buildCoverageIntervals(windows, new Set<string>(), threshold);
        const presentByPair = new Map(
          present.map((interval) => [`${interval.start}/${interval.end}`, interval]),
        );
        for (const interval of intervals) {
          const match = presentByPair.get(`${interval.start}/${interval.end}`);
          expect(match).toBeDefined();
          expect(interval.availableStaff).toBeLessThanOrEqual(match?.availableStaff ?? -1);
        }
        if (absentProfileIds.size > 0 && present.length > intervals.length) {
          absenceDroppedIntervals += 1;
        }
        expect(boundaryPairs(intervals).every((pair) => boundaryPairs(present).includes(pair))).toBe(
          true,
        );
      }),
      { numRuns: 200 },
    );

    // Guard against a vacuous pass. Every window shape the property names has to
    // have been generated, both employee readings have to have been exercised,
    // and the interval set has to have been more than one interval wide with more
    // than one employee in it somewhere.
    expect(multiIntervalCases).toBeGreaterThan(0);
    expect(gapCases).toBeGreaterThan(0);
    expect(nestedCases).toBeGreaterThan(0);
    expect(identicalCases).toBeGreaterThan(0);
    expect(repeatedProfileCases).toBeGreaterThan(0);
    expect(distinctProfileCases).toBeGreaterThan(0);
    expect(absenceDroppedIntervals).toBeGreaterThan(0);
    expect(degenerateWindowCases).toBeGreaterThan(0);
    expect(sharedIntervals).toBeGreaterThan(0);
  });
});

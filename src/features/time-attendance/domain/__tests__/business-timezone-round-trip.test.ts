// src/features/time-attendance/domain/__tests__/business-timezone-round-trip.test.ts
// Property test for the wall clock -> instant conversion in `domain/work-date.ts`.
//
// `employee_schedules.shift_start` and `shift_end` are wall-clock times in the
// business timezone (Requirement 3.7), so a schedule row only becomes an instant
// through `zonedToInstant`. This test converts a generated wall clock and reads
// it back with `wallClockOf`, over a four-year range that contains four
// spring-forward and four fall-back transitions.
//
// The two daylight-saving edges are generated deliberately rather than hoped
// for: one arbitrary draws wall clocks uniformly from inside a spring-forward
// gap, where the requested time never happens, and the transition-date cluster
// covers the fall-back hour that happens twice. Transition instants come from
// the published fixture in `arbitraries.ts`, not from `work-date.ts`.
//
// Feature: time-attendance-ui-redesign, Property 7: Business-timezone schedule round trip
// **Validates: Requirements 3.7**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { wallClockOf, zonedToInstant } from '../work-date';
import {
  BUSINESS_TIMEZONE,
  EASTERN_DST_WINDOWS,
  workDateArb,
  zoneOffsetMinutes,
} from './arbitraries';

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

/** A daylight-saving transition, described in local wall-clock terms. */
interface Transition {
  /** UTC instant at which the offset changes. */
  transitionMs: number;
  /** Local calendar date the transition falls on. */
  date: string;
  /** Wall clock the outgoing offset would read at `transitionMs`. */
  before: string;
  /** Wall clock the incoming offset reads at `transitionMs`. */
  after: string;
  /** `before` and `after` as epoch values read as though they were UTC. */
  beforeMs: number;
  afterMs: number;
}

function isoDate(msAsIfUtc: number): string {
  return new Date(msAsIfUtc).toISOString().slice(0, 10);
}

function isoTime(msAsIfUtc: number): string {
  return new Date(msAsIfUtc).toISOString().slice(11, 19);
}

/**
 * Describes the transition at `transitionMs` by applying the offset in force on
 * each side of it. For spring forward the interval `[before, after)` is the gap:
 * one hour of wall clock that no instant carries. For fall back `after` is
 * earlier than `before`, and that hour is the one that happens twice.
 */
function transitionAt(transitionMs: number): Transition {
  const beforeMs =
    transitionMs + zoneOffsetMinutes(transitionMs - 1, BUSINESS_TIMEZONE) * MINUTE_MS;
  const afterMs = transitionMs + zoneOffsetMinutes(transitionMs, BUSINESS_TIMEZONE) * MINUTE_MS;

  return {
    transitionMs,
    date: isoDate(beforeMs),
    before: isoTime(beforeMs),
    after: isoTime(afterMs),
    beforeMs,
    afterMs,
  };
}

const SPRING_FORWARD: readonly Transition[] = EASTERN_DST_WINDOWS.map((w) =>
  transitionAt(w.springForward),
);

const FALL_BACK: readonly Transition[] = EASTERN_DST_WINDOWS.map((w) => transitionAt(w.fallBack));

const TRANSITION_DATES: readonly string[] = [...SPRING_FORWARD, ...FALL_BACK].map((t) => t.date);

/**
 * The spring-forward gap a requested wall clock falls inside, or null. Times are
 * zero-padded `HH:MM:SS`, so lexical comparison is chronological comparison.
 */
function springForwardGap(date: string, time: string): Transition | null {
  return (
    SPRING_FORWARD.find((t) => t.date === date && time >= t.before && time < t.after) ?? null
  );
}

interface WallClock {
  date: string;
  time: string;
}

/** A wall clock inside a spring-forward gap: a time of day that never happens. */
const gapWallClockArb: fc.Arbitrary<WallClock> = fc
  .constantFrom(...SPRING_FORWARD)
  .chain((transition) => {
    const gapMs = transition.afterMs - transition.beforeMs;
    return fc
      .integer({ min: 0, max: gapMs / SECOND_MS - 1 })
      .map((offsetSeconds) => ({
        date: transition.date,
        time: isoTime(transition.beforeMs + offsetSeconds * SECOND_MS),
      }));
  });

/**
 * The small hours of a transition date, which is where both edges live: the
 * gap on a spring-forward date and the repeated hour on a fall-back date.
 */
const transitionDateWallClockArb: fc.Arbitrary<WallClock> = fc
  .tuple(
    fc.constantFrom(...TRANSITION_DATES),
    fc.integer({ min: 0, max: 4 }),
    fc.integer({ min: 0, max: 59 }),
    fc.constantFrom(0, 1, 30, 59),
  )
  .map(([date, hour, minute, second]) => ({ date, time: wallClock(hour, minute, second) }));

/** The ends of the day, where a mishandled offset shows up as a date rollover. */
const dayBoundaryWallClockArb: fc.Arbitrary<WallClock> = fc
  .tuple(
    workDateArb,
    fc.constantFrom('00:00:00', '00:00:01', '00:30:00', '12:00:00', '23:59:00', '23:59:59'),
  )
  .map(([date, time]) => ({ date, time }));

/** The uniform tail, so the clusters are not the whole input space. */
const uniformWallClockArb: fc.Arbitrary<WallClock> = fc
  .tuple(
    workDateArb,
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 }),
  )
  .map(([date, hour, minute, second]) => ({ date, time: wallClock(hour, minute, second) }));

function wallClock(hour: number, minute: number, second: number): string {
  return [hour, minute, second].map((v) => String(v).padStart(2, '0')).join(':');
}

const wallClockArb: fc.Arbitrary<WallClock> = fc.oneof(
  { weight: 2, arbitrary: gapWallClockArb },
  { weight: 3, arbitrary: transitionDateWallClockArb },
  { weight: 2, arbitrary: dayBoundaryWallClockArb },
  { weight: 3, arbitrary: uniformWallClockArb },
);

describe('PBT-7: Business-timezone schedule round trip', () => {
  it('recovers the requested wall clock, except inside the spring-forward gap', () => {
    let gapCases = 0;

    fc.assert(
      fc.property(wallClockArb, ({ date, time }) => {
        const instant = zonedToInstant(date, time, BUSINESS_TIMEZONE);
        const readBack = wallClockOf(instant, BUSINESS_TIMEZONE);
        const gap = springForwardGap(date, time);

        if (gap === null) {
          expect(readBack).toEqual({ date, time });
          return;
        }

        // The documented exception: no instant carries this wall clock, so the
        // conversion resolves to the first instant on the far side of the
        // transition, which reads as the wall clock the clocks jump to.
        gapCases += 1;
        expect(instant.getTime()).toBe(gap.transitionMs);
        expect(readBack).toEqual({ date: gap.date, time: gap.after });
      }),
      { numRuns: 200 },
    );

    // Guard against a vacuous pass: the exception clause is only tested if the
    // run actually produced wall clocks inside a gap.
    expect(gapCases).toBeGreaterThan(0);
  });
});

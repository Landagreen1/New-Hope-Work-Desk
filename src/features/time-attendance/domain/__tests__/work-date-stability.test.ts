// src/features/time-attendance/domain/__tests__/work-date-stability.test.ts
// Property test for the instant -> work date mapping in `domain/work-date.ts`.
//
// The two bucketing conventions this redesign replaces disagreed because one of
// them read the process timezone. So the test does not take the module's word
// for it: every generated instant is mapped under seven different
// `process.env.TZ` values, and the expected answer is computed from the local
// offset fixture in `arbitraries.ts` rather than from `work-date.ts` itself,
// which would be circular.
//
// Feature: time-attendance-ui-redesign, Property 6: Work-date stability across process timezones
// **Validates: Requirements 3.6, 19.9, 19.10**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { wallClockOf, workDateOf } from '../work-date';
import { instantArb, timeZoneArb, zoneOffsetMinutes } from './arbitraries';

const MINUTE_MS = 60_000;

/**
 * Process timezones to run each mapping under. Chosen to straddle the date line
 * in both directions from the deployed employee zones (UTC+14 and UTC-12), to
 * include a half-hour offset, and to include a zone that observes daylight
 * saving on a different schedule from Eastern.
 */
const PROCESS_TIMEZONES = [
  'UTC',
  'Etc/GMT+12',
  'Pacific/Kiritimati',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'America/Los_Angeles',
  'America/New_York',
] as const;

/** Runs `body` with the process timezone set, restoring it however `body` ends. */
function withProcessTimeZone(timeZone: string, body: () => void): void {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    body();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

/**
 * The calendar date an instant falls on in a zone, from the offset fixture in
 * `arbitraries.ts`. Shifting the instant by the zone offset and reading the
 * result as UTC gives the wall-clock date, which is what a work date is.
 */
function expectedWorkDate(epochMs: number, timeZone: string): string {
  const localMs = epochMs + zoneOffsetMinutes(epochMs, timeZone) * MINUTE_MS;
  return new Date(localMs).toISOString().slice(0, 10);
}

describe('PBT-6: Work-date stability across process timezones', () => {
  it('maps an instant to the calendar date in the employee zone, identically under every process timezone', () => {
    fc.assert(
      fc.property(instantArb, timeZoneArb, (instant, employeeTimeZone) => {
        const epochMs = instant.getTime();
        const expected = expectedWorkDate(epochMs, employeeTimeZone);

        const mappedDates = new Set<string>();
        const displayedDates = new Set<string>();
        const processOffsets = new Set<number>();

        for (const processTimeZone of PROCESS_TIMEZONES) {
          withProcessTimeZone(processTimeZone, () => {
            processOffsets.add(new Date(epochMs).getTimezoneOffset());
            mappedDates.add(workDateOf(instant, employeeTimeZone));
            // Requirement 19.9: the display conversion is the same conversion,
            // so it must report the same date as the work-date map.
            displayedDates.add(wallClockOf(instant, employeeTimeZone).date);
          });
        }

        // Guard against a vacuous pass: if the runtime ignored the assignments
        // above, every iteration would have run under one timezone and the
        // stability assertions would prove nothing.
        expect(processOffsets.size).toBeGreaterThan(1);

        // One element, and that element is the independently computed date.
        expect([...mappedDates]).toEqual([expected]);
        expect([...displayedDates]).toEqual([expected]);
      }),
      { numRuns: 200 },
    );
  });
});

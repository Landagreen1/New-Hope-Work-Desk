// src/features/time-attendance/domain/__tests__/coverage-ribbon-states.test.ts
// Property test for the Health_Ribbon: seven dates, one state each, in the order
// Requirement 18 states its criteria.
//
// The seven dates are checked twice over: against the window the generator
// computed by calendar index, and against a day-by-day difference in UTC. Neither
// is the arithmetic the ribbon uses, so a run that repeated a date across a
// daylight-saving transition or skipped one at a month boundary fails here.
//
// Precedence is checked two ways, because re-deriving the expected state from the
// same three conditions in the same order would pass against an implementation
// that had them in any order at all. So each date is checked against the ordered
// decision, and then the order itself is probed: adding a date to the closed set
// makes it Closed however bad its coverage is, and removing a date from the
// schedule set makes it No_Schedule while its coverage still says otherwise.
//
// Agreement is structural rather than recomputed. The ribbon is handed the
// coverage the service published and collapses the status carried on it, so the
// assertion is that the state equals the collapse of that entry's own status —
// not that it equals a status this test classified for itself. The same date read
// from a second, overlapping seven-day window has to come out the same, which is
// criterion 10 across screens.
//
// A ribbon date the coverage set does not cover is No_Schedule: the ribbon has
// nothing to collapse, and the generator leaves dates out of the coverage set on
// purpose so that branch is reached rather than assumed unreachable.
//
// Feature: time-attendance-ui-redesign, Property 15: Health ribbon totality, precedence, and agreement
// **Validates: Requirements 18.2, 18.3, 18.4, 18.5, 18.6, 18.10**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  RIBBON_DAYS,
  RIBBON_STATE_BY_COVERAGE,
  deriveRibbonStates,
  projectCoverage,
  type DateCoverage,
  type RibbonState,
} from '../coverage';
import { RIBBON_WINDOW_DAYS, ribbonCaseArb } from './arbitraries';

const DAY_MS = 86_400_000;

/** The five states Requirement 18, criterion 3 names, transcribed from it. */
const RIBBON_STATES = [
  'healthy',
  'warning',
  'critical',
  'closed',
  'no_schedule',
] as const satisfies readonly RibbonState[];

function midnightMs(workDate: string): number {
  return Date.parse(`${workDate}T00:00:00Z`);
}

describe('PBT-15: Health ribbon totality, precedence, and agreement', () => {
  it('yields seven consecutive dates with exactly one state each, closed ahead of no-schedule ahead of coverage, and the coverage state the service published for the date', () => {
    const statesSeen = new Set<RibbonState>();
    let closedOverCriticalCases = 0;
    let scheduledButUncoveredCases = 0;
    let duplicatedCoverageCases = 0;
    let sharedDatesCompared = 0;
    let coverageDerivedCells = 0;

    // The strip is seven cells wide by criterion 2, and the module says so.
    expect(RIBBON_DAYS).toBe(RIBBON_WINDOW_DAYS);

    fc.assert(
      fc.property(ribbonCaseArb, (ribbon) => {
        const coverage: DateCoverage[] = ribbon.projectionInputs.map((input) =>
          projectCoverage(input),
        );
        const dates = deriveRibbonStates(
          ribbon.startDate,
          ribbon.closedDates,
          ribbon.scheduledDates,
          coverage,
        );

        // Criterion 2: seven consecutive dates beginning at the start date.
        expect(dates).toHaveLength(RIBBON_WINDOW_DAYS);
        expect(dates[0].workDate).toBe(ribbon.startDate);
        expect(dates.map((date) => date.workDate)).toEqual(
          ribbon.dates.map((draw) => draw.workDate),
        );
        for (let i = 1; i < dates.length; i += 1) {
          expect(midnightMs(dates[i].workDate) - midnightMs(dates[i - 1].workDate)).toBe(DAY_MS);
        }

        // The first entry for a date wins, so the result cannot depend on how many
        // times the service happened to return it.
        const firstEntry = new Map<string, DateCoverage>();
        for (const entry of coverage) {
          if (!firstEntry.has(entry.workDate)) firstEntry.set(entry.workDate, entry);
        }

        dates.forEach((date, index) => {
          const draw = ribbon.dates[index];
          const closed = ribbon.closedDates.has(date.workDate);
          const scheduled = ribbon.scheduledDates.has(date.workDate);
          const entry = firstEntry.get(date.workDate) ?? null;

          // Criterion 3: exactly one state, drawn from the five-value set.
          expect(RIBBON_STATES).toContain(date.state);
          statesSeen.add(date.state);

          // The coverage behind the state is carried through for the drawer.
          expect(date.coverage).toBe(entry);

          // Criteria 4, 5, and 6 in order.
          if (closed) {
            expect(date.state).toBe('closed');
            if (entry !== null && entry.status === 'critical') closedOverCriticalCases += 1;
          } else if (!scheduled) {
            expect(date.state).toBe('no_schedule');
          } else if (entry === null) {
            expect(date.state).toBe('no_schedule');
            scheduledButUncoveredCases += 1;
          } else {
            // Criterion 6 and criterion 10: the state is the Coverage_Service
            // status for that date, collapsed for a strip with one indicator per
            // date. At_Minimum presents as Warning and Critical does not.
            expect(date.state).toBe(RIBBON_STATE_BY_COVERAGE[entry.status]);
            expect(date.coverage?.workDate).toBe(date.workDate);
            coverageDerivedCells += 1;
            if (entry.status === 'at_minimum') expect(date.state).toBe('warning');
            if (entry.status === 'critical') expect(date.state).toBe('critical');
          }

          if (draw.covered && draw.duplicated) duplicatedCoverageCases += 1;

          // Precedence, probed rather than re-derived. Closing the date makes it
          // Closed whatever its coverage says, and unscheduling an open date makes
          // it No_Schedule while the coverage entry is still there to be read.
          const closedToo = deriveRibbonStates(
            ribbon.startDate,
            new Set([...ribbon.closedDates, date.workDate]),
            ribbon.scheduledDates,
            coverage,
          );
          expect(closedToo[index].state).toBe('closed');
          expect(closedToo[index].coverage).toBe(entry);

          const withoutSchedule = deriveRibbonStates(
            ribbon.startDate,
            new Set([...ribbon.closedDates].filter((value) => value !== date.workDate)),
            new Set([...ribbon.scheduledDates].filter((value) => value !== date.workDate)),
            coverage,
          );
          expect(withoutSchedule[index].state).toBe('no_schedule');
        });

        // Criterion 10: a second window overlapping the first reads the same
        // state for every date the two share.
        const alternate = deriveRibbonStates(
          ribbon.alternateStartDate,
          ribbon.closedDates,
          ribbon.scheduledDates,
          coverage,
        );
        const stateByDate = new Map(dates.map((date) => [date.workDate, date.state]));
        for (const date of alternate) {
          const shared = stateByDate.get(date.workDate);
          if (shared === undefined) continue;
          sharedDatesCompared += 1;
          expect(date.state).toBe(shared);
          expect(date.coverage).toBe(firstEntry.get(date.workDate) ?? null);
        }
      }),
      { numRuns: 100 },
    );

    // Guard against a vacuous pass: every state has to have been assigned, the
    // precedence has to have been tested where it decides something, a scheduled
    // date has to have been left out of the coverage set, a date has to have
    // arrived twice, and the two windows have to have shared dates.
    expect([...statesSeen].sort()).toEqual([
      'closed',
      'critical',
      'healthy',
      'no_schedule',
      'warning',
    ]);
    expect(closedOverCriticalCases).toBeGreaterThan(0);
    expect(scheduledButUncoveredCases).toBeGreaterThan(0);
    expect(duplicatedCoverageCases).toBeGreaterThan(0);
    expect(sharedDatesCompared).toBeGreaterThan(0);
    expect(coverageDerivedCells).toBeGreaterThan(0);
  });
});

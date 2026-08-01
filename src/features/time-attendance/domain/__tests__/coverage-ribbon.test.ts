// src/features/time-attendance/domain/__tests__/coverage-ribbon.test.ts
// Example tests for the Health_Ribbon state derivation.
//
// Feature: time-attendance-ui-redesign, task 4.3
//
// One case per branch of the precedence: a closed date outranking its coverage,
// an open date with no published schedule, each of the four coverage statuses
// collapsed to its ribbon state, and the run of seven dates itself across a
// month boundary and a daylight-saving transition. The universal statements —
// totality, precedence, and agreement with the Coverage_Service — are covered by
// Property 15.
//
// The coverage entries are produced by `projectCoverage` rather than hand-built,
// so the statuses the ribbon reads are the ones the service actually publishes.
//
// Requirements: 18.2, 18.3, 18.4, 18.5, 18.6, 18.10

import { describe, expect, it } from 'vitest';
import {
  RIBBON_DAYS,
  RIBBON_STATE_BY_COVERAGE,
  deriveRibbonStates,
  projectCoverage,
  type CoverageStatus,
  type DateCoverage,
  type RibbonState,
} from '../coverage';
import type { Threshold } from '../types';

/** 2026-07-27 is a Monday, so the strip runs Monday to Sunday. */
const START_DATE = '2026-07-27';

const WEEK = [
  '2026-07-27',
  '2026-07-28',
  '2026-07-29',
  '2026-07-30',
  '2026-07-31',
  '2026-08-01',
  '2026-08-02',
];

const THRESHOLD: Threshold = { minimumStaff: 2, warningThreshold: 3 };

const NONE: ReadonlySet<string> = new Set<string>();

/** A roster of six, so every status in the matrix is reachable by absences. */
const ROSTER = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];

/**
 * Projected coverage for a date with `available` employees expected, classified
 * against `THRESHOLD`. Absences are what move the figure, which is the same path
 * the service takes.
 */
function coverageFor(workDate: string, available: number): DateCoverage {
  return projectCoverage({
    workDate,
    scheduledProfileIds: ROSTER,
    approvedAbsenceProfileIds: ROSTER.slice(0, ROSTER.length - available),
    proposedAbsenceProfileIds: [],
    threshold: THRESHOLD,
  });
}

/** Every date of the week scheduled and covered at `available` staff. */
function fullWeek(available: number): DateCoverage[] {
  return WEEK.map((workDate) => coverageFor(workDate, available));
}

function statesOf(dates: ReturnType<typeof deriveRibbonStates>): RibbonState[] {
  return dates.map((date) => date.state);
}

describe('deriveRibbonStates', () => {
  it('returns seven consecutive dates beginning at the start date', () => {
    const dates = deriveRibbonStates(START_DATE, NONE, new Set(WEEK), fullWeek(6));

    expect(dates).toHaveLength(RIBBON_DAYS);
    expect(dates.map((date) => date.workDate)).toEqual(WEEK);
  });

  it('crosses a month boundary and a daylight-saving transition one date at a time', () => {
    // 2026-11-01 is the New York fall-back date, so the run contains a 25-hour
    // day. Calendar arithmetic steps past it without repeating or skipping.
    const dates = deriveRibbonStates('2026-10-29', NONE, NONE, []);

    expect(dates.map((date) => date.workDate)).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  it('assigns exactly one state per date with no coverage supplied at all', () => {
    const dates = deriveRibbonStates(START_DATE, NONE, NONE, []);

    expect(dates).toHaveLength(RIBBON_DAYS);
    expect(statesOf(dates)).toEqual(Array(RIBBON_DAYS).fill('no_schedule'));
  });

  it('assigns closed to a date the organisation is not open', () => {
    const dates = deriveRibbonStates(
      START_DATE,
      new Set(['2026-07-29']),
      new Set(WEEK),
      fullWeek(6),
    );

    expect(statesOf(dates)).toEqual([
      'healthy',
      'healthy',
      'closed',
      'healthy',
      'healthy',
      'healthy',
      'healthy',
    ]);
  });

  it('reports a closed date as closed however bad its coverage is', () => {
    // The date is critically short and closed. Closed wins: the organisation is
    // not open, so the shortfall is not a staffing emergency.
    const critical = WEEK.map((workDate) => coverageFor(workDate, 0));
    const dates = deriveRibbonStates(START_DATE, new Set(WEEK), new Set(WEEK), critical);

    expect(critical.every((date) => date.status === 'critical')).toBe(true);
    expect(statesOf(dates)).toEqual(Array(RIBBON_DAYS).fill('closed'));
  });

  it('assigns no_schedule to an open date carrying no published schedule', () => {
    const scheduled = WEEK.filter((workDate) => workDate !== '2026-08-01');
    const dates = deriveRibbonStates(START_DATE, NONE, new Set(scheduled), fullWeek(6));

    expect(statesOf(dates)).toEqual([
      'healthy',
      'healthy',
      'healthy',
      'healthy',
      'healthy',
      'no_schedule',
      'healthy',
    ]);
  });

  it('assigns no_schedule to a scheduled date the coverage set does not cover', () => {
    const partial = fullWeek(6).filter((date) => date.workDate !== '2026-07-30');
    const dates = deriveRibbonStates(START_DATE, NONE, new Set(WEEK), partial);

    expect(dates[3]).toMatchObject({ workDate: '2026-07-30', state: 'no_schedule', coverage: null });
  });

  it('derives its three coverage states from the status the service published', () => {
    // Against a minimum of 2 and a warning threshold of 3: 4 available is
    // healthy, 3 warning, 2 at minimum, 1 critical.
    const expected: Array<[number, CoverageStatus, RibbonState]> = [
      [4, 'healthy', 'healthy'],
      [3, 'warning', 'warning'],
      [2, 'at_minimum', 'warning'],
      [1, 'critical', 'critical'],
    ];

    for (const [available, status, state] of expected) {
      const coverage = fullWeek(available);
      const dates = deriveRibbonStates(START_DATE, NONE, new Set(WEEK), coverage);

      expect(coverage.map((date) => date.status)).toEqual(Array(RIBBON_DAYS).fill(status));
      expect(statesOf(dates)).toEqual(Array(RIBBON_DAYS).fill(state));
    }
  });

  it('presents at_minimum as warning while carrying the uncollapsed status through', () => {
    const dates = deriveRibbonStates(START_DATE, NONE, new Set(WEEK), fullWeek(2));

    expect(dates[0].state).toBe('warning');
    expect(dates[0].coverage?.status).toBe('at_minimum');
    expect(RIBBON_STATE_BY_COVERAGE.at_minimum).toBe('warning');
  });

  it('reports an unconfigured date as healthy, matching the coverage figure', () => {
    const unconfigured = WEEK.map((workDate) =>
      projectCoverage({
        workDate,
        scheduledProfileIds: [],
        approvedAbsenceProfileIds: [],
        proposedAbsenceProfileIds: [],
        threshold: null,
      }),
    );
    const dates = deriveRibbonStates(START_DATE, NONE, new Set(WEEK), unconfigured);

    expect(statesOf(dates)).toEqual(Array(RIBBON_DAYS).fill('healthy'));
    expect(dates.every((date) => date.coverage?.requiredStaff === null)).toBe(true);
  });

  it('carries the coverage figures for each date it covers', () => {
    const dates = deriveRibbonStates(START_DATE, NONE, new Set(WEEK), fullWeek(4));

    expect(dates[0].coverage).toMatchObject({
      workDate: START_DATE,
      scheduled: 6,
      approvedAbsences: 2,
      available: 4,
      requiredStaff: 2,
      status: 'healthy',
    });
  });

  it('ignores coverage for dates outside the seven', () => {
    const outside = [coverageFor('2026-08-03', 0), coverageFor('2026-07-26', 0)];
    const dates = deriveRibbonStates(START_DATE, NONE, new Set(WEEK), [...fullWeek(6), ...outside]);

    expect(statesOf(dates)).toEqual(Array(RIBBON_DAYS).fill('healthy'));
  });

  it('does not depend on the order the coverage set arrives in', () => {
    const coverage = fullWeek(6);
    const shuffled = [...coverage].reverse();

    expect(deriveRibbonStates(START_DATE, NONE, new Set(WEEK), shuffled)).toEqual(
      deriveRibbonStates(START_DATE, NONE, new Set(WEEK), coverage),
    );
  });

  it('keeps the first entry when a date appears twice in the coverage set', () => {
    const first = coverageFor(START_DATE, 6);
    const second = coverageFor(START_DATE, 0);
    const dates = deriveRibbonStates(START_DATE, NONE, new Set(WEEK), [first, second]);

    expect(dates[0]).toMatchObject({ state: 'healthy', coverage: first });
  });

  it('reads the same state for a date whichever screen derives it', () => {
    // Three screens, three separately built coverage sets carrying the same
    // figures for the shared date. The state has to match, because the ribbon
    // reads the published status rather than classifying anything itself.
    const shared = '2026-07-30';
    const today = deriveRibbonStates(START_DATE, NONE, new Set(WEEK), fullWeek(2));
    const schedule = deriveRibbonStates(START_DATE, NONE, new Set(WEEK), fullWeek(2));
    const timeOff = deriveRibbonStates('2026-07-30', NONE, new Set(WEEK), fullWeek(2));

    const stateFor = (dates: ReturnType<typeof deriveRibbonStates>) =>
      dates.find((date) => date.workDate === shared)?.state;

    expect(stateFor(today)).toBe('warning');
    expect(stateFor(schedule)).toBe('warning');
    expect(stateFor(timeOff)).toBe('warning');
  });

  it('rejects a start date that is not a calendar date', () => {
    expect(() => deriveRibbonStates('2026-02-30', NONE, NONE, [])).toThrow(RangeError);
    expect(() => deriveRibbonStates('27-07-2026', NONE, NONE, [])).toThrow(RangeError);
  });
});

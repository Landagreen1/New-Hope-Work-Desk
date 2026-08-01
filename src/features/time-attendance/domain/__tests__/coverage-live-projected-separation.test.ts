// src/features/time-attendance/domain/__tests__/coverage-live-projected-separation.test.ts
// Property test for the separation of Live_Coverage from Projected_Coverage.
//
// Half of this guarantee is a type-level ban: `ProjectionInput` declares
// `sessions`, `breaks`, `records`, `derivedStatus` and the rest as `never`, so a
// projection cannot be handed clock data even through a variable, where excess
// property checking would not apply. That clause is one `@ts-expect-error` case
// below and it is deliberately not the whole property — a compile-time ban says
// nothing about what the function does with data that reaches it by another
// route.
//
// So the runtime half is asserted too, three ways. Clock data is generated and
// live coverage is derived from it, which moves the working, on-break, and
// approved-off headcounts; the projection for the same date, computed from the
// same roster and the same published schedules, does not move. Clock data
// smuggled past the compiler with a cast is ignored figure for figure. And the
// Coverage_Interval availability figures for the date are computed from the
// schedule windows, so no employee who is only clocked in appears in an interval
// and no employee on approved leave is counted in one.
//
// The clock world is varied by stripping the sessions from the same generated
// day rather than by drawing a second unrelated day, so the schedules, the
// roster, and the absences are held fixed and the clock data is the only thing
// that changes. The guard at the end requires that change to have moved live
// coverage somewhere, or the clause would be comparing two identical worlds.
//
// Feature: time-attendance-ui-redesign, Property 13: Live and projected separation
// **Validates: Requirements 8.7, 9.6, 19.4**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deriveRange } from '../attendance';
import {
  buildCoverageIntervals,
  liveCoverage,
  projectCoverage,
  type CoverageInterval,
  type DepartmentCoverage,
  type ProjectionInput,
  type ShiftWindow,
} from '../coverage';
import type { AttendanceInputs, DailyAttendanceRecord } from '../types';
import { liveCoverageCaseArb } from './arbitraries';

function shape(rows: readonly DepartmentCoverage[]): string {
  return JSON.stringify(rows);
}

/** Windows as the clock recorded them, which is what the intervals must ignore. */
function clockWindows(
  records: readonly DailyAttendanceRecord[],
  workDate: string,
  evaluatedAt: string,
): ShiftWindow[] {
  return records
    .filter((record) => record.workDate === workDate && record.firstClockIn !== null)
    .map((record) => ({
      profileId: record.profileId,
      start: new Date(record.firstClockIn as string),
      end: new Date(record.lastClockOut ?? evaluatedAt),
    }));
}

function intervalShape(intervals: readonly CoverageInterval[]): string {
  return JSON.stringify(intervals);
}

describe('PBT-13: Live and projected separation', () => {
  it('leaves Projected_Coverage and every Coverage_Interval availability figure unchanged by any clock entry', () => {
    let clockMovedLiveCoverage = 0;
    let unscheduledClockIns = 0;
    let clockIntervalsDiffered = 0;
    let intervalSets = 0;
    let liveAndProjectedDiffered = 0;

    // The type-level half of the guarantee, asserted once: there is no field on
    // `ProjectionInput` a session could occupy, and the ban survives being passed
    // through a variable, where excess property checking would not apply. It is
    // one clause of this property rather than the whole of it, which is why the
    // generated clauses below assert the runtime half as well.
    const withClockData = {
      workDate: '2026-07-28',
      scheduledProfileIds: ['p1', 'p2'],
      approvedAbsenceProfileIds: [],
      proposedAbsenceProfileIds: [],
      threshold: null,
      sessions: [{ id: 's1', clockIn: '2026-07-28T13:00:00.000Z', clockOut: null }],
    };

    // @ts-expect-error a projection input has nowhere to hold a clock session.
    expect(projectCoverage(withClockData).available).toBe(2);

    fc.assert(
      fc.property(liveCoverageCaseArb, (day) => {
        const withoutClockData: AttendanceInputs[] = day.inputs.map((input) => ({
          ...input,
          sessions: [],
        }));

        const clocked = deriveRange(day.inputs);
        const unclocked = deriveRange(withoutClockData);

        const live = (records: readonly DailyAttendanceRecord[]): DepartmentCoverage[] =>
          liveCoverage({
            workDate: day.workDate,
            records,
            roster: day.roster,
            thresholds: day.thresholds,
          });

        const liveWithClock = live(clocked);
        const liveWithoutClock = live(unclocked);
        if (shape(liveWithClock) !== shape(liveWithoutClock)) clockMovedLiveCoverage += 1;

        // The projection reads published schedules and approved absences, which
        // is everything `ProjectionInput` can hold (19.4).
        const projectionInput: ProjectionInput = {
          workDate: day.workDate,
          scheduledProfileIds: day.scheduledProfileIds,
          approvedAbsenceProfileIds: day.approvedAbsenceProfileIds,
          proposedAbsenceProfileIds: [],
          threshold: null,
          roster: day.roster,
          departmentThresholds: day.thresholds,
        };
        const projected = projectCoverage(projectionInput);

        expect(projected.scheduled).toBe(new Set(day.scheduledProfileIds).size);
        expect(projected.approvedAbsences).toBe(new Set(day.approvedAbsenceProfileIds).size);
        expect(projected.rawAvailable).toBe(projected.scheduled - projected.approvedAbsences);

        // Recomputed while the clock world differs: the same figures, to the
        // field. There is no state for a clock entry to have reached.
        expect(projectCoverage(projectionInput)).toStrictEqual(projected);

        // Clock data smuggled past the compiler with a cast is ignored.
        const smuggled = {
          ...projectionInput,
          sessions: day.inputs.flatMap((input) => input.sessions),
          breaks: day.inputs.flatMap((input) => input.sessions.flatMap((s) => s.breaks)),
          records: clocked,
          derivedStatus: 'working',
          hasOpenSession: true,
          workedHours: 8,
        } as unknown as ProjectionInput;
        expect(projectCoverage(smuggled)).toStrictEqual(projected);

        // Criterion 8.7: an employee who is clocked in without a published
        // schedule is not in the projection, however much they have worked.
        const clockedInIds = clocked
          .filter((record) => record.workDate === day.workDate && record.firstClockIn !== null)
          .map((record) => record.profileId);
        const scheduledIds = new Set(day.scheduledProfileIds);
        const onlyClockedIn = clockedInIds.filter((id) => !scheduledIds.has(id));
        unscheduledClockIns += onlyClockedIn.length;

        for (const profileId of onlyClockedIn) {
          expect(projected.scheduledProfileIds).not.toContain(profileId);
          for (const row of projected.departments) {
            expect(row.scheduledProfileIds).not.toContain(profileId);
          }
        }

        // Criterion 9.6: interval availability comes from the schedule windows
        // and the approved absences, not from the clock.
        const absent = new Set(day.approvedAbsenceProfileIds);
        const intervals = buildCoverageIntervals(day.scheduleWindows, absent, null);
        if (intervals.length > 0) intervalSets += 1;

        expect(intervalShape(buildCoverageIntervals(day.scheduleWindows, absent, null))).toBe(
          intervalShape(intervals),
        );

        for (const interval of intervals) {
          for (const profileId of interval.profileIds) {
            expect(scheduledIds.has(profileId)).toBe(true);
            expect(absent.has(profileId)).toBe(false);
            expect(onlyClockedIn).not.toContain(profileId);
          }
          expect(interval.availableStaff).toBe(interval.profileIds.length);
        }

        // Evidence the clause above is not comparing the clock to itself: the
        // same date partitioned from the clock entries is a different answer.
        const fromClock = buildCoverageIntervals(
          clockWindows(clocked, day.workDate, day.evaluatedAt),
          absent,
          null,
        );
        if (intervalShape(fromClock) !== intervalShape(intervals)) clockIntervalsDiffered += 1;

        const working = liveWithClock.reduce((total, row) => total + row.working, 0);
        if (working !== projected.available) liveAndProjectedDiffered += 1;
      }),
      { numRuns: 100 },
    );

    // Guard against a vacuous pass. The clock data has to have moved live
    // coverage, somebody has to have clocked in without a schedule, the
    // clock-derived partition has to have differed from the schedule-derived one,
    // and the two figures have to have disagreed somewhere — otherwise "unchanged
    // by any clock entry" would be a statement about inputs that never differed.
    expect(clockMovedLiveCoverage).toBeGreaterThan(0);
    expect(unscheduledClockIns).toBeGreaterThan(0);
    expect(clockIntervalsDiffered).toBeGreaterThan(0);
    expect(intervalSets).toBeGreaterThan(0);
    expect(liveAndProjectedDiffered).toBeGreaterThan(0);
  });
});

// src/features/time-attendance/domain/__tests__/coverage-headcount-partition.test.ts
// Property test for the Live_Coverage headcounts and the employee lists behind
// them.
//
// The records are derived through `deriveRange` rather than hand-built, so the
// statuses the headcounts read are the ones the Status Rule Matrix assigns. The
// expected figures are then recomputed from those records independently of the
// coverage module: filter by date, filter by department, count by status. A
// headcount that counted rows instead of employees, leaked yesterday's clock
// state, or counted an employee the roster does not place in a department fails
// against that recomputation.
//
// ## The missing headcount is a count, not a subtraction
//
// Requirement 6, criterion 8 defines the missing headcount as the count of
// employees scheduled on the date whose Derived_Status is none of Working,
// On_Break, and Approved_Time_Off. It is asserted here twice, in full: as that
// count, and as the length of the list the drawer shows behind it (criterion
// 14). Both clauses are needed — a figure that agreed with its own list while
// counting the wrong employees would satisfy one and fail the other.
//
// The subtraction `scheduled − working − onBreak − approvedOff` floored at zero
// is a different figure, and the generator reaches the inputs where it differs:
// Status Rule Matrix rules 3 and 4 assign On_Break and Working without requiring
// a published schedule, so an employee picking up an unscheduled day is counted
// as working while never counting as scheduled, and the subtraction floors to
// zero while a scheduled employee is genuinely absent and named in the list. The
// vacuity guard at the end of this test requires that case to have occurred, so
// the corrected definition is not merely satisfied — it is the one being tested.
//
// Feature: time-attendance-ui-redesign, Property 11: Live coverage headcount partition
// **Validates: Requirements 6.2, 6.5, 6.6, 6.7, 6.8, 6.14**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deriveRange } from '../attendance';
import { DEPARTMENT_ORDER, classifyCoverage, liveCoverage } from '../coverage';
import type { DailyAttendanceRecord, DerivedStatus } from '../types';
import type { Department } from '../../types';
import { liveCoverageCaseArb } from './arbitraries';

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

function idsWithStatus(
  records: readonly DailyAttendanceRecord[],
  status: DerivedStatus,
): string[] {
  return sortedIds(records.filter((r) => r.derivedStatus === status).map((r) => r.profileId));
}

function intersection(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return a.filter((id) => other.has(id));
}

describe('PBT-11: Live coverage headcount partition', () => {
  it('counts each status into its own headcount, keeps on-break out of working, and reports the missing headcount as both the count of unaccounted scheduled employees and the list behind it', () => {
    let workingRows = 0;
    let onBreakRows = 0;
    let approvedOffRows = 0;
    let missingRows = 0;
    let subtractionDisagreements = 0;
    let otherDateRecords = 0;
    let uncountedEmployees = 0;

    fc.assert(
      fc.property(liveCoverageCaseArb, (day) => {
        const records = deriveRange(day.inputs);
        const rows = liveCoverage({
          workDate: day.workDate,
          records,
          roster: day.roster,
          thresholds: day.thresholds,
        });

        const onDate = records.filter((record) => record.workDate === day.workDate);
        otherDateRecords += records.length - onDate.length;

        const departmentOf = (profileId: string): Department | null =>
          day.roster.get(profileId)?.department ?? null;

        // One row per department with somebody rostered or a configured pair,
        // in a stable order (criterion 2).
        const present = new Set<Department>();
        for (const subject of day.roster.values()) {
          if (subject.department !== null) present.add(subject.department);
        }
        for (const department of day.thresholds.keys()) present.add(department);

        expect(rows.map((row) => row.department)).toEqual(
          DEPARTMENT_ORDER.filter((department) => present.has(department)),
        );

        for (const row of rows) {
          const mine = onDate.filter((record) => departmentOf(record.profileId) === row.department);

          const working = idsWithStatus(mine, 'working');
          const onBreak = idsWithStatus(mine, 'on_break');
          const approvedOff = idsWithStatus(mine, 'approved_time_off');
          const scheduled = sortedIds(
            mine.filter((record) => record.scheduledStart !== null).map((r) => r.profileId),
          );

          // Criterion 8: the scheduled employees accounted for by none of the
          // three headcounts.
          const accountedFor = new Set([...working, ...onBreak, ...approvedOff]);
          const missing = scheduled.filter((id) => !accountedFor.has(id));

          expect(row.workDate).toBe(day.workDate);

          // Criteria 5, 6, and 2: each headcount is the count of records
          // carrying its status, and scheduled staffing is the count carrying a
          // scheduled start.
          expect(row.working).toBe(working.length);
          expect(row.onBreak).toBe(onBreak.length);
          expect(row.approvedOff).toBe(approvedOff.length);
          expect(row.scheduled).toBe(scheduled.length);

          // Criterion 14: the employees the drawer lists behind each headcount.
          expect(row.workingProfileIds).toEqual(working);
          expect(row.onBreakProfileIds).toEqual(onBreak);
          expect(row.approvedOffProfileIds).toEqual(approvedOff);
          expect(row.scheduledProfileIds).toEqual(scheduled);

          // Criterion 8, both clauses: the count of unaccounted scheduled
          // employees, and the length of the list shown behind the figure.
          expect(row.missing).toBe(missing.length);
          expect(row.missingProfileIds).toEqual(missing);
          expect(row.missing).toBe(row.missingProfileIds.length);

          // Criterion 7: on-break employees are excluded from the working
          // headcount, and from the figure the status is classified from.
          expect(intersection(row.workingProfileIds, row.onBreakProfileIds)).toEqual([]);
          expect(row.available).toBe(row.working);

          // The four status-derived lists are pairwise disjoint: a status feeds
          // at most one headcount, and missing is what none of them accounts for.
          const lists = [
            row.workingProfileIds,
            row.onBreakProfileIds,
            row.approvedOffProfileIds,
            row.missingProfileIds,
          ];
          for (let i = 0; i < lists.length; i += 1) {
            for (let j = i + 1; j < lists.length; j += 1) {
              expect(intersection(lists[i], lists[j])).toEqual([]);
            }
          }

          // The scheduled set partitions into the employees accounted for and
          // the employees missing, which is why the figure cannot go negative.
          const scheduledAccountedFor = row.scheduledProfileIds.filter((id) =>
            accountedFor.has(id),
          );
          expect(scheduledAccountedFor.length + row.missing).toBe(row.scheduled);
          expect(row.missingProfileIds.every((id) => row.scheduledProfileIds.includes(id))).toBe(
            true,
          );

          for (const figure of [
            row.scheduled,
            row.working,
            row.onBreak,
            row.approvedOff,
            row.missing,
            row.available,
          ]) {
            expect(figure).toBeGreaterThanOrEqual(0);
          }

          const threshold = day.thresholds.get(row.department) ?? null;
          expect(row.requiredStaff).toBe(threshold ? threshold.minimumStaff : null);
          expect(row.status).toBe(classifyCoverage(row.available, threshold));

          const subtraction = Math.max(
            0,
            row.scheduled - row.working - row.onBreak - row.approvedOff,
          );
          if (subtraction !== row.missing) subtractionDisagreements += 1;

          if (row.working > 0) workingRows += 1;
          if (row.onBreak > 0) onBreakRows += 1;
          if (row.approvedOff > 0) approvedOffRows += 1;
          if (row.missing > 0) missingRows += 1;
        }

        // Nobody the roster does not place in a department is counted anywhere,
        // and no employee is counted from a record belonging to another date.
        const counted = new Set(
          rows.flatMap((row) => [
            ...row.scheduledProfileIds,
            ...row.workingProfileIds,
            ...row.onBreakProfileIds,
            ...row.approvedOffProfileIds,
            ...row.missingProfileIds,
          ]),
        );
        for (const profileId of counted) {
          expect(departmentOf(profileId)).not.toBeNull();
          expect(onDate.some((record) => record.profileId === profileId)).toBe(true);
        }
        uncountedEmployees += [...day.roster.keys()].filter((id) => !counted.has(id)).length;

        // Each employee is counted once, so a record set handed over twice —
        // the shape a range read can produce — reports the same figures.
        expect(
          liveCoverage({
            workDate: day.workDate,
            records: [...records, ...records],
            roster: day.roster,
            thresholds: day.thresholds,
          }),
        ).toStrictEqual(rows);
      }),
      { numRuns: 100 },
    );

    // Guard against a vacuous pass. Every headcount has to have been non-zero
    // somewhere, a record from another date has to have been offered and
    // ignored, and an employee the roster does not place in a department has to
    // have been left out.
    expect(workingRows).toBeGreaterThan(0);
    expect(onBreakRows).toBeGreaterThan(0);
    expect(approvedOffRows).toBeGreaterThan(0);
    expect(missingRows).toBeGreaterThan(0);
    expect(otherDateRecords).toBeGreaterThan(0);
    expect(uncountedEmployees).toBeGreaterThan(0);

    // The corrected definition of criterion 8 is the one under test: the
    // subtraction it replaced has to have disagreed with it somewhere, or this
    // property would pass against either definition.
    expect(subtractionDisagreements).toBeGreaterThan(0);
  });
});

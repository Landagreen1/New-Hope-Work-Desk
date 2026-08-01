// src/features/time-attendance/domain/__tests__/coverage-projection-identity.test.ts
// Property test for Projected_Coverage: the identity, the cost of one absence,
// and the department partition.
//
// Three readings of the same expression. `scheduled − approvedAbsences −
// proposedAbsences` is asserted against the distinct employee counts rather than
// the list lengths, because a split shift recorded as two schedule rows must not
// inflate the figure. The reported figure is floored at zero and the unfloored
// arithmetic is retained, so the monotonicity clauses are asserted on both: an
// absence always costs exactly one on `rawAvailable`, and costs one on
// `available` until the floor absorbs it.
//
// The absence added by the monotonicity clause is an employee named in none of
// the three lists. Adding one already named would change nothing, because the
// lists are counted as sets — so quantifying over "adding one approved absence"
// means adding a new one, which is what the generator's spare employee is for.
//
// The department clause is conditional and the generator draws both sides: the
// per-department figures sum to the organisation figure when every employee
// named is rostered with a department, and are a subset of it when some employee
// is off the roster or carries none. The summed `available` figures are compared
// against the raw arithmetic, because a department whose absences outnumber its
// schedules has had its excess absorbed by its own floor and cannot be summed
// back.
//
// Requirement 9, criterion 1 is the same expression applied to every date of a
// requested range, so the last clause projects the whole range with the proposed
// absence included and checks the identity per date.
//
// Feature: time-attendance-ui-redesign, Property 12: Projection identity, monotonicity, and department partition
// **Validates: Requirements 8.6, 8.8, 9.1, 9.2**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { COVERAGE_SEVERITY, classifyCoverage, projectCoverage } from '../coverage';
import type { ProjectionInput } from '../coverage';
import type { RecordSubjectIndex } from '../attendance';
import type { Department } from '../../types';
import { dateRangeArb, projectionCaseArb, type ProjectionCase } from './arbitraries';

const DAY_MS = 86_400_000;

/**
 * The calendar dates of an inclusive range, stepped in UTC.
 *
 * Local to this test on purpose: `domain/work-date.ts` is the module Properties
 * 6 and 7 test, and the range clause here should not be checked against the
 * arithmetic it would otherwise be sharing.
 */
function datesOf(range: { start: string; end: string }): string[] {
  const dates: string[] = [];
  const endMs = Date.parse(`${range.end}T00:00:00Z`);
  for (let ms = Date.parse(`${range.start}T00:00:00Z`); ms <= endMs; ms += DAY_MS) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

function inputFor(day: ProjectionCase, overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    workDate: day.workDate,
    scheduledProfileIds: day.scheduledProfileIds,
    approvedAbsenceProfileIds: day.approvedAbsenceProfileIds,
    proposedAbsenceProfileIds: day.proposedAbsenceProfileIds,
    threshold: day.threshold,
    roster: day.roster,
    departmentThresholds: day.departmentThresholds,
    ...overrides,
  };
}

function distinctCount(ids: readonly string[]): number {
  return new Set(ids).size;
}

/** The distinct members of `ids` the roster maps to `department`, sorted. */
function inDepartment(
  ids: readonly string[],
  department: Department,
  roster: RecordSubjectIndex,
): string[] {
  return [...new Set(ids)]
    .filter((id) => roster.get(id)?.department === department)
    .sort();
}

describe('PBT-12: Projection identity, monotonicity, and department partition', () => {
  it('projects scheduled minus approved minus proposed, costs exactly one per added absence, never falls when one is removed, and sums back across departments that partition the roster', () => {
    let flooredCases = 0;
    let partitionedCases = 0;
    let unpartitionedCases = 0;
    let removalCases = 0;
    let repeatedScheduleCases = 0;
    let departmentRows = 0;

    fc.assert(
      fc.property(projectionCaseArb, dateRangeArb, (day, range) => {
        const input = inputFor(day);
        const projected = projectCoverage(input);

        // The identity, over distinct employees rather than rows (8.6, 9.2).
        expect(projected.workDate).toBe(day.workDate);
        expect(projected.scheduled).toBe(distinctCount(day.scheduledProfileIds));
        expect(projected.approvedAbsences).toBe(distinctCount(day.approvedAbsenceProfileIds));
        expect(projected.proposedAbsences).toBe(distinctCount(day.proposedAbsenceProfileIds));
        expect(projected.rawAvailable).toBe(
          projected.scheduled - projected.approvedAbsences - projected.proposedAbsences,
        );
        expect(projected.available).toBe(Math.max(0, projected.rawAvailable));
        expect(projected.requiredStaff).toBe(day.threshold ? day.threshold.minimumStaff : null);
        expect(projected.status).toBe(classifyCoverage(projected.available, day.threshold));

        if (projected.rawAvailable < 0) flooredCases += 1;
        if (day.scheduledProfileIds.length > distinctCount(day.scheduledProfileIds)) {
          repeatedScheduleCases += 1;
        }

        // Adding one approved absence costs exactly one, and never improves the
        // status (9.1, 9.2).
        const withApproved = projectCoverage(
          inputFor(day, {
            approvedAbsenceProfileIds: [...day.approvedAbsenceProfileIds, day.spare.profileId],
          }),
        );
        expect(withApproved.approvedAbsences).toBe(projected.approvedAbsences + 1);
        expect(withApproved.rawAvailable).toBe(projected.rawAvailable - 1);
        expect(withApproved.available).toBe(Math.max(0, projected.rawAvailable - 1));
        expect(COVERAGE_SEVERITY[withApproved.status]).toBeGreaterThanOrEqual(
          COVERAGE_SEVERITY[projected.status],
        );

        // A proposed absence costs the same one, which is the arithmetic the
        // Approval_Impact_Preview shows before the decision (9.2).
        const withProposed = projectCoverage(
          inputFor(day, {
            proposedAbsenceProfileIds: [...day.proposedAbsenceProfileIds, day.spare.profileId],
          }),
        );
        expect(withProposed.proposedAbsences).toBe(projected.proposedAbsences + 1);
        expect(withProposed.rawAvailable).toBe(projected.rawAvailable - 1);
        expect(withProposed.available).toBe(withApproved.available);

        // Removing one approved absence never decreases the projection, and
        // gives back exactly the one it cost.
        if (projected.approvedAbsences > 0) {
          removalCases += 1;
          const [removed] = [...new Set(day.approvedAbsenceProfileIds)].sort();
          const withoutOne = projectCoverage(
            inputFor(day, {
              approvedAbsenceProfileIds: day.approvedAbsenceProfileIds.filter(
                (id) => id !== removed,
              ),
            }),
          );
          expect(withoutOne.approvedAbsences).toBe(projected.approvedAbsences - 1);
          expect(withoutOne.rawAvailable).toBe(projected.rawAvailable + 1);
          expect(withoutOne.available).toBeGreaterThanOrEqual(projected.available);
        }

        // Every department row is the same expression restricted to the
        // department roster (8.8).
        for (const row of projected.departments) {
          departmentRows += 1;
          const scheduled = inDepartment(day.scheduledProfileIds, row.department, day.roster);
          const approved = inDepartment(
            day.approvedAbsenceProfileIds,
            row.department,
            day.roster,
          );
          const proposed = inDepartment(
            day.proposedAbsenceProfileIds,
            row.department,
            day.roster,
          );
          const threshold = day.departmentThresholds.get(row.department) ?? null;

          expect(row.scheduledProfileIds).toEqual(scheduled);
          expect(row.approvedAbsenceProfileIds).toEqual(approved);
          expect(row.proposedAbsenceProfileIds).toEqual(proposed);
          expect(row.scheduled).toBe(scheduled.length);
          expect(row.approvedAbsences).toBe(approved.length);
          expect(row.proposedAbsences).toBe(proposed.length);
          expect(row.rawAvailable).toBe(
            row.scheduled - row.approvedAbsences - row.proposedAbsences,
          );
          expect(row.available).toBe(Math.max(0, row.rawAvailable));
          expect(row.requiredStaff).toBe(threshold ? threshold.minimumStaff : null);
          expect(row.status).toBe(classifyCoverage(row.available, threshold));
        }

        const sum = (pick: (row: (typeof projected.departments)[number]) => number): number =>
          projected.departments.reduce((total, row) => total + pick(row), 0);

        if (day.partitionsRoster) {
          partitionedCases += 1;
          expect(sum((row) => row.scheduled)).toBe(projected.scheduled);
          expect(sum((row) => row.approvedAbsences)).toBe(projected.approvedAbsences);
          expect(sum((row) => row.proposedAbsences)).toBe(projected.proposedAbsences);
          expect(sum((row) => row.rawAvailable)).toBe(projected.rawAvailable);

          // The floored figures sum back too, unless some department's own floor
          // absorbed its excess absences.
          if (projected.departments.every((row) => row.rawAvailable >= 0)) {
            expect(sum((row) => row.available)).toBe(projected.available);
          } else {
            expect(sum((row) => row.available)).toBeGreaterThanOrEqual(projected.available);
          }
        } else {
          unpartitionedCases += 1;
          // An employee off the roster, or carrying no department, belongs to no
          // row: the department figures are a subset of the organisation figures.
          expect(sum((row) => row.scheduled)).toBeLessThanOrEqual(projected.scheduled);
          expect(sum((row) => row.approvedAbsences)).toBeLessThanOrEqual(
            projected.approvedAbsences,
          );
          expect(sum((row) => row.proposedAbsences)).toBeLessThanOrEqual(
            projected.proposedAbsences,
          );
        }

        // Requirement 9, criterion 1: every date of the requested range is
        // projected with the requested absence included as a proposed absence,
        // and the figure depends on the lists rather than on the date.
        for (const workDate of datesOf(range)) {
          const perDate = projectCoverage(
            inputFor(day, {
              workDate,
              proposedAbsenceProfileIds: [...day.proposedAbsenceProfileIds, day.spare.profileId],
            }),
          );
          expect(perDate.workDate).toBe(workDate);
          expect(perDate.rawAvailable).toBe(
            perDate.scheduled - perDate.approvedAbsences - perDate.proposedAbsences,
          );
          expect(perDate.available).toBe(withProposed.available);
          expect(perDate.status).toBe(withProposed.status);
        }
      }),
      { numRuns: 100 },
    );

    // Guard against a vacuous pass: the floor, both sides of the partition
    // condition, a removal, a repeated schedule row, and at least one department
    // row all have to have occurred.
    expect(flooredCases).toBeGreaterThan(0);
    expect(partitionedCases).toBeGreaterThan(0);
    expect(unpartitionedCases).toBeGreaterThan(0);
    expect(removalCases).toBeGreaterThan(0);
    expect(repeatedScheduleCases).toBeGreaterThan(0);
    expect(departmentRows).toBeGreaterThan(0);
  });
});

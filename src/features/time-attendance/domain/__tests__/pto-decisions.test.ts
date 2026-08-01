// src/features/time-attendance/domain/__tests__/pto-decisions.test.ts
// Example tests for the decision vocabulary and the below-minimum approval guard
// in `domain/pto.ts`: the eight options, the status each one stores, which of
// them move a balance, and when a shortfall blocks an approval.
//
// Feature: time-attendance-ui-redesign, task 11.2
//
// The coverage inputs are built by calling `projectCoverage` and
// `buildCoverageIntervals` rather than by writing `DateCoverage` and
// `CoverageInterval` objects by hand. The guard reads the Coverage_Status those
// functions assign, so hand-written fixtures could carry a status the coverage
// rule would never produce and the tests would stop saying anything about the
// real pairing.
//
// 2026-07-27 is a Monday, so 2026-07-29 is the Wednesday of that week and
// 2026-07-31 the Friday. Instants are written in UTC because the guard compares
// statuses rather than wall-clock times; zone handling is `work-date.ts`'s
// business and is tested there.
//
// Requirements: 10.1, 10.2, 10.4, 10.5, 10.6, 10.7, 10.9, 10.10

import { describe, expect, it } from 'vitest';
import {
  buildCoverageIntervals,
  projectCoverage,
  type CoverageInterval,
  type DateCoverage,
  type ShiftWindow,
} from '../coverage';
import {
  DECISION_OPTIONS,
  DECISION_RULES,
  approvedRangesForDecision,
  collectShortfalls,
  countWorkingDays,
  decisionApproves,
  decisionBalanceDeltas,
  decisionRule,
  evaluateApprovalGuard,
  reasonWithContent,
  statusForDecision,
  type CoverageShortfall,
  type DecisionOption,
} from '../pto';
import type { PTOStatus } from '../../types';
import type { DateRange, Threshold } from '../types';

const MONDAY = '2026-07-27';
const WEDNESDAY = '2026-07-29';
const FRIDAY = '2026-07-31';

/** The Monday and Friday either side of 31 December 2025. */
const STRADDLE: DateRange = { from: '2025-12-29', to: '2026-01-02' };

const NOTHING_CLOSED: ReadonlySet<string> = new Set<string>();
const NOBODY_ABSENT: ReadonlySet<string> = new Set<string>();

/** Two required, warning collapsed to nothing, so three people read Healthy. */
const NEEDS_TWO: Threshold = { minimumStaff: 2, warningThreshold: 2 };

const range = (from: string, to: string): DateRange => ({ from, to });

const requested = (from: string, to: string) => ({ requested: range(from, to) });

/** A date's projection, as the Coverage_Service produces it. */
function projected(options: {
  workDate?: string;
  scheduled: readonly string[];
  proposedAbsences?: readonly string[];
  approvedAbsences?: readonly string[];
  threshold: Threshold | null;
}): DateCoverage {
  return projectCoverage({
    workDate: options.workDate ?? WEDNESDAY,
    scheduledProfileIds: options.scheduled,
    approvedAbsenceProfileIds: options.approvedAbsences ?? [],
    proposedAbsenceProfileIds: options.proposedAbsences ?? [],
    threshold: options.threshold,
  });
}

const shift = (profileId: string, start: string, end: string): ShiftWindow => ({
  profileId,
  start: new Date(`${WEDNESDAY}T${start}:00Z`),
  end: new Date(`${WEDNESDAY}T${end}:00Z`),
});

/**
 * A day staffed by three people with a one-hour hole in the middle: A works
 * through, B leaves at noon, C arrives at one. Three people are scheduled, so
 * the date reads Healthy against a requirement of two while the 12:00–13:00
 * interval has one person in it.
 */
function dayWithMiddayHole(): CoverageInterval[] {
  return buildCoverageIntervals(
    [
      shift('a', '09:00', '17:00'),
      shift('b', '09:00', '12:00'),
      shift('c', '13:00', '17:00'),
    ],
    NOBODY_ABSENT,
    NEEDS_TWO,
  );
}

const shortfall = (overrides: Partial<CoverageShortfall> = {}): CoverageShortfall => ({
  workDate: WEDNESDAY,
  interval: null,
  availableStaff: 1,
  requiredStaff: 2,
  shortBy: 1,
  ...overrides,
});

const ONE_SHORTFALL: readonly CoverageShortfall[] = [shortfall()];

describe('DECISION_OPTIONS', () => {
  it('offers the eight options in the order Requirement 10.1 lists them', () => {
    expect(DECISION_OPTIONS).toEqual([
      'approve_full',
      'deny',
      'approve_partial',
      'suggest_dates',
      'assign_coverage',
      'approve_with_coverage',
      'waitlist',
      'request_info',
    ]);
  });

  it('carries a rule for every option and no rule for anything else', () => {
    expect(Object.keys(DECISION_RULES).sort()).toEqual([...DECISION_OPTIONS].sort());
  });
});

describe('statusForDecision', () => {
  it('maps the eight options onto the stored statuses', () => {
    const mapped = DECISION_OPTIONS.map((decision) => [
      decision,
      statusForDecision(decision, 'pending'),
    ]);

    expect(mapped).toEqual([
      ['approve_full', 'approved'],
      ['deny', 'denied'],
      ['approve_partial', 'partially_approved'],
      ['suggest_dates', 'information_requested'],
      ['assign_coverage', 'pending'],
      ['approve_with_coverage', 'approved'],
      ['waitlist', 'waitlisted'],
      ['request_info', 'information_requested'],
    ]);
  });

  it('sends both approving-with-coverage and approving-in-full to approved', () => {
    expect(statusForDecision('approve_with_coverage', 'pending')).toBe(
      statusForDecision('approve_full', 'pending'),
    );
  });

  it('sends both suggesting dates and requesting information to information requested', () => {
    expect(statusForDecision('suggest_dates', 'pending')).toBe(
      statusForDecision('request_info', 'pending'),
    );
  });

  it('distinguishes the two pairs that share a status by their payload', () => {
    expect(DECISION_RULES.approve_full.distinguishingPayload).toBe('none');
    expect(DECISION_RULES.approve_with_coverage.distinguishingPayload).toBe(
      'coverage_assignments',
    );
    expect(DECISION_RULES.suggest_dates.distinguishingPayload).toBe('suggested_ranges');
    expect(DECISION_RULES.request_info.distinguishingPayload).toBe('question');
  });

  it('leaves the status as it stands when coverage is assigned', () => {
    const statuses: PTOStatus[] = ['pending', 'waitlisted', 'information_requested'];
    for (const status of statuses) {
      expect(statusForDecision('assign_coverage', status)).toBe(status);
    }
    expect(DECISION_RULES.assign_coverage.status).toBeNull();
  });

  it('ignores the previous status for every deciding option', () => {
    for (const decision of DECISION_OPTIONS) {
      if (decision === 'assign_coverage') continue;
      expect(statusForDecision(decision, 'waitlisted')).toBe(
        statusForDecision(decision, 'pending'),
      );
    }
  });

  it('rejects a decision option the database constraint does not accept', () => {
    const unknown = 'approve_maybe' as unknown as DecisionOption;
    expect(() => statusForDecision(unknown, 'pending')).toThrow(RangeError);
    expect(() => decisionRule(unknown)).toThrow(RangeError);
    expect(() => decisionApproves(unknown)).toThrow(RangeError);
  });
});

describe('decisionApproves', () => {
  it('holds for exactly the three approving options', () => {
    const approving = DECISION_OPTIONS.filter(decisionApproves);
    expect(approving).toEqual(['approve_full', 'approve_partial', 'approve_with_coverage']);
  });
});

describe('approvedRangesForDecision', () => {
  it('approves the whole requested range for a full approval', () => {
    expect(approvedRangesForDecision('approve_full', requested(MONDAY, FRIDAY))).toEqual([
      range(MONDAY, FRIDAY),
    ]);
    expect(
      approvedRangesForDecision('approve_with_coverage', requested(MONDAY, FRIDAY)),
    ).toEqual([range(MONDAY, FRIDAY)]);
  });

  it('approves only the named sub-ranges for a partial approval', () => {
    const ranges = {
      requested: range(MONDAY, FRIDAY),
      approved: [range(MONDAY, WEDNESDAY)],
    };
    expect(approvedRangesForDecision('approve_partial', ranges)).toEqual([
      range(MONDAY, WEDNESDAY),
    ]);
  });

  it('cannot approve more than was requested through a full approval', () => {
    // A payload naming both is not an invitation to widen the approval.
    const ranges = {
      requested: range(MONDAY, WEDNESDAY),
      approved: [range(MONDAY, '2026-08-31')],
    };
    expect(approvedRangesForDecision('approve_full', ranges)).toEqual([
      range(MONDAY, WEDNESDAY),
    ]);
  });

  it('approves nothing for a partial approval naming no sub-range', () => {
    expect(approvedRangesForDecision('approve_partial', requested(MONDAY, FRIDAY))).toEqual([]);
  });

  it('approves nothing for the five options that decide something else', () => {
    for (const decision of DECISION_OPTIONS.filter((option) => !decisionApproves(option))) {
      expect(approvedRangesForDecision(decision, requested(MONDAY, FRIDAY))).toEqual([]);
    }
  });
});

describe('decisionBalanceDeltas', () => {
  it('debits the requested working days for a full approval', () => {
    expect(
      decisionBalanceDeltas('approve_full', 'vacation', requested(MONDAY, FRIDAY), NOTHING_CLOSED),
    ).toEqual([{ year: 2026, balanceField: 'vacation_used', deltaDays: 5 }]);
  });

  it('debits the same days when the approval follows a coverage assignment', () => {
    expect(
      decisionBalanceDeltas(
        'approve_with_coverage',
        'vacation',
        requested(MONDAY, FRIDAY),
        NOTHING_CLOSED,
      ),
    ).toEqual([{ year: 2026, balanceField: 'vacation_used', deltaDays: 5 }]);
  });

  it('debits only the approved working days for a partial approval', () => {
    const ranges = {
      requested: range(MONDAY, FRIDAY),
      approved: [range(MONDAY, WEDNESDAY)],
    };
    expect(decisionBalanceDeltas('approve_partial', 'sick', ranges, NOTHING_CLOSED)).toEqual([
      { year: 2026, balanceField: 'sick_used', deltaDays: 3 },
    ]);
  });

  it('leaves the balance unchanged for the five non-approving options', () => {
    for (const decision of DECISION_OPTIONS.filter((option) => !decisionApproves(option))) {
      expect(
        decisionBalanceDeltas(decision, 'vacation', requested(MONDAY, FRIDAY), NOTHING_CLOSED),
      ).toEqual([]);
    }
  });

  it('leaves the balance unchanged for a partial approval that approves nothing', () => {
    expect(
      decisionBalanceDeltas(
        'approve_partial',
        'vacation',
        requested(MONDAY, FRIDAY),
        NOTHING_CLOSED,
      ),
    ).toEqual([]);
  });

  it('debits each calendar year of an approval spanning two of them', () => {
    expect(
      decisionBalanceDeltas(
        'approve_full',
        'personal',
        { requested: STRADDLE },
        NOTHING_CLOSED,
      ),
    ).toEqual([
      { year: 2025, balanceField: 'personal_used', deltaDays: 3 },
      { year: 2026, balanceField: 'personal_used', deltaDays: 2 },
    ]);
  });

  it('sums to the working days the approved ranges hold', () => {
    const deltas = decisionBalanceDeltas(
      'approve_full',
      'vacation',
      { requested: STRADDLE },
      NOTHING_CLOSED,
    );
    const total = deltas.reduce((sum, delta) => sum + delta.deltaDays, 0);
    expect(total).toBe(countWorkingDays(STRADDLE.from, STRADDLE.to, NOTHING_CLOSED));
  });

  it('excludes closed dates from the debit', () => {
    expect(
      decisionBalanceDeltas(
        'approve_full',
        'vacation',
        requested(MONDAY, FRIDAY),
        new Set([WEDNESDAY]),
      ),
    ).toEqual([{ year: 2026, balanceField: 'vacation_used', deltaDays: 4 }]);
  });

  it('rejects a request type the database constraint does not accept', () => {
    expect(() =>
      decisionBalanceDeltas(
        'approve_full',
        'birthday' as unknown as 'vacation',
        requested(MONDAY, FRIDAY),
        NOTHING_CLOSED,
      ),
    ).toThrow(RangeError);
  });
});

describe('collectShortfalls', () => {
  it('reports nothing when the projection stays above the requirement', () => {
    const coverage = projected({ scheduled: ['a', 'b', 'c'], threshold: NEEDS_TWO });
    expect(coverage.status).toBe('healthy');
    expect(collectShortfalls([{ coverage }])).toEqual([]);
  });

  it('reports nothing for a date sitting exactly on its minimum', () => {
    // At_Minimum is not below the minimum. Criterion 9 blocks what goes below.
    const coverage = projected({
      scheduled: ['a', 'b', 'c'],
      proposedAbsences: ['c'],
      threshold: NEEDS_TWO,
    });
    expect(coverage.status).toBe('at_minimum');
    expect(collectShortfalls([{ coverage }])).toEqual([]);
  });

  it('reports a date the approval would take below its requirement', () => {
    const coverage = projected({
      scheduled: ['a', 'b'],
      proposedAbsences: ['b'],
      threshold: NEEDS_TWO,
    });
    expect(coverage.status).toBe('critical');
    expect(collectShortfalls([{ coverage }])).toEqual([
      {
        workDate: WEDNESDAY,
        interval: null,
        availableStaff: 1,
        requiredStaff: 2,
        shortBy: 1,
      },
    ]);
  });

  it('reports nothing when the slot has no configured requirement', () => {
    // An unconfigured threshold is a gap in the configuration, not a staffing
    // emergency, so it cannot block an approval however empty the date is.
    const coverage = projected({
      scheduled: ['a'],
      proposedAbsences: ['a'],
      threshold: null,
    });
    expect(coverage.available).toBe(0);
    expect(collectShortfalls([{ coverage }])).toEqual([]);
  });

  it('reports an interval shortfall on a date that is adequately staffed overall', () => {
    const coverage = projected({ scheduled: ['a', 'b', 'c'], threshold: NEEDS_TWO });
    expect(coverage.status).toBe('healthy');

    const shortfalls = collectShortfalls([{ coverage, intervals: dayWithMiddayHole() }]);

    expect(shortfalls).toEqual([
      {
        workDate: WEDNESDAY,
        interval: {
          start: `${WEDNESDAY}T12:00:00.000Z`,
          end: `${WEDNESDAY}T13:00:00.000Z`,
        },
        availableStaff: 1,
        requiredStaff: 2,
        shortBy: 1,
      },
    ]);
  });

  it('reports the date before the intervals inside it', () => {
    const coverage = projected({
      scheduled: ['a', 'b', 'c'],
      proposedAbsences: ['b', 'c'],
      threshold: NEEDS_TWO,
    });
    expect(coverage.status).toBe('critical');

    const shortfalls = collectShortfalls([{ coverage, intervals: dayWithMiddayHole() }]);

    expect(shortfalls).toHaveLength(2);
    expect(shortfalls[0].interval).toBeNull();
    expect(shortfalls[1].interval).not.toBeNull();
  });

  it('measures the shortfall from the reported figure, not from the raw arithmetic', () => {
    // Absences outnumber schedules, so the raw projection is negative. The
    // shortfall is how many people are still needed, which is the requirement
    // itself and never more.
    const coverage = projected({
      scheduled: ['a'],
      approvedAbsences: ['b'],
      proposedAbsences: ['a'],
      threshold: NEEDS_TWO,
    });
    expect(coverage.rawAvailable).toBe(-1);
    expect(collectShortfalls([{ coverage }])[0]).toMatchObject({
      availableStaff: 0,
      shortBy: 2,
    });
  });

  it('reports nothing for no dates at all', () => {
    expect(collectShortfalls([])).toEqual([]);
  });

  it('keeps the dates in the order supplied', () => {
    const thursday = projected({
      workDate: '2026-07-30',
      scheduled: ['a'],
      proposedAbsences: ['a'],
      threshold: NEEDS_TWO,
    });
    const wednesday = projected({
      scheduled: ['a'],
      proposedAbsences: ['a'],
      threshold: NEEDS_TWO,
    });

    const shortfalls = collectShortfalls([{ coverage: thursday }, { coverage: wednesday }]);
    expect(shortfalls.map((entry) => entry.workDate)).toEqual(['2026-07-30', WEDNESDAY]);
  });
});

describe('evaluateApprovalGuard', () => {
  it('permits an approval that creates no shortfall', () => {
    const verdict = evaluateApprovalGuard([]);
    expect(verdict.permitted).toBe(true);
    expect(verdict.code).toBeNull();
    expect(verdict.escapes).toEqual([]);
  });

  it('blocks an approval that creates a shortfall and offers nothing against it', () => {
    const verdict = evaluateApprovalGuard(ONE_SHORTFALL);
    expect(verdict.permitted).toBe(false);
    expect(verdict.code).toBe('coverage_shortfall');
    expect(verdict.shortfalls).toEqual([...ONE_SHORTFALL]);
  });

  it('blocks an approval whose escapes are all explicitly declined', () => {
    const verdict = evaluateApprovalGuard(ONE_SHORTFALL, {
      coverageAssigned: false,
      acknowledgedShortfall: false,
      overrideReason: null,
    });
    expect(verdict.permitted).toBe(false);
    expect(verdict.escapes).toEqual([]);
  });

  it('permits the approval once coverage is assigned for the shortfall', () => {
    const verdict = evaluateApprovalGuard(ONE_SHORTFALL, { coverageAssigned: true });
    expect(verdict.permitted).toBe(true);
    expect(verdict.escapes).toEqual(['coverage_assigned']);
  });

  it('permits the approval once the shortfall is acknowledged', () => {
    const verdict = evaluateApprovalGuard(ONE_SHORTFALL, { acknowledgedShortfall: true });
    expect(verdict.permitted).toBe(true);
    expect(verdict.escapes).toEqual(['shortfall_acknowledged']);
  });

  it('permits the approval once an override reason with content is supplied', () => {
    const verdict = evaluateApprovalGuard(ONE_SHORTFALL, {
      overrideReason: '  Owner approved by phone  ',
    });
    expect(verdict.permitted).toBe(true);
    expect(verdict.escapes).toEqual(['override_reason']);
    expect(verdict.overrideReason).toBe('Owner approved by phone');
  });

  it('does not accept a whitespace-only override reason as an escape', () => {
    for (const blank of ['', ' ', '\t\n', '\u00a0']) {
      const verdict = evaluateApprovalGuard(ONE_SHORTFALL, { overrideReason: blank });
      expect(verdict.permitted).toBe(false);
      expect(verdict.overrideReason).toBeNull();
    }
  });

  it('reports every escape that holds, in the order the criterion lists them', () => {
    const verdict = evaluateApprovalGuard(ONE_SHORTFALL, {
      coverageAssigned: true,
      acknowledgedShortfall: true,
      overrideReason: 'Short-handed but the client meeting moved',
    });
    expect(verdict.permitted).toBe(true);
    expect(verdict.escapes).toEqual([
      'coverage_assigned',
      'shortfall_acknowledged',
      'override_reason',
    ]);
  });

  it('carries the shortfalls through even when an escape lets the approval past', () => {
    // An approved shortfall is still a shortfall: it is what the decision row
    // and the audit entry record.
    const shortfalls = [shortfall(), shortfall({ interval: { start: 'a', end: 'b' } })];
    const verdict = evaluateApprovalGuard(shortfalls, { acknowledgedShortfall: true });
    expect(verdict.shortfalls).toEqual(shortfalls);
  });

  it('reports the escapes that hold even when there was nothing to escape', () => {
    const verdict = evaluateApprovalGuard([], { acknowledgedShortfall: true });
    expect(verdict.permitted).toBe(true);
    expect(verdict.escapes).toEqual(['shortfall_acknowledged']);
  });

  it('blocks on an interval shortfall alone', () => {
    const coverage = projected({ scheduled: ['a', 'b', 'c'], threshold: NEEDS_TWO });
    const shortfalls = collectShortfalls([{ coverage, intervals: dayWithMiddayHole() }]);

    expect(evaluateApprovalGuard(shortfalls).permitted).toBe(false);
    expect(evaluateApprovalGuard(shortfalls, { acknowledgedShortfall: true }).permitted).toBe(
      true,
    );
  });

  it('does not weigh the size of the shortfall', () => {
    const oneShort = evaluateApprovalGuard([shortfall({ availableStaff: 1, shortBy: 1 })]);
    const wholeDepartment = evaluateApprovalGuard([
      shortfall({ availableStaff: 0, requiredStaff: 4, shortBy: 4 }),
    ]);
    expect(oneShort.permitted).toBe(wholeDepartment.permitted);
  });

  it('does not mutate the shortfall list it is given', () => {
    const shortfalls = [shortfall()];
    const verdict = evaluateApprovalGuard(shortfalls);
    verdict.shortfalls.push(shortfall({ workDate: FRIDAY }));
    expect(shortfalls).toHaveLength(1);
  });
});

describe('reasonWithContent', () => {
  it('returns the trimmed reason when it carries content', () => {
    expect(reasonWithContent('  Covered by the Friday rota  ')).toBe(
      'Covered by the Friday rota',
    );
  });

  it('returns null for a reason with no content at all', () => {
    expect(reasonWithContent('')).toBeNull();
    expect(reasonWithContent('   ')).toBeNull();
    expect(reasonWithContent('\n\t')).toBeNull();
    expect(reasonWithContent(null)).toBeNull();
    expect(reasonWithContent(undefined)).toBeNull();
  });

  it('accepts a single non-whitespace character', () => {
    expect(reasonWithContent('x')).toBe('x');
  });
});

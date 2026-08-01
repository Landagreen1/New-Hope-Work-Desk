// src/features/time-attendance/shared/__tests__/threshold-draft.test.ts
// What the staffing-threshold editor decides before it sends anything.
//
// Feature: time-attendance-ui-redesign, task 25.2
//
// Two things are worth pinning down here, and both are things the coverage rules
// would report as a staffing warning if the editor got them wrong:
//
//   1. **The pair rule.** `warning_threshold` is the top of the Warning band, not
//      a second minimum, so a pair with the warning figure below the minimum
//      states a warning level that can never fire. Refused, with a reason.
//   2. **Unconfigured is not zero.** An absent `staffing_thresholds` row reports
//      required staffing as unconfigured and Coverage_Status Healthy; a stored
//      `0 / 0` requires nobody and reads as At Minimum the moment the department
//      is empty. The editor must be able to say either, and must never turn one
//      into the other.
//
// Nothing is mocked: the band arithmetic, the rejection rule, and the draft
// resolution are the real ones.
//
// Requirements: 2.3, 6.3, 6.4, 6.9, 6.10, 6.11, 6.12, 20.1, 20.2

import { describe, expect, it } from 'vitest';

import {
  MAX_REQUIRED_STAFF,
  classifyCoverage,
  coverageBands,
  rejectThreshold,
  slotKey,
  type ThresholdSlot,
} from '../../domain/coverage';
import type { Threshold } from '../../domain/types';
import {
  CLEARED,
  bandRange,
  cellBands,
  cellValue,
  draftEdits,
  parseHeadcount,
  storedByKey,
  type ThresholdDraft,
} from '../threshold-draft';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SALES_MON_MORNING: ThresholdSlot = {
  department: 'sales',
  dayOfWeek: 1,
  timeSlot: 'morning',
};
const SALES_MON_FULL_DAY: ThresholdSlot = {
  department: 'sales',
  dayOfWeek: 1,
  timeSlot: 'full_day',
};
/** Saturday, which the v1.9.5 seed deliberately leaves unconfigured. */
const SALES_SAT_MORNING: ThresholdSlot = {
  department: 'sales',
  dayOfWeek: 6,
  timeSlot: 'morning',
};

const ORDER: readonly ThresholdSlot[] = [
  SALES_MON_MORNING,
  SALES_MON_FULL_DAY,
  SALES_SAT_MORNING,
];

/** The label a refusal names, kept short so assertions read clearly. */
const labelOf = (slot: ThresholdSlot) => `${slot.department}/${slot.dayOfWeek}/${slot.timeSlot}`;

function drafted(entries: Record<string, ThresholdDraft[string]>): ThresholdDraft {
  return entries;
}

/** The stored table with sales Monday morning at the seeded 6 / 8. */
const SEEDED = storedByKey([{ ...SALES_MON_MORNING, minimumStaff: 6, warningThreshold: 8 }]);

const NOTHING_STORED = storedByKey([]);

// ─── The pair rule ───────────────────────────────────────────────────────────

describe('rejectThreshold', () => {
  it('accepts a pair whose warning band is reachable', () => {
    expect(rejectThreshold({ minimumStaff: 6, warningThreshold: 8 })).toBeNull();
  });

  it('accepts a warning threshold equal to the minimum, which is no warning band', () => {
    // A legible choice: straight from At Minimum to Healthy.
    expect(rejectThreshold({ minimumStaff: 2, warningThreshold: 2 })).toBeNull();
    expect(coverageBands({ minimumStaff: 2, warningThreshold: 2 }).map((b) => b.status)).toEqual([
      'critical',
      'at_minimum',
      'healthy',
    ]);
  });

  it('refuses a warning threshold below the minimum, because that band can never fire', () => {
    expect(rejectThreshold({ minimumStaff: 6, warningThreshold: 5 })).toBe(
      'unreachable_warning_band',
    );
  });

  it('refuses a negative figure', () => {
    expect(rejectThreshold({ minimumStaff: -1, warningThreshold: 2 })).toBe('negative');
    expect(rejectThreshold({ minimumStaff: 0, warningThreshold: -1 })).toBe('negative');
  });

  it('refuses a fractional figure, since a headcount counts people', () => {
    expect(rejectThreshold({ minimumStaff: 1.5, warningThreshold: 3 })).toBe('not_whole');
  });

  it('refuses a figure beyond the stated maximum, which is a slipped keystroke', () => {
    expect(
      rejectThreshold({ minimumStaff: 6, warningThreshold: MAX_REQUIRED_STAFF + 1 }),
    ).toBe('above_maximum');
  });

  it('accepts zero as a real requirement of nobody', () => {
    // Storable, and different from an absent row. See the unconfigured tests below.
    expect(rejectThreshold({ minimumStaff: 0, warningThreshold: 0 })).toBeNull();
  });
});

// ─── The bands a pair means ──────────────────────────────────────────────────

describe('coverageBands', () => {
  it('describes the four bands of a seeded pair', () => {
    expect(coverageBands({ minimumStaff: 6, warningThreshold: 8 })).toEqual([
      { status: 'critical', from: 0, to: 5 },
      { status: 'at_minimum', from: 6, to: 6 },
      { status: 'warning', from: 7, to: 8 },
      { status: 'healthy', from: 9, to: null },
    ]);
  });

  it('omits the Critical band when the minimum is zero, since nothing falls below none', () => {
    expect(coverageBands({ minimumStaff: 0, warningThreshold: 1 }).map((b) => b.status)).toEqual([
      'at_minimum',
      'warning',
      'healthy',
    ]);
  });

  it('agrees with classifyCoverage at every headcount in and around the bands', () => {
    // The bands are a second reading of the same rule, so the two must not drift:
    // whichever band a headcount falls in is the status the coverage panel assigns.
    const threshold: Threshold = { minimumStaff: 3, warningThreshold: 5 };
    const bands = coverageBands(threshold);

    for (let available = 0; available <= 8; available += 1) {
      const band = bands.find(
        (candidate) => available >= candidate.from && (candidate.to === null || available <= candidate.to),
      );
      expect(band?.status).toBe(classifyCoverage(available, threshold));
    }
  });

  it('renders a band as a range a reader can check against a headcount', () => {
    expect(coverageBands({ minimumStaff: 6, warningThreshold: 8 }).map(bandRange)).toEqual([
      '0\u20135',
      '6',
      '7\u20138',
      '9 or more',
    ]);
  });
});

describe('cellBands', () => {
  it('shows nothing for a cell mid-keystroke rather than guessing a band', () => {
    expect(cellBands({ minimum: '6', warning: '' })).toBeNull();
    expect(cellBands({ minimum: '', warning: '' })).toBeNull();
  });

  it('shows nothing for a pair the write path would refuse', () => {
    expect(cellBands({ minimum: '6', warning: '5' })).toBeNull();
  });

  it('shows nothing for an unconfigured or cleared cell', () => {
    expect(cellBands(null)).toBeNull();
    expect(cellBands(CLEARED)).toBeNull();
  });

  it('shows the bands of a legible pair', () => {
    expect(cellBands({ minimum: '6', warning: '8' })).toEqual([
      { status: 'critical', range: '0\u20135' },
      { status: 'at_minimum', range: '6' },
      { status: 'warning', range: '7\u20138' },
      { status: 'healthy', range: '9 or more' },
    ]);
  });
});

describe('parseHeadcount', () => {
  it('reads a whole number of people', () => {
    expect(parseHeadcount('6')).toBe(6);
    expect(parseHeadcount(' 0 ')).toBe(0);
    expect(parseHeadcount('06')).toBe(6);
  });

  it('refuses anything that is not one', () => {
    for (const text of ['', ' ', '-1', '1.5', '1e3', 'six', String(MAX_REQUIRED_STAFF + 1)]) {
      expect(parseHeadcount(text)).toBeNull();
    }
  });
});

// ─── Unconfigured is not zero ────────────────────────────────────────────────

describe('an unconfigured slot is distinct from a configured zero', () => {
  it('shows an unconfigured slot as having no pair at all', () => {
    // Not `{ minimum: '0', warning: '0' }`: the cell has to be able to say "no
    // requirement", which is what an absent row means to the coverage rules.
    expect(cellValue(SALES_SAT_MORNING, {}, SEEDED)).toBeNull();
    expect(cellValue(SALES_MON_MORNING, {}, SEEDED)).toEqual({ minimum: '6', warning: '8' });
  });

  it('sends nothing for an untouched unconfigured slot', () => {
    // The Saturday and Sunday gap is deliberate. A save that has not been asked to
    // configure the weekend must not create zero-valued weekend rows.
    const patch = draftEdits({}, SEEDED, ORDER, labelOf);
    expect(patch).toEqual({ slots: [] });
  });

  it('sends a clear, not a zero, when a stored slot is cleared', () => {
    const patch = draftEdits(
      drafted({ [slotKey(SALES_MON_MORNING)]: CLEARED }),
      SEEDED,
      ORDER,
      labelOf,
    );

    expect(patch).toEqual({
      slots: [{ department: 'sales', day_of_week: 1, time_slot: 'morning', clear: true }],
    });
  });

  it('sends nothing when a slot that is already unconfigured is cleared', () => {
    // Nothing to remove, so there is nothing to write.
    expect(
      draftEdits(drafted({ [slotKey(SALES_SAT_MORNING)]: CLEARED }), SEEDED, ORDER, labelOf),
    ).toEqual({ slots: [] });
  });

  it('stores a real zero pair when that is what was typed', () => {
    const patch = draftEdits(
      drafted({ [slotKey(SALES_SAT_MORNING)]: { minimum: '0', warning: '0' } }),
      SEEDED,
      ORDER,
      labelOf,
    );

    expect(patch).toEqual({
      slots: [
        {
          department: 'sales',
          day_of_week: 6,
          time_slot: 'morning',
          minimum_staff: 0,
          warning_threshold: 0,
        },
      ],
    });
  });

  it('classifies the two differently, which is why they cannot be merged', () => {
    // The reason the distinction is load-bearing: with nobody available, an absent
    // row reads Healthy and a stored zero reads At Minimum, which the health ribbon
    // presents as a warning on every weekend date.
    expect(classifyCoverage(0, null)).toBe('healthy');
    expect(classifyCoverage(0, { minimumStaff: 0, warningThreshold: 0 })).toBe('at_minimum');
  });
});

// ─── What a draft sends ──────────────────────────────────────────────────────

describe('draftEdits', () => {
  it('sends only the slots whose figures actually differ', () => {
    const patch = draftEdits(
      drafted({
        // Same figures, differently typed: not a change.
        [slotKey(SALES_MON_MORNING)]: { minimum: '06', warning: '8' },
        [slotKey(SALES_MON_FULL_DAY)]: { minimum: '4', warning: '6' },
      }),
      SEEDED,
      ORDER,
      labelOf,
    );

    expect(patch).toEqual({
      slots: [
        {
          department: 'sales',
          day_of_week: 1,
          time_slot: 'full_day',
          minimum_staff: 4,
          warning_threshold: 6,
        },
      ],
    });
  });

  it('lists the changed slots in the order the form shows them', () => {
    // One request for the whole edited set, so the order is the reader's order and
    // a refusal names the first cell they would look at.
    const patch = draftEdits(
      drafted({
        [slotKey(SALES_SAT_MORNING)]: { minimum: '1', warning: '2' },
        [slotKey(SALES_MON_MORNING)]: { minimum: '7', warning: '9' },
      }),
      SEEDED,
      ORDER,
      labelOf,
    );

    expect('slots' in patch && patch.slots.map((slot) => slot.time_slot)).toEqual([
      'morning',
      'morning',
    ]);
    expect('slots' in patch && patch.slots.map((slot) => slot.day_of_week)).toEqual([1, 6]);
  });

  it('refuses a half-typed pair rather than completing it with a zero', () => {
    const patch = draftEdits(
      drafted({ [slotKey(SALES_SAT_MORNING)]: { minimum: '3', warning: '' } }),
      NOTHING_STORED,
      ORDER,
      labelOf,
    );

    expect('invalid' in patch && patch.invalid).toContain('sales/6/morning');
    expect('invalid' in patch && patch.invalid).toContain('whole number');
  });

  it('refuses an unreachable warning band, naming the slot and the reason', () => {
    const patch = draftEdits(
      drafted({ [slotKey(SALES_MON_MORNING)]: { minimum: '6', warning: '5' } }),
      SEEDED,
      ORDER,
      labelOf,
    );

    expect('invalid' in patch && patch.invalid).toContain('sales/1/morning');
    expect('invalid' in patch && patch.invalid).toContain('top of the Warning band');
  });

  it('refuses a negative figure', () => {
    const patch = draftEdits(
      drafted({ [slotKey(SALES_MON_MORNING)]: { minimum: '-1', warning: '2' } }),
      SEEDED,
      ORDER,
      labelOf,
    );

    // Caught as unreadable text before it can reach the pair rule, so the reason
    // still names the slot rather than being dropped.
    expect('invalid' in patch).toBe(true);
  });

  it('refuses the whole set when one slot is refused, so a save is never partial', () => {
    const patch = draftEdits(
      drafted({
        [slotKey(SALES_MON_MORNING)]: { minimum: '7', warning: '9' },
        [slotKey(SALES_MON_FULL_DAY)]: { minimum: '9', warning: '7' },
      }),
      SEEDED,
      ORDER,
      labelOf,
    );

    expect('slots' in patch).toBe(false);
  });

  it('treats the three time slots as separate requirements', () => {
    // The lookup is exact: a full_day figure is not a fallback for morning, so
    // configuring one slot leaves the other two exactly as they were.
    const patch = draftEdits(
      drafted({ [slotKey(SALES_MON_FULL_DAY)]: { minimum: '5', warning: '7' } }),
      SEEDED,
      ORDER,
      labelOf,
    );

    expect('slots' in patch && patch.slots).toHaveLength(1);
    expect('slots' in patch && patch.slots[0]?.time_slot).toBe('full_day');
  });
});

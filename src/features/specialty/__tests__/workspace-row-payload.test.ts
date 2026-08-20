/**
 * The driver and vehicle replace-all payload, tested as a rule.
 *
 * `specialty_update_intake` deletes every driver or vehicle row and re-inserts from the
 * array it is given. That makes this function the difference between "corrected one
 * driver's licence number" and "erased the fleet", so it is the one piece of the workspace
 * that earns property tests.
 *
 * Two claims are defended here:
 *
 * 1. Columns the TypeScript interface does not name — a driver's `incidents`, a vehicle's
 *    `coverage` — survive the round trip, because the rows are passed through as they
 *    arrived rather than rebuilt.
 * 2. The edited row is found by id. An index captured when the dialog opened names a
 *    different driver once a teammate has added or removed one, and the whole point of
 *    keying on id is that Save then refuses rather than overwriting a stranger.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { applyRow, rowTarget, type RawRow } from '../workspace/row-payload';

/** A driver as `to_jsonb(dr)` actually sends it: every column, including untyped ones. */
function driver(id: string, position: number, overrides: RawRow = {}): RawRow {
  return {
    id,
    submission_id: 'intake-1',
    position,
    first_name: `Driver${position}`,
    last_name: 'Silva',
    dob: '1980-01-01',
    relationship: 'employee',
    document_type: 'driver_license',
    license_number: `L${position}`,
    license_state: 'NC',
    license_status: 'valid',
    years_licensed: 12,
    sr22_required: false,
    // Named by no TypeScript interface in this module. That is the point.
    incidents: [{ kind: 'accident', when: '2024-03-02' }],
    cdl: true,
    cdl_date: '2015-06-01',
    cdl_years_experience: 9,
    owner_operator: false,
    accidents_36mo: null,
    accidents_detail: null,
    violations_36mo: null,
    violations_detail: null,
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

const ROWS = [driver('d1', 1), driver('d2', 2), driver('d3', 3)];

describe('rowTarget', () => {
  it('reads an existing row by its id', () => {
    expect(rowTarget(ROWS[1])).toEqual({ kind: 'existing', id: 'd2' });
  });

  it('treats a row with no id as new', () => {
    expect(rowTarget({ position: 4, first_name: 'New' })).toEqual({ kind: 'new' });
    expect(rowTarget(null)).toEqual({ kind: 'new' });
    expect(rowTarget(undefined)).toEqual({ kind: 'new' });
  });
});

describe('applyRow — replacing', () => {
  it('changes only the targeted row', () => {
    const edited = { ...ROWS[1], license_number: 'CORRECTED' };
    const next = applyRow(ROWS, { kind: 'existing', id: 'd2' }, edited, false);

    expect(next).not.toBeNull();
    expect(next).toHaveLength(3);
    expect(next?.[1].license_number).toBe('CORRECTED');
    expect(next?.[0].license_number).toBe('L1');
    expect(next?.[2].license_number).toBe('L3');
  });

  it('carries every column of every untouched row, including untyped ones', () => {
    // The claim the whole editor rests on. `incidents` is not in `IntakeDriverRow`, and
    // rebuilding rows from that interface would drop it on every save.
    const next = applyRow(ROWS, { kind: 'existing', id: 'd2' }, { ...ROWS[1] }, false);
    for (const [index, row] of (next ?? []).entries()) {
      expect(row.incidents).toEqual(ROWS[index].incidents);
      expect(row.cdl_years_experience).toBe(ROWS[index].cdl_years_experience);
      expect(row.submission_id).toBe('intake-1');
    }
  });

  it('preserves a null answer as null rather than defaulting it', () => {
    // An unanswered underwriting question must not become an answered No on its way
    // through an unrelated edit.
    const next = applyRow(ROWS, { kind: 'existing', id: 'd1' }, { ...ROWS[0] }, false);
    expect(next?.[2].accidents_36mo).toBeNull();
    expect(next?.[2].violations_36mo).toBeNull();
  });

  it('finds the row wherever it has moved to', () => {
    // A teammate removed the first driver, so the row that was at index 1 is now at 0.
    // Keying on position would have overwritten the wrong driver.
    const shifted = [ROWS[1], ROWS[2]];
    const next = applyRow(
      shifted,
      { kind: 'existing', id: 'd3' },
      { ...ROWS[2], license_number: 'CORRECTED' },
      false,
    );
    expect(next?.map((row) => row.id)).toEqual(['d2', 'd3']);
    expect(next?.[1].license_number).toBe('CORRECTED');
  });

  it('refuses when the row has been removed underneath the dialog', () => {
    // Null is the signal to tell the reader to reopen it, rather than silently appending
    // a duplicate driver.
    expect(applyRow([ROWS[0]], { kind: 'existing', id: 'd2' }, ROWS[1], false)).toBeNull();
  });
});

describe('applyRow — adding', () => {
  it('appends and numbers the new row last', () => {
    const next = applyRow(ROWS, { kind: 'new' }, { first_name: 'Nuevo', last_name: 'Driver' }, false);
    expect(next).toHaveLength(4);
    expect(next?.[3].first_name).toBe('Nuevo');
    expect(next?.[3].position).toBe(4);
  });

  it('appends onto an empty list', () => {
    const next = applyRow([], { kind: 'new' }, { first_name: 'First' }, false);
    expect(next).toEqual([{ first_name: 'First', position: 1 }]);
  });

  it('has nothing to remove for a row that was never saved', () => {
    expect(applyRow(ROWS, { kind: 'new' }, {}, true)).toBeNull();
  });
});

describe('applyRow — removing', () => {
  it('drops the targeted row and closes the gap in the numbering', () => {
    // Position is what the carrier application prints. A gap reads as a missing driver.
    const next = applyRow(ROWS, { kind: 'existing', id: 'd2' }, {}, true);
    expect(next?.map((row) => row.id)).toEqual(['d1', 'd3']);
    expect(next?.map((row) => row.position)).toEqual([1, 2]);
  });

  it('refuses when the row is already gone', () => {
    expect(applyRow([ROWS[0]], { kind: 'existing', id: 'd2' }, {}, true)).toBeNull();
  });
});

describe('applyRow — invariants', () => {
  it('always renumbers from one with no gaps and no repeats', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 5 }),
        fc.boolean(),
        (count, targetIndex, removing) => {
          const rows = Array.from({ length: count }, (_, index) =>
            driver(`d${index}`, index + 1),
          );
          const target =
            targetIndex < count
              ? ({ kind: 'existing', id: `d${targetIndex}` } as const)
              : ({ kind: 'new' } as const);

          const next = applyRow(rows, target, { first_name: 'Draft' }, removing);
          if (next === null) return true;

          const positions = next.map((row) => row.position);
          return positions.every((position, index) => position === index + 1);
        },
      ),
    );
  });

  it('never changes the length by more than one', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 5 }),
        fc.boolean(),
        (count, targetIndex, removing) => {
          const rows = Array.from({ length: count }, (_, index) =>
            driver(`d${index}`, index + 1),
          );
          const target =
            targetIndex < count
              ? ({ kind: 'existing', id: `d${targetIndex}` } as const)
              : ({ kind: 'new' } as const);

          const next = applyRow(rows, target, { first_name: 'Draft' }, removing);
          if (next === null) return true;
          return Math.abs(next.length - rows.length) <= 1;
        },
      ),
    );
  });

  it('never loses an untargeted row', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 5 }),
        (count, targetIndex) => {
          const rows = Array.from({ length: count }, (_, index) =>
            driver(`d${index}`, index + 1),
          );
          if (targetIndex >= count) return true;

          const next = applyRow(
            rows,
            { kind: 'existing', id: `d${targetIndex}` },
            { ...rows[targetIndex] },
            false,
          );
          if (next === null) return false;
          // Every original id is still present after a replace.
          return rows.every((row) => next.some((candidate) => candidate.id === row.id));
        },
      ),
    );
  });
});

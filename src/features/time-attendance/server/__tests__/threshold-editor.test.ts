// src/features/time-attendance/server/__tests__/threshold-editor.test.ts
// What the staffing-threshold editor's write path decides without a database.
//
// Feature: time-attendance-ui-redesign, task 25.2
//
// `saveStaffingThresholds` is at most two statements against `staffing_thresholds`,
// so what is worth asserting here is everything around them: which rows an
// assignment set upserts, that the delete filter matches exactly the slots being
// cleared and not the cross product of their columns, that a row the loader would
// drop cannot come back as a configured slot, and that a write failure reaches a
// screen as the failure it is. The upsert and the row level security that reserves
// it to `super_admin` are integration concerns.
//
// Nothing is mocked. The mapping, the slot identity, and the failure contract are
// the real ones.
//
// Requirements: 2.3, 6.3, 6.4, 20.1, 20.2, 21.6, 22.16

import { describe, expect, it } from 'vitest';

import { slotKey, type ThresholdSlot } from '../../domain/coverage';
import { serviceFailure } from '../api-response';
import {
  KNOWN_DAYS_OF_WEEK,
  KNOWN_DEPARTMENTS,
  KNOWN_TIME_SLOTS,
  PolicyServiceError,
  THRESHOLDS_SAVED_UNREADABLE_MESSAGE,
  THRESHOLDS_UNWRITABLE_MESSAGE,
  buildStaffingThresholdTable,
  describeSlot,
  isThresholdClear,
  thresholdClearFilter,
  thresholdUpsertRows,
  toThresholdSnapshot,
  type ThresholdEdit,
} from '../policy';

const SALES_MON_MORNING: ThresholdSlot = {
  department: 'sales',
  dayOfWeek: 1,
  timeSlot: 'morning',
};
const MANAGEMENT_SAT_FULL_DAY: ThresholdSlot = {
  department: 'management',
  dayOfWeek: 6,
  timeSlot: 'full_day',
};

describe('the accepted vocabulary', () => {
  it('names exactly the values the v1.2.0 check constraints admit', () => {
    // The write path accepts these and nothing else, so a row the editor could
    // store and `buildStaffingThresholdTable` would then drop cannot be written.
    expect(KNOWN_DEPARTMENTS).toEqual(['sales', 'customer_service', 'commercial', 'management']);
    expect(KNOWN_TIME_SLOTS).toEqual(['morning', 'afternoon', 'full_day']);
    expect(KNOWN_DAYS_OF_WEEK).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('names a slot in the vocabulary the caller sent', () => {
    expect(describeSlot(SALES_MON_MORNING)).toBe('sales, day 1, morning');
  });
});

describe('thresholdUpsertRows', () => {
  it('assigns the columns v1.2.0 declares', () => {
    const [row] = thresholdUpsertRows([
      { ...SALES_MON_MORNING, minimumStaff: 6, warningThreshold: 8 },
    ]);

    expect(row.department).toBe('sales');
    expect(row.day_of_week).toBe(1);
    expect(row.time_slot).toBe('morning');
    expect(row.minimum_staff).toBe(6);
    expect(row.warning_threshold).toBe(8);
    // The touch trigger fires before update, but a first insert has to carry it.
    expect(typeof row.updated_at).toBe('string');
  });

  it('carries a zero pair through as a stored requirement of nobody', () => {
    const [row] = thresholdUpsertRows([
      { ...MANAGEMENT_SAT_FULL_DAY, minimumStaff: 0, warningThreshold: 0 },
    ]);

    expect(row.minimum_staff).toBe(0);
    expect(row.warning_threshold).toBe(0);
  });

  it('produces one row per assignment, so a set is one statement', () => {
    expect(
      thresholdUpsertRows([
        { ...SALES_MON_MORNING, minimumStaff: 6, warningThreshold: 8 },
        { ...MANAGEMENT_SAT_FULL_DAY, minimumStaff: 2, warningThreshold: 3 },
      ]),
    ).toHaveLength(2);
  });
});

describe('thresholdClearFilter', () => {
  it('matches one slot on all three columns together', () => {
    expect(thresholdClearFilter([SALES_MON_MORNING])).toBe(
      'and(department.eq.sales,day_of_week.eq.1,time_slot.eq.morning)',
    );
  });

  it('matches exactly the named slots rather than the cross product of their columns', () => {
    // Three `in` filters would also match sales/6/full_day and management/1/morning,
    // deleting two slots nobody asked to clear.
    const filter = thresholdClearFilter([SALES_MON_MORNING, MANAGEMENT_SAT_FULL_DAY]);

    expect(filter.split('),and(')).toHaveLength(2);
    expect(filter).toContain('department.eq.sales,day_of_week.eq.1,time_slot.eq.morning');
    expect(filter).toContain('department.eq.management,day_of_week.eq.6,time_slot.eq.full_day');
  });

  it('is empty when there is nothing to clear, so no delete is issued', () => {
    // An empty filter must never be sent: PostgREST would match every row.
    expect(thresholdClearFilter([])).toBe('');
  });

  it('interpolates only values from the closed sets', () => {
    // Every department and slot the filter can carry is checked against
    // `KNOWN_DEPARTMENTS` and `KNOWN_TIME_SLOTS` before it arrives, and the day is a
    // whole number, so no caller-supplied text reaches the filter expression.
    const filter = thresholdClearFilter(
      KNOWN_DEPARTMENTS.flatMap((department) =>
        KNOWN_TIME_SLOTS.map((timeSlot) => ({ department, dayOfWeek: 0, timeSlot })),
      ),
    );

    expect(/^[a-z0-9_.,()=]+$/.test(filter)).toBe(true);
  });
});

describe('an edit that clears a slot', () => {
  it('is told apart from one that stores a pair', () => {
    const clear: ThresholdEdit = { ...MANAGEMENT_SAT_FULL_DAY, clear: true };
    const assign: ThresholdEdit = { ...SALES_MON_MORNING, minimumStaff: 0, warningThreshold: 0 };

    expect(isThresholdClear(clear)).toBe(true);
    expect(isThresholdClear(assign)).toBe(false);
  });
});

describe('toThresholdSnapshot', () => {
  it('reports only configured slots, so an absent row stays absent', () => {
    // An unconfigured slot must not arrive as a slot with null figures: that is what
    // lets the editor tell "no requirement" from "a requirement of none".
    const snapshot = toThresholdSnapshot([
      {
        department: 'sales',
        day_of_week: 1,
        time_slot: 'morning',
        minimum_staff: 6,
        warning_threshold: 8,
        updated_at: '2026-01-02T03:04:05.000Z',
      },
    ]);

    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toEqual({
      department: 'sales',
      dayOfWeek: 1,
      timeSlot: 'morning',
      minimumStaff: 6,
      warningThreshold: 8,
      updatedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('answers an empty table with no entries rather than a fabricated grid', () => {
    expect(toThresholdSnapshot([]).entries).toEqual([]);
    expect(toThresholdSnapshot(null).entries).toEqual([]);
  });

  it('drops a row naming a slot no caller can ask about', () => {
    // The same rows `buildStaffingThresholdTable` drops. Keeping them would show the
    // editor a requirement that no coverage reading will ever compare against.
    const snapshot = toThresholdSnapshot([
      { department: 'reception', day_of_week: 1, time_slot: 'morning', minimum_staff: 1, warning_threshold: 2 },
      { department: 'sales', day_of_week: 9, time_slot: 'morning', minimum_staff: 1, warning_threshold: 2 },
      { department: 'sales', day_of_week: 1, time_slot: 'evening', minimum_staff: 1, warning_threshold: 2 },
      { department: 'sales', day_of_week: 1, time_slot: 'morning', minimum_staff: null, warning_threshold: 2 },
    ]);

    expect(snapshot.entries).toEqual([]);
  });

  it('orders entries by department, then day, then slot', () => {
    const snapshot = toThresholdSnapshot([
      { department: 'management', day_of_week: 1, time_slot: 'full_day', minimum_staff: 2, warning_threshold: 3 },
      { department: 'sales', day_of_week: 2, time_slot: 'morning', minimum_staff: 6, warning_threshold: 8 },
      { department: 'sales', day_of_week: 1, time_slot: 'afternoon', minimum_staff: 6, warning_threshold: 8 },
      { department: 'sales', day_of_week: 1, time_slot: 'morning', minimum_staff: 6, warning_threshold: 8 },
    ]);

    expect(snapshot.entries.map(slotKey)).toEqual([
      'sales:1:morning',
      'sales:1:afternoon',
      'sales:2:morning',
      'management:1:full_day',
    ]);
  });

  it('feeds the same figures the coverage lookup reads back', () => {
    // The round trip that matters: what the editor displays is what
    // `classifyCoverage` will later be handed.
    const rows = [
      { department: 'commercial', day_of_week: 3, time_slot: 'full_day', minimum_staff: 4, warning_threshold: 6 },
    ];
    const entry = toThresholdSnapshot(rows).entries[0];
    const table = buildStaffingThresholdTable(rows);

    expect(table.thresholdFor('commercial', 3, 'full_day')).toEqual({
      minimumStaff: entry.minimumStaff,
      warningThreshold: entry.warningThreshold,
    });
    // And the slot the seed leaves alone stays unconfigured.
    expect(table.thresholdFor('commercial', 6, 'full_day')).toBeNull();
  });
});

describe('a threshold write that failed', () => {
  it('reaches the screen as a retryable failure stating nothing was changed', async () => {
    const response = serviceFailure(
      new PolicyServiceError('write_failed', THRESHOLDS_UNWRITABLE_MESSAGE),
      'write_failed',
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body.code).toBe('write_failed');
    expect(body.error).toBe(THRESHOLDS_UNWRITABLE_MESSAGE);
  });

  it('does not claim nothing was changed when only the read-back failed', async () => {
    // The edits are committed at that point. Telling the administrator that nothing
    // was saved would send them to re-enter a change that is already stored.
    const response = serviceFailure(
      new PolicyServiceError('read_failed', THRESHOLDS_SAVED_UNREADABLE_MESSAGE),
      'write_failed',
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.code).toBe('read_failed');
    expect(body.error).toContain('were saved');
  });
});

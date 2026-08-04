/**
 * URL state round trip.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 9.1, 9.6, 9.7, 9.10
 *
 * The URL is the report state, not a side effect of it, so these properties matter:
 * an identical state must produce an identical string, a parse of a written string must
 * return the state that was written, and an unrecognised value must be dropped and named
 * rather than thrown. Without the last one, a manager pasting last quarter's link gets an
 * error instead of a report.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_SIZE,
  SORT_KEYS,
  WINDOW_PRESETS,
  addDays,
  businessToday,
  clearDimensionFilters,
  defaultFilters,
  hasActiveDimensionFilters,
  parseReportUrl,
  resolvePreset,
  toFilterPayload,
  writeReportUrl,
} from '../url-state';
import type { ReportFilters } from '../types';

const TODAY = '2026-08-03'; // A Monday.

function parse(query: string) {
  return parseReportUrl(new URLSearchParams(query), TODAY);
}

describe('defaults', () => {
  it('opens on Overview in Operational Activity mode over the last seven days', () => {
    const filters = defaultFilters(TODAY);
    expect(filters.view).toBe('overview');
    expect(filters.mode).toBe('activity');
    expect(filters.startDate).toBe('2026-07-28');
    expect(filters.endDate).toBe(TODAY);
    expect(filters.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('writes an empty query string for the default state', () => {
    // Otherwise the first render would push a URL, and Back would land on a
    // functionally identical page.
    expect(writeReportUrl(defaultFilters(TODAY), TODAY)).toBe('');
  });

  it('parses an empty query string to the defaults with nothing dropped', () => {
    const { filters, droppedKeys } = parse('');
    expect(filters).toEqual(defaultFilters(TODAY));
    expect(droppedKeys).toEqual([]);
  });
});

describe('businessToday', () => {
  it('reads the date in the business timezone, not the reader\u2019s locale', () => {
    // 02:00 UTC on 4 August is still 3 August in New York. An agent in Ecuador and a
    // manager in New York must see the same default window.
    expect(businessToday(new Date('2026-08-04T02:00:00Z'), 'America/New_York')).toBe(
      '2026-08-03',
    );
  });
});

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31');
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
  });

  it('crosses a year boundary', () => {
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });
});

describe('window presets', () => {
  it('offers all eight of Requirement 9.1', () => {
    expect(WINDOW_PRESETS).toHaveLength(8);
    expect(WINDOW_PRESETS.map((preset) => preset.id)).toEqual([
      'today',
      'yesterday',
      'last_7_days',
      'current_week',
      'previous_week',
      'current_month',
      'previous_month',
      'custom',
    ]);
  });

  it('resolves today and yesterday to a single day', () => {
    expect(resolvePreset('today', TODAY)).toEqual({ startDate: TODAY, endDate: TODAY });
    expect(resolvePreset('yesterday', TODAY)).toEqual({
      startDate: '2026-08-02',
      endDate: '2026-08-02',
    });
  });

  it('starts the week on Monday', () => {
    // 3 August 2026 is a Monday, so the current week starts on it.
    expect(resolvePreset('current_week', TODAY).startDate).toBe('2026-08-03');
    // From a Wednesday the week still starts on that Monday.
    expect(resolvePreset('current_week', '2026-08-05').startDate).toBe('2026-08-03');
  });

  it('treats Sunday as the end of the week it closes, not the start of the next', () => {
    // 2 August 2026 is a Sunday; its week began Monday 27 July.
    expect(resolvePreset('current_week', '2026-08-02').startDate).toBe('2026-07-27');
  });

  it('resolves the previous week to a full Monday-to-Sunday span', () => {
    expect(resolvePreset('previous_week', TODAY)).toEqual({
      startDate: '2026-07-27',
      endDate: '2026-08-02',
    });
  });

  it('resolves the current month from its first day', () => {
    expect(resolvePreset('current_month', TODAY)).toEqual({
      startDate: '2026-08-01',
      endDate: TODAY,
    });
  });

  it('resolves the previous month to its whole span', () => {
    expect(resolvePreset('previous_month', TODAY)).toEqual({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    });
  });

  it('handles a previous month of a different length', () => {
    // March back to February, in a non-leap year.
    expect(resolvePreset('previous_month', '2026-03-15')).toEqual({
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
  });
});

describe('round trip', () => {
  it('restores every field it wrote', () => {
    const filters: ReportFilters = {
      ...defaultFilters(TODAY),
      view: 'agents',
      mode: 'cohort',
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      compareToPreviousPeriod: true,
      hoursSegment: 'after',
      afterHoursDimensions: ['received', 'worked'],
      agentProfileIds: ['5608dfc2-e63c-4f0d-beb4-12b41458aa50'],
      dealerIds: ['a3fda208-532c-4095-bcef-31af4ce2569a'],
      channels: ['WhatsApp'],
      quoteKinds: ['requote'],
      assignmentMethods: ['manual_quote'],
      statuses: ['finalized'],
      outcomes: ['sold'],
      sortColumn: 'finalized_at_desc',
      page: 3,
    };
    const query = writeReportUrl(filters, TODAY);
    const { filters: restored, droppedKeys } = parse(query);
    expect(droppedKeys).toEqual([]);
    expect(restored).toEqual(filters);
  });

  it('produces one identical string for one identical state', () => {
    // Back would otherwise sometimes replay a state that differed only in key order.
    const filters: ReportFilters = {
      ...defaultFilters(TODAY),
      view: 'sources',
      channels: ['RingCentral', 'WhatsApp'],
      outcomes: ['sold'],
    };
    expect(writeReportUrl(filters, TODAY)).toBe(writeReportUrl({ ...filters }, TODAY));
  });

  it('survives a second round trip unchanged', () => {
    const first = parse('view=agents&mode=cohort&hours=after&ahd=worked&page=2');
    const second = parse(writeReportUrl(first.filters, TODAY));
    expect(second.filters).toEqual(first.filters);
  });
});

describe('dropping unrecognised values', () => {
  it('drops an unknown view and names it', () => {
    const { filters, droppedKeys } = parse('view=scorecard');
    expect(filters.view).toBe('overview');
    expect(droppedKeys).toContain('view');
  });

  it('drops an unknown mode and names it', () => {
    const { filters, droppedKeys } = parse('mode=blended');
    expect(filters.mode).toBe('activity');
    expect(droppedKeys).toContain('mode');
  });

  it('drops an unknown hours segment and names it', () => {
    const { filters, droppedKeys } = parse('hours=graveyard');
    expect(filters.hoursSegment).toBe('all');
    expect(droppedKeys).toContain('hours');
  });

  it('keeps the valid after-hours dimensions and names the drop', () => {
    const { filters, droppedKeys } = parse('ahd=received,bogus,finalized');
    expect(filters.afterHoursDimensions).toEqual(['received', 'finalized']);
    expect(droppedKeys).toContain('ahd');
  });

  it('drops a malformed uuid and names the key', () => {
    const { filters, droppedKeys } = parse('agents=not-a-uuid');
    expect(filters.agentProfileIds).toEqual([]);
    expect(droppedKeys).toContain('agents');
  });

  it('keeps the valid uuids alongside a malformed one', () => {
    const { filters } = parse(
      'sources=a3fda208-532c-4095-bcef-31af4ce2569a,nope',
    );
    expect(filters.dealerIds).toEqual(['a3fda208-532c-4095-bcef-31af4ce2569a']);
  });

  it('drops a malformed date and keeps the default', () => {
    const { filters, droppedKeys } = parse('start=last-tuesday');
    expect(filters.startDate).toBe('2026-07-28');
    expect(droppedKeys).toContain('start');
  });

  it('drops an unknown sort key and names it', () => {
    const { filters, droppedKeys } = parse('sort=by_vibes');
    expect(filters.sortColumn).toBeNull();
    expect(droppedKeys).toContain('sort');
  });

  it('accepts every declared sort key', () => {
    for (const key of SORT_KEYS) {
      const { filters, droppedKeys } = parse(`sort=${key}`);
      expect(filters.sortColumn).toBe(key);
      expect(droppedKeys).not.toContain('sort');
    }
  });

  it('never throws on a hostile query string', () => {
    expect(() =>
      parse('view=%%%&mode=&start=0000-99-99&ahd=,,,&page=-4&size=999999'),
    ).not.toThrow();
  });
});

describe('range and pagination guards', () => {
  it('swaps a reversed range rather than reporting nothing', () => {
    const { filters } = parse('start=2026-07-31&end=2026-07-01');
    expect(filters.startDate).toBe('2026-07-01');
    expect(filters.endDate).toBe('2026-07-31');
  });

  it('falls back to page one for a nonsense page', () => {
    expect(parse('page=-3').filters.page).toBe(1);
    expect(parse('page=abc').filters.page).toBe(1);
  });

  it('clamps an oversized page size to the default', () => {
    expect(parse('size=999999').filters.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(parse('size=0').filters.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(parse('size=100').filters.pageSize).toBe(100);
  });
});

describe('filter activity helpers', () => {
  it('reports no active dimension filters for the defaults', () => {
    expect(hasActiveDimensionFilters(defaultFilters(TODAY))).toBe(false);
  });

  it('counts an hours segment as an active filter', () => {
    expect(
      hasActiveDimensionFilters({ ...defaultFilters(TODAY), hoursSegment: 'after' }),
    ).toBe(true);
  });

  it('clears every dimension filter and resets the page but keeps the window', () => {
    const filters: ReportFilters = {
      ...defaultFilters(TODAY),
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      mode: 'cohort',
      view: 'sources',
      hoursSegment: 'after',
      dealerIds: ['a3fda208-532c-4095-bcef-31af4ce2569a'],
      outcomes: ['sold'],
      page: 4,
    };
    const cleared = clearDimensionFilters(filters);
    expect(hasActiveDimensionFilters(cleared)).toBe(false);
    expect(cleared.page).toBe(1);
    // The window, the mode and the view are not dimension filters.
    expect(cleared.startDate).toBe('2026-07-01');
    expect(cleared.endDate).toBe('2026-07-31');
    expect(cleared.mode).toBe('cohort');
    expect(cleared.view).toBe('sources');
  });
});

describe('toFilterPayload', () => {
  it('emits the snake_case keys the RPCs expect', () => {
    const payload = toFilterPayload({
      ...defaultFilters(TODAY),
      mode: 'cohort',
      hoursSegment: 'sunday',
      afterHoursDimensions: ['manual_entry'],
    });
    expect(payload).toMatchObject({
      mode: 'cohort',
      start_date: '2026-07-28',
      end_date: TODAY,
      hours_segment: 'sunday',
      after_hours_dimensions: ['manual_entry'],
    });
    // The view and the pagination are the client's business, not a filter.
    expect(payload).not.toHaveProperty('view');
    expect(payload).not.toHaveProperty('page');
  });

  it('sends empty arrays rather than omitting a filter', () => {
    const payload = toFilterPayload(defaultFilters(TODAY));
    for (const key of [
      'agent_profile_ids',
      'dealer_ids',
      'salesperson_ids',
      'channels',
      'quote_kinds',
      'assignment_methods',
      'statuses',
      'outcomes',
    ]) {
      expect(payload[key]).toEqual([]);
    }
  });
});

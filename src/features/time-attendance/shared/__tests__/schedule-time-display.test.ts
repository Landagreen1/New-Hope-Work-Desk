// How the Schedule screen spells a stored shift time, checked by example.
//
// `employee_schedules.shift_start` and `shift_end` are `time` columns written in
// the business timezone, and the grid shows them on each employee's own clock.
// What replaced the hardcoded hour offsets is `formatScheduledTimeOfDay`, so the
// cases worth pinning are the ones those offsets got wrong: the same shift on
// either side of a daylight-saving transition, in a zone that observes one and in
// two that do not.
//
// The generated coverage of the two conversions underneath this — work-date
// stability and the business-timezone round trip — is tasks 1.5 and 1.6, and it is
// already in `domain/__tests__`. Nothing here re-derives anything; these are
// spellings.
//
// Requirements: 2.5, 19.9, 19.10

import { describe, expect, it } from 'vitest';

import { formatScheduledTimeOfDay, formatTimeZoneName, NO_VALUE } from '../format';

const BUSINESS = 'America/New_York';
const ECUADOR = 'America/Guayaquil';
const HONDURAS = 'America/Tegucigalpa';

describe('formatScheduledTimeOfDay', () => {
  it('spells a stored time as it is when the employee is in the business zone', () => {
    expect(formatScheduledTimeOfDay('2026-08-12', '09:00:00', BUSINESS, BUSINESS)).toBe('9:00 AM');
    expect(formatScheduledTimeOfDay('2026-08-12', '17:30:00', BUSINESS, BUSINESS)).toBe('5:30 PM');
    expect(formatScheduledTimeOfDay('2026-08-12', '00:00:00', BUSINESS, BUSINESS)).toBe('12:00 AM');
    expect(formatScheduledTimeOfDay('2026-08-12', '12:00:00', BUSINESS, BUSINESS)).toBe('12:00 PM');
  });

  it('reads a stored time on the employee clock across a daylight-saving change', () => {
    // Ecuador is UTC-5 all year. New York is UTC-4 in August and UTC-5 in January,
    // so the same stored 09:00 is 8:00 AM in Guayaquil in summer and 9:00 AM in
    // winter. The offsets this replaced answered 8:00 AM in both.
    expect(formatScheduledTimeOfDay('2026-08-12', '09:00:00', BUSINESS, ECUADOR)).toBe('8:00 AM');
    expect(formatScheduledTimeOfDay('2026-01-14', '09:00:00', BUSINESS, ECUADOR)).toBe('9:00 AM');

    // Honduras is UTC-6 all year: one hour further behind on each date.
    expect(formatScheduledTimeOfDay('2026-08-12', '09:00:00', BUSINESS, HONDURAS)).toBe('7:00 AM');
    expect(formatScheduledTimeOfDay('2026-01-14', '09:00:00', BUSINESS, HONDURAS)).toBe('8:00 AM');
  });

  it('carries a shift end back over midnight when the conversion takes it there', () => {
    // 00:30 in New York is 23:30 the previous evening in Guayaquil. The time of day
    // is what the cell shows; the date it belongs to is the row it is in.
    expect(formatScheduledTimeOfDay('2026-08-12', '00:30:00', BUSINESS, ECUADOR)).toBe('11:30 PM');
  });

  it('accepts the forms a time column and the shift form both send', () => {
    expect(formatScheduledTimeOfDay('2026-08-12', '09:00', BUSINESS, ECUADOR)).toBe('8:00 AM');
    expect(formatScheduledTimeOfDay('2026-08-12', '09:00:00.000', BUSINESS, ECUADOR)).toBe('8:00 AM');
  });

  it('shows the stored time unconverted when a zone is not known yet', () => {
    // The state a first render is in, before the read carrying the business zone
    // has resolved. Unconverted is the honest reading of a time column.
    expect(formatScheduledTimeOfDay('2026-08-12', '09:00:00', undefined, ECUADOR)).toBe('9:00 AM');
    expect(formatScheduledTimeOfDay('2026-08-12', '09:00:00', BUSINESS, undefined)).toBe('9:00 AM');
    expect(formatScheduledTimeOfDay('2026-08-12', '09:00:00', BUSINESS, 'Mars/Olympus')).toBe(
      '9:00 AM',
    );
  });

  it('reports a value it cannot read rather than inventing midnight', () => {
    expect(formatScheduledTimeOfDay('2026-08-12', '', BUSINESS, ECUADOR)).toBe(NO_VALUE);
    expect(formatScheduledTimeOfDay('2026-08-12', null, BUSINESS, ECUADOR)).toBe(NO_VALUE);
    expect(formatScheduledTimeOfDay('2026-08-12', 'lunchtime', BUSINESS, ECUADOR)).toBe(NO_VALUE);
  });
});

describe('formatTimeZoneName', () => {
  it('names the place the identifier names', () => {
    expect(formatTimeZoneName(BUSINESS)).toBe('New York');
    expect(formatTimeZoneName(ECUADOR)).toBe('Guayaquil');
    expect(formatTimeZoneName(HONDURAS)).toBe('Tegucigalpa');
    expect(formatTimeZoneName('UTC')).toBe('UTC');
  });

  it('says nothing for an employee whose zone is not known', () => {
    expect(formatTimeZoneName(undefined)).toBe('');
    expect(formatTimeZoneName(null)).toBe('');
    expect(formatTimeZoneName('   ')).toBe('');
  });
});

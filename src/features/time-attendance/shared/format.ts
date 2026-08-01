// src/features/time-attendance/shared/format.ts
// The module's display formatting: the one place an instant, a work date, an
// hours figure, or a minutes figure becomes the text a reader sees.
//
// None of this decides anything. Every figure arrives already computed on a
// `DailyAttendanceRecord`, and these functions only choose how it is spelled.
// That distinction is why they live in `shared/` rather than in `domain/`: a
// wording change is not a rule change, and a screen composing its own wording is
// how "30" ends up meaning minutes in one column and hours in the next.
//
// ## Why the zone is an argument
//
// A clock instant means nothing without a zone to read it in. Requirement 19,
// criteria 9 and 10 put every zone conversion behind `domain/work-date.ts`, so
// `formatTimeOfDay` reads the wall clock through `wallClockOf` and formats the
// fields it returns. There is no second `Intl.DateTimeFormat` in this module and
// no `toLocaleTimeString` with a `timeZone` option, which is what replaced the
// hardcoded Guayaquil and Tegucigalpa offsets `ScheduleManager.tsx` used to apply
// and what keeps them from having a successor. The schedule grid's own case — a
// stored `time` column rather than an instant — goes through
// `formatScheduledTimeOfDay` below, which composes the same two conversions.
//
// The zone to pass is the employee's own `profiles.timezone`, which every read
// carries on `AttendanceEmployee.timezone`. The service normalises an unusable
// zone to the business timezone before a record leaves the server, so a zone
// reaching here is one the server could read; the fallback below exists for the
// case where the browser's zone data is narrower than the server's.
//
// Requirements: 4.1, 4.3, 4.5, 4.6, 19.9, 22.7

import type { MetricUnit } from '../domain/attendance';
import { wallClockOf, zonedToInstant, type ZonedWallClock } from '../domain/work-date';

/**
 * What stands in for a figure the record does not carry.
 *
 * An em dash rather than a zero or a blank: a missing clock-out is not a
 * clock-out at midnight, and an empty cell reads as a rendering fault.
 */
export const NO_VALUE = '\u2014';

/** Month names, indexed by the 1-based month of a `YYYY-MM-DD` date. */
const MONTH_NAMES = [
  '',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MONTH_NAMES_LONG = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Weekday names, indexed the way `Date.prototype.getUTCDay` numbers them. */
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The three fields of a `YYYY-MM-DD` date, or null when it is not one. */
function dateFields(date: string): { year: number; month: number; day: number } | null {
  const match = DATE_PATTERN.exec(date);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return { year, month, day };
}

/**
 * The weekday a `YYYY-MM-DD` date falls on.
 *
 * Read at UTC midnight rather than through `new Date('2026-08-11T00:00:00')`,
 * which is parsed in the process timezone and lands on the previous date for
 * anywhere west of Greenwich. A work date is a calendar date and carries no
 * hour, so no zone belongs in the answer.
 */
function weekdayOf(fields: { year: number; month: number; day: number }): string {
  const utc = new Date(Date.UTC(fields.year, fields.month - 1, fields.day));
  return WEEKDAY_NAMES[utc.getUTCDay()];
}

/**
 * The wall clock of an instant in a zone, and the zone it was actually read in.
 *
 * `wallClockOf` throws for a zone this runtime does not know. UTC is substituted
 * and reported rather than silently used, because a time displayed in the wrong
 * zone is worse than a time displayed with its zone named.
 */
function wallClock(instant: Date, timeZone: string): { clock: ZonedWallClock; zone: string } {
  try {
    return { clock: wallClockOf(instant, timeZone), zone: timeZone };
  } catch {
    return { clock: wallClockOf(instant, 'UTC'), zone: 'UTC' };
  }
}

/** An instant, or null when the value is absent or unreadable. */
function instantOf(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? new Date(epochMs) : null;
}

/** `13:05:00` as `1:05 PM`. Hour 0 reads as 12 AM, hour 12 as 12 PM. */
function twelveHour(time: string): string {
  const [hourText, minuteText] = time.split(':');
  const hour24 = Number(hourText);
  if (!Number.isFinite(hour24)) return time;

  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minuteText} ${suffix}`;
}

/**
 * An instant as a time of day in a named zone: `9:05 AM`.
 *
 * Returns `NO_VALUE` for an absent instant, so a caller renders the result
 * unconditionally rather than branching on null at every call site. A zone this
 * runtime cannot read is named in the output rather than substituted quietly.
 *
 * Requirements: 4.1, 4.3, 4.6, 19.9
 */
export function formatTimeOfDay(value: string | null | undefined, timeZone: string): string {
  const instant = instantOf(value);
  if (instant === null) return NO_VALUE;

  const { clock, zone } = wallClock(instant, timeZone);
  const time = twelveHour(clock.time);
  return zone === timeZone ? time : `${time} ${zone}`;
}

/**
 * The scheduled span as one phrase: `9:00 AM – 6:00 PM`.
 *
 * Both ends absent reads as no shift at all, which is what a date carrying no
 * published schedule looks like on the record.
 *
 * Requirements: 4.1
 */
export function formatTimeSpan(
  from: string | null | undefined,
  to: string | null | undefined,
  timeZone: string,
): string | null {
  const start = instantOf(from);
  const end = instantOf(to);
  if (start === null && end === null) return null;

  return `${formatTimeOfDay(from, timeZone)} \u2013 ${formatTimeOfDay(to, timeZone)}`;
}

/** `HH:MM`, `HH:MM:SS`, or `HH:MM:SS.fff`, the forms a `time` column arrives in. */
const STORED_TIME_PATTERN = /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * A stored `time` column as the time of day it reads in another zone.
 *
 * `employee_schedules.shift_start` and `shift_end` are `time` columns, not
 * instants: they carry a wall clock and no zone at all, and the zone that makes
 * them meaningful is the business timezone the schedule was written in
 * (Requirement 3, criterion 7). So placing one on an employee's own clock is two
 * steps, and both of them belong to `domain/work-date.ts` — `zonedToInstant` to
 * find the instant the business clock reads `time` on `date`, then the same
 * `wallClockOf` read `formatTimeOfDay` performs, to spell that instant in the
 * employee's zone.
 *
 * That composition is the whole point of this function. It is what replaces the
 * hardcoded minus-one-hour and minus-two-hour offsets `ScheduleManager.tsx` used
 * to apply against a fixed Eastern Daylight Time baseline, which were wrong for
 * half the year in every zone involved. Daylight saving is handled because
 * `zonedToInstant` reads the offset actually in force on `date`, which is also
 * why the date has to be an argument: 09:00 in New York is 14:00 UTC in January
 * and 13:00 UTC in July, and the employee's own clock moves with its own rules.
 *
 * Either zone may be absent, which is the state a screen is in before the policy
 * read that carries the business timezone has resolved. Both that case and the
 * case where the two zones are the same spell the stored wall clock as it is,
 * with no conversion: an unconverted time is the honest reading of a `time`
 * column, and it is what an employee in the business timezone sees either way.
 *
 * A zone this runtime cannot read falls back to that same unconverted reading,
 * rather than to the UTC reading `formatTimeOfDay` names for an instant. The two
 * differ because the values differ: an instant exists whatever zone is available
 * to read it in, so naming UTC is the honest answer there, while a `time` column
 * read in UTC is a time no clock in the organisation shows. The grid carries the
 * zone as a label beside the figure either way.
 *
 * Requirements: 2.5, 19.9, 19.10
 */
export function formatScheduledTimeOfDay(
  date: string,
  time: string | null | undefined,
  storedTimeZone: string | null | undefined,
  displayTimeZone: string | null | undefined,
): string {
  if (typeof time !== 'string') return NO_VALUE;

  const stored = time.trim();
  if (!STORED_TIME_PATTERN.test(stored)) return NO_VALUE;

  const from = typeof storedTimeZone === 'string' ? storedTimeZone.trim() : '';
  const to = typeof displayTimeZone === 'string' ? displayTimeZone.trim() : '';
  if (from === '' || to === '' || from === to) return twelveHour(stored);

  try {
    return twelveHour(wallClockOf(zonedToInstant(date, stored, from), to).time);
  } catch {
    // A zone this runtime cannot read, or a date that names no calendar date.
    // The stored wall clock is still true, so it is shown rather than withheld.
    return twelveHour(stored);
  }
}

/**
 * A timezone identifier as the place it names: `America/New_York` reads as
 * `New York`, `America/Guayaquil` as `Guayaquil`.
 *
 * Derived from the identifier rather than looked up, so it answers for every zone
 * in the IANA database instead of the three `profiles.timezone` currently holds.
 * The abbreviations it replaces — `ET`, `ECT`, `CST` — were a hardcoded map of
 * those three, and `CST` was wrong for Tegucigalpa half the year in the same way
 * the offsets beside it were.
 *
 * A place name rather than an abbreviation is also the more useful label: it says
 * which clock a time is being read on without asking the reader to know what a
 * three-letter code stands for.
 *
 * Requirements: 2.5, 19.9
 */
export function formatTimeZoneName(timeZone: string | null | undefined): string {
  if (typeof timeZone !== 'string') return '';

  const trimmed = timeZone.trim();
  if (trimmed === '') return '';

  const segments = trimmed.split('/');
  return segments[segments.length - 1].replace(/_/g, ' ');
}

/**
 * A work date as `Mon 11 Aug`.
 *
 * Requirements: 4.19
 */
export function formatWorkDate(date: string): string {
  const fields = dateFields(date);
  if (fields === null) return date;
  return `${weekdayOf(fields).slice(0, 3)} ${fields.day} ${MONTH_NAMES[fields.month]}`;
}

/**
 * A work date in full: `Monday, 11 August 2026`.
 *
 * Used where the date is a heading rather than a row label, so the reader is not
 * left working out which week an abbreviated date belongs to.
 */
export function formatWorkDateLong(date: string): string {
  const fields = dateFields(date);
  if (fields === null) return date;
  return `${weekdayOf(fields)}, ${fields.day} ${MONTH_NAMES_LONG[fields.month]} ${fields.year}`;
}

/**
 * The month a work date falls in: `August 2026`.
 *
 * The heading of a month grid, where the individual dates are the cells and the
 * month is what the grid is called. Any date in the month produces the same
 * answer, so a caller can pass the anchor it already holds rather than
 * constructing the first of the month to ask.
 *
 * Requirements: 8.1
 */
export function formatWorkMonth(date: string): string {
  const fields = dateFields(date);
  if (fields === null) return date;
  return `${MONTH_NAMES_LONG[fields.month]} ${fields.year}`;
}

/**
 * An instant as the calendar date it fell on in a named zone: `Mon 3 Aug`.
 *
 * A stored instant is not a date until a zone is chosen for it, and the zone that
 * makes it meaningful is the one the person it describes lives in — a request
 * submitted at 22:00 in Tegucigalpa was submitted that day, not the next one, and
 * a reader in another country should still see the day the requester submitted it.
 * So the zone is an argument, and callers pass the subject's own
 * `profiles.timezone`, exactly as they do for `formatTimeOfDay`.
 *
 * Requirements: 7.5, 19.9
 */
export function formatInstantDate(value: string | null | undefined, timeZone: string): string {
  const instant = instantOf(value);
  if (instant === null) return NO_VALUE;
  return formatWorkDate(wallClock(instant, timeZone).clock.date);
}

/** A number with at most two decimals and no trailing zeros: `7.5`, `8`, `7.42`. */
function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * An hours figure as `7.5h`.
 *
 * The value is rendered as the record carries it. Hours are rounded to two
 * decimals once, at the domain boundary, so nothing is rounded a second time
 * here beyond dropping the zeros that rounding leaves behind.
 *
 * Requirements: 4.1, 4.4
 */
export function formatHours(hours: number | null | undefined): string {
  if (typeof hours !== 'number' || !Number.isFinite(hours)) return NO_VALUE;
  return `${trimNumber(hours)}h`;
}

/** An hours figure in words, for an accessible name: `7.5 hours`. */
export function hoursPhrase(hours: number | null | undefined): string {
  if (typeof hours !== 'number' || !Number.isFinite(hours)) return 'not recorded';
  const value = Math.round(hours * 100) / 100;
  return `${trimNumber(value)} ${value === 1 ? 'hour' : 'hours'}`;
}

/**
 * A minutes figure as `30m`.
 *
 * Requirements: 4.5
 */
export function formatMinutes(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return NO_VALUE;
  return `${trimNumber(minutes)}m`;
}

/** A minutes figure in words, for an accessible name: `30 minutes`. */
export function minutesPhrase(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return 'not recorded';
  const value = Math.round(minutes * 100) / 100;
  return `${trimNumber(value)} ${value === 1 ? 'minute' : 'minutes'}`;
}

/**
 * A metric or trend figure as the text a control shows: `92.5%`, `7.5h`, `30m`,
 * `12`.
 *
 * The unit travels with the figure on the metric itself, so the spelling is a
 * lookup rather than a decision each view makes for each metric. Overview and
 * Employee Trends both render figures carrying these four units, and a percentage
 * shown as `92.5` in one place and `92.5%` in the other is the kind of
 * disagreement that makes a reader distrust both.
 *
 * Requirements: 13.3, 14.2
 */
export function formatMetricValue(value: number, unit: MetricUnit): string {
  if (!Number.isFinite(value)) return NO_VALUE;

  switch (unit) {
    case 'percent':
      return `${trimNumber(value)}%`;
    case 'hours':
      return formatHours(value);
    case 'minutes':
      return formatMinutes(value);
    case 'count':
      return trimNumber(value);
  }
}

/**
 * The same figure in words, for a control's accessible name.
 *
 * Requirement 13, criterion 6 asks each metric control to carry an accessible
 * name stating the metric label and the metric value, and Requirement 22,
 * criterion 12 asks the same of every metric control. `7.5h` read aloud is "seven
 * point five h", so the spoken form spells the unit out while the visible form
 * stays compact enough for a tile.
 *
 * Requirements: 13.6, 22.12
 */
export function metricValuePhrase(value: number, unit: MetricUnit): string {
  if (!Number.isFinite(value)) return 'not recorded';

  switch (unit) {
    case 'percent':
      return `${trimNumber(value)} per cent`;
    case 'hours':
      return hoursPhrase(value);
    case 'minutes':
      return minutesPhrase(value);
    case 'count':
      return trimNumber(value);
  }
}

/**
 * A count of days as `5 days`, `1 day`, or `0.5 days`.
 *
 * Leave is measured in working days throughout the module — a request's length, a
 * balance, an approved sub-range — so the noun is fixed here rather than chosen
 * per column. Returns `NO_VALUE` for an absent figure, which is what a remaining
 * balance reports when no `pto_balances` row was readable: unknown, rather than
 * none left.
 *
 * Requirements: 7.5, 11.3
 */
export function formatDays(days: number | null | undefined): string {
  if (typeof days !== 'number' || !Number.isFinite(days)) return NO_VALUE;
  const value = Math.round(days * 100) / 100;
  return `${trimNumber(value)} ${value === 1 ? 'day' : 'days'}`;
}

/**
 * An elapsed duration in minutes as the largest whole unit it fills: `4 days`,
 * `5 hours`, `12 minutes`, `under a minute`.
 *
 * Requirement 7, criterion 5 asks the Request_Inbox to show how long a request
 * has been awaiting review, and that figure reaches the row as a minute count.
 * Rendered as minutes it is unreadable — a fortnight is `20160m` — so it is
 * reduced to one unit and floored to it.
 *
 * Floored rather than rounded, and one unit rather than two, because this is an
 * age: `4 days` for a request submitted four days and twenty hours ago
 * understates it by hours and never overstates it, which is the safe direction
 * for a queue an administrator is triaging. The precise instant is on the row
 * beside it as the submission date.
 *
 * Words rather than `4d 2h`, because the figure sits inside a row that is itself
 * one control: whatever is written here is read aloud as part of that control's
 * accessible name (Requirement 22, criterion 12).
 *
 * Requirements: 7.5, 22.12
 */
export function formatElapsedMinutes(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return NO_VALUE;
  if (minutes < 1) return 'under a minute';

  const wholeMinutes = Math.floor(minutes);
  if (wholeMinutes < 60) return `${wholeMinutes} ${wholeMinutes === 1 ? 'minute' : 'minutes'}`;

  const hours = Math.floor(wholeMinutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;

  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

// ─── The date-and-time picker's own spelling ──────────────────────────────────
//
// `nhwd-shared/DateTimePicker` holds a wall clock as `YYYY-MM-DDTHH:mm`, and the
// correction endpoints take instants. Both drawers that submit a punch correction
// need the same two conversions, so they live here rather than once in each: two
// copies of a timezone adapter is exactly the situation Requirement 19, criteria 9
// and 10 exist to prevent, and both directions go through `domain/work-date.ts`
// either way.
//
// These are spellings, not derivations. Nothing here decides what an instant
// means; it decides how an instant is written into a form field, and how a form
// field is read back.
//
// Requirements: 5.15, 12.12, 19.9, 19.10

/**
 * An instant as the `YYYY-MM-DDTHH:mm` the picker holds, read in `timeZone`.
 *
 * Returns the empty string for an absent or unreadable instant, and for a zone
 * this runtime cannot read — an empty picker is the honest state for a value that
 * could not be placed on a clock.
 *
 * The zone to pass is the employee's own `profiles.timezone`, so an administrator
 * types the time the employee's clock showed rather than the time on their own.
 *
 * Requirements: 19.9
 */
export function toDateTimePickerValue(instant: string | null, timeZone: string): string {
  const parsed = instantOf(instant);
  if (parsed === null) return '';

  try {
    const clock = wallClockOf(parsed, timeZone);
    return `${clock.date}T${clock.time.slice(0, 5)}`;
  } catch {
    return '';
  }
}

/**
 * The picker's wall clock as an ISO instant, or null when it cannot be read.
 *
 * Null covers all three ways it can fail: an incomplete pair, a value naming no
 * date, and a zone this runtime does not know. A caller states that as a field
 * error rather than submitting a guess.
 *
 * Requirements: 19.10
 */
export function fromDateTimePickerValue(
  pickerValue: string,
  timeZone: string,
): string | null {
  const [date, time] = pickerValue.split('T');
  if (date === undefined || time === undefined || date === '' || time === '') return null;

  try {
    return zonedToInstant(date, `${time.slice(0, 5)}:00`, timeZone).toISOString();
  } catch {
    return null;
  }
}

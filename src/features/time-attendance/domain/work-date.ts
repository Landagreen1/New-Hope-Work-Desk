// src/features/time-attendance/domain/work-date.ts
// The single implementation of both timezone conversions the attendance module
// performs: instant -> calendar work date, and zoned wall clock -> instant.
// Calendar-date arithmetic lives here too, because stepping from one date to the
// next is the third way a caller could otherwise reinvent date handling.
//
// Nothing else in the module is allowed to convert between an instant and a
// calendar date or a wall-clock time, or to step a calendar date. That is what
// removes the two conflicting bucketing conventions and the hardcoded offsets
// the redesign replaces.
//
// Pure: no I/O, no `Date.now()`, no reads of `process.env`. Every result is a
// function of the arguments alone, so the same inputs always produce the same
// output regardless of the timezone the process happens to run in.
//
// No date library. Conversion is built on `Intl.DateTimeFormat`, which is
// available in the Node runtime these routes declare.
//
// Requirements: 3.6 (clock instant -> work date in the employee timezone),
// 3.7 (schedules interpreted in the business timezone across DST),
// 18.2 (seven consecutive dates from a start date),
// 19.9 (one employee-timezone conversion), 19.10 (one instant -> work date map).

/**
 * A wall-clock reading in a named zone: the calendar date and the time of day
 * a clock on the wall in that zone shows at some instant.
 *
 * `zonedToInstant` and `wallClockOf` are inverses, except inside a
 * spring-forward gap where no instant carries the requested wall clock. See
 * `zonedToInstant` for what happens there.
 */
export interface ZonedWallClock {
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:MM:SS`, 24-hour, zero-padded */
  time: string;
}

/** Numeric wall-clock fields, the form the offset probe works in. */
interface ZonedFields {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// `HH:MM`, `HH:MM:SS`, or `HH:MM:SS.fff`. Postgres `time` columns arrive as
// `HH:MM:SS`; the schedule form submits `HH:MM`.
const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;

/**
 * Formatters are cached per zone. Construction dominates the cost of a
 * conversion and the derivation calls this per row over a 90-day window.
 * Caching is invisible to callers: a formatter is a pure function of the zone.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * `en-CA` orders date fields year-month-day, so the parts come back in ISO
 * order. Explicit numeric fields are used rather than `dateStyle: 'short'`
 * because `dateStyle` cannot be combined with the time fields the offset probe
 * needs, and because explicit fields pin zero-padding instead of inheriting
 * whatever the locale's short-date pattern does. The formatted date is the
 * same either way.
 *
 * `hourCycle: 'h23'` keeps midnight at `00` rather than `24`. `hour12: false`
 * is deliberately not set: it would let the locale pick `h24` instead.
 */
function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  // Throws RangeError for an unknown zone, which is the right failure and is
  // deliberately not cached.
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** Wall-clock fields for an instant in a named zone. */
function zonedFields(epochMs: number, timeZone: string): ZonedFields {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(epochMs));

  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;

  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      default:
        break;
    }
  }

  // Defensive: an ICU build that answers with the `h24` convention reports
  // midnight as hour 24 on the same calendar date, so 24 means 0 here.
  if (hour === 24) hour = 0;

  return { year, month, day, hour, minute, second };
}

/**
 * Offset of `timeZone` at an instant, in milliseconds, signed the way a
 * wall clock reads: `wallClockAsUtc - instant`. New York in winter is
 * -5 hours, in summer -4 hours.
 *
 * The instant is floored to the second before probing because the formatter
 * has second resolution; without the floor a sub-second instant would report
 * an offset short by its millisecond remainder. Zone offsets are whole
 * minutes, so nothing is lost.
 */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const flooredMs = Math.floor(epochMs / 1000) * 1000;
  const f = zonedFields(flooredMs, timeZone);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - flooredMs;
}

function assertValidInstant(instant: Date): number {
  const epochMs = instant.getTime();
  if (!Number.isFinite(epochMs)) {
    throw new RangeError('work-date: instant is not a valid Date');
  }
  return epochMs;
}

/**
 * The calendar date an instant falls on in a named zone, as `YYYY-MM-DD`.
 *
 * This is the mapping from a clock instant to a work date (Requirement 3,
 * criterion 6): pass the employee's `profiles.timezone`. Because the zone is
 * an explicit argument, the answer never depends on the process timezone,
 * which is Correctness Property 6.
 *
 * @throws RangeError if `instant` is an invalid Date or `timeZone` is unknown.
 */
export function workDateOf(instant: Date, timeZone: string): string {
  const epochMs = assertValidInstant(instant);
  const f = zonedFields(epochMs, timeZone);
  return formatDateFields(f);
}

/**
 * The full wall-clock reading of an instant in a named zone: the inverse of
 * `zonedToInstant`, and the one conversion used to display an instant in an
 * employee's timezone (Requirement 19, criterion 9).
 *
 * @throws RangeError if `instant` is an invalid Date or `timeZone` is unknown.
 */
export function wallClockOf(instant: Date, timeZone: string): ZonedWallClock {
  const epochMs = assertValidInstant(instant);
  const f = zonedFields(epochMs, timeZone);
  return { date: formatDateFields(f), time: formatTimeFields(f) };
}

/**
 * The calendar date `days` after `date`, as `YYYY-MM-DD`.
 *
 * Calendar arithmetic, not instant arithmetic. No timezone is involved and no
 * hour is implied, so stepping across a daylight-saving transition still
 * advances by exactly one date — which is what a seven-day strip of dates and a
 * working-day count need. Adding 86,400,000 milliseconds to an instant does not
 * do this: on a spring-forward date it lands on the same calendar date at a
 * different hour.
 *
 * `days` may be negative to step backwards. Zero validates `date` and returns
 * it unchanged, which is the cheapest way for a caller to reject a malformed
 * date.
 *
 * Month, year, and leap-year rollover come out of the step itself:
 * `addCalendarDays('2024-02-28', 2)` is `'2024-03-01'` because 2024 has a 29th,
 * and `addCalendarDays('2026-02-28', 2)` is `'2026-03-02'` because 2026 has not.
 *
 * @throws RangeError if `date` is malformed or is not a real calendar date, if
 *   `days` is not a safe integer, or if the result falls outside the four-digit
 *   year range the `YYYY-MM-DD` format can express.
 */
export function addCalendarDays(date: string, days: number): string {
  if (!Number.isSafeInteger(days)) {
    throw new RangeError(`addCalendarDays: days must be an integer, received ${days}`);
  }

  const { year, month, day } = parseCalendarDate(date, 'addCalendarDays');
  const stepped = utcMidnight(year, month, day + days);

  if (!Number.isFinite(stepped.getTime())) {
    throw new RangeError(`addCalendarDays: "${date}" plus ${days} days is not a calendar date`);
  }

  const steppedYear = stepped.getUTCFullYear();
  if (steppedYear < 0 || steppedYear > 9999) {
    throw new RangeError(`addCalendarDays: "${date}" plus ${days} days is outside YYYY-MM-DD`);
  }

  return `${pad(steppedYear, 4)}-${pad(stepped.getUTCMonth() + 1, 2)}-${pad(stepped.getUTCDate(), 2)}`;
}

/**
 * `count` consecutive calendar dates beginning at `date`, ascending.
 *
 * Each date is computed from `date` by offset rather than from its predecessor,
 * so no error can accumulate across the run.
 *
 * @throws RangeError if `date` is malformed, `count` is not a non-negative safe
 *   integer, or any produced date falls outside `YYYY-MM-DD`.
 */
export function consecutiveDates(date: string, count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`consecutiveDates: count must be a non-negative integer, received ${count}`);
  }

  const dates: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    dates.push(addCalendarDays(date, offset));
  }
  return dates;
}

/**
 * The calendar fields of a `YYYY-MM-DD` date.
 *
 * Rejects a string that matches the shape but names no real date, such as
 * `2024-02-30`, instead of silently rolling into the following month. The
 * caller's name is threaded through so the message says which entry point was
 * called.
 */
function parseCalendarDate(
  date: string,
  context: string,
): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(date);
  if (!match) {
    throw new RangeError(`${context}: date must be YYYY-MM-DD, received "${date}"`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const probe = utcMidnight(year, month, day);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new RangeError(`${context}: "${date}" is not a calendar date`);
  }

  return { year, month, day };
}

/**
 * Midnight UTC on the given calendar fields, with `day` allowed to overflow or
 * underflow its month.
 *
 * `setUTCFullYear` rather than `Date.UTC` because `Date.UTC` maps years 0
 * through 99 into the 1900s, which would quietly rewrite a year the four-digit
 * pattern accepts.
 */
function utcMidnight(year: number, month: number, day: number): Date {
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return probe;
}

function formatDateFields(f: ZonedFields): string {
  return `${pad(f.year, 4)}-${pad(f.month, 2)}-${pad(f.day, 2)}`;
}

function formatTimeFields(f: ZonedFields): string {
  return `${pad(f.hour, 2)}:${pad(f.minute, 2)}:${pad(f.second, 2)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * The instant at which a wall clock in `timeZone` reads `date` and `time`,
 * daylight saving included.
 *
 * This is how a schedule row becomes an instant: `shift_start` and `shift_end`
 * are wall-clock times in the business timezone `America/New_York`
 * (Requirement 3, criterion 7).
 *
 * `date` is `YYYY-MM-DD`. `time` is `HH:MM`, `HH:MM:SS`, or `HH:MM:SS.fff`;
 * `24:00` and `24:00:00` are accepted and mean midnight ending `date`, which
 * is how Postgres can hand back a `time` column.
 *
 * ## How it works
 *
 * A wall clock cannot be turned into an instant by string parsing, because the
 * offset to apply depends on the instant being computed. So the offset is
 * probed instead:
 *
 * 1. Treat the requested wall clock as if it were UTC. Call that `target`.
 * 2. Read the zone's offset at `target`, and subtract it. That is the first
 *    candidate.
 * 3. Read the offset again at the candidate. If it matches the offset already
 *    applied, the candidate reads back as the requested wall clock and is the
 *    answer.
 * 4. Otherwise the first probe landed on the far side of a daylight-saving
 *    transition. Apply the newly read offset to `target` instead. One repeat
 *    is enough: the second probe is taken from an instant within an hour of
 *    the requested wall clock, so it reads the offset actually in force there.
 *
 * ## Daylight-saving edges
 *
 * **Spring-forward gap.** The requested wall clock may not exist at all: on
 * 2024-03-10 in New York the clocks jump from 01:59:59 to 03:00:00, so 02:30
 * never happens. Neither candidate can read back as 02:30. The gap is detected
 * (both candidates fail the read-back check) and the result is the instant
 * immediately after the transition, 03:00:00 local. That is documented,
 * deterministic behaviour, not an error: a schedule with a shift start inside
 * the gap starts when the clocks reach the far side of it. The exact
 * transition instant is found by bisecting between the two failed candidates,
 * which is exact to the millisecond.
 *
 * **Fall-back overlap.** The requested wall clock may exist twice: on
 * 2024-11-03 in New York, 01:30 happens once in EDT and again in EST. The
 * first probe already reads the earlier offset, so the earlier of the two
 * instants is returned. Round-tripping still recovers the requested wall
 * clock.
 *
 * @throws RangeError if `date` or `time` is malformed, `date` is not a real
 *   calendar date, or `timeZone` is unknown.
 */
export function zonedToInstant(date: string, time: string, timeZone: string): Date {
  const target = parseWallClockAsUtc(date, time);

  // Pass 1: probe the offset where the wall clock would sit if it were UTC.
  const firstOffset = zoneOffsetMs(target, timeZone);
  const firstCandidate = target - firstOffset;
  if (zoneOffsetMs(firstCandidate, timeZone) === firstOffset) {
    return new Date(firstCandidate);
  }

  // Pass 2: the first probe crossed a transition. Re-apply the offset that is
  // in force at the first candidate.
  const secondOffset = zoneOffsetMs(firstCandidate, timeZone);
  const secondCandidate = target - secondOffset;
  if (zoneOffsetMs(secondCandidate, timeZone) === secondOffset) {
    return new Date(secondCandidate);
  }

  // Neither candidate reads back as the requested wall clock, so the wall
  // clock does not exist: a spring-forward gap. Resolve to the first instant
  // on the far side of the transition.
  return new Date(firstInstantAfterTransition(secondCandidate, firstCandidate, timeZone));
}

/**
 * The first instant at or after `min(a, b)` whose offset differs from the
 * offset at `min(a, b)`, found by bisection.
 *
 * Called only from the spring-forward gap branch, where the two candidates
 * straddle the transition. Offsets change on whole seconds, and the probe
 * floors to the second, so the search converges on the exact transition
 * instant.
 */
function firstInstantAfterTransition(a: number, b: number, timeZone: string): number {
  let low = Math.min(a, b);
  let high = Math.max(a, b);

  const lowOffset = zoneOffsetMs(low, timeZone);
  if (zoneOffsetMs(high, timeZone) === lowOffset) {
    // No transition between the candidates. Not reachable for any zone in the
    // IANA database via the gap branch; returning the later candidate keeps
    // the function total and deterministic.
    return high;
  }

  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (zoneOffsetMs(mid, timeZone) === lowOffset) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return high;
}

/** The requested wall clock as an epoch value, read as though it were UTC. */
function parseWallClockAsUtc(date: string, time: string): number {
  // Rejects a date that passes the pattern but is not a real calendar date,
  // such as 2024-02-30, instead of silently rolling into the next month.
  const { year, month, day } = parseCalendarDate(date, 'zonedToInstant');

  const timeMatch = TIME_PATTERN.exec(time);
  if (!timeMatch) {
    throw new RangeError(
      `zonedToInstant: time must be HH:MM, HH:MM:SS, or HH:MM:SS.fff, received "${time}"`,
    );
  }

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = timeMatch[3] === undefined ? 0 : Number(timeMatch[3]);
  const millisecond =
    timeMatch[4] === undefined ? 0 : Number(timeMatch[4].slice(0, 3).padEnd(3, '0'));

  if (minute > 59 || second > 59) {
    throw new RangeError(`zonedToInstant: time "${time}" is out of range`);
  }
  // 24:00 and 24:00:00 mean midnight ending `date`; any other hour past 23 is
  // not a time of day.
  if (hour > 24 || (hour === 24 && (minute !== 0 || second !== 0 || millisecond !== 0))) {
    throw new RangeError(`zonedToInstant: time "${time}" is out of range`);
  }

  // Hour 24 rolls into the following date, which is what `24:00` means.
  const probe = utcMidnight(year, month, day);
  probe.setUTCHours(hour, minute, second, millisecond);
  return probe.getTime();
}

// src/features/time-attendance/domain/__tests__/arbitraries.ts
// Shared fast-check generators for the time & attendance property suite.
//
// This module contains generators only: no `describe`, no `it`, no assertions.
// Every property test in `domain/__tests__/` draws its inputs from here so that
// a failure in one property and a failure in another are describing the same
// input space.
//
// Three deliberate choices shape this file:
//
// 1. Instants are clustered, not uniform. Uniform random instants across a
//    four-year window almost never land on a date boundary or inside a
//    daylight-saving transition, which is exactly where the work-date and
//    schedule-conversion bugs live. `instantArb` therefore draws from four
//    clusters: local midnight, both Eastern daylight-saving transitions,
//    typical scheduled shift boundaries, and a uniform tail so the space is
//    not only the clusters.
//
// 2. No `fc.date`. `fc.date` yields `Invalid Date` unless `noInvalidDate` is
//    set, and an invalid date throws the moment a generator calls
//    `toISOString()`. `src/features/cs-intake/__tests__/quote-visibility-bug-exploration.test.ts`
//    fails intermittently for exactly that reason. Every instant here is built
//    by integer millisecond arithmetic from a bounded anchor, so validity is
//    structural rather than filtered.
//
// 3. The zone offset table below is local on purpose. Generators must not be
//    built out of `domain/work-date.ts`, because Properties 6 and 7 test that
//    module; feeding it its own output would make the tests circular. The
//    table is a fixture of published Eastern transition instants, not a second
//    implementation of the conversion.
//
// Requirements: 23.9

import fc from 'fast-check';
import { APP_ROLES } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';
import type { RecordSubject, RecordSubjectIndex } from '../attendance';
import type {
  AttendanceInputs,
  AttendancePolicy,
  ClockSessionInput,
  Threshold,
} from '../types';
import type { BreakType, Department, PTOType, ScheduleStatus, ShiftType } from '../../types';
import { DEPARTMENT_LABELS, PTO_TYPE_LABELS, SHIFT_TYPE_LABELS } from '../../types';

// ─── Zones and the generated window ──────────────────────────────────────────

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Schedules are interpreted in the business timezone (Requirement 3.7). */
export const BUSINESS_TIMEZONE = 'America/New_York';

/**
 * The zones `profiles.timezone` actually holds, set by `v1.7.3`. Property 6
 * quantifies over "any employee timezone from the deployed set", and this is
 * that set.
 */
export const DEPLOYED_TIMEZONES = [
  'America/New_York',
  'America/Guayaquil',
  'America/Tegucigalpa',
] as const;

export type DeployedTimeZone = (typeof DEPLOYED_TIMEZONES)[number];

/**
 * Eastern daylight-saving transition instants as UTC milliseconds. Spring
 * forward is 02:00 EST (UTC-5) on the second Sunday in March; fall back is
 * 02:00 EDT (UTC-4) on the first Sunday in November.
 *
 * These are the anchors the daylight-saving cluster of `instantArb` jitters
 * around, and they bound the window `instantArb` generates within.
 */
export const EASTERN_DST_WINDOWS: readonly { springForward: number; fallBack: number }[] = [
  { springForward: Date.UTC(2024, 2, 10, 7), fallBack: Date.UTC(2024, 10, 3, 6) },
  { springForward: Date.UTC(2025, 2, 9, 7), fallBack: Date.UTC(2025, 10, 2, 6) },
  { springForward: Date.UTC(2026, 2, 8, 7), fallBack: Date.UTC(2026, 10, 1, 6) },
  { springForward: Date.UTC(2027, 2, 14, 7), fallBack: Date.UTC(2027, 10, 7, 6) },
];

/** Both transitions of every covered year, flattened, for the cluster anchor. */
export const EASTERN_DST_TRANSITIONS: readonly number[] = EASTERN_DST_WINDOWS.flatMap(
  (w) => [w.springForward, w.fallBack],
);

/** Guayaquil and Tegucigalpa observe no daylight saving. */
const FIXED_ZONE_OFFSET_MINUTES: Readonly<Record<string, number | undefined>> = {
  'America/Guayaquil': -300,
  'America/Tegucigalpa': -360,
};

/**
 * Offset of `timeZone` at an instant, in minutes east of UTC.
 *
 * Fixture, not a conversion library: the two southern zones are constant, and
 * Eastern is read off `EASTERN_DST_WINDOWS`. Any zone name outside the
 * deployed set is treated as Eastern. Instants outside the covered years are
 * reported as standard time, which is why the generators stay inside the
 * window the table covers.
 */
export function zoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const fixed = FIXED_ZONE_OFFSET_MINUTES[timeZone];
  if (fixed !== undefined) return fixed;
  const inDaylightSaving = EASTERN_DST_WINDOWS.some(
    (w) => utcMs >= w.springForward && utcMs < w.fallBack,
  );
  return inDaylightSaving ? -240 : -300;
}

/** First and last calendar day the generators produce, as UTC midnight. */
const FIRST_DAY_MS = Date.UTC(2024, 0, 1);
const LAST_DAY_MS = Date.UTC(2027, 11, 31);

/** Number of distinct calendar dates in the generated window (1461). */
export const GENERATED_DAY_COUNT = (LAST_DAY_MS - FIRST_DAY_MS) / DAY_MS + 1;

const FIRST_DAY_WEEKDAY = new Date(FIRST_DAY_MS).getUTCDay();

/** `YYYY-MM-DD` for a zero-based day index into the generated window. */
export function dayIndexToDate(index: number): string {
  return new Date(FIRST_DAY_MS + index * DAY_MS).toISOString().slice(0, 10);
}

/** Day of week (0 = Sunday) for a day index, without constructing a Date. */
export function weekdayOfDayIndex(index: number): number {
  return (FIRST_DAY_WEEKDAY + index) % 7;
}

const FIRST_SATURDAY_INDEX = (6 - FIRST_DAY_WEEKDAY + 7) % 7;

/**
 * Instant of a wall clock in a named zone, by the same two-pass offset probe
 * the design specifies for `zonedToInstant`, run against the local offset
 * table. A wall clock inside the spring-forward gap converges on the instant
 * immediately after the transition, which is the documented resolution.
 */
function zonedWallClockToMs(dayIndex: number, minutesOfDay: number, timeZone: string): number {
  const asIfUtc = FIRST_DAY_MS + dayIndex * DAY_MS + minutesOfDay * MINUTE_MS;
  const firstPass = asIfUtc - zoneOffsetMinutes(asIfUtc, timeZone) * MINUTE_MS;
  return asIfUtc - zoneOffsetMinutes(firstPass, timeZone) * MINUTE_MS;
}

/**
 * Shift boundaries the roster actually uses, in minutes past local midnight.
 * `instantArb` clusters around these and `scheduleArb` draws from them, so a
 * generated clock-in lands near a generated scheduled start often enough for
 * the grace-period and early-departure rules to be exercised.
 */
export const SCHEDULE_BOUNDARY_MINUTES: readonly number[] = [
  8 * 60, 8 * 60 + 30, 9 * 60, 12 * 60, 12 * 60 + 30,
  13 * 60, 17 * 60, 17 * 60 + 30, 17 * 60 + 50, 18 * 60,
];

// ─── Primitive generators ────────────────────────────────────────────────────

const dayIndexArb = fc.integer({ min: 0, max: GENERATED_DAY_COUNT - 1 });

/** A zone from the deployed set. */
export const timeZoneArb: fc.Arbitrary<DeployedTimeZone> = fc.constantFrom(...DEPLOYED_TIMEZONES);

/** A calendar work date, `YYYY-MM-DD`, always a real date. */
export const workDateArb: fc.Arbitrary<string> = dayIndexArb.map(dayIndexToDate);

export const breakTypeArb: fc.Arbitrary<BreakType> = fc.constantFrom(
  ...(['lunch', 'short', 'personal'] as const satisfies readonly BreakType[]),
);

/** Drawn from `SHIFT_TYPE_LABELS` so a shift type added later is covered. */
export const shiftTypeArb: fc.Arbitrary<ShiftType> = fc.constantFrom(
  ...(Object.keys(SHIFT_TYPE_LABELS) as ShiftType[]),
);

/**
 * Weighted toward `published` and `scheduled`, because those are the statuses
 * the status matrix and the payroll-blocking classification branch on.
 */
export const scheduleStatusArb: fc.Arbitrary<ScheduleStatus> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<ScheduleStatus>('published') },
  { weight: 3, arbitrary: fc.constant<ScheduleStatus>('scheduled') },
  { weight: 1, arbitrary: fc.constant<ScheduleStatus>('completed') },
  { weight: 1, arbitrary: fc.constant<ScheduleStatus>('missed') },
  { weight: 1, arbitrary: fc.constant<ScheduleStatus>('cancelled') },
);

/** Every application role, drawn from `APP_ROLES` rather than a copy of it. */
export const roleArb: fc.Arbitrary<AppRole> = fc.constantFrom(...APP_ROLES);

const nonEmptyTextArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

// ─── instantArb ──────────────────────────────────────────────────────────────

/** Local midnight in a deployed zone, jittered across the date boundary. */
const midnightClusterArb = fc
  .tuple(dayIndexArb, timeZoneArb, fc.integer({ min: -90, max: 90 }))
  .map(([dayIndex, timeZone, jitterMinutes]) =>
    zonedWallClockToMs(dayIndex, 0, timeZone) + jitterMinutes * MINUTE_MS,
  );

/** Either daylight-saving transition, jittered across the discontinuity. */
const dstClusterArb = fc
  .tuple(fc.constantFrom(...EASTERN_DST_TRANSITIONS), fc.integer({ min: -150, max: 150 }))
  .map(([transitionMs, jitterMinutes]) => transitionMs + jitterMinutes * MINUTE_MS);

/** A typical scheduled boundary in a deployed zone, jittered around it. */
const scheduleBoundaryClusterArb = fc
  .tuple(
    dayIndexArb,
    timeZoneArb,
    fc.constantFrom(...SCHEDULE_BOUNDARY_MINUTES),
    fc.integer({ min: -45, max: 45 }),
  )
  .map(([dayIndex, timeZone, boundaryMinutes, jitterMinutes]) =>
    zonedWallClockToMs(dayIndex, boundaryMinutes, timeZone) + jitterMinutes * MINUTE_MS,
  );

/** The uniform tail, so the clusters are not the whole input space. */
const uniformInstantArb = fc
  .tuple(dayIndexArb, fc.integer({ min: 0, max: 24 * 60 - 1 }))
  .map(([dayIndex, minutesOfDay]) => FIRST_DAY_MS + dayIndex * DAY_MS + minutesOfDay * MINUTE_MS);

const instantMsArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: midnightClusterArb },
  { weight: 3, arbitrary: dstClusterArb },
  { weight: 3, arbitrary: scheduleBoundaryClusterArb },
  { weight: 2, arbitrary: uniformInstantArb },
);

/**
 * A clock instant, clustered on local midnight, both daylight-saving
 * transitions, and scheduled boundaries. Always a valid `Date`: every value is
 * a bounded integer millisecond offset from a fixed anchor.
 */
export const instantArb: fc.Arbitrary<Date> = instantMsArb.map((ms) => new Date(ms));

/** The same instants as ISO strings, the form the domain input types carry. */
export const isoInstantArb: fc.Arbitrary<string> = instantMsArb.map((ms) =>
  new Date(ms).toISOString(),
);

// ─── Clock sessions ──────────────────────────────────────────────────────────

type BreakInput = ClockSessionInput['breaks'][number];

/**
 * How one break behaves. `ended_without_duration` is the null-duration edge
 * case the design folds into the generators rather than writing as its own
 * test; `open` is an unended break, which is only ever the last break on a
 * session.
 */
interface BreakSpec {
  id: string;
  type: BreakType;
  gapMinutes: number;
  lengthMinutes: number;
  ending: 'ended' | 'ended_without_duration' | 'open';
}

const breakSpecArb: fc.Arbitrary<BreakSpec> = fc.record({
  id: fc.uuid(),
  type: breakTypeArb,
  gapMinutes: fc.integer({ min: 1, max: 45 }),
  lengthMinutes: fc.integer({ min: 5, max: 75 }),
  ending: fc.oneof(
    { weight: 6, arbitrary: fc.constant('ended' as const) },
    { weight: 1, arbitrary: fc.constant('ended_without_duration' as const) },
    { weight: 2, arbitrary: fc.constant('open' as const) },
  ),
});

/** Everything about a session except where on the clock it sits. */
interface SessionSpec {
  spanMinutes: number;
  open: boolean;
  breaks: BreakSpec[];
  adjustment: { by: string; reason: string } | null;
}

const sessionSpecArb: fc.Arbitrary<SessionSpec> = fc.record({
  spanMinutes: fc.integer({ min: 15, max: 13 * 60 }),
  open: fc.oneof(
    { weight: 3, arbitrary: fc.constant(false) },
    { weight: 1, arbitrary: fc.constant(true) },
  ),
  breaks: fc.array(breakSpecArb, { maxLength: 3 }),
  adjustment: fc.oneof(
    { weight: 4, arbitrary: fc.constant(null) },
    { weight: 1, arbitrary: fc.record({ by: fc.uuid(), reason: nonEmptyTextArb }) },
  ),
});

/**
 * Places breaks sequentially inside the session span. Specs that no longer fit
 * are dropped rather than clamped, which keeps shrinking readable, and an
 * unended break terminates the list because a later break could not have
 * started while one was still open.
 */
function buildBreaks(
  clockInMs: number,
  spanMinutes: number,
  specs: readonly BreakSpec[],
): BreakInput[] {
  const breaks: BreakInput[] = [];
  let cursorMinutes = 0;

  for (const spec of specs) {
    const startMinutes = cursorMinutes + spec.gapMinutes;
    if (startMinutes + spec.lengthMinutes > spanMinutes) break;

    const start = new Date(clockInMs + startMinutes * MINUTE_MS).toISOString();

    if (spec.ending === 'open') {
      breaks.push({ id: spec.id, type: spec.type, start, end: null, durationMinutes: null });
      break;
    }

    const endMinutes = startMinutes + spec.lengthMinutes;
    breaks.push({
      id: spec.id,
      type: spec.type,
      start,
      end: new Date(clockInMs + endMinutes * MINUTE_MS).toISOString(),
      durationMinutes: spec.ending === 'ended' ? spec.lengthMinutes : null,
    });
    cursorMinutes = endMinutes;
  }

  return breaks;
}

type SessionShape = 'as_spec' | 'force_closed' | 'negative_duration';

function buildSession(
  id: string,
  clockInMs: number,
  spec: SessionSpec,
  shape: SessionShape = 'as_spec',
): ClockSessionInput {
  const closedOutMs = clockInMs + spec.spanMinutes * MINUTE_MS;
  const clockOutMs =
    shape === 'negative_duration'
      ? clockInMs - spec.spanMinutes * MINUTE_MS
      : shape === 'force_closed' || !spec.open
        ? closedOutMs
        : null;

  return {
    id,
    clockIn: new Date(clockInMs).toISOString(),
    clockOut: clockOutMs === null ? null : new Date(clockOutMs).toISOString(),
    breaks: buildBreaks(clockInMs, spec.spanMinutes, spec.breaks),
    adjustedBy: spec.adjustment?.by ?? null,
    adjustmentReason: spec.adjustment?.reason ?? null,
  };
}

/**
 * One well-formed clock session: a clustered clock-in, an optional clock-out,
 * a break multiset across all three break types, and an optional unended
 * break. Breaks always sit inside the session span.
 */
export const clockSessionArb: fc.Arbitrary<ClockSessionInput> = fc
  .tuple(fc.uuid(), instantMsArb, sessionSpecArb)
  .map(([id, clockInMs, spec]) => buildSession(id, clockInMs, spec));

/**
 * A set of sessions on one work date that never overlap: sorted ascending,
 * separated by at least five minutes, and open in the last position only.
 * This is the input shape the well-formed hours properties need, since an
 * overlap would make the worked-hours bound false by construction.
 */
export const nonOverlappingSessionSetArb: fc.Arbitrary<ClockSessionInput[]> = fc
  .tuple(
    instantMsArb,
    fc.array(fc.tuple(fc.uuid(), sessionSpecArb, fc.integer({ min: 5, max: 120 })), {
      minLength: 1,
      maxLength: 4,
    }),
  )
  .map(([firstClockInMs, entries]) => {
    const sessions: ClockSessionInput[] = [];
    let cursorMs = firstClockInMs;

    entries.forEach(([id, spec, gapMinutes], index) => {
      const clockInMs = index === 0 ? cursorMs : cursorMs + gapMinutes * MINUTE_MS;
      const isLast = index === entries.length - 1;
      sessions.push(buildSession(id, clockInMs, spec, isLast ? 'as_spec' : 'force_closed'));
      cursorMs = clockInMs + spec.spanMinutes * MINUTE_MS;
    });

    return sessions;
  });

/**
 * A set of sessions with no well-formedness guarantee. Every session hangs off
 * one anchor within twelve hours, so overlaps, duplicate clock-ins, several
 * open sessions at once, and arbitrary ordering are all common. Roughly one
 * session in ten is inverted, clocking out before it clocked in.
 *
 * This is the generator for the `needs_review` classification path and for the
 * overlapping-session and negative-duration exception rules. It includes the
 * empty set.
 */
export const anySessionSetArb: fc.Arbitrary<ClockSessionInput[]> = fc
  .tuple(
    instantMsArb,
    fc.array(
      fc.tuple(
        fc.uuid(),
        sessionSpecArb,
        fc.integer({ min: -720, max: 720 }),
        fc.oneof(
          { weight: 9, arbitrary: fc.constant(false) },
          { weight: 1, arbitrary: fc.constant(true) },
        ),
      ),
      { maxLength: 4 },
    ),
  )
  .map(([anchorMs, entries]) =>
    entries.map(([id, spec, offsetMinutes, inverted]) =>
      buildSession(
        id,
        anchorMs + offsetMinutes * MINUTE_MS,
        spec,
        inverted ? 'negative_duration' : 'as_spec',
      ),
    ),
  );

// ─── Schedules ───────────────────────────────────────────────────────────────

/** The schedule shape `AttendanceInputs` carries, with wall-clock `HH:MM:SS`. */
export type ScheduleInput = NonNullable<AttendanceInputs['schedule']>;

function formatWallClock(minutesOfDay: number): string {
  const hours = Math.floor(minutesOfDay / 60);
  const minutes = minutesOfDay % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
}

const boundaryMinutesArb = fc.constantFrom(...SCHEDULE_BOUNDARY_MINUTES);

function scheduleFrom(startMinutes: number, endMinutes: number) {
  return fc
    .tuple(shiftTypeArb, scheduleStatusArb)
    .map(([shiftType, status]): ScheduleInput => ({
      start: formatWallClock(startMinutes),
      end: formatWallClock(endMinutes),
      shiftType,
      status,
    }));
}

/** A same-day shift drawn from the boundaries the roster actually uses. */
const boundaryScheduleArb = fc
  .tuple(boundaryMinutesArb, boundaryMinutesArb)
  .filter(([start, end]) => end > start)
  .chain(([start, end]) => scheduleFrom(start, end));

/** A same-day shift at an arbitrary minute, so the boundaries are not the space. */
const arbitrarySameDayScheduleArb = fc
  .integer({ min: 0, max: 20 * 60 })
  .chain((start) =>
    fc
      .integer({ min: 30, max: 24 * 60 - 1 - start })
      .chain((length) => scheduleFrom(start, start + length)),
  );

/** An overnight shift: the end time is strictly before the start time. */
const overnightScheduleArb = fc
  .integer({ min: 12 * 60, max: 24 * 60 - 1 })
  .chain((start) =>
    fc.integer({ min: 0, max: Math.min(start - 1, 12 * 60) }).chain((end) => scheduleFrom(start, end)),
  );

/** A shift whose end equals its start, the degenerate overnight boundary. */
const zeroLengthScheduleArb = fc
  .integer({ min: 0, max: 24 * 60 - 1 })
  .chain((minutes) => scheduleFrom(minutes, minutes));

/**
 * A published or draft shift: same-day, overnight, or with its end equal to
 * its start. Overnight detection is `end <= start`, so the equal case belongs
 * to the same branch of the rule and is generated often enough to matter.
 */
export const scheduleArb: fc.Arbitrary<ScheduleInput> = fc.oneof(
  { weight: 4, arbitrary: boundaryScheduleArb },
  { weight: 2, arbitrary: arbitrarySameDayScheduleArb },
  { weight: 2, arbitrary: overnightScheduleArb },
  { weight: 1, arbitrary: zeroLengthScheduleArb },
);

/** A schedule or none, since an unscheduled work date is a first-class input. */
export const optionalScheduleArb: fc.Arbitrary<ScheduleInput | null> = fc.oneof(
  { weight: 4, arbitrary: scheduleArb },
  { weight: 1, arbitrary: fc.constant(null) },
);

// ─── Attendance policy ───────────────────────────────────────────────────────

/**
 * `policy.unpaidBreakTypes`, weighted toward the deployed value `['lunch']`
 * (Requirement 3.10). The other splits are generated too, because the
 * arithmetic classifies a break against the policy rather than against the
 * literal type name, and a property that only ever saw one split would not be
 * testing the classification at all.
 */
export const unpaidBreakTypesArb: fc.Arbitrary<readonly BreakType[]> = fc.oneof(
  { weight: 5, arbitrary: fc.constant<readonly BreakType[]>(['lunch']) },
  { weight: 2, arbitrary: fc.constant<readonly BreakType[]>(['lunch', 'personal']) },
  { weight: 1, arbitrary: fc.constant<readonly BreakType[]>([]) },
  { weight: 1, arbitrary: fc.constant<readonly BreakType[]>(['lunch', 'short', 'personal']) },
);

/** A tolerance in minutes: the deployed value most of the time, including zero. */
function toleranceArb(deployed: number, max: number): fc.Arbitrary<number> {
  return fc.oneof(
    { weight: 3, arbitrary: fc.constant(deployed) },
    { weight: 2, arbitrary: fc.integer({ min: 0, max }) },
  );
}

/**
 * An `AttendancePolicy`. `businessTimezone` is the zone Requirement 3.7 fixes,
 * since a schedule row is only meaningful in that zone; the four tolerances are
 * generated, zero included, because the grace period and the early-departure
 * tolerance are strict comparisons whose boundary is the point of Property 4.
 */
export const attendancePolicyArb: fc.Arbitrary<AttendancePolicy> = fc
  .record({
    businessTimezone: fc.constant<string>(BUSINESS_TIMEZONE),
    gracePeriodMinutes: toleranceArb(5, 60),
    earlyDepartureToleranceMinutes: toleranceArb(15, 60),
    missingClockOutToleranceMinutes: toleranceArb(120, 240),
    unpaidBreakTypes: unpaidBreakTypesArb,
    breakOverrunMinutes: toleranceArb(60, 120),
  })
  .map((policy): AttendancePolicy => policy);

// ─── Attendance inputs ───────────────────────────────────────────────────────

/** Drawn from `PTO_TYPE_LABELS` so a type added later is covered. */
export const ptoTypeArb: fc.Arbitrary<PTOType> = fc.constantFrom(
  ...(Object.keys(PTO_TYPE_LABELS) as PTOType[]),
);

/** An approved time-off request covering the date, or none. */
export const approvedAbsenceArb: fc.Arbitrary<AttendanceInputs['approvedAbsence']> = fc.oneof(
  { weight: 3, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.record({ requestId: fc.uuid(), ptoType: ptoTypeArb }) },
);

function shiftInstant(value: string, deltaMs: number): string {
  return new Date(Date.parse(value) + deltaMs).toISOString();
}

/**
 * A session set translated so its earliest clock-in lands on `targetMs`.
 *
 * Translation is one addition applied to every instant, so spans, break
 * placement, overlaps, and inverted sessions all survive it: the generated
 * shape is preserved and only its position on the clock moves. That is what
 * lets `anySessionSetArb` supply the sessions for a named work date without a
 * second session builder that could drift from the first.
 */
function anchorSessions(
  sessions: readonly ClockSessionInput[],
  targetMs: number,
): ClockSessionInput[] {
  if (sessions.length === 0) return [];

  const earliestMs = Math.min(...sessions.map((session) => Date.parse(session.clockIn)));
  const deltaMs = targetMs - earliestMs;

  return sessions.map((session) => ({
    ...session,
    clockIn: shiftInstant(session.clockIn, deltaMs),
    clockOut: session.clockOut === null ? null : shiftInstant(session.clockOut, deltaMs),
    breaks: session.breaks.map((item) => ({
      ...item,
      start: shiftInstant(item.start, deltaMs),
      end: item.end === null ? null : shiftInstant(item.end, deltaMs),
    })),
  }));
}

function clampDayIndex(index: number): number {
  if (index < 0) return 0;
  if (index > GENERATED_DAY_COUNT - 1) return GENERATED_DAY_COUNT - 1;
  return index;
}

/** The draws behind one `AttendanceInputs` row, before they are positioned. */
interface AttendanceDayDraw {
  profileId: string;
  dayIndex: number;
  timeZone: DeployedTimeZone;
  schedule: ScheduleInput | null;
  sessions: ClockSessionInput[];
  /** Minutes past local midnight the earliest clock-in is moved to. */
  firstClockInMinutes: number;
  /** Days between the work date and the date the evaluation instant falls on. */
  evaluationDayOffset: number;
  /** Minutes past local midnight of the evaluation instant. */
  evaluationMinutes: number;
  approvedAbsence: AttendanceInputs['approvedAbsence'];
  unscheduledWorkApproved: boolean;
  reviewedAt: string | null;
  policy: AttendancePolicy;
}

const localMinutesArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...SCHEDULE_BOUNDARY_MINUTES) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 24 * 60 - 1 }) },
);

const attendanceDayDrawArb: fc.Arbitrary<AttendanceDayDraw> = fc.record({
  profileId: fc.uuid(),
  dayIndex: dayIndexArb,
  timeZone: timeZoneArb,
  schedule: optionalScheduleArb,
  sessions: anySessionSetArb,
  firstClockInMinutes: localMinutesArb,
  // Both signs, so the future-date and past-date branches of the Status Rule
  // Matrix are reached rather than left to chance.
  evaluationDayOffset: fc.integer({ min: -2, max: 2 }),
  evaluationMinutes: localMinutesArb,
  approvedAbsence: approvedAbsenceArb,
  unscheduledWorkApproved: fc.boolean(),
  reviewedAt: fc.oneof(
    { weight: 3, arbitrary: fc.constant(null) },
    { weight: 1, arbitrary: isoInstantArb },
  ),
  policy: attendancePolicyArb,
});

function buildAttendanceInputs(draw: AttendanceDayDraw): AttendanceInputs {
  const dayIndex = clampDayIndex(draw.dayIndex);
  const evaluationIndex = clampDayIndex(dayIndex + draw.evaluationDayOffset);

  const anchorMs = zonedWallClockToMs(dayIndex, draw.firstClockInMinutes, draw.timeZone);
  const evaluatedAtMs = zonedWallClockToMs(evaluationIndex, draw.evaluationMinutes, draw.timeZone);

  return {
    profileId: draw.profileId,
    workDate: dayIndexToDate(dayIndex),
    employeeTimezone: draw.timeZone,
    schedule: draw.schedule,
    sessions: anchorSessions(draw.sessions, anchorMs),
    approvedAbsence: draw.approvedAbsence,
    unscheduledWorkApproved: draw.unscheduledWorkApproved,
    reviewedAt: draw.reviewedAt,
    policy: draw.policy,
    evaluatedAt: new Date(evaluatedAtMs).toISOString(),
  };
}

/**
 * One `AttendanceInputs` row: a work date, an optional schedule, a session set
 * anchored on that work date, an optional approved absence, and an evaluation
 * instant within two days of the date, so the rules that turn on whether an
 * instant "has passed" are exercised rather than always decided the same way.
 *
 * Sessions come from `anySessionSetArb`, so overlaps, several open sessions at
 * once, and inverted sessions are all generated: an input set that only ever
 * described a well-formed day would never reach the `needs_review` path.
 */
export const attendanceInputsArb: fc.Arbitrary<AttendanceInputs> =
  attendanceDayDrawArb.map(buildAttendanceInputs);

/**
 * A set of `AttendanceInputs` over two employees and two adjacent work dates,
 * sharing one employee timezone, one policy, and one evaluation instant, the way
 * a single range read supplies them.
 *
 * The keys cycle over three employee-and-date pairs, so a set of four rows or
 * more carries a duplicate key — which is the input shape
 * `collapseAttendanceInputs` exists for and the one that could otherwise
 * produce two records for one employee and date.
 */
export const attendanceInputsSetArb: fc.Arbitrary<AttendanceInputs[]> = fc
  .array(attendanceDayDrawArb, { minLength: 1, maxLength: 6 })
  .map((draws) => {
    const base = draws[0];
    const employees = [base.profileId, draws[draws.length - 1].profileId];

    const rows = draws.map((draw, index) =>
      buildAttendanceInputs({
        ...draw,
        profileId: employees[index % employees.length],
        dayIndex: clampDayIndex(base.dayIndex) + (index % 3 === 2 ? 1 : 0),
        timeZone: base.timeZone,
        policy: base.policy,
      }),
    );

    const { evaluatedAt } = rows[0];
    return rows.map((row) => ({ ...row, evaluatedAt }));
  });

// ─── Staffing thresholds ─────────────────────────────────────────────────────

/** Warning at or above the minimum, the configured-and-sane case. */
const orderedThresholdArb = fc
  .integer({ min: 0, max: 12 })
  .chain((minimumStaff) =>
    fc
      .integer({ min: 0, max: 6 })
      .map((delta) => ({ minimumStaff, warningThreshold: minimumStaff + delta })),
  );

/** Warning below the minimum, which collapses the Warning band to nothing. */
const degenerateThresholdArb = fc
  .integer({ min: 1, max: 12 })
  .chain((minimumStaff) =>
    fc.integer({ min: 0, max: minimumStaff - 1 }).map((warningThreshold) => ({
      minimumStaff,
      warningThreshold,
    })),
  );

/**
 * A staffing threshold, or none. The null case is an unconfigured department,
 * which reports required staffing as unconfigured and status Healthy; the
 * degenerate case is the ordering Property 10 has to survive.
 */
export const thresholdArb: fc.Arbitrary<Threshold | null> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 4, arbitrary: orderedThresholdArb },
  { weight: 2, arbitrary: degenerateThresholdArb },
);

// ─── Date ranges ─────────────────────────────────────────────────────────────

/**
 * An inclusive calendar date range, `start` never after `end`. Mirrors the
 * design's `DateRange`; it moves to `domain/pto.ts` once that module exists.
 */
export interface GeneratedDateRange {
  start: string;
  end: string;
}

/** A single day, which is also the shortest range the services accept. */
const singleDayRangeArb = workDateArb.map((date) => ({ start: date, end: date }));

/**
 * A range that straddles 31 December, so per-year attribution has two years to
 * split across. `start` is in the second half of December and `end` is in the
 * first half of the following January, so the boundary is always inside.
 */
const yearStraddlingRangeArb = fc
  .tuple(fc.constantFrom(2024, 2025, 2026), fc.integer({ min: 0, max: 16 }), fc.integer({ min: 0, max: 15 }))
  .map(([year, daysBefore, daysAfter]) => ({
    start: new Date(Date.UTC(year, 11, 31) - daysBefore * DAY_MS).toISOString().slice(0, 10),
    end: new Date(Date.UTC(year + 1, 0, 1) + daysAfter * DAY_MS).toISOString().slice(0, 10),
  }));

const lastSaturdayIndex =
  FIRST_SATURDAY_INDEX +
  7 * Math.floor((GENERATED_DAY_COUNT - 2 - FIRST_SATURDAY_INDEX) / 7);

/**
 * A range lying entirely inside one weekend: Saturday alone, Sunday alone, or
 * Saturday through Sunday. Every such range has a working-day count of zero.
 */
const weekendOnlyRangeArb = fc
  .tuple(
    fc.integer({ min: 0, max: (lastSaturdayIndex - FIRST_SATURDAY_INDEX) / 7 }),
    fc.constantFrom<'saturday' | 'sunday' | 'both'>('saturday', 'sunday', 'both'),
  )
  .map(([week, span]) => {
    const saturday = FIRST_SATURDAY_INDEX + week * 7;
    const startIndex = span === 'sunday' ? saturday + 1 : saturday;
    const endIndex = span === 'saturday' ? saturday : saturday + 1;
    return { start: dayIndexToDate(startIndex), end: dayIndexToDate(endIndex) };
  });

/** An ordinary range of up to six weeks. */
const spanningRangeArb = dayIndexArb.chain((startIndex) =>
  fc
    .integer({ min: 0, max: Math.min(45, GENERATED_DAY_COUNT - 1 - startIndex) })
    .map((length) => ({
      start: dayIndexToDate(startIndex),
      end: dayIndexToDate(startIndex + length),
    })),
);

/**
 * A date range covering the shapes the working-day and year-attribution
 * properties need: a single day, a range straddling 31 December, a range
 * entirely inside a weekend, and an ordinary multi-week span.
 */
export const dateRangeArb: fc.Arbitrary<GeneratedDateRange> = fc.oneof(
  { weight: 2, arbitrary: singleDayRangeArb },
  { weight: 2, arbitrary: yearStraddlingRangeArb },
  { weight: 2, arbitrary: weekendOnlyRangeArb },
  { weight: 3, arbitrary: spanningRangeArb },
);

// ─── CSV fields ──────────────────────────────────────────────────────────────

/**
 * The characters that corrupt the browser-built export the redesign replaces:
 * the delimiter, the quote character, all three line endings, and non-ASCII
 * text including multi-code-point graphemes.
 */
const CSV_HAZARD_FRAGMENTS: readonly string[] = [
  ',', '"', '""', '\n', '\r', '\r\n', '\t', ';', ' ', '  ',
  'é', 'ñ', 'ü', 'ç', '¿', 'ó', '—', 'Ω', '中文', '日本語', '🙂', '👍🏽',
];

/**
 * A CSV field value. Roughly half of every generated string is hazard
 * fragments, so quoting, quote doubling, and the round trip are all exercised
 * rather than hoped for. The empty string is included.
 */
export const csvFieldArb: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      { weight: 3, arbitrary: fc.constantFrom(...CSV_HAZARD_FRAGMENTS) },
      { weight: 2, arbitrary: fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 8 }) },
      { weight: 1, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 4 }) },
    ),
    { maxLength: 6 },
  )
  .map((fragments) => fragments.join(''));
// ─── Coverage: departments and rosters ───────────────────────────────────────

/** True with the given odds, so a shape can be made common without being certain. */
function weightedBoolean(trueWeight: number, falseWeight: number): fc.Arbitrary<boolean> {
  return fc.oneof(
    { weight: trueWeight, arbitrary: fc.constant(true) },
    { weight: falseWeight, arbitrary: fc.constant(false) },
  );
}

/** Every department, drawn from `DEPARTMENT_LABELS` so a later addition is covered. */
export const ALL_DEPARTMENTS: readonly Department[] = Object.keys(
  DEPARTMENT_LABELS,
) as Department[];

export const departmentArb: fc.Arbitrary<Department> = fc.constantFrom(...ALL_DEPARTMENTS);

/**
 * A department or none.
 *
 * The null case is not decoration: an employee carrying no department belongs to
 * no coverage row, which is what makes the per-department figures sum to the
 * organisation figure only when the departments partition the roster. Property
 * 12 needs both sides of that condition.
 */
export const optionalDepartmentArb: fc.Arbitrary<Department | null> = fc.oneof(
  { weight: 6, arbitrary: departmentArb },
  { weight: 1, arbitrary: fc.constant(null) },
);

/** One to three departments, so a small roster concentrates rather than scattering. */
const departmentPoolArb: fc.Arbitrary<Department[]> = fc
  .array(departmentArb, { minLength: 1, maxLength: 3 })
  .map((departments) => [...new Set(departments)]);

/** No row at all, an explicit unconfigured row, or a pair. */
const thresholdEntryArb: fc.Arbitrary<Threshold | null | undefined> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<Threshold | null | undefined>(undefined) },
  { weight: 5, arbitrary: thresholdArb },
);

/**
 * The threshold pair per department for one day of week and time slot, as the
 * caller resolves it from `staffing_thresholds`.
 *
 * Three cases per department: absent from the map, present and null, or a pair
 * from `thresholdArb`. A department carrying a pair while nobody is rostered to
 * it is reachable, which is the most serious gap a coverage response can report
 * and the one an implementation could most easily drop.
 */
export const departmentThresholdsArb: fc.Arbitrary<ReadonlyMap<Department, Threshold | null>> = fc
  .array(thresholdEntryArb, {
    minLength: ALL_DEPARTMENTS.length,
    maxLength: ALL_DEPARTMENTS.length,
  })
  .map((entries) => {
    const thresholds = new Map<Department, Threshold | null>();
    ALL_DEPARTMENTS.forEach((department, index) => {
      const entry = entries[index];
      if (entry !== undefined) thresholds.set(department, entry);
    });
    return thresholds;
  });

/** A headcount the coverage rule is applied to, wide enough to cross any threshold. */
export const availableStaffArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 15 });

// ─── Coverage: shift windows ─────────────────────────────────────────────────

/**
 * A shift window as `buildCoverageIntervals` takes it: one employee, two
 * instants.
 *
 * Declared here rather than imported from `domain/coverage.ts` so that the
 * generators stay independent of the module the coverage properties test. It is
 * structurally the `ShiftWindow` that module exports.
 */
export interface GeneratedShiftWindow {
  profileId: string;
  start: Date;
  end: Date;
}

/** One window's placement, in minutes from the case's anchor instant. */
interface ShiftWindowDraw {
  startOffsetMinutes: number;
  lengthMinutes: number;
  /** Index into the shared profile pool, used when profiles may repeat. */
  profileIndex: number;
  absent: boolean;
}

/**
 * Offsets and lengths are drawn mostly from a small discrete set, because the
 * shapes the partition has to survive are the coincidences: identical windows
 * need two equal offsets and two equal lengths, and nested windows need one
 * window's span to sit strictly inside another's. Uniform draws produce those
 * almost never. The uniform tail keeps the space from being only the set.
 */
const windowOffsetArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(0, 60, 120, 180, 240, 300) },
  { weight: 1, arbitrary: fc.integer({ min: -240, max: 600 }) },
);

/** Zero is included: a window covering no time is ignored, boundaries and all. */
const windowLengthArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(0, 60, 120, 240, 480) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 600 }) },
);

const shiftWindowDrawArb: fc.Arbitrary<ShiftWindowDraw> = fc.record({
  startOffsetMinutes: windowOffsetArb,
  lengthMinutes: windowLengthArb,
  profileIndex: fc.nat({ max: 2 }),
  absent: weightedBoolean(1, 5),
});

/**
 * One date's shift windows for the interval partition, with the employees whose
 * absence excludes them from the counts.
 *
 * `distinctProfiles` says whether every window carries its own employee. Both
 * cases matter and they are not the same claim: with distinct employees an
 * interval's headcount equals the number of shift rows spanning it, while with
 * repeated employees — a split shift recorded as two rows — the headcount is
 * the number of distinct employees and is strictly lower. Property 14 asserts
 * the distinct-employee reading always and the row-count reading when the flag
 * says it is meaningful.
 */
export interface ShiftWindowCase {
  windows: GeneratedShiftWindow[];
  absentProfileIds: ReadonlySet<string>;
  threshold: Threshold | null;
  distinctProfiles: boolean;
}

export const shiftWindowCaseArb: fc.Arbitrary<ShiftWindowCase> = fc
  .record({
    anchorMs: instantMsArb,
    draws: fc.array(shiftWindowDrawArb, { maxLength: 6 }),
    distinctProfiles: weightedBoolean(1, 1),
    threshold: thresholdArb,
  })
  .map(({ anchorMs, draws, distinctProfiles, threshold }) => {
    const windows: GeneratedShiftWindow[] = [];
    const absentProfileIds = new Set<string>();

    draws.forEach((draw, index) => {
      const profileId = distinctProfiles ? `w${index}` : `p${draw.profileIndex}`;
      const startMs = anchorMs + draw.startOffsetMinutes * MINUTE_MS;
      windows.push({
        profileId,
        start: new Date(startMs),
        end: new Date(startMs + draw.lengthMinutes * MINUTE_MS),
      });
      if (draw.absent) absentProfileIds.add(profileId);
    });

    return { windows, absentProfileIds, threshold, distinctProfiles };
  });

// ─── Coverage: projection inputs ─────────────────────────────────────────────

/** How one employee appears in a projection: on the roster, and in which lists. */
interface ProjectionEmployeeDraw {
  department: Department | null;
  onRoster: boolean;
  scheduled: boolean;
  approvedAbsence: boolean;
  proposedAbsence: boolean;
  /** Repeats the employee in the scheduled list, as a split shift would. */
  repeatedSchedule: boolean;
}

const projectionEmployeeDrawArb: fc.Arbitrary<ProjectionEmployeeDraw> = fc.record({
  department: optionalDepartmentArb,
  onRoster: weightedBoolean(5, 1),
  scheduled: weightedBoolean(3, 1),
  approvedAbsence: weightedBoolean(1, 3),
  proposedAbsence: weightedBoolean(1, 4),
  repeatedSchedule: weightedBoolean(1, 5),
});

/**
 * Everything Projected_Coverage for one date is computed from, plus the two
 * facts a property needs to know about the input it was handed.
 *
 * `partitionsRoster` records whether every employee named in the three lists is
 * rostered with a department, which is the condition under which the
 * per-department figures sum to the organisation figure. Half the cases are
 * drawn to satisfy it and half are not, so neither side of the condition is
 * left to chance.
 *
 * `spare` is an employee named in none of the three lists and rostered with a
 * department, so adding them as an absence is always a new absence — which is
 * what "adding one approved absence decreases Projected_Coverage by exactly
 * one" quantifies over. Adding an employee already named would change nothing,
 * because the lists are counted as sets.
 */
export interface ProjectionCase {
  workDate: string;
  scheduledProfileIds: string[];
  approvedAbsenceProfileIds: string[];
  proposedAbsenceProfileIds: string[];
  threshold: Threshold | null;
  roster: RecordSubjectIndex;
  departmentThresholds: ReadonlyMap<Department, Threshold | null>;
  partitionsRoster: boolean;
  spare: RecordSubject;
}

export const projectionCaseArb: fc.Arbitrary<ProjectionCase> = fc
  .record({
    workDate: workDateArb,
    employees: fc.array(projectionEmployeeDrawArb, { minLength: 1, maxLength: 8 }),
    partitioned: weightedBoolean(1, 1),
    threshold: thresholdArb,
    departmentThresholds: departmentThresholdsArb,
    spareDepartment: departmentArb,
  })
  .map(({ workDate, employees, partitioned, threshold, departmentThresholds, spareDepartment }) => {
    const scheduledProfileIds: string[] = [];
    const approvedAbsenceProfileIds: string[] = [];
    const proposedAbsenceProfileIds: string[] = [];
    const roster = new Map<string, RecordSubject>();

    employees.forEach((draw, index) => {
      const profileId = `e${index}`;
      const department = partitioned ? (draw.department ?? spareDepartment) : draw.department;
      if (partitioned || draw.onRoster) roster.set(profileId, { profileId, department });

      if (draw.scheduled) {
        scheduledProfileIds.push(profileId);
        if (draw.repeatedSchedule) scheduledProfileIds.push(profileId);
      }
      if (draw.approvedAbsence) approvedAbsenceProfileIds.push(profileId);
      if (draw.proposedAbsence) proposedAbsenceProfileIds.push(profileId);
    });

    const spare: RecordSubject = { profileId: 'spare', department: spareDepartment };
    roster.set(spare.profileId, spare);

    const named = new Set([
      ...scheduledProfileIds,
      ...approvedAbsenceProfileIds,
      ...proposedAbsenceProfileIds,
    ]);
    const partitionsRoster = [...named].every((id) => {
      const subject = roster.get(id);
      return subject !== undefined && subject.department !== null;
    });

    return {
      workDate,
      scheduledProfileIds,
      approvedAbsenceProfileIds,
      proposedAbsenceProfileIds,
      threshold,
      roster,
      departmentThresholds,
      partitionsRoster,
      spare,
    };
  });

// ─── Coverage: one live day ──────────────────────────────────────────────────

/**
 * How one employee's day is shaped, and therefore which headcount reads them.
 *
 * These are input shapes, not statuses: the shape decides what schedule,
 * sessions, breaks, and absence the employee carries, and the Status Rule
 * Matrix decides the status. Naming them after the outcome they are built to
 * reach keeps the generator readable without asserting anything about the
 * matrix, which is Property 1's business.
 *
 * `unscheduled_working` is the shape the missing-headcount definition turns on:
 * an employee working a day they were never scheduled for is counted as working
 * while never counting as scheduled, which is what makes `scheduled − working −
 * onBreak − approvedOff` drift below the number of scheduled employees actually
 * unaccounted for.
 */
export type LiveCoverageShape =
  | 'working'
  | 'on_break'
  | 'approved_off'
  | 'approved_off_unscheduled'
  | 'no_show'
  | 'left_early'
  | 'unscheduled_working'
  | 'inconsistent';

const liveCoverageShapeArb: fc.Arbitrary<LiveCoverageShape> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<LiveCoverageShape>('working') },
  { weight: 3, arbitrary: fc.constant<LiveCoverageShape>('on_break') },
  { weight: 3, arbitrary: fc.constant<LiveCoverageShape>('approved_off') },
  { weight: 2, arbitrary: fc.constant<LiveCoverageShape>('approved_off_unscheduled') },
  { weight: 4, arbitrary: fc.constant<LiveCoverageShape>('no_show') },
  { weight: 2, arbitrary: fc.constant<LiveCoverageShape>('left_early') },
  { weight: 4, arbitrary: fc.constant<LiveCoverageShape>('unscheduled_working') },
  { weight: 1, arbitrary: fc.constant<LiveCoverageShape>('inconsistent') },
);

interface LiveEmployeeDraw {
  shape: LiveCoverageShape;
  /** Index into the case's department pool; -1 is an employee with no department. */
  departmentIndex: number;
  onRoster: boolean;
  /** Places the row on the day before, which a live read of the date must ignore. */
  previousDate: boolean;
}

const liveEmployeeDrawArb: fc.Arbitrary<LiveEmployeeDraw> = fc.record({
  shape: liveCoverageShapeArb,
  departmentIndex: fc.oneof(
    { weight: 8, arbitrary: fc.nat({ max: 2 }) },
    { weight: 1, arbitrary: fc.constant(-1) },
  ),
  onRoster: weightedBoolean(6, 1),
  previousDate: weightedBoolean(1, 6),
});

/**
 * The wall clock the live day is built around, in minutes past local midnight.
 *
 * The evaluation instant sits inside every generated shift, so an open session
 * is still open at it and the missing-clock-out tolerance has not expired. That
 * is what makes the shapes above reach the statuses they are named for instead
 * of all collapsing into one late-evening outcome.
 */
const LIVE_EVALUATION_MINUTES = 13 * 60;
const LIVE_BREAK_START_MINUTES = LIVE_EVALUATION_MINUTES - 30;
const LIVE_EARLY_CLOCK_OUT_MINUTES = LIVE_EVALUATION_MINUTES - 60;

/**
 * One date's live-coverage inputs, with the roster and thresholds a coverage
 * read is given and the published-schedule view of the same date.
 *
 * `inputs` are `AttendanceInputs`, not records: the test derives the records
 * through `deriveRange`, so the statuses the headcounts read are the ones the
 * Status Rule Matrix actually assigns rather than statuses a generator decided.
 *
 * `scheduleWindows`, `scheduledProfileIds`, and `approvedAbsenceProfileIds` are
 * the same day expressed the way Projected_Coverage sees it — published
 * schedules and approved absences, no clock data — which is what lets Property
 * 13 hold the projection still while the clock data moves underneath it.
 */
export interface LiveCoverageCase {
  workDate: string;
  inputs: AttendanceInputs[];
  roster: RecordSubjectIndex;
  thresholds: ReadonlyMap<Department, Threshold | null>;
  scheduleWindows: GeneratedShiftWindow[];
  scheduledProfileIds: string[];
  approvedAbsenceProfileIds: string[];
  /** The instant every row is evaluated at, as a single read supplies it. */
  evaluatedAt: string;
}

function liveIso(dayIndex: number, minutes: number): string {
  return new Date(zonedWallClockToMs(dayIndex, minutes, BUSINESS_TIMEZONE)).toISOString();
}

/** The sessions one shape carries, positioned against the generated shift. */
function liveSessions(
  shape: LiveCoverageShape,
  profileId: string,
  dayIndex: number,
  shiftStartMinutes: number,
): ClockSessionInput[] {
  const session = (
    suffix: string,
    startMinutes: number,
    endMinutes: number | null,
    breaks: ClockSessionInput['breaks'] = [],
  ): ClockSessionInput => ({
    id: `${profileId}-${suffix}`,
    clockIn: liveIso(dayIndex, startMinutes),
    clockOut: endMinutes === null ? null : liveIso(dayIndex, endMinutes),
    breaks,
    adjustedBy: null,
    adjustmentReason: null,
  });

  switch (shape) {
    case 'working':
      return [session('1', shiftStartMinutes, null)];
    case 'on_break':
      return [
        session('1', shiftStartMinutes, null, [
          {
            id: `${profileId}-b1`,
            type: 'lunch',
            start: liveIso(dayIndex, LIVE_BREAK_START_MINUTES),
            end: null,
            durationMinutes: null,
          },
        ]),
      ];
    case 'unscheduled_working':
      return [session('1', shiftStartMinutes + 60, null)];
    case 'left_early':
      return [session('1', shiftStartMinutes, LIVE_EARLY_CLOCK_OUT_MINUTES)];
    case 'inconsistent':
      // Two sessions open at once, which is data the derivation can detect and
      // cannot resolve: the record falls to `needs_review` and belongs to no
      // headcount while still counting as scheduled.
      return [session('1', shiftStartMinutes, null), session('2', shiftStartMinutes + 60, null)];
    case 'approved_off':
    case 'approved_off_unscheduled':
    case 'no_show':
      return [];
  }
}

/** True when the shape carries a published schedule on its date. */
function liveHasSchedule(shape: LiveCoverageShape): boolean {
  return shape !== 'unscheduled_working' && shape !== 'approved_off_unscheduled';
}

/** True when the shape carries an approved absence covering its date. */
function liveHasAbsence(shape: LiveCoverageShape): boolean {
  return shape === 'approved_off' || shape === 'approved_off_unscheduled';
}

/**
 * One live-coverage day: a roster of up to eight employees across one to three
 * departments, each carrying one of the day shapes, some off the roster, some
 * with no department, and some belonging to the day before.
 *
 * Every employee shares one timezone, one policy, and one evaluation instant,
 * the way a single range read supplies them. The zone is the business timezone
 * so that a generated wall clock and the schedule resolution agree about which
 * calendar date they are on; cross-zone attribution is Property 6's subject,
 * not this one's.
 */
export const liveCoverageCaseArb: fc.Arbitrary<LiveCoverageCase> = fc
  .record({
    dayIndex: fc.integer({ min: 1, max: GENERATED_DAY_COUNT - 2 }),
    employees: fc.array(liveEmployeeDrawArb, { minLength: 1, maxLength: 8 }),
    departmentPool: departmentPoolArb,
    shiftStartMinutes: fc.constantFrom(8 * 60, 8 * 60 + 30, 9 * 60),
    shiftEndMinutes: fc.constantFrom(17 * 60, 17 * 60 + 30, 18 * 60),
    thresholds: departmentThresholdsArb,
    policy: attendancePolicyArb,
    shiftType: shiftTypeArb,
  })
  .map((draw) => {
    const workDate = dayIndexToDate(draw.dayIndex);
    const evaluatedAt = liveIso(draw.dayIndex, LIVE_EVALUATION_MINUTES);

    const inputs: AttendanceInputs[] = [];
    const roster = new Map<string, RecordSubject>();
    const scheduleWindows: GeneratedShiftWindow[] = [];
    const scheduledProfileIds: string[] = [];
    const approvedAbsenceProfileIds: string[] = [];

    draw.employees.forEach((employee, index) => {
      const profileId = `p${index}`;
      const dayIndex = employee.previousDate ? draw.dayIndex - 1 : draw.dayIndex;
      const hasSchedule = liveHasSchedule(employee.shape);
      const hasAbsence = liveHasAbsence(employee.shape);

      if (employee.departmentIndex === -1) {
        roster.set(profileId, { profileId, department: null });
      } else if (employee.onRoster) {
        const pool = draw.departmentPool;
        roster.set(profileId, {
          profileId,
          department: pool[employee.departmentIndex % pool.length],
        });
      }

      inputs.push({
        profileId,
        workDate: dayIndexToDate(dayIndex),
        employeeTimezone: BUSINESS_TIMEZONE,
        schedule: hasSchedule
          ? {
              start: formatWallClock(draw.shiftStartMinutes),
              end: formatWallClock(draw.shiftEndMinutes),
              shiftType: draw.shiftType,
              status: 'published',
            }
          : null,
        sessions: liveSessions(employee.shape, profileId, dayIndex, draw.shiftStartMinutes),
        approvedAbsence: hasAbsence ? { requestId: `r${index}`, ptoType: 'vacation' } : null,
        unscheduledWorkApproved: false,
        reviewedAt: null,
        policy: draw.policy,
        evaluatedAt,
      });

      // The published-schedule view of the date itself, which is what the
      // projection and the interval partition are computed from.
      if (!employee.previousDate) {
        if (hasSchedule) {
          scheduledProfileIds.push(profileId);
          scheduleWindows.push({
            profileId,
            start: new Date(zonedWallClockToMs(dayIndex, draw.shiftStartMinutes, BUSINESS_TIMEZONE)),
            end: new Date(zonedWallClockToMs(dayIndex, draw.shiftEndMinutes, BUSINESS_TIMEZONE)),
          });
        }
        if (hasAbsence) approvedAbsenceProfileIds.push(profileId);
      }
    });

    return {
      workDate,
      inputs,
      roster,
      thresholds: draw.thresholds,
      scheduleWindows,
      scheduledProfileIds,
      approvedAbsenceProfileIds,
      evaluatedAt,
    };
  });

// ─── Coverage: the health ribbon ─────────────────────────────────────────────

/**
 * How many dates the ribbon shows, transcribed from Requirement 18, criterion 2
 * rather than imported from `domain/coverage.ts`. A generator that read the
 * module's own constant could not tell a seven-date strip from a six-date one.
 */
export const RIBBON_WINDOW_DAYS = 7;

/** One ribbon date: whether it is open, scheduled, covered, and how well staffed. */
export interface RibbonDateDraw {
  workDate: string;
  closed: boolean;
  scheduled: boolean;
  /** False leaves the date out of the coverage set entirely. */
  covered: boolean;
  /** A second coverage entry for the date, carrying different figures. */
  duplicated: boolean;
  scheduledCount: number;
  approvedCount: number;
  threshold: Threshold | null;
}

/**
 * Thresholds sized against the generated headcounts, so all four coverage
 * outcomes are reachable and the three coverage-derived ribbon states are
 * actually exercised. `thresholdArb` is mixed in for the null and degenerate
 * configurations.
 */
const ribbonThresholdArb: fc.Arbitrary<Threshold | null> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .integer({ min: 1, max: 3 })
      .chain((minimumStaff) =>
        fc
          .integer({ min: 0, max: 2 })
          .map((delta): Threshold | null => ({
            minimumStaff,
            warningThreshold: minimumStaff + delta,
          })),
      ),
  },
  { weight: 2, arbitrary: thresholdArb },
);

const ribbonDateDrawArb = fc.record({
  closed: weightedBoolean(1, 4),
  scheduled: weightedBoolean(4, 1),
  covered: weightedBoolean(5, 1),
  duplicated: weightedBoolean(1, 5),
  scheduledCount: fc.integer({ min: 0, max: 6 }),
  approvedCount: fc.integer({ min: 0, max: 4 }),
  threshold: ribbonThresholdArb,
});

/** A projection input for one ribbon date, which the test maps through `projectCoverage`. */
export interface RibbonProjectionInput {
  workDate: string;
  scheduledProfileIds: string[];
  approvedAbsenceProfileIds: string[];
  proposedAbsenceProfileIds: string[];
  threshold: Threshold | null;
}

/**
 * A ribbon derivation: a start date, the closed and scheduled date sets, and the
 * projection inputs behind the coverage set.
 *
 * `dates` is the seven-date window computed by calendar index rather than by
 * `domain/work-date.ts`, so the seven-consecutive-dates claim is checked against
 * something other than the arithmetic that produced it.
 *
 * The coverage set is deliberately imperfect: dates outside the window, dates
 * missing from it, and a repeated date carrying different figures. A ribbon date
 * the coverage set does not cover reports No_Schedule, and a generator that
 * always supplied complete coverage would never reach that branch.
 *
 * `alternateStartDate` is a second window overlapping the first, for the claim
 * that the same date reads the same on every screen.
 */
export interface RibbonCase {
  startDate: string;
  alternateStartDate: string;
  dates: RibbonDateDraw[];
  closedDates: ReadonlySet<string>;
  scheduledDates: ReadonlySet<string>;
  projectionInputs: RibbonProjectionInput[];
}

function ribbonProjectionInput(dateDraw: RibbonDateDraw, approvedCount: number): RibbonProjectionInput {
  return {
    workDate: dateDraw.workDate,
    scheduledProfileIds: Array.from({ length: dateDraw.scheduledCount }, (_, i) => `s${i}`),
    approvedAbsenceProfileIds: Array.from({ length: approvedCount }, (_, i) => `s${i}`),
    proposedAbsenceProfileIds: [],
    threshold: dateDraw.threshold,
  };
}

export const ribbonCaseArb: fc.Arbitrary<RibbonCase> = fc
  .record({
    startDayIndex: fc.integer({ min: 3, max: GENERATED_DAY_COUNT - RIBBON_WINDOW_DAYS - 1 }),
    dates: fc.array(ribbonDateDrawArb, {
      minLength: RIBBON_WINDOW_DAYS,
      maxLength: RIBBON_WINDOW_DAYS,
    }),
    /** A date outside the window, carrying figures the ribbon must ignore. */
    outsideThreshold: ribbonThresholdArb,
  })
  .map(({ startDayIndex, dates: draws, outsideThreshold }) => {
    const dates: RibbonDateDraw[] = draws.map((draw, offset) => ({
      ...draw,
      workDate: dayIndexToDate(startDayIndex + offset),
    }));

    const closedDates = new Set<string>();
    const scheduledDates = new Set<string>();
    const projectionInputs: RibbonProjectionInput[] = [];

    for (const date of dates) {
      if (date.closed) closedDates.add(date.workDate);
      if (date.scheduled) scheduledDates.add(date.workDate);
      if (!date.covered) continue;

      projectionInputs.push(ribbonProjectionInput(date, Math.min(date.approvedCount, date.scheduledCount)));
      if (date.duplicated) {
        // A second entry for the same date, with every scheduled employee away.
        projectionInputs.push(ribbonProjectionInput(date, date.scheduledCount));
      }
    }

    // Dates either side of the window, which must not reach any cell.
    const outside: RibbonDateDraw = {
      workDate: dayIndexToDate(startDayIndex - 1),
      closed: false,
      scheduled: true,
      covered: true,
      duplicated: false,
      scheduledCount: 0,
      approvedCount: 0,
      threshold: outsideThreshold,
    };
    projectionInputs.push(ribbonProjectionInput(outside, 0));
    projectionInputs.push(
      ribbonProjectionInput(
        { ...outside, workDate: dayIndexToDate(startDayIndex + RIBBON_WINDOW_DAYS) },
        0,
      ),
    );

    return {
      startDate: dates[0].workDate,
      alternateStartDate: dayIndexToDate(startDayIndex - 3),
      dates,
      closedDates,
      scheduledDates,
      projectionInputs,
    };
  });

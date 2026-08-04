/**
 * Shared business-hours classification corpus.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 7.5, 7.6, 7.8, 7.9, 8.2
 *
 * This corpus is run twice: by `business-hours.test.ts` against `classifyInstant`
 * in TypeScript, and by `business-hours-parity.integration.test.ts` against
 * `public.reporting_is_business_hours` in SQL. The after-hours rule exists in both
 * places because the browser needs it for labels and drawer rows while the queries
 * need it for aggregation, and sharing one corpus is what stops the two drifting.
 *
 * Every instant is written in UTC with its intended `America/New_York` wall clock
 * in the case name, so a reader can check the offset arithmetic without running
 * anything. Dates are in 2026; both daylight-saving transitions that year fall on
 * a Sunday (8 March and 1 November), so the weekday cases either side of each
 * transition are what actually prove the offset is tracked.
 */

import { DEFAULT_BUSINESS_HOURS } from '../definitions';
import type { BusinessHoursSettings, ClosureKind } from '../types';

export interface BusinessHoursCase {
  name: string;
  /** UTC instant. */
  instant: string;
  expected: {
    businessDate: string;
    minuteOfDay: number;
    dayOfWeek: number;
    isSunday: boolean;
    isWorkingDay: boolean;
    isBusinessHours: boolean;
    closureLabel: string | null;
    closureKind: ClosureKind | null;
  };
}

/** Labor Day 2026 is a Monday; the special closure is a Wednesday. */
export const FIXTURE_SETTINGS: BusinessHoursSettings = {
  ...DEFAULT_BUSINESS_HOURS,
  closures: [
    { date: '2026-09-07', label: 'Labor Day', kind: 'holiday' },
    { date: '2026-08-05', label: 'Office closed for maintenance', kind: 'special_closure' },
  ],
};

/** Same configuration with Sunday opened, for the Sunday-handling cases. */
export const SUNDAY_OPEN_SETTINGS: BusinessHoursSettings = {
  ...FIXTURE_SETTINGS,
  sundayIsWorkingDay: true,
};

export const BUSINESS_HOURS_CASES: readonly BusinessHoursCase[] = [
  {
    name: 'Monday 10:00 EDT is inside business hours',
    instant: '2026-08-03T14:00:00Z',
    expected: {
      businessDate: '2026-08-03',
      minuteOfDay: 600,
      dayOfWeek: 1,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: true,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Monday 08:30 EDT is inside business hours because opening is inclusive',
    instant: '2026-08-03T12:30:00Z',
    expected: {
      businessDate: '2026-08-03',
      minuteOfDay: 510,
      dayOfWeek: 1,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: true,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Monday 08:29 EDT is after hours, one minute before opening',
    instant: '2026-08-03T12:29:00Z',
    expected: {
      businessDate: '2026-08-03',
      minuteOfDay: 509,
      dayOfWeek: 1,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: false,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Monday 17:29 EDT is inside business hours, one minute before closing',
    instant: '2026-08-03T21:29:00Z',
    expected: {
      businessDate: '2026-08-03',
      minuteOfDay: 1049,
      dayOfWeek: 1,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: true,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Monday 17:30 EDT is after hours because closing is exclusive',
    instant: '2026-08-03T21:30:00Z',
    expected: {
      businessDate: '2026-08-03',
      minuteOfDay: 1050,
      dayOfWeek: 1,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: false,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Monday 22:00 EDT is after hours and still belongs to Monday',
    instant: '2026-08-04T02:00:00Z',
    expected: {
      businessDate: '2026-08-03',
      minuteOfDay: 1320,
      dayOfWeek: 1,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: false,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Tuesday 06:00 EDT is after hours, before opening',
    instant: '2026-08-04T10:00:00Z',
    expected: {
      businessDate: '2026-08-04',
      minuteOfDay: 360,
      dayOfWeek: 2,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: false,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Saturday 10:00 EDT is inside business hours',
    instant: '2026-08-01T14:00:00Z',
    expected: {
      businessDate: '2026-08-01',
      minuteOfDay: 600,
      dayOfWeek: 6,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: true,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Saturday 18:00 EDT is after hours',
    instant: '2026-08-01T22:00:00Z',
    expected: {
      businessDate: '2026-08-01',
      minuteOfDay: 1080,
      dayOfWeek: 6,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: false,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Sunday 12:00 EDT is after hours while Sunday is closed',
    instant: '2026-08-02T16:00:00Z',
    expected: {
      businessDate: '2026-08-02',
      minuteOfDay: 720,
      dayOfWeek: 0,
      isSunday: true,
      isWorkingDay: false,
      isBusinessHours: false,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'A holiday at midday is after hours for the whole day',
    instant: '2026-09-07T16:00:00Z',
    expected: {
      businessDate: '2026-09-07',
      minuteOfDay: 720,
      dayOfWeek: 1,
      isSunday: false,
      isWorkingDay: false,
      isBusinessHours: false,
      closureLabel: 'Labor Day',
      closureKind: 'holiday',
    },
  },
  {
    name: 'A special closure at midday is after hours for the whole day',
    instant: '2026-08-05T16:00:00Z',
    expected: {
      businessDate: '2026-08-05',
      minuteOfDay: 720,
      dayOfWeek: 3,
      isSunday: false,
      isWorkingDay: false,
      isBusinessHours: false,
      closureLabel: 'Office closed for maintenance',
      closureKind: 'special_closure',
    },
  },

  // ---- Daylight saving: spring forward, 08:00 March 2026 -------------------
  // Friday is EST (UTC-5), the following Monday is EDT (UTC-4). Both instants are
  // 08:30 local and both must be business hours. Two different UTC times, one wall
  // clock: this is the case the current `toLocaleString` round trip gets wrong.
  {
    name: 'Friday before spring forward, 08:30 EST, is inside business hours',
    instant: '2026-03-06T13:30:00Z',
    expected: {
      businessDate: '2026-03-06',
      minuteOfDay: 510,
      dayOfWeek: 5,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: true,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Monday after spring forward, 08:30 EDT, is inside business hours',
    instant: '2026-03-09T12:30:00Z',
    expected: {
      businessDate: '2026-03-09',
      minuteOfDay: 510,
      dayOfWeek: 1,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: true,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Spring-forward Sunday 01:00 EST reads as 01:00 local',
    instant: '2026-03-08T06:00:00Z',
    expected: {
      businessDate: '2026-03-08',
      minuteOfDay: 60,
      dayOfWeek: 0,
      isSunday: true,
      isWorkingDay: false,
      isBusinessHours: false,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Spring-forward Sunday 04:00 EDT reads as 04:00 local, not 03:00',
    instant: '2026-03-08T08:00:00Z',
    expected: {
      businessDate: '2026-03-08',
      minuteOfDay: 240,
      dayOfWeek: 0,
      isSunday: true,
      isWorkingDay: false,
      isBusinessHours: false,
      closureLabel: null,
      closureKind: null,
    },
  },

  // ---- Daylight saving: fall back, 01:00 November 2026 --------------------
  {
    name: 'Friday before fall back, 08:30 EDT, is inside business hours',
    instant: '2026-10-30T12:30:00Z',
    expected: {
      businessDate: '2026-10-30',
      minuteOfDay: 510,
      dayOfWeek: 5,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: true,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Monday after fall back, 08:30 EST, is inside business hours',
    instant: '2026-11-02T13:30:00Z',
    expected: {
      businessDate: '2026-11-02',
      minuteOfDay: 510,
      dayOfWeek: 1,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: true,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Fall-back Sunday 01:30 EDT, the first pass through the repeated hour',
    instant: '2026-11-01T05:30:00Z',
    expected: {
      businessDate: '2026-11-01',
      minuteOfDay: 90,
      dayOfWeek: 0,
      isSunday: true,
      isWorkingDay: false,
      isBusinessHours: false,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Fall-back Sunday 01:30 EST, the second pass through the repeated hour',
    instant: '2026-11-01T06:30:00Z',
    expected: {
      businessDate: '2026-11-01',
      minuteOfDay: 90,
      dayOfWeek: 0,
      isSunday: true,
      isWorkingDay: false,
      isBusinessHours: false,
      closureLabel: null,
      closureKind: null,
    },
  },

  // ---- Midnight, where hourCycle matters ----------------------------------
  {
    name: 'Midnight EDT reads as minute zero, not minute 1440',
    instant: '2026-08-03T04:00:00Z',
    expected: {
      businessDate: '2026-08-03',
      minuteOfDay: 0,
      dayOfWeek: 1,
      isSunday: false,
      isWorkingDay: true,
      isBusinessHours: false,
      closureLabel: null,
      closureKind: null,
    },
  },
];

/** Sunday cases evaluated against `SUNDAY_OPEN_SETTINGS`. */
export const SUNDAY_OPEN_CASES: readonly BusinessHoursCase[] = [
  {
    name: 'Sunday 12:00 EDT is inside business hours once Sunday is opened',
    instant: '2026-08-02T16:00:00Z',
    expected: {
      businessDate: '2026-08-02',
      minuteOfDay: 720,
      dayOfWeek: 0,
      isSunday: true,
      isWorkingDay: true,
      isBusinessHours: true,
      closureLabel: null,
      closureKind: null,
    },
  },
  {
    name: 'Sunday 20:00 EDT is still after hours once Sunday is opened',
    instant: '2026-08-03T00:00:00Z',
    expected: {
      businessDate: '2026-08-02',
      minuteOfDay: 1200,
      dayOfWeek: 0,
      isSunday: true,
      isWorkingDay: true,
      isBusinessHours: false,
      closureLabel: null,
      closureKind: null,
    },
  },
];

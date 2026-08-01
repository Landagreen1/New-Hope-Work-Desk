// src/features/time-attendance/shared/useAttendanceRoster.ts
// The employees a screen may name, for the controls that have to name one.
//
// Two Review views need a roster before they can ask their real question. The
// Employee Trends view is about one employee over one range (Requirement 14,
// criterion 1) and the employee-trends export names one employee (Requirement 15,
// criterion 1), and neither read can be issued until an employee has been chosen —
// so neither read can supply the list to choose from.
//
// `/api/attendance/day` is that list. It answers one date for every employee in
// scope and carries `employees` whether or not those employees have anything
// recorded on the date, which is exactly a roster; it resolves the date itself in
// the business timezone, so nothing here has to decide what "today" is; and it is
// six queries whatever the roster size, so it costs what any other single read
// costs. Adding a roster endpoint would be a second definition of who is in scope,
// and `visibleProfileIds` is meant to be the only one.
//
// The records the read also returns are ignored. That is the price of not adding
// an endpoint, and it is paid once per screen rather than per employee.
//
// ## The business timezone comes out of the same read
//
// `DayResponse.policy` carries `attendance_policy`, and the organisation's zone is
// one of its fields. The workspace needs that zone before it has rendered any
// screen — the Health_Ribbon's seven dates begin on the organisation's current
// date (Requirement 18, criterion 2), and the Time Off & Coverage panes format
// against it — and it holds no policy read of its own.
//
// `useBusinessTimeZone` is that read, delegating to this hook rather than issuing
// its own, so `/api/attendance/day` is still called from one place in the client.
// A policy endpoint would be a second definition of a singleton this response
// already carries.
//
// Requirements: 14.1, 15.1, 18.2, 19.1, 20.1, 21.1, 21.2, 22.14, 22.16

'use client';

import { useMemo } from 'react';

import type { AttendanceEmployee, DayResponse } from '../server/attendance-service';
import type { ApiFailure } from './api-failure';
import { attendanceJson } from './api-failure';
import { useAsyncResource, type AsyncResourceStatus } from './useAsyncResource';

/** A stable empty roster, so a memo does not see a new array every render. */
const NO_EMPLOYEES: readonly AttendanceEmployee[] = [];

export interface AttendanceRoster {
  /** Every employee in scope, ordered by display name. */
  employees: readonly AttendanceEmployee[];
  /** True when the read covered employees other than the caller. */
  teamScope: boolean;
  /**
   * `attendance_policy.business_timezone`, or null until the read has resolved and
   * for a read that failed.
   *
   * Null rather than a fallback zone, so a caller decides for itself what to do
   * without one. The controls that take a zone already default to UTC, and a
   * default invented here would hide which of the two a screen is using.
   */
  businessTimezone: string | null;
  status: AsyncResourceStatus;
  failure: ApiFailure | null;
  pending: boolean;
  retry: () => void;
}

/**
 * The employees the signed-in caller may name.
 *
 * `enabled` exists so a screen that does not need the roster — a non-administrator
 * reaching a view that will refuse anyway — does not issue the read. It reports
 * `idle` in that case, which `AsyncStateBlock` renders as nothing selected rather
 * than as a failure.
 *
 * Requirements: 14.1, 22.14, 22.16
 */
export function useAttendanceRoster(enabled = true): AttendanceRoster {
  const day = useAsyncResource(
    (signal) => attendanceJson<DayResponse>('/api/attendance/day', { signal }),
    {
      enabled,
      subject: 'the employee list',
      // A roster read that returns nobody is a scope with nobody in it, which the
      // consuming control states as an empty select rather than as an empty screen.
      isEmpty: () => false,
    },
  );

  const employees = day.data?.employees;
  const businessTimezone = day.data?.policy.businessTimezone ?? null;

  return useMemo(
    () => ({
      employees: employees ?? NO_EMPLOYEES,
      teamScope: day.data?.teamScope ?? false,
      businessTimezone,
      status: day.status,
      failure: day.failure,
      pending: day.pending,
      retry: day.retry,
    }),
    [
      employees,
      day.data?.teamScope,
      businessTimezone,
      day.status,
      day.failure,
      day.pending,
      day.retry,
    ],
  );
}

/**
 * The organisation's timezone, for a caller that needs the zone and not the
 * roster.
 *
 * `undefined` rather than null while the read is outstanding, because that is what
 * every control taking a `timeZone` prop treats as "not supplied" and falls back to
 * UTC for. A caller passing this through therefore starts on the fallback and moves
 * to the organisation's zone once the read resolves, rather than rendering nothing
 * until it does.
 *
 * Delegates to `useAttendanceRoster`, so this is the same single
 * `/api/attendance/day` read rather than a second one.
 *
 * Requirements: 18.2, 19.1
 */
export function useBusinessTimeZone(enabled = true): string | undefined {
  return useAttendanceRoster(enabled).businessTimezone ?? undefined;
}

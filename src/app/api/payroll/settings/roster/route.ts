// src/app/api/payroll/settings/roster/route.ts
// GET /api/payroll/settings/roster
//
// Pay settings for every employee, in one request. Requirement 20, criterion 5
// asks the Workforce screen to retrieve pay settings for all listed employees in a
// single request, and the sibling `/api/payroll/settings` cannot answer that: it
// addresses one employee by `profile_id`, so a screen listing a roster of twenty
// issued twenty requests and grew a request per hire.
//
// The two endpoints stay separate rather than one endpoint with a mode, because
// they answer different questions and are permitted differently. Reading your own
// pay is an employee capability; reading everybody's is not.
//
// | Request                        | Answer                        |
// | ------------------------------ | ----------------------------- |
// | No Supabase configuration      | 503                           |
// | No session                     | 401                           |
// | A role the module cannot name  | 403 `not_authorised`          |
// | A signed-in non-administrator  | 403 `not_authorised`          |
// | An administrator               | 200 `{ settings: [ … ] }`     |
// | The read failed                | 500 `read_failed`             |
//
// Requirement 21, criterion 6 reserves pay figures to an Attendance_Administrator,
// so the gate is `canAdministerAttendance` before anything is read, and row level
// security on `employee_payment_settings` enforces the same rule underneath
// (criterion 10). There is no per-employee narrowing to do: an administrator's
// visibility is the whole roster, and a non-administrator is refused rather than
// answered with their own row — a caller asking for the roster and receiving one
// row would read it as a roster of one.
//
// ## What comes back
//
// One entry per configured employee, carrying the four fields the pay table
// displays. An employee with no row is simply absent, which is the same statement
// `/api/payroll/settings` makes with an explicit `null`: pay has not been set up
// yet. Nothing is invented in its place, and no display name is joined in — the
// screen already has the roster it listed, and joining `profiles` here would make
// this read a second definition of who is on it.
//
// Requirements: 20.1, 20.5, 21.6, 21.10, 21.12, 21.15, 22.16

import { resolveActor } from '@/features/time-attendance/server/api-actor';
import { apiOk, failed, serviceFailure, unauthorised } from '@/features/time-attendance/server/api-response';
import { canAdministerAttendance } from '@/features/time-attendance/server/visibility';

export const runtime = 'nodejs';

/** The columns the Workforce pay table reads. */
const ROSTER_PAY_COLUMNS = 'profile_id, pay_type, hourly_rate, salary_amount';

/** Stated when a signed-in caller without administration asks for the roster. */
const PAY_RESERVED_MESSAGE =
  'Pay settings for the whole roster are reserved to a super admin.';

/**
 * Stated when the read itself failed.
 *
 * Not the driver's message, and it names no employee: a failure should not confirm
 * who is on the payroll.
 */
const ROSTER_UNREADABLE_MESSAGE =
  'Pay settings could not be read. Retrying may succeed.';

export async function GET() {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  if (!canAdministerAttendance(resolved.actor.role)) {
    return unauthorised('not_authorised', PAY_RESERVED_MESSAGE);
  }

  try {
    const { data, error } = await resolved.client
      .from('employee_payment_settings')
      .select(ROSTER_PAY_COLUMNS);

    // A failed read is not an empty result: row level security answers an
    // unpermitted read with no rows rather than with an error, so this is a fault
    // the caller may retry.
    if (error) {
      console.error('[time-attendance] roster pay settings read failed', error);
      return failed('read_failed', ROSTER_UNREADABLE_MESSAGE);
    }

    return apiOk({ settings: data ?? [] });
  } catch (error) {
    return serviceFailure(error);
  }
}

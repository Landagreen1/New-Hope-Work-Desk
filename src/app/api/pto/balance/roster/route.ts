// src/app/api/pto/balance/roster/route.ts
// GET /api/pto/balance/roster?year=2026
//
// Time-off balances for every employee, in one request. Requirement 20, criterion
// 6 asks the Workforce screen to retrieve time-off balances for all listed
// employees in a single request, and the sibling `/api/pto/balance` cannot answer
// that: it addresses one employee and one year, so the balances editor issued one
// request per employee and grew a request per hire.
//
// | Request                        | Answer                             |
// | ------------------------------ | ---------------------------------- |
// | No Supabase configuration      | 503                                |
// | No session                     | 401                                |
// | A role the module cannot name  | 403 `not_authorised`               |
// | A signed-in non-administrator  | 403 `not_authorised`               |
// | `year` that is not a year      | 400 `invalid_parameter`            |
// | An administrator               | 200 `{ year, balances: [ … ] }`    |
// | The read failed                | 500 `read_failed`                  |
//
// Administrator-only, before anything is read: the whole roster's allocations and
// usage are an administration view, and a non-administrator is refused rather than
// answered with their own row, which a caller asking for the roster would read as a
// roster of one. Row level security on `pto_balances` enforces the same rule
// underneath.
//
// ## The year
//
// `year` is optional and defaults to the current year in the business timezone,
// read from `attendance_policy` rather than taken from the browser — on 31 December
// the two disagree, and the balance year a screen edits should not depend on where
// the reader is sitting. The year actually used comes back on the response, so the
// screen states the year it is showing rather than assuming its own.
//
// ## An unconfigured employee is absent, not defaulted
//
// One entry per stored row. An employee with no `pto_balances` row for the year is
// absent from the list, and the screen shows its own allocation defaults for them.
// This endpoint invents no row: fabricating a balance per employee is the behaviour
// Appendix A.2 records against the old pay-settings read, where a substituted
// default object was indistinguishable from stored data. The single-employee
// sibling still substitutes one, which is why this is stated here rather than
// assumed.
//
// Requirements: 20.1, 20.6, 21.6, 21.10, 21.15, 22.16

import { workDateOf } from '@/features/time-attendance/domain/work-date';
import { resolveActor } from '@/features/time-attendance/server/api-actor';
import {
  ApiRequestError,
  apiOk,
  failed,
  serviceFailure,
  unauthorised,
} from '@/features/time-attendance/server/api-response';
import { loadAttendancePolicy } from '@/features/time-attendance/server/policy';
import { canAdministerAttendance } from '@/features/time-attendance/server/visibility';

export const runtime = 'nodejs';

/** The columns the Workforce balances editor reads. */
const ROSTER_BALANCE_COLUMNS =
  'profile_id, year, vacation_days, personal_days, vacation_used, personal_used';

/** Stated when a signed-in caller without administration asks for the roster. */
const BALANCES_RESERVED_MESSAGE =
  'Time-off balances for the whole roster are reserved to a super admin.';

/** Stated when the read itself failed. Names no employee. */
const ROSTER_UNREADABLE_MESSAGE =
  'Time-off balances could not be read. Retrying may succeed.';

/** The years `pto_balances.year` can meaningfully hold. */
const YEAR_PATTERN = /^\d{4}$/;

/**
 * The requested balance year, or undefined when the parameter is absent.
 *
 * Refused rather than coerced: `?year=abc` read as the current year answers a
 * different question than the one asked, and an editor saving against a year it
 * did not choose moves the wrong allocation.
 */
function optionalYear(params: URLSearchParams): number | undefined {
  const given = params.get('year');
  if (given === null || given.trim() === '') return undefined;

  const value = given.trim();
  if (!YEAR_PATTERN.test(value)) {
    throw new ApiRequestError(
      'invalid_parameter',
      `year must be a four-digit year, received "${value}"`,
      'year',
    );
  }
  return Number(value);
}

export async function GET(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  if (!canAdministerAttendance(resolved.actor.role)) {
    return unauthorised('not_authorised', BALANCES_RESERVED_MESSAGE);
  }

  try {
    const requested = optionalYear(new URL(request.url).searchParams);

    // The policy is read only when the year has to be resolved, so a caller that
    // states its year costs one query.
    const year =
      requested ??
      Number(
        workDateOf(
          new Date(),
          (await loadAttendancePolicy(resolved.client)).businessTimezone,
        ).slice(0, 4),
      );

    const { data, error } = await resolved.client
      .from('pto_balances')
      .select(ROSTER_BALANCE_COLUMNS)
      .eq('year', year);

    if (error) {
      console.error('[time-attendance] roster time-off balances read failed', error);
      return failed('read_failed', ROSTER_UNREADABLE_MESSAGE);
    }

    return apiOk({ year, balances: data ?? [] });
  } catch (error) {
    return serviceFailure(error);
  }
}

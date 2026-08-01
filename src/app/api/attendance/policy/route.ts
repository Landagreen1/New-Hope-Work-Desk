// src/app/api/attendance/policy/route.ts
// GET   /api/attendance/policy   read the attendance policy singleton
// PATCH /api/attendance/policy   change it, super_admin only
//
// The Workforce screen's attendance-policy editor (Requirement 2, criterion 3).
// `attendance_policy` owns every tolerance the Status Rule Matrix refers to — the
// grace period, the early-departure tolerance, the missing-clock-out tolerance,
// the break-overrun allowance, and which break types are unpaid — and until now
// the module could only read them. This is the write.
//
// ## Who may read, and who may write
//
// | Request                                  | Answer                          |
// | ---------------------------------------- | ------------------------------- |
// | No Supabase configuration                | 503                             |
// | No session                               | 401                             |
// | A role the module cannot name            | 403 `not_authorised`            |
// | GET, any signed-in caller                | 200 `{ policy, updatedAt }`     |
// | PATCH without administration             | 403 `not_authorised`            |
// | PATCH with a field the policy rejects    | 400 `invalid_parameter`, `field`|
// | PATCH naming no field at all             | 400 `invalid_parameter`         |
// | PATCH that committed                     | 200 `{ policy, updatedAt }`     |
// | The read or the write failed             | 500 `read_failed`/`write_failed`|
//
// The read is open to every signed-in user because the tolerances are what My Day,
// the Health Ribbon, and every status pill are derived from, and row level security
// on the table says the same thing: select for `authenticated`, update and insert
// for `super_admin`. The write is gated on `canAdministerAttendance` before the
// body is read, so a call outside the permitted set touches nothing (Requirement
// 21, criteria 6, 12, and 15), and the policy underneath refuses it a second time.
//
// ## Why PATCH rather than PUT
//
// Every field is optional and an absent field keeps its stored value. A form that
// submits four tolerances therefore cannot silently reset the fifth, and two
// administrators editing different fields do not overwrite each other. A PUT would
// have to carry the whole singleton on every save, including `business_timezone`,
// which this endpoint does not accept at all: the zone is what every stored shift
// time is read in and every work date is derived against, so changing it
// re-derives history and belongs to a deployment decision rather than to a form.
//
// ## What comes back
//
// The committed policy, read back in the same statement that wrote it, plus
// `updatedAt`. The editor replaces its form from that response rather than from
// what it submitted, which is the module's rule for every mutation: the screen
// derives nothing and displays what the server committed (Requirement 22).
//
// A policy change is not written to the Attendance_Audit_Log. Requirement 16,
// criterion 1 names five audited events — corrections, time-off decisions,
// coverage overrides, review status changes, and payroll processing — each of
// which is about one employee on one work date, which a configuration change is
// not. The row's own `updated_by` and `updated_at` carry who changed it and when.
//
// Requirements: 2.3, 2.5, 3.10, 3.12, 16.1, 21.6, 21.12, 21.15, 22.16

import { resolveActor } from '@/features/time-attendance/server/api-actor';
import {
  ApiRequestError,
  apiOk,
  serviceFailure,
  unauthorised,
} from '@/features/time-attendance/server/api-response';
import {
  KNOWN_BREAK_TYPES,
  loadPolicySnapshot,
  saveAttendancePolicy,
  type AttendancePolicyUpdate,
} from '@/features/time-attendance/server/policy';
import {
  optionalChoiceList,
  optionalWholeNumber,
  readJsonBody,
  type JsonBody,
} from '@/features/time-attendance/server/request-body';
import { canAdministerAttendance } from '@/features/time-attendance/server/visibility';

export const runtime = 'nodejs';

/** Stated when a signed-in caller without administration attempts the write. */
const POLICY_RESERVED_MESSAGE =
  'Changing the attendance policy is reserved to a super admin.';

/** Stated when a PATCH names none of the five editable fields. */
const NO_FIELDS_MESSAGE =
  'Name at least one policy field to change: grace_period_minutes, ' +
  'early_departure_tolerance_minutes, missing_clock_out_tolerance_minutes, ' +
  'break_overrun_minutes, or unpaid_break_types.';

/**
 * The largest tolerance the editor will store: one day.
 *
 * The column check is `>= 0` alone, so the upper bound is this route's. A
 * tolerance longer than a day cannot describe a shift boundary — a
 * missing-clock-out tolerance of a week means no session is ever reported as
 * unclosed — and a value that large is a slipped keystroke rather than a policy.
 * Refusing it names the field, which a stored nonsense value never would.
 */
const MAX_TOLERANCE_MINUTES = 1440;

/** One tolerance, as a whole number of minutes within the accepted range. */
function toleranceMinutes(body: JsonBody, field: string): number | undefined {
  const value = optionalWholeNumber(body, field);
  if (value === undefined) return undefined;

  if (value < 0 || value > MAX_TOLERANCE_MINUTES) {
    throw new ApiRequestError(
      'invalid_parameter',
      `${field} must be between 0 and ${MAX_TOLERANCE_MINUTES} minutes, received ${value}`,
      field,
    );
  }
  return value;
}

/**
 * The five editable fields, as the update the service applies.
 *
 * Assigned only when given, so an absent field stays absent on the object rather
 * than becoming an explicit `undefined` that `policyUpdateColumns` would have to
 * tell apart from a value.
 */
function readPolicyUpdate(body: JsonBody): AttendancePolicyUpdate {
  const update: AttendancePolicyUpdate = {};

  const grace = toleranceMinutes(body, 'grace_period_minutes');
  if (grace !== undefined) update.gracePeriodMinutes = grace;

  const earlyDeparture = toleranceMinutes(body, 'early_departure_tolerance_minutes');
  if (earlyDeparture !== undefined) update.earlyDepartureToleranceMinutes = earlyDeparture;

  const missingClockOut = toleranceMinutes(body, 'missing_clock_out_tolerance_minutes');
  if (missingClockOut !== undefined) update.missingClockOutToleranceMinutes = missingClockOut;

  const breakOverrun = toleranceMinutes(body, 'break_overrun_minutes');
  if (breakOverrun !== undefined) update.breakOverrunMinutes = breakOverrun;

  // The accepted names come from the loader, so the editor cannot store a break
  // type the loader would drop on the way back out.
  const unpaidBreakTypes = optionalChoiceList(body, 'unpaid_break_types', KNOWN_BREAK_TYPES);
  if (unpaidBreakTypes !== undefined) update.unpaidBreakTypes = unpaidBreakTypes;

  if (Object.keys(update).length === 0) {
    throw new ApiRequestError('invalid_parameter', NO_FIELDS_MESSAGE, 'body');
  }
  return update;
}

/**
 * GET /api/attendance/policy
 *
 * Requirements: 2.3, 22.16
 */
export async function GET() {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    return apiOk(await loadPolicySnapshot(resolved.client));
  } catch (error) {
    return serviceFailure(error);
  }
}

/**
 * PATCH /api/attendance/policy
 *
 * ```
 * {
 *   "grace_period_minutes":                5,          // optional, 0–1440
 *   "early_departure_tolerance_minutes":   15,         // optional, 0–1440
 *   "missing_clock_out_tolerance_minutes": 120,        // optional, 0–1440
 *   "break_overrun_minutes":               60,         // optional, 0–1440
 *   "unpaid_break_types":                  ["lunch"]   // optional, may be empty
 * }
 * ```
 *
 * Requirements: 2.3, 21.6, 21.12, 21.15, 22.16
 */
export async function PATCH(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  // Authorised before the body is read, so a refused call parses nothing and
  // touches nothing.
  if (!canAdministerAttendance(resolved.actor.role)) {
    return unauthorised('not_authorised', POLICY_RESERVED_MESSAGE);
  }

  try {
    const update = readPolicyUpdate(await readJsonBody(request));
    return apiOk(await saveAttendancePolicy(resolved.client, resolved.actor.id, update));
  } catch (error) {
    // One statement, so nothing was saved when it failed.
    return serviceFailure(error, 'write_failed');
  }
}

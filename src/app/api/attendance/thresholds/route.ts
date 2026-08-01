// src/app/api/attendance/thresholds/route.ts
// GET   /api/attendance/thresholds   read every configured staffing threshold
// PATCH /api/attendance/thresholds   change a set of them, super_admin only
//
// The Workforce screen's staffing-threshold editor (Requirement 2, criterion 3;
// Requirement 6, criterion 3). `staffing_thresholds` states the minimum and
// warning headcount per department, day of week, and time slot. The figures
// arrived through the v1.9.5 seed migration and, until now, nothing in the
// application could change them: re-running a seed is the only tool an
// administrator had, and a seed overwrites all sixty slots.
//
// ## Who may read, and who may write
//
// | Request                                     | Answer                        |
// | ------------------------------------------- | ----------------------------- |
// | No Supabase configuration                   | 503                           |
// | No session                                  | 401                           |
// | A role the module cannot name               | 403 `not_authorised`          |
// | GET, any signed-in caller                   | 200 `{ entries }`             |
// | PATCH without administration                | 403 `not_authorised`          |
// | PATCH with a slot or figure refused         | 400 `invalid_parameter`, `field` |
// | PATCH naming no slot at all                 | 400 `invalid_parameter`       |
// | PATCH that committed                        | 200 `{ entries }`             |
// | The read or the write failed                | 500 `read_failed`/`write_failed` |
//
// The read is open to every signed-in user because the thresholds are what every
// coverage status is classified against, and row level security says the same
// thing: `staffing_thresholds_authenticated_select` from v1.9.2 for the read,
// `staffing_thresholds_admin_all` from v1.6.2 — `super_admin` — for the write.
// Requirement 21, criterion 14 is the read, criterion 12 is the write, and
// Appendix B, Open Question 1 settled Attendance_Administrator as `super_admin`.
// The write is gated on `canAdministerAttendance` before the body is read, so a
// refused call parses nothing and touches nothing (Requirement 21, criterion 15),
// and the policy underneath refuses it a second time.
//
// ## One request for the whole edited set
//
// The editor covers four departments times seven days times three slots: 84
// cells. A save carries every cell the administrator changed in one `slots`
// array, and the service turns that into at most two statements — one upsert and
// one delete. Requirement 20, criteria 1 and 2 rule out a request per row, and a
// per-cell save would also make a multi-cell edit partially applied whenever one
// cell was refused.
//
// Every slot is validated before anything is written, and the first refusal
// refuses the whole set naming the slot it came from. A save that stored eleven of
// the twelve cells an administrator typed, with nothing on screen saying which
// one it dropped, is the failure this avoids.
//
// ## PATCH rather than PUT
//
// A slot the request does not name keeps whatever it holds. The body carries the
// edited cells, not the whole table, so two administrators editing different
// departments do not overwrite each other and an editor that has read a stale
// table cannot silently revert a slot it never displayed.
//
// ## Clearing a slot is not storing zero
//
// `thresholdFor` answers null for a slot with no row, which reports required
// staffing as unconfigured and Coverage_Status Healthy (Requirement 6,
// criterion 4). Saturday and Sunday carry no rows on purpose — see the header of
// `v1.9.5-staffing-thresholds-seed.sql` — because a stored `0 / 0` would classify
// an empty weekend as At Minimum and raise a warning against a requirement of
// nobody.
//
// So a slot entry either carries a pair or carries `"clear": true`, and the two
// are different statements. A pair of `0 / 0` is stored as a real requirement of
// nobody; a clear removes the row and returns the slot to unconfigured. An entry
// carrying both a pair and `clear` is refused rather than resolved, because there
// is no honest way to guess which the administrator meant.
//
// ## What comes back
//
// The whole table as it now stands, read back after the write. The editor
// replaces its grid from that response rather than from what it submitted, which
// is the module's rule for every mutation: the screen derives nothing and displays
// what the server committed. Reading the whole table rather than the changed rows
// is what lets a cleared slot come back as absent instead of unmentioned.
//
// Requirements: 2.3, 2.5, 6.3, 6.4, 16.1, 20.1, 20.2, 21.6, 21.12, 21.14, 21.15, 22.16

import {
  MAX_REQUIRED_STAFF,
  THRESHOLD_REJECTION_REASON,
  rejectThreshold,
} from '@/features/time-attendance/domain/coverage';
import { resolveActor } from '@/features/time-attendance/server/api-actor';
import {
  ApiRequestError,
  apiOk,
  serviceFailure,
  unauthorised,
} from '@/features/time-attendance/server/api-response';
import {
  KNOWN_DEPARTMENTS,
  KNOWN_TIME_SLOTS,
  describeSlot,
  loadThresholdSnapshot,
  saveStaffingThresholds,
  slotKey,
  type ThresholdEdit,
} from '@/features/time-attendance/server/policy';
import {
  optionalFlag,
  optionalObjectList,
  optionalWholeNumber,
  readJsonBody,
  requiredChoice,
  requiredWholeNumber,
  type JsonBody,
} from '@/features/time-attendance/server/request-body';
import { canAdministerAttendance } from '@/features/time-attendance/server/visibility';

export const runtime = 'nodejs';

/** Stated when a signed-in caller without administration attempts the write. */
const THRESHOLDS_RESERVED_MESSAGE =
  'Changing the staffing thresholds is reserved to a super admin.';

/** Stated when a PATCH carries no slots. */
const NO_SLOTS_MESSAGE =
  'Name at least one slot to change in slots, each with a department, a day_of_week, ' +
  'a time_slot, and either minimum_staff and warning_threshold or "clear": true.';

/** The highest `day_of_week` the column accepts. 0 is Sunday. */
const MAX_DAY_OF_WEEK = 6;

/** One entry's day of week, as the column's 0-to-6 range. */
function dayOfWeek(entry: JsonBody, label: string): number {
  const value = requiredWholeNumber(entry, 'day_of_week', `${label}.day_of_week`);

  if (value < 0 || value > MAX_DAY_OF_WEEK) {
    throw new ApiRequestError(
      'invalid_parameter',
      `${label}.day_of_week must be between 0 (Sunday) and ${MAX_DAY_OF_WEEK} (Saturday), received ${value}`,
      `${label}.day_of_week`,
    );
  }
  return value;
}

/** One headcount figure, as a whole number within the accepted range. */
function headcount(entry: JsonBody, field: string, label: string): number {
  const value = requiredWholeNumber(entry, field, `${label}.${field}`);

  if (value < 0 || value > MAX_REQUIRED_STAFF) {
    throw new ApiRequestError(
      'invalid_parameter',
      `${label}.${field} must be between 0 and ${MAX_REQUIRED_STAFF} people, received ${value}`,
      `${label}.${field}`,
    );
  }
  return value;
}

/**
 * One entry of `slots`, as the edit the service applies.
 *
 * The slot is read first, so a refusal about the figures can name the slot the
 * administrator typed them into rather than only its position in the array.
 */
function readEdit(entry: JsonBody, index: number): ThresholdEdit {
  const label = `slots[${index}]`;

  const slot = {
    department: requiredChoice(entry, 'department', KNOWN_DEPARTMENTS),
    dayOfWeek: dayOfWeek(entry, label),
    timeSlot: requiredChoice(entry, 'time_slot', KNOWN_TIME_SLOTS),
  };

  const clear = optionalFlag(entry, 'clear') === true;
  const namesFigures =
    optionalWholeNumber(entry, 'minimum_staff', `${label}.minimum_staff`) !== undefined ||
    optionalWholeNumber(entry, 'warning_threshold', `${label}.warning_threshold`) !== undefined;

  if (clear) {
    // Both together says two contradictory things about the same slot. Guessing
    // would store a requirement nobody asked for, or drop one they did.
    if (namesFigures) {
      throw new ApiRequestError(
        'invalid_parameter',
        `${label} for ${describeSlot(slot)} asks to clear the slot and also names a staffing figure. ` +
          'Send either "clear": true or the two figures, not both.',
        label,
      );
    }
    return { ...slot, clear: true };
  }

  const threshold = {
    minimumStaff: headcount(entry, 'minimum_staff', label),
    warningThreshold: headcount(entry, 'warning_threshold', label),
  };

  // The pair rule, read from the domain so the refusal and the coverage bands the
  // editor draws are the same statement about what a pair means.
  const rejection = rejectThreshold(threshold);
  if (rejection !== null) {
    throw new ApiRequestError(
      'invalid_parameter',
      `${label} for ${describeSlot(slot)}: ${THRESHOLD_REJECTION_REASON[rejection]}`,
      label,
    );
  }

  return { ...slot, ...threshold };
}

/**
 * The `slots` array as the edits the service applies.
 *
 * Every entry is validated before any of them is written, so a refused figure
 * leaves the whole table as it was. A slot named twice is refused rather than
 * resolved by order: two edits for one slot in one request say two things, and
 * silently keeping the last would commit a figure the administrator can see is not
 * the one they meant.
 */
function readEdits(body: JsonBody): ThresholdEdit[] {
  const entries = optionalObjectList(body, 'slots');
  if (entries === undefined || entries.length === 0) {
    throw new ApiRequestError('invalid_parameter', NO_SLOTS_MESSAGE, 'slots');
  }

  const edits = entries.map(readEdit);
  const seen = new Set<string>();

  for (const [index, edit] of edits.entries()) {
    const key = slotKey(edit);
    if (seen.has(key)) {
      throw new ApiRequestError(
        'invalid_parameter',
        `slots names ${describeSlot(edit)} more than once. Send one edit per slot.`,
        `slots[${index}]`,
      );
    }
    seen.add(key);
  }

  return edits;
}

/**
 * GET /api/attendance/thresholds
 *
 * Answers `{ entries }` with one entry per configured slot. An unconfigured slot
 * is absent rather than present with null figures, which is the same statement
 * the table makes (Requirement 6, criterion 4).
 *
 * Requirements: 6.3, 6.4, 21.14, 22.16
 */
export async function GET() {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    return apiOk(await loadThresholdSnapshot(resolved.client));
  } catch (error) {
    return serviceFailure(error);
  }
}

/**
 * PATCH /api/attendance/thresholds
 *
 * ```
 * {
 *   "slots": [
 *     { "department": "sales", "day_of_week": 1, "time_slot": "morning",
 *       "minimum_staff": 6, "warning_threshold": 8 },
 *     { "department": "sales", "day_of_week": 6, "time_slot": "morning",
 *       "clear": true }
 *   ]
 * }
 * ```
 *
 * Requirements: 2.3, 6.3, 6.4, 20.1, 20.2, 21.6, 21.12, 21.15, 22.16
 */
export async function PATCH(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  // Authorised before the body is read, so a refused call parses nothing and
  // touches nothing.
  if (!canAdministerAttendance(resolved.actor.role)) {
    return unauthorised('not_authorised', THRESHOLDS_RESERVED_MESSAGE);
  }

  try {
    const edits = readEdits(await readJsonBody(request));
    return apiOk(await saveStaffingThresholds(resolved.client, edits));
  } catch (error) {
    return serviceFailure(error, 'write_failed');
  }
}

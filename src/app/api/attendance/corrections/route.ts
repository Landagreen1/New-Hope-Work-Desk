// src/app/api/attendance/corrections/route.ts
// POST /api/attendance/corrections
//
// The one write behind every manual change to a stored punch: Correct Punch, Add
// Missing Punch, the four correction controls in the exception drawer, and Approve
// Unscheduled Work (Requirements 5.15, 12.12). One endpoint rather than one per
// action, because the actions differ by which field they name and by nothing else:
// each of them locks the row it changes, records the previous value, writes the
// audit entry in the same transaction, and answers with the recomputed record.
//
// ```
// {
//   "profile_id":      "…",                        // required
//   "work_date":       "2026-07-14",               // required
//   "field":           "clock_out",                // required, one of nine
//   "value":           "2026-07-14T22:05:00.000Z", // shape follows the field
//   "entity_id":       "…",                        // the row being corrected
//   "entity_type":     "clock_entry",              // optional assertion
//   "reason":          "…",                        // required, except for `note`
//   "idempotency_key": "…"                         // required, non-blank
// }
// ```
//
// The accepted fields are `CORRECTION_FIELDS`, exported by the service and offered
// here rather than transcribed, so this route cannot drift from the vocabulary
// `attendance_apply_correction` implements. `value` is the one field whose shape
// depends on another: an instant for the four punch fields, whole minutes for the
// two minute counts, `{ clock_in, clock_out?, break_minutes? }` for a whole added
// session, the note text for `note`, and nothing at all for `unscheduled_work`,
// whose approval is the audit entry.
//
// ## What this file decides
//
// The shape of the body. That is the whole of it. Whether the instant parses,
// whether the minutes are inside the accepted range, whether the named row exists,
// whether it belongs to the named employee, whether the correction would create a
// second open session, what the field held before, and which payroll period covers
// the date are all resolved by `applyCorrection` and by the function beneath it —
// under the row lock, where the answers cannot go stale between the check and the
// write. Re-deriving any of them here would be a second implementation of the
// correction vocabulary that could disagree with the first.
//
// ## The reason is required here as well as below
//
// Requirements 5.16, 12.13, and 21.9 require a stored reason of at least one
// non-whitespace character for every manual override of a derived value.
// `optionalText` already reads a whitespace-only string as absent, so requiring a
// value is exactly that rule, and it is answered as `reason_required` with the
// field named so the drawer can attach the message to the control that produced
// it. `note` is the one field that may omit it: the note text is its own stated
// reason, and the function copies it onto the audit entry rather than making the
// administrator type the same sentence twice.
//
// The service asserts the same rule, and so does the database function as the
// owner of the write. Three checks of one rule is deliberate: this one gives the
// caller a field to attach the message to, and the two below it hold for a caller
// that arrives another way (Requirement 21, criterion 10).
//
// ## What comes back
//
// The committed correction and the recomputed `DailyAttendanceRecord` for the
// affected employee and work date, read back from source rows after the
// transaction committed. The queue and the drawers replace the affected row from
// that response rather than reloading, which is Requirements 5.18 and 12.14.
//
// A resubmitted `idempotency_key` answers 200 with `applied: false` and the prior
// result: the change is already in place, and a retry after a lost response is not
// a conflict. The replay is still recorded in the audit log, pointing at the first
// entry, because two submitted corrections that showed one entry would understate
// what happened.
//
// Requirements: 5.15, 5.16, 5.17, 5.18, 12.12, 12.13, 12.14, 16.1, 16.2, 21.4,
// 21.9, 21.15, 22.16

import { resolveActor } from '@/features/time-attendance/server/api-actor';
import {
  ApiRequestError,
  apiOk,
  serviceFailure,
} from '@/features/time-attendance/server/api-response';
import {
  CORRECTION_FIELDS,
  applyCorrection,
  type CorrectionEntityType,
  type CorrectionField,
  type CorrectionInput,
  type NoteCorrectionInput,
  type SessionCorrectionInput,
  type UnscheduledWorkApprovalInput,
} from '@/features/time-attendance/server/attendance-service';
import {
  optionalBodyRecordId,
  optionalChoice,
  optionalText,
  optionalWholeNumber,
  readJsonBody,
  requiredBodyDate,
  requiredBodyObject,
  requiredBodyRecordId,
  requiredChoice,
  requiredText,
  requiredWholeNumber,
  type JsonBody,
} from '@/features/time-attendance/server/request-body';

export const runtime = 'nodejs';

/**
 * The caller's assertion about what it believes it is correcting.
 *
 * Optional, and validated by the function against the field it resolves itself,
 * so a drawer that names a break while sending a clock-entry field is refused.
 * Written as a `satisfies` list so a change to the service's vocabulary fails to
 * compile here rather than silently accepting a value the function will reject.
 */
const ENTITY_TYPES = [
  'clock_entry',
  'break',
  'note',
] as const satisfies readonly CorrectionEntityType[];

/**
 * Stated when a correction arrives without the reason every override requires.
 *
 * Local to this route rather than exported: a route module's exports are its
 * handlers and its configuration, and the wording belongs to the one refusal that
 * uses it.
 */
const REASON_REQUIRED_MESSAGE =
  'A correction carries a reason of at least one non-whitespace character.';

/** The fields every correction names, whichever value it changes. */
type CorrectionSubject = Pick<
  NoteCorrectionInput,
  'profileId' | 'workDate' | 'idempotencyKey' | 'reason' | 'entityType'
>;

/**
 * The reason the correction stores, or null for a note.
 *
 * Requirements 5.16, 12.13, 21.9.
 */
function readReason(body: JsonBody, field: CorrectionField): string | null {
  const reason = optionalText(body, 'reason');
  if (reason === undefined && field !== 'note') {
    throw new ApiRequestError('reason_required', REASON_REQUIRED_MESSAGE, 'reason');
  }
  return reason ?? null;
}

/** Who the correction is recorded against, and what makes it apply once. */
function readSubject(body: JsonBody, field: CorrectionField): CorrectionSubject {
  return {
    profileId: requiredBodyRecordId(body, 'profile_id'),
    workDate: requiredBodyDate(body, 'work_date'),
    idempotencyKey: requiredText(body, 'idempotency_key'),
    reason: readReason(body, field),
    entityType: optionalChoice(body, 'entity_type', ENTITY_TYPES) ?? null,
  };
}

/**
 * The added session's instants and break minutes.
 *
 * Read as the types they arrived as and passed on. Whether the two instants parse,
 * whether they are ordered, and whether the employee already has an open session
 * are the function's to answer under the lock.
 */
function readSession(body: JsonBody): SessionCorrectionInput['value'] {
  const source = requiredBodyObject(body, 'value');

  const value: SessionCorrectionInput['value'] = {
    clockIn: requiredText(source, 'clock_in', 'value.clock_in'),
    clockOut: optionalText(source, 'clock_out', 'value.clock_out') ?? null,
  };

  const breakMinutes = optionalWholeNumber(source, 'break_minutes', 'value.break_minutes');
  if (breakMinutes !== undefined) value.breakMinutes = breakMinutes;

  return value;
}

/** One correction, from a JSON body. */
function readCorrectionInput(body: JsonBody): CorrectionInput {
  const field = requiredChoice(body, 'field', CORRECTION_FIELDS);
  const subject = readSubject(body, field);

  switch (field) {
    // The four punch fields carry one instant and name the row it belongs to.
    case 'clock_in':
    case 'clock_out':
    case 'break_start':
    case 'break_end':
      return {
        ...subject,
        field,
        entityId: requiredBodyRecordId(body, 'entity_id'),
        value: requiredText(body, 'value'),
      };

    // Two stored minute counts, in two places, meaning two different things:
    // `break_minutes` moves the payroll-visible figure on the clock entry,
    // `duration_minutes` moves the break row the derivation reads.
    case 'break_minutes':
    case 'duration_minutes':
      return {
        ...subject,
        field,
        entityId: requiredBodyRecordId(body, 'entity_id'),
        value: requiredWholeNumber(body, 'value'),
      };

    // `session` and `note` insert a row, so neither names one. An `entity_id`
    // sent with either is refused by the function rather than ignored.
    case 'session':
      return { ...subject, field, value: readSession(body) };

    case 'note':
      return { ...subject, field, value: requiredText(body, 'value') };

    // The approval *is* the audit entry: there is no row to write and no
    // un-approve path, so the value is fixed and only the clock entry the
    // approval refers to is read.
    case 'unscheduled_work': {
      const input: UnscheduledWorkApprovalInput = { ...subject, field };

      const entityId = optionalBodyRecordId(body, 'entity_id');
      if (entityId !== undefined) input.entityId = entityId;

      return input;
    }
  }
}

export async function POST(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const input = readCorrectionInput(await readJsonBody(request));

    return apiOk(await applyCorrection(resolved.actor, input, { client: resolved.client }));
  } catch (error) {
    // `write_failed` is the honest fallback for an unclassified failure here: the
    // change and its audit entry share one transaction, so telling the caller
    // nothing was saved is true, where `read_failed` would invite a retry of a
    // request that may already have landed.
    return serviceFailure(error, 'write_failed');
  }
}

// src/app/api/attendance/notes/route.ts
// POST /api/attendance/notes
//
// Add Manager Note, the action the employee day drawer and the exception drawer
// both offer (Requirements 5.15, 12.12). The note is recorded against one employee
// and one work date, and it is read back by the drawers that display the notes for
// that employee and date (Requirement 5, criterion 12).
//
// ```
// {
//   "profile_id":      "…",           // required
//   "work_date":       "2026-07-14",  // required
//   "note":            "…",           // required, at least one non-whitespace character
//   "reason":          "…",           // optional; the note is its own stated reason
//   "idempotency_key": "…"            // required, non-blank
// }
// ```
//
// ## Why this is its own endpoint and still one write
//
// A note is the `note` field of `attendance_apply_correction`, so it takes exactly
// the path every other correction takes: `attendance_notes` row and
// `attendance_audit_log` entry in one transaction, the audit insert last, so a
// failed audit write leaves no note behind (Requirement 16, criterion 6). What this
// endpoint adds is a name for the action the drawers offer and a body without a
// `field` selector, which is what the design's route table asks for. The rule the
// note obeys, and the vocabulary it belongs to, stay in one place.
//
// The note text carries the field's own non-blank requirement — the database
// column has a check constraint to that effect, and `optionalText` reads a
// whitespace-only string as absent — so an empty note is refused here with the
// field named rather than reaching the constraint as a 500.
//
// `reason` is optional, and this is the one correction where that is true. The note
// text is itself the stated reason and the function copies it onto the audit entry,
// so Requirement 21, criterion 9 is satisfied without asking the administrator to
// write the same sentence twice.
//
// ## What comes back
//
// The committed note and the recomputed `DailyAttendanceRecord`, in the same
// envelope `/api/attendance/corrections` answers with, so a drawer handles one
// shape. `record` is null when the employee and work date carry no record at all: a
// note on a date with no schedule, no session, no approved absence, and no review
// has nothing to report a status about, and the note is still stored and audited.
//
// Requirements: 5.15, 5.17, 12.12, 12.14, 16.1, 16.2, 21.4, 21.9, 21.15, 22.16

import { resolveActor } from '@/features/time-attendance/server/api-actor';
import { apiOk, serviceFailure } from '@/features/time-attendance/server/api-response';
import {
  applyCorrection,
  type NoteCorrectionInput,
} from '@/features/time-attendance/server/attendance-service';
import {
  optionalText,
  readJsonBody,
  requiredBodyDate,
  requiredBodyRecordId,
  requiredText,
} from '@/features/time-attendance/server/request-body';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const body = await readJsonBody(request);

    const input: NoteCorrectionInput = {
      field: 'note',
      profileId: requiredBodyRecordId(body, 'profile_id'),
      workDate: requiredBodyDate(body, 'work_date'),
      value: requiredText(body, 'note'),
      idempotencyKey: requiredText(body, 'idempotency_key'),
      reason: optionalText(body, 'reason') ?? null,
    };

    return apiOk(await applyCorrection(resolved.actor, input, { client: resolved.client }));
  } catch (error) {
    // The note and its audit entry share one transaction, so `write_failed` is the
    // honest fallback: nothing was saved.
    return serviceFailure(error, 'write_failed');
  }
}

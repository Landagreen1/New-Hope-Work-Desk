// src/app/api/attendance/reviews/route.ts
// POST /api/attendance/reviews
//
// Mark Reviewed, for one employee and one work date (Requirement 12, criterion 15).
//
// ```
// {
//   "profile_id": "…",          // required
//   "work_date":  "2026-07-14"  // required
// }
// ```
//
// ## Two fields, and no reason
//
// Marking a day reviewed overrides no derived value: it records that an
// administrator looked at the row. Requirement 12, criterion 15 asks for the actor
// and the timestamp, and Requirement 21, criterion 9 requires a stored reason for
// manual overrides, which this is not. So the body is the two fields the design's
// signature names and nothing else.
//
// ## No idempotency key either, because the primary key is one
//
// `attendance_mark_reviewed` inserts with `on conflict (profile_id, work_date) do
// nothing`, so a second call retains the first reviewer and timestamp through the
// composite primary key rather than through a read-then-write that two
// administrators could interleave (Requirement 12, criterion 16). A repeat answers
// 200 with `applied: false`, `code: 'already_reviewed'`, and the retained reviewer,
// and writes no audit entry: Requirement 16, criterion 1 records changes to review
// status, and a repeat changes nothing.
//
// That is deliberately the opposite of a replayed correction, which is a
// resubmitted change and is recorded as one — which is why a correction carries a
// key and this does not.
//
// ## What comes back
//
// The review stamp and the recomputed `DailyAttendanceRecord`, because the stamp is
// part of the record and the Exception Queue filters on review status: the row the
// administrator just reviewed has to be able to leave the queue without a reload
// (Requirements 12.3, 12.14).
//
// Requirements: 12.15, 12.16, 16.1, 16.2, 21.4, 21.15, 22.16

import { resolveActor } from '@/features/time-attendance/server/api-actor';
import { apiOk, serviceFailure } from '@/features/time-attendance/server/api-response';
import { markReviewed } from '@/features/time-attendance/server/attendance-service';
import {
  readJsonBody,
  requiredBodyDate,
  requiredBodyRecordId,
} from '@/features/time-attendance/server/request-body';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const body = await readJsonBody(request);
    const profileId = requiredBodyRecordId(body, 'profile_id');
    const workDate = requiredBodyDate(body, 'work_date');

    return apiOk(
      await markReviewed(resolved.actor, profileId, workDate, { client: resolved.client }),
    );
  } catch (error) {
    // The review row and its audit entry share one transaction, so `write_failed`
    // is the honest fallback: the day is unreviewed and nothing was saved.
    return serviceFailure(error, 'write_failed');
  }
}

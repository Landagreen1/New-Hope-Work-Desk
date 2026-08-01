// src/app/api/attendance/audit/route.ts
// GET /api/attendance/audit?from&to&profile_id&action&actor_id&page&limit
//
// One page of the attendance audit trail, newest first: every field Requirement 16,
// criterion 2 records, under the four filters of criterion 4, in pages of at most a
// hundred entries (criterion 7).
//
// The response carries back the query the entries were selected by, with the paging
// that was actually applied, so the view can name its own active filters and can
// page without keeping a second copy of what it asked for.
//
// A caller that names no range gets the trail unfiltered by date rather than a
// default window. The page is what bounds the read, and an audit question is as
// often "has this ever been recorded" as "what happened last fortnight" — a silent
// two-week default would answer the first one wrongly and look like an answer.
//
// The trail is administrator-only, which `getAuditEntries` refuses rather than
// narrows: `v1.9.0` grants `select` on `attendance_audit_log` to `super_admin`
// alone, so an employee's read would come back empty, and an empty audit trail
// reads as "nothing was recorded" rather than as "you may not ask".
//
// Requirements: 16.2, 16.3, 16.4, 16.7, 21.1, 21.15, 22.16

import {
  refuseInvisibleProfiles,
  resolveActor,
} from '@/features/time-attendance/server/api-actor';
import { apiOk, serviceFailure } from '@/features/time-attendance/server/api-response';
import { getAuditEntries } from '@/features/time-attendance/server/attendance-service';
import { parseAuditQuery } from '@/features/time-attendance/server/request-query';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const { searchParams } = new URL(request.url);
    const query = parseAuditQuery(searchParams);

    // Both employee filters are checked, because either can name somebody: an
    // entry has an affected employee and an actor, and a caller may not ask about
    // an employee outside their visibility under either heading. A refusal states
    // what was refused rather than whether the employee exists.
    const refusal = await refuseInvisibleProfiles(resolved.actor, [
      ...(query.profileIds ?? []),
      ...(query.actorProfileIds ?? []),
    ]);
    if (refusal !== null) return refusal;

    return apiOk(await getAuditEntries(resolved.actor, query, { client: resolved.client }));
  } catch (error) {
    return serviceFailure(error);
  }
}

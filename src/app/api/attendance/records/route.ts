// src/app/api/attendance/records/route.ts
// GET /api/attendance/records?from&to&status&exception&department&saved_filter&...
//
// One page of Daily_Attendance_Records for a query: the rows behind the Exception
// Queue, and the rows behind every drill-down that reaches it. At most 100 rows
// per request, one row per employee per work date however many exceptions that
// row carries (Requirements 12.4, 12.17, 12.20, 20.8).
//
// The response carries back the query the rows were actually selected by — the
// caller's filters conjoined with the resolved scope, the resolved range, and the
// applied paging. A metric drill-down therefore lands on exactly the rows the
// metric was computed over, and the queue can name its own active filters without
// guessing.
//
// A caller that names no range gets the service's fallback fortnight rather than
// the whole history. The Exception Queue's own default is the current pay period,
// which the caller supplies because only the caller knows which period is current
// (Requirement 12, criterion 19).
//
// Requirements: 12.3, 12.4, 12.5, 12.17, 12.19, 12.20, 14.2, 20.8, 21.15, 22.16

import {
  refuseInvisibleProfiles,
  resolveActor,
} from '@/features/time-attendance/server/api-actor';
import { apiOk, serviceFailure } from '@/features/time-attendance/server/api-response';
import { getRecords } from '@/features/time-attendance/server/attendance-service';
import { parseRecordQuery } from '@/features/time-attendance/server/request-query';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const { searchParams } = new URL(request.url);
    const query = parseRecordQuery(searchParams);

    // An employee asking for a colleague is refused rather than answered with an
    // empty page, which would read as "no records" instead of "not yours".
    const refusal = await refuseInvisibleProfiles(resolved.actor, query.profileIds);
    if (refusal !== null) return refusal;

    return apiOk(await getRecords(resolved.actor, query, { client: resolved.client }));
  } catch (error) {
    return serviceFailure(error);
  }
}

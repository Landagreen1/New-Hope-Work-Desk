// src/app/api/attendance/day/route.ts
// GET /api/attendance/day?date=YYYY-MM-DD
//
// One date's Daily_Attendance_Records for every employee the caller may see.
// Serves My Day for an employee and Team Today for an administrator from the
// same read: the difference between the two is the scope `visibleProfileIds`
// resolves, not a different endpoint or a different derivation.
//
// Six outbound queries — the policy singleton and the five range reads —
// whatever the roster size, which is what lets Team Today load the whole team in
// one request (Requirement 20, criteria 1 through 3).
//
// `date` is optional. When it is absent the date is resolved here as today in the
// business timezone rather than taken from the browser: a client sending its own
// local date would file the hour either side of midnight against the wrong work
// date. The policy read that resolves the timezone is passed into the service, so
// the default costs no extra query.
//
// Requirements: 4.1–4.19, 5.3–5.13, 20.3, 21.15, 22.16

import { workDateOf } from '@/features/time-attendance/domain/work-date';
import { resolveActor } from '@/features/time-attendance/server/api-actor';
import { apiOk, serviceFailure } from '@/features/time-attendance/server/api-response';
import { getDay } from '@/features/time-attendance/server/attendance-service';
import { loadAttendancePolicy } from '@/features/time-attendance/server/policy';
import { optionalDate } from '@/features/time-attendance/server/request-query';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const { searchParams } = new URL(request.url);
    const requested = optionalDate(searchParams, 'date');

    const evaluatedAt = new Date().toISOString();
    const policy = await loadAttendancePolicy(resolved.client);
    const date = requested ?? workDateOf(new Date(evaluatedAt), policy.businessTimezone);

    return apiOk(
      await getDay(resolved.actor, date, { client: resolved.client, evaluatedAt, policy }),
    );
  } catch (error) {
    return serviceFailure(error);
  }
}

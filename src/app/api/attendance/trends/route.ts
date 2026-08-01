// src/app/api/attendance/trends/route.ts
// GET /api/attendance/trends?profile_id=…&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// One employee's attendance history over one range, in one request: the twelve
// values of Requirement 14, criterion 2, the scheduled-versus-worked comparison
// per date, the manager notes, and every record in the range so a drill-down needs
// no second read (Requirement 14, criterion 6).
//
// All three parameters are required. A trend is about a named person over a named
// range, and defaulting either would answer a different question than the one the
// view asked.
//
// The employee is checked against the caller's visibility before any attendance
// row is read, so an employee asking for a colleague's history is refused rather
// than answered with an empty history (Requirement 21, criteria 1 and 15). The
// refusal states what was refused, not whether the record exists.
//
// Requirements: 14.1, 14.2, 14.3, 14.4, 14.6, 21.1, 21.15, 22.16

import { resolveActor } from '@/features/time-attendance/server/api-actor';
import { apiOk, serviceFailure } from '@/features/time-attendance/server/api-response';
import { getTrends } from '@/features/time-attendance/server/attendance-service';
import {
  requiredDateRange,
  requiredIdentifier,
} from '@/features/time-attendance/server/request-query';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const { searchParams } = new URL(request.url);
    const profileId = requiredIdentifier(searchParams, 'profile_id');
    const range = requiredDateRange(searchParams);

    return apiOk(
      await getTrends(resolved.actor, profileId, range, { client: resolved.client }),
    );
  } catch (error) {
    return serviceFailure(error);
  }
}

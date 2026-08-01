// src/app/api/coverage/route.ts
// GET /api/coverage?mode=live|projected&from=YYYY-MM-DD&to=YYYY-MM-DD&department=…
//
// The one coverage read behind three surfaces: the Live_Coverage_Panel on Today
// (`mode=live`, one date), the Coverage_Calendar on Time Off & Coverage
// (`mode=projected` over a month or a fortnight), and the Health_Ribbon on all
// three operational screens (`mode=projected` over seven dates). They differ by
// query, not by endpoint, which is why the ribbon cannot disagree with the
// calendar about a date (Requirement 18, criterion 10).
//
// The whole displayed range comes back in one request, and the outbound query
// count is a property of the mode rather than of the roster size or the range
// length (Requirements 8.12, 18.11, 20.4).
//
// ## The range defaults to today in the business timezone
//
// `from` and `to` are optional, together. An absent range resolves to today in
// the business timezone, read here from `attendance_policy` rather than taken
// from the browser: a client sending its own local date would ask about the wrong
// work date for the hour either side of midnight. That is the same reason
// `/api/attendance/day` resolves its default the same way.
//
// The policy read costs no extra query. It is passed into the service, which then
// reads only the thresholds, so the two configuration reads happen either way.
//
// ## One bad date does not blank the range
//
// Per-date results carry an optional `unavailable: { reason }`, so a date whose
// projection cannot be computed states why and the rest of the range keeps its
// figures (Requirement 9, criterion 14). The route passes that through: it is a
// per-date fact on a successful response, never a whole-request failure. A
// failure that really is whole-request — a malformed range, a live read over more
// than one date, a source read that errored — is answered through the shared
// contract in `api-response.ts`.
//
// Requirements: 6.1–6.16, 8.2–8.13, 9.14, 18.2–18.11, 20.4, 21.15, 22.16

import { workDateOf } from '@/features/time-attendance/domain/work-date';
import { resolveActor } from '@/features/time-attendance/server/api-actor';
import { apiOk, serviceFailure } from '@/features/time-attendance/server/api-response';
import { getCoverage } from '@/features/time-attendance/server/coverage-service';
import { loadAttendancePolicy } from '@/features/time-attendance/server/policy';
import { parseCoverageQuery } from '@/features/time-attendance/server/request-query';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const { searchParams } = new URL(request.url);

    const evaluatedAt = new Date().toISOString();
    const policy = await loadAttendancePolicy(resolved.client);
    const today = workDateOf(new Date(evaluatedAt), policy.businessTimezone);

    return apiOk(
      await getCoverage(resolved.actor, parseCoverageQuery(searchParams, today), {
        client: resolved.client,
        evaluatedAt,
        policy,
      }),
    );
  } catch (error) {
    return serviceFailure(error);
  }
}

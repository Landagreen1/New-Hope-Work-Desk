// src/app/api/coverage/impact/route.ts
// GET /api/coverage/impact?request_id=…
//
// What one pending time-off request would do to coverage if it were approved: the
// projection for every date the request covers, with the request itself counted as
// a proposed absence (Requirement 9, criteria 1 and 2). This is what the
// Approval_Impact_Preview inside the decision drawer renders.
//
// `request_id` is the only parameter, and deliberately so. The range, the
// employee, and the proposed absence all come from the stored request, so a caller
// cannot ask for a projection of a hypothetical absence for somebody else, and the
// preview cannot be shown for dates the request does not cover.
//
// `getImpact` is a wrapper over the same `getCoverage` projected read the
// Coverage_Calendar makes, so the figure shown before a decision is the figure
// read after it — Correctness Property 21 by construction rather than by two
// implementations happening to agree.
//
// A request outside the caller's visibility and a request that does not exist are
// refused identically, with `not_visible`. Row level security answers an
// unpermitted read with no rows, so the two are indistinguishable, and a refusal
// that named the difference would confirm the existence of a record the caller may
// not read.
//
// Per-date results carry the same optional `unavailable: { reason }` the calendar
// reads, so a date whose projection cannot be computed states why and the
// remaining requested dates keep their figures (Requirement 9, criterion 14).
//
// Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.14, 21.1, 21.2, 21.15, 22.16

import { resolveActor } from '@/features/time-attendance/server/api-actor';
import { apiOk, serviceFailure } from '@/features/time-attendance/server/api-response';
import { getImpact } from '@/features/time-attendance/server/coverage-service';
import { requiredRecordId } from '@/features/time-attendance/server/request-query';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const { searchParams } = new URL(request.url);
    const requestId = requiredRecordId(searchParams, 'request_id');

    return apiOk(await getImpact(resolved.actor, requestId, { client: resolved.client }));
  } catch (error) {
    return serviceFailure(error);
  }
}

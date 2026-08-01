// src/app/api/attendance/metrics/route.ts
// GET /api/attendance/metrics?from&to&department&status&...
//
// The fourteen Overview metrics for a query, in one request (Requirement 13,
// criterion 7). Each metric arrives with the query that produced it, so the
// drill-down hands `/api/attendance/records` the identical query and the figure
// cannot disagree with the rows behind it.
//
// Paging is not part of a metric: a figure is computed over the whole match, not
// over a page, so `page` and `limit` are not read here. A caller that sends them
// is answered with the metrics over the whole match, and the paging applies when
// they follow a metric's `query` to the records endpoint.
//
// Requirements: 13.2, 13.3, 13.4, 13.5, 13.7, 21.15, 22.16

import {
  refuseInvisibleProfiles,
  resolveActor,
} from '@/features/time-attendance/server/api-actor';
import { apiOk, serviceFailure } from '@/features/time-attendance/server/api-response';
import { getMetrics } from '@/features/time-attendance/server/attendance-service';
import { parseMetricQuery } from '@/features/time-attendance/server/request-query';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const { searchParams } = new URL(request.url);
    const query = parseMetricQuery(searchParams);

    const refusal = await refuseInvisibleProfiles(resolved.actor, query.profileIds);
    if (refusal !== null) return refusal;

    return apiOk(await getMetrics(resolved.actor, query, { client: resolved.client }));
  } catch (error) {
    return serviceFailure(error);
  }
}

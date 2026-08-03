// POST /api/cancellations/scheduler — the Notification_Scheduler endpoint.
//
// Called by Vercel Cron once a business day, and by a manager who wants the day's Touchpoints sent
// now. Mirrors `POST /api/renewals/sms/scheduler`: the Node runtime, a 300-second budget,
// authorization by full-string equality of `Authorization: Bearer ${CRON_SECRET}` or by a session
// whose profile role is `manager` or `super_admin`, HTTP 403 otherwise with zero sends and zero
// rows, then a service-role client from `SUPABASE_SECRET_KEY` (falling back to
// `SUPABASE_SERVICE_ROLE_KEY`) for the batch work.
//
// The whole batch lives in `src/features/cancellations/scheduler/run.ts` and the authorization in
// `./authorize.ts`, which is the repository's existing shape for a route with real work behind it
// (see `src/app/api/attendance/day/route.ts` over `features/time-attendance/server`). Two reasons,
// both practical: the scheduler suites (tasks 14.3, 14.4) and the authorization suite (task 18.1)
// drive the batch and the 403 with injected clients, providers, and clocks rather than a running
// Next server, and a route file exporting nothing but its HTTP surface cannot drift from the route
// contract Next validates.
//
// Requirements: 12.1, 12.2, 12.3, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13, 13.1, 13.5, 13.6, 13.7,
// 18.2, 19.4, 19.6, 23.3, 26.5

import { handleSchedulerRequest } from '@/features/cancellations/scheduler/run';

export const runtime = 'nodejs';

/** A batch of combined messages, each with its own provider call, needs more than the default. */
export const maxDuration = 300;

/** Never prerendered and never cached: the run reads the clock and writes rows. */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSchedulerRequest(request);
}

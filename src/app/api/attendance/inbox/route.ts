// src/app/api/attendance/inbox/route.ts
// GET /api/attendance/inbox
//
// The Needs_Attention_Inbox in one request: every unresolved item across the
// module, one item per underlying record, worst first (Requirement 17, criteria 4,
// 7, and 9).
//
// ## No parameters
//
// The inbox has no filters, and deliberately. It is the answer to "what is waiting"
// asked from any of the six screens, so a caller has nothing to narrow it by — the
// three windows are the owning screens' own, resolved in the service, and the item
// set is scoped by who is asking rather than by what they sent. A range parameter
// here would let two screens mount the same control and disagree about how much of
// it they were showing.
//
// ## Authorisation
//
// `resolveActor` first, so nothing is read before the caller exists. Scope is then
// `visibleProfileIds` inside each of the three reads, which is Requirement 17,
// criterion 8: a caller who does not administer attendance sees their own items and
// no others. Nothing in the request names an employee, so there is no out-of-scope
// query to refuse.
//
// Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.7, 17.8, 17.9, 17.10, 20.1,
// 21.1, 21.2, 21.15, 22.16

import { resolveActor } from '@/features/time-attendance/server/api-actor';
import { apiOk, serviceFailure } from '@/features/time-attendance/server/api-response';
import { getInbox } from '@/features/time-attendance/server/inbox-service';

export const runtime = 'nodejs';

export async function GET() {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    return apiOk(
      await getInbox(resolved.actor, {
        client: resolved.client,
        evaluatedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    return serviceFailure(error);
  }
}

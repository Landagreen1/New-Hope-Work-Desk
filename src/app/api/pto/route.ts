// src/app/api/pto/route.ts
// GET  /api/pto?status&department&profile_id&pto_type&from&to&coverage_risk&page&limit
// POST /api/pto  { action: 'submit' | 'cancel', … }
//
// The Request_Inbox read, and the two writes that belong to the employee whose
// leave it is: submitting a request, and withdrawing one. An administrator's
// answer to a request is a decision and lives on `/api/pto/decisions`, because a
// decision moves a balance and this endpoint moves none.
//
// This replaces the inherited implementation, which is the reason the module has
// a service at all. That version took `total_days` from the request body, counted
// weekdays with a second implementation that could disagree with the first, read
// `pto_balances` into JavaScript, added a figure, wrote the sum back — so two
// approvals landing together lost one increment — and logged the failure to the
// console while still answering success (Appendix A.5). Every one of those
// figures is now computed by `pto-service.ts` from stored rows, and this file
// carries no time-off rule of its own: it resolves the caller, reads the request,
// and hands both to the service.
//
// ## GET
//
// One page of the inbox: at most fifty rows, pending before decided, filtered by
// the six inbox filters (Requirement 7, criteria 6 through 8 and 12). Scope comes
// from `visibleProfileIds` inside the service, so an employee sees their own
// requests in all five states and an administrator sees the team, without this
// route holding a rule about it (Requirements 7.11, 11.6).
//
// The response carries `requestTypes`: the request types the
// `pto_requests.pto_type` constraint accepts, read off the same map every balance
// movement goes through. The composer builds its type selector from that list, so
// it cannot offer a type the database refuses — which is what the inherited
// screen did with `birthday` (Requirement 10, criterion 20).
//
// ## POST
//
// | `action`   | body                                          | answers                    |
// | ---------- | --------------------------------------------- | -------------------------- |
// | `submit`   | `pto_type`, `start_date`, `end_date`, `reason?` | `{ request, disclosure }` |
// | `cancel`   | `request_id`                                  | `{ request }`              |
//
// `action` is required rather than inferred from which fields are present.
// Inferring would make a submission with a stray `request_id` ambiguous, and the
// two writes are not interchangeable: one creates a row, the other closes one.
//
// A submission carries no day count and no balance. The working-day count and the
// short-notice condition are computed on the server and stored on the row, and
// the disclosure that comes back is what the composer displays — the shortfall
// and the short-notice condition, neither of which blocks the submission
// (Requirements 11.2, 11.4, 11.5).
//
// A cancellation is offered for `pending` and `waitlisted` and refused for
// everything else, which the service decides through the same `canCancelRequest`
// the composer used to decide whether to offer the action. A request that moved
// under the employee is answered as a conflict carrying the current row, so the
// screen can re-render against the truth rather than re-submitting
// (Requirements 11.8, 11.9, 11.10).
//
// Both writes answer 200 with the affected row rebuilt from stored data, so the
// screen replaces that row from the response rather than reloading the inbox. The
// module has one success shape, `apiOk`, for the same reason it has one failure
// contract.
//
// The inherited `PATCH` is gone. Approving or denying a request is one of the
// eight decision options, and all eight are `POST /api/pto/decisions`.
//
// Requirements: 7.4–7.12, 10.20, 11.1, 11.3, 11.6, 11.8, 11.9, 11.10, 21.1,
// 21.2, 21.15, 22.16

import {
  refuseInvisibleProfiles,
  resolveActor,
} from '@/features/time-attendance/server/api-actor';
import { apiOk, serviceFailure } from '@/features/time-attendance/server/api-response';
import {
  cancelOwnRequest,
  listRequests,
  submitRequest,
  type SubmissionInput,
} from '@/features/time-attendance/server/pto-service';
import {
  optionalText,
  readJsonBody,
  requiredBodyDate,
  requiredBodyRecordId,
  requiredChoice,
} from '@/features/time-attendance/server/request-body';
import {
  PTO_TYPES,
  SUBMITTABLE_PTO_TYPES,
  parseRequestQuery,
} from '@/features/time-attendance/server/request-query';

export const runtime = 'nodejs';

/** The two writes this endpoint serves, in the order the screen offers them. */
const ACTIONS = ['submit', 'cancel'] as const;

export async function GET(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const { searchParams } = new URL(request.url);
    const query = parseRequestQuery(searchParams);

    // An employee asking for a colleague's requests is refused rather than
    // answered with an empty page, which would read as "no requests" instead of
    // "not yours".
    const refusal = await refuseInvisibleProfiles(resolved.actor, query.profileIds);
    if (refusal !== null) return refusal;

    const page = await listRequests(resolved.actor, query, { client: resolved.client });
    return apiOk({ ...page, requestTypes: SUBMITTABLE_PTO_TYPES });
  } catch (error) {
    return serviceFailure(error);
  }
}

export async function POST(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const body = await readJsonBody(request);
    const action = requiredChoice(body, 'action', ACTIONS);

    if (action === 'cancel') {
      const requestId = requiredBodyRecordId(body, 'request_id');
      return apiOk({
        request: await cancelOwnRequest(resolved.actor, requestId, { client: resolved.client }),
      });
    }

    const input: SubmissionInput = {
      ptoType: requiredChoice(body, 'pto_type', SUBMITTABLE_PTO_TYPES),
      startDate: requiredBodyDate(body, 'start_date'),
      endDate: requiredBodyDate(body, 'end_date'),
    };

    const reason = optionalText(body, 'reason');
    if (reason !== undefined) input.reason = reason;

    return apiOk(await submitRequest(resolved.actor, input, { client: resolved.client }));
  } catch (error) {
    // `write_failed` is the honest fallback for an unclassified failure on a
    // mutation: it tells the caller nothing was saved, where `read_failed` would
    // invite them to retry a request that may already have landed.
    return serviceFailure(error, 'write_failed');
  }
}

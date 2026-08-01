// src/app/api/pto/decisions/route.ts
// POST /api/pto/decisions
//
// The one write behind all eight decision options: approve the full request, deny
// it, approve part of it, suggest different dates, find or assign coverage,
// approve after assigning coverage, waitlist it, and request more information
// (Requirement 10, criterion 1). One endpoint rather than eight, because the eight
// differ by payload and not by procedure: every one of them locks the request row,
// checks the caller is not its owner, reconciles the balance, records the ledger
// row and the audit entry, and answers with the recomputed projection.
//
// ```
// {
//   "request_id":             "…",                       // required
//   "decision":               "approve_full",            // required, one of eight
//   "idempotency_key":        "…",                       // required, non-blank
//   "expected_status":        "pending",                  // optional
//   "approved_ranges":        [{ "from": "…", "to": "…" }],
//   "declined_ranges":        [{ "from": "…", "to": "…" }],
//   "suggested_ranges":       [{ "from": "…", "to": "…" }],
//   "coverage_assignments":   [{ "date": "…", "covering_profile_id": "…",
//                                "shift_start": "09:00", "shift_end": "17:00" }],
//   "reason":                 "…",                        // denial reason or question
//   "override_reason":        "…",
//   "acknowledged_shortfall": false
// }
// ```
//
// ## What this file decides, which is very little
//
// The shape of the body, and nothing else. Which payload each decision requires,
// which decisions move a balance, how many working days they move, which year each
// day belongs to, whether the coverage guard permits the approval, and whether the
// request has moved since the drawer opened are all `pto-service.ts` and the domain
// layer beneath it. In particular no day count and no balance figure is read from
// the body at all: `decide` computes the movement from the stored request, the
// stored closed dates, and the stored ledger, and `pto_decide()` re-derives the
// same arithmetic inside the row lock and refuses the call if the two disagree. A
// browser can therefore lie about a day count and be refused, or lie about a
// balance and be ignored (Requirements 10.13–10.16, 10.18).
//
// ## The two answers a screen has to act on
//
// **A replay answers 200 with `applied: false`.** `idempotency_key` is required
// and non-blank, and a key already recorded against the request means the decision
// is in place: nothing is applied a second time, no coverage is assigned again,
// and the prior decision comes back (Requirement 10, criterion 17). A retry after
// a lost response is deliberately not a conflict — the status moved *because* the
// first attempt succeeded, and the browser still holds the status it last saw.
//
// **A stale view answers 409 with the current row.** `expected_status` is the
// status the administrator saw when the drawer opened. It is compared inside the
// row lock, so two administrators deciding the same request cannot both debit it;
// the loser is told what the request now holds and can re-read rather than
// re-submit. Omitting it defaults to the status the service read, which still
// reaches the lock.
//
// A coverage shortfall the guard cannot excuse is the other 409, carrying the
// shortfalls and the projection they were read from, so the drawer can offer the
// three escapes Requirement 10, criterion 9 names: assign coverage, acknowledge
// the shortfall, or supply an override reason.
//
// Authorisation is the service's first act, before it reads anything, and
// `pto_decide()` asserts the same rule again as the owner of the function. The
// owner of a request may never decide it, whatever their role, which is why a
// `super_admin` submitting their own leave is answered with
// `owner_cannot_decide` (Requirements 10.19, 21.15).
//
// Requirements: 10.1–10.20, 21.2, 21.15, 22.16

import { DECISION_OPTIONS } from '@/features/time-attendance/domain/pto';
import { resolveActor } from '@/features/time-attendance/server/api-actor';
import { apiOk, serviceFailure } from '@/features/time-attendance/server/api-response';
import {
  decide,
  type CoverageAssignmentInput,
  type DecisionInput,
} from '@/features/time-attendance/server/pto-service';
import {
  optionalChoice,
  optionalFlag,
  optionalObjectList,
  optionalRanges,
  optionalText,
  readJsonBody,
  requiredBodyDate,
  requiredBodyRecordId,
  requiredChoice,
  requiredText,
  type JsonBody,
} from '@/features/time-attendance/server/request-body';
import { PTO_STATUSES } from '@/features/time-attendance/server/request-query';

export const runtime = 'nodejs';

/**
 * The coverage assignments, as the administrator submitted them.
 *
 * Shape only. That the date falls inside the requested range, that the covering
 * employee is not the requester, that they exist, and that the times are times the
 * schedule columns accept are all checked by `applyCoverageAssignments`, which is
 * also where the schedule row is created or amended and linked to the request
 * (Requirement 10, criterion 8).
 */
function readCoverageAssignments(body: JsonBody): CoverageAssignmentInput[] | undefined {
  const entries = optionalObjectList(body, 'coverage_assignments');
  if (entries === undefined) return undefined;

  return entries.map((entry, index) => {
    const label = `coverage_assignments[${index}]`;
    return {
      date: requiredBodyDate(entry, 'date', `${label}.date`),
      coveringProfileId: requiredBodyRecordId(
        entry,
        'covering_profile_id',
        `${label}.covering_profile_id`,
      ),
      shiftStart: requiredText(entry, 'shift_start', `${label}.shift_start`),
      shiftEnd: requiredText(entry, 'shift_end', `${label}.shift_end`),
    };
  });
}

/** One decision, from a JSON body. Every field absent unless it was given. */
function readDecisionInput(body: JsonBody): DecisionInput {
  const input: DecisionInput = {
    requestId: requiredBodyRecordId(body, 'request_id'),
    decision: requiredChoice(body, 'decision', DECISION_OPTIONS),
    idempotencyKey: requiredText(body, 'idempotency_key'),
  };

  const approvedRanges = optionalRanges(body, 'approved_ranges');
  if (approvedRanges !== undefined) input.approvedRanges = approvedRanges;

  const declinedRanges = optionalRanges(body, 'declined_ranges');
  if (declinedRanges !== undefined) input.declinedRanges = declinedRanges;

  const suggestedRanges = optionalRanges(body, 'suggested_ranges');
  if (suggestedRanges !== undefined) input.suggestedRanges = suggestedRanges;

  const coverageAssignments = readCoverageAssignments(body);
  if (coverageAssignments !== undefined) input.coverageAssignments = coverageAssignments;

  const reason = optionalText(body, 'reason');
  if (reason !== undefined) input.reason = reason;

  const overrideReason = optionalText(body, 'override_reason');
  if (overrideReason !== undefined) input.overrideReason = overrideReason;

  const acknowledgedShortfall = optionalFlag(body, 'acknowledged_shortfall');
  if (acknowledgedShortfall !== undefined) input.acknowledgedShortfall = acknowledgedShortfall;

  const expectedStatus = optionalChoice(body, 'expected_status', PTO_STATUSES);
  if (expectedStatus !== undefined) input.expectedStatus = expectedStatus;

  return input;
}

export async function POST(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const input = readDecisionInput(await readJsonBody(request));

    return apiOk(await decide(resolved.actor, input, { client: resolved.client }));
  } catch (error) {
    // `write_failed` is the honest fallback for an unclassified failure here: the
    // decision either committed in one transaction or did nothing, so telling the
    // caller nothing was saved is true, where `read_failed` would invite a retry.
    return serviceFailure(error, 'write_failed');
  }
}

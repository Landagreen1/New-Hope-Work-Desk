/**
 * GET  — submission history for a carrier market.
 * POST — send a carrier submission.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirements 8, 10, 11.
 *
 * The route is thin. Everything of consequence lives in
 * `src/features/carrier-submissions/server/`, matching the convention the cancellations
 * provider-isolation test enforces for that module.
 */

import { MESSAGES, fail, ok } from '@/features/carrier-submissions/server/api';
import { resolveSender, resolveSubmissionActor } from '@/features/carrier-submissions/server/actor';
import { getSendableToken } from '@/features/carrier-submissions/server/connections';
import { recordSubmissionAftermath, sendSubmission } from '@/features/carrier-submissions/server/send';
import { createSubmissionServiceClient } from '@/features/carrier-submissions/server/service-client';
import { isValidEmailAddress } from '@/features/carrier-submissions/recipients';
import type { SubmissionKind } from '@/features/carrier-submissions/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Large attachments go through chunked upload sessions, which take longer than a default. */
export const maxDuration = 120;

const SUBMISSION_COLUMNS =
  'id, opportunity_id, carrier_market_id, market_id, submitted_by, from_email, to_email, cc_email, subject, body, submission_kind, status, failure_reason, failure_retryable, provider_message_id, attachment_count, attachment_bytes, sent_at, created_at';

export async function GET(request: Request) {
  // History is open to anyone who may view the opportunity (Requirement 8.7), so this
  // resolves an actor rather than a sender, and reads through the caller's own client so
  // the SELECT policy — not this route — decides what is visible.
  const resolved = await resolveSubmissionActor();
  if (!resolved.ok) return resolved.response;

  const url = new URL(request.url);
  const carrierMarketId = url.searchParams.get('carrier_market_id');
  const opportunityId = url.searchParams.get('opportunity_id');
  if (!carrierMarketId && !opportunityId) {
    return fail('invalid_request', 'Name a carrier market or an opportunity.');
  }

  let query = resolved.client
    .from('carrier_submissions')
    .select(SUBMISSION_COLUMNS)
    .order('created_at', { ascending: false });

  if (carrierMarketId) query = query.eq('carrier_market_id', carrierMarketId);
  if (opportunityId) query = query.eq('opportunity_id', opportunityId);

  const { data, error } = await query;
  if (error) return fail('read_failed', 'Could not read the submission history.');

  const submissions = data ?? [];
  const ids = submissions.map((row) => row.id as string);

  let documents: unknown[] = [];
  if (ids.length > 0) {
    const { data: docs } = await resolved.client
      .from('carrier_submission_documents')
      .select('id, submission_id, quote_document_id, file_name, storage_bucket, storage_path, mime_type, file_size')
      .in('submission_id', ids);
    documents = docs ?? [];
  }

  return ok({ submissions, documents });
}

interface SendBody {
  opportunity_id?: unknown;
  carrier_market_id?: unknown;
  market_id?: unknown;
  to?: unknown;
  cc?: unknown;
  subject?: unknown;
  body?: unknown;
  document_ids?: unknown;
  submission_kind?: unknown;
  idempotency_key?: unknown;
  carrier_name?: unknown;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export async function POST(request: Request) {
  const resolved = await resolveSender();
  if (!resolved.ok) return resolved.response;

  let payload: SendBody;
  try {
    payload = (await request.json()) as SendBody;
  } catch {
    return fail('invalid_request', 'The request body was not valid JSON.');
  }

  const opportunityId = typeof payload.opportunity_id === 'string' ? payload.opportunity_id : '';
  const carrierMarketId = typeof payload.carrier_market_id === 'string' ? payload.carrier_market_id : '';
  const subject = typeof payload.subject === 'string' ? payload.subject : '';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const idempotencyKey = typeof payload.idempotency_key === 'string' ? payload.idempotency_key : '';

  if (!opportunityId) return fail('invalid_request', 'Name the quote.', { field: 'opportunity_id' });
  if (!carrierMarketId) return fail('invalid_request', 'Name the carrier.', { field: 'carrier_market_id' });
  if (!subject.trim()) return fail('invalid_request', 'Add a subject.', { field: 'subject' });
  if (!idempotencyKey) {
    // Refused rather than generated here. A key the server invents is not an idempotency
    // key — a retry would arrive with a different one and send a second email.
    return fail('invalid_request', 'The request was missing its idempotency key.', {
      field: 'idempotency_key',
    });
  }

  const to = readStringArray(payload.to).map((entry) => entry.trim()).filter(Boolean);
  const cc = readStringArray(payload.cc).map((entry) => entry.trim()).filter(Boolean);
  if (to.length === 0) return fail('invalid_request', 'Add at least one recipient.', { field: 'to' });

  for (const address of [...to, ...cc]) {
    if (!isValidEmailAddress(address)) {
      return fail('invalid_request', `${address} is not a valid email address.`, { field: 'to' });
    }
  }

  const service = createSubmissionServiceClient();
  if (!service) return fail('unconfigured', MESSAGES.unconfigured);

  // The caller must be allowed to EDIT the quote, not merely view it. Checked through the
  // caller's own client so the RPC sees their identity.
  const { data: canEdit, error: canEditError } = await resolved.client.rpc(
    'specialty_can_edit_opportunity',
    { p_opportunity_id: opportunityId },
  );
  if (canEditError) return fail('read_failed', 'Could not check your access to this quote.');
  if (canEdit !== true) {
    return fail('not_authorised', 'You cannot send submissions for this quote.');
  }

  const token = await getSendableToken({ service, profileId: resolved.actor.id });
  if (!token.ok) {
    if (token.code === 'no_connection') return fail('no_connection', MESSAGES.noConnection);
    if (token.code === 'needs_reconnect') return fail('needs_reconnect', MESSAGES.needsReconnect);
    if (token.code === 'unconfigured') return fail('unconfigured', MESSAGES.unconfigured);
    return fail('read_failed', token.reason, { retryable: true });
  }

  const kind = payload.submission_kind;
  const submissionKind: SubmissionKind =
    kind === 'additional_documents' || kind === 'revised' ? kind : 'initial';

  const outcome = await sendSubmission({
    service,
    senderProfileId: resolved.actor.id,
    opportunityId,
    carrierMarketId,
    marketId: typeof payload.market_id === 'string' ? payload.market_id : null,
    connectionId: token.connectionId,
    accessToken: token.accessToken,
    fromEmail: token.emailAddress,
    to,
    cc,
    subject,
    body,
    documentIds: readStringArray(payload.document_ids),
    submissionKind,
    idempotencyKey,
  });

  if (!outcome.ok) {
    if (outcome.code === 'invalid_request') return fail('invalid_request', outcome.reason);
    if (outcome.code === 'provider_failed') {
      return fail('provider_failed', outcome.reason, { retryable: outcome.retryable });
    }
    return fail('write_failed', outcome.reason);
  }

  // Only after a genuinely new send. A duplicate must not re-stamp the carrier or write a
  // second activity entry for one email.
  if (!outcome.duplicate) {
    await recordSubmissionAftermath({
      service,
      submissionId: outcome.submissionId,
      opportunityId,
      carrierMarketId,
      senderProfileId: resolved.actor.id,
      carrierName: typeof payload.carrier_name === 'string' ? payload.carrier_name : '',
      recipients: to,
      attachmentCount: readStringArray(payload.document_ids).length,
    });
  }

  return ok({
    submission_id: outcome.submissionId,
    message_id: outcome.messageId,
    duplicate: outcome.duplicate,
    sent_to: to,
  });
}

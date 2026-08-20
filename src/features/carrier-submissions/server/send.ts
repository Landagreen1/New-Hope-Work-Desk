/**
 * Reserve → send → record.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirements 6, 7, 9, 10.
 *
 * ORDER MATTERS, AND THIS ORDER IS DELIBERATE
 *   1. RESERVE  insert the row with status 'sending' and the caller's idempotency key,
 *               BEFORE contacting the provider. The unique constraint is the lock: a
 *               double-click, a client retry, or a duplicated request loses the race and
 *               is handed the original row instead of sending a second email.
 *   2. SEND     one provider call.
 *   3. RECORD   stamp 'sent' with the provider message id, or 'failed' with a reason.
 *
 *   This is the shape `cancellation_communications` already proves in this codebase. It is
 *   the OPPOSITE of the renewal SMS route, which sends first and logs after and can
 *   therefore lose the record of a message that really went out.
 *
 *   A crash between steps 1 and 3 leaves a 'sending' row. That row is visible, blocks a
 *   duplicate, and can be reconciled by hand. That is the safe direction to fail: a
 *   duplicate submission to a carrier is worse than a row that needs explaining.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMailAsUser,
  type MailAttachment,
  type MailSendResult,
} from '@/lib/microsoft-mail';

import type { SubmissionKind } from '../types';

const SUBMISSIONS = 'carrier_submissions';
const SUBMISSION_DOCS = 'carrier_submission_documents';
const DOCUMENTS = 'specialty_documents';

/** Postgres unique_violation. The reservation losing the race. */
const UNIQUE_VIOLATION = '23505';

/** Matches the storage bucket limit. A carrier mailbox will refuse far less. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface SendSubmissionInput {
  service: SupabaseClient;
  senderProfileId: string;
  opportunityId: string;
  carrierMarketId: string;
  marketId: string | null;
  connectionId: string;
  accessToken: string;
  fromEmail: string;
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  body: string;
  documentIds: readonly string[];
  submissionKind: SubmissionKind;
  idempotencyKey: string;
  /** Seams, for tests. */
  send?: typeof sendMailAsUser;
  downloadDocument?: (bucket: string, path: string) => Promise<Buffer | null>;
}

export type SendSubmissionOutcome =
  | { ok: true; submissionId: string; messageId: string | null; duplicate: boolean }
  | {
      ok: false;
      code: 'invalid_request' | 'write_failed' | 'provider_failed';
      reason: string;
      retryable?: boolean;
      submissionId?: string;
    };

interface DocumentRow {
  id: string;
  file_name: string;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  file_size: number | null;
}

export async function sendSubmission(input: SendSubmissionInput): Promise<SendSubmissionOutcome> {
  const { service } = input;

  if (input.to.length === 0) {
    return { ok: false, code: 'invalid_request', reason: 'Add at least one recipient.' };
  }
  if (input.subject.trim().length === 0) {
    return { ok: false, code: 'invalid_request', reason: 'Add a subject.' };
  }

  // ── Resolve the attachments BEFORE reserving ────────────────────────────────
  // A document id that does not belong to this opportunity is a bad request, not a failed
  // send, and it should not leave a 'failed' row behind. Scoping the query to the
  // opportunity is also what stops a caller attaching another quote's documents by id.
  let documents: DocumentRow[] = [];
  if (input.documentIds.length > 0) {
    const { data, error } = await service
      .from(DOCUMENTS)
      .select('id, file_name, storage_bucket, storage_path, mime_type, file_size')
      .eq('opportunity_id', input.opportunityId)
      .in('id', [...input.documentIds]);

    if (error) {
      return { ok: false, code: 'write_failed', reason: 'Could not read the selected documents.' };
    }
    documents = (data ?? []) as DocumentRow[];

    if (documents.length !== input.documentIds.length) {
      return {
        ok: false,
        code: 'invalid_request',
        reason: 'One of the selected documents is no longer on this quote.',
      };
    }
  }

  const download = input.downloadDocument ?? makeDownloader(service);
  const attachments: MailAttachment[] = [];
  let totalBytes = 0;

  for (const document of documents) {
    const bytes = await download(document.storage_bucket, document.storage_path);
    if (bytes === null) {
      return {
        ok: false,
        code: 'invalid_request',
        reason: `${document.file_name} could not be read from storage.`,
      };
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return {
        ok: false,
        code: 'invalid_request',
        reason: `The attachments total more than ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)} MB. Remove one and send it separately.`,
      };
    }
    attachments.push({
      fileName: document.file_name,
      mimeType: document.mime_type || 'application/octet-stream',
      bytes,
    });
  }

  // ── 1. RESERVE ──────────────────────────────────────────────────────────────
  const { data: reserved, error: reserveError } = await service
    .from(SUBMISSIONS)
    .insert({
      opportunity_id: input.opportunityId,
      carrier_market_id: input.carrierMarketId,
      market_id: input.marketId,
      submitted_by: input.senderProfileId,
      email_connection_id: input.connectionId,
      from_email: input.fromEmail,
      to_email: [...input.to],
      cc_email: [...input.cc],
      subject: input.subject,
      body: input.body,
      submission_kind: input.submissionKind,
      status: 'sending',
      idempotency_key: input.idempotencyKey,
      attachment_count: attachments.length,
      attachment_bytes: totalBytes,
    })
    .select('id')
    .single();

  if (reserveError) {
    if (reserveError.code === UNIQUE_VIOLATION) {
      // Requirement 10.6: hand back the original rather than sending again. This is the
      // double-click, and it must be indistinguishable from success to the caller.
      const existing = await service
        .from(SUBMISSIONS)
        .select('id, provider_message_id, status')
        .eq('carrier_market_id', input.carrierMarketId)
        .eq('idempotency_key', input.idempotencyKey)
        .maybeSingle();

      if (existing.data) {
        return {
          ok: true,
          submissionId: existing.data.id as string,
          messageId: (existing.data.provider_message_id as string | null) ?? null,
          duplicate: true,
        };
      }
    }
    return { ok: false, code: 'write_failed', reason: 'Could not record the submission.' };
  }

  const submissionId = reserved.id as string;

  // ── 2. SEND ─────────────────────────────────────────────────────────────────
  const result: MailSendResult = await (input.send ?? sendMailAsUser)({
    accessToken: input.accessToken,
    subject: input.subject,
    body: input.body,
    to: input.to,
    cc: input.cc,
    attachments,
  });

  // ── 3. RECORD ───────────────────────────────────────────────────────────────
  if (!result.success || result.messageId === null) {
    // No provider message id means the send cannot be proved, and the database CHECK
    // would refuse a 'sent' row anyway. Recording it as sent would be a lie the audit
    // trail then carries forever.
    const reason =
      result.failureReason ??
      'The provider accepted the message but returned no identifier, so the send cannot be confirmed.';

    await service
      .from(SUBMISSIONS)
      .update({
        status: 'failed',
        failure_reason: reason.slice(0, 1000),
        failure_retryable: result.retryable,
        provider_draft_id: result.draftId,
      })
      .eq('id', submissionId);

    return {
      ok: false,
      code: 'provider_failed',
      reason,
      retryable: result.retryable,
      submissionId,
    };
  }

  const { error: recordError } = await service
    .from(SUBMISSIONS)
    .update({
      status: 'sent',
      provider_message_id: result.messageId,
      provider_draft_id: result.draftId,
      sent_at: new Date().toISOString(),
    })
    .eq('id', submissionId);

  if (recordError) {
    // The email HAS gone. Never report this as a failure — the user would send again and
    // the carrier would receive two. Leave the row in 'sending' as the visible anomaly.
    return { ok: true, submissionId, messageId: result.messageId, duplicate: false };
  }

  // Attachment snapshot. Written after the send so a failed submission carries no
  // attachment rows to imply otherwise.
  if (documents.length > 0) {
    await service.from(SUBMISSION_DOCS).insert(
      documents.map((document) => ({
        submission_id: submissionId,
        quote_document_id: document.id,
        file_name: document.file_name,
        storage_bucket: document.storage_bucket,
        storage_path: document.storage_path,
        mime_type: document.mime_type,
        file_size: document.file_size,
      })),
    );
  }

  return { ok: true, submissionId, messageId: result.messageId, duplicate: false };
}

function makeDownloader(service: SupabaseClient) {
  return async (bucket: string, path: string): Promise<Buffer | null> => {
    const { data, error } = await service.storage.from(bucket).download(path);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  };
}

/**
 * Advances the carrier's status and logs the activity, after a successful send.
 *
 * Requirement 9.3–9.4. Separated from `sendSubmission` because neither of these may
 * turn a delivered email into a reported failure: the message is already gone, and a
 * throw here must not reach the caller as "the send failed".
 */
export async function recordSubmissionAftermath(input: {
  service: SupabaseClient;
  submissionId: string;
  opportunityId: string;
  carrierMarketId: string;
  senderProfileId: string;
  carrierName: string;
  recipients: readonly string[];
  attachmentCount: number;
}): Promise<void> {
  const { service } = input;

  try {
    const { data: market } = await service
      .from('specialty_carrier_markets')
      .select('status')
      .eq('id', input.carrierMarketId)
      .maybeSingle();

    // Requirement 9.4: never regress a carrier that has moved past 'submitted'. A second
    // submission to a carrier already quoting must not drag it back.
    const status = String(market?.status ?? '');
    if (status === 'not_started' || status === 'preparing') {
      await service
        .from('specialty_carrier_markets')
        .update({
          status: 'submitted',
          submitted_at: new Date().toISOString(),
          submitted_by: input.senderProfileId,
        })
        .eq('id', input.carrierMarketId)
        .in('status', ['not_started', 'preparing']);
    }
  } catch {
    // Deliberately swallowed. The email is sent and recorded; a status that did not
    // advance is a cosmetic problem a human can fix in one click.
  }

  try {
    // Written directly with an explicit actor rather than through `specialty_log`: that
    // function derives its actor from `auth.uid()`, which a service-role call does not
    // have, so it would record a NULL actor. `generate-application/route.ts` does the
    // same thing for the same reason.
    await service.from('specialty_activity').insert({
      opportunity_id: input.opportunityId,
      carrier_market_id: input.carrierMarketId,
      actor_profile_id: input.senderProfileId,
      event_type: 'carrier_submission_emailed',
      detail: {
        submission_id: input.submissionId,
        carrier: input.carrierName,
        recipients: input.recipients,
        attachment_count: input.attachmentCount,
      },
    });
  } catch {
    // Same reasoning.
  }
}

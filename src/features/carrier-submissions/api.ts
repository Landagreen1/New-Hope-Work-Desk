'use client';

/**
 * Browser-side calls for carrier submissions.
 *
 * Everything of consequence happens server-side. This module only shapes requests and
 * reads responses; it never touches a credential and never talks to a provider.
 */

import type {
  CarrierSubmission,
  EmailConnection,
  SubmissionDocument,
  SubmissionKind,
} from './types';

export interface SubmissionReadinessFlags {
  /** The Microsoft application settings are present in this environment. */
  provider: boolean;
  /** A usable token encryption key is present. */
  encryption: boolean;
  ready: boolean;
}

export interface ConnectionStatus {
  readiness: SubmissionReadinessFlags;
  /** Retained for older cached clients; equals `readiness.ready`. */
  configured: boolean;
  can_send: boolean;
  connection: EmailConnection | null;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const response = await fetch('/api/email-connections', { cache: 'no-store' });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as ConnectionStatus;
}

export async function disconnectMailbox(): Promise<void> {
  const response = await fetch('/api/email-connections', { method: 'DELETE' });
  if (!response.ok) throw new Error(await readError(response));
}

/** A full navigation, not a fetch — the provider needs a top-level redirect. */
export function connectMailboxUrl(reconnect = false): string {
  return `/api/email-connections/microsoft/start${reconnect ? '?reconnect=1' : ''}`;
}

export interface SubmissionHistory {
  submissions: CarrierSubmission[];
  documents: SubmissionDocument[];
}

export async function getSubmissionHistory(params: {
  opportunityId?: string;
  carrierMarketId?: string;
}): Promise<SubmissionHistory> {
  const query = new URLSearchParams();
  if (params.opportunityId) query.set('opportunity_id', params.opportunityId);
  if (params.carrierMarketId) query.set('carrier_market_id', params.carrierMarketId);

  const response = await fetch(`/api/specialty/carrier-submissions?${query.toString()}`, {
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as SubmissionHistory;
}

export interface SendSubmissionRequest {
  opportunityId: string;
  carrierMarketId: string;
  marketId: string | null;
  carrierName: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  documentIds: string[];
  submissionKind: SubmissionKind;
  /**
   * Generated once when the composer opens and reused for every attempt from that
   * instance. This is what makes a double-click, or a retry after a timeout, produce one
   * email instead of two.
   */
  idempotencyKey: string;
}

export interface SendSubmissionResponse {
  submission_id: string;
  message_id: string | null;
  duplicate: boolean;
  sent_to: string[];
}

export class SubmissionSendError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.name = 'SubmissionSendError';
    this.code = code;
    this.retryable = retryable;
  }
}

export async function sendSubmission(
  request: SendSubmissionRequest,
): Promise<SendSubmissionResponse> {
  const response = await fetch('/api/specialty/carrier-submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      opportunity_id: request.opportunityId,
      carrier_market_id: request.carrierMarketId,
      market_id: request.marketId,
      carrier_name: request.carrierName,
      to: request.to,
      cc: request.cc,
      subject: request.subject,
      body: request.body,
      document_ids: request.documentIds,
      submission_kind: request.submissionKind,
      idempotency_key: request.idempotencyKey,
    }),
  });

  if (!response.ok) {
    let code = 'unknown';
    let retryable = false;
    let message = `Request failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: string; code?: string; retryable?: boolean };
      message = body.error ?? message;
      code = body.code ?? code;
      retryable = body.retryable === true;
    } catch {
      // Keep the fallback message.
    }
    throw new SubmissionSendError(message, code, retryable);
  }

  return (await response.json()) as SendSubmissionResponse;
}

/**
 * Carrier email submission — shared types.
 *
 * Spec: .kiro/specs/carrier-email-submission
 * Mirrors supabase/migrations/v1.21.0-carrier-email-submission.sql. Every union here
 * has a CHECK constraint behind it; if you add a value, add it in both places or the
 * database will refuse the row at runtime.
 */

/** Mailbox providers this product can send through. Phase 1 is Microsoft only. */
export type EmailProvider = 'microsoft';

/**
 * `needs_reconnect` is the state a connection enters when a refresh token is rejected
 * — consent revoked, password changed, tenant policy altered. It is not an error to
 * be swallowed: the composer must refuse to send and point at the settings screen.
 */
export type EmailConnectionStatus = 'connected' | 'needs_reconnect' | 'disconnected';

/**
 * What a submission was for. Recorded rather than inferred, because "I sent the loss
 * runs afterwards" and "I sent a corrected application" are different facts about the
 * same carrier and the history has to be able to say which.
 */
export type SubmissionKind = 'initial' | 'additional_documents' | 'revised';

/**
 * `sending` is the reservation state. The row exists before the provider is contacted,
 * so a crash mid-send leaves a visible row that blocks a duplicate rather than a
 * silent second email. A row only reaches `sent` once the provider has confirmed.
 */
export type SubmissionStatus = 'sending' | 'sent' | 'failed';

/**
 * A user's authorized mailbox.
 *
 * Deliberately has no credential field. `encrypted_access_credentials` is revoked from
 * `authenticated` at the column level in v1.21.0 § 8, so a browser session cannot read
 * it even with a valid JWT — and this type not carrying it means a component cannot
 * accidentally ask for it.
 */
export interface EmailConnection {
  id: string;
  profile_id: string;
  provider: EmailProvider;
  /** The mailbox actually authorized, read from the provider — not what we assumed. */
  email_address: string;
  provider_account_id: string;
  provider_tenant_id: string | null;
  token_expires_at: string | null;
  scopes: string[];
  status: EmailConnectionStatus;
  last_error: string | null;
  connected_at: string;
  updated_at: string;
}

/** One email actually sent to a carrier. Many per carrier market are expected. */
export interface CarrierSubmission {
  id: string;
  opportunity_id: string;
  carrier_market_id: string;
  market_id: string | null;
  submitted_by: string;
  email_connection_id: string | null;

  from_email: string;
  to_email: string[];
  cc_email: string[];

  subject: string;
  body: string;

  submission_kind: SubmissionKind;
  status: SubmissionStatus;
  failure_reason: string | null;
  /** Whether the failure was transient. Drives what the UI offers the sender next. */
  failure_retryable: boolean | null;
  provider: EmailProvider;
  /** The RFC-822 Message-ID. Stable across the move into Sent Items. */
  provider_message_id: string | null;
  provider_draft_id: string | null;

  attachment_count: number;
  attachment_bytes: number;

  sent_at: string | null;
  created_at: string;

  // Joined for display.
  submitted_by_name?: string;
  documents?: SubmissionDocument[];
}

/**
 * One attachment, as sent.
 *
 * `file_name`, `storage_bucket` and `storage_path` are copies rather than joins.
 * Deleting the underlying quote document nulls `quote_document_id` and leaves this
 * record intact — the history says what was sent even when the file is gone.
 */
export interface SubmissionDocument {
  id: string;
  submission_id: string;
  quote_document_id: string | null;
  file_name: string;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  file_size: number | null;
}

/** A carrier's submission history, as the Submissions panel renders it. */
export interface CarrierSubmissionHistory {
  carrier_market_id: string;
  carrier_name: string;
  submissions: CarrierSubmission[];
  last_sent_at: string | null;
  sent_count: number;
}

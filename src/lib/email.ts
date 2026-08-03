/**
 * Email Delivery Service
 *
 * Server-only module for sending transactional email via the Resend REST API.
 * One HTTPS POST with a bearer key, so no SMTP transport and no runtime
 * dependency beyond the platform `fetch`.
 *
 * This is the ONLY module in the repository that calls an email provider.
 * Every caller goes through `sendEmail`, which never throws: provider errors,
 * non-2xx responses, transport failures, and the 30-second timeout are all
 * converted to a failure result carrying a retryable indicator. The retry
 * policy (at most 2 additional attempts, 5-60 s backoff) lives in the calling
 * scheduler helper, not here.
 *
 * Environment variables required (server-side only, never NEXT_PUBLIC_):
 *   RESEND_API_KEY, CANCELLATION_EMAIL_FROM, CANCELLATION_EMAIL_REPLY_TO
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 30_000;
const MAX_FAILURE_REASON_LENGTH = 500;

interface EmailConfig {
  apiKey: string;
  fromAddress: string;
  defaultReplyTo: string | null;
}

function readEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * True only when both the provider credential and the single agency
 * from-address are present. Credential values are never returned or logged;
 * only the variable names appear in messages.
 */
export function isEmailConfigured(): boolean {
  return Boolean(readEnv('RESEND_API_KEY') && readEnv('CANCELLATION_EMAIL_FROM'));
}

function getConfig(): EmailConfig | null {
  const apiKey = readEnv('RESEND_API_KEY');
  const fromAddress = readEnv('CANCELLATION_EMAIL_FROM');

  if (!apiKey || !fromAddress) return null;

  return {
    apiKey,
    fromAddress,
    defaultReplyTo: readEnv('CANCELLATION_EMAIL_REPLY_TO'),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailSendResult {
  success: boolean;
  messageId: string | null;
  failureReason: string | null;
  retryable: boolean;
}

export interface EmailSendInput {
  to: string;
  subject: string;
  body: string;
  senderDisplayName: string;
  replyTo: string;
}

// ---------------------------------------------------------------------------
// Send one email (the only email provider call in the repository)
// ---------------------------------------------------------------------------

export async function sendEmail(input: EmailSendInput): Promise<EmailSendResult> {
  const config = getConfig();
  if (!config) {
    return failure(
      'Email delivery is not configured. Set RESEND_API_KEY and CANCELLATION_EMAIL_FROM environment variables.',
      false,
    );
  }

  const to = input.to?.trim() ?? '';
  if (to.length === 0) {
    return failure('Recipient email address is absent.', false);
  }

  const replyTo = input.replyTo?.trim() || config.defaultReplyTo;

  const payload: Record<string, unknown> = {
    from: formatFromAddress(config.fromAddress, input.senderDisplayName),
    to: [to],
    subject: input.subject ?? '',
    text: input.body ?? '',
  };

  if (replyTo) {
    payload.reply_to = replyTo;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SEND_TIMEOUT_MS);

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const rawBody = await readBody(response);

    if (!response.ok) {
      return failure(
        describeProviderError(response.status, rawBody),
        isRetryableStatus(response.status),
      );
    }

    // Success: store the provider identifier unchanged, or absent when the
    // provider returns none.
    return {
      success: true,
      messageId: extractMessageId(rawBody),
      failureReason: null,
      retryable: false,
    };
  } catch (caught) {
    if (timedOut) {
      return failure(`Email provider did not respond within ${SEND_TIMEOUT_MS / 1000} seconds.`, true);
    }
    // A caller-side abort or any transport-level failure is transient, so it
    // is reported as retryable rather than raised to the caller.
    const message = caught instanceof Error ? caught.message : 'Unknown email provider error';
    return failure(message, true);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failure(reason: string, retryable: boolean): EmailSendResult {
  return {
    success: false,
    messageId: null,
    failureReason: truncate(reason),
    retryable,
  };
}

/** Timeouts, 429, and 5xx are retryable; every other 4xx is not. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseJson(raw: string): Record<string, unknown> | null {
  if (raw.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractMessageId(raw: string): string | null {
  const json = parseJson(raw);
  if (!json) return null;
  const id = json.id;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  return id;
}

/**
 * Builds a failure reason from the response status and the provider's own
 * message. The request credential is sent in a header and is never present in
 * a response body, so no credential value can reach this string.
 */
function describeProviderError(status: number, raw: string): string {
  const json = parseJson(raw);
  const message = typeof json?.message === 'string' ? json.message.trim() : '';
  const name = typeof json?.name === 'string' ? json.name.trim() : '';
  const detail = message || name || raw.trim();

  return detail.length > 0
    ? `Email provider returned HTTP ${status}: ${detail}`
    : `Email provider returned HTTP ${status}.`;
}

/**
 * From-address is always CANCELLATION_EMAIL_FROM; the display name comes from
 * the caller. A configured value already in `Name <address>` form contributes
 * only its address so the caller's display name is the one that applies.
 */
function formatFromAddress(configuredFrom: string, senderDisplayName: string): string {
  const address = extractAddress(configuredFrom);
  const displayName = sanitizeDisplayName(senderDisplayName);
  return displayName.length > 0 ? `${displayName} <${address}>` : address;
}

function extractAddress(configuredFrom: string): string {
  const angled = /<([^<>]+)>\s*$/.exec(configuredFrom);
  return (angled ? angled[1] : configuredFrom).trim();
}

/**
 * Strips the characters that would break an RFC 5322 address or inject a
 * header, then collapses whitespace runs to one space.
 */
function sanitizeDisplayName(name: string): string {
  if (typeof name !== 'string') return '';
  return name
    .replace(/[\r\n<>"\\,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string): string {
  return text.length > MAX_FAILURE_REASON_LENGTH
    ? text.slice(0, MAX_FAILURE_REASON_LENGTH)
    : text;
}

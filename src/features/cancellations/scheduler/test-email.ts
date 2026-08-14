// The email configuration test: one message to an address a manager names (REQ-3.4).
//
// ── WHAT THIS ANSWERS, AND WHAT IT DOES NOT
//
// `providerReadiness()` reports whether the credentials are *present*. It cannot report whether they
// *work*: a revoked key, a from-address on an unverified domain, a send-only key without permission
// for the address, and a domain still waiting on DNS all look identical from the environment. Only a
// real provider call distinguishes them, and before this existed the only way to make one was to send
// to a customer.
//
// So this is a connectivity and authorization test. It proves the key is accepted, the from-address
// is authorized, and the provider queued a message — the four unknowns that stand between a
// configured deployment and a working one.
//
// It is deliberately **not** the template preview. `./test-send.ts` renders a real case at a real
// touchpoint and belongs in the case drawer, where a manager has a case to render; it needs a case
// id, a touchpoint, the template rows, the settings row, and the contact rows. This action needs
// none of that, which is why it can live on the readiness panel where the configuration question is
// actually asked.
//
// ── SAFETY
//
// The recipient is supplied by the manager and is never read from the database, so this cannot reach
// a customer contact even by accident. Nothing is written: no `cancellation_communications` row, no
// `cancellation_test_sends` row (that table requires a `case_id`, and this action has no case), and
// no case status change. The only effect is one outbound email and one provider response.
//
// ── WHY IT IS NOT IN THE ROUTE
//
// Requirements 23.1 and 23.5 confine the provider to `src/lib/email.ts`, and
// `provider-isolation.test.ts` forbids any route under `src/app/api/cancellations/` from importing
// it. The features layer may, so the handler lives here and the route delegates — the same split
// `POST /api/cancellations/send` uses with `handleManualSendRequest`.

import { isEmailConfigured, sendEmail } from '@/lib/email';
import { canManageRenewals } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import { resolveSessionProfile, type SchedulerSessionResolver } from './authorize';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Requirement 22.6: the role does not permit the operation, and nothing was sent. */
export const TEST_EMAIL_FORBIDDEN_MESSAGE =
  'Sending a test email requires a manager. Nothing was sent.';

/** The body named no usable recipient. */
export const TEST_EMAIL_INVALID_RECIPIENT_MESSAGE =
  'Provide the email address the test message should be sent to.';

/**
 * `isEmailConfigured()` is false, so no provider call was attempted.
 *
 * Deliberately does not name the two environment variables. Requirement 23.1 confines the credential
 * names to `src/lib/email.ts`, and `provider-isolation.test.ts` enforces it by scanning for them —
 * naming them here would be a second place to change them. `sendEmail`'s own unconfigured message
 * does name both, and `.env.example` documents them.
 */
export const TEST_EMAIL_NOT_CONFIGURED_MESSAGE =
  'Email delivery is not configured on the server. Set the email provider credentials as server '
  + 'environment variables and redeploy, so the running build can read them, then check again.';

/** The subject of the test message, so it is unmistakable in an inbox. */
export const TEST_EMAIL_SUBJECT = 'New Hope Work Desk — email configuration test';

/**
 * The display name on the test message.
 *
 * Deliberately not an employee name: this message is from the system to whoever is configuring it,
 * and attributing it to a person would make a forwarded copy look like agency correspondence.
 */
export const TEST_EMAIL_SENDER_NAME = 'New Hope Work Desk';

/**
 * A shape check, not a validity check. The provider is the authority on whether an address exists;
 * this only refuses a value that cannot be an address at all, so a typo still reaches the provider
 * and comes back as a provider error a manager can read.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface TestEmailOutcome {
  /** True only where the provider accepted the message. */
  ok: boolean;
  /** The address the message was addressed to, echoed so the panel can name it. */
  recipient: string;
  /** The provider's own identifier, where it returned one. */
  messageId: string | null;
  /**
   * The provider's own failure text, unchanged. This is the whole value of the action: "domain is
   * not verified" and "API key is invalid" are different problems with different fixes, and a
   * generic message would hide which one it is.
   */
  failureReason: string | null;
  /** True where the failure was transient, so retrying is worth trying. */
  retryable: boolean;
}

export interface TestEmailRequestOptions {
  /** The session reader seam, so a test drives every role with no cookies. */
  resolveSession?: SchedulerSessionResolver;
  /** The sender seam, so a test asserts the payload without contacting a provider. */
  send?: typeof sendEmail;
  /** The configuration predicate seam. */
  configured?: () => boolean;
}

/** The parsed request body. */
export function parseTestEmailBody(
  payload: unknown,
): { ok: true; recipient: string } | { ok: false; message: string } {
  const recipient = typeof payload === 'object' && payload !== null
    ? (payload as { recipient?: unknown }).recipient
    : undefined;

  const trimmed = typeof recipient === 'string' ? recipient.trim() : '';
  if (trimmed.length === 0 || !EMAIL_SHAPE.test(trimmed)) {
    return { ok: false, message: TEST_EMAIL_INVALID_RECIPIENT_MESSAGE };
  }
  return { ok: true, recipient: trimmed };
}

/**
 * Sends one test message and reports exactly what the provider said.
 *
 * Order matters and is asserted by the tests: the role is checked, then the body, then the
 * configuration, and only then is the provider called. Every refusal happens before the provider
 * call, so a refused request makes no outbound request at all.
 */
export async function handleTestEmailRequest(
  request: Request,
  options: TestEmailRequestOptions = {},
): Promise<Response> {
  const resolveSession = options.resolveSession ?? resolveSessionProfile;
  const session = await resolveSession();

  const role: AppRole | null = session?.role ?? null;
  if (session === null || role === null || !canManageRenewals(role)) {
    return Response.json({ error: TEST_EMAIL_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    payload = null;
  }

  const parsed = parseTestEmailBody(payload);
  if (!parsed.ok) {
    return Response.json({ error: parsed.message }, { status: 400 });
  }

  const configured = options.configured ?? isEmailConfigured;
  if (!configured()) {
    return Response.json({ error: TEST_EMAIL_NOT_CONFIGURED_MESSAGE }, { status: 503 });
  }

  const send = options.send ?? sendEmail;
  const result = await send({
    to: parsed.recipient,
    subject: TEST_EMAIL_SUBJECT,
    body: testEmailBody(parsed.recipient),
    senderDisplayName: TEST_EMAIL_SENDER_NAME,
    // Replies go back to the configured default rather than to a person; an empty value lets
    // `sendEmail` fall through to CANCELLATION_EMAIL_REPLY_TO.
    replyTo: '',
  });

  const outcome: TestEmailOutcome = {
    ok: result.success,
    recipient: parsed.recipient,
    messageId: result.messageId,
    failureReason: result.failureReason,
    retryable: result.retryable,
  };

  // 200 for an accepted message, 502 for a provider refusal: the caller should not have to read the
  // body to know whether email works. The provider's reason travels in the body either way.
  return Response.json(outcome, { status: result.success ? 200 : 502 });
}

/**
 * The message body. Plain text, because `sendEmail` posts `text` only.
 *
 * It states what the message proves, so someone who finds it in an inbox months later knows it was a
 * deliberate configuration check and not a stray customer notice.
 */
function testEmailBody(recipient: string): string {
  return [
    'This is a configuration test from the New Hope Work Desk.',
    '',
    `It was sent to ${recipient} by a manager from the cancellations readiness panel.`,
    '',
    'Receiving it confirms the email credential is accepted, the agency from-address is authorized',
    'to send, and the sending domain is verified.',
    '',
    'No customer was contacted and no cancellation record was changed.',
  ].join('\n');
}

// Provider readiness, and the email configuration test (REQ-3.2, REQ-3.3, REQ-3.4).
//
// Two defects are pinned here, both of which had the same cause: the readiness route asked the
// "can this deployment send?" question a second time, by hand, instead of asking the provider
// modules that already answer it.
//
//   * SMS read `RINGCENTRAL_JWT_TOKEN` / `RINGCENTRAL_CLIENT_ID` / `RINGCENTRAL_CLIENT_SECRET`. The
//     real variables are `RC_*`, so the check was false on every deployment that ever existed — and
//     the panel gates the automatic-sending toggle on all checks passing, so automatic sending could
//     not be turned on at all.
//   * Email checked the API key alone while `isEmailConfigured()` requires the key and the
//     from-address, so a green tick could sit above a send path that refused every message.
//
// `providerReadiness()` now delegates to both provider predicates. The assertions below drive it
// through the real environment rather than a stub, so a future hand-rolled copy fails here.
//
// The test-email handler is covered for the order it does things in: role, then body, then
// configuration, then the provider. Every refusal has to happen before the provider call, because a
// refused request must make no outbound request.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailSendInput, EmailSendResult } from '@/lib/email';
import type { AppRole } from '@/lib/types';
import { providerReadiness } from '../scheduler/readiness';
import {
  TEST_EMAIL_FORBIDDEN_MESSAGE,
  TEST_EMAIL_INVALID_RECIPIENT_MESSAGE,
  TEST_EMAIL_NOT_CONFIGURED_MESSAGE,
  TEST_EMAIL_SENDER_NAME,
  TEST_EMAIL_SUBJECT,
  handleTestEmailRequest,
  parseTestEmailBody,
} from '../scheduler/test-email';

/** Every variable either predicate reads, cleared before each case so nothing leaks between them. */
const PROVIDER_VARS = [
  'RESEND_API_KEY', 'CANCELLATION_EMAIL_FROM',
  'RC_CLIENT_ID', 'RC_CLIENT_SECRET', 'RC_JWT_TOKEN', 'RC_SMS_FROM_NUMBER',
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of PROVIDER_VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// providerReadiness
// ---------------------------------------------------------------------------

describe('providerReadiness', () => {
  it('reports both channels unconfigured when nothing is set', () => {
    expect(providerReadiness()).toEqual({ sms: false, email: false });
  });

  it('requires the from-address as well as the credential for email', () => {
    // The old route reported ready on the key alone, and every send then failed.
    process.env.RESEND_API_KEY = 're_test_key';
    expect(providerReadiness().email).toBe(false);

    process.env.CANCELLATION_EMAIL_FROM = 'notices@example.com';
    expect(providerReadiness().email).toBe(true);
  });

  it('reads the RC_ variables the product actually uses for SMS', () => {
    // The regression: these are the names `src/lib/ringcentral-sms.ts` reads and `.env.example`
    // documents. The old check read RINGCENTRAL_* and was therefore always false.
    process.env.RC_CLIENT_ID = 'id';
    process.env.RC_CLIENT_SECRET = 'secret';
    process.env.RC_JWT_TOKEN = 'jwt';
    process.env.RC_SMS_FROM_NUMBER = '+15555550100';
    expect(providerReadiness().sms).toBe(true);
  });

  it('does not report SMS ready on the misspelled variables', () => {
    process.env.RINGCENTRAL_JWT_TOKEN = 'jwt';
    process.env.RINGCENTRAL_CLIENT_ID = 'id';
    process.env.RINGCENTRAL_CLIENT_SECRET = 'secret';
    try {
      expect(providerReadiness().sms).toBe(false);
    } finally {
      delete process.env.RINGCENTRAL_JWT_TOKEN;
      delete process.env.RINGCENTRAL_CLIENT_ID;
      delete process.env.RINGCENTRAL_CLIENT_SECRET;
    }
  });

  it('reports SMS unconfigured when the from-number is missing', () => {
    process.env.RC_CLIENT_ID = 'id';
    process.env.RC_CLIENT_SECRET = 'secret';
    process.env.RC_JWT_TOKEN = 'jwt';
    expect(providerReadiness().sms).toBe(false);
  });

  it('keeps the two channels independent', () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.CANCELLATION_EMAIL_FROM = 'notices@example.com';
    expect(providerReadiness()).toEqual({ sms: false, email: true });
  });
});

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

describe('parseTestEmailBody', () => {
  it('accepts a plausible address and trims it', () => {
    expect(parseTestEmailBody({ recipient: '  byron@newhopeins.com  ' }))
      .toEqual({ ok: true, recipient: 'byron@newhopeins.com' });
  });

  const REFUSED: readonly { payload: unknown; why: string }[] = [
    { payload: {}, why: 'no recipient' },
    { payload: { recipient: '' }, why: 'empty' },
    { payload: { recipient: '   ' }, why: 'whitespace only' },
    { payload: { recipient: 'not-an-address' }, why: 'no domain' },
    { payload: { recipient: 'a@b' }, why: 'no dot in the domain' },
    { payload: { recipient: 42 }, why: 'not a string' },
    { payload: null, why: 'null body' },
  ];

  it.each(REFUSED)('refuses a body with $why', ({ payload }) => {
    expect(parseTestEmailBody(payload))
      .toEqual({ ok: false, message: TEST_EMAIL_INVALID_RECIPIENT_MESSAGE });
  });
});

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

const MANAGER_ROLES: readonly AppRole[] = ['manager', 'super_admin'];
const NON_MANAGER_ROLES: readonly AppRole[] = ['agent', 'customer_service', 'sales_supervisor'];

function requestFor(recipient: unknown): Request {
  return new Request('https://example.test/api/cancellations/test-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient }),
  });
}

function session(role: AppRole) {
  return async () => ({ profileId: 'profile-1', role });
}

/**
 * A stub sender with the real signature, so `mock.calls[0][0]` is the typed payload and an argument
 * assertion below cannot drift from what `sendEmail` actually accepts.
 */
function sender(overrides: Partial<EmailSendResult> = {}) {
  return vi.fn(async (_input: EmailSendInput): Promise<EmailSendResult> => ({
    success: true, messageId: 'provider-id-1', failureReason: null, retryable: false, ...overrides,
  }));
}

describe('handleTestEmailRequest', () => {
  it.each(MANAGER_ROLES)('sends for %s and reports the provider identifier', async (role) => {
    const send = sender();
    const response = await handleTestEmailRequest(requestFor('byron@newhopeins.com'), {
      resolveSession: session(role), send, configured: () => true,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, recipient: 'byron@newhopeins.com', messageId: 'provider-id-1', failureReason: null,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      to: 'byron@newhopeins.com',
      subject: TEST_EMAIL_SUBJECT,
      senderDisplayName: TEST_EMAIL_SENDER_NAME,
      replyTo: '',
    });
  });

  it('states in the body what the message proves, and that nothing was touched', async () => {
    const send = sender();
    await handleTestEmailRequest(requestFor('byron@newhopeins.com'), {
      resolveSession: session('manager'), send, configured: () => true,
    });
    const body = send.mock.calls[0][0].body;
    expect(body).toContain('byron@newhopeins.com');
    expect(body).toContain('No customer was contacted');
  });

  it.each(NON_MANAGER_ROLES)('refuses %s before calling the provider', async (role) => {
    const send = sender();
    const response = await handleTestEmailRequest(requestFor('byron@newhopeins.com'), {
      resolveSession: session(role), send, configured: () => true,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: TEST_EMAIL_FORBIDDEN_MESSAGE });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an absent session before calling the provider', async () => {
    const send = sender();
    const response = await handleTestEmailRequest(requestFor('byron@newhopeins.com'), {
      resolveSession: async () => null, send, configured: () => true,
    });

    expect(response.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an unusable recipient before calling the provider', async () => {
    const send = sender();
    const response = await handleTestEmailRequest(requestFor('nope'), {
      resolveSession: session('manager'), send, configured: () => true,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: TEST_EMAIL_INVALID_RECIPIENT_MESSAGE });
    expect(send).not.toHaveBeenCalled();
  });

  it('answers 503 when email is unconfigured, without calling the provider', async () => {
    const send = sender();
    const response = await handleTestEmailRequest(requestFor('byron@newhopeins.com'), {
      resolveSession: session('manager'), send, configured: () => false,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: TEST_EMAIL_NOT_CONFIGURED_MESSAGE });
    expect(send).not.toHaveBeenCalled();
  });

  it('names no credential variable in the unconfigured message', () => {
    // Requirement 23.1 confines those names to src/lib/email.ts.
    expect(TEST_EMAIL_NOT_CONFIGURED_MESSAGE).not.toMatch(/RESEND|CANCELLATION_EMAIL/);
  });

  it('reports a provider refusal verbatim, which is the point of the action', async () => {
    // "The domain is not verified" and "API key is invalid" need different fixes, so the reason
    // travels through unchanged rather than being flattened into "sending failed".
    const send = sender({
      success: false,
      messageId: null,
      failureReason: 'Email provider returned HTTP 403: The newhopeins.com domain is not verified.',
      retryable: false,
    });
    const response = await handleTestEmailRequest(requestFor('byron@newhopeins.com'), {
      resolveSession: session('manager'), send, configured: () => true,
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      failureReason: 'Email provider returned HTTP 403: The newhopeins.com domain is not verified.',
      retryable: false,
    });
  });

  it('passes the retryable indicator through for a transient failure', async () => {
    const send = sender({ success: false, messageId: null, failureReason: 'HTTP 429', retryable: true });
    const response = await handleTestEmailRequest(requestFor('byron@newhopeins.com'), {
      resolveSession: session('manager'), send, configured: () => true,
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ ok: false, retryable: true });
  });

  it('treats an unparseable body as a missing recipient rather than throwing', async () => {
    const send = sender();
    const request = new Request('https://example.test/api/cancellations/test-email', {
      method: 'POST', body: 'not json',
    });
    const response = await handleTestEmailRequest(request, {
      resolveSession: session('manager'), send, configured: () => true,
    });

    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

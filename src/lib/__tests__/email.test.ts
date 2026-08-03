// Email delivery module tests (task 11.2) for `src/lib/email.ts`.
//
// Covers Requirement 23.6 — one send operation returning exactly one result carrying a success
// indicator, the provider message identifier on success, and a failure reason plus a retryable
// indicator on failure, with every provider error reported as a failure result rather than raised
// to the caller — and Requirement 23.8, the 30-second bound and the retryable classification the
// scheduler's retry policy reads (Requirement 25.2). Requirement 23.2 and Requirement 22.7 are
// covered by the from-address, reply-to, and credential-containment groups: the API key travels
// only in the Authorization header and appears in no returned value.
//
// No real network call is made by any test in this file. `fetch` is replaced for every test, the
// default replacement rejects so a forgotten stub cannot reach the provider, and an `afterAll`
// check asserts that the only URL any test requested is the Resend endpoint over HTTPS. The
// 30-second timeout is driven with fake timers rather than waited out, and `process.env` is
// snapshotted and restored around every case.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isEmailConfigured, sendEmail, type EmailSendInput, type EmailSendResult } from '../email';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const MAX_FAILURE_REASON_LENGTH = 500;

/** A fabricated credential. Its value must never appear in a returned result. */
const API_KEY = 're_TESTKEY_not_a_real_credential';
const FROM = 'reminders@newhope.example';
const REPLY_TO_ENV = 'office@newhope.example';

const ENV_KEYS = ['RESEND_API_KEY', 'CANCELLATION_EMAIL_FROM', 'CANCELLATION_EMAIL_REPLY_TO'] as const;
type EnvKey = (typeof ENV_KEYS)[number];

let savedEnv: Partial<Record<EnvKey, string | undefined>> = {};

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Every request any test in this file made, checked once in `afterAll`. */
const observedCalls: FetchCall[] = [];

/** The platform implementation, captured before anything in this file replaces it. */
const NATIVE_FETCH = globalThis.fetch;
let nativeFetchCalls = 0;

// Nothing in this file may reach the platform fetch. This baseline replacement counts and refuses
// any request that escapes a per-test stub, and because it is installed before the first
// `vi.stubGlobal` call it is also what `vi.unstubAllGlobals()` restores.
globalThis.fetch = (async () => {
  nativeFetchCalls += 1;
  throw new Error('the platform fetch must not be reached');
}) as typeof globalThis.fetch;

type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    observedCalls.push(call);
    return handler(call);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function configureEmail(
  overrides: { apiKey?: string; from?: string; replyTo?: string } = {},
): void {
  const { apiKey = API_KEY, from = FROM, replyTo } = overrides;
  process.env.RESEND_API_KEY = apiKey;
  process.env.CANCELLATION_EMAIL_FROM = from;
  if (replyTo !== undefined) process.env.CANCELLATION_EMAIL_REPLY_TO = replyTo;
}

function input(overrides: Partial<EmailSendInput> = {}): EmailSendInput {
  return {
    to: 'insured@example.com',
    subject: 'Your policy is scheduled for cancellation',
    body: 'Please contact our office to keep your coverage active.',
    senderDisplayName: 'Maria Gomez',
    replyTo: '',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
}

function lastCall(mock: ReturnType<typeof stubFetch>): FetchCall {
  const call = mock.mock.calls.at(-1);
  expect(call, 'the provider was not called').toBeDefined();
  return { url: String(call?.[0]), init: call?.[1] ?? {} };
}

function payloadOf(call: FetchCall): Record<string, unknown> {
  expect(typeof call.init.body).toBe('string');
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

/**
 * Every return of `sendEmail`, on every path, is one `EmailSendResult` whose failure reason is
 * within the 500-character bound and carries no credential value.
 */
function expectResultShape(result: EmailSendResult): void {
  expect(Object.keys(result).sort()).toEqual(['failureReason', 'messageId', 'retryable', 'success']);
  expect(typeof result.success).toBe('boolean');
  expect(typeof result.retryable).toBe('boolean');
  expect(result.messageId === null || typeof result.messageId === 'string').toBe(true);
  expect(result.failureReason === null || typeof result.failureReason === 'string').toBe(true);
  if (result.failureReason !== null) {
    expect(result.failureReason.length).toBeLessThanOrEqual(MAX_FAILURE_REASON_LENGTH);
    expect(result.failureReason).not.toContain(API_KEY);
  }
  expect(JSON.stringify(result)).not.toContain(API_KEY);
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

// ---------------------------------------------------------------------------
// Environment and global isolation
// ---------------------------------------------------------------------------

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Default replacement: a test that forgets to stub cannot reach the provider.
  stubFetch(() => {
    throw new Error('unexpected network call');
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  // Nothing in this file may contact a host other than the Resend endpoint, and no request may
  // fall through to the platform implementation.
  expect(observedCalls.length).toBeGreaterThan(0);
  for (const call of observedCalls) {
    expect(call.url).toBe(RESEND_ENDPOINT);
    expect(call.url.startsWith('https://')).toBe(true);
  }
  expect(nativeFetchCalls).toBe(0);
  expect(NATIVE_FETCH).toBeTypeOf('function');
});

// ---------------------------------------------------------------------------
// isEmailConfigured
// ---------------------------------------------------------------------------

describe('isEmailConfigured', () => {
  it('is true only when both the API key and the from-address are present', () => {
    configureEmail();
    expect(isEmailConfigured()).toBe(true);
  });

  it('is false when either variable is absent', () => {
    expect(isEmailConfigured()).toBe(false);

    process.env.RESEND_API_KEY = API_KEY;
    expect(isEmailConfigured()).toBe(false);

    delete process.env.RESEND_API_KEY;
    process.env.CANCELLATION_EMAIL_FROM = FROM;
    expect(isEmailConfigured()).toBe(false);
  });

  it('treats an empty or whitespace-only value as absent', () => {
    configureEmail({ apiKey: '', from: FROM });
    expect(isEmailConfigured()).toBe(false);

    configureEmail({ apiKey: API_KEY, from: '   ' });
    expect(isEmailConfigured()).toBe(false);

    configureEmail({ apiKey: '\t\n ', from: '  ' });
    expect(isEmailConfigured()).toBe(false);
  });

  it('does not depend on the reply-to variable', () => {
    configureEmail();
    expect(isEmailConfigured()).toBe(true);

    process.env.CANCELLATION_EMAIL_REPLY_TO = REPLY_TO_ENV;
    expect(isEmailConfigured()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Configuration and recipient guards
// ---------------------------------------------------------------------------

describe('sendEmail configuration and recipient guards', () => {
  it('fails non-retryably and names both required variables when configuration is absent', async () => {
    const mock = stubFetch(() => jsonResponse(200, { id: 'msg_should_not_be_reached' }));

    const result = await sendEmail(input());

    expectResultShape(result);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.failureReason).toContain('RESEND_API_KEY');
    expect(result.failureReason).toContain('CANCELLATION_EMAIL_FROM');
    expect(mock).not.toHaveBeenCalled();
  });

  it('fails non-retryably when only one of the two variables is present', async () => {
    const mock = stubFetch(() => jsonResponse(200, { id: 'msg_should_not_be_reached' }));

    process.env.RESEND_API_KEY = API_KEY;
    const withoutFrom = await sendEmail(input());
    expect(withoutFrom.success).toBe(false);
    expect(withoutFrom.retryable).toBe(false);

    delete process.env.RESEND_API_KEY;
    process.env.CANCELLATION_EMAIL_FROM = FROM;
    const withoutKey = await sendEmail(input());
    expect(withoutKey.success).toBe(false);
    expect(withoutKey.retryable).toBe(false);

    expect(mock).not.toHaveBeenCalled();
  });

  it('fails non-retryably on an empty or whitespace-only recipient without calling the provider', async () => {
    configureEmail();
    const mock = stubFetch(() => jsonResponse(200, { id: 'msg_should_not_be_reached' }));

    for (const to of ['', '   ', '\t\n']) {
      const result = await sendEmail(input({ to }));
      expectResultShape(result);
      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.messageId).toBeNull();
      expect(result.failureReason).toContain('Recipient');
    }

    expect(mock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Success mapping
// ---------------------------------------------------------------------------

describe('sendEmail success mapping', () => {
  it('maps a 2xx response to success carrying the provider identifier unchanged', async () => {
    configureEmail();
    const mock = stubFetch(() => jsonResponse(200, { id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c' }));

    const result = await sendEmail(input());

    expectResultShape(result);
    expect(result).toEqual({
      success: true,
      messageId: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
      failureReason: null,
      retryable: false,
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(lastCall(mock).url).toBe(RESEND_ENDPOINT);
    expect(lastCall(mock).init.method).toBe('POST');
  });

  it('succeeds with an absent identifier when the response body carries none', async () => {
    configureEmail();

    const cases: Array<{ label: string; response: () => Response }> = [
      { label: 'no id field', response: () => jsonResponse(200, { object: 'email' }) },
      { label: 'non-string id', response: () => jsonResponse(200, { id: 12345 }) },
      { label: 'null id', response: () => jsonResponse(200, { id: null }) },
      { label: 'blank id', response: () => jsonResponse(200, { id: '   ' }) },
      { label: 'unparsable body', response: () => new Response('accepted', { status: 200 }) },
      { label: 'empty body', response: () => new Response(null, { status: 200 }) },
      { label: 'JSON array body', response: () => jsonResponse(200, ['msg_1']) },
    ];

    for (const { label, response } of cases) {
      stubFetch(response);
      const result = await sendEmail(input());
      expectResultShape(result);
      expect(result, label).toEqual({
        success: true,
        messageId: null,
        failureReason: null,
        retryable: false,
      });
    }
  });

  it('accepts every 2xx status as success', async () => {
    configureEmail();

    for (const status of [200, 201, 202]) {
      stubFetch(() => jsonResponse(status, { id: `msg_${status}` }));
      const result = await sendEmail(input());
      expect(result.success, `status ${status}`).toBe(true);
      expect(result.messageId).toBe(`msg_${status}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Provider failure classification
// ---------------------------------------------------------------------------

describe('sendEmail provider failure classification', () => {
  const statuses: Array<{ status: number; retryable: boolean }> = [
    { status: 400, retryable: false },
    { status: 401, retryable: false },
    { status: 403, retryable: false },
    { status: 404, retryable: false },
    { status: 422, retryable: false },
    { status: 428, retryable: false },
    { status: 429, retryable: true },
    { status: 430, retryable: false },
    { status: 499, retryable: false },
    { status: 500, retryable: true },
    { status: 502, retryable: true },
    { status: 503, retryable: true },
    { status: 504, retryable: true },
  ];

  it.each(statuses)('maps HTTP $status to a failure with retryable=$retryable', async ({ status, retryable }) => {
    configureEmail();
    stubFetch(() => jsonResponse(status, { message: 'provider said no' }));

    const result = await sendEmail(input());

    expectResultShape(result);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(retryable);
    expect(result.messageId).toBeNull();
    expect(result.failureReason).toContain(String(status));
    expect(result.failureReason).toContain('provider said no');
  });

  it('ignores an identifier in a non-2xx body', async () => {
    configureEmail();
    stubFetch(() => jsonResponse(422, { id: 'msg_not_sent', message: 'invalid recipient' }));

    const result = await sendEmail(input());

    expect(result.success).toBe(false);
    expect(result.messageId).toBeNull();
  });

  it('builds the failure reason from the provider message, name, raw text, or status alone', async () => {
    configureEmail();

    stubFetch(() => jsonResponse(400, { name: 'validation_error', message: 'to is required' }));
    expect((await sendEmail(input())).failureReason).toContain('to is required');

    stubFetch(() => jsonResponse(400, { name: 'validation_error' }));
    expect((await sendEmail(input())).failureReason).toContain('validation_error');

    stubFetch(() => new Response('Bad Request', { status: 400 }));
    expect((await sendEmail(input())).failureReason).toContain('Bad Request');

    stubFetch(() => new Response('', { status: 400 }));
    const bare = await sendEmail(input());
    expect(bare.failureReason).toBe('Email provider returned HTTP 400.');
  });

  it('truncates a long provider failure reason at 500 characters', async () => {
    configureEmail();
    stubFetch(() => jsonResponse(400, { message: 'x'.repeat(600) }));

    const result = await sendEmail(input());

    expectResultShape(result);
    expect(result.failureReason).not.toBeNull();
    expect(result.failureReason).toHaveLength(MAX_FAILURE_REASON_LENGTH);
    expect(result.failureReason?.startsWith('Email provider returned HTTP 400: ')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('sendEmail 30-second timeout', () => {
  it('aborts at 30 seconds and reports a retryable timeout distinct from a transport error', async () => {
    configureEmail();
    vi.useFakeTimers();

    let abortSeen = false;
    const mock = stubFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => {
            abortSeen = true;
            reject(abortError());
          });
        }),
    );

    const pending = sendEmail(input());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    expect(abortSeen).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(abortSeen).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    expectResultShape(result);
    expect(result).toEqual({
      success: false,
      messageId: null,
      failureReason: 'Email provider did not respond within 30 seconds.',
      retryable: true,
    });
  });

  it('passes an abort signal on every request', async () => {
    configureEmail();
    const mock = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));

    await sendEmail(input());

    const signal = lastCall(mock).init.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect((signal as AbortSignal).aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transport errors and the never-throws contract
// ---------------------------------------------------------------------------

describe('sendEmail never throws', () => {
  it('surfaces a thrown transport error as a retryable failure result', async () => {
    configureEmail();
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });

    const result = await sendEmail(input());

    expectResultShape(result);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.messageId).toBeNull();
    expect(result.failureReason).toBe('fetch failed');
  });

  it('reports an abort raised before the timeout as a retryable transport failure', async () => {
    configureEmail();
    stubFetch(() => Promise.reject(abortError()));

    const result = await sendEmail(input());

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.failureReason).toBe('The operation was aborted.');
    expect(result.failureReason).not.toContain('30 seconds');
  });

  it('returns a result for a rejection that is not an Error and for an unreadable body', async () => {
    configureEmail();

    const hostile: Array<{ label: string; handler: FetchHandler }> = [
      { label: 'string rejection', handler: () => Promise.reject('boom') },
      { label: 'null rejection', handler: () => Promise.reject(null) },
      { label: 'undefined rejection', handler: () => Promise.reject(undefined) },
      {
        label: 'body read failure on success',
        handler: () => {
          const response = jsonResponse(200, { id: 'msg_1' });
          vi.spyOn(response, 'text').mockRejectedValue(new Error('stream closed'));
          return response;
        },
      },
      {
        label: 'body read failure on error status',
        handler: () => {
          const response = jsonResponse(500, { message: 'server error' });
          vi.spyOn(response, 'text').mockRejectedValue(new Error('stream closed'));
          return response;
        },
      },
    ];

    for (const { label, handler } of hostile) {
      stubFetch(handler);
      const result = await sendEmail(input());
      expectResultShape(result);
      if (label === 'body read failure on success') {
        expect(result, label).toEqual({
          success: true,
          messageId: null,
          failureReason: null,
          retryable: false,
        });
      } else {
        expect(result.success, label).toBe(false);
        expect(result.failureReason, label).not.toBeNull();
      }
    }
  });

  it('returns a result rather than throwing when caller fields arrive absent at runtime', async () => {
    configureEmail();
    const mock = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));

    const absentFields = {
      to: 'insured@example.com',
      subject: null,
      body: undefined,
      senderDisplayName: null,
      replyTo: null,
    } as unknown as EmailSendInput;

    const result = await sendEmail(absentFields);

    expectResultShape(result);
    expect(result.success).toBe(true);
    const payload = payloadOf(lastCall(mock));
    expect(payload.subject).toBe('');
    expect(payload.text).toBe('');
    expect(payload.from).toBe(FROM);
    expect('reply_to' in payload).toBe(false);

    const absentRecipient = { ...absentFields, to: null } as unknown as EmailSendInput;
    const guarded = await sendEmail(absentRecipient);
    expectResultShape(guarded);
    expect(guarded.success).toBe(false);
    expect(guarded.retryable).toBe(false);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('truncates a long transport error message at 500 characters', async () => {
    configureEmail();
    stubFetch(() => {
      throw new Error('y'.repeat(900));
    });

    const result = await sendEmail(input());

    expectResultShape(result);
    expect(result.failureReason).toHaveLength(MAX_FAILURE_REASON_LENGTH);
    expect(result.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

describe('sendEmail request construction', () => {
  it('sends the recipient, subject, and body unchanged as JSON', async () => {
    configureEmail();
    const mock = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));

    await sendEmail(input({ to: '  insured@example.com  ' }));

    const call = lastCall(mock);
    const payload = payloadOf(call);
    expect(payload.to).toEqual(['insured@example.com']);
    expect(payload.subject).toBe('Your policy is scheduled for cancellation');
    expect(payload.text).toBe('Please contact our office to keep your coverage active.');
    expect(headersOf(call)['Content-Type']).toBe('application/json');
  });

  it('always sends from the configured address with the caller display name', async () => {
    configureEmail();
    const mock = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));

    await sendEmail(input({ senderDisplayName: 'Maria Gomez' }));

    expect(payloadOf(lastCall(mock)).from).toBe(`Maria Gomez <${FROM}>`);
  });

  it('takes only the address from a configured value already in Name <address> form', async () => {
    configureEmail({ from: `New Hope Renewals <${FROM}>` });
    const mock = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));

    await sendEmail(input({ senderDisplayName: 'Maria Gomez' }));

    expect(payloadOf(lastCall(mock)).from).toBe(`Maria Gomez <${FROM}>`);
  });

  it('sends the bare configured address when the display name is blank', async () => {
    configureEmail();

    for (const senderDisplayName of ['', '   ']) {
      const mock = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
      await sendEmail(input({ senderDisplayName }));
      expect(payloadOf(lastCall(mock)).from, `display name ${JSON.stringify(senderDisplayName)}`).toBe(
        FROM,
      );
    }
  });

  it('strips header-injection characters from the display name', async () => {
    // The display name comes from a database-stored employee record, so it is untrusted input.
    configureEmail();
    const mock = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));

    const hostile = '"Ana" <attacker@evil.example>,\r\nBcc: leak@evil.example';
    await sendEmail(input({ senderDisplayName: hostile }));

    const from = payloadOf(lastCall(mock)).from as string;
    expect(from).toBe(`Ana attacker@evil.example Bcc leak@evil.example <${FROM}>`);
    expect(from).not.toMatch(/[\r\n",;:\\]/);
    expect(from.match(/</g)).toHaveLength(1);
    expect(from.match(/>/g)).toHaveLength(1);
    expect(from.endsWith(`<${FROM}>`)).toBe(true);
  });

  it('prefers the caller reply-to, falls back to the configured one, and omits the field when neither exists', async () => {
    configureEmail({ replyTo: REPLY_TO_ENV });

    let mock = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    await sendEmail(input({ replyTo: '  maria@newhope.example  ' }));
    expect(payloadOf(lastCall(mock)).reply_to).toBe('maria@newhope.example');

    mock = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    await sendEmail(input({ replyTo: '   ' }));
    expect(payloadOf(lastCall(mock)).reply_to).toBe(REPLY_TO_ENV);

    delete process.env.CANCELLATION_EMAIL_REPLY_TO;
    mock = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    await sendEmail(input({ replyTo: '' }));
    expect('reply_to' in payloadOf(lastCall(mock))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Credential containment, provider isolation, and silence
// ---------------------------------------------------------------------------

describe('sendEmail credential containment', () => {
  it('sends the API key only in the Authorization header', async () => {
    configureEmail();
    const mock = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));

    await sendEmail(input());

    const call = lastCall(mock);
    expect(headersOf(call).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.init.body as string).not.toContain(API_KEY);
    expect(call.url).not.toContain(API_KEY);
  });

  it('returns no credential value in any failure reason', async () => {
    configureEmail({ replyTo: REPLY_TO_ENV });

    const failures: FetchHandler[] = [
      () => jsonResponse(401, { name: 'validation_error', message: 'API key is invalid' }),
      () => jsonResponse(429, { message: 'Too many requests' }),
      () => jsonResponse(500, { message: 'Internal server error' }),
      () => new Response('server maintenance', { status: 503 }),
      () => {
        throw new Error('fetch failed');
      },
    ];

    for (const handler of failures) {
      stubFetch(handler);
      const result = await sendEmail(input());
      expectResultShape(result);
      expect(result.success).toBe(false);
      expect(result.failureReason).not.toContain(API_KEY);
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    }

    // The missing-configuration reason names the variables, never their values.
    delete process.env.RESEND_API_KEY;
    const unconfigured = await sendEmail(input());
    expect(unconfigured.failureReason).toContain('RESEND_API_KEY');
    expect(unconfigured.failureReason).not.toContain(API_KEY);
  });

  it('reaches no host other than the provider endpoint and never the platform fetch', async () => {
    configureEmail();
    const mock = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));

    // The module resolves `fetch` from the global at call time, so the replacement is what runs
    // and the platform implementation captured before any stub was installed is never invoked.
    expect(globalThis.fetch).not.toBe(NATIVE_FETCH);
    expect(mock).not.toBe(NATIVE_FETCH);

    const result = await sendEmail(input());

    expect(result.success).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(lastCall(mock).url).toBe(RESEND_ENDPOINT);
    expect(nativeFetchCalls).toBe(0);
  });

  it('logs nothing on any path', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    await sendEmail(input()); // unconfigured

    configureEmail();
    stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    await sendEmail(input());

    stubFetch(() => jsonResponse(500, { message: 'Internal server error' }));
    await sendEmail(input());

    stubFetch(() => {
      throw new Error('fetch failed');
    });
    await sendEmail(input());

    await sendEmail(input({ to: '' }));

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

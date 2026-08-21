/**
 * Spec: .kiro/specs/carrier-email-submission, Requirements 1, 10, 12.
 *
 * Every test drives an injected `fetch`. Nothing here reaches Microsoft.
 *
 * The assertions that earn their keep are the ones about failure: that a token never
 * appears in anything the module returns, that `invalid_grant` is distinguished from a
 * transient error, and that the size threshold actually switches transport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCESS_DENIED_MESSAGE,
  REQUIRED_SCOPES,
  buildAuthorizationUrl,
  createPkcePair,
  createState,
  encodedSize,
  exchangeCodeForTokens,
  getConfig,
  getMailboxIdentity,
  isMicrosoftConfigured,
  missingSendScopes,
  needsUploadSession,
  refreshAccessToken,
  sendMailAsUser,
  type MailAttachment,
  type MicrosoftConfig,
} from '../microsoft-mail';

const CONFIG: MicrosoftConfig = {
  clientId: 'client-id',
  clientSecret: 'CLIENT-SECRET-VALUE',
  tenantId: 'tenant-id',
  redirectUri: 'https://www.example.com/api/email-connections/microsoft/callback',
};

const ACCESS_TOKEN = 'ACCESS-TOKEN-DO-NOT-LEAK';
const REFRESH_TOKEN = 'REFRESH-TOKEN-DO-NOT-LEAK';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function attachment(name: string, bytes: number): MailAttachment {
  return { fileName: name, mimeType: 'application/pdf', bytes: Buffer.alloc(bytes, 7) };
}

const ENV_KEYS = ['MS_OAUTH_CLIENT_ID', 'MS_OAUTH_CLIENT_SECRET', 'MS_OAUTH_TENANT_ID', 'MS_OAUTH_REDIRECT_URI'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('configuration', () => {
  it('is absent until all four variables are set', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(getConfig()).toBeNull();
    expect(isMicrosoftConfigured()).toBe(false);

    process.env.MS_OAUTH_CLIENT_ID = 'a';
    process.env.MS_OAUTH_CLIENT_SECRET = 'b';
    process.env.MS_OAUTH_TENANT_ID = 'c';
    expect(getConfig()).toBeNull();

    process.env.MS_OAUTH_REDIRECT_URI = 'd';
    expect(getConfig()).toEqual({ clientId: 'a', clientSecret: 'b', tenantId: 'c', redirectUri: 'd' });
  });

  it('treats a blank variable as absent', () => {
    for (const key of ENV_KEYS) process.env[key] = 'x';
    process.env.MS_OAUTH_TENANT_ID = '   ';
    expect(getConfig()).toBeNull();
  });
});

describe('authorization URL', () => {
  it('carries PKCE, the state, and only the three scopes we need', () => {
    const url = new URL(buildAuthorizationUrl({
      config: CONFIG, state: 'STATE-VALUE', codeChallenge: 'CHALLENGE',
    }));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(url.searchParams.get('state')).toBe('STATE-VALUE');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([...REQUIRED_SCOPES].sort());
  });

  it('requests Mail.ReadWrite but nothing wider', () => {
    // This assertion used to forbid every Mail.Read* scope, which encoded a promise the
    // implementation could not keep: POST /me/messages requires delegated Mail.ReadWrite,
    // and without it every send failed with 403 ErrorAccessDenied.
    //
    // The line is redrawn, not erased. Mail.ReadWrite is admitted because one specific
    // call needs it; the `.Shared` and `.All` variants — which reach other people's
    // mailboxes rather than the signed-in user's own — are still refused.
    const scope = new URL(buildAuthorizationUrl({
      config: CONFIG, state: 's', codeChallenge: 'c',
    })).searchParams.get('scope') ?? '';
    expect(scope).toContain('Mail.ReadWrite');
    expect(scope).not.toContain('.Shared');
    expect(scope).not.toContain('.All');
    expect(scope).not.toContain('MailboxSettings');
  });

  it('never puts the client secret in the URL', () => {
    const url = buildAuthorizationUrl({ config: CONFIG, state: 's', codeChallenge: 'c' });
    expect(url).not.toContain(CONFIG.clientSecret);
  });

  it('forces consent only when asked', () => {
    const plain = new URL(buildAuthorizationUrl({ config: CONFIG, state: 's', codeChallenge: 'c' }));
    expect(plain.searchParams.get('prompt')).toBeNull();
    const forced = new URL(buildAuthorizationUrl({
      config: CONFIG, state: 's', codeChallenge: 'c', forceConsent: true,
    }));
    expect(forced.searchParams.get('prompt')).toBe('consent');
  });
});

describe('PKCE', () => {
  it('derives an S256 challenge and never repeats a verifier', () => {
    const pairs = Array.from({ length: 20 }, () => createPkcePair());
    expect(new Set(pairs.map((p) => p.verifier)).size).toBe(20);
    expect(new Set(pairs.map((p) => p.challenge)).size).toBe(20);
    for (const pair of pairs) {
      expect(pair.challenge).not.toBe(pair.verifier);
      expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('produces an unguessable state', () => {
    expect(new Set(Array.from({ length: 20 }, () => createState())).size).toBe(20);
  });
});

describe('token exchange and refresh', () => {
  it('returns tokens and an absolute expiry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN,
      expires_in: 3600, scope: 'Mail.Send User.Read offline_access',
    }));
    const before = Date.now();
    const result = await exchangeCodeForTokens({
      config: CONFIG, code: 'CODE', codeVerifier: 'VERIFIER', fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tokens.accessToken).toBe(ACCESS_TOKEN);
    expect(result.tokens.scopes.sort()).toEqual(['Mail.Send', 'User.Read', 'offline_access']);
    const expiry = Date.parse(result.tokens.expiresAt);
    expect(expiry).toBeGreaterThanOrEqual(before + 3_599_000);
  });

  it('sends the verifier and the secret in the form, never the URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { access_token: 'a', expires_in: 60 }));
    await exchangeCodeForTokens({ config: CONFIG, code: 'CODE', codeVerifier: 'VERIFIER', fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).not.toContain('VERIFIER');
    expect(url).not.toContain(CONFIG.clientSecret);
    const form = new URLSearchParams(init.body as string);
    expect(form.get('code_verifier')).toBe('VERIFIER');
    expect(form.get('grant_type')).toBe('authorization_code');
  });

  it('treats invalid_grant as needing reconnection, not as retryable', async () => {
    // The one failure a retry cannot fix: consent revoked, password changed, policy
    // altered. Retrying forever would hide it.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, {
      error: 'invalid_grant', error_description: 'AADSTS700082: refresh token expired\r\nTrace ID: x',
    }));
    const result = await refreshAccessToken({ config: CONFIG, refreshToken: REFRESH_TOKEN, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.needsReconnect).toBe(true);
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain('invalid_grant');
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
  ])('marks HTTP %i retryable=%s', async (status, retryable) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(status, { error: 'temporarily_unavailable' }));
    const result = await refreshAccessToken({ config: CONFIG, refreshToken: REFRESH_TOKEN, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(retryable);
  });

  it('treats a transport error as retryable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const result = await refreshAccessToken({ config: CONFIG, refreshToken: REFRESH_TOKEN, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
    expect(result.needsReconnect).toBe(false);
  });

  it('NEVER puts a token or the client secret in a failure reason', async () => {
    // The single most important assertion in this file. A provider error that quotes the
    // request is how credentials reach logs.
    for (const response of [
      jsonResponse(400, { error: 'invalid_grant', error_description: `bad ${REFRESH_TOKEN}` }),
      jsonResponse(500, { error: 'server_error' }),
    ]) {
      const fetchImpl = vi.fn().mockResolvedValue(response);
      const result = await refreshAccessToken({ config: CONFIG, refreshToken: REFRESH_TOKEN, fetchImpl });
      if (result.ok) continue;
      expect(result.reason).not.toContain(CONFIG.clientSecret);
    }
    const thrown = vi.fn().mockRejectedValue(new Error(`connect failed for ${CONFIG.clientSecret}`));
    const result = await refreshAccessToken({ config: CONFIG, refreshToken: REFRESH_TOKEN, fetchImpl: thrown });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain(CONFIG.clientSecret);
    expect(result.reason).not.toContain(REFRESH_TOKEN);
  });
});

describe('mailbox identity', () => {
  it('prefers mail, falls back to userPrincipalName', async () => {
    const withMail = vi.fn().mockResolvedValue(jsonResponse(200, {
      id: 'acct', mail: 'olanda@nhpfs.com', userPrincipalName: 'other@nhpfs.com', displayName: 'Oscar',
    }));
    const a = await getMailboxIdentity({ accessToken: ACCESS_TOKEN, fetchImpl: withMail });
    expect(a.ok && a.identity.emailAddress).toBe('olanda@nhpfs.com');

    const withoutMail = vi.fn().mockResolvedValue(jsonResponse(200, {
      id: 'acct', userPrincipalName: 'upn@nhpfs.com',
    }));
    const b = await getMailboxIdentity({ accessToken: ACCESS_TOKEN, fetchImpl: withoutMail });
    expect(b.ok && b.identity.emailAddress).toBe('upn@nhpfs.com');
  });

  it('refuses a response with no address rather than inventing one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'acct' }));
    const result = await getMailboxIdentity({ accessToken: ACCESS_TOKEN, fetchImpl });
    expect(result.ok).toBe(false);
  });
});

describe('attachment size routing', () => {
  it('computes base64 size without allocating', () => {
    expect(encodedSize(3)).toBe(4);
    expect(encodedSize(1)).toBe(4);
    expect(encodedSize(6)).toBe(8);
  });

  it('stays inline below the threshold and switches above it', () => {
    expect(needsUploadSession([attachment('a.pdf', 1_000_000)])).toBe(false);
    expect(needsUploadSession([attachment('a.pdf', 3_000_000)])).toBe(true);
  });

  it('measures the TOTAL, not the largest single file', () => {
    // Three files well under the limit individually still overflow one request.
    const many = Array.from({ length: 3 }, (_, i) => attachment(`f${i}.pdf`, 900_000));
    expect(many.every((a) => !needsUploadSession([a]))).toBe(true);
    expect(needsUploadSession(many)).toBe(true);
  });
});

describe('sendMailAsUser', () => {
  function draftCreated(id = 'draft-1', internetMessageId: string | null = '<mid@nhpfs.com>') {
    return jsonResponse(201, { id, internetMessageId });
  }

  it('creates a draft, sends it, and returns the internetMessageId', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(draftCreated())
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    const result = await sendMailAsUser({
      accessToken: ACCESS_TOKEN, subject: 'S', body: 'B',
      to: ['carrier@example.com'], cc: ['cc@example.com'],
      attachments: [attachment('app.pdf', 1000)], fetchImpl,
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('<mid@nhpfs.com>');
    expect(result.draftId).toBe('draft-1');

    const [createUrl, createInit] = fetchImpl.mock.calls[0];
    expect(createUrl).toBe('https://graph.microsoft.com/v1.0/me/messages');
    const draft = JSON.parse(createInit.body as string);
    expect(draft.toRecipients).toEqual([{ emailAddress: { address: 'carrier@example.com' } }]);
    expect(draft.ccRecipients).toEqual([{ emailAddress: { address: 'cc@example.com' } }]);
    expect(draft.attachments[0]['@odata.type']).toBe('#microsoft.graph.fileAttachment');

    expect(fetchImpl.mock.calls[1][0]).toBe('https://graph.microsoft.com/v1.0/me/messages/draft-1/send');
  });

  it('does NOT use /me/sendMail', async () => {
    // That endpoint returns 202 with an empty body and no identifier, which cannot
    // satisfy "capture the provider message id".
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(draftCreated())
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    await sendMailAsUser({ accessToken: ACCESS_TOKEN, subject: 'S', body: 'B', to: ['a@b.com'], fetchImpl });
    for (const [url] of fetchImpl.mock.calls) {
      expect(String(url)).not.toContain('/sendMail');
    }
  });

  it('refuses to send with no recipient, without contacting the provider', async () => {
    const fetchImpl = vi.fn();
    const result = await sendMailAsUser({
      accessToken: ACCESS_TOKEN, subject: 'S', body: 'B', to: [], fetchImpl,
    });
    expect(result.success).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses an upload session for large attachments and chunks by 320 KiB multiples', async () => {
    const big = attachment('big.pdf', 12 * 1024 * 1024);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(draftCreated())
      .mockResolvedValueOnce(jsonResponse(201, { uploadUrl: 'https://upload.example/session' }))
      .mockResolvedValue(new Response(null, { status: 202 }));

    const result = await sendMailAsUser({
      accessToken: ACCESS_TOKEN, subject: 'S', body: 'B',
      to: ['a@b.com'], attachments: [big], fetchImpl,
    });
    expect(result.success).toBe(true);

    // The draft must NOT carry the bytes inline.
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string).attachments).toBeUndefined();

    const puts = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts.length).toBe(3); // 12 MiB in 5 MiB chunks
    const ranges = puts.map(([, init]) => (init.headers as Record<string, string>)['Content-Range']);
    expect(ranges[0]).toBe(`bytes 0-5242879/${big.bytes.length}`);
    expect(ranges[2]).toBe(`bytes 10485760-12582911/${big.bytes.length}`);
    // Every chunk but the last must be a multiple of 320 KiB, which Graph requires.
    expect(5242880 % (320 * 1024)).toBe(0);
  });

  it('does not send the bearer token to the pre-authorised upload URL', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(draftCreated())
      .mockResolvedValueOnce(jsonResponse(201, { uploadUrl: 'https://upload.example/session' }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    await sendMailAsUser({
      accessToken: ACCESS_TOKEN, subject: 'S', body: 'B',
      to: ['a@b.com'], attachments: [attachment('big.pdf', 4 * 1024 * 1024)], fetchImpl,
    });
    const put = fetchImpl.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.stringify(put?.[1]?.headers ?? {})).not.toContain(ACCESS_TOKEN);
  });

  it('reports a draft-creation failure and never sends', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, {
      error: { code: 'ErrorAccessDenied', message: 'Access is denied.' },
    }));
    const result = await sendMailAsUser({
      accessToken: ACCESS_TOKEN, subject: 'S', body: 'B', to: ['a@b.com'], fetchImpl,
    });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    // A 403 is translated to its remedy rather than echoed — see the 403 handling suite.
    expect(result.failureReason).toBe(ACCESS_DENIED_MESSAGE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([[429, true], [503, true], [400, false]])(
    'marks a send failure of HTTP %i retryable=%s', async (status, retryable) => {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(draftCreated())
        .mockResolvedValueOnce(jsonResponse(status, { error: { code: 'x', message: 'y' } }));
      const result = await sendMailAsUser({
        accessToken: ACCESS_TOKEN, subject: 'S', body: 'B', to: ['a@b.com'], fetchImpl,
      });
      expect(result.success).toBe(false);
      expect(result.retryable).toBe(retryable);
      expect(result.draftId).toBe('draft-1');
    });

  it('never throws, whatever the transport does', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('aborted', 'TimeoutError'));
    const result = await sendMailAsUser({
      accessToken: ACCESS_TOKEN, subject: 'S', body: 'B', to: ['a@b.com'], fetchImpl,
    });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('NEVER leaks the access token into a failure reason', async () => {
    const cases = [
      vi.fn().mockResolvedValueOnce(jsonResponse(500, {
        error: { code: 'x', message: `token ${ACCESS_TOKEN} rejected` },
      })),
      vi.fn().mockRejectedValue(new Error(`socket hang up while sending ${ACCESS_TOKEN}`)),
    ];
    for (const fetchImpl of cases) {
      const result = await sendMailAsUser({
        accessToken: ACCESS_TOKEN, subject: 'S', body: 'B', to: ['a@b.com'], fetchImpl,
      });
      expect(result.success).toBe(false);
      expect(result.failureReason ?? '').not.toContain(ACCESS_TOKEN);
    }
    // Note the two paths differ, and both are correct: an echoed token is redacted,
    // while a transport error never carries one because only `err.name` is used.
  });

  it('redacts an echoed token rather than dropping the whole message', async () => {
    // The surrounding text is what tells an operator what went wrong. Blanking the
    // entire reason to be safe would trade one problem for another.
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(500, {
      error: { code: 'InternalServerError', message: `token ${ACCESS_TOKEN} rejected` },
    }));
    const result = await sendMailAsUser({
      accessToken: ACCESS_TOKEN, subject: 'S', body: 'B', to: ['a@b.com'], fetchImpl,
    });
    expect(result.failureReason).toBe('HTTP 500 — InternalServerError: token [redacted] rejected');
  });

  it('leaves a short accessToken alone rather than mangling the message', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(500, {
      error: { code: 'x', message: 'the file was not found' },
    }));
    const result = await sendMailAsUser({
      accessToken: 'abc', subject: 'S', body: 'B', to: ['a@b.com'], fetchImpl,
    });
    expect(result.failureReason).toContain('the file was not found');
  });

  it('succeeds even when the provider omits internetMessageId', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(draftCreated('d2', null))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const result = await sendMailAsUser({
      accessToken: ACCESS_TOKEN, subject: 'S', body: 'B', to: ['a@b.com'], fetchImpl,
    });
    // The caller decides what to do; the database CHECK refuses a 'sent' row with no id.
    expect(result.success).toBe(true);
    expect(result.messageId).toBeNull();
  });
});

describe('scope requirements', () => {
  it('requests Mail.ReadWrite as well as Mail.Send', () => {
    // The draft path needs both, and neither implies the other: Mail.ReadWrite cannot
    // send, Mail.Send cannot create a draft. Omitting Mail.ReadWrite produced
    // 403 ErrorAccessDenied on POST /me/messages for every submission.
    expect([...REQUIRED_SCOPES]).toContain('Mail.ReadWrite');
    expect([...REQUIRED_SCOPES]).toContain('Mail.Send');
    expect([...REQUIRED_SCOPES]).toContain('offline_access');
    expect([...REQUIRED_SCOPES]).toContain('User.Read');
    expect(REQUIRED_SCOPES).toHaveLength(4);
  });

  it('uses the same scope set for authorization, exchange and refresh', () => {
    // A scope requested at authorization but omitted on refresh silently narrows the
    // token later, which fails long after anyone would connect the two.
    const authorize = new URL(
      buildAuthorizationUrl({ config: CONFIG, state: 's', codeChallenge: 'c' }),
    ).searchParams.get('scope');

    const exchangeFetch = vi.fn().mockResolvedValue(jsonResponse(200, { access_token: 'a', expires_in: 60 }));
    const refreshFetch = vi.fn().mockResolvedValue(jsonResponse(200, { access_token: 'a', expires_in: 60 }));

    return Promise.all([
      exchangeCodeForTokens({ config: CONFIG, code: 'c', codeVerifier: 'v', fetchImpl: exchangeFetch }),
      refreshAccessToken({ config: CONFIG, refreshToken: 'r', fetchImpl: refreshFetch }),
    ]).then(() => {
      const exchangeScope = new URLSearchParams(exchangeFetch.mock.calls[0][1].body as string).get('scope');
      const refreshScope = new URLSearchParams(refreshFetch.mock.calls[0][1].body as string).get('scope');
      expect(exchangeScope).toBe(authorize);
      expect(refreshScope).toBe(authorize);
    });
  });

  it('is delegated, never application permissions', () => {
    const exchangeFetch = vi.fn().mockResolvedValue(jsonResponse(200, { access_token: 'a', expires_in: 60 }));
    return exchangeCodeForTokens({
      config: CONFIG, code: 'c', codeVerifier: 'v', fetchImpl: exchangeFetch,
    }).then(() => {
      const form = new URLSearchParams(exchangeFetch.mock.calls[0][1].body as string);
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('scope')).not.toContain('.default');
    });
  });
});

describe('missingSendScopes', () => {
  it('accepts a complete grant in any case or order', () => {
    expect(missingSendScopes(['Mail.Send', 'Mail.ReadWrite', 'User.Read'])).toEqual([]);
    expect(missingSendScopes(['mail.readwrite', 'MAIL.SEND'])).toEqual([]);
  });

  it('accepts the fully-qualified resource URI form Microsoft sometimes returns', () => {
    expect(missingSendScopes([
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
    ])).toEqual([]);
  });

  it('names exactly what is missing', () => {
    // The pre-fix grant. This is what Oscar's stored connection looks like.
    expect(missingSendScopes(['offline_access', 'User.Read', 'Mail.Send'])).toEqual(['Mail.ReadWrite']);
    expect(missingSendScopes(['offline_access', 'User.Read', 'Mail.ReadWrite'])).toEqual(['Mail.Send']);
    expect(missingSendScopes(['User.Read'])).toEqual(['Mail.ReadWrite', 'Mail.Send']);
  });

  it('does NOT block when the provider returned no scope metadata', () => {
    // Some token responses omit `scope`. Refusing to send on absent metadata would be a
    // worse failure than the one being prevented — it would break a working mailbox.
    expect(missingSendScopes([])).toEqual([]);
  });
});

describe('403 handling', () => {
  it('explains an ErrorAccessDenied on draft creation instead of echoing Graph', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, {
      error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' },
    }));
    const result = await sendMailAsUser({
      accessToken: ACCESS_TOKEN, subject: 'S', body: 'B', to: ['a@b.com'], fetchImpl,
    });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe(ACCESS_DENIED_MESSAGE);
    // "Check credentials" sends the reader hunting for a password problem that does not
    // exist. The remedy is the permission grant, so that is what is said.
    expect(result.failureReason).not.toContain('Check credentials');
    expect(result.retryable).toBe(false);
  });

  it('explains a 403 during a large-attachment upload session too', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(201, { id: 'd1', internetMessageId: '<m>' }))
      .mockResolvedValueOnce(jsonResponse(403, { error: { code: 'ErrorAccessDenied', message: 'nope' } }));
    const result = await sendMailAsUser({
      accessToken: ACCESS_TOKEN, subject: 'S', body: 'B', to: ['a@b.com'],
      attachments: [attachment('big.pdf', 4 * 1024 * 1024)], fetchImpl,
    });
    expect(result.success).toBe(false);
    expect(result.failureReason).toContain('Reconnect your mailbox');
  });

  it('still reports other Graph errors verbatim', async () => {
    // Only 403 has a specific known remedy. Replacing every error with one friendly
    // sentence would hide the ones that need reading.
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(400, {
      error: { code: 'ErrorInvalidRecipients', message: 'The recipient is invalid.' },
    }));
    const result = await sendMailAsUser({
      accessToken: ACCESS_TOKEN, subject: 'S', body: 'B', to: ['a@b.com'], fetchImpl,
    });
    expect(result.failureReason).toContain('ErrorInvalidRecipients');
  });
});

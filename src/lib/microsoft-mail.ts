/**
 * Microsoft 365 mailbox authorization and sending, via Entra ID and Microsoft Graph.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirements 1, 10, 12.
 *
 * THIS IS THE ONLY MODULE PERMITTED TO NAME `login.microsoftonline.com`,
 * `graph.microsoft.com`, OR ANY `MS_OAUTH_*` VARIABLE. The repository already enforces
 * that discipline for Resend and RingCentral through
 * `src/features/cancellations/__tests__/provider-isolation.test.ts`; a matching test for
 * this module lives beside it. The reason is not tidiness — it is that a credential name
 * scattered across the codebase is a credential nobody can rotate with confidence.
 *
 * WHY THE DRAFT PATH RATHER THAN /me/sendMail
 *   `POST /me/sendMail` returns 202 Accepted with an empty body and NO message
 *   identifier, which cannot satisfy Requirement 10.4. Creating a draft returns both `id`
 *   and `internetMessageId`; the latter is the RFC-822 Message-ID, is assigned at draft
 *   creation, survives the move into Sent Items, and is the value a carrier's reply will
 *   reference. One path also covers both attachment size regimes.
 *
 * NOTHING HERE THROWS. Every function returns a discriminated result, matching
 * `src/lib/email.ts` and `src/lib/ringcentral-sms.ts`. A provider that throws forces every
 * caller to remember a try/catch, and the one that forgets sends an email and records
 * nothing.
 */

import { createHash, randomBytes } from 'node:crypto';

const AUTH_HOST = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * The delegated permissions this application requests. Nothing wider.
 *
 * `Mail.ReadWrite` is here because of the draft path, and it was missing at first — which
 * is what produced `403 ErrorAccessDenied` on every send. `POST /me/messages` creates a
 * draft in the user's mailbox, and Microsoft Graph requires `Mail.ReadWrite` for that
 * specific call. `Mail.Send` alone authorises `POST /me/sendMail` and nothing else, so the
 * original scope set could never have worked with a draft-first implementation.
 *
 * BOTH are needed and neither implies the other: `Mail.ReadWrite` cannot send, and
 * `Mail.Send` cannot create a draft.
 *
 * HONEST NOTE ON WHAT THIS GRANTS. `Mail.ReadWrite` is read AND write across the user's
 * mail folders — it is genuinely broader than "send on my behalf", and it is the price of
 * the draft path. The draft path is what yields `internetMessageId` (the RFC-822
 * Message-ID a carrier's reply will reference) and what handles attachments above the
 * inline limit. `/me/sendMail` would need only `Mail.Send`, but it returns 202 with an
 * empty body and no identifier at all, so a submission could never prove it was sent.
 * That trade is deliberate and was made with the mailbox owner. If the read access ever
 * becomes unacceptable, the alternative is `/me/sendMail` plus a schema change allowing a
 * sent submission to carry no provider message id.
 */
export const REQUIRED_SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
] as const;

/**
 * The two that must be present on a token before a submission may be sent.
 *
 * `offline_access` and `User.Read` matter at connection time; these two are what the send
 * itself depends on, one per Graph call it makes.
 */
export const SCOPES_REQUIRED_TO_SEND = ['Mail.ReadWrite', 'Mail.Send'] as const;

/**
 * Which required send scopes are absent from what the provider actually granted.
 *
 * Microsoft returns scopes in whatever case and order it likes, and may grant fewer than
 * were asked for — a tenant policy or an interrupted consent both do that silently. The
 * connection then looks healthy right up until the send fails with a 403 nobody can read.
 * So the granted set is checked rather than assumed.
 *
 * An EMPTY granted list is treated as "cannot tell, do not block": some token responses
 * omit `scope` entirely, and refusing to send on missing metadata would be a worse failure
 * than the one being prevented.
 */
export function missingSendScopes(granted: readonly string[]): string[] {
  if (granted.length === 0) return [];
  const held = new Set(
    granted.map((scope) => scope.trim().toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, '')),
  );
  return SCOPES_REQUIRED_TO_SEND.filter((needed) => !held.has(needed.toLowerCase()));
}

/** The message shown when consent did not cover what sending needs. */
export const INCOMPLETE_AUTHORIZATION_MESSAGE =
  'Microsoft mailbox authorization is incomplete. Reconnect your mailbox to grant the required email permissions.';

const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Above this, attachments go through an upload session instead of inline.
 *
 * Graph caps a message-create request at about 4 MB, and base64 inflates by 4/3. Three
 * megabytes of *encoded* attachment leaves room for the body and headers.
 */
const INLINE_LIMIT_ENCODED_BYTES = 3 * 1024 * 1024;

/** Graph requires upload chunks to be a multiple of 320 KiB. 5 MiB is 16 of them. */
const UPLOAD_CHUNK_BYTES = 320 * 1024 * 16;

export type FetchLike = typeof fetch;

export interface MicrosoftConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri: string;
}

function readEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Removes known secrets from text destined for a log, a response, or the database.
 *
 * A provider is not supposed to echo a bearer token back in an error body. "Not supposed
 * to" is not a control, and `carrier_submissions.failure_reason` is persisted — so a
 * single chatty upstream error would write a live credential into the database, where it
 * would sit until someone happened to read that row.
 *
 * Every failure path in this module passes through here. That is deliberate: a redactor
 * applied at three call sites is a redactor someone will forget at the fourth.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined | null)[]): string {
  let output = text;
  for (const secret of secrets) {
    // Below eight characters a "secret" is more likely to be a substring of ordinary
    // words, and blanking those would destroy the message without protecting anything.
    if (typeof secret === 'string' && secret.length >= 8) {
      output = output.split(secret).join('[redacted]');
    }
  }
  return output;
}

/** The configuration, or null when incomplete. Null rather than throw, like `email.ts`. */
export function getConfig(): MicrosoftConfig | null {
  const clientId = readEnv('MS_OAUTH_CLIENT_ID');
  const clientSecret = readEnv('MS_OAUTH_CLIENT_SECRET');
  const tenantId = readEnv('MS_OAUTH_TENANT_ID');
  const redirectUri = readEnv('MS_OAUTH_REDIRECT_URI');
  if (!clientId || !clientSecret || !tenantId || !redirectUri) return null;
  return { clientId, clientSecret, tenantId, redirectUri };
}

export function isMicrosoftConfigured(): boolean {
  return getConfig() !== null;
}

// ── PKCE ──────────────────────────────────────────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * A PKCE verifier and its S256 challenge.
 *
 * This is a confidential client — it holds a secret — so PKCE is not strictly required.
 * It is used anyway because it costs nothing and closes authorization-code interception
 * even if the redirect is ever mis-configured.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** A single-use, unguessable `state`. */
export function createState(): string {
  return randomBytes(32).toString('base64url');
}

// ── Authorization ─────────────────────────────────────────────────────────────

export function buildAuthorizationUrl(input: {
  config: MicrosoftConfig;
  state: string;
  codeChallenge: string;
  /** Forces the consent screen. Used by Reconnect so revoked consent is re-granted. */
  forceConsent?: boolean;
}): string {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    response_type: 'code',
    redirect_uri: input.config.redirectUri,
    response_mode: 'query',
    scope: REQUIRED_SCOPES.join(' '),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (input.forceConsent) params.set('prompt', 'consent');
  return `${AUTH_HOST}/${input.config.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, ISO 8601. */
  expiresAt: string;
  scopes: string[];
}

export type TokenResult =
  | { ok: true; tokens: TokenSet }
  | { ok: false; reason: string; retryable: boolean; needsReconnect: boolean };

/**
 * Reduces a token endpoint response to a result.
 *
 * `invalid_grant` is singled out because it is the one failure a retry cannot fix: the
 * user revoked consent, changed their password, or an administrator altered policy. The
 * only remedy is to authorize again, so it is reported as `needsReconnect` rather than as
 * a transient error the caller might sensibly retry forever.
 */
function readTokenResponse(status: number, payload: unknown): TokenResult {
  const body = (payload ?? {}) as Record<string, unknown>;

  if (status >= 200 && status < 300 && typeof body.access_token === 'string') {
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    return {
      ok: true,
      tokens: {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : '',
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
      },
    };
  }

  const error = typeof body.error === 'string' ? body.error : `http_${status}`;
  const description =
    typeof body.error_description === 'string'
      ? body.error_description.split('\n')[0].slice(0, 300)
      : '';

  const needsReconnect =
    error === 'invalid_grant' || error === 'interaction_required' || error === 'consent_required';

  return {
    ok: false,
    reason: description ? `${error}: ${description}` : error,
    retryable: !needsReconnect && (status === 429 || status >= 500),
    needsReconnect,
  };
}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  form: Record<string, string>,
): Promise<TokenResult> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const result = readTokenResponse(response.status, payload);
    if (!result.ok) {
      return { ...result, reason: redactSecrets(result.reason, Object.values(form)) };
    }
    return result;
  } catch (err) {
    // Never interpolate the form — it carries the client secret and the refresh token.
    // `err.name` only — an Error message can contain the request it failed on.
    return {
      ok: false,
      reason: `Could not reach the identity provider: ${err instanceof Error ? err.name : 'unknown error'}`,
      retryable: true,
      needsReconnect: false,
    };
  }
}

export function exchangeCodeForTokens(input: {
  config: MicrosoftConfig;
  code: string;
  codeVerifier: string;
  fetchImpl?: FetchLike;
}): Promise<TokenResult> {
  return postForm(input.fetchImpl ?? fetch, `${AUTH_HOST}/${input.config.tenantId}/oauth2/v2.0/token`, {
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.config.redirectUri,
    code_verifier: input.codeVerifier,
    scope: REQUIRED_SCOPES.join(' '),
  });
}

export function refreshAccessToken(input: {
  config: MicrosoftConfig;
  refreshToken: string;
  fetchImpl?: FetchLike;
}): Promise<TokenResult> {
  return postForm(input.fetchImpl ?? fetch, `${AUTH_HOST}/${input.config.tenantId}/oauth2/v2.0/token`, {
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    scope: REQUIRED_SCOPES.join(' '),
  });
}

// ── Identity ──────────────────────────────────────────────────────────────────

export interface MailboxIdentity {
  accountId: string;
  emailAddress: string;
  displayName: string | null;
}

export type IdentityResult =
  | { ok: true; identity: MailboxIdentity }
  | { ok: false; reason: string };

/**
 * The mailbox that was actually authorized.
 *
 * Read from the provider rather than assumed, because the address a user expects and the
 * address they signed in with are not always the same, and the second one is what
 * carriers will see (Requirement 1.12).
 */
export async function getMailboxIdentity(input: {
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<IdentityResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${GRAPH}/me?$select=id,mail,userPrincipalName,displayName`, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, reason: `Could not read the mailbox identity (HTTP ${response.status}).` };
    }
    const body = (await response.json()) as Record<string, unknown>;
    const address =
      (typeof body.mail === 'string' && body.mail) ||
      (typeof body.userPrincipalName === 'string' && body.userPrincipalName) ||
      '';
    if (!address || typeof body.id !== 'string') {
      return { ok: false, reason: 'The provider returned no mailbox address.' };
    }
    return {
      ok: true,
      identity: {
        accountId: body.id,
        emailAddress: address,
        displayName: typeof body.displayName === 'string' ? body.displayName : null,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `Could not reach the mail provider: ${err instanceof Error ? err.name : 'unknown error'}`,
    };
  }
}

// ── Sending ───────────────────────────────────────────────────────────────────

export interface MailAttachment {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

export interface MailSendResult {
  success: boolean;
  /** The RFC-822 Message-ID. Stable across the move into Sent Items. */
  messageId: string | null;
  /** The mutable Graph item id, kept for support rather than as an identifier. */
  draftId: string | null;
  failureReason: string | null;
  retryable: boolean;
}

/** base64 length for n bytes, without allocating the string. */
export function encodedSize(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

export function totalEncodedSize(attachments: readonly MailAttachment[]): number {
  return attachments.reduce((sum, a) => sum + encodedSize(a.bytes.length), 0);
}

export function needsUploadSession(attachments: readonly MailAttachment[]): boolean {
  return totalEncodedSize(attachments) > INLINE_LIMIT_ENCODED_BYTES;
}

function failure(reason: string, retryable: boolean): MailSendResult {
  return { success: false, messageId: null, draftId: null, failureReason: reason, retryable };
}

/** 429 and 5xx are worth retrying. Other 4xx will fail identically forever. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Describes a Graph failure without ever quoting the credential.
 *
 * The bearer token is only ever in a request header, never in a response body, so
 * echoing the body is safe — but the status line is built explicitly rather than by
 * stringifying the whole request, which is how tokens end up in logs.
 */
async function describeFailure(response: Response): Promise<string> {
  let code = '';
  let detail = '';
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    code = body?.error?.code ?? '';
    const message = body?.error?.message ?? '';
    detail = [code, message].filter(Boolean).join(': ').slice(0, 400);
  } catch {
    detail = '';
  }

  // The one Graph failure that has a specific, actionable cause worth naming.
  //
  // `403 ErrorAccessDenied` on a mail call means the token does not carry the permission
  // the call needs — almost always a mailbox connected before Mail.ReadWrite was
  // requested, whose stored consent predates the fix. Raw Graph text ("Access is denied.
  // Check credentials and try again.") sends the reader looking for a password problem
  // that does not exist, so the remedy is stated instead.
  if (response.status === 403 && (code === 'ErrorAccessDenied' || code === 'AccessDenied' || code === '')) {
    return ACCESS_DENIED_MESSAGE;
  }

  return detail ? `HTTP ${response.status} — ${detail}` : `HTTP ${response.status}`;
}

/** Shown for a 403 on any mail call. Names the remedy, not just the refusal. */
export const ACCESS_DENIED_MESSAGE =
  'Microsoft denied access to create the email draft. Reconnect your mailbox and confirm Mail.ReadWrite and Mail.Send permissions are granted.';

function recipientList(addresses: readonly string[]) {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

/**
 * Creates a draft in the sender's mailbox, attaches, and sends it.
 *
 * Because the draft is created in their mailbox and sent from it, the message lands in
 * their Sent Items and carrier replies thread back to them — which is the entire reason
 * for connecting a real mailbox rather than relaying through a transactional provider.
 */
export async function sendMailAsUser(input: {
  accessToken: string;
  subject: string;
  body: string;
  to: readonly string[];
  cc?: readonly string[];
  attachments?: readonly MailAttachment[];
  fetchImpl?: FetchLike;
}): Promise<MailSendResult> {
  const result = await sendMailInner(input);
  // One choke point, so no failure path can bypass redaction.
  return result.failureReason === null
    ? result
    : { ...result, failureReason: redactSecrets(result.failureReason, [input.accessToken]) };
}

async function sendMailInner(input: {
  accessToken: string;
  subject: string;
  body: string;
  to: readonly string[];
  cc?: readonly string[];
  attachments?: readonly MailAttachment[];
  fetchImpl?: FetchLike;
}): Promise<MailSendResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const attachments = input.attachments ?? [];
  const headers = {
    Authorization: `Bearer ${input.accessToken}`,
    'Content-Type': 'application/json',
  };

  if (input.to.length === 0) {
    return failure('No recipient was given.', false);
  }

  const inline = !needsUploadSession(attachments);

  // 1. Create the draft.
  let draftId: string;
  let internetMessageId: string | null;
  try {
    const draft: Record<string, unknown> = {
      subject: input.subject,
      body: { contentType: 'Text', content: input.body },
      toRecipients: recipientList(input.to),
      ccRecipients: recipientList(input.cc ?? []),
    };
    if (inline && attachments.length > 0) {
      draft.attachments = attachments.map((a) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.fileName,
        contentType: a.mimeType,
        contentBytes: a.bytes.toString('base64'),
      }));
    }

    const response = await fetchImpl(`${GRAPH}/me/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(draft),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return failure(await describeFailure(response), isRetryableStatus(response.status));
    }
    const created = (await response.json()) as Record<string, unknown>;
    if (typeof created.id !== 'string') {
      return failure('The provider created a draft with no identifier.', false);
    }
    draftId = created.id;
    internetMessageId =
      typeof created.internetMessageId === 'string' ? created.internetMessageId : null;
  } catch (err) {
    return failure(
      `Could not reach the mail provider: ${err instanceof Error ? err.name : 'unknown error'}`,
      true,
    );
  }

  // 2. Large attachments, one upload session each.
  if (!inline) {
    for (const attachment of attachments) {
      const uploaded = await uploadLargeAttachment({
        fetchImpl,
        accessToken: input.accessToken,
        draftId,
        attachment,
      });
      if (uploaded !== null) {
        return { ...uploaded, draftId };
      }
    }
  }

  // 3. Send.
  try {
    const response = await fetchImpl(`${GRAPH}/me/messages/${draftId}/send`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ...failure(await describeFailure(response), isRetryableStatus(response.status)), draftId };
    }
  } catch (err) {
    return {
      ...failure(
        `Could not reach the mail provider: ${err instanceof Error ? err.name : 'unknown error'}`,
        true,
      ),
      draftId,
    };
  }

  return {
    success: true,
    messageId: internetMessageId,
    draftId,
    failureReason: null,
    retryable: false,
  };
}

/** Returns null on success, or the failure that ends the send. */
async function uploadLargeAttachment(input: {
  fetchImpl: FetchLike;
  accessToken: string;
  draftId: string;
  attachment: MailAttachment;
}): Promise<MailSendResult | null> {
  const { fetchImpl, accessToken, draftId, attachment } = input;
  const size = attachment.bytes.length;

  let uploadUrl: string;
  try {
    const response = await fetchImpl(
      `${GRAPH}/me/messages/${draftId}/attachments/createUploadSession`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          AttachmentItem: {
            attachmentType: 'file',
            name: attachment.fileName,
            size,
            contentType: attachment.mimeType,
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return failure(
        `${attachment.fileName}: ${await describeFailure(response)}`,
        isRetryableStatus(response.status),
      );
    }
    const session = (await response.json()) as Record<string, unknown>;
    if (typeof session.uploadUrl !== 'string') {
      return failure(`${attachment.fileName}: the provider returned no upload URL.`, false);
    }
    uploadUrl = session.uploadUrl;
  } catch (err) {
    return failure(
      `${attachment.fileName}: could not start the upload (${err instanceof Error ? err.name : 'unknown error'}).`,
      true,
    );
  }

  for (let start = 0; start < size; start += UPLOAD_CHUNK_BYTES) {
    const end = Math.min(start + UPLOAD_CHUNK_BYTES, size) - 1;
    const chunk = attachment.bytes.subarray(start, end + 1);
    try {
      // The upload URL is pre-authorised; sending the bearer token to it as well would
      // widen where the credential travels for no benefit.
      const response = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${start}-${end}/${size}`,
        },
        body: new Uint8Array(chunk),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!response.ok && response.status !== 201 && response.status !== 202) {
        return failure(
          `${attachment.fileName}: upload failed at byte ${start} (HTTP ${response.status}).`,
          isRetryableStatus(response.status),
        );
      }
    } catch (err) {
      return failure(
        `${attachment.fileName}: upload interrupted at byte ${start} (${err instanceof Error ? err.name : 'unknown error'}).`,
        true,
      );
    }
  }

  return null;
}

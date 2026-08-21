/**
 * Completes the OAuth flow and stores the connection.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirement 1.5–1.6, 1.12.
 *
 * The cookie is cleared before anything else happens, so a replayed callback cannot reuse
 * a `state` even if the exchange below fails partway.
 */

import { cookies } from 'next/headers';

import { secretsMatch } from '@/lib/crypto/secret-box';
import { exchangeCodeForTokens, getConfig, getMailboxIdentity } from '@/lib/microsoft-mail';
import { resolveSender } from '@/features/carrier-submissions/server/actor';
import { storeConnection } from '@/features/carrier-submissions/server/connections';
import { createSubmissionServiceClient } from '@/features/carrier-submissions/server/service-client';

import { OAUTH_STATE_COOKIE } from '../start/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Where the user lands afterwards, with an outcome the settings screen can render. */
const SETTINGS_PATH = '/tools/specialty';

function back(request: Request, outcome: string, detail?: string): Response {
  const url = new URL(SETTINGS_PATH, new URL(request.url).origin);
  url.searchParams.set('email_connection', outcome);
  if (detail) url.searchParams.set('detail', detail.slice(0, 200));
  return Response.redirect(url.toString(), 302);
}

export async function GET(request: Request) {
  const jar = await cookies();
  const raw = jar.get(OAUTH_STATE_COOKIE)?.value ?? null;
  // Cleared first, unconditionally. A single-use value that survives a failed exchange is
  // no longer single-use.
  jar.delete(OAUTH_STATE_COOKIE);

  const resolved = await resolveSender();
  if (!resolved.ok) return back(request, 'error', 'You are not permitted to connect a mailbox.');

  const url = new URL(request.url);
  const providerError = url.searchParams.get('error');
  if (providerError) {
    return back(
      request,
      'error',
      url.searchParams.get('error_description') ?? providerError,
    );
  }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  if (!code || !returnedState || !raw) {
    return back(request, 'error', 'The authorisation response was incomplete. Try again.');
  }

  let stored: { state?: string; verifier?: string };
  try {
    stored = JSON.parse(raw) as { state?: string; verifier?: string };
  } catch {
    return back(request, 'error', 'The authorisation session was unreadable. Try again.');
  }

  // Constant-time, and a mismatch says nothing about which half was wrong.
  if (!stored.state || !stored.verifier || !secretsMatch(stored.state, returnedState)) {
    return back(request, 'error', 'The authorisation session did not match. Try again.');
  }

  const config = getConfig();
  if (!config) return back(request, 'error', 'Microsoft sending is not configured.');

  const exchanged = await exchangeCodeForTokens({ config, code, codeVerifier: stored.verifier });
  if (!exchanged.ok) return back(request, 'error', exchanged.reason);

  // Requirement 1.12: report the mailbox that was actually authorised, read from the
  // provider — not the one anybody assumed.
  const identity = await getMailboxIdentity({ accessToken: exchanged.tokens.accessToken });
  if (!identity.ok) return back(request, 'error', identity.reason);

  const service = createSubmissionServiceClient();
  if (!service) return back(request, 'error', 'The server is not configured to store the connection.');

  const saved = await storeConnection({
    service,
    profileId: resolved.actor.id,
    emailAddress: identity.identity.emailAddress,
    accountId: identity.identity.accountId,
    tenantId: config.tenantId,
    tokens: exchanged.tokens,
  });
  if (!saved.ok) return back(request, 'error', saved.reason);

  return back(request, 'connected', identity.identity.emailAddress);
}

/**
 * Begins the OAuth authorization-code flow against Microsoft Entra ID.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirement 1.3–1.5.
 *
 * The `state` and the PKCE verifier are held in one short-lived, httpOnly, SameSite=Lax
 * cookie rather than a database table. They are single-use, expire in minutes, and are
 * never queried — a table would be state to garbage-collect for no benefit. SameSite=Lax
 * still arrives on the top-level GET redirect back from Microsoft, which is the only
 * navigation that needs it.
 */

import { cookies } from 'next/headers';

import { buildAuthorizationUrl, createPkcePair, createState, getConfig } from '@/lib/microsoft-mail';
import { MESSAGES, fail } from '@/features/carrier-submissions/server/api';
import { resolveSender } from '@/features/carrier-submissions/server/actor';
import { submissionReadiness } from '@/features/carrier-submissions/server/readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OAUTH_STATE_COOKIE = 'nhwd_ms_oauth';
const COOKIE_TTL_SECONDS = 600;

export async function GET(request: Request) {
  const resolved = await resolveSender();
  if (!resolved.ok) return resolved.response;

  const config = getConfig();
  if (!config || !submissionReadiness().ready) {
    return fail('unconfigured', MESSAGES.unconfigured);
  }

  const state = createState();
  const pkce = createPkcePair();

  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, JSON.stringify({ state, verifier: pkce.verifier }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/email-connections',
    maxAge: COOKIE_TTL_SECONDS,
  });

  const forceConsent = new URL(request.url).searchParams.get('reconnect') === '1';
  const authorizationUrl = buildAuthorizationUrl({
    config,
    state,
    codeChallenge: pkce.challenge,
    forceConsent,
  });

  return Response.redirect(authorizationUrl, 302);
}

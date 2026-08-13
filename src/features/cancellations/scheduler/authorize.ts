// Who may run the Notification_Scheduler, decided before a single row is read.
//
// Requirement 12 criteria 9 and 10 are the whole contract:
// - 12.9   a request whose `Authorization` header token equals the server-side configured cron
//          secret **in full** is authorized, and so is a session request from a profile holding
//          Manager_Role (`manager` or `super_admin`)
// - 12.10  every other request is answered HTTP 403, sends zero messages, and creates zero
//          Communication_Record rows
//
// **The 403 is the first thing that happens.** Nothing about the request body, no settings row, no
// candidate case, and no provider is touched before this resolves. The zero-sends and zero-rows
// half of Requirement 12.10 is therefore structural rather than a promise: the caller
// (`handleSchedulerRequest` in `./run`) returns this module's response and never reaches the batch.
//
// ---------------------------------------------------------------------------------------------
// FULL-STRING EQUALITY, AND WHY IT IS SPELLED OUT
// ---------------------------------------------------------------------------------------------
// `bearerTokenMatches` compares the entire `Authorization` header value against the entire string
// `Bearer ${CRON_SECRET}`. It does not call `startsWith`, it does not `split(' ')` and read
// element 1, and it does not trim. A token that is a prefix of the secret, a token that is a
// suffix of it, a token carrying trailing whitespace, and a token with a doubled space after
// `Bearer` all produce a different whole string and are all refused. Task 18.1 tests exactly that,
// and a prefix match here would hand the scheduler to anyone who guessed the first character.
//
// The comparison runs in constant time with respect to the secret's content: the length check
// leaks only the length, and the loop touches every character whatever the first mismatch was, so
// a caller cannot recover the secret one character at a time from response timing.
//
// An absent or empty configured secret authorizes nobody. Otherwise a deployment that forgot to
// set `CRON_SECRET` would authorize `Authorization: Bearer ` — the exact request an attacker sends
// first.
//
// ---------------------------------------------------------------------------------------------
// EVERY SESSION FAILURE IS A 403, NOT A 401 AND NOT A 503
// ---------------------------------------------------------------------------------------------
// `POST /api/renewals/sms/scheduler` answers a missing session with 401 and an unconfigured
// Supabase with 503. Requirement 12.10 does not: a request that presents "neither a bearer token
// equal to a configured cron secret value nor a session from a profile holding Manager_Role" is
// answered 403, and a request with no session presents neither. So an unconfigured Supabase client,
// an absent session, an unreadable `profiles` row, an unrecognized role, and an Agent_Role session
// all resolve to the same refusal here. That is also the safer direction: the endpoint refuses
// unless Manager_Role is positively proven, and no environment fault can turn a refusal into a run.
//
// The session read is deliberately reached through a dynamic import of `@/lib/supabase/server`,
// which is what `POST /api/renewals/sms/scheduler` does. `next/headers` is loaded only on the
// session path, so a cron request never touches it and a unit test can drive the 403 paths with a
// plain `new Request(...)` outside any Next request scope — `cookies()` throwing there is caught
// and read as "no session", which is the correct answer.

import { createClient as createServiceRoleSupabase, type SupabaseClient } from '@supabase/supabase-js';

import { APP_ROLES, canManageRenewals } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** The cron secret variable, already used by `POST /api/renewals/sms/scheduler` (design). */
export const CRON_SECRET_ENV = 'CRON_SECRET';

/** The Supabase project URL the service-role client connects to. */
export const SUPABASE_URL_ENV = 'NEXT_PUBLIC_SUPABASE_URL';

/** The service-role credential, `SUPABASE_SECRET_KEY` first and the older name as a fallback. */
export const SERVICE_ROLE_KEY_ENV_ORDER = [
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

/** Stated for every refusal, naming neither the secret nor whether a session existed. */
export const UNAUTHORIZED_MESSAGE =
  'This request was not authorized. Send the scheduler cron secret, or sign in as a manager.';

/** Stated when the service-role credentials are absent, so no batch client can be built. */
export const SERVICE_ROLE_UNCONFIGURED_MESSAGE =
  'Server database credentials are not configured. Nothing was sent and nothing was written.';

// ---------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------

/** The authorized caller: the cron secret, or a Manager_Role session (Requirement 12.9). */
export type SchedulerActor =
  | { kind: 'cron'; profileId: null; role: null }
  | { kind: 'session'; profileId: string; role: AppRole };

/** What a session resolver reports: the signed-in profile, or `null` for no usable session. */
export interface SchedulerSession {
  profileId: string;
  /** `null` where the stored role is absent or is not one `APP_ROLES` names. */
  role: AppRole | null;
}

/** The session seam, so a test drives the manager and `super_admin` paths with no cookies. */
export type SchedulerSessionResolver = () => Promise<SchedulerSession | null>;

export interface SchedulerAuthorizationOptions {
  /** The configured cron secret. Absent reads `process.env.CRON_SECRET`. */
  cronSecret?: string | null;
  /** The session reader. Absent uses the cookie-bound server client. */
  resolveSession?: SchedulerSessionResolver;
}

/** The authorized caller, or the response that ends the request with zero sends and zero rows. */
export type SchedulerAuthorization =
  | { ok: true; actor: SchedulerActor }
  | { ok: false; response: Response };

// ---------------------------------------------------------------------------
// Full-string bearer equality (Requirement 12.9)
// ---------------------------------------------------------------------------

/**
 * Equal-length, every-character comparison. Returns false for differing lengths, which leaks the
 * length and nothing else, and otherwise touches every character so the first mismatch's position
 * does not change the running time.
 */
function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * True only where the whole `Authorization` header value equals the whole string
 * `Bearer ${secret}` (Requirement 12.9).
 *
 * No prefix match, no suffix match, no trimming, no case folding, and no tolerance of extra
 * whitespace. An absent or empty configured secret matches nothing at all.
 */
export function bearerTokenMatches(
  authorizationHeader: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (typeof authorizationHeader !== 'string' || typeof secret !== 'string') return false;
  if (secret.length === 0) return false;
  return constantTimeEquals(authorizationHeader, `Bearer ${secret}`);
}

/** The configured cron secret, or `null` where it is unset or blank. */
export function configuredCronSecret(): string | null {
  const value = process.env[CRON_SECRET_ENV];
  if (typeof value !== 'string') return null;
  return value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// The session path (Requirement 12.9, Manager_Role)
// ---------------------------------------------------------------------------

/** The stored role, or `null` where it is absent or not a role `APP_ROLES` names. */
export function readSchedulerRole(role: unknown): AppRole | null {
  return APP_ROLES.includes(role as AppRole) ? (role as AppRole) : null;
}

/**
 * The signed-in profile read through the cookie-bound server client, or `null`.
 *
 * Never throws: an unconfigured Supabase, a `cookies()` call outside a request scope, an absent
 * session, and an unreadable `profiles` row all resolve to `null`, which the caller answers 403.
 */
export async function resolveSessionProfile(): Promise<SchedulerSession | null> {
  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    if (supabase === null) return null;

    const { data: userData } = await supabase.auth.getUser();
    const user = userData?.user;
    if (!user) return null;

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (error) return null;

    return { profileId: user.id, role: readSchedulerRole(profile?.role) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** The HTTP 403 of Requirement 12.10: zero sends, zero rows, no detail about why. */
export function schedulerForbidden(): Response {
  return Response.json({ error: UNAUTHORIZED_MESSAGE }, { status: 403 });
}

/**
 * The authorized caller, or the 403 (Requirements 12.9, 12.10).
 *
 * The cron secret is checked first and short-circuits, so a valid cron request performs no
 * database read at all. `super_admin` is accepted wherever `manager` is, through
 * `isBroadManagerRole`.
 */
export async function authorizeSchedulerRequest(
  request: Request,
  options: SchedulerAuthorizationOptions = {},
): Promise<SchedulerAuthorization> {
  const secret = options.cronSecret === undefined ? configuredCronSecret() : options.cronSecret;
  const header = request.headers.get('authorization');

  if (bearerTokenMatches(header, secret)) {
    return { ok: true, actor: { kind: 'cron', profileId: null, role: null } };
  }

  const resolve = options.resolveSession ?? resolveSessionProfile;
  const session = await resolve();
  if (session === null || session.role === null || !canManageRenewals(session.role)) {
    return { ok: false, response: schedulerForbidden() };
  }

  return {
    ok: true,
    actor: { kind: 'session', profileId: session.profileId, role: session.role },
  };
}

// ---------------------------------------------------------------------------
// The service-role client for the batch work
// ---------------------------------------------------------------------------

/**
 * The service-role Supabase client, or `null` where the credentials are absent.
 *
 * The batch needs it for two separate reasons. It reads and writes across every case rather than
 * the caller's own rows, and `public.cancellation_retry_communication` — the only update path the
 * Communication_Record immutability trigger admits — accepts Manager_Role, the service role, and
 * nothing else. Under any other client the reserve and the provider call would still happen and
 * the recording step would fail, leaving a row reading `Sent`, attempt 1, no provider id. So this
 * client, not the caller's session client, is what is handed to `sendCommunication`.
 */
export function createSchedulerServiceClient(): SupabaseClient | null {
  const url = process.env[SUPABASE_URL_ENV];
  if (typeof url !== 'string' || url.length === 0) return null;

  let key: string | null = null;
  for (const name of SERVICE_ROLE_KEY_ENV_ORDER) {
    const candidate = process.env[name];
    if (typeof candidate === 'string' && candidate.length > 0) {
      key = candidate;
      break;
    }
  }
  if (key === null) return null;

  return createServiceRoleSupabase(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The 503 for absent service-role credentials: nothing was sent and nothing was written. */
export function serviceRoleUnconfigured(): Response {
  return Response.json({ error: SERVICE_ROLE_UNCONFIGURED_MESSAGE }, { status: 503 });
}

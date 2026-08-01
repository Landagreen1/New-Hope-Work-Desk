// src/features/time-attendance/server/api-actor.ts
// Who is calling, resolved once per request, before any attendance data is read.
//
// Every Time & Attendance route opens with this. It is the repository's existing
// route preamble — `createClient()`, 503 when Supabase is unconfigured,
// `getUser()`, 401 when there is no session, then the caller's own `profiles`
// row for the role — written once instead of once per route, so no endpoint can
// forget a step or answer a missing session with a 500.
//
// ## Authorise before touching data
//
// The only read this performs is the caller's own `profiles` row, which is the
// authorisation read itself. Nothing about the request — no date, no filter, no
// profile id from the query string — is used before the actor exists. Scope is
// then resolved inside the service through `visibleProfileIds`, which is the
// single place a read decides whose data it may touch. A route that read the
// range first and checked the role afterwards would have already touched data it
// might not be allowed to.
//
// ## Why a resolution object rather than a thrown error
//
// The two early exits are responses, not failures: 503 and 401 are the correct
// answers to a well-formed request, and neither has a `code` for a screen to
// branch on. Returning them keeps the route body a straight line — resolve,
// return the response if there is one, otherwise read — and keeps `try` around
// the part that can actually throw.
//
// Requirements: 21.1 (an employee sees only their own data), 21.2 (an
// administrator sees the employees they may review), 21.10 (the rule is enforced
// at the API layer as well as in row level security), 21.15 (a call outside the
// permitted set is an authorisation failure that changes nothing).

import type { SupabaseClient } from '@supabase/supabase-js';

import { APP_ROLES } from '@/lib/permissions';
import { createClient } from '@/lib/supabase/server';
import type { AppRole } from '@/lib/types';

import { failed, unauthenticated, unauthorised, unconfigured } from './api-response';
import { visibleProfileIds, type Actor } from './visibility';

/** Stated when a signed-in user carries no role the module recognises. */
export const NO_ROLE_MESSAGE =
  'Your profile has no role assigned, so attendance data cannot be read. Ask an administrator to set your role.';

/** Stated when the caller's own profile row could not be read at all. */
export const PROFILE_UNREADABLE_MESSAGE =
  'Your profile could not be read, so this request could not be authorised. Retrying may succeed.';

/**
 * Stated when a request names an employee the caller may not see.
 *
 * Says what was refused rather than whether the employee exists, so a refusal
 * cannot be used to enumerate the roster.
 */
export const NOT_VISIBLE_MESSAGE =
  'That request names an employee outside your visibility.';

/**
 * The signed-in caller and the client to read as, or the response to send.
 *
 * The client is the cookie-bound server client, so every read the services then
 * issue runs under the caller's own row level security. Passing it down rather
 * than letting each service build its own is what keeps the API-layer check and
 * the policy check looking at the same identity.
 */
export type ActorResolution =
  | { ok: true; actor: Actor; client: SupabaseClient }
  | { ok: false; response: Response };

/**
 * The stored role, or null when it is absent or not one this module knows.
 *
 * Null rather than a default: reading an unrecognised role as `agent` would
 * grant self-scope to a row whose role nobody can explain, and reading it as an
 * administrator would be worse. A role the module cannot name is answered as an
 * authorisation failure.
 */
export function readActorRole(role: unknown): AppRole | null {
  return APP_ROLES.includes(role as AppRole) ? (role as AppRole) : null;
}

/**
 * The caller, or the response that ends the request.
 *
 * Requirements: 21.10, 21.15
 */
export async function resolveActor(): Promise<ActorResolution> {
  const client = await createClient();
  if (!client) return { ok: false, response: unconfigured() };

  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return { ok: false, response: unauthenticated() };

  const { data: profile, error } = await client
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  // A failed read and a missing role are different answers. Row level security
  // lets every user read their own row, so an error here is a fault the caller
  // can retry, while a missing role is a configuration problem only an
  // administrator can fix. Reporting both as a refusal would send the user to
  // ask for a role they already have.
  if (error) return { ok: false, response: failed('read_failed', PROFILE_UNREADABLE_MESSAGE) };

  const role = readActorRole(profile?.role);
  if (role === null) {
    return { ok: false, response: unauthorised('not_authorised', NO_ROLE_MESSAGE) };
  }

  return { ok: true, actor: { id: user.id, role }, client };
}

/**
 * The refusal for a query naming employees the caller may not see, or null when
 * every named employee is in scope.
 *
 * The services already narrow: a profile filter is intersected with the caller's
 * scope, so an out-of-scope id cannot widen a read whether this runs or not.
 * What this adds is the refusal Requirement 21, criterion 15 asks for. Answering
 * `?profile_id=<somebody-else>` with an empty page is not wrong about the data
 * and is wrong about the request: the caller reads it as "that employee has no
 * records" when the truth is "you may not ask".
 *
 * Scope still comes from `visibleProfileIds` and nowhere else, so this is the
 * same decision the service will make rather than a second copy of it.
 *
 * Requirements: 21.1, 21.2, 21.15
 */
export async function refuseInvisibleProfiles(
  actor: Actor,
  profileIds: readonly string[] | undefined,
): Promise<Response | null> {
  if (profileIds === undefined || profileIds.length === 0) return null;

  const scope = await visibleProfileIds(actor);
  if (scope === 'all') return null;

  const refused = profileIds.some((profileId) => !scope.includes(profileId));
  return refused ? unauthorised('not_visible', NOT_VISIBLE_MESSAGE) : null;
}

/**
 * Who is calling, and may they send.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirement 11.
 *
 * Modelled on `src/features/time-attendance/server/api-actor.ts`: a discriminated result
 * carrying the cookie-bound client, so every read a route then issues runs under the
 * caller's own row level security rather than under a client the route built for itself.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';

import { MESSAGES, fail } from './api';

export interface SubmissionActor {
  id: string;
  role: string;
  /** Requirement 11.5: read from data, never from a hardcoded identifier. */
  canSend: boolean;
}

export type ActorResolution =
  | { ok: true; actor: SubmissionActor; client: SupabaseClient }
  | { ok: false; response: Response };

/** The signed-in caller, or the response that ends the request. */
export async function resolveSubmissionActor(): Promise<ActorResolution> {
  const client = await createClient();
  if (!client) return { ok: false, response: fail('unconfigured', MESSAGES.unconfigured) };

  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return { ok: false, response: fail('unauthenticated', MESSAGES.unauthenticated) };

  const { data: profile, error } = await client
    .from('profiles')
    .select('role, is_active, can_send_carrier_submissions')
    .eq('id', user.id)
    .maybeSingle();

  // A failed read and a missing profile are different answers. Every user may read their
  // own row under RLS, so an error here is a fault worth retrying, while a missing row is
  // a configuration problem retrying will never fix.
  if (error) {
    return { ok: false, response: fail('read_failed', 'Could not read your profile.') };
  }
  if (!profile || profile.is_active === false) {
    return { ok: false, response: fail('not_authorised', 'Your account is not active.') };
  }

  return {
    ok: true,
    client,
    actor: {
      id: user.id,
      role: String(profile.role ?? ''),
      canSend: profile.can_send_carrier_submissions === true,
    },
  };
}

/**
 * The same, but refusing anyone who may not send.
 *
 * Viewing history is open to anyone who may view the opportunity (Requirement 11.2), so
 * the sender check is a separate step rather than folded into resolution.
 */
export async function resolveSender(): Promise<ActorResolution> {
  const resolved = await resolveSubmissionActor();
  if (!resolved.ok) return resolved;
  if (!resolved.actor.canSend) {
    return { ok: false, response: fail('not_a_sender', MESSAGES.notASender) };
  }
  return resolved;
}

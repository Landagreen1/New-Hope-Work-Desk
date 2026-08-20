/**
 * The service-role client, for the writes a browser session must never be able to forge.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirements 7, 10, 12.
 *
 * `carrier_submissions` has a SELECT policy and no INSERT or UPDATE policy at all, and
 * `user_email_connections` hides its credential column from `authenticated` by column
 * grant. Both are written here, through the service role, because the send route owns the
 * whole reserve → send → record lifecycle and a client that could insert its own row
 * could claim a submission was sent that never was.
 *
 * Named after `createSchedulerServiceClient` in the cancellations scheduler, which solves
 * the same problem the same way. The env-var order is identical, including the legacy
 * fallback.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_URL_ENV = 'NEXT_PUBLIC_SUPABASE_URL';
export const SERVICE_ROLE_KEY_ENV_ORDER = [
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

function readEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Null when unconfigured, so the caller answers 503 rather than throwing. */
export function createSubmissionServiceClient(): SupabaseClient | null {
  const url = readEnv(SUPABASE_URL_ENV);
  if (!url) return null;

  let secret: string | null = null;
  for (const name of SERVICE_ROLE_KEY_ENV_ORDER) {
    secret = readEnv(name);
    if (secret) break;
  }
  if (!secret) return null;

  return createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

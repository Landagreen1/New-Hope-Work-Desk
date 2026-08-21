/**
 * The mailbox connection lifecycle: store, read, refresh, disconnect.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirements 1, 12.
 *
 * Every function here runs server-side only. Tokens are sealed before they reach the
 * database and opened only in this process; nothing in this module returns plaintext
 * credentials to a caller that could serialise them into a response.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { open, seal } from '@/lib/crypto/secret-box';
import {
  getConfig,
  refreshAccessToken,
  type MicrosoftConfig,
  type TokenSet,
} from '@/lib/microsoft-mail';

import type { EmailConnection } from '../types';

const TABLE = 'user_email_connections';

/**
 * Refresh this far ahead of expiry.
 *
 * A token that expires mid-request fails the send after the draft has been created,
 * leaving a draft in the sender's mailbox and a reserved row in the database. Two minutes
 * covers a slow upload session without refreshing on every call.
 */
const REFRESH_MARGIN_MS = 120_000;

/** What the envelope holds. Never leaves this module in this shape. */
interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  obtained_at: string;
}

/** The columns safe to hand to a client. Deliberately excludes the ciphertext. */
const PUBLIC_COLUMNS =
  'id, profile_id, provider, email_address, provider_account_id, provider_tenant_id, token_expires_at, scopes, status, last_error, connected_at, updated_at';

export async function readConnection(
  client: SupabaseClient,
  profileId: string,
): Promise<EmailConnection | null> {
  const { data, error } = await client
    .from(TABLE)
    .select(PUBLIC_COLUMNS)
    .eq('profile_id', profileId)
    .eq('provider', 'microsoft')
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as EmailConnection;
}

/**
 * Creates or replaces the connection for a profile.
 *
 * An upsert rather than an insert because `unique (profile_id, provider)` makes
 * reconnecting the same mailbox a replacement, not a second row — and because a user who
 * reconnects should not have to disconnect first.
 */
export async function storeConnection(input: {
  service: SupabaseClient;
  profileId: string;
  emailAddress: string;
  accountId: string;
  tenantId: string | null;
  tokens: TokenSet;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const credentials: StoredCredentials = {
    access_token: input.tokens.accessToken,
    refresh_token: input.tokens.refreshToken,
    obtained_at: new Date().toISOString(),
  };

  let envelope: string;
  try {
    envelope = seal(JSON.stringify(credentials));
  } catch (err) {
    // The encryption key is missing or malformed. Say so without quoting anything.
    return { ok: false, reason: err instanceof Error ? err.message : 'Could not encrypt the credentials.' };
  }

  const { error } = await input.service.from(TABLE).upsert(
    {
      profile_id: input.profileId,
      provider: 'microsoft',
      email_address: input.emailAddress,
      provider_account_id: input.accountId,
      provider_tenant_id: input.tenantId,
      encrypted_access_credentials: envelope,
      token_expires_at: input.tokens.expiresAt,
      scopes: input.tokens.scopes,
      status: 'connected',
      last_error: null,
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'profile_id,provider' },
  );

  if (error) return { ok: false, reason: 'Could not save the mailbox connection.' };
  return { ok: true };
}

export async function deleteConnection(
  service: SupabaseClient,
  profileId: string,
): Promise<boolean> {
  // Requirement 1.10: the credentials go, the submission history stays. The foreign key
  // on carrier_submissions.email_connection_id is ON DELETE SET NULL for exactly this.
  const { error } = await service
    .from(TABLE)
    .delete()
    .eq('profile_id', profileId)
    .eq('provider', 'microsoft');
  return !error;
}

export type SendableToken =
  | { ok: true; accessToken: string; emailAddress: string; connectionId: string }
  | { ok: false; code: 'no_connection' | 'needs_reconnect' | 'unconfigured' | 'read_failed'; reason: string };

/**
 * A valid access token for this sender, refreshing first when it is close to expiry.
 *
 * Reads through the service client because the ciphertext column is not selectable by
 * `authenticated` — that is the point of the column grant, and this is the one place
 * allowed to look past it.
 */
export async function getSendableToken(input: {
  service: SupabaseClient;
  profileId: string;
  config?: MicrosoftConfig | null;
  now?: () => number;
  refresh?: typeof refreshAccessToken;
}): Promise<SendableToken> {
  const config = input.config ?? getConfig();
  if (!config) {
    return { ok: false, code: 'unconfigured', reason: 'Microsoft sending is not configured.' };
  }

  const { data, error } = await input.service
    .from(TABLE)
    .select(`${PUBLIC_COLUMNS}, encrypted_access_credentials`)
    .eq('profile_id', input.profileId)
    .eq('provider', 'microsoft')
    .maybeSingle();

  if (error) return { ok: false, code: 'read_failed', reason: 'Could not read the mailbox connection.' };
  if (!data) return { ok: false, code: 'no_connection', reason: 'No mailbox is connected.' };

  const row = data as unknown as EmailConnection & { encrypted_access_credentials: string };

  if (row.status === 'needs_reconnect') {
    return { ok: false, code: 'needs_reconnect', reason: row.last_error ?? 'The connection needs to be re-authorised.' };
  }

  let credentials: StoredCredentials;
  try {
    credentials = JSON.parse(open(row.encrypted_access_credentials)) as StoredCredentials;
  } catch {
    // Wrong key, rotated key, or tampering. All three mean the same thing to the user:
    // reconnect. Marking the row keeps the settings screen honest.
    await markNeedsReconnect(
      input.service,
      row.id,
      'The stored credentials could not be decrypted. Reconnect the mailbox.',
    );
    return {
      ok: false,
      code: 'needs_reconnect',
      reason: 'The stored credentials could not be decrypted. Reconnect the mailbox.',
    };
  }

  const now = (input.now ?? Date.now)();
  const expiresAt = row.token_expires_at ? Date.parse(row.token_expires_at) : 0;
  const stillValid = Number.isFinite(expiresAt) && expiresAt - now > REFRESH_MARGIN_MS;

  if (stillValid && credentials.access_token) {
    return {
      ok: true,
      accessToken: credentials.access_token,
      emailAddress: row.email_address,
      connectionId: row.id,
    };
  }

  if (!credentials.refresh_token) {
    await markNeedsReconnect(input.service, row.id, 'No refresh token is stored.');
    return { ok: false, code: 'needs_reconnect', reason: 'No refresh token is stored. Reconnect the mailbox.' };
  }

  const refreshed = await (input.refresh ?? refreshAccessToken)({
    config,
    refreshToken: credentials.refresh_token,
  });

  if (!refreshed.ok) {
    if (refreshed.needsReconnect) {
      await markNeedsReconnect(input.service, row.id, refreshed.reason);
      return { ok: false, code: 'needs_reconnect', reason: refreshed.reason };
    }
    // A transient failure must NOT mark the connection broken — that would send the user
    // to re-authorise a connection that is fine.
    return { ok: false, code: 'read_failed', reason: refreshed.reason };
  }

  // Microsoft may or may not rotate the refresh token. Keep the old one when it does not.
  const nextCredentials: StoredCredentials = {
    access_token: refreshed.tokens.accessToken,
    refresh_token: refreshed.tokens.refreshToken || credentials.refresh_token,
    obtained_at: new Date(now).toISOString(),
  };

  const { error: updateError } = await input.service
    .from(TABLE)
    .update({
      encrypted_access_credentials: seal(JSON.stringify(nextCredentials)),
      token_expires_at: refreshed.tokens.expiresAt,
      status: 'connected',
      last_error: null,
    })
    .eq('id', row.id);

  // A failed write is not fatal for THIS send — the token in hand is valid. The next call
  // simply refreshes again.
  if (updateError) {
    return {
      ok: true,
      accessToken: refreshed.tokens.accessToken,
      emailAddress: row.email_address,
      connectionId: row.id,
    };
  }

  return {
    ok: true,
    accessToken: refreshed.tokens.accessToken,
    emailAddress: row.email_address,
    connectionId: row.id,
  };
}

export async function markNeedsReconnect(
  service: SupabaseClient,
  connectionId: string,
  reason: string,
): Promise<void> {
  await service
    .from(TABLE)
    .update({ status: 'needs_reconnect', last_error: reason.slice(0, 500) })
    .eq('id', connectionId);
}

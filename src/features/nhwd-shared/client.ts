// src/features/nhwd-shared/client.ts
// Shared browser Supabase client for platform modules.
// If the Work Desk already exports a browser client (check src/lib/),
// delete this file and re-point the imports in cs-intake/api.ts and
// renewals/api.ts to your existing helper instead.
'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
    );
  }
  return _client;
}

export type AppRole = 'agent' | 'customer_service' | 'manager';

export interface ProfileLite {
  id: string;
  display_name: string;
  initials: string;
  role: AppRole;
  is_active: boolean;
}

export async function getCurrentProfile(): Promise<ProfileLite | null> {
  const supabase = getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return null;
  const { data } = await supabase
    .from('profiles')
    .select('id, display_name, initials, role, is_active')
    .eq('id', auth.user.id)
    .single();
  return (data as ProfileLite) ?? null;
}

export async function listActiveAgents(): Promise<ProfileLite[]> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('profiles')
    .select('id, display_name, initials, role, is_active')
    .eq('is_active', true)
    .in('role', ['agent', 'manager'])
    .order('display_name');
  return (data as ProfileLite[]) ?? [];
}

'use client';

import type { SupabaseClient } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/client';

import type { ProfileLite } from './types';

export type { AppRole, ProfileLite } from './types';

let browserClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!browserClient) browserClient = createClient();
  return browserClient;
}

export async function listActiveAgents(): Promise<ProfileLite[]> {
  const { data, error } = await getSupabase()
    .from('profiles')
    .select('id,display_name,initials,role,is_active')
    .eq('is_active', true)
    .eq('role', 'agent')
    .order('display_name');

  if (error) throw new Error(`Unable to load active Sales Agents: ${error.message}`);
  return (data ?? []) as ProfileLite[];
}

export async function listRenewalAssignees(): Promise<ProfileLite[]> {
  const { data, error } = await getSupabase()
    .from('profiles')
    .select('id,display_name,initials,role,is_active')
    .eq('is_active', true)
    .in('role', ['agent', 'customer_service'])
    .order('role')
    .order('display_name');

  if (error) throw new Error(`Unable to load renewal assignees: ${error.message}`);
  return (data ?? []) as ProfileLite[];
}

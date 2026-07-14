'use client';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';

let sharedClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!sharedClient) sharedClient = createClient();
  return sharedClient;
}

export type AppRole = 'agent' | 'manager' | 'customer_service';

export interface ProfileLite {
  id: string;
  display_name: string;
  initials: string;
  role: AppRole;
  is_active: boolean;
}

export async function getCurrentProfile(): Promise<ProfileLite | null> {
  const supabase = getSupabase();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, initials, role, is_active')
    .eq('id', auth.user.id)
    .single();

  if (error || !data) return null;
  return data as ProfileLite;
}

export async function listActiveAgents(): Promise<ProfileLite[]> {
  const { data, error } = await getSupabase()
    .from('profiles')
    .select('id, display_name, initials, role, is_active')
    .eq('is_active', true)
    .eq('role', 'agent')
    .order('display_name');

  if (error) throw error;
  return (data as ProfileLite[]) ?? [];
}

export async function listRenewalAssignees(): Promise<ProfileLite[]> {
  const { data, error } = await getSupabase()
    .from('profiles')
    .select('id, display_name, initials, role, is_active')
    .eq('is_active', true)
    .in('role', ['agent', 'customer_service'])
    .order('role')
    .order('display_name');

  if (error) throw error;
  return (data as ProfileLite[]) ?? [];
}

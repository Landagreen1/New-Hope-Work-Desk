"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import type { AppRole, ProfileLite } from './types';

let browserClient: SupabaseClient | null = null;

/**
 * Return the same cookie-aware Supabase browser client used by Work Desk.
 *
 * The main application authenticates with @supabase/ssr. Creating a second
 * client directly with @supabase/supabase-js prevents the feature modules
 * from seeing the existing cookie-backed session. Reusing the platform helper
 * keeps Quote Intake and Renewals on the same authenticated session.
 */
export function getSupabase(): SupabaseClient {
  if (!browserClient) {
    browserClient = createClient();
  }

  return browserClient;
}

export type { AppRole, ProfileLite } from './types';

export async function getCurrentProfile(): Promise<ProfileLite | null> {
  const supabase = getSupabase();

  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return null;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id,display_name,initials,role,is_active")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data as ProfileLite;
}

export async function listActiveAgents(): Promise<ProfileLite[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("profiles")
    .select("id,display_name,initials,role,is_active")
    .eq("is_active", true)
    .in("role", ["agent", "manager"])
    .order("display_name");

  if (error) {
    throw new Error(`Unable to load active agents: ${error.message}`);
  }

  return (data ?? []) as ProfileLite[];
}

/**
 * Return the active employees who can be assigned renewal records.
 *
 * Managers control assignment but are not included as renewal assignees.
 * Renewal work may be assigned to either a Sales Agent or Customer Service.
 */
export async function listRenewalAssignees(): Promise<ProfileLite[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("profiles")
    .select("id,display_name,initials,role,is_active")
    .eq("is_active", true)
    .in("role", ["agent", "customer_service"])
    .order("role")
    .order("display_name");

  if (error) {
    throw new Error(`Unable to load renewal assignees: ${error.message}`);
  }

  return (data ?? []) as ProfileLite[];
}

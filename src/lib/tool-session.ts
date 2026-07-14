import { redirect } from 'next/navigation';

import type { AppRole, ProfileLite } from '@/features/nhwd-shared/types';
import { createClient } from '@/lib/supabase/server';

export async function requireToolProfile(allowedRoles: readonly AppRole[]): Promise<ProfileLite> {
  const supabase = await createClient();
  if (!supabase) redirect('/setup');

  const { data: claimsData } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (!userId) redirect('/login');

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id,display_name,initials,role,is_active,must_change_password')
    .eq('id', userId)
    .single();

  if (error || !profile || !profile.is_active) redirect('/login');
  if (profile.must_change_password) redirect('/change-password');

  const role = profile.role as AppRole;
  if (!allowedRoles.includes(role)) redirect('/');

  return {
    id: profile.id,
    display_name: profile.display_name,
    initials: profile.initials,
    role,
    is_active: profile.is_active,
  };
}

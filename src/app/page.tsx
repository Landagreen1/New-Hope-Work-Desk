export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';

import { OperationsDock } from '@/components/operations-dock';
import { WorkDeskApp } from '@/components/work-desk-app';
import { loadDashboardData } from '@/lib/dashboard-data';
import { createClient } from '@/lib/supabase/server';
import type { SessionProfile } from '@/lib/types';

export default async function Home() {
  const supabase = await createClient();
  if (!supabase) redirect('/setup');

  const { data: claimsData } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (!userId) redirect('/login');

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id,username,display_name,initials,role,must_change_password,is_active')
    .eq('id', userId)
    .single();

  if (profileError || !profile || !profile.is_active) redirect('/login');
  if (profile.must_change_password) redirect('/change-password');

  const initialData = await loadDashboardData(supabase);
  const sessionProfile: SessionProfile = {
    id: profile.id,
    username: profile.username,
    displayName: profile.display_name,
    initials: profile.initials,
    role: profile.role,
    mustChangePassword: profile.must_change_password,
  };

  return (
    <>
      <WorkDeskApp sessionProfile={sessionProfile} initialData={initialData} />
      <OperationsDock role={sessionProfile.role} />
    </>
  );
}

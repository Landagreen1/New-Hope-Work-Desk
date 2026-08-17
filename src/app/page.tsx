export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';

import type { DeskSection } from '@/components/app-sidebar';
import { RoleWorkspace } from '@/components/role-workspace';
import { loadDashboardData } from '@/lib/dashboard-data';
import { createClient } from '@/lib/supabase/server';
import type { SessionProfile } from '@/lib/types';

/**
 * `?desk=<section>` opens My Desk on a named section.
 *
 * Read on the server and handed to the workspace as an initial value, rather than
 * read from the client with `useSearchParams`. Navigation is React state here, so a
 * one-time initial value is exactly what this is, and resolving it on the server
 * avoids a first render that shows the wrong section.
 *
 * Its only caller is the retired `/tools/cs-intake/queue` route, which redirects
 * here so an old bookmark still lands on the intake queue.
 */
const DESK_SECTIONS = ['work', 'intake', 'pricing', 'outcomes', 'workload'] as const;

function deskSectionFrom(value: string | string[] | undefined): DeskSection | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return DESK_SECTIONS.find((section) => section === candidate);
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  const initialDeskSection = deskSectionFrom((await searchParams).desk);

  return (
    <RoleWorkspace
      sessionProfile={sessionProfile}
      initialData={initialData}
      initialDeskSection={initialDeskSection}
    />
  );
}

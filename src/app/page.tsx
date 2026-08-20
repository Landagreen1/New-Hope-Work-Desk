export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';

import type { DeskSection, ModuleId, SubNavId } from '@/components/app-sidebar';
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

const MODULE_IDS = [
  'sales',
  'customer_service',
  'commercial',
  'specialty_quotes',
  'renewals',
  'time_attendance',
  'user_admin',
] as const;

/**
 * `?module=&sub=` opens the shell on a named screen.
 *
 * Added for the Specialty Quotes workspace, which is a route of its own: coming back
 * from a quote has to land on the screen the reader left, and the shell's navigation is
 * React state, so a link needs a way to name it.
 *
 * `sub` is not validated against the `SubNavId` union on purpose. `resolveNavigationForRole`
 * already resolves an identifier this role is not offered — and a retired one — to the
 * right replacement, so validating here would be a second, weaker copy of that rule. A
 * nonsense value lands on the module's first screen rather than on an error.
 */
function navigationFrom(
  moduleValue: string | string[] | undefined,
  subValue: string | string[] | undefined,
): { module: ModuleId; subNav: SubNavId } | undefined {
  const moduleCandidate = Array.isArray(moduleValue) ? moduleValue[0] : moduleValue;
  // Not named `module`: that identifier is reserved in a Next.js module scope.
  const moduleId = MODULE_IDS.find((known) => known === moduleCandidate);
  if (!moduleId) return undefined;

  const subCandidate = Array.isArray(subValue) ? subValue[0] : subValue;
  if (!subCandidate) return undefined;

  return { module: moduleId, subNav: subCandidate as SubNavId };
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

  const params = await searchParams;
  const initialDeskSection = deskSectionFrom(params.desk);
  const initialNavigation = navigationFrom(params.module, params.sub);

  return (
    <RoleWorkspace
      sessionProfile={sessionProfile}
      initialData={initialData}
      initialDeskSection={initialDeskSection}
      initialNavigation={initialNavigation}
    />
  );
}

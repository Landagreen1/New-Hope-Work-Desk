export const dynamic = 'force-dynamic';

import { Suspense } from 'react';

import PolicyFollowUpPage from '@/features/renewals/PolicyFollowUpPage';
import { canAccessRenewals } from '@/lib/permissions';
import { requireToolProfile } from '@/lib/tool-session';

export default async function Page() {
  // Requirements 2.5 and 2.9: the role check runs in server-side code before anything renders,
  // so a profile `canAccessRenewals` rejects is redirected here and reads zero renewal rows.
  const profile = await requireToolProfile(canAccessRenewals);
  return (
    <Suspense>
      <PolicyFollowUpPage initialProfile={profile} />
    </Suspense>
  );
}

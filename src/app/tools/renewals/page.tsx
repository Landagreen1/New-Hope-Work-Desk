export const dynamic = 'force-dynamic';

import RenewalsPage from '@/features/renewals/RenewalsPage';
import { canAccessRenewals } from '@/lib/permissions';
import { requireToolProfile } from '@/lib/tool-session';

export default async function Page() {
  const profile = await requireToolProfile(canAccessRenewals);
  return <RenewalsPage initialProfile={profile} />;
}

export const dynamic = 'force-dynamic';

import ToolsHub from '@/features/platform/ToolsHub';
import {
  canAccessCustomerService,
  canAccessRenewals,
  canAccessSales,
} from '@/lib/permissions';
import { requireToolProfile } from '@/lib/tool-session';

export default async function Page() {
  const profile = await requireToolProfile(
    (role) =>
      canAccessSales(role)
      || canAccessCustomerService(role)
      || canAccessRenewals(role),
  );
  return <ToolsHub initialProfile={profile} />;
}

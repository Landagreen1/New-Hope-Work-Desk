export const dynamic = 'force-dynamic';

import RenewalsPage from '@/features/renewals/RenewalsPage';
import { requireToolProfile } from '@/lib/tool-session';

export default async function Page() {
  const profile = await requireToolProfile(['agent', 'manager', 'customer_service']);
  return <RenewalsPage initialProfile={profile} />;
}

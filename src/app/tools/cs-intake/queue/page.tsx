export const dynamic = 'force-dynamic';

import IntakeQueue from '@/features/cs-intake/IntakeQueue';
import { canAccessSalesIntakeQueue } from '@/lib/permissions';
import { requireToolProfile } from '@/lib/tool-session';

export default async function Page() {
  const profile = await requireToolProfile(canAccessSalesIntakeQueue);
  return <IntakeQueue initialProfile={profile} />;
}

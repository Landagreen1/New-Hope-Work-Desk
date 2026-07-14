export const dynamic = 'force-dynamic';

import IntakeQueue from '@/features/cs-intake/IntakeQueue';
import { requireToolProfile } from '@/lib/tool-session';

export default async function Page() {
  const profile = await requireToolProfile(['agent', 'manager']);
  return <IntakeQueue initialProfile={profile} />;
}

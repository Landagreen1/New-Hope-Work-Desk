export const dynamic = 'force-dynamic';

import ToolsHub from '@/features/platform/ToolsHub';
import { requireToolProfile } from '@/lib/tool-session';

export default async function Page() {
  const profile = await requireToolProfile(['agent', 'manager', 'customer_service']);
  return <ToolsHub initialProfile={profile} />;
}

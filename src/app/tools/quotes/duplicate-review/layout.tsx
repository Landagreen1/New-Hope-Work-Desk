import type { ReactNode } from 'react';

import { canManageSales } from '@/lib/permissions';
import { requireToolProfile } from '@/lib/tool-session';

export default async function DuplicateReviewLayout({ children }: { children: ReactNode }) {
  await requireToolProfile(canManageSales);
  return children;
}

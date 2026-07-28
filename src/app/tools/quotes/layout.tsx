import type { ReactNode } from 'react';

import { canAccessSales } from '@/lib/permissions';
import { requireToolProfile } from '@/lib/tool-session';

export default async function QuotesLayout({ children }: { children: ReactNode }) {
  await requireToolProfile(canAccessSales);
  return children;
}

export const dynamic = 'force-dynamic';

import { Suspense } from 'react';

import QuotesListPage from '@/features/quotes/QuotesListPage';
import { requireToolProfile } from '@/lib/tool-session';

function QuotesLoading() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f3f5f9] font-black text-slate-500">
      Loading Quotes...
    </main>
  );
}

export default async function Page() {
  const profile = await requireToolProfile(['agent', 'manager']);
  return (
    <Suspense fallback={<QuotesLoading />}>
      <QuotesListPage initialProfile={profile} />
    </Suspense>
  );
}

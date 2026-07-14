export const dynamic = 'force-dynamic';

import { Suspense } from 'react';

import CsIntakeLanding from '@/features/cs-intake/CsIntakeLanding';
import { requireToolProfile } from '@/lib/tool-session';

function QuoteIntakeLoading() {
  return <main className="grid min-h-screen place-items-center bg-[#f3f5f9] font-black text-slate-500">Loading Quote Intake…</main>;
}

export default async function Page() {
  const profile = await requireToolProfile(['customer_service', 'manager']);
  return (
    <Suspense fallback={<QuoteIntakeLoading />}>
      <CsIntakeLanding initialProfile={profile} />
    </Suspense>
  );
}

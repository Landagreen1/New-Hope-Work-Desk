import { Suspense } from 'react';

import { ui } from '@/features/nhwd-shared/ui';
import { requireToolProfile } from '@/lib/tool-session';

import SpecialtyQuoteClient from './quote-client';

interface PageProps {
  /** Next 16: route params arrive as a promise. */
  params: Promise<{ quoteId: string }>;
}

/**
 * `/specialty-quotes/[quoteId]` — one Specialty Quote's workspace.
 *
 * A real route, which is the point of the redesign. Refreshing keeps the quote open, the
 * back button goes back to the list, a manager can paste the URL to a teammate, and a
 * future alert can deep-link straight to the quote — none of which a side panel held in
 * React state could do.
 *
 * The gate is only "an active employee is signed in". Whether this account may read this
 * particular quote is `specialty_can_view_opportunity()`, decided inside
 * `specialty_opportunity_detail`, and the workspace renders that refusal as its own
 * explained state rather than as an empty screen. Guarding by role here would be the
 * wrong check anyway: specialty access is quoting-team membership.
 */
export default async function SpecialtyQuotePage({ params }: PageProps) {
  const { quoteId } = await params;
  const profile = await requireToolProfile(() => true);

  return (
    <div className="min-h-screen bg-[#f3f5f9] text-slate-950">
      <main className={ui.page}>
        <Suspense fallback={<p className={ui.empty}>Loading the quote…</p>}>
          <SpecialtyQuoteClient quoteId={quoteId} profile={profile} />
        </Suspense>
      </main>
    </div>
  );
}

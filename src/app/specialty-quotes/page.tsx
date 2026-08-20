import { Suspense } from 'react';

import { ui } from '@/features/nhwd-shared/ui';
import { requireToolProfile } from '@/lib/tool-session';

import SpecialtyQuotesListClient from './list-client';

/**
 * `/specialty-quotes` — the routed Specialty Quotes list.
 *
 * The canonical list, and the destination the quote workspace's back link points at.
 * Its whole state lives in the query string, so returning from a quote lands on the
 * same search, view, filters and page the reader left.
 *
 * The gate here is only "an active employee is signed in". Access to Specialty Quotes
 * is membership of a quoting team, which a role cannot answer, and it is enforced where
 * it belongs: `specialty_can_access()` and the RLS policies refuse a non-member inside
 * every RPC the screen calls. What the client renders for such an account is the
 * module's own explanation, not a blank page — the same courtesy message the Work Desk
 * shell shows.
 */
export default async function SpecialtyQuotesPage() {
  const profile = await requireToolProfile(() => true);

  return (
    <Suspense
      fallback={
        <main className={ui.page}>
          <p className={ui.empty}>Loading Specialty Quotes…</p>
        </main>
      }
    >
      <SpecialtyQuotesListClient profile={profile} />
    </Suspense>
  );
}

'use client';

/**
 * The URL half of the quote workspace.
 *
 * Three things live in the query string and nowhere else:
 *
 * - `tab` — which section is showing, so `?tab=carriers` is a link somebody can send.
 * - `carrier` — which carrier's workstream is open, so "what Eastern asked for" is
 *   addressable rather than three clicks in.
 * - `back` — where the back link returns to, carrying the list's own filters.
 *
 * Tab and carrier changes use `replace`, not `push`. Pushing would put every tab the
 * reader glanced at into history, and the back button has one job here: return to the
 * Specialty Quotes list.
 *
 * `back` is read from the URL, which makes it untrusted input. `safeBackHref` refuses
 * anything that is not a same-origin path, so a crafted link cannot turn the back button
 * into a redirect off the Work Desk.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import type { ProfileLite } from '@/features/nhwd-shared/types';
import { safeBackHref } from '@/features/specialty/list-state';
import { parseTab, type WorkspaceTab } from '@/features/specialty/workflow';
import QuoteWorkspace from '@/features/specialty/workspace/QuoteWorkspace';

export default function SpecialtyQuoteClient({
  quoteId,
  profile,
}: {
  quoteId: string;
  profile: ProfileLite;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const tab = parseTab(searchParams.get('tab'));
  const carrierId = searchParams.get('carrier');
  const back = searchParams.get('back');

  const backHref = useMemo(() => safeBackHref(back), [back]);

  /**
   * One writer, one call per navigation.
   *
   * Both parameters move together — opening a carrier sets the tab *and* the carrier —
   * so this takes them together. It used to be two setters, and calling both in the same
   * tick lost one of them: each call rebuilt the query string from the `searchParams` of
   * the render it closed over, `router.replace` does not update that synchronously, and
   * the second write therefore overwrote the first. Every route into a specific carrier
   * landed on the carrier list instead.
   */
  const navigate = useCallback(
    (next: { tab?: WorkspaceTab; carrier?: string | null }) => {
      const params = new URLSearchParams(searchParams.toString());

      if (next.tab !== undefined) {
        // The Overview is the default, so it is left off the URL rather than written
        // as `?tab=overview`.
        if (next.tab === 'overview') params.delete('tab');
        else params.set('tab', next.tab);
      }
      if (next.carrier !== undefined) {
        if (next.carrier === null) params.delete('carrier');
        else params.set('carrier', next.carrier);
      }

      const query = params.toString();
      router.replace(
        query === '' ? `/specialty-quotes/${quoteId}` : `/specialty-quotes/${quoteId}?${query}`,
        { scroll: false },
      );
    },
    [quoteId, router, searchParams],
  );

  return (
    <QuoteWorkspace
      opportunityId={quoteId}
      profile={profile}
      backHref={backHref}
      tab={tab}
      carrierId={carrierId}
      onNavigate={navigate}
    />
  );
}

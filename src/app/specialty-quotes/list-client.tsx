'use client';

/**
 * The routed Specialty Quotes list.
 *
 * Its one job beyond rendering `SpecialtyList` is to keep the URL and the list in step,
 * in both directions:
 *
 * - On arrival the query string seeds the filters, so a refresh, a bookmark or the back
 *   button from a quote all restore the same list.
 * - As the reader filters, the query string is rewritten with `replace` rather than
 *   `push`. Pushing would add a history entry per filter change and Back would crawl
 *   back through them instead of leaving the list.
 *
 * Opening a quote carries the current list URL along as `?back=`, which is what lets the
 * workspace's back link return to this exact list rather than to a default one.
 */

import { AlertCircle } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ModuleShell } from '@/features/nhwd-shared/ModuleShell';
import type { AppRole, ProfileLite } from '@/features/nhwd-shared/types';
import { ui } from '@/features/nhwd-shared/ui';
import { getWorkspaceContext } from '@/features/specialty/api';
import {
  parseListState,
  specialtyListHref,
  specialtyQuoteHref,
  type SpecialtyListMode,
  type SpecialtyListState,
} from '@/features/specialty/list-state';
import SpecialtyList from '@/features/specialty/SpecialtyList';
import { lineLabel } from '@/features/specialty/status';
import type { WorkspaceContext } from '@/features/specialty/types';

const SECTION_SUBTITLES: Record<SpecialtyListMode, string> = {
  work: 'What the team is working, and what needs attention. A quote you are not assigned is still yours to help with.',
  quotes: 'Search every specialty quote, open or closed.',
};

function modeFrom(value: string | null): SpecialtyListMode {
  return value === 'quotes' ? 'quotes' : 'work';
}

export default function SpecialtyQuotesListClient({ profile }: { profile: ProfileLite }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const mode = modeFrom(searchParams.get('section'));

  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  /** What the query string says the list is showing. Keyed on the string itself. */
  const queryString = searchParams.toString();
  const urlState = useMemo(
    () => parseListState(new URLSearchParams(queryString), mode),
    [mode, queryString],
  );

  /**
   * The list URL as the reader has filtered it, for the `?back=` a quote link carries.
   *
   * A ref rather than state: it is read at click time and never rendered, so making it
   * state would re-render the whole list on every filter change for no visible effect.
   * Null until the list first publishes its filters, which is why opening a quote falls
   * back to the URL we arrived on.
   */
  const listHref = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setContext(await getWorkspaceContext());
      setLastUpdated(new Date());
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Specialty Quotes could not be loaded for your account.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleStateChange = useCallback(
    (state: SpecialtyListState) => {
      const href = specialtyListHref(state, mode);
      listHref.current = href;
      router.replace(href, { scroll: false });
    },
    [mode, router],
  );

  const handleOpen = useCallback(
    (opportunityId: string) => {
      router.push(
        specialtyQuoteHref(opportunityId, {
          backTo: listHref.current ?? specialtyListHref(urlState, mode),
        }),
      );
    },
    [mode, router, urlState],
  );

  const subtitle = useMemo(() => {
    if (!context) return 'Trucking and Homeowners quoting, worked as a team.';
    const lines = Array.from(
      new Set(context.lines_of_business.map((route) => route.line_of_business)),
    );
    if (lines.length === 0) {
      return 'You have specialty access but no line of business is routed to your team yet.';
    }
    return `${lines.map(lineLabel).join(' and ')} · ${SECTION_SUBTITLES[mode]}`;
  }, [context, mode]);

  if (loading && !context) {
    return (
      <main className={ui.page}>
        <p className={ui.empty}>Loading Specialty Quotes…</p>
      </main>
    );
  }

  /**
   * No membership, no module.
   *
   * A courtesy message, not the access control: `specialty_can_access()` and the RLS
   * policies refuse the same account at the database, so a direct API call gets nothing
   * either.
   */
  if (error || !context) {
    return (
      <main className={ui.page}>
        <div className={`${ui.error} flex max-w-2xl items-start gap-2`}>
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {error ?? 'Specialty Quotes is not available for your account.'}
            <br />
            <span className="font-semibold">
              Access comes from membership of a quoting team, not from your role. A manager adds
              members under User Administration → Quoting Teams.
            </span>
          </span>
        </div>
      </main>
    );
  }

  return (
    <ModuleShell
      title="Specialty Quotes"
      subtitle={subtitle}
      role={profile.role as AppRole}
      lastUpdated={lastUpdated}
      onRefresh={() => {
        void load();
        setRefreshToken((current) => current + 1);
      }}
    >
      {/* The two destinations, as links rather than component state, so each is a URL
          somebody can bookmark and come back to. */}
      <nav aria-label="Specialty destinations" className="mb-5 flex gap-1 rounded-2xl bg-slate-100 p-1.5">
        {(['work', 'quotes'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-current={mode === option ? 'page' : undefined}
            onClick={() =>
              router.replace(
                option === 'work' ? '/specialty-quotes' : '/specialty-quotes?section=quotes',
                { scroll: false },
              )
            }
            className={`rounded-xl px-4 py-2 text-xs font-black transition ${
              mode === option ? 'bg-[#223f7a] text-white shadow-sm' : 'text-slate-600 hover:bg-white'
            }`}
          >
            {option === 'work' ? 'Team Work' : 'All Quotes'}
          </button>
        ))}
      </nav>

      {context.lines_of_business.length === 0 ? (
        <div className={`${ui.info} mb-5`}>
          You are a member of a quoting team, but no line of business is routed to it yet. A manager
          sets that under User Administration → Quoting Teams.
        </div>
      ) : null}

      <SpecialtyList
        key={mode}
        profileId={profile.id}
        context={context}
        mode={mode}
        onOpen={handleOpen}
        refreshToken={refreshToken}
        initialState={urlState}
        onStateChange={handleStateChange}
      />
    </ModuleShell>
  );
}

'use client';

/**
 * The Specialty Quote workspace.
 *
 * A routed page, not a drawer. An employee opens a quote with a customer on the line
 * and needs the whole case — the application, five carrier submissions, the pricing,
 * the paperwork and the history — and a 640-pixel panel could not hold it. Being a real
 * URL is the other half: Back works, a refresh keeps the quote open, and a manager can
 * send a teammate a link to one carrier's request rather than to the list.
 *
 * WHAT THIS COMPONENT OWNS
 *
 * - One `specialty_opportunity_detail` call. That RPC returns the opportunity, the
 *   carrier markets, the checklist, the information requests, the notes, the documents,
 *   the price presentations, the contributors, the linked intake and the workflow
 *   stages in a single round trip, so opening this page is one query and not a dozen.
 * - One deferred `specialty_activity_timeline` call. The Overview shows the last few
 *   events and the Activity tab shows all of them, so it is fetched once, after the
 *   detail has painted, and shared. Fetching it per tab would be the same data twice.
 * - `run()`, the single mutation wrapper. Every action goes through it, so success,
 *   concurrency refusal and failure are handled in one place and the page always
 *   reflects the server rather than what was optimistically hoped for.
 * - Realtime. Teammates work the same records; a change one of them makes has to arrive
 *   here without a reload. The subscription is a signal to refetch and never a source
 *   of data — the row the server returns has been through the team boundary and a
 *   payload has not.
 *
 * WHAT IT DOES NOT OWN
 *
 * Permissions. `detail.can_edit`, `detail.can_reassign` and `detail.is_manager` are
 * computed by the database from quoting-team membership, and the RPCs re-derive them on
 * every write. There is no `assignee === me` check anywhere in this module: a teammate's
 * quote is one an eligible member may work.
 */

import { AlertTriangle, Loader2, ShieldOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getSupabase } from '../../nhwd-shared/client';
import type { ProfileLite } from '../../nhwd-shared/types';
import { ui } from '../../nhwd-shared/ui';
import {
  AlreadyClaimedError,
  SpecialtyAccessError,
  SpecialtyConflictError,
  SpecialtyNotFoundError,
  getOpportunityDetail,
  getTimeline,
  getWorkspaceContext,
} from '../api';
import SpecialtyLogModal from '../SpecialtyLogModal';
import type { OpportunityDetail, TimelineEntry, WorkspaceContext } from '../types';
import { WORKSPACE_TABS, tabLabel, workflowProgress, type WorkspaceTab } from '../workflow';
import ActivityPanel from './ActivityPanel';
import ApplicationPanel from './ApplicationPanel';
import CarriersPanel from './CarriersPanel';
import DocumentsPanel from './DocumentsPanel';
import OverviewPanel from './OverviewPanel';
import SubmissionsPanel from './SubmissionsPanel';
import QuoteHeader from './QuoteHeader';
import WorkflowProgress from './WorkflowProgress';

/** How many events the Overview's Recent Activity shows. */
const RECENT_ACTIVITY_LIMIT = 8;

export interface QuoteWorkspaceProps {
  opportunityId: string;
  profile: ProfileLite;
  /** Where the back link goes. Carries the list's filters when it has them. */
  backHref: string;
  tab: WorkspaceTab;
  /** Which carrier's workstream is open, from `?carrier=`. */
  carrierId: string | null;
  /**
   * Moves the workspace, writing both parameters at once.
   *
   * Deliberately one call and not two setters: opening a carrier changes the tab and the
   * carrier together, and two separate URL writes in the same tick lose one of each
   * other.
   */
  onNavigate: (next: { tab?: WorkspaceTab; carrier?: string | null }) => void;
}

export default function QuoteWorkspace({
  opportunityId,
  profile,
  backHref,
  tab,
  carrierId,
  onNavigate,
}: QuoteWorkspaceProps) {
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [detail, setDetail] = useState<OpportunityDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<{ kind: 'denied' | 'missing' | 'failed'; message: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  /** Guards a slow earlier response from overwriting a newer one. */
  const requestToken = useRef(0);

  // ── Loading ────────────────────────────────────────────────────────────────

  const loadDetail = useCallback(
    async (silent = false) => {
      const token = ++requestToken.current;
      if (!silent) setLoading(true);
      try {
        const next = await getOpportunityDetail(opportunityId);
        if (token !== requestToken.current) return;
        setDetail(next);
        setFatal(null);
      } catch (caught) {
        if (token !== requestToken.current) return;
        if (caught instanceof SpecialtyAccessError) {
          setFatal({ kind: 'denied', message: caught.message });
        } else if (caught instanceof SpecialtyNotFoundError) {
          setFatal({ kind: 'missing', message: caught.message });
        } else {
          setFatal({
            kind: 'failed',
            message: caught instanceof Error ? caught.message : 'That quote could not be opened.',
          });
        }
      } finally {
        if (token === requestToken.current) setLoading(false);
      }
    },
    [opportunityId],
  );

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  /**
   * The workspace context, for the carrier picker and the teammate list.
   *
   * Deliberately not blocking: the quote paints from `detail` alone, and the only thing
   * this adds is the list of carriers that can be added. A failure here is silent
   * because it is not a reason to refuse to show the quote.
   */
  useEffect(() => {
    let cancelled = false;
    void getWorkspaceContext()
      .then((next) => {
        if (!cancelled) setContext(next);
      })
      .catch(() => {
        /* The Add Carrier picker degrades to empty; nothing else depends on it. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Its own token: a slow earlier timeline must not land on top of a newer one. */
  const timelineToken = useRef(0);

  const loadTimeline = useCallback(async () => {
    const token = ++timelineToken.current;
    setTimelineLoading(true);
    try {
      const next = await getTimeline(opportunityId, 200);
      if (token !== timelineToken.current) return;
      setTimeline(next);
    } catch {
      if (token === timelineToken.current) setTimeline([]);
    } finally {
      if (token === timelineToken.current) setTimelineLoading(false);
    }
  }, [opportunityId]);

  /**
   * The timeline, once per quote, deferred behind the quote itself.
   *
   * Three surfaces want it — the Overview's recent events, a carrier's status history and
   * the Activity tab — so it is one fetch that all three read rather than a fetch per
   * tab. Keyed on `opportunityId` and not on `detail`: every refetch replaces the detail
   * object, so depending on it meant re-reading the timeline on every mutation, on every
   * realtime event and on every window focus — and `run()` already refreshes it after an
   * action that could have changed it.
   */
  useEffect(() => {
    void loadTimeline();
  }, [loadTimeline]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  /**
   * Runs one action, then reloads from the server.
   *
   * A concurrency refusal is surfaced as a conflict banner rather than an error,
   * because the answer is "look at the latest version", not "try again". The reload
   * happens either way, so the page is never left showing data the server rejected.
   */
  const run = useCallback(
    async (action: () => Promise<void>, success: string) => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      setNotice(null);
      setConflict(null);
      try {
        await action();
        setNotice(success);
        await loadDetail(true);
        void loadTimeline();
        return true;
      } catch (caught) {
        if (caught instanceof SpecialtyConflictError) {
          setConflict(caught.message);
          await loadDetail(true);
        } else if (caught instanceof AlreadyClaimedError) {
          setNotice(`${caught.message} It is still open for you to work.`);
          await loadDetail(true);
        } else {
          setError(
            caught instanceof Error ? caught.message : 'That action could not be completed.',
          );
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, loadDetail, loadTimeline],
  );

  // ── Realtime ───────────────────────────────────────────────────────────────

  /**
   * Keyed on the quote, not on the loaded detail.
   *
   * Depending on `detail` tore the channel down and resubscribed on every refetch, which
   * meant a window during which a teammate's change was not being listened for — and
   * every mutation opened one.
   */
  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel(`specialty-quote-${opportunityId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'specialty_opportunities',
          filter: `id=eq.${opportunityId}`,
        },
        () => void loadDetail(true),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'specialty_carrier_markets',
          filter: `opportunity_id=eq.${opportunityId}`,
        },
        () => void loadDetail(true),
      )
      .subscribe();

    const onFocus = () => void loadDetail(true);
    window.addEventListener('focus', onFocus);
    return () => {
      void supabase.removeChannel(channel);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadDetail, opportunityId]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const phases = useMemo(
    () =>
      detail
        ? workflowProgress({
            opportunity: detail.opportunity,
            carrier_markets: detail.carrier_markets,
            information_requests: detail.information_requests,
            has_intake: detail.intake !== null,
          })
        : [],
    [detail],
  );

  const recentActivity = useMemo(
    () => timeline.slice(0, RECENT_ACTIVITY_LIMIT),
    [timeline],
  );

  const openCarrier = useCallback(
    (id: string) => onNavigate({ tab: 'carriers', carrier: id }),
    [onNavigate],
  );

  const openTab = useCallback(
    (next: WorkspaceTab) =>
      // Leaving Carriers drops the selection, so coming back lands on the list rather
      // than on whichever carrier was open three clicks ago.
      onNavigate(next === 'carriers' ? { tab: next } : { tab: next, carrier: null }),
    [onNavigate],
  );

  /**
   * profile id → display name, so the Submissions tab can name whoever sent each email
   * without a second query. Assignable members already cover every quoting-team member,
   * which is exactly the set that can send.
   */
  const profileNames = useMemo(
    () =>
      Object.fromEntries(
        (detail?.assignable_members ?? []).map((member) => [member.profile_id, member.display_name]),
      ) as Record<string, string>,
    [detail],
  );

  const selectCarrier = useCallback(
    (id: string | null) => onNavigate({ carrier: id }),
    [onNavigate],
  );

  // ── Fatal states ───────────────────────────────────────────────────────────

  if (loading && !detail) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-7 w-7 animate-spin text-[#223f7a]" />
          <p className="text-sm font-bold text-slate-500">Loading the quote…</p>
        </div>
      </div>
    );
  }

  if (fatal && !detail) {
    return (
      <div className="mx-auto max-w-2xl py-16">
        {fatal.kind === 'denied' ? (
          <div className={`${ui.error} flex items-start gap-3`}>
            <ShieldOff className="mt-0.5 h-5 w-5 shrink-0" />
            <span>
              {fatal.message}
              <br />
              <span className="font-semibold">
                Access to Specialty Quotes comes from membership of a quoting team, not from your
                role. A manager adds members under User Administration → Quoting Teams.
              </span>
            </span>
          </div>
        ) : fatal.kind === 'missing' ? (
          <p className={ui.empty}>
            {fatal.message} The link may be from before the quote was closed out, or the id may be
            wrong.
          </p>
        ) : (
          <div className="space-y-3">
            <div className={ui.error}>{fatal.message}</div>
            <button type="button" className={ui.btnPrimary} onClick={() => void loadDetail()}>
              Try again
            </button>
          </div>
        )}
        <div className="mt-4">
          <a href={backHref} className="text-xs font-black text-[#223f7a] hover:underline">
            ← Back to Specialty Quotes
          </a>
        </div>
      </div>
    );
  }

  if (!detail) return null;

  // ── The workspace ──────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 pb-16">
      <QuoteHeader
        detail={detail}
        backHref={backHref}
        run={run}
        busy={busy}
        onRefresh={() => {
          void loadDetail();
          void loadTimeline();
        }}
        onOpenLog={() => setLogOpen(true)}
      />

      <WorkflowProgress
        phases={phases}
        stage={detail.opportunity.stage}
        stageLabel={detail.opportunity.stage_label}
      />

      {conflict ? (
        <div className={`${ui.info} flex items-start gap-2`}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-blue-700" />
          <span>
            {conflict} The latest version is shown below — your change was not saved, and nothing your
            teammate did was lost.
          </span>
        </div>
      ) : null}
      {error ? <div className={ui.error}>{error}</div> : null}
      {notice ? <div className={ui.success}>{notice}</div> : null}

      <nav
        aria-label="Quote sections"
        className="flex gap-1 overflow-x-auto rounded-2xl bg-slate-100 p-1.5"
      >
        {WORKSPACE_TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => openTab(entry)}
            aria-current={tab === entry ? 'page' : undefined}
            className={`shrink-0 rounded-xl px-3.5 py-2 text-xs font-black transition ${
              tab === entry ? 'bg-[#223f7a] text-white shadow-sm' : 'text-slate-600 hover:bg-white'
            }`}
          >
            {tabLabel(entry)}
            {entry === 'carriers' && detail.opportunity.markets_total > 0
              ? ` (${detail.opportunity.markets_total})`
              : entry === 'documents' && detail.opportunity.documents_count > 0
                ? ` (${detail.opportunity.documents_count})`
                : ''}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <OverviewPanel
          detail={detail}
          recentActivity={recentActivity}
          activityLoading={timelineLoading}
          run={run}
          busy={busy}
          onOpenTab={openTab}
          onOpenCarrier={openCarrier}
        />
      ) : null}

      {tab === 'carriers' ? (
        <CarriersPanel
          detail={detail}
          context={context ?? EMPTY_CONTEXT}
          profileId={profile.id}
          timeline={timeline}
          run={run}
          busy={busy}
          selectedCarrierId={carrierId}
          onSelectCarrier={selectCarrier}
          setError={setError}
        />
      ) : null}

      {tab === 'application' ? (
        <ApplicationPanel detail={detail} run={run} busy={busy} />
      ) : null}

      {tab === 'documents' ? (
        <DocumentsPanel
          detail={detail}
          profileId={profile.id}
          run={run}
          busy={busy}
          setError={setError}
        />
      ) : null}

      {tab === 'submissions' ? (
        <SubmissionsPanel detail={detail} profileNames={profileNames} />
      ) : null}

      {tab === 'activity' ? (
        <ActivityPanel
          detail={detail}
          timeline={timeline}
          loading={timelineLoading}
          onRefresh={() => void loadTimeline()}
        />
      ) : null}

      <SpecialtyLogModal
        opportunityId={logOpen ? detail.opportunity.id : null}
        reference={detail.opportunity.reference}
        displayName={detail.opportunity.display_name}
        isOpen={logOpen}
        onClose={() => setLogOpen(false)}
      />
    </div>
  );
}

/**
 * What the Carriers tab gets while the context is still in flight.
 *
 * The tab is fully usable without it — every existing market renders from `detail` —
 * and only the "add a carrier we have used before" picker is empty for a moment.
 */
const EMPTY_CONTEXT: WorkspaceContext = {
  is_manager: false,
  can_view_reports: false,
  lines_of_business: [],
  my_teams: [],
  teammates: [],
  carriers: [],
};

'use client';

// My Work: the agent-first Policy Follow-up surface (Requirements 6.1 to 6.5, 7.1 to 7.9).
//
// One list of the signed-in employee's assigned open work across both domains, grouped by urgency,
// with one clear next action per item. Clicking an item opens the *existing* domain drawer — the
// Renewal drawer or the Cancellation drawer — rather than a duplicate detail surface, because those
// two are where every action already lives and where every write is already audited (task 7.6).
//
// What this surface deliberately does not do:
//   * it does not send anything. Requirement 12.1 keeps the shared surfaces consumers of
//     communication status, never a second sender, and there is no send call in this file;
//   * it does not show raw imported source fields (Requirement 6.3);
//   * it does not offer a claim or steal control. Requirement 3.6 defaults to manager and automatic
//     ownership, and adding a self-assign button would be a queue behaviour nobody asked for.
//
// Load pattern follows `RenewalsPage` and `CancellationsPage`: one `load()` that writes state only
// from settled callbacks, so the effect that calls it never sets state synchronously.

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ModuleShell } from '../nhwd-shared/ModuleShell';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import CancellationDrawer from '../cancellations/CancellationDrawer';
import { getCancellationSettings, listCancellationAssignees } from '../cancellations/api';
import type { CancellationAssignee, CancellationSettings } from '../cancellations/api';
import RenewalDrawer from '../renewals/RenewalDrawer';
import { listRenewalAssignees, listRenewals } from '../renewals/api';
import type { RenewalAssignee, RenewalRecord } from '../renewals/api';
import { currentBusinessDate } from '../renewals/derive';
import { failureText } from '../renewals/format';
import { loadMyPolicyWork } from './api';
import PolicyWorkTable from './PolicyWorkTable';
import { policyWorkBucket, policyWorkCounts, openPolicyWorkItems } from './work-projection';
import {
  POLICY_URGENCY_BUCKETS,
  POLICY_URGENCY_LABELS,
  type PolicyUrgencyBucket,
  type PolicyWorkItem,
} from './types';

/** Requirement 1.7 of the renewals spec, carried over: a hung query reaches the retry path. */
const QUERY_TIMEOUT_MS = 15_000;
const LOAD_FAILURE = 'Your assigned policy work could not be loaded.';

/** What each empty bucket says. A blank Critical list is good news and should read that way. */
const EMPTY_MESSAGE: Record<PolicyUrgencyBucket, string> = {
  critical: 'Nothing critical. Nothing of yours is overdue or about to cancel.',
  today: 'Nothing due today.',
  upcoming: 'Nothing due in the next seven days.',
  waiting: 'Nothing of yours is waiting on a customer, a payment, or a verification.',
  later: 'No other active policies are assigned to you.',
};

/** The order the buckets are stacked in, which is the Requirement 6.2 order. */
const BUCKET_ORDER: readonly PolicyUrgencyBucket[] = POLICY_URGENCY_BUCKETS;

interface MyWorkData {
  items: readonly PolicyWorkItem[];
  truncated: boolean;
  /** Every renewal the employee owns, so the drawer can be handed the record it needs. */
  renewals: readonly RenewalRecord[];
  renewalAssignees: readonly RenewalAssignee[];
  cancellationAssignees: readonly CancellationAssignee[];
  settings: CancellationSettings | null;
}

const EMPTY_DATA: MyWorkData = {
  items: [], truncated: false, renewals: [],
  renewalAssignees: [], cancellationAssignees: [], settings: null,
};

/** Rejects at 15 seconds, so a hung read reaches the retry path instead of loading forever. */
function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('It did not return within 15 seconds.')), QUERY_TIMEOUT_MS);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** A supporting read degrades rather than failing the surface. */
function optional<T>(work: Promise<readonly T[]>): Promise<readonly T[]> {
  return work.then((rows) => rows, () => []);
}

export interface MyPolicyWorkPageProps {
  initialProfile: ProfileLite;
  /** Set when a surrounding workspace already draws the page chrome, as `PolicyFollowUpPage` does. */
  embedded?: boolean;
  /**
   * Raised when the reader asks to see one of the detailed domain lists instead. The shell owns tab
   * selection, so this surface asks rather than navigating.
   */
  onOpenTab?: (tab: 'renewals' | 'cancellations') => void;
}

export default function MyPolicyWorkPage({
  initialProfile: profile,
  embedded = false,
  onOpenTab,
}: MyPolicyWorkPageProps) {
  const [data, setData] = useState<MyWorkData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selected, setSelected] = useState<PolicyWorkItem | null>(null);

  /**
   * One load for the surface. Every state write happens in a settled callback, so the effect below
   * never sets state synchronously and a failure leaves the previously loaded work on screen.
   */
  const load = useCallback(() => {
    void withTimeout(Promise.all([
      loadMyPolicyWork({ profileId: profile.id, role: profile.role }),
      optional(listRenewals({ status: 'open', assignedTo: profile.id })),
      optional(listRenewalAssignees()),
      optional(listCancellationAssignees()),
      getCancellationSettings().catch(() => null),
    ])).then(([work, renewals, renewalAssignees, cancellationAssignees, settings]) => {
      setData({
        items: work.items,
        truncated: work.truncated,
        renewals,
        renewalAssignees,
        cancellationAssignees,
        settings,
      });
      setError(null);
      setLastUpdated(new Date());
      setLoading(false);
    }, (caught: unknown) => {
      setError(failureText(caught, LOAD_FAILURE));
      setLoading(false);
    });
  }, [profile.id, profile.role]);

  const reload = useCallback(() => { setLoading(true); load(); }, [load]);

  useEffect(() => { load(); }, [load]);

  // Freshness without a subscription, the same three triggers both domain pages use.
  useEffect(() => {
    const refresh = () => load();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [load]);

  /** One clock read per render pass, handed to every child that formats a date. */
  const businessDate = currentBusinessDate();

  /** Task 6.8: a closed item belongs in no bucket. */
  const open = useMemo(() => openPolicyWorkItems(data.items), [data.items]);
  const counts = useMemo(() => policyWorkCounts(open), [open]);
  const buckets = useMemo(
    () => new Map(BUCKET_ORDER.map((bucket) => [bucket, policyWorkBucket(open, bucket)])),
    [open],
  );

  /** The renewal record the drawer needs, when a renewal item is open. */
  const selectedRenewal = useMemo(() => {
    if (selected === null || selected.domain !== 'renewal') return null;
    return data.renewals.find((record) => record.id === selected.sourceId) ?? null;
  }, [data.renewals, selected]);

  const totalOpen = open.length;

  return (
    <ModuleShell
      title="My Work"
      subtitle="Your assigned renewals and cancellations, most urgent first, with one next step each."
      role={profile.role}
      lastUpdated={lastUpdated}
      onRefresh={reload}
      embedded={embedded}
    >
      <div className="space-y-4">
        {/* The failure names the read, keeps the previously loaded work on screen, and retries. */}
        {error ? (
          <div className={`${ui.error} flex flex-wrap items-center justify-between gap-3`} role="alert">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </span>
            <button type="button" className={ui.btnSecondary} onClick={reload}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />Retry
            </button>
          </div>
        ) : null}

        {data.truncated ? (
          <p className={ui.info}>
            The {open.length.toLocaleString('en-US')} most urgent of your cancellations are loaded.
            Open Pending Cancellations to reach the rest.
          </p>
        ) : null}

        {/* Requirement 7.3: the four counters, each one a filter nobody has to think about. */}
        <div
          role="group"
          aria-label="My work summary"
          aria-busy={loading}
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          {(['critical', 'today', 'upcoming', 'waiting'] as const).map((bucket) => (
            <div
              key={bucket}
              className={[
                'rounded-2xl border px-3 py-3',
                bucket === 'critical' && counts[bucket] > 0
                  ? 'border-rose-300 bg-rose-50'
                  : 'border-slate-200 bg-white',
              ].join(' ')}
            >
              <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">
                {POLICY_URGENCY_LABELS[bucket]}
              </p>
              <p className="mt-0.5 text-2xl font-black tabular-nums text-slate-900">
                {counts[bucket].toLocaleString('en-US')}
              </p>
            </div>
          ))}
        </div>

        {!loading && totalOpen === 0 ? (
          <section className={`${ui.card} p-6`}>
            <p className="text-sm font-black text-slate-900">Nothing is assigned to you right now.</p>
            <p className="mt-1 text-sm font-bold text-slate-500">
              When a renewal or a cancellation is assigned to you it appears here, most urgent first.
            </p>
            {onOpenTab ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={ui.btnSecondary} onClick={() => onOpenTab('renewals')}>
                  Browse all renewals
                </button>
                <button
                  type="button"
                  className={ui.btnSecondary}
                  onClick={() => onOpenTab('cancellations')}
                >
                  Browse all cancellations
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* One section per bucket, in the Requirement 6.2 order. An empty bucket still renders its
            heading so the reader can tell "none" from "not loaded". */}
        {BUCKET_ORDER.map((bucket) => {
          const items = buckets.get(bucket) ?? [];
          if (!loading && items.length === 0 && totalOpen === 0) return null;

          return (
            <section key={bucket} className={`${ui.card} p-4`} aria-busy={loading}>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-black text-slate-900">
                  {POLICY_URGENCY_LABELS[bucket]}
                  <span className="ml-2 text-xs font-black tabular-nums text-slate-500">
                    {items.length.toLocaleString('en-US')}
                  </span>
                </h3>
              </div>

              <div className="mt-3">
                <PolicyWorkTable
                  items={items}
                  businessDate={businessDate}
                  selectedId={selected?.sourceId ?? null}
                  onOpen={setSelected}
                  loading={loading && items.length === 0}
                  emptyMessage={EMPTY_MESSAGE[bucket]}
                />
              </div>
            </section>
          );
        })}
      </div>

      {/* Task 7.6: the existing domain drawers, not a duplicate detail surface. Each one owns its own
          detail reads and every write, so an action completed here is the same action, audited the
          same way, as one completed from the domain list. */}
      <RenewalDrawer
        record={selected?.domain === 'renewal' ? selectedRenewal : null}
        businessDate={businessDate}
        assignees={data.renewalAssignees}
        canManage={false}
        onClose={() => setSelected(null)}
        onRecordChanged={() => load()}
      />

      <CancellationDrawer
        key={selected?.domain === 'cancellation' ? selected.sourceId : 'none'}
        caseId={selected?.domain === 'cancellation' ? selected.sourceId : null}
        businessDate={businessDate}
        role={profile.role}
        assignees={data.cancellationAssignees}
        settings={data.settings}
        noteComposer={null}
        onClose={() => setSelected(null)}
        onCaseChanged={() => load()}
      />
    </ModuleShell>
  );
}

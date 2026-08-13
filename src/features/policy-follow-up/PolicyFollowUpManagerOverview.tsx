'use client';

// Manager Overview: the manager-first Policy Follow-up surface (Requirements 9.1 to 9.5, 10.2, 10.3,
// 12.5, 13.2, and tasks 10.1 to 10.7).
//
// It answers one question — what is at risk or falling behind — and it answers it over the *whole*
// authorized population. Every number on this screen comes from `policy_followup_manager_overview`,
// a server-side aggregate, and not from rows the client happens to hold: the Cancellations list caps
// its own read at twenty pages, so a counter computed from what the browser has is wrong on a book
// larger than a thousand cases, silently and in the direction that hides work (Requirement 9.5).
// The surface says `across the full population` in as many words, so a reader knows which kind of
// number they are looking at.
//
// Four sections, in the order a manager needs them:
//   1. the per-domain counters of Requirement 9.2;
//   2. Attention Required, every card clickable into the underlying records (Requirement 9.3);
//   3. the team workload table, most at risk first (Requirement 9.4);
//   4. ownership: policy search, reassignment, unlock, conflicts, and agent eligibility
//      (Requirements 3.4, 3.5, 10.2, 10.3).
//
// Nothing here sends a customer message (Requirement 12.1), and nothing here turns automatic sending
// on: that control belongs to the cancellations readiness panel and is deliberately not duplicated.

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  Unlock,
  UsersRound,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { canManageRenewals } from '@/lib/permissions';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import { currentBusinessDate } from '../renewals/derive';
import { failureText } from '../renewals/format';
import {
  assignPolicy,
  bootstrapPolicyOwners,
  listPolicyEligibleAgents,
  listPolicyOwnershipExceptions,
  loadManagerOverview,
  savePolicyAgentSetting,
  searchPolicies,
  unlockPolicyOwner,
  type PolicyOwnershipException,
} from './api';
import {
  POLICY_ASSIGNMENT_MODES,
  POLICY_ASSIGNMENT_MODE_LABELS,
  type PolicyAssignmentMode,
} from './normalization';
import { buildAttentionCards } from './attention';
import type {
  PolicyDomainOverviewCounts,
  PolicyEligibleAgent,
  PolicyFollowUpManagerOverview,
  PolicySearchResult,
} from './types';

const QUERY_TIMEOUT_MS = 15_000;
const LOAD_FAILURE = 'The Policy Follow-up overview could not be loaded.';

/** The Requirement 9.2 counters, in the order they are listed there. */
const DOMAIN_ROWS: readonly { key: keyof PolicyDomainOverviewCounts; label: string; alarming?: true }[] = [
  { key: 'active', label: 'Active' },
  { key: 'needActionToday', label: 'Need action today' },
  { key: 'overdue', label: 'Overdue', alarming: true },
  { key: 'unassigned', label: 'Unassigned', alarming: true },
  { key: 'neverContacted', label: 'No successful contact', alarming: true },
  { key: 'waiting', label: 'Waiting' },
  { key: 'reviewRequired', label: 'Review required', alarming: true },
  { key: 'completedThisMonth', label: 'Completed this month' },
];

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('It did not return within 15 seconds.')), QUERY_TIMEOUT_MS);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function optional<T>(work: Promise<readonly T[]>): Promise<readonly T[]> {
  return work.then((rows) => rows, () => []);
}

interface OverviewData {
  overview: PolicyFollowUpManagerOverview | null;
  agents: readonly PolicyEligibleAgent[];
  exceptions: readonly PolicyOwnershipException[];
}

const EMPTY_DATA: OverviewData = { overview: null, agents: [], exceptions: [] };

type PanelId = 'ownership' | 'eligibility' | 'search';

export interface PolicyFollowUpManagerOverviewProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
  /** Raised when an Attention card drills into a domain list. The shell owns tab selection. */
  onOpenTab?: (tab: 'renewals' | 'cancellations' | 'imports', filter?: string) => void;
}

export default function PolicyFollowUpManagerOverviewPage({
  initialProfile: profile,
  embedded = false,
  onOpenTab,
}: PolicyFollowUpManagerOverviewProps) {
  const manage = canManageRenewals(profile.role);

  const [data, setData] = useState<OverviewData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Search and assignment drafts.
  const [searchText, setSearchText] = useState('');
  const [results, setResults] = useState<readonly PolicySearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [assignTarget, setAssignTarget] = useState<PolicySearchResult | PolicyOwnershipException | null>(null);
  const [assignTo, setAssignTo] = useState('');
  const [assignNote, setAssignNote] = useState('');

  const load = useCallback(() => {
    if (!manage) return;
    void withTimeout(Promise.all([
      loadManagerOverview(),
      optional(listPolicyEligibleAgents()),
      optional(listPolicyOwnershipExceptions('all', 200)),
    ])).then(([overview, agents, exceptions]) => {
      setData({ overview, agents, exceptions });
      setError(null);
      setLastUpdated(new Date());
      setLoading(false);
    }, (caught: unknown) => {
      setError(failureText(caught, LOAD_FAILURE));
      setLoading(false);
    });
  }, [manage]);

  const reload = useCallback(() => { setLoading(true); load(); }, [load]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const refresh = () => load();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [load]);

  const businessDate = data.overview?.businessDate ?? currentBusinessDate();

  /** Requirement 9.3: every count is a card, and every card knows where it drills to. */
  const attentionCards = useMemo(
    () => (data.overview === null ? [] : buildAttentionCards(data.overview)),
    [data.overview],
  );

  /** Requirement 9.4: most at risk first, which the RPC already ordered. */
  const agents = data.overview?.agents ?? [];

  const conflicts = useMemo(
    () => data.exceptions.filter((row) => row.conflict),
    [data.exceptions],
  );
  const unassigned = useMemo(
    () => data.exceptions.filter((row) => !row.conflict),
    [data.exceptions],
  );

  /** Every write path: one busy key, a success notice, and a failure that names the attempt. */
  const run = useCallback(async (
    key: string,
    action: () => Promise<string>,
    failure: string,
  ) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      load();
    } catch (caught) {
      setError(failureText(caught, failure));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const runSearch = useCallback(async () => {
    const query = searchText.trim();
    if (query.length === 0) { setResults([]); return; }
    setSearching(true);
    setError(null);
    try {
      setResults(await searchPolicies(query, 25));
    } catch (caught) {
      setError(failureText(caught, 'The policy search could not be completed.'));
    } finally {
      setSearching(false);
    }
  }, [searchText]);

  if (!manage) {
    return (
      <ModuleShell
        title="Manager Overview"
        subtitle="Policy follow-up"
        role={profile.role}
        embedded={embedded}
      >
        <div className={ui.error}>Manager Overview is available to managers and super admins.</div>
      </ModuleShell>
    );
  }

  const overview = data.overview;

  return (
    <ModuleShell
      title="Manager Overview"
      subtitle="What is at risk or falling behind, across every renewal and cancellation in your view."
      role={profile.role}
      lastUpdated={lastUpdated}
      onRefresh={reload}
      embedded={embedded}
    >
      <div className="space-y-4">
        {error ? (
          <div className={`${ui.error} flex flex-wrap items-center justify-between gap-3`} role="alert">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />{error}
            </span>
            <button type="button" className={ui.btnSecondary} onClick={reload}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />Retry
            </button>
          </div>
        ) : null}

        {notice ? (
          <p role="status" className={ui.success}>
            <CheckCircle2 className="mr-2 inline h-4 w-4" aria-hidden="true" />{notice}
          </p>
        ) : null}

        {/* Requirement 9.5 in as many words, so nobody has to guess whether a number is a window. */}
        {overview?.fullPopulation ? (
          <p className="text-xs font-bold text-slate-500">
            Every count below is computed across the full population in your view, for the business
            date {businessDate}.
          </p>
        ) : null}

        {/* ── 1. Per-domain counters (Requirement 9.2) */}
        <div className="grid gap-4 lg:grid-cols-2">
          {([
            ['Renewals', overview?.renewals, 'renewals'] as const,
            ['Pending Cancellations', overview?.cancellations, 'cancellations'] as const,
          ]).map(([title, counts, tab]) => (
            <section key={title} className={`${ui.card} p-5`} aria-busy={loading}>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-black text-slate-900">{title}</h3>
                {onOpenTab ? (
                  <button type="button" className={ui.btnGhost} onClick={() => onOpenTab(tab)}>
                    Open list
                  </button>
                ) : null}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {DOMAIN_ROWS.map((row) => {
                  const value = counts?.[row.key] ?? 0;
                  const alarming = row.alarming === true && value > 0;
                  return (
                    <div
                      key={row.key}
                      className={[
                        'rounded-2xl border px-3 py-2',
                        alarming ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white',
                      ].join(' ')}
                    >
                      <dt className="text-[10px] font-black uppercase tracking-wide text-slate-500">
                        {row.label}
                      </dt>
                      <dd className="mt-0.5 text-xl font-black tabular-nums text-slate-900">
                        {value.toLocaleString('en-US')}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          ))}
        </div>

        {/* ── 2. Attention Required (Requirement 9.3) */}
        <section className={`${ui.card} p-5`} aria-busy={loading}>
          <h3 className="text-sm font-black text-slate-900">Attention required</h3>
          <p className="mt-0.5 text-xs font-bold text-slate-500">
            Each card opens the records behind it.
          </p>

          {attentionCards.length === 0 && !loading ? (
            <p className="mt-3 text-sm font-bold text-slate-500">
              Nothing is waiting on a manager right now.
            </p>
          ) : (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {attentionCards.map((card) => (
                <li key={card.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (card.target.tab === 'manager') {
                        setPanel('ownership');
                        return;
                      }
                      onOpenTab?.(
                        card.target.tab as 'renewals' | 'cancellations' | 'imports',
                        card.target.filter,
                      );
                    }}
                    className="flex w-full items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-left transition hover:border-[#8da4cf] hover:bg-[#f8faff] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#eef3fb]"
                  >
                    <span>
                      <span className="block text-sm font-black text-slate-900">{card.label}</span>
                      <span className="mt-0.5 block text-xs font-semibold text-slate-500">
                        {card.hint}
                      </span>
                    </span>
                    <span
                      className={[
                        'shrink-0 rounded-full px-2.5 py-1 text-sm font-black tabular-nums',
                        card.count > 0 ? 'bg-rose-100 text-rose-900' : 'bg-slate-100 text-slate-500',
                      ].join(' ')}
                    >
                      {card.count.toLocaleString('en-US')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 3. Team workload (Requirement 9.4) */}
        <section className={`${ui.card} overflow-hidden`} aria-busy={loading}>
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <h3 className="text-sm font-black text-slate-900">Team workload</h3>
            <p className="text-xs font-bold text-slate-500">Most at risk first</p>
          </div>
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>Employee</th>
                  <th className={ui.th}>Renewals</th>
                  <th className={ui.th}>Cancellations</th>
                  <th className={ui.th}>Due today</th>
                  <th className={ui.th}>Overdue</th>
                  <th className={ui.th}>Critical</th>
                  <th className={ui.th}>Requotes</th>
                  <th className={ui.th}>Waiting</th>
                  <th className={ui.th}>Workload</th>
                  <th className={ui.th}>Automatic</th>
                </tr>
              </thead>
              <tbody>
                {agents.length === 0 ? (
                  <tr>
                    <td className={ui.td} colSpan={10}>
                      {loading ? 'Loading the team…' : 'No employees are eligible for Policy Follow-up work.'}
                    </td>
                  </tr>
                ) : agents.map((agent) => (
                  <tr key={agent.profileId}>
                    <td className={`${ui.td} font-black text-slate-900`}>
                      {agent.displayName}
                      {agent.username ? (
                        <span className="ml-1 font-bold text-slate-400">@{agent.username}</span>
                      ) : null}
                    </td>
                    <td className={`${ui.td} tabular-nums`}>{agent.activeRenewals}</td>
                    <td className={`${ui.td} tabular-nums`}>{agent.activeCancellations}</td>
                    <td className={`${ui.td} tabular-nums`}>{agent.dueToday}</td>
                    <td className={`${ui.td} tabular-nums ${agent.overdue > 0 ? 'font-black text-rose-700' : ''}`}>
                      {agent.overdue}
                    </td>
                    <td className={`${ui.td} tabular-nums ${agent.criticalCancellations > 0 ? 'font-black text-rose-700' : ''}`}>
                      {agent.criticalCancellations}
                    </td>
                    <td className={`${ui.td} tabular-nums`}>{agent.carrierNonRenewals}</td>
                    <td className={`${ui.td} tabular-nums`}>{agent.waiting}</td>
                    <td className={`${ui.td} font-black tabular-nums text-slate-900`}>
                      {agent.workloadScore}
                    </td>
                    <td className={ui.td}>
                      {agent.autoAssignmentEnabled && agent.assignmentMode !== 'manual_only'
                        ? <span className={`${ui.badge} ${ui.badgeTone.success}`}>On</span>
                        : <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>Off</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── 4. Ownership controls */}
        <section className={`${ui.card} p-5`}>
          <h3 className="text-sm font-black text-slate-900">Ownership</h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {([
              ['search', 'Find a policy', 'Search by customer, policy, carrier, phone, or email', Search],
              ['ownership', 'Unassigned and conflicts', 'Policies with no owner, and bootstrap conflicts', ShieldCheck],
              ['eligibility', 'Agent eligibility', 'Who receives renewals, cancellations, and balancing', UsersRound],
            ] as const).map(([id, label, hint, Icon]) => (
              <button
                key={id}
                type="button"
                aria-expanded={panel === id}
                onClick={() => setPanel(panel === id ? null : id)}
                className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-left transition hover:border-[#8da4cf] hover:bg-[#f8faff]"
              >
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#eef3fb] text-[#223f7a]">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-black text-slate-900">{label}</span>
                  <span className="mt-0.5 block text-xs font-semibold text-slate-500">{hint}</span>
                </span>
                <ChevronDown
                  className={`ml-auto h-4 w-4 shrink-0 transition ${panel === id ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>

          {/* ── Policy search (Requirements 10.2, 10.3) */}
          {panel === 'search' ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <form
                onSubmit={(event) => { event.preventDefault(); void runSearch(); }}
                className="flex flex-wrap items-end gap-3"
              >
                <label className="min-w-[16rem] flex-1">
                  <span className={ui.label}>Customer, policy, carrier, phone, or email</span>
                  <input
                    type="search"
                    className={ui.input}
                    value={searchText}
                    maxLength={100}
                    onChange={(event) => setSearchText(event.target.value)}
                  />
                </label>
                <button type="submit" className={ui.btnPrimary} disabled={searching}>
                  <Search className="h-4 w-4" aria-hidden="true" />Search
                </button>
              </form>

              {results.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {results.map((result) => (
                    <li
                      key={`${result.carrierKey}|${result.policyNumberNormalized}`}
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-3"
                    >
                      <p className="text-sm font-black text-slate-900">
                        {result.customerName ?? 'Customer not recorded'}
                      </p>
                      <p className="mt-0.5 text-xs font-bold text-slate-500">
                        {result.carrier ?? 'Carrier not recorded'} · Policy {result.policyNumber}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs font-bold">
                        {/* Requirement 10.2: active renewal, active cancellation, both, or neither. */}
                        <span className={`${ui.badge} ${result.hasActiveRenewal ? ui.badgeTone.info : ui.badgeTone.neutral}`}>
                          {result.hasActiveRenewal ? 'Active renewal' : 'No active renewal'}
                        </span>
                        <span className={`${ui.badge} ${result.hasActiveCancellation ? ui.badgeTone.progress : ui.badgeTone.neutral}`}>
                          {result.hasActiveCancellation ? 'Active cancellation' : 'No active cancellation'}
                        </span>
                        {/* Requirement 10.3: one owner, whichever domain you came from. */}
                        <span className="text-slate-600">
                          Owner: {result.ownerName ?? 'Unassigned'}
                        </span>
                        {result.assignmentLocked ? (
                          <span className={`${ui.badge} ${ui.badgeTone.violet}`}>
                            <Lock className="mr-1 h-3 w-3" aria-hidden="true" />Manager locked
                          </span>
                        ) : null}
                        {result.ownershipConflict ? (
                          <span className={`${ui.badge} ${ui.badgeTone.danger}`}>Ownership conflict</span>
                        ) : null}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={ui.btnSecondary}
                          onClick={() => { setAssignTarget(result); setAssignTo(result.ownerProfileId ?? ''); }}
                        >
                          Assign owner
                        </button>
                        {result.assignmentLocked && result.carrierKey && result.policyNumberNormalized ? (
                          <button
                            type="button"
                            className={ui.btnGhost}
                            disabled={busy !== null}
                            onClick={() => void run(
                              `unlock:${result.policyNumberNormalized}`,
                              async () => {
                                await unlockPolicyOwner({
                                  carrierKey: result.carrierKey as string,
                                  policyNumberNormalized: result.policyNumberNormalized as string,
                                });
                                return `${result.policyNumber} is unlocked. The same owner is kept; future imports may reassign it.`;
                              },
                              'The policy could not be unlocked.',
                            )}
                          >
                            <Unlock className="h-4 w-4" aria-hidden="true" />Unlock automatic assignment
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : searchText.trim().length > 0 && !searching ? (
                <p className="mt-3 text-sm font-bold text-slate-500">No policy matched that search.</p>
              ) : null}
            </div>
          ) : null}

          {/* ── Unassigned and conflicted policies (Requirement 9.3, task 10.7) */}
          {panel === 'ownership' ? (
            <div className="mt-4 space-y-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-black text-slate-900">
                  {conflicts.length} ownership {conflicts.length === 1 ? 'conflict' : 'conflicts'} ·{' '}
                  {unassigned.length} unassigned
                </p>
                <button
                  type="button"
                  className={ui.btnSecondary}
                  disabled={busy !== null}
                  onClick={() => void run('bootstrap', async () => {
                    const result = await bootstrapPolicyOwners();
                    return `${result.bootstrapped} owners bootstrapped, ${result.conflicts} conflicts recorded, `
                      + `${result.unowned} unowned policies listed.`;
                  }, 'The ownership bootstrap could not be run.')}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />Re-run ownership bootstrap
                </button>
              </div>

              {conflicts.length > 0 ? (
                <div>
                  <p className={ui.sectionTitle}>Conflicts — pick an owner</p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    The renewal and the cancellation for these policies were assigned to different
                    employees. Nothing was guessed and neither assignment was changed; choosing an
                    owner settles it and protects the choice from future imports.
                  </p>
                  <ul className="mt-2 space-y-2">
                    {conflicts.map((row) => (
                      <li
                        key={`${row.carrier_key}|${row.policy_number_normalized}`}
                        className="rounded-2xl border border-rose-200 bg-white px-3 py-3"
                      >
                        <p className="text-sm font-black text-slate-900">
                          {row.customer_name ?? 'Customer not recorded'}
                        </p>
                        <p className="mt-0.5 text-xs font-bold text-slate-500">
                          {row.carrier ?? row.carrier_key} · Policy{' '}
                          {row.policy_number ?? row.policy_number_normalized}
                        </p>
                        <button
                          type="button"
                          className={`${ui.btnSecondary} mt-2`}
                          onClick={() => { setAssignTarget(row); setAssignTo(''); }}
                        >
                          Choose the owner
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {unassigned.length > 0 ? (
                <div>
                  <p className={ui.sectionTitle}>Unassigned policies</p>
                  <ul className="mt-2 space-y-2">
                    {unassigned.slice(0, 25).map((row) => (
                      <li
                        key={`${row.carrier_key}|${row.policy_number_normalized}`}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3"
                      >
                        <span>
                          <span className="block text-sm font-black text-slate-900">
                            {row.customer_name ?? 'Customer not recorded'}
                          </span>
                          <span className="mt-0.5 block text-xs font-bold text-slate-500">
                            {row.carrier ?? row.carrier_key} · Policy{' '}
                            {row.policy_number ?? row.policy_number_normalized}
                            {row.producer_label ? ` · Producer “${row.producer_label}”` : ''}
                          </span>
                        </span>
                        <button
                          type="button"
                          className={ui.btnSecondary}
                          onClick={() => { setAssignTarget(row); setAssignTo(''); }}
                        >
                          Assign owner
                        </button>
                      </li>
                    ))}
                  </ul>
                  {unassigned.length > 25 ? (
                    <p className="mt-2 text-xs font-bold text-slate-500">
                      The 25 most recent of {unassigned.length} unassigned policies are shown.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {conflicts.length === 0 && unassigned.length === 0 ? (
                <p className="text-sm font-bold text-slate-500">
                  Every policy with live work has an owner, and no bootstrap conflict is outstanding.
                </p>
              ) : null}
            </div>
          ) : null}

          {/* ── Agent eligibility (Requirement 3.4, tasks 10.1, 10.2) */}
          {panel === 'eligibility' ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <p className="text-xs font-semibold text-slate-600">
                These settings control automatic assignment only. Each employee&apos;s role still
                decides what they can reach, and none of this touches the quote queues, the
                attendance queue state, or anybody&apos;s turn.
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th className={ui.th}>Employee</th>
                      <th className={ui.th}>Renewals</th>
                      <th className={ui.th}>Cancellations</th>
                      <th className={ui.th}>Automatic assignment</th>
                      <th className={ui.th}>Mode</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map((agent) => (
                      <AgentEligibilityRow
                        key={agent.profile_id}
                        agent={agent}
                        busy={busy === `eligibility:${agent.profile_id}`}
                        onSave={(next) => void run(
                          `eligibility:${agent.profile_id}`,
                          async () => {
                            await savePolicyAgentSetting(next);
                            return `${agent.display_name}'s Policy Follow-up eligibility is saved.`;
                          },
                          'The eligibility setting could not be saved.',
                        )}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </section>

        {/* ── The assignment dialog (Requirement 3.5) */}
        {assignTarget !== null ? (
          <section className={`${ui.card} p-5`} role="group" aria-label="Assign the policy owner">
            <h3 className="text-sm font-black text-slate-900">Assign the policy owner</h3>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">
              This updates every open renewal and active cancellation for the policy, records who
              changed it, and protects the choice from future automatic reassignment until you unlock
              it.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label>
                <span className={ui.label}>Employee</span>
                <select
                  className={ui.select}
                  value={assignTo}
                  onChange={(event) => setAssignTo(event.target.value)}
                >
                  <option value="">Choose the employee who will own it</option>
                  {data.agents.map((agent) => (
                    <option key={agent.profile_id} value={agent.profile_id}>
                      {agent.display_name}
                      {agent.username ? ` · @${agent.username}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className={ui.label}>Note (optional)</span>
                <input
                  type="text"
                  className={ui.input}
                  value={assignNote}
                  maxLength={500}
                  onChange={(event) => setAssignNote(event.target.value)}
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className={ui.btnPrimary}
                disabled={assignTo === '' || busy !== null}
                onClick={() => {
                  const carrierKey = 'carrierKey' in assignTarget
                    ? assignTarget.carrierKey
                    : assignTarget.carrier_key;
                  const policy = 'policyNumberNormalized' in assignTarget
                    ? assignTarget.policyNumberNormalized
                    : assignTarget.policy_number_normalized;
                  if (!carrierKey || !policy) {
                    setError('That policy has no readable carrier, so it cannot be owned by carrier and policy number yet.');
                    return;
                  }
                  void run('assign', async () => {
                    const result = await assignPolicy({
                      carrierKey,
                      policyNumberNormalized: policy,
                      profileId: assignTo,
                      managerNote: assignNote.trim() || null,
                    });
                    setAssignTarget(null);
                    setAssignNote('');
                    const person = data.agents.find((agent) => agent.profile_id === assignTo);
                    return `${policy} is assigned to ${person?.display_name ?? 'the selected employee'}: `
                      + `${result.renewals_updated} renewal and ${result.cancellations_updated} cancellation `
                      + 'records were updated.';
                  }, 'The policy assignment could not be saved.');
                }}
              >
                Assign and lock
              </button>
              <button
                type="button"
                className={ui.btnGhost}
                onClick={() => { setAssignTarget(null); setAssignNote(''); }}
              >
                Cancel
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </ModuleShell>
  );
}

// ---------------------------------------------------------------------------
// One editable eligibility row (Requirement 3.4)
// ---------------------------------------------------------------------------

interface AgentEligibilityRowProps {
  agent: PolicyEligibleAgent;
  busy: boolean;
  onSave: (next: {
    profileId: string;
    renewalsEnabled: boolean;
    cancellationsEnabled: boolean;
    autoAssignmentEnabled: boolean;
    assignmentMode: PolicyAssignmentMode;
  }) => void;
}

function AgentEligibilityRow({ agent, busy, onSave }: AgentEligibilityRowProps) {
  const save = (patch: Partial<{
    renewalsEnabled: boolean;
    cancellationsEnabled: boolean;
    autoAssignmentEnabled: boolean;
    assignmentMode: PolicyAssignmentMode;
  }>) => {
    onSave({
      profileId: agent.profile_id,
      renewalsEnabled: patch.renewalsEnabled ?? agent.renewals_enabled,
      cancellationsEnabled: patch.cancellationsEnabled ?? agent.cancellations_enabled,
      autoAssignmentEnabled: patch.autoAssignmentEnabled ?? agent.auto_assignment_enabled,
      assignmentMode: patch.assignmentMode ?? agent.assignment_mode,
    });
  };

  return (
    <tr>
      <td className={`${ui.td} font-black text-slate-900`}>
        {agent.display_name}
        {agent.username ? <span className="ml-1 font-bold text-slate-400">@{agent.username}</span> : null}
      </td>
      <td className={ui.td}>
        <label className={ui.checkboxRow}>
          <input
            type="checkbox"
            checked={agent.renewals_enabled}
            disabled={busy}
            onChange={(event) => save({ renewalsEnabled: event.target.checked })}
          />
          <span className="sr-only">Eligible for renewals</span>
        </label>
      </td>
      <td className={ui.td}>
        <label className={ui.checkboxRow}>
          <input
            type="checkbox"
            checked={agent.cancellations_enabled}
            disabled={busy}
            onChange={(event) => save({ cancellationsEnabled: event.target.checked })}
          />
          <span className="sr-only">Eligible for cancellations</span>
        </label>
      </td>
      <td className={ui.td}>
        <label className={ui.checkboxRow}>
          <input
            type="checkbox"
            checked={agent.auto_assignment_enabled}
            disabled={busy}
            onChange={(event) => save({ autoAssignmentEnabled: event.target.checked })}
          />
          <span className="sr-only">Receives automatic assignment</span>
        </label>
      </td>
      <td className={ui.td}>
        <select
          className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-slate-900"
          value={agent.assignment_mode}
          disabled={busy}
          onChange={(event) => save({ assignmentMode: event.target.value as PolicyAssignmentMode })}
        >
          {POLICY_ASSIGNMENT_MODES.map((mode) => (
            <option key={mode} value={mode}>{POLICY_ASSIGNMENT_MODE_LABELS[mode]}</option>
          ))}
        </select>
      </td>
    </tr>
  );
}

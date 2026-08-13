'use client';

// Policy Follow-up workspace shell (Requirements 14.1, 14.2; renewals Requirements 1.1 to 1.4, 1.8, 1.11).
//
// Five views and nothing else. This file reads no data, calls no `api.ts` function, and owns no
// control beyond the tab buttons, so every element the renewals Requirement 1.4 lists — summary
// filter bar, search field, saved filter control, list surface, right-anchored detail drawer, the
// timeline inside it, and the one prominent primary action — belongs to the tab surface it renders.
//
// ── Which view a reader lands on (Requirement 14.1)
//
// The tab is URL-addressable, so `?tab=renewals` and `?tab=cancellations` — every link already in
// circulation — resolve to exactly the surfaces they always did. `my-work` is the default for an
// agent, because Requirement 6.1 makes it the agent-first landing view, and `manager` is the default
// for Manager_Role, because Requirement 9.1's whole point is that a manager needs a different first
// screen from an agent. Neither default is persisted: a fresh load resolves it from the role again.
//
// `manager` and `imports` are reserved to Manager_Role (Requirement 14.2). The gate here is a
// convenience, not the enforcement: `policy_followup_manager_overview` and every manager RPC check
// the role server-side, and the import functions refuse a non-manager outright.
//
// Requirement 1.3 of the renewals spec still applies to the two list views: the three values a
// reader set on the tab being left — search text, saved filter, sort order — are reported here by
// that tab and handed back as its initial state when the reader returns. Everything else about the
// tab being left goes with it, because the panel renders one tab at a time.
//
// Requirement 1.8: no control here creates a to-do item, a task, a task template, a task board, a
// drag-and-drop arrangement, or a user-defined workflow state, and no tab exposes one.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { canAccessRenewals, canManageRenewals } from '@/lib/permissions';
import CancellationsPage from '../cancellations/CancellationsPage';
import type { CancellationsUiState } from '../cancellations/derive';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import MyPolicyWorkPage from '../policy-follow-up/MyPolicyWorkPage';
import PolicyFollowUpImports from '../policy-follow-up/PolicyFollowUpImports';
import PolicyFollowUpManagerOverviewPage from '../policy-follow-up/PolicyFollowUpManagerOverview';
import {
  POLICY_FOLLOW_UP_TAB_IDS,
  isManagerOnlyTab,
  type PolicyFollowUpTab,
} from '../policy-follow-up/types';
import type { RenewalsUiState } from './derive';
import RenewalsPage from './RenewalsPage';

/**
 * The five views in the order they are offered (Requirement 14.1).
 *
 * `renewals` and `cancellations` keep the ids and the labels they have always had, so no existing
 * link and no existing muscle memory breaks.
 */
export const POLICY_FOLLOW_UP_TABS = [
  { id: 'my-work', label: 'My Work' },
  { id: 'renewals', label: 'Renewals' },
  { id: 'cancellations', label: 'Pending Cancellations' },
  { id: 'manager', label: 'Manager Overview' },
  { id: 'imports', label: 'Imports' },
] as const satisfies readonly { id: PolicyFollowUpTab; label: string }[];

export type PolicyFollowUpTabId = PolicyFollowUpTab;

/** What the Renewals tab starts from before the reader has narrowed anything (renewals Req 1.3). */
const INITIAL_RENEWALS_UI: RenewalsUiState = { searchText: '', savedFilter: null, sortOrder: 'recommended' };

/**
 * What the Cancellations tab starts from (renewals Req 1.3). A null saved filter is Needs Action,
 * which `resolveCancellationFilter` and `filterCancellationRows` both resolve it to (cancellations
 * Req 16.2): the tab has no zero-filter state, and storing `'needs-action'` here would claim the
 * reader chose it.
 */
const INITIAL_CANCELLATIONS_UI: CancellationsUiState = {
  searchText: '',
  savedFilter: null,
  sortOrder: 'recommended',
};

const TAB_IDS: ReadonlySet<string> = new Set<string>(POLICY_FOLLOW_UP_TAB_IDS);

/**
 * The view a reader lands on, from the URL where it names one this profile may open, and from the
 * role otherwise (Requirement 14.1).
 *
 * A manager-only tab requested by a profile without Manager_Role falls back to that profile's
 * default rather than rendering an access message: the tab is not theirs to be refused from, and
 * silently landing them somewhere useful is better than an error they cannot act on.
 */
export function resolvePolicyFollowUpTab(
  requested: string | null,
  role: ProfileLite['role'],
): PolicyFollowUpTab {
  const manager = canManageRenewals(role);
  const fallback: PolicyFollowUpTab = manager ? 'manager' : 'my-work';

  if (requested === null || !TAB_IDS.has(requested)) return fallback;
  const tab = requested as PolicyFollowUpTab;
  if (isManagerOnlyTab(tab) && !manager) return fallback;
  return tab;
}

export interface PolicyFollowUpPageProps {
  initialProfile: ProfileLite;
  /** Set when a surrounding workspace already draws the page chrome, as `RoleWorkspace` does. */
  embedded?: boolean;
}

export default function PolicyFollowUpPage({ initialProfile, embedded = false }: PolicyFollowUpPageProps) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const manager = canManageRenewals(initialProfile.role);
  const activeTab = resolvePolicyFollowUpTab(searchParams.get('tab'), initialProfile.role);

  /** Requirement 14.2: a manager-only tab is not offered to a profile that cannot open it. */
  const tabs = useMemo(
    () => POLICY_FOLLOW_UP_TABS.filter((tab) => manager || !isManagerOnlyTab(tab.id)),
    [manager],
  );

  /**
   * Renewals Requirement 1.3, retention half. The mounted tab reports its three values as the reader
   * changes them, which must not re-render this shell, so they land in a ref. `restored…Ui` is the
   * copy a mounting tab reads, taken from the ref while the tab is being left — the one moment the
   * retained value matters to a render. One pair per tab, and neither tab can read the other's.
   */
  const renewalsUi = useRef<RenewalsUiState>(INITIAL_RENEWALS_UI);
  const [restoredRenewalsUi, setRestoredRenewalsUi] = useState<RenewalsUiState>(INITIAL_RENEWALS_UI);
  const retainRenewalsUi = useCallback((next: RenewalsUiState) => { renewalsUi.current = next; }, []);

  const cancellationsUi = useRef<CancellationsUiState>(INITIAL_CANCELLATIONS_UI);
  const [restoredCancellationsUi, setRestoredCancellationsUi] =
    useState<CancellationsUiState>(INITIAL_CANCELLATIONS_UI);
  const retainCancellationsUi = useCallback((next: CancellationsUiState) => {
    cancellationsUi.current = next;
  }, []);

  /** Requirement 14.1: retain the list UI state and put the tab in the URL. */
  const selectTab = useCallback((next: PolicyFollowUpTab) => {
    setRestoredRenewalsUi(renewalsUi.current);
    setRestoredCancellationsUi(cancellationsUi.current);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [searchParams, router]);

  if (!canAccessRenewals(initialProfile.role)) {
    return (
      <ModuleShell
        title="Policy Follow-up"
        subtitle="Renewals and pending cancellations"
        role={initialProfile.role}
        embedded={embedded}
      >
        <div className={ui.error}>Your account does not have Policy Follow-up access.</div>
      </ModuleShell>
    );
  }

  return (
    <ModuleShell
      title="Policy Follow-up"
      subtitle="Two follow-up queues in one place: renewals coming due, and policies heading to cancellation."
      role={initialProfile.role}
      embedded={embedded}
    >
      <div className="space-y-4">
        <div
          role="tablist"
          aria-label="Policy follow-up tabs"
          className="flex flex-wrap gap-1.5 rounded-[22px] border border-slate-200 bg-white px-2 py-2 shadow-sm"
        >
          {tabs.map((tab) => {
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`policy-follow-up-tab-${tab.id}`}
                aria-selected={active}
                aria-controls={`policy-follow-up-panel-${tab.id}`}
                onClick={() => selectTab(tab.id)}
                className={[
                  'rounded-xl border px-4 py-2 text-sm font-black transition',
                  active
                    ? 'border-[#c9d5e9] bg-[#eef3fb] text-[#223f7a]'
                    : 'border-transparent bg-white text-slate-600 hover:bg-slate-50',
                ].join(' ')}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`policy-follow-up-panel-${activeTab}`}
          aria-labelledby={`policy-follow-up-tab-${activeTab}`}
        >
          {activeTab === 'my-work' ? (
            <MyPolicyWorkPage
              initialProfile={initialProfile}
              embedded
              onOpenTab={(tab) => selectTab(tab)}
            />
          ) : null}

          {activeTab === 'renewals' ? (
            <RenewalsPage
              initialProfile={initialProfile}
              embedded
              initialUiState={restoredRenewalsUi}
              onUiStateChange={retainRenewalsUi}
            />
          ) : null}

          {activeTab === 'cancellations' ? (
            <CancellationsPage
              initialProfile={initialProfile}
              embedded
              initialUiState={restoredCancellationsUi}
              onUiStateChange={retainCancellationsUi}
            />
          ) : null}

          {activeTab === 'manager' ? (
            <PolicyFollowUpManagerOverviewPage
              initialProfile={initialProfile}
              embedded
              onOpenTab={(tab) => selectTab(tab)}
            />
          ) : null}

          {activeTab === 'imports' ? (
            <PolicyFollowUpImports initialProfile={initialProfile} embedded />
          ) : null}
        </div>
      </div>
    </ModuleShell>
  );
}

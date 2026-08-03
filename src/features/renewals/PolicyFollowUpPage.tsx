'use client';

// Policy Follow-up workspace shell (Requirements 1.1, 1.2, 1.3, 1.4, 1.8, 1.11).
//
// Two tabs and nothing else. This file reads no data, calls no `api.ts` function, and owns no
// control beyond the two tab buttons, so every element Requirement 1.4 lists — summary filter bar,
// search field, saved filter control, list surface, right-anchored detail drawer, the timeline
// inside it, and the one prominent primary action — belongs to the tab surface it renders.
//
// The selected tab is component state and is held nowhere else: no localStorage, no sessionStorage,
// no cookie, and no URL parameter. A fresh page load therefore starts on Renewals whatever the
// reader had selected during an earlier load (Req 1.2).
//
// Requirement 1.3 splits in two. The three values the reader set on the tab being left — search
// text, saved filter, sort order — are reported here by that tab and handed back as its initial
// state when the reader returns. Everything else about the tab being left goes with it: the panel
// renders one tab at a time, so leaving unmounts that tab and its detail drawer closes with it,
// and returning mounts a tab whose record selection starts empty again.
//
// Switching writes one piece of state and renders the other tab, which paints its own list surface
// or loading indicator on that render; nothing navigates and nothing reloads (Req 1.11).
//
// Requirement 1.8: no control here creates a to-do item, a task, a task template, a task board, a
// drag-and-drop arrangement, or a user-defined workflow state, and neither tab exposes one.

import { useCallback, useRef, useState } from 'react';

import { ModuleShell } from '../nhwd-shared/ModuleShell';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import type { RenewalsUiState } from './derive';
import RenewalsPage from './RenewalsPage';

/** Requirement 1.1: exactly two tabs, Renewals first and Cancellations second. */
export const POLICY_FOLLOW_UP_TABS = [
  { id: 'renewals', label: 'Renewals' },
  { id: 'cancellations', label: 'Cancellations' },
] as const;

export type PolicyFollowUpTabId = (typeof POLICY_FOLLOW_UP_TABS)[number]['id'];

/** Requirement 1.2: the tab a page load starts on, read once per mount and never persisted. */
const INITIAL_TAB: PolicyFollowUpTabId = 'renewals';

/** What the Renewals tab starts from before the reader has narrowed anything (Req 1.3). */
const INITIAL_RENEWALS_UI: RenewalsUiState = { searchText: '', savedFilter: null, sortOrder: 'recommended' };

export interface PolicyFollowUpPageProps {
  initialProfile: ProfileLite;
  /** Set when a surrounding workspace already draws the page chrome, as `RoleWorkspace` does. */
  embedded?: boolean;
}

export default function PolicyFollowUpPage({ initialProfile, embedded = false }: PolicyFollowUpPageProps) {
  const [activeTab, setActiveTab] = useState<PolicyFollowUpTabId>(INITIAL_TAB);

  /**
   * Requirement 1.3, retention half. The mounted tab reports its three values as the reader changes
   * them, which must not re-render this shell, so they land in a ref. `restoredRenewalsUi` is the
   * copy a mounting tab reads, taken from the ref while the tab is being left — the one moment the
   * retained value matters to a render. Task 16.12 adds the Cancellations pair beside these two.
   */
  const renewalsUi = useRef<RenewalsUiState>(INITIAL_RENEWALS_UI);
  const [restoredRenewalsUi, setRestoredRenewalsUi] = useState<RenewalsUiState>(INITIAL_RENEWALS_UI);
  const retainRenewalsUi = useCallback((next: RenewalsUiState) => { renewalsUi.current = next; }, []);

  /** Requirement 1.3: the tab being left hands over its three values, and the rest of it unmounts. */
  const selectTab = useCallback((next: PolicyFollowUpTabId) => {
    setRestoredRenewalsUi(renewalsUi.current);
    setActiveTab(next);
  }, []);

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
          {POLICY_FOLLOW_UP_TABS.map((tab) => {
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
          {activeTab === 'renewals' ? (
            <RenewalsPage
              initialProfile={initialProfile}
              embedded
              initialUiState={restoredRenewalsUi}
              onUiStateChange={retainRenewalsUi}
            />
          ) : (
            /* Inert until task 16.12 puts `CancellationsPage` here: text, and not one control. */
            <div className={ui.empty}>
              <p>The Cancellations queue is not part of this build yet.</p>
              <p className="mt-1">Nothing is imported, sent, or stored from this tab.</p>
            </div>
          )}
        </div>
      </div>
    </ModuleShell>
  );
}

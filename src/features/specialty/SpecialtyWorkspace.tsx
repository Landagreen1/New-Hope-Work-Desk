'use client';

/**
 * Specialty Quotes — one module for every specialty line of business.
 *
 * Not a Trucking board and a Homeowners board. Not a Trucking database and a
 * Homeowners database. One workspace, three destinations, and the line of business is
 * a filter rather than an application. Adding Commercial later is a routing row and a
 * workflow template, not another screen.
 *
 * The three destinations:
 *   Work    — the operational surface. Opens on all of the team's active work.
 *   Quotes  — search and browse everything, closed included.
 *   Reports — pipeline, workload, contribution, timing, carriers, lost business.
 *
 * Team administration is deliberately absent: it is a settings screen and lives under
 * User Administration, so this module stays small.
 */

import { AlertCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ModuleShell } from '../nhwd-shared/ModuleShell';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import { getWorkspaceContext } from './api';
import OpportunityDrawer from './OpportunityDrawer';
import { getSpecialtyPermissions } from './permissions';
import SpecialtyList from './SpecialtyList';
import SpecialtyReports from './SpecialtyReports';
import { lineLabel } from './status';
import type { AppRole } from '@/lib/types';
import type { WorkspaceContext } from './types';

export type SpecialtySection = 'work' | 'quotes' | 'reports';

const SECTIONS: { id: SpecialtySection; label: string; hint: string }[] = [
  { id: 'work', label: 'Work', hint: 'What the team is working, and what needs attention.' },
  { id: 'quotes', label: 'Quotes', hint: 'Search every specialty quote, open or closed.' },
  { id: 'reports', label: 'Reports', hint: 'Pipeline, workload, carriers and outcomes.' },
];

export interface SpecialtyWorkspaceProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
  /** Which destination to open on, set by the sidebar. */
  activeSection?: SpecialtySection;
}

export default function SpecialtyWorkspace({
  initialProfile,
  embedded = false,
  activeSection = 'work',
}: SpecialtyWorkspaceProps) {
  const role = initialProfile.role as AppRole;

  const [section, setSection] = useState<SpecialtySection>(activeSection);
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /** Bumped whenever a drawer action changes something, so the list refetches. */
  const [refreshToken, setRefreshToken] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    setSection(activeSection);
  }, [activeSection]);

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

  const permissions = useMemo(() => getSpecialtyPermissions(role, context), [context, role]);

  const sections = useMemo(
    () => SECTIONS.filter((entry) => entry.id !== 'reports' || permissions.canViewReports),
    [permissions.canViewReports],
  );

  const subtitle = useMemo(() => {
    if (!context) return 'Trucking and Homeowners quoting, worked as a team.';
    const lines = Array.from(new Set(context.lines_of_business.map((route) => route.line_of_business)));
    if (lines.length === 0) {
      return 'You have specialty access but no line of business is routed to your team yet.';
    }
    return `${lines.map(lineLabel).join(' and ')} quoting, worked as a team. A quote you are not assigned is still yours to help with.`;
  }, [context]);

  if (loading && !context) {
    return (
      <div className="grid min-h-[420px] place-items-center rounded-[28px] border border-slate-200 bg-white font-black text-slate-500 shadow-sm">
        Loading Specialty Quotes…
      </div>
    );
  }

  /**
   * No membership, no module.
   *
   * This is a courtesy message, not the access control: `specialty_can_access()` and
   * the RLS policies refuse the same account at the database, so a direct API call
   * gets nothing either.
   */
  if (error || !context) {
    return (
      <div className="grid min-h-[40vh] place-items-center p-6">
        <div className={`${ui.error} flex max-w-xl items-start gap-2`}>
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
      </div>
    );
  }

  return (
    <ModuleShell
      title="Specialty Quotes"
      subtitle={subtitle}
      role={role}
      lastUpdated={lastUpdated}
      onRefresh={() => {
        void load();
        setRefreshToken((current) => current + 1);
      }}
      embedded={embedded}
    >
      <nav
        aria-label="Specialty Quotes sections"
        className="mb-5 flex flex-wrap gap-1 rounded-2xl bg-slate-100 p-1.5"
      >
        {sections.map((entry) => (
          <button
            key={entry.id}
            type="button"
            title={entry.hint}
            onClick={() => setSection(entry.id)}
            aria-current={section === entry.id ? 'page' : undefined}
            className={`rounded-xl px-4 py-2.5 text-sm font-black transition ${
              section === entry.id ? 'bg-[#223f7a] text-white shadow-sm' : 'text-slate-600 hover:bg-white'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {context.lines_of_business.length === 0 ? (
        <div className={`${ui.info} mb-5`}>
          You are a member of a quoting team, but no line of business is routed to it yet. A manager
          sets that under User Administration → Quoting Teams.
        </div>
      ) : null}

      {section === 'reports' ? (
        <SpecialtyReports context={context} onOpen={setOpenId} />
      ) : (
        <SpecialtyList
          key={section}
          profileId={initialProfile.id}
          context={context}
          mode={section === 'work' ? 'work' : 'quotes'}
          onOpen={setOpenId}
          refreshToken={refreshToken}
        />
      )}

      {openId ? (
        <OpportunityDrawer
          opportunityId={openId}
          profileId={initialProfile.id}
          context={context}
          onClose={() => setOpenId(null)}
          onChanged={() => setRefreshToken((current) => current + 1)}
        />
      ) : null}
    </ModuleShell>
  );
}

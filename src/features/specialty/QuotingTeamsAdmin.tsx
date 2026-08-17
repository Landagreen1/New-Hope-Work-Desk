'use client';

/**
 * Quoting Teams administration.
 *
 * Lives under User Administration rather than inside Specialty Quotes: it is a
 * settings screen, not a quoting screen, and the module is deliberately kept to
 * three destinations.
 *
 * What it is for: changing who handles a type of insurance must not require a
 * developer or a migration. Everything on this screen writes to `quoting_teams`,
 * `quoting_team_members` and `quoting_team_lob_routes`, and every authorization
 * predicate in the database reads those same tables — so a brand new team with new
 * members and a new line-of-business route works immediately, with no change to
 * authorization logic anywhere.
 *
 * Two safety behaviours are worth knowing about, both enforced server-side and
 * surfaced here:
 *   * Removing a member who still holds active assignments is refused until a
 *     transfer target is named. Their history and their membership row are kept
 *     either way — nothing is deleted.
 *   * A team cannot be deactivated while it is the only active destination for a
 *     line of business that is still receiving intakes.
 */

import { AlertTriangle, Plus, RefreshCw, Users, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ModuleShell } from '../nhwd-shared/ModuleShell';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import {
  getTeamsAdmin,
  removeTeamMember,
  saveTeam,
  saveTeamMember,
  setLineRoute,
} from './api';
import { canAdministerQuotingTeams } from './permissions';
import { lineLabel, titleCase } from './status';
import type { AppRole } from '@/lib/types';
import type { AssignmentMethod, TeamAdmin, TeamsAdminPayload } from './types';

const ASSIGNMENT_METHODS: { id: AssignmentMethod; label: string; hint: string }[] = [
  {
    id: 'shared_claim',
    label: 'Shared Claim',
    hint: 'Everyone eligible sees incoming work and one of them claims it. What Trucking and Homeowners use.',
  },
  {
    id: 'manual_assignment',
    label: 'Manual Assignment',
    hint: 'A manager or team lead assigns each quote. Members cannot self-claim.',
  },
  {
    id: 'automatic_balanced',
    label: 'Automatic Balanced',
    hint: 'Reserved. Stored on the team; automatic distribution is not implemented yet.',
  },
  {
    id: 'round_robin',
    label: 'Round Robin',
    hint: 'Reserved. Stored on the team; rotation is not implemented yet.',
  },
];

const CAPABILITIES: { key: keyof CapabilityState; label: string; hint: string }[] = [
  { key: 'canView', label: 'View', hint: 'See the team\u2019s quotes.' },
  { key: 'canClaim', label: 'Claim', hint: 'Take primary responsibility for unclaimed work.' },
  { key: 'canEdit', label: 'Edit', hint: 'Work any of the team\u2019s quotes, not only their own.' },
  { key: 'canBeAssigned', label: 'Be assigned', hint: 'Can hold primary responsibility.' },
  { key: 'canReassign', label: 'Transfer', hint: 'Move responsibility between members.' },
  { key: 'canViewReports', label: 'Reports', hint: 'See the team\u2019s reporting.' },
];

interface CapabilityState {
  canView: boolean;
  canClaim: boolean;
  canEdit: boolean;
  canBeAssigned: boolean;
  canReassign: boolean;
  canViewReports: boolean;
}

const FULL_CAPABILITIES: CapabilityState = {
  canView: true,
  canClaim: true,
  canEdit: true,
  canBeAssigned: true,
  canReassign: true,
  canViewReports: true,
};

export interface QuotingTeamsAdminProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
}

export default function QuotingTeamsAdmin({ initialProfile, embedded = false }: QuotingTeamsAdminProps) {
  const role = initialProfile.role as AppRole;
  const allowed = canAdministerQuotingTeams(role);

  const [payload, setPayload] = useState<TeamsAdminPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPayload(await getTeamsAdmin());
      setLastUpdated(new Date());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Quoting teams could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    void load();
  }, [allowed, load]);

  const run = useCallback(
    async (action: () => Promise<void>, success: string) => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await action();
        setNotice(success);
        await load();
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'That change could not be saved.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, load],
  );

  if (!allowed) {
    return (
      <div className="grid min-h-[40vh] place-items-center p-6">
        <div className={ui.error}>Quoting Teams is available to managers and super admins.</div>
      </div>
    );
  }

  return (
    <ModuleShell
      title="Quoting Teams"
      subtitle="Who handles which line of insurance. Changing a team, its members or its routing takes effect immediately — no migration and no developer."
      role={role}
      lastUpdated={lastUpdated}
      onRefresh={() => void load()}
      embedded={embedded}
    >
      {error ? <div className={`${ui.error} mb-5`}>{error}</div> : null}
      {notice ? <div className={`${ui.success} mb-5`}>{notice}</div> : null}

      {/* Routing. The question "where does a submitted intake go" has one answer. */}
      <section className={`${ui.card} mb-5`}>
        <div className={ui.cardHeader}>
          <div>
            <p className={ui.sectionTitle}>Line-of-business routing</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              Customer Service never picks a person. The line of business picks the team. Commercial GL
              is absent on purpose — it still routes to the Commercial Board.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Line of business</th>
                <th className={ui.th}>Receiving team</th>
                <th className={ui.th}>Change</th>
              </tr>
            </thead>
            <tbody>
              {(payload?.routes ?? []).map((route) => (
                <tr key={route.line_of_business}>
                  <td className={ui.td}>
                    <span className="font-black text-slate-900">
                      {lineLabel(route.line_of_business)}
                    </span>
                  </td>
                  <td className={ui.td}>{route.team_name}</td>
                  <td className={ui.td}>
                    <select
                      className={ui.select}
                      value={route.team_id}
                      disabled={busy}
                      onChange={(event) => {
                        const teamId = event.target.value;
                        if (teamId === route.team_id) return;
                        void run(
                          () => setLineRoute(route.line_of_business, teamId),
                          `${lineLabel(route.line_of_business)} intakes now go to that team.`,
                        );
                      }}
                    >
                      {(payload?.teams ?? [])
                        .filter((team) => team.is_active)
                        .map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}
                          </option>
                        ))}
                    </select>
                  </td>
                </tr>
              ))}
              {(payload?.routes ?? []).length === 0 && !loading ? (
                <tr>
                  <td className={ui.td} colSpan={3}>
                    No routing configured. A submitted Trucking or Homeowners intake will be refused
                    until a team is set here.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className={ui.sectionTitle}>Teams</p>
        <div className="flex items-center gap-2">
          {loading ? <RefreshCw className="h-4 w-4 animate-spin text-slate-400" aria-hidden /> : null}
          <button type="button" className={ui.btnPrimary} onClick={() => setCreating((c) => !c)}>
            <Plus className="h-4 w-4" />
            Create team
          </button>
        </div>
      </div>

      {creating ? (
        <section className={`${ui.card} ${ui.cardPad} mb-5`}>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className={ui.label}>Team name</span>
              <input
                className={ui.input}
                value={newTeamName}
                onChange={(event) => setNewTeamName(event.target.value)}
                placeholder="e.g. Commercial Team"
              />
            </label>
            <div className="flex items-end gap-2">
              <button
                type="button"
                className={ui.btnPrimary}
                disabled={busy || newTeamName.trim() === ''}
                onClick={() =>
                  void run(async () => {
                    await saveTeam({ name: newTeamName, assignmentMethod: 'shared_claim' });
                  }, 'The team was created. Add members and set its routing.').then((ok) => {
                    if (ok) {
                      setNewTeamName('');
                      setCreating(false);
                    }
                  })
                }
              >
                Create
              </button>
              <button type="button" className={ui.btnGhost} onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <div className="space-y-5">
        {(payload?.teams ?? []).map((team) => (
          <TeamCard
            key={team.id}
            team={team}
            payload={payload!}
            run={run}
            busy={busy}
          />
        ))}
        {(payload?.teams ?? []).length === 0 && !loading ? (
          <p className={ui.empty}>No quoting teams yet.</p>
        ) : null}
      </div>
    </ModuleShell>
  );
}

function TeamCard({
  team,
  payload,
  run,
  busy,
}: {
  team: TeamAdmin;
  payload: TeamsAdminPayload;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  busy: boolean;
}) {
  const [addingMember, setAddingMember] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState('');
  const [reassignTo, setReassignTo] = useState('');
  /** How many quotes the last removal transferred. Shown so it is not a silent side effect. */
  const [transferred, setTransferred] = useState<number | null>(null);

  const currentMemberIds = new Set(
    team.members.filter((member) => member.is_active).map((member) => member.profile_id),
  );
  const candidates = payload.assignable_profiles.filter(
    (profile) => !currentMemberIds.has(profile.profile_id),
  );
  const removingMember = team.members.find((member) => member.profile_id === removing);
  const transferTargets = team.members.filter(
    (member) => member.is_active && member.can_be_assigned && member.profile_id !== removing,
  );

  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-black text-slate-950">{team.name}</h3>
            <span className={`${ui.badge} ${team.is_active ? ui.badgeTone.success : ui.badgeTone.neutral}`}>
              {team.is_active ? 'Active' : 'Inactive'}
            </span>
            {team.lines_of_business.map((line) => (
              <span key={line} className={`${ui.badge} ${ui.badgeTone.info}`}>
                {lineLabel(line)}
              </span>
            ))}
            <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>
              {team.active_opportunity_count} active quote
              {team.active_opportunity_count === 1 ? '' : 's'}
            </span>
          </div>
          {team.description ? (
            <p className="mt-1 text-sm font-semibold text-slate-500">{team.description}</p>
          ) : null}
          {transferred !== null && transferred > 0 ? (
            <p className="mt-1 text-sm font-bold text-emerald-700">
              {transferred} active quote{transferred === 1 ? '' : 's'} transferred during the last
              removal. Each transfer was recorded on the quote&rsquo;s timeline.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={team.is_active ? ui.btnDanger : ui.btnSecondary}
            disabled={busy}
            onClick={() =>
              void run(
                async () => {
                  await saveTeam({
                    teamId: team.id,
                    name: team.name,
                    description: team.description,
                    assignmentMethod: team.assignment_method,
                    collaborativeEditing: team.collaborative_editing,
                    teamVisibility: team.team_visibility,
                    isActive: !team.is_active,
                  });
                },
                team.is_active ? `${team.name} was deactivated.` : `${team.name} was activated.`,
              )
            }
          >
            {team.is_active ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </div>

      <div className="grid gap-4 border-b border-slate-100 p-5 sm:grid-cols-2 sm:p-6">
        <label className="block">
          <span className={ui.label}>Assignment method</span>
          <select
            className={ui.select}
            value={team.assignment_method}
            disabled={busy}
            onChange={(event) =>
              void run(async () => {
                await saveTeam({
                  teamId: team.id,
                  name: team.name,
                  description: team.description,
                  assignmentMethod: event.target.value,
                  collaborativeEditing: team.collaborative_editing,
                  teamVisibility: team.team_visibility,
                  isActive: team.is_active,
                });
              }, 'The assignment method was saved.')
            }
          >
            {ASSIGNMENT_METHODS.map((method) => (
              <option key={method.id} value={method.id}>
                {method.label}
              </option>
            ))}
          </select>
          <span className="mt-1.5 block text-xs font-semibold text-slate-400">
            {ASSIGNMENT_METHODS.find((method) => method.id === team.assignment_method)?.hint}
          </span>
        </label>

        <div>
          <span className={ui.label}>Collaborative editing</span>
          <label className={`${ui.checkboxRow} mt-2`}>
            <input
              type="checkbox"
              checked={team.collaborative_editing}
              disabled={busy}
              onChange={(event) =>
                void run(async () => {
                  await saveTeam({
                    teamId: team.id,
                    name: team.name,
                    description: team.description,
                    assignmentMethod: team.assignment_method,
                    collaborativeEditing: event.target.checked,
                    teamVisibility: team.team_visibility,
                    isActive: team.is_active,
                  });
                }, 'The collaboration setting was saved.')
              }
            />
            Any editing member can work any of the team&rsquo;s quotes
          </label>
          <span className="mt-1.5 block text-xs font-semibold text-slate-400">
            Leave this on. Turning it off restricts editing to the primary assignee, which is the
            behaviour this engine was built to replace.
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>Member</th>
              <th className={ui.th}>Role</th>
              {CAPABILITIES.map((capability) => (
                <th key={capability.key} className={ui.th} title={capability.hint}>
                  {capability.label}
                </th>
              ))}
              <th className={ui.th}>Active quotes</th>
              <th className={ui.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {team.members.map((member) => (
              <tr key={member.profile_id} className={member.is_active ? '' : 'opacity-50'}>
                <td className={ui.td}>
                  <span className="inline-flex items-center gap-2">
                    <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#eef3fb] text-[10px] font-black text-[#223f7a]">
                      {member.initials}
                    </span>
                    <span className="font-black text-slate-900">{member.display_name}</span>
                  </span>
                  {!member.is_active ? (
                    <p className="mt-0.5 text-xs font-bold text-slate-400">
                      Removed{member.removed_reason ? ` — ${member.removed_reason}` : ''}. History kept.
                    </p>
                  ) : null}
                </td>
                <td className={ui.td}>{titleCase(member.role)}</td>
                {CAPABILITIES.map((capability) => {
                  const dbKey = {
                    canView: 'can_view',
                    canClaim: 'can_claim',
                    canEdit: 'can_edit',
                    canBeAssigned: 'can_be_assigned',
                    canReassign: 'can_reassign',
                    canViewReports: 'can_view_reports',
                  }[capability.key] as keyof typeof member;
                  const checked = Boolean(member[dbKey]);
                  return (
                    <td key={capability.key} className={ui.td}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy || !member.is_active}
                        onChange={(event) =>
                          void run(
                            () =>
                              saveTeamMember({
                                teamId: team.id,
                                profileId: member.profile_id,
                                canView:
                                  capability.key === 'canView' ? event.target.checked : member.can_view,
                                canClaim:
                                  capability.key === 'canClaim' ? event.target.checked : member.can_claim,
                                canEdit:
                                  capability.key === 'canEdit' ? event.target.checked : member.can_edit,
                                canBeAssigned:
                                  capability.key === 'canBeAssigned'
                                    ? event.target.checked
                                    : member.can_be_assigned,
                                canReassign:
                                  capability.key === 'canReassign'
                                    ? event.target.checked
                                    : member.can_reassign,
                                canViewReports:
                                  capability.key === 'canViewReports'
                                    ? event.target.checked
                                    : member.can_view_reports,
                              }),
                            `${member.display_name}\u2019s permissions were saved.`,
                          )
                        }
                      />
                    </td>
                  );
                })}
                <td className={ui.td}>{member.active_assignment_count}</td>
                <td className={ui.td}>
                  {member.is_active ? (
                    <button
                      type="button"
                      className={ui.btnDanger}
                      disabled={busy}
                      onClick={() => {
                        setRemoving(member.profile_id);
                        setRemoveReason('');
                        setReassignTo('');
                      }}
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={ui.btnSecondary}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            saveTeamMember({
                              teamId: team.id,
                              profileId: member.profile_id,
                              ...FULL_CAPABILITIES,
                            }),
                          `${member.display_name} was added back to ${team.name}.`,
                        )
                      }
                    >
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {team.members.length === 0 ? (
              <tr>
                <td className={ui.td} colSpan={CAPABILITIES.length + 4}>
                  No members yet. This team receives no work until somebody is added.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Removal, with the resolution the server requires. */}
      {removingMember ? (
        <div className="border-t border-slate-100 p-5 sm:p-6">
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
                <div>
                  <p className="text-sm font-black text-rose-900">
                    Remove {removingMember.display_name} from {team.name}?
                  </p>
                  <p className="mt-1 text-xs font-semibold text-rose-700">
                    Their membership record and everything they have done stays. They keep no ability
                    to claim or be assigned new work.
                    {removingMember.active_assignment_count > 0
                      ? ` They currently hold ${removingMember.active_assignment_count} active assignment(s), so a transfer target is required.`
                      : ''}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRemoving(null)}
                className="rounded-lg p-1.5 text-rose-500 hover:bg-rose-100"
                aria-label="Cancel removal"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={ui.label}>Reason</span>
                <input
                  className={ui.input}
                  value={removeReason}
                  onChange={(event) => setRemoveReason(event.target.value)}
                  placeholder="e.g. moved to another department"
                />
              </label>
              {removingMember.active_assignment_count > 0 ? (
                <label className="block">
                  <span className={ui.label}>Transfer their active quotes to</span>
                  <select
                    className={ui.select}
                    value={reassignTo}
                    onChange={(event) => setReassignTo(event.target.value)}
                  >
                    <option value="">Choose an employee</option>
                    {transferTargets.map((target) => (
                      <option key={target.profile_id} value={target.profile_id}>
                        {target.display_name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className={ui.btnDanger}
                disabled={
                  busy ||
                  (removingMember.active_assignment_count > 0 && reassignTo === '')
                }
                onClick={() =>
                  void run(async () => {
                    const result = await removeTeamMember(team.id, removingMember.profile_id, {
                      reason: removeReason,
                      reassignTo: reassignTo || null,
                    });
                    // How much moved is reported rather than left silent; the reload that
                    // follows shows the new assignee on each transferred quote.
                    setTransferred(result.reassigned_count);
                  }, `${removingMember.display_name} was removed from ${team.name}.`).then((ok) => {
                    if (ok) setRemoving(null);
                  })
                }
              >
                Remove member
              </button>
              <button type="button" className={ui.btnGhost} onClick={() => setRemoving(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Add a member. Any active employee, whatever their application role. */}
      <div className="border-t border-slate-100 p-5 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="block">
            <span className={ui.label}>
              <Users className="mr-1.5 inline h-3.5 w-3.5" />
              Add a member
            </span>
            <select
              className={ui.select}
              value={addingMember}
              onChange={(event) => setAddingMember(event.target.value)}
            >
              <option value="">Choose an employee</option>
              {candidates.map((candidate) => (
                <option key={candidate.profile_id} value={candidate.profile_id}>
                  {candidate.display_name} · {titleCase(candidate.role)}
                </option>
              ))}
            </select>
            <span className="mt-1.5 block text-xs font-semibold text-slate-400">
              Application role is a separate concept. A Customer Service rep and a Super Admin can
              both be ordinary members of the same quoting team.
            </span>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              className={ui.btnPrimary}
              disabled={busy || addingMember === ''}
              onClick={() =>
                void run(
                  () =>
                    saveTeamMember({
                      teamId: team.id,
                      profileId: addingMember,
                      ...FULL_CAPABILITIES,
                    }),
                  'The member was added with full collaborative access.',
                ).then((ok) => {
                  if (ok) setAddingMember('');
                })
              }
            >
              <Plus className="h-4 w-4" />
              Add
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

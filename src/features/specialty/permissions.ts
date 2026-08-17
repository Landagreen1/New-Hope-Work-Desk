/**
 * Named capabilities for Specialty Quotes.
 *
 * The organising rule of this file, and of the whole module: **access is team
 * membership, not application role, and assignment is accountability rather than
 * ownership.** Oscar and Jason are `super_admin`, Brenda is `customer_service`, and
 * all three are ordinary members of quoting teams. No `trucking_agent` or
 * `homeowners_agent` role exists and none is needed.
 *
 * Every function here mirrors a SQL predicate. These helpers decide what to render;
 * the database decides what is allowed. A user who defeats the UI still meets
 * `specialty_can_access()`, `specialty_can_view_opportunity()`,
 * `specialty_can_edit_opportunity()` and the RLS policies that call them.
 *
 * Kept free of `getSupabase` and of React so the rules can be property-tested
 * directly — see `__tests__/team-access.test.ts`.
 */

import type { AppRole } from '@/lib/types';
import { isBroadManagerRole } from '@/lib/permissions';
import type { SpecialtyLine, TeamMembership, WorkspaceContext } from './types';

/** The six configurable per-member capabilities. */
export type Capability = 'view' | 'claim' | 'edit' | 'assign' | 'reassign' | 'reports';

/**
 * The subset of a membership row the rules need.
 *
 * A structural type rather than the full row, so the mirror tests can build cases
 * without inventing team names and timestamps.
 */
export interface MembershipFacts {
  team_id: string;
  is_active: boolean;
  profile_is_active: boolean;
  team_is_active: boolean;
  collaborative_editing: boolean;
  can_view: boolean;
  can_claim: boolean;
  can_edit: boolean;
  can_be_assigned: boolean;
  can_reassign: boolean;
  can_view_reports: boolean;
}

/** Management oversight. Mirrors `public.specialty_is_manager()`. */
export function isSpecialtyManager(role: AppRole): boolean {
  return isBroadManagerRole(role);
}

/** Only a manager or super admin configures quoting teams. */
export function canAdministerQuotingTeams(role: AppRole): boolean {
  return isBroadManagerRole(role);
}

function capabilityHeld(membership: MembershipFacts, capability: Capability): boolean {
  switch (capability) {
    case 'view':
      return membership.can_view;
    case 'claim':
      return membership.can_claim;
    case 'edit':
      return membership.can_edit;
    case 'assign':
      return membership.can_be_assigned;
    case 'reassign':
      return membership.can_reassign;
    case 'reports':
      return membership.can_view_reports;
  }
}

function membershipUsable(membership: MembershipFacts): boolean {
  return membership.is_active && membership.team_is_active && membership.profile_is_active;
}

/**
 * Does this membership grant the capability?
 *
 * Mirrors `public.specialty_member_capability(team_id, capability)`. All three
 * active flags must hold: a retired member, a deactivated team and a deactivated
 * employee are each disqualifying on their own.
 */
export function memberCapability(
  memberships: readonly MembershipFacts[],
  teamId: string,
  capability: Capability,
): boolean {
  return memberships.some(
    (membership) =>
      membership.team_id === teamId &&
      membershipUsable(membership) &&
      capabilityHeld(membership, capability),
  );
}

/**
 * Can this user open the module at all?
 *
 * Mirrors `public.specialty_can_access()`. Note the shape: an unrelated Sales agent
 * with no membership is refused even though they can reach every other Sales screen,
 * and a manager is admitted without any membership at all.
 */
export function canAccessSpecialty(
  role: AppRole,
  memberships: readonly MembershipFacts[],
): boolean {
  if (isSpecialtyManager(role)) return true;
  return memberships.some((membership) => membershipUsable(membership) && membership.can_view);
}

/**
 * Can this user see a line of business?
 *
 * Mirrors `public.specialty_can_view_lob(line)`. This is the predicate that keeps
 * Brenda out of Trucking: she holds a viewing membership on the Homeowners team, and
 * reaching the module through that membership must not hand her another line.
 */
export function canViewLine(
  role: AppRole,
  line: SpecialtyLine,
  memberships: readonly MembershipFacts[],
  routes: readonly { line_of_business: SpecialtyLine; team_id: string }[],
): boolean {
  if (isSpecialtyManager(role)) return true;
  return routes.some(
    (route) =>
      route.line_of_business === line && memberCapability(memberships, route.team_id, 'view'),
  );
}

/**
 * Can this user read one opportunity?
 *
 * Mirrors `public.specialty_can_view_opportunity(id)`. Deliberately takes no
 * assignee argument: who is assigned has no bearing on who may read.
 */
export function canViewOpportunity(
  role: AppRole,
  opportunity: { team_id: string },
  memberships: readonly MembershipFacts[],
): boolean {
  if (isSpecialtyManager(role)) return true;
  return memberCapability(memberships, opportunity.team_id, 'view');
}

/**
 * Can this user edit one opportunity and its children?
 *
 * Mirrors `public.specialty_can_edit_opportunity(id)`. The assignee is consulted in
 * exactly one case — a team whose `collaborative_editing` has been switched off. For
 * a collaborative team, which is the default and what both initial teams use, an
 * editing member may work every one of the team's quotes: Oscar edits Jason's
 * trucking quote, Brenda edits Oscar's homeowners quote.
 */
export function canEditOpportunity(
  role: AppRole,
  opportunity: { team_id: string; primary_assignee_id: string | null },
  memberships: readonly MembershipFacts[],
  userId: string,
): boolean {
  if (isSpecialtyManager(role)) return true;
  const membership = memberships.find(
    (candidate) =>
      candidate.team_id === opportunity.team_id &&
      membershipUsable(candidate) &&
      candidate.can_edit,
  );
  if (!membership) return false;
  if (membership.collaborative_editing) return true;
  return opportunity.primary_assignee_id === userId;
}

/** Mirrors `public.specialty_can_claim_opportunity(id)`. */
export function canClaimOpportunity(
  role: AppRole,
  opportunity: { team_id: string },
  memberships: readonly MembershipFacts[],
): boolean {
  return (
    isSpecialtyManager(role) || memberCapability(memberships, opportunity.team_id, 'claim')
  );
}

/** Mirrors `public.specialty_can_reassign_opportunity(id)`. */
export function canReassignOpportunity(
  role: AppRole,
  opportunity: { team_id: string },
  memberships: readonly MembershipFacts[],
): boolean {
  return (
    isSpecialtyManager(role) || memberCapability(memberships, opportunity.team_id, 'reassign')
  );
}

/** Mirrors `public.specialty_can_view_reports()`. */
export function canViewSpecialtyReports(
  role: AppRole,
  memberships: readonly MembershipFacts[],
): boolean {
  if (isSpecialtyManager(role)) return true;
  return memberships.some(
    (membership) => membershipUsable(membership) && membership.can_view_reports,
  );
}

/**
 * Only a manager reopens a closed quote.
 *
 * Mirrors the gate in `public.specialty_clear_result`. The outcome has already been
 * reported on, so undoing it is an oversight act rather than ordinary quoting work.
 */
export function canReopenResult(role: AppRole): boolean {
  return isSpecialtyManager(role);
}

/**
 * Turns the server's workspace context into the membership facts these rules take.
 *
 * `specialty_workspace_context` only ever returns usable memberships — it filters on
 * the same three active flags — so the flags are set true here rather than invented.
 */
export function membershipsFromContext(context: WorkspaceContext): MembershipFacts[] {
  return context.my_teams.map((team: TeamMembership) => ({
    team_id: team.team_id,
    is_active: true,
    profile_is_active: true,
    team_is_active: true,
    collaborative_editing: team.collaborative_editing,
    can_view: team.can_view,
    can_claim: team.can_claim,
    can_edit: team.can_edit,
    can_be_assigned: team.can_be_assigned,
    can_reassign: team.can_reassign,
    can_view_reports: team.can_view_reports,
  }));
}

/** Everything a Specialty screen needs to decide what to render. */
export interface SpecialtyPermissions {
  isManager: boolean;
  canAdministerTeams: boolean;
  canViewReports: boolean;
  canClaimAnywhere: boolean;
  visibleLines: SpecialtyLine[];
}

export function getSpecialtyPermissions(
  role: AppRole,
  context: WorkspaceContext | null,
): SpecialtyPermissions {
  const memberships = context ? membershipsFromContext(context) : [];
  return {
    isManager: isSpecialtyManager(role),
    canAdministerTeams: canAdministerQuotingTeams(role),
    canViewReports: canViewSpecialtyReports(role, memberships),
    canClaimAnywhere:
      isSpecialtyManager(role) ||
      memberships.some((membership) => membership.can_claim && membership.is_active),
    visibleLines: Array.from(
      new Set((context?.lines_of_business ?? []).map((route) => route.line_of_business)),
    ),
  };
}

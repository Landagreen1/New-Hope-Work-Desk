/**
 * The Specialty Quotes access rules, tested as rules.
 *
 * The helpers in `../permissions.ts` are declared to mirror named SQL predicates.
 * These tests pin the behaviour of the mirror so a change to one side without the
 * other shows up here rather than in production — and, more usefully, they state the
 * spec's mandatory access scenarios as executable claims.
 *
 * The property tests are the interesting ones. The single most important rule in this
 * engine is that **assignment is accountability, not access**: no amount of shuffling
 * who is assigned may change who can read or write. `fc.assert` is how that is stated
 * for every assignment rather than for one example.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  canAccessSpecialty,
  canAdministerQuotingTeams,
  canClaimOpportunity,
  canEditOpportunity,
  canReassignOpportunity,
  canReopenResult,
  canViewLine,
  canViewOpportunity,
  canViewSpecialtyReports,
  isSpecialtyManager,
  memberCapability,
  membershipsFromContext,
  type MembershipFacts,
} from '../permissions';
import type { AppRole } from '@/lib/types';
import type { SpecialtyLine, WorkspaceContext } from '../types';

const TRUCKING_TEAM = 'team-trucking';
const HOMEOWNERS_TEAM = 'team-homeowners';

const ROUTES: { line_of_business: SpecialtyLine; team_id: string }[] = [
  { line_of_business: 'trucking', team_id: TRUCKING_TEAM },
  { line_of_business: 'homeowners', team_id: HOMEOWNERS_TEAM },
];

function fullMember(teamId: string, overrides: Partial<MembershipFacts> = {}): MembershipFacts {
  return {
    team_id: teamId,
    is_active: true,
    profile_is_active: true,
    team_is_active: true,
    collaborative_editing: true,
    can_view: true,
    can_claim: true,
    can_edit: true,
    can_be_assigned: true,
    can_reassign: true,
    can_view_reports: true,
    ...overrides,
  };
}

// The three initial members, exactly as the v1.16.0 seed configures them. Note that
// nothing here is keyed on a name: the fixtures are memberships, and the display names
// exist only so the test reads like the requirement it is checking.
const OSCAR = { id: 'oscar', role: 'super_admin' as AppRole, teams: [TRUCKING_TEAM, HOMEOWNERS_TEAM] };
const JASON = { id: 'jason', role: 'super_admin' as AppRole, teams: [TRUCKING_TEAM, HOMEOWNERS_TEAM] };
const BRENDA = { id: 'brenda', role: 'customer_service' as AppRole, teams: [HOMEOWNERS_TEAM] };
/** A Sales agent who is not on any quoting team. */
const OUTSIDER = { id: 'outsider', role: 'agent' as AppRole, teams: [] as string[] };
/** A manager with no membership at all: oversight comes from the role. */
const MANAGER = { id: 'manager', role: 'manager' as AppRole, teams: [] as string[] };

function membershipsFor(person: { teams: string[] }): MembershipFacts[] {
  return person.teams.map((teamId) => fullMember(teamId));
}

describe('module access is membership, not role', () => {
  it('admits a member of any active team', () => {
    expect(canAccessSpecialty(BRENDA.role, membershipsFor(BRENDA))).toBe(true);
    expect(canAccessSpecialty(OSCAR.role, membershipsFor(OSCAR))).toBe(true);
  });

  it('refuses a Sales agent with no membership, even though they reach every Sales screen', () => {
    expect(canAccessSpecialty(OUTSIDER.role, membershipsFor(OUTSIDER))).toBe(false);
  });

  it('admits a manager with no membership, for oversight', () => {
    expect(canAccessSpecialty(MANAGER.role, [])).toBe(true);
  });

  it('refuses a member whose team has been deactivated', () => {
    expect(
      canAccessSpecialty('agent', [fullMember(TRUCKING_TEAM, { team_is_active: false })]),
    ).toBe(false);
  });

  it('refuses a retired member', () => {
    expect(canAccessSpecialty('agent', [fullMember(TRUCKING_TEAM, { is_active: false })])).toBe(
      false,
    );
  });

  it('refuses a deactivated employee who is still listed on the team', () => {
    expect(
      canAccessSpecialty('agent', [fullMember(TRUCKING_TEAM, { profile_is_active: false })]),
    ).toBe(false);
  });

  it('refuses a member whose only capability is something other than view', () => {
    expect(
      canAccessSpecialty('agent', [fullMember(TRUCKING_TEAM, { can_view: false })]),
    ).toBe(false);
  });
});

describe('line-of-business visibility follows the team, not the module', () => {
  it('gives Oscar and Jason both lines', () => {
    for (const person of [OSCAR, JASON]) {
      expect(canViewLine(person.role, 'trucking', membershipsFor(person), ROUTES)).toBe(true);
      expect(canViewLine(person.role, 'homeowners', membershipsFor(person), ROUTES)).toBe(true);
    }
  });

  it('gives Brenda Homeowners', () => {
    expect(canViewLine(BRENDA.role, 'homeowners', membershipsFor(BRENDA), ROUTES)).toBe(true);
  });

  /**
   * The scenario the spec calls out by name. Brenda can reach the Specialty module
   * because she is on the Homeowners team; that must not hand her Trucking.
   */
  it('denies Brenda Trucking, even though she can open the module', () => {
    const memberships = membershipsFor(BRENDA);
    expect(canAccessSpecialty(BRENDA.role, memberships)).toBe(true);
    expect(canViewLine(BRENDA.role, 'trucking', memberships, ROUTES)).toBe(false);
  });

  it('denies every line to somebody with no membership', () => {
    for (const line of ['trucking', 'homeowners'] as SpecialtyLine[]) {
      expect(canViewLine(OUTSIDER.role, line, [], ROUTES)).toBe(false);
    }
  });

  it('gives a manager every line without any membership', () => {
    expect(canViewLine(MANAGER.role, 'trucking', [], ROUTES)).toBe(true);
    expect(canViewLine(MANAGER.role, 'homeowners', [], ROUTES)).toBe(true);
  });

  it('follows a rerouted line without any code change', () => {
    // A manager moves Trucking to the Homeowners team. Brenda gains Trucking purely
    // because the routing row moved — which is the whole point of configuration-driven
    // teams.
    const rerouted = [
      { line_of_business: 'trucking' as SpecialtyLine, team_id: HOMEOWNERS_TEAM },
      { line_of_business: 'homeowners' as SpecialtyLine, team_id: HOMEOWNERS_TEAM },
    ];
    expect(canViewLine(BRENDA.role, 'trucking', membershipsFor(BRENDA), rerouted)).toBe(true);
  });
});

describe('reading and editing one opportunity', () => {
  const truckingQuote = { team_id: TRUCKING_TEAM, primary_assignee_id: JASON.id };
  const homeownersQuote = { team_id: HOMEOWNERS_TEAM, primary_assignee_id: BRENDA.id };

  it('lets Oscar read and work a Trucking quote assigned to Jason', () => {
    const memberships = membershipsFor(OSCAR);
    expect(canViewOpportunity(OSCAR.role, truckingQuote, memberships)).toBe(true);
    expect(canEditOpportunity(OSCAR.role, truckingQuote, memberships, OSCAR.id)).toBe(true);
  });

  it('lets Oscar and Jason work a Homeowners quote assigned to Brenda', () => {
    for (const person of [OSCAR, JASON]) {
      expect(
        canEditOpportunity(person.role, homeownersQuote, membershipsFor(person), person.id),
      ).toBe(true);
    }
  });

  it('lets Brenda work a Homeowners quote assigned to Oscar', () => {
    expect(
      canEditOpportunity(
        BRENDA.role,
        { team_id: HOMEOWNERS_TEAM, primary_assignee_id: OSCAR.id },
        membershipsFor(BRENDA),
        BRENDA.id,
      ),
    ).toBe(true);
  });

  it('does not let Brenda read a Trucking quote', () => {
    expect(canViewOpportunity(BRENDA.role, truckingQuote, membershipsFor(BRENDA))).toBe(false);
    expect(canEditOpportunity(BRENDA.role, truckingQuote, membershipsFor(BRENDA), BRENDA.id)).toBe(
      false,
    );
  });

  it('does not let a non-member read anything', () => {
    expect(canViewOpportunity(OUTSIDER.role, truckingQuote, [])).toBe(false);
    expect(canViewOpportunity(OUTSIDER.role, homeownersQuote, [])).toBe(false);
  });

  it('restricts editing to the assignee only when the team turns collaboration off', () => {
    const strict = [fullMember(TRUCKING_TEAM, { collaborative_editing: false })];
    expect(canEditOpportunity('agent', truckingQuote, strict, JASON.id)).toBe(true);
    expect(canEditOpportunity('agent', truckingQuote, strict, OSCAR.id)).toBe(false);
    // And the same person can still READ it: the setting narrows writing, not access.
    expect(canViewOpportunity('agent', truckingQuote, strict)).toBe(true);
  });

  it('honours a member whose edit capability was withdrawn', () => {
    const viewOnly = [fullMember(HOMEOWNERS_TEAM, { can_edit: false })];
    expect(canViewOpportunity('agent', homeownersQuote, viewOnly)).toBe(true);
    expect(canEditOpportunity('agent', homeownersQuote, viewOnly, 'someone')).toBe(false);
  });
});

describe('assignment is accountability, not access', () => {
  /**
   * The core architectural rule, as a property.
   *
   * For every possible assignee — a teammate, a stranger, or nobody — a collaborative
   * team member's ability to read and to write is unchanged. If this ever fails, the
   * engine has regressed to the model it was built to replace.
   */
  it('read and write access is independent of who is assigned', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<string | null>(OSCAR.id, JASON.id, BRENDA.id, 'stranger', null),
        (assignee) => {
          const quote = { team_id: HOMEOWNERS_TEAM, primary_assignee_id: assignee };
          const memberships = membershipsFor(OSCAR);
          return (
            canViewOpportunity(OSCAR.role, quote, memberships) &&
            canEditOpportunity(OSCAR.role, quote, memberships, OSCAR.id)
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a non-member gains nothing by being named the assignee', () => {
    // A stale or mistaken assignment must not be a back door into another team's work.
    fc.assert(
      fc.property(fc.constantFrom(TRUCKING_TEAM, HOMEOWNERS_TEAM), (teamId) => {
        const quote = { team_id: teamId, primary_assignee_id: OUTSIDER.id };
        return (
          canViewOpportunity(OUTSIDER.role, quote, []) === false &&
          canEditOpportunity(OUTSIDER.role, quote, [], OUTSIDER.id) === false
        );
      }),
      { numRuns: 100 },
    );
  });

  it('a Homeowners-only member is denied Trucking for every assignment', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<string | null>(BRENDA.id, OSCAR.id, JASON.id, null),
        (assignee) => {
          const quote = { team_id: TRUCKING_TEAM, primary_assignee_id: assignee };
          return canViewOpportunity(BRENDA.role, quote, membershipsFor(BRENDA)) === false;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('claiming and transferring', () => {
  const unclaimed = { team_id: TRUCKING_TEAM, primary_assignee_id: null };

  it('lets every eligible member of the team claim, which is what shared claim means', () => {
    for (const person of [OSCAR, JASON]) {
      expect(canClaimOpportunity(person.role, unclaimed, membershipsFor(person))).toBe(true);
    }
  });

  it('does not let a member of a different team claim', () => {
    expect(canClaimOpportunity(BRENDA.role, unclaimed, membershipsFor(BRENDA))).toBe(false);
  });

  it('respects a withdrawn claim capability while leaving viewing intact', () => {
    const cannotClaim = [fullMember(TRUCKING_TEAM, { can_claim: false })];
    expect(canClaimOpportunity('agent', unclaimed, cannotClaim)).toBe(false);
    expect(canViewOpportunity('agent', unclaimed, cannotClaim)).toBe(true);
  });

  it('lets the small specialty teams transfer between themselves', () => {
    expect(canReassignOpportunity(OSCAR.role, unclaimed, membershipsFor(OSCAR))).toBe(true);
  });

  it('respects a withdrawn transfer capability', () => {
    expect(
      canReassignOpportunity('agent', unclaimed, [
        fullMember(TRUCKING_TEAM, { can_reassign: false }),
      ]),
    ).toBe(false);
  });
});

describe('reports and administration', () => {
  it('gives a reporting member their own team figures', () => {
    expect(canViewSpecialtyReports(BRENDA.role, membershipsFor(BRENDA))).toBe(true);
  });

  it('withholds reports from a member without the capability', () => {
    expect(
      canViewSpecialtyReports('agent', [fullMember(TRUCKING_TEAM, { can_view_reports: false })]),
    ).toBe(false);
  });

  it('withholds reports from a non-member', () => {
    expect(canViewSpecialtyReports(OUTSIDER.role, [])).toBe(false);
  });

  it('limits team configuration to managers and super admins', () => {
    expect(canAdministerQuotingTeams('manager')).toBe(true);
    expect(canAdministerQuotingTeams('super_admin')).toBe(true);
    for (const role of [
      'agent',
      'customer_service',
      'commercial',
      'sales_supervisor',
      'commercial_supervisor',
      'customer_service_supervisor',
    ] as AppRole[]) {
      expect(canAdministerQuotingTeams(role)).toBe(false);
    }
  });

  it('limits reopening a closed quote to managers', () => {
    expect(canReopenResult('manager')).toBe(true);
    expect(canReopenResult('super_admin')).toBe(true);
    expect(canReopenResult('agent')).toBe(false);
    expect(canReopenResult('customer_service')).toBe(false);
  });

  it('treats super_admin as management everywhere it treats manager as management', () => {
    // Super-admin parity: every predicate that admits a manager admits a super admin.
    expect(isSpecialtyManager('manager')).toBe(isSpecialtyManager('super_admin'));
    expect(canAdministerQuotingTeams('manager')).toBe(canAdministerQuotingTeams('super_admin'));
    expect(canReopenResult('manager')).toBe(canReopenResult('super_admin'));
    expect(canAccessSpecialty('manager', [])).toBe(canAccessSpecialty('super_admin', []));
  });

  it('does not treat a scoped supervisor as specialty management', () => {
    // Scoped supervisors run a department, not the quoting teams.
    for (const role of [
      'sales_supervisor',
      'commercial_supervisor',
      'customer_service_supervisor',
    ] as AppRole[]) {
      expect(isSpecialtyManager(role)).toBe(false);
      expect(canAccessSpecialty(role, [])).toBe(false);
    }
  });
});

describe('capability lookup', () => {
  it('answers per team, not globally', () => {
    const memberships = [
      fullMember(TRUCKING_TEAM, { can_claim: false }),
      fullMember(HOMEOWNERS_TEAM, { can_claim: true }),
    ];
    expect(memberCapability(memberships, TRUCKING_TEAM, 'claim')).toBe(false);
    expect(memberCapability(memberships, HOMEOWNERS_TEAM, 'claim')).toBe(true);
  });

  it('answers false for a team the caller is not on', () => {
    expect(memberCapability(membershipsFor(BRENDA), TRUCKING_TEAM, 'view')).toBe(false);
  });

  it('covers all six capabilities', () => {
    const memberships = [fullMember(TRUCKING_TEAM)];
    for (const capability of ['view', 'claim', 'edit', 'assign', 'reassign', 'reports'] as const) {
      expect(memberCapability(memberships, TRUCKING_TEAM, capability)).toBe(true);
    }
  });
});

describe('membershipsFromContext', () => {
  it('carries each capability and the collaboration setting through unchanged', () => {
    const context: WorkspaceContext = {
      is_manager: false,
      can_view_reports: true,
      lines_of_business: [
        { line_of_business: 'homeowners', team_id: HOMEOWNERS_TEAM, team_name: 'Homeowners Team' },
      ],
      my_teams: [
        {
          team_id: HOMEOWNERS_TEAM,
          team_name: 'Homeowners Team',
          assignment_method: 'shared_claim',
          collaborative_editing: true,
          can_view: true,
          can_claim: true,
          can_edit: false,
          can_be_assigned: true,
          can_reassign: false,
          can_view_reports: true,
        },
      ],
      teammates: [],
      carriers: [],
    };

    const [membership] = membershipsFromContext(context);
    expect(membership.can_edit).toBe(false);
    expect(membership.can_reassign).toBe(false);
    expect(membership.collaborative_editing).toBe(true);
    // The server only returns usable memberships, so the three active flags are true.
    expect(membership.is_active && membership.team_is_active && membership.profile_is_active).toBe(
      true,
    );
    expect(canEditOpportunity('customer_service', { team_id: HOMEOWNERS_TEAM, primary_assignee_id: null }, [membership], 'x')).toBe(false);
  });
});

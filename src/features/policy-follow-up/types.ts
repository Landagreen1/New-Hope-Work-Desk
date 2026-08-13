// Policy Follow-up: the shared types the operational projection, My Work, and Manager Overview
// all read.
//
// Requirement 5.1 asks for one projection that can represent a renewal and a cancellation as the
// same *work item* without replacing either domain record. These types are that projection's shape.
// They are a read model: nothing in the application writes a `PolicyWorkItem` back, and every
// mutation still goes through the domain's own API and drawer (design 2).
//
// Types only — no runtime behavior, no imports from either domain.

import type { PolicyAssignmentMode, PolicyAssignmentSource, PolicySourceState } from './normalization';

// ---------------------------------------------------------------------------
// The work item (Requirement 5.1)
// ---------------------------------------------------------------------------

export type PolicyWorkDomain = 'renewal' | 'cancellation';

/**
 * The five buckets Requirement 6.2 groups assigned open work into.
 *
 * `waiting` is not a degree of urgency; it is the answer "nothing is due from you right now,
 * because this is waiting on the customer, a payment, or a verification". Keeping it in the same
 * union is what lets one list render all five sections from one sort.
 */
export type PolicyUrgencyBucket = 'critical' | 'today' | 'upcoming' | 'waiting' | 'later';

export const POLICY_URGENCY_BUCKETS = [
  'critical',
  'today',
  'upcoming',
  'waiting',
  'later',
] as const satisfies readonly PolicyUrgencyBucket[];

export const POLICY_URGENCY_LABELS: Readonly<Record<PolicyUrgencyBucket, string>> = {
  critical: 'Critical',
  today: 'Today',
  upcoming: 'Upcoming',
  waiting: 'Waiting',
  later: 'Later',
};

/** Why one item landed in `critical`, so the row can say so rather than just colour itself. */
export type PolicyCriticalReason =
  | 'action_overdue'
  | 'cancellation_imminent'
  | 'requote_required'
  | 'communication_failed';

export const POLICY_CRITICAL_REASON_LABELS: Readonly<Record<PolicyCriticalReason, string>> = {
  action_overdue: 'Follow-up overdue',
  cancellation_imminent: 'Cancelling within 3 days',
  requote_required: 'Requote not started',
  communication_failed: 'Message failed — contact by hand',
};

/**
 * One unit of assigned, open policy work.
 *
 * `sourceId` is the domain record id — `renewal_records.id` or `cancellation_cases.id` — and is
 * what the shell hands the existing drawer. There is no separate work-item identity to keep in
 * step, because there is no separate lifecycle table (Requirement 5.1).
 */
export interface PolicyWorkItem {
  domain: PolicyWorkDomain;
  sourceId: string;
  carrier: string | null;
  /** The normalized carrier key, present only where the row carries a readable carrier. */
  carrierKey: string | null;
  policyNumber: string;
  policyNumberNormalized: string | null;
  customerName: string;
  assignedTo: string | null;
  assignedName: string | null;
  /** The renewal date or the cancellation effective date. */
  eventDate: string | null;
  /** Whole calendar days from the business date to `eventDate`; negative once it has passed. */
  daysRemaining: number | null;
  /** True where `eventDate` is the collector's estimate rather than a confirmed date (Req 8.3). */
  eventDateEstimated: boolean;
  /** The operational status an agent reads. Never a raw stored enum and never Spanish. */
  normalizedStatus: string;
  /** The normalized collector source state, where the record came from a collector import. */
  sourceState: PolicySourceState | null;
  /** The one thing to do next, or `null` where nothing is required of anybody. */
  nextAction: string | null;
  /** When that action is due, where the domain records a due date for it. */
  actionDueDate: string | null;
  lastContactAt: string | null;
  /** Present only where the item is waiting on a recorded dependency (Requirement 6.2). */
  waitingReason: string | null;
  urgency: PolicyUrgencyBucket;
  criticalReasons: readonly PolicyCriticalReason[];
  workloadPoints: number;
  /** True where the record is held for manager review (Requirements 1.3, 1.4). */
  reviewRequired: boolean;
  /** True where automatic customer communication is withheld (Requirement 12.2). */
  communicationBlocked: boolean;
}

/** The four counters above the My Work list (Requirement 7.3). */
export interface PolicyWorkCounts {
  critical: number;
  today: number;
  upcoming: number;
  waiting: number;
  later: number;
}

// ---------------------------------------------------------------------------
// Shared ownership (Requirement 3.2)
// ---------------------------------------------------------------------------

/** One row of `policy_followup_policy_owners`. */
export interface PolicyOwner {
  id: string;
  carrier_key: string;
  policy_number_normalized: string;
  assigned_to: string | null;
  assignment_source: PolicyAssignmentSource;
  /** True where a manager fixed this ownership against future automatic reassignment (Req 3.5). */
  assignment_locked: boolean;
  assigned_by: string | null;
  assigned_at: string;
  last_auto_assigned_at: string | null;
  manager_note: string | null;
  /**
   * True where the bootstrap found the renewal and the cancellation for one policy assigned to
   * different employees and refused to guess (design 4.4). `assigned_to` stays null until a
   * manager chooses.
   */
  conflict: boolean;
  conflict_detail: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** One row of `policy_followup_agent_settings` (Requirement 3.4). */
export interface PolicyAgentSetting {
  profile_id: string;
  renewals_enabled: boolean;
  cancellations_enabled: boolean;
  auto_assignment_enabled: boolean;
  assignment_mode: PolicyAssignmentMode;
  created_at: string;
  updated_at: string;
}

/** One employee a manager may configure or assign to, with their current settings folded in. */
export interface PolicyEligibleAgent {
  profile_id: string;
  display_name: string;
  username: string | null;
  initials: string | null;
  role: string;
  is_active: boolean;
  renewals_enabled: boolean;
  cancellations_enabled: boolean;
  auto_assignment_enabled: boolean;
  assignment_mode: PolicyAssignmentMode;
}

/** One row of `policy_followup_assignment_events` (Requirement 13.2). */
export interface PolicyAssignmentEvent {
  id: string;
  carrier_key: string;
  policy_number_normalized: string;
  domain: PolicyWorkDomain | null;
  source_record_id: string | null;
  event_type:
    | 'bootstrap'
    | 'producer_assignment'
    | 'auto_assignment'
    | 'manager_assignment'
    | 'unlock'
    | 'conflict';
  previous_profile_id: string | null;
  next_profile_id: string | null;
  actor_profile_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

/** What one assignment attempt decided, as the RPCs report it (Requirements 11.2, 13.2). */
export interface PolicyAssignmentOutcome {
  carrier_key: string | null;
  policy_number_normalized: string | null;
  assigned_to: string | null;
  assignment_source: PolicyAssignmentSource | null;
  assignment_locked: boolean;
  /** One of the six precedence steps of Requirement 3.3, or why none applied. */
  reason: string;
  workload_score: number | null;
}

// ---------------------------------------------------------------------------
// Manager Overview (Requirement 9)
// ---------------------------------------------------------------------------

/** The per-domain counters of Requirement 9.2, over the full authorized population. */
export interface PolicyDomainOverviewCounts {
  active: number;
  needActionToday: number;
  overdue: number;
  unassigned: number;
  /** Renewals: no contact recorded. Cancellations: no sent/delivered message and no response. */
  neverContacted: number;
  waiting: number;
  completedThisMonth: number;
  reviewRequired: number;
}

/** The cross-domain exception counters of Requirement 9.2. */
export interface PolicyAttentionCounts {
  carrierNonRenewalAwaitingRequote: number;
  paymentVerificationRequired: number;
  failedCommunications: number;
  reviewRequiredImports: number;
  unmatchedProducerLabels: number;
  matchReviewRows: number;
  missingValidContact: number;
  unknownImportedStatus: number;
  unassignedPolicies: number;
  ownershipConflicts: number;
}

/** Where an Attention Required card drills to (design 10.2). */
export interface PolicyAttentionTarget {
  tab: 'renewals' | 'cancellations' | 'manager' | 'imports' | 'my-work';
  /** A saved filter id of the target tab, where one can represent the category. */
  filter?: string;
  /** A narrower selector the target tab understands. */
  extra?: string;
}

export interface PolicyAttentionCard {
  id: string;
  label: string;
  count: number;
  /** One sentence saying what the manager is looking at and why it matters. */
  hint: string;
  target: PolicyAttentionTarget;
}

/** The whole Manager Overview payload (design 10.1). */
export interface PolicyFollowUpManagerOverview {
  businessDate: string;
  renewals: PolicyDomainOverviewCounts;
  cancellations: PolicyDomainOverviewCounts;
  attention: PolicyAttentionCounts;
  agents: readonly PolicyAgentOverviewRow[];
  /** True where every count above was computed by the server over the full population (Req 9.5). */
  fullPopulation: boolean;
}

/** One row of the team workload table (Requirement 9.4). */
export interface PolicyAgentOverviewRow {
  profileId: string;
  displayName: string;
  username: string | null;
  role: string | null;
  renewalsEnabled: boolean;
  cancellationsEnabled: boolean;
  autoAssignmentEnabled: boolean;
  assignmentMode: PolicyAssignmentMode;
  activeRenewals: number;
  activeCancellations: number;
  dueToday: number;
  overdue: number;
  criticalCancellations: number;
  carrierNonRenewals: number;
  waiting: number;
  workloadScore: number;
}

// ---------------------------------------------------------------------------
// Cross-domain policy search (Requirement 10.2)
// ---------------------------------------------------------------------------

/** One result of the cross-domain policy search (Requirement 10.2). */
export interface PolicySearchResult {
  carrierKey: string | null;
  carrier: string | null;
  policyNumber: string;
  policyNumberNormalized: string | null;
  customerName: string | null;
  /** The shared owner's display name, or `null` where the policy is unowned. */
  ownerName: string | null;
  ownerProfileId: string | null;
  assignmentSource: PolicyAssignmentSource | null;
  assignmentLocked: boolean;
  /**
   * True where the bootstrap found the renewal and the cancellation assigned to different employees
   * and refused to guess. The policy has no shared owner until a manager chooses (design 4.4).
   */
  ownershipConflict: boolean;
  hasActiveRenewal: boolean;
  hasActiveCancellation: boolean;
  renewalRecordId: string | null;
  cancellationCaseId: string | null;
}

// ---------------------------------------------------------------------------
// Tabs (Requirement 14.1)
// ---------------------------------------------------------------------------

/**
 * The five Policy Follow-up views (Requirement 14.1).
 *
 * `renewals` and `cancellations` keep their existing ids, so every link already in circulation —
 * `?tab=renewals`, `?tab=cancellations` — resolves to the same surface it did before.
 */
export type PolicyFollowUpTab = 'my-work' | 'renewals' | 'cancellations' | 'manager' | 'imports';

export const POLICY_FOLLOW_UP_TAB_IDS = [
  'my-work',
  'renewals',
  'cancellations',
  'manager',
  'imports',
] as const satisfies readonly PolicyFollowUpTab[];

/** True for a view reserved to Manager_Role (Requirement 14.2). */
export function isManagerOnlyTab(tab: PolicyFollowUpTab): boolean {
  return tab === 'manager' || tab === 'imports';
}

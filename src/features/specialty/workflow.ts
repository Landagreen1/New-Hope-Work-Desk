/**
 * The Specialty Quote workspace's derived vocabulary.
 *
 * Everything in this file is a **reading** of state the database already holds. No
 * new status system is introduced: the workflow rail, the next action and the quote
 * health panel are all computed from `specialty_opportunities.stage`, the carrier
 * markets, the information requests and the price presentations that
 * `specialty_opportunity_detail` already returns in one round trip.
 *
 * It lives apart from the components for one reason named by the spec: "Create a
 * centralized frontend/domain helper for deriving the most relevant next action. Do
 * not scatter this logic across many components." The header, the Overview panel and
 * the list all ask the same question, so they all ask it here.
 *
 * Pure — no React, no `getSupabase` — so the priority order can be tested directly.
 */

import { carrierStatusLabel, isInformationOutstanding, type Tone } from './status';
import type {
  CarrierMarket,
  CarrierMarketStatus,
  InformationRequest,
  SpecialtyResult,
  SpecialtyStage,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// The tabs
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The five destinations of the workspace.
 *
 * `notes` is deliberately absent as a tab of its own: notes and the checklist read
 * as part of what is happening rather than as a filing cabinet, so they sit on the
 * Overview and inside each carrier's own workstream. The Activity tab is where the
 * complete narrative lives.
 */
export const WORKSPACE_TABS = ['overview', 'carriers', 'application', 'documents', 'activity'] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

const TAB_LABELS: Record<WorkspaceTab, string> = {
  overview: 'Overview',
  carriers: 'Carriers',
  application: 'Application',
  documents: 'Documents',
  activity: 'Activity',
};

export function tabLabel(tab: WorkspaceTab): string {
  return TAB_LABELS[tab];
}

/** Reads `?tab=` without trusting it. Anything unknown opens the Overview. */
export function parseTab(value: string | null | undefined): WorkspaceTab {
  return WORKSPACE_TABS.find((tab) => tab === value) ?? 'overview';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Structural inputs
//
// Narrow shapes rather than `OpportunityDetail`, so a test can state the three facts
// a rule actually depends on instead of inventing a whole quote. `OpportunityDetail`
// satisfies these structurally, which is what keeps the two in step.
// ═══════════════════════════════════════════════════════════════════════════════

export interface QuoteFacts {
  stage: SpecialtyStage;
  result: SpecialtyResult | null;
  primary_assignee_id: string | null;
  next_action: string | null;
  next_action_due: string | null;
  is_overdue: boolean;
  is_due_today: boolean;
  price_sent_at: string | null;
  bound_carrier_name: string | null;
  sold_premium: number | null;
  documents_count: number;
}

export type CarrierFacts = Pick<
  CarrierMarket,
  'id' | 'carrier_name' | 'status' | 'premium' | 'presented_at' | 'info_requested' | 'submitted_at'
>;

export type InformationFacts = Pick<InformationRequest, 'label' | 'status'>;

export interface QuoteState {
  opportunity: QuoteFacts;
  carrier_markets: readonly CarrierFacts[];
  information_requests: readonly InformationFacts[];
  /** Whether a linked CS intake exists at all. A legacy-adopted quote has none. */
  has_intake: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Carrier status groups
//
// The nine database statuses read as four operational situations. The groups are
// what the Carriers tab counts and what the next action reasons over; the nine
// values themselves are never collapsed, because "declined" and "not competitive"
// are different answers from an underwriter and the carrier report depends on the
// difference.
// ═══════════════════════════════════════════════════════════════════════════════

export type CarrierGroup = 'pending' | 'awaiting' | 'blocked' | 'quoted' | 'closed';

export function carrierGroup(status: CarrierMarketStatus): CarrierGroup {
  switch (status) {
    case 'not_started':
    case 'preparing':
      return 'pending';
    case 'submitted':
    case 'waiting':
      return 'awaiting';
    case 'more_info_needed':
      return 'blocked';
    case 'quote_received':
      return 'quoted';
    case 'declined':
    case 'not_competitive':
    case 'withdrawn':
      return 'closed';
  }
}

export interface CarrierTally {
  total: number;
  /** Not yet approached: Not Submitted or Ready. */
  pending: number;
  /** Approached and the ball is with the underwriter. */
  awaiting: number;
  /** The carrier has asked for something. */
  blocked: number;
  quoted: number;
  closed: number;
  /** Approached at all, i.e. `submitted_at` is set. Marketing history. */
  submitted: number;
  /** Quoted and already presented to the customer. */
  presented: number;
  bestPremium: number | null;
}

export function tallyCarriers(markets: readonly CarrierFacts[]): CarrierTally {
  const tally: CarrierTally = {
    total: markets.length,
    pending: 0,
    awaiting: 0,
    blocked: 0,
    quoted: 0,
    closed: 0,
    submitted: 0,
    presented: 0,
    bestPremium: null,
  };

  for (const market of markets) {
    tally[carrierGroup(market.status)] += 1;
    if (market.submitted_at !== null) tally.submitted += 1;
    if (market.presented_at !== null) tally.presented += 1;
    if (market.status === 'quote_received' && market.premium !== null) {
      tally.bestPremium =
        tally.bestPremium === null ? market.premium : Math.min(tally.bestPremium, market.premium);
    }
  }

  return tally;
}

/** The viable options, cheapest first. What a comparison actually is. */
export function quotedMarkets<T extends CarrierFacts>(markets: readonly T[]): T[] {
  return markets
    .filter((market) => market.status === 'quote_received' && market.premium !== null)
    .sort((a, b) => (a.premium ?? 0) - (b.premium ?? 0));
}

// ═══════════════════════════════════════════════════════════════════════════════
// The workflow rail
// ═══════════════════════════════════════════════════════════════════════════════

export type PhaseKey = 'intake' | 'submissions' | 'quoting' | 'customer' | 'complete';

export interface WorkflowPhase {
  key: PhaseKey;
  label: string;
  state: 'done' | 'current' | 'upcoming';
  /** What is true right now inside this phase, read from live data. */
  caption: string;
  /** Set on the current phase when it is blocked rather than merely in progress. */
  isBlocked: boolean;
}

/** Which phase a stage belongs to. The nine stages group into five phases. */
const STAGE_PHASE: Record<SpecialtyStage, PhaseKey> = {
  new: 'intake',
  information_needed: 'intake',
  ready_to_market: 'submissions',
  marketing: 'submissions',
  options_ready: 'quoting',
  price_sent: 'customer',
  follow_up: 'customer',
  sold: 'complete',
  not_sold: 'complete',
};

const PHASE_ORDER: readonly PhaseKey[] = ['intake', 'submissions', 'quoting', 'customer', 'complete'];

const PHASE_LABELS: Record<PhaseKey, string> = {
  intake: 'Intake',
  submissions: 'Submissions',
  quoting: 'Quoting',
  customer: 'Customer',
  complete: 'Complete',
};

export function phaseForStage(stage: SpecialtyStage): PhaseKey {
  return STAGE_PHASE[stage];
}

/**
 * The progress rail.
 *
 * Position comes from the stage, which is the authoritative column. The captions
 * come from the children, so the rail says "3 of 5 submitted" rather than repeating
 * the stage name five times.
 */
export function workflowProgress(state: QuoteState): WorkflowPhase[] {
  const { opportunity } = state;
  const tally = tallyCarriers(state.carrier_markets);
  const outstanding = outstandingInformation(state.information_requests);
  const currentPhase = phaseForStage(opportunity.stage);
  const currentIndex = PHASE_ORDER.indexOf(currentPhase);

  const captions: Record<PhaseKey, string> = {
    intake: state.has_intake
      ? outstanding.length > 0
        ? `${outstanding.length} item${outstanding.length === 1 ? '' : 's'} outstanding`
        : 'Information complete'
      : 'No linked intake',
    submissions:
      tally.total === 0 ? 'No carriers yet' : `${tally.submitted} of ${tally.total} submitted`,
    quoting:
      tally.quoted === 0
        ? tally.blocked > 0
          ? `${tally.blocked} carrier${tally.blocked === 1 ? '' : 's'} need information`
          : 'No quotes yet'
        : `${tally.quoted} quote${tally.quoted === 1 ? '' : 's'} received`,
    customer: opportunity.price_sent_at === null ? 'Price not sent' : 'Price sent',
    complete:
      opportunity.result === 'sold'
        ? 'Sold'
        : opportunity.result === 'not_sold'
          ? 'Not sold'
          : 'Open',
  };

  return PHASE_ORDER.map((key, index) => ({
    key,
    label: PHASE_LABELS[key],
    state: index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming',
    caption: captions[key],
    isBlocked:
      index === currentIndex &&
      (opportunity.stage === 'information_needed' || (key === 'quoting' && tally.blocked > 0)),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Quote health
// ═══════════════════════════════════════════════════════════════════════════════

export function outstandingInformation<T extends InformationFacts>(
  requests: readonly T[],
): T[] {
  return requests.filter((request) => isInformationOutstanding(request.status));
}

/** Carriers that have asked for something and not had it answered. */
export function blockedCarriers<T extends CarrierFacts>(markets: readonly T[]): T[] {
  return markets.filter((market) => market.status === 'more_info_needed');
}

export interface QuoteHealth {
  /** True when a linked intake exists and nothing is outstanding against it. */
  applicationComplete: boolean;
  documentsCount: number;
  carriersSubmitted: number;
  carriersTotal: number;
  quotesReceived: number;
  /**
   * Plain sentences naming what is actually missing.
   *
   * Deliberately not a completion percentage. A percentage over a list nobody
   * defined is a number that looks like a measurement and is not one.
   */
  missing: string[];
}

export function quoteHealth(state: QuoteState): QuoteHealth {
  const tally = tallyCarriers(state.carrier_markets);
  const outstanding = outstandingInformation(state.information_requests);

  const missing = [
    ...outstanding.map((request) => request.label),
    ...blockedCarriers(state.carrier_markets).map(
      (market) => `${market.carrier_name} requested ${market.info_requested ?? 'more information'}`,
    ),
  ];

  if (!state.has_intake) {
    missing.push('No linked intake — customer detail was kept as the first note');
  }

  return {
    applicationComplete: state.has_intake && outstanding.length === 0,
    documentsCount: state.opportunity.documents_count,
    carriersSubmitted: tally.submitted,
    carriersTotal: tally.total,
    quotesReceived: tally.quoted,
    missing,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// The next action
// ═══════════════════════════════════════════════════════════════════════════════

export type NextActionKey =
  | 'closed'
  | 'information_outstanding'
  | 'carrier_needs_information'
  | 'no_carriers'
  | 'ready_to_submit'
  | 'awaiting_carrier_responses'
  | 'prices_ready_to_send'
  | 'follow_up_due'
  | 'awaiting_customer_decision'
  | 'record_result'
  | 'unclaimed';

export interface NextAction {
  key: NextActionKey;
  /** One line, in the words an employee would use. */
  headline: string;
  /** The specifics, when there are any worth saying. */
  detail: string | null;
  /** Where in the workspace the reader resolves it. */
  tab: WorkspaceTab;
  /** The label on the button that goes there. */
  actionLabel: string;
  tone: Tone;
  /** Set when the action belongs to one carrier's workstream. */
  carrierMarketId: string | null;
}

/**
 * The single most relevant thing to do next.
 *
 * The order is the spec's priority list (section 18) and it is a **reading of state,
 * not a change to it**: nothing here writes, moves a stage or overrides the next
 * action a teammate recorded by hand. That recorded value is shown alongside this
 * one, because "Oscar said to call the customer Thursday" is information the state
 * machine does not hold.
 *
 * Blocking situations outrank waiting ones, and a carrier's request outranks a
 * missing document, because an underwriter who has asked a question has stopped
 * work until it is answered.
 */
export function deriveNextAction(state: QuoteState): NextAction {
  const { opportunity } = state;
  const tally = tallyCarriers(state.carrier_markets);

  // 10. Closed. Nothing is pending on a recorded outcome.
  if (opportunity.result === 'sold') {
    return {
      key: 'closed',
      headline: 'Sold. Nothing further is needed.',
      detail: [
        opportunity.bound_carrier_name,
        opportunity.sold_premium === null ? null : `$${opportunity.sold_premium.toLocaleString()}`,
      ]
        .filter(Boolean)
        .join(' · ') || null,
      tab: 'activity',
      actionLabel: 'View activity',
      tone: 'success',
      carrierMarketId: null,
    };
  }
  if (opportunity.result === 'not_sold') {
    return {
      key: 'closed',
      headline: 'Closed as not sold.',
      detail: 'A manager can reopen it if the customer comes back.',
      tab: 'activity',
      actionLabel: 'View activity',
      tone: 'neutral',
      carrierMarketId: null,
    };
  }

  // 2. A carrier has asked for something. Ahead of the intake list because an
  //    underwriter's question has already stopped that submission.
  const blocked = blockedCarriers(state.carrier_markets);
  if (blocked.length > 0) {
    const first = blocked[0];
    return {
      key: 'carrier_needs_information',
      headline:
        blocked.length === 1
          ? `${first.carrier_name} requested additional information.`
          : `${blocked.length} carriers requested additional information.`,
      detail: first.info_requested ?? null,
      tab: 'carriers',
      actionLabel: 'Resolve request',
      tone: 'danger',
      carrierMarketId: blocked.length === 1 ? first.id : null,
    };
  }

  // 1. Required information is missing from the application.
  const outstanding = outstandingInformation(state.information_requests);
  if (outstanding.length > 0) {
    return {
      key: 'information_outstanding',
      headline:
        outstanding.length === 1
          ? `Waiting on ${outstanding[0].label}.`
          : `${outstanding.length} items of information are outstanding.`,
      detail: outstanding.map((request) => request.label).join(' · '),
      tab: 'overview',
      actionLabel: 'Review what is missing',
      tone: 'danger',
      carrierMarketId: null,
    };
  }

  // A quote nobody is accountable for. Below the blocking states because anyone on
  // the team can work it regardless of who is assigned.
  if (opportunity.primary_assignee_id === null) {
    return {
      key: 'unclaimed',
      headline: 'Nobody has claimed this quote yet.',
      detail: 'Claiming records accountability. Your teammates can still work it with you.',
      tab: 'overview',
      actionLabel: 'Claim it',
      tone: 'info',
      carrierMarketId: null,
    };
  }

  // 3. No carriers at all.
  if (tally.total === 0) {
    return {
      key: 'no_carriers',
      headline: 'No carriers have been added yet.',
      detail: 'Add the markets you plan to approach; each keeps its own status and pricing.',
      tab: 'carriers',
      actionLabel: 'Add carriers',
      tone: 'progress',
      carrierMarketId: null,
    };
  }

  // 7. Pricing in hand and not yet sent. Ahead of "still waiting", because a quote
  //    the customer has not seen is worth more than one more carrier's answer.
  if (tally.quoted > 0 && tally.presented === 0) {
    return {
      key: 'prices_ready_to_send',
      headline:
        tally.quoted === 1
          ? 'One carrier quote is ready to send to the customer.'
          : `${tally.quoted} carrier quotes are ready to send to the customer.`,
      detail:
        tally.bestPremium === null
          ? null
          : `Best option ${`$${tally.bestPremium.toLocaleString()}`}. Recording a price sent freezes what the customer was told.`,
      tab: 'carriers',
      actionLabel: 'Review the options',
      tone: 'violet',
      carrierMarketId: null,
    };
  }

  // 4. Submissions prepared but not sent.
  if (tally.submitted === 0 && tally.pending > 0) {
    return {
      key: 'ready_to_submit',
      headline:
        tally.pending === 1
          ? 'One carrier is ready to submit.'
          : `${tally.pending} carriers are ready to submit.`,
      detail: state.carrier_markets
        .filter((market) => carrierGroup(market.status) === 'pending')
        .map((market) => market.carrier_name)
        .join(' · '),
      tab: 'carriers',
      actionLabel: 'Work the submissions',
      tone: 'cyan',
      carrierMarketId: null,
    };
  }

  // 8. The customer has the price and the follow-up is due.
  if (opportunity.price_sent_at !== null && (opportunity.is_overdue || opportunity.is_due_today)) {
    return {
      key: 'follow_up_due',
      headline: opportunity.is_overdue
        ? 'The customer follow-up is overdue.'
        : 'The customer follow-up is due today.',
      detail: opportunity.next_action,
      tab: 'overview',
      actionLabel: 'Open the follow-up',
      tone: 'danger',
      carrierMarketId: null,
    };
  }

  // 5. Waiting on underwriting.
  if (tally.awaiting > 0) {
    return {
      key: 'awaiting_carrier_responses',
      headline:
        tally.awaiting === 1
          ? 'Waiting on one carrier response.'
          : `Waiting on ${tally.awaiting} carrier responses.`,
      detail: state.carrier_markets
        .filter((market) => carrierGroup(market.status) === 'awaiting')
        .map((market) => market.carrier_name)
        .join(' · '),
      tab: 'carriers',
      actionLabel: 'Chase the carriers',
      tone: 'progress',
      carrierMarketId: null,
    };
  }

  // 9. Awaiting a decision.
  if (tally.presented > 0) {
    return {
      key: 'awaiting_customer_decision',
      headline: 'The customer has the pricing and is deciding.',
      detail: opportunity.next_action,
      tab: 'overview',
      actionLabel: 'Record the result',
      tone: 'cyan',
      carrierMarketId: null,
    };
  }

  // Every carrier answered and none of them quoted. There is a result to record.
  return {
    key: 'record_result',
    headline:
      tally.closed === tally.total
        ? 'Every carrier has closed out. Record the result.'
        : 'Decide the next step for this quote.',
    detail:
      tally.closed === tally.total
        ? 'Nothing is outstanding with a carrier, so the outcome can be recorded.'
        : opportunity.next_action,
    tab: 'carriers',
    actionLabel: 'Open the carriers',
    tone: 'neutral',
    carrierMarketId: null,
  };
}

/**
 * The one-line version, for a list row.
 *
 * The recorded next action wins here: a list is scanned, and what a teammate wrote
 * by hand is more specific than anything derivable. The derived reading is the
 * fallback for a quote nobody has written one for.
 */
export function nextActionSummary(state: QuoteState): string {
  const recorded = state.opportunity.next_action?.trim();
  if (recorded) return recorded;
  return deriveNextAction(state).headline;
}

// ═══════════════════════════════════════════════════════════════════════════════
// The list row's reading
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * What `specialty_search_opportunities` gives a list row.
 *
 * The search RPC returns aggregates rather than the child rows — counts of markets by
 * situation, a count and a label list for outstanding information — because a
 * twenty-five-row page cannot afford five joins per row. So the list gets its own,
 * coarser reading of the same priority order rather than the full
 * {@link deriveNextAction}, and the two are kept in this one file so they cannot drift
 * into telling different stories about the same quote.
 */
export interface RowFacts {
  result: SpecialtyResult | null;
  primary_assignee_id: string | null;
  next_action: string | null;
  is_overdue: boolean;
  is_due_today: boolean;
  price_sent_at: string | null;
  markets_total: number;
  markets_submitted: number;
  markets_quoted: number;
  markets_waiting: number;
  markets_info_needed: number;
  open_information_count: number;
  open_information_labels: string | null;
}

/**
 * The one line a list row shows under Next Action.
 *
 * What a teammate wrote by hand wins, for the same reason it wins in the workspace: a
 * list is scanned, and "Call Miguel Thursday" is more specific than anything derivable.
 * The derived reading is the fallback, so a row is never blank.
 */
export function listNextAction(row: RowFacts): string {
  const recorded = row.next_action?.trim();
  if (recorded) return recorded;

  if (row.result === 'sold') return 'Sold';
  if (row.result === 'not_sold') return 'Closed as not sold';

  if (row.markets_info_needed > 0) {
    return row.markets_info_needed === 1
      ? 'A carrier needs information'
      : `${row.markets_info_needed} carriers need information`;
  }
  if (row.open_information_count > 0) {
    return row.open_information_labels
      ? `Waiting on ${row.open_information_labels}`
      : `${row.open_information_count} items outstanding`;
  }
  if (row.primary_assignee_id === null) return 'Unclaimed';
  if (row.markets_total === 0) return 'No carriers yet';
  if (row.markets_quoted > 0 && row.price_sent_at === null) return 'Prices ready to send';
  if (row.markets_submitted === 0) return 'Ready to submit';
  if (row.price_sent_at !== null && (row.is_overdue || row.is_due_today)) {
    return 'Customer follow-up due';
  }
  if (row.markets_waiting > 0) return 'Waiting on carrier responses';
  if (row.price_sent_at !== null) return 'Awaiting the customer’s decision';
  return 'Decide the next step';
}

/** Groups carrier statuses for the Carriers tab summary strip. */
export function carrierGroupLabel(group: CarrierGroup): string {
  switch (group) {
    case 'pending':
      return 'Pending';
    case 'awaiting':
      return 'Awaiting response';
    case 'blocked':
      return 'Needs information';
    case 'quoted':
      return 'Quoted';
    case 'closed':
      return 'Closed';
  }
}

/** Re-exported so a component never has to reach past this module for a label. */
export { carrierStatusLabel };

/**
 * The employee-facing status vocabulary.
 *
 * An agent on a live call should not have to know that a priced quote has left
 * `work_items` for `pending_pricing_quotes`, or that "converted" is an intake
 * status rather than a quote status. So the many real statuses are grouped into
 * five buckets, and the specific state is shown as a plain-language chip beside
 * the bucket.
 *
 * This is presentation only. No underlying status is removed or rewritten, and
 * the grouping itself is computed in SQL (quote_center_journeys.stage) so the
 * counts, the filters and the cards cannot disagree with each other. What lives
 * here is the labelling and ordering the screen needs.
 */

import type { JourneyStage, StageFilter } from './types';

/** Filter order, matching the order work actually moves through. */
export const STAGE_FILTERS: readonly StageFilter[] = [
  'all',
  'intake',
  'working',
  'price_sent',
  'closed',
] as const;

const STAGE_FILTER_LABELS: Record<StageFilter, string> = {
  all: 'All',
  intake: 'Intake',
  working: 'Working',
  price_sent: 'Price Sent',
  closed: 'Closed',
};

export function stageFilterLabel(filter: StageFilter): string {
  return STAGE_FILTER_LABELS[filter];
}

/** What each bucket means, for the filter tooltips. */
const STAGE_DESCRIPTIONS: Record<JourneyStage, string> = {
  intake: 'Started or submitted, not yet taken by an agent.',
  working: 'An agent owns it and is quoting.',
  price_sent: 'Pricing has gone out and a decision is pending.',
  closed: 'Decided — sold or not sold.',
};

export function stageDescription(stage: JourneyStage): string {
  return STAGE_DESCRIPTIONS[stage];
}

/**
 * Lifecycle rank, furthest first.
 *
 * Used wherever two representations of the same journey have to be reduced to
 * one: the furthest valid state wins, because a quote that has been sold is not
 * also still an intake. The SQL view applies the same ordering when it collapses
 * a journey, and this mirror exists so the rule can be tested and reused in the
 * browser without a round trip.
 */
const STAGE_RANK: Record<JourneyStage, number> = {
  intake: 1,
  working: 2,
  price_sent: 3,
  closed: 4,
};

export function stageRank(stage: JourneyStage): number {
  return STAGE_RANK[stage];
}

/** The furthest of two stages. */
export function furthestStage(a: JourneyStage, b: JourneyStage): JourneyStage {
  return stageRank(a) >= stageRank(b) ? a : b;
}

/** Visual tone keys, matching `ui.badgeTone`. */
export type StageTone = 'neutral' | 'info' | 'progress' | 'success' | 'danger' | 'violet' | 'cyan';

/**
 * The tone for a journey's chip.
 *
 * Closed splits on the decision rather than sharing one colour, because "sold"
 * and "not sold" are the two outcomes an employee most needs to tell apart at a
 * glance, and colouring them identically would defeat the point of the chip.
 */
export function stageTone(stage: JourneyStage, decision?: string | null): StageTone {
  if (stage === 'closed') {
    if ((decision ?? '').toLowerCase() === 'sold') return 'success';
    if ((decision ?? '').toLowerCase() === 'not_sold') return 'danger';
    return 'neutral';
  }
  if (stage === 'price_sent') return 'cyan';
  if (stage === 'working') return 'progress';
  return 'info';
}

/**
 * True when this journey is an unfinished intake that someone can pick up and
 * continue.
 *
 * Only `draft` and `returned` qualify. A submitted intake is already waiting for
 * an agent to claim it through the queue, and editing it at that point would be
 * changing work that has been handed over. `can_edit_cs_intake` and
 * `cs_intake_save_draft` enforce the same two statuses server-side.
 */
export function isContinuableDraft(intakeStatus: string | null | undefined): boolean {
  return intakeStatus === 'draft' || intakeStatus === 'returned';
}

/**
 * True when the journey has a live quote row that can accept quote notes.
 *
 * Deliberately keyed on `hasQuote` rather than on the presence of a work item id:
 * a manager-deleted quote leaves the intake still carrying its
 * `source_work_item_id`, and posting a note against that id would be rejected by
 * `add_quote_note` because the quote no longer exists in any lifecycle table.
 */
export function acceptsQuoteNote(hasQuote: boolean): boolean {
  return hasQuote;
}

/**
 * Where a note about this journey belongs.
 *
 * Before conversion the intake's own append-only log is the only place a note can
 * go; after conversion `quote_notes` is where the agent working the quote will
 * look. Choosing here rather than at each call site is what keeps one "Add Note"
 * button correct at every stage.
 */
export function noteTargetFor(journey: {
  has_quote: boolean;
  work_item_id: string | null;
  intake_id: string | null;
}): { kind: 'quote'; workItemId: string } | { kind: 'intake'; intakeId: string } | null {
  if (journey.has_quote && journey.work_item_id) {
    return { kind: 'quote', workItemId: journey.work_item_id };
  }
  if (journey.intake_id) return { kind: 'intake', intakeId: journey.intake_id };
  return null;
}

/** Human labels for the raw line-of-business values stored on an intake. */
const LOB_LABELS: Record<string, string> = {
  auto: 'Auto',
  personal_auto: 'Auto',
  commercial_auto: 'Commercial Auto',
  trucking: 'Trucking',
  commercial_gl: 'Commercial GL',
  homeowners: 'Homeowners',
  non_owners: 'Non-Owners',
  motorcycle: 'Motorcycle',
  boat: 'Boat',
  trailer: 'Trailer / Mobile Home',
  renters: 'Renters',
};

/**
 * The line of business to show on a card.
 *
 * A quote created without an intake has no line of business recorded, so its work
 * type is the honest answer rather than inventing one.
 */
export function lineOfBusinessLabel(
  lineOfBusiness: string | null | undefined,
  workType?: string | null,
): string {
  if (lineOfBusiness && LOB_LABELS[lineOfBusiness]) return LOB_LABELS[lineOfBusiness];
  if (lineOfBusiness) return titleCase(lineOfBusiness);
  if (workType === 'requote') return 'Requote';
  if (workType === 'new_quote') return 'Quote';
  return 'Quote';
}

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Reasons a quote was not sold, in the vocabulary the database constrains to. */
const NOT_SOLD_REASONS: Record<string, string> = {
  price_too_high: 'Price too high',
  chose_another_option: 'Chose another option',
  no_response: 'No response',
  no_longer_needed: 'No longer needed',
  other: 'Other',
};

export function notSoldReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return NOT_SOLD_REASONS[reason] ?? titleCase(reason);
}

/**
 * Formats a phone number for display without losing anything.
 *
 * Ten digits become (704) 555-1212; anything else is shown exactly as stored,
 * because an unexpected format is more likely to be a real extension or an
 * international number than a mistake to be tidied away.
 */
export function formatPhone(value: string | null | undefined): string {
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return value;
}

/** Digits only, matching public.nhwd_digits so client and server agree. */
export function phoneDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/**
 * A short, human identifier for a journey.
 *
 * Employees read these aloud to each other and to customers, so an intake and a
 * quote are prefixed differently and the full UUID is never shown.
 */
export function journeyReference(journey: {
  intake_id: string | null;
  work_item_id: string | null;
  has_quote: boolean;
}): string {
  if (journey.has_quote && journey.work_item_id) {
    return `Q-${journey.work_item_id.slice(0, 8).toUpperCase()}`;
  }
  if (journey.intake_id) return `INT-${journey.intake_id.slice(0, 8).toUpperCase()}`;
  if (journey.work_item_id) return `Q-${journey.work_item_id.slice(0, 8).toUpperCase()}`;
  return '—';
}

/**
 * The differentiators that tell same-name customers apart, in the order they are
 * most useful on a call.
 *
 * Requirement: a name is never sufficient identity. Three people called Maria
 * Perez must be distinguishable from the card alone, so the card always shows
 * whatever of these exists rather than falling back to the name.
 */
export function journeyDifferentiators(journey: {
  phone_primary: string | null;
  addr_city: string | null;
  addr_state: string | null;
  source_label: string | null;
  salesperson_name: string | null;
  assigned_agent_name: string | null;
}): string[] {
  const parts: string[] = [];
  const phone = formatPhone(journey.phone_primary);
  if (phone) parts.push(phone);

  const place = [journey.addr_city, journey.addr_state].filter(Boolean).join(', ');
  if (place) parts.push(place);

  if (journey.source_label && journey.source_label !== 'Not recorded') {
    parts.push(
      journey.salesperson_name
        ? `${journey.source_label} / ${journey.salesperson_name}`
        : journey.source_label,
    );
  }

  if (journey.assigned_agent_name) parts.push(journey.assigned_agent_name);

  return parts;
}

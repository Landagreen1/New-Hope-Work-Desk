/**
 * The Specialty Quotes presentation vocabulary.
 *
 * Labels, tones and ordering only. The stage a quote is in, and every rule about
 * moving between stages, is decided in SQL — `specialty_workflow_stages` supplies
 * the authoritative label per template and `specialty_change_stage` enforces the
 * transitions. What lives here is how the browser renders those facts, plus the
 * pure mappings that are worth testing without a database round trip.
 */

import type {
  CarrierMarketStatus,
  InformationStatus,
  DocumentCategory,
  PriceMethod,
  SpecialtyLine,
  SpecialtyLostReason,
  SpecialtyStage,
  SpecialtyView,
} from './types';

/** Tone keys, matching `ui.badgeTone`. No new colours are introduced. */
export type Tone = 'neutral' | 'info' | 'progress' | 'success' | 'danger' | 'violet' | 'cyan';

// ── Stages ───────────────────────────────────────────────────────────────────

/** Lifecycle order. Mirrors the seeded `position` in specialty_workflow_stages. */
export const STAGE_ORDER: readonly SpecialtyStage[] = [
  'new',
  'information_needed',
  'ready_to_market',
  'marketing',
  'options_ready',
  'price_sent',
  'follow_up',
  'sold',
  'not_sold',
] as const;

const STAGE_LABELS: Record<SpecialtyStage, string> = {
  new: 'New',
  information_needed: 'Information Needed',
  ready_to_market: 'Ready to Market',
  marketing: 'Marketing',
  options_ready: 'Options Ready',
  price_sent: 'Price Sent',
  follow_up: 'Follow-Up',
  sold: 'Sold',
  not_sold: 'Not Sold',
};

export function stageLabel(stage: SpecialtyStage): string {
  return STAGE_LABELS[stage] ?? titleCase(stage);
}

/** What each stage means, for the filter tooltips and the stage picker. */
const STAGE_MEANINGS: Record<SpecialtyStage, string> = {
  new: 'A completed intake has reached the team and nobody has claimed it yet.',
  information_needed: 'Blocked until the customer or Customer Service supplies something.',
  ready_to_market: 'Enough information exists to start approaching carriers.',
  marketing: 'At least one carrier is actively being worked.',
  options_ready: 'At least one viable carrier quote is in hand.',
  price_sent: 'Pricing has gone to the customer.',
  follow_up: 'The customer has the price and a decision is pending.',
  sold: 'Bound. Carrier and premium recorded.',
  not_sold: 'Closed with a recorded reason.',
};

export function stageMeaning(stage: SpecialtyStage): string {
  return STAGE_MEANINGS[stage] ?? '';
}

export function stageTone(stage: SpecialtyStage): Tone {
  switch (stage) {
    case 'new':
      return 'info';
    case 'information_needed':
      return 'danger';
    case 'ready_to_market':
      return 'cyan';
    case 'marketing':
      return 'progress';
    case 'options_ready':
      return 'violet';
    case 'price_sent':
      return 'cyan';
    case 'follow_up':
      return 'progress';
    case 'sold':
      return 'success';
    case 'not_sold':
      return 'neutral';
  }
}

export function isTerminalStage(stage: SpecialtyStage): boolean {
  return stage === 'sold' || stage === 'not_sold';
}

/**
 * The normalized lifecycle status shown outside the module — Quote Center, and
 * anywhere Customer Service reads a customer's progress.
 *
 * Mirrors the CASE in `specialty_cs_status` and in the `quote_center_journeys`
 * specialty overlay, so the three places a customer's status can be read cannot
 * disagree with each other.
 */
export function normalizedLifecycleStatus(stage: SpecialtyStage): string {
  switch (stage) {
    case 'new':
      return 'Submitted to Specialty Team';
    case 'information_needed':
      return 'Information Needed';
    case 'ready_to_market':
    case 'marketing':
      return 'Being Quoted';
    case 'options_ready':
      return 'Options Ready';
    case 'price_sent':
      return 'Price Sent';
    case 'follow_up':
      return 'Customer Follow-Up';
    case 'sold':
      return 'Sold';
    case 'not_sold':
      return 'Not Sold';
  }
}

// ── Lines of business ────────────────────────────────────────────────────────

const LINE_LABELS: Record<SpecialtyLine, string> = {
  trucking: 'Trucking',
  homeowners: 'Homeowners',
  commercial_gl: 'Commercial GL',
};

export function lineLabel(line: SpecialtyLine | string): string {
  return LINE_LABELS[line as SpecialtyLine] ?? titleCase(line);
}

// ── Carrier market statuses ──────────────────────────────────────────────────

export const CARRIER_STATUS_ORDER: readonly CarrierMarketStatus[] = [
  'not_started',
  'preparing',
  'submitted',
  'waiting',
  'more_info_needed',
  'quote_received',
  'not_competitive',
  'declined',
  'withdrawn',
] as const;

const CARRIER_STATUS_LABELS: Record<CarrierMarketStatus, string> = {
  not_started: 'Not Started',
  preparing: 'Preparing',
  submitted: 'Submitted',
  waiting: 'Waiting',
  more_info_needed: 'More Information Needed',
  quote_received: 'Quote Received',
  declined: 'Declined',
  not_competitive: 'Not Competitive',
  withdrawn: 'Withdrawn',
};

export function carrierStatusLabel(status: CarrierMarketStatus): string {
  return CARRIER_STATUS_LABELS[status] ?? titleCase(status);
}

export function carrierStatusTone(status: CarrierMarketStatus): Tone {
  switch (status) {
    case 'quote_received':
      return 'success';
    case 'more_info_needed':
      return 'danger';
    case 'submitted':
    case 'waiting':
      return 'progress';
    case 'preparing':
      return 'info';
    case 'declined':
      return 'danger';
    case 'not_competitive':
      return 'violet';
    case 'withdrawn':
    case 'not_started':
      return 'neutral';
  }
}

/**
 * Which fields a carrier status requires before it can be saved.
 *
 * Mirrors the validation in `specialty_update_carrier_market` and the table CHECK
 * constraints, so the form can say what is missing before the round trip instead of
 * surfacing a database error.
 */
export function carrierStatusRequires(status: CarrierMarketStatus): readonly string[] {
  switch (status) {
    case 'quote_received':
      return ['premium'];
    case 'declined':
      return ['decline_reason'];
    case 'more_info_needed':
      return ['info_requested'];
    default:
      return [];
  }
}

/** True once a market has been approached, so it is history rather than a draft. */
export function isCarrierMarketWorked(status: CarrierMarketStatus): boolean {
  return status !== 'not_started' && status !== 'preparing';
}

// ── Outcomes ─────────────────────────────────────────────────────────────────

export const LOST_REASONS: readonly SpecialtyLostReason[] = [
  'price_too_high',
  'stayed_with_current_carrier',
  'customer_stopped_responding',
  'competitor',
  'ineligible',
  'unable_to_place',
  'customer_postponed',
  'duplicate',
  'other',
] as const;

const LOST_REASON_LABELS: Record<SpecialtyLostReason, string> = {
  price_too_high: 'Price too high',
  stayed_with_current_carrier: 'Customer stayed with current carrier',
  customer_stopped_responding: 'Customer stopped responding',
  competitor: 'Competitor',
  ineligible: 'Ineligible',
  unable_to_place: 'Unable to place',
  customer_postponed: 'Customer postponed',
  duplicate: 'Duplicate',
  other: 'Other',
};

export function lostReasonLabel(reason: SpecialtyLostReason | string | null | undefined): string {
  if (!reason) return '—';
  return LOST_REASON_LABELS[reason as SpecialtyLostReason] ?? titleCase(reason);
}

// ── Information requests ─────────────────────────────────────────────────────

const INFORMATION_STATUS_LABELS: Record<InformationStatus, string> = {
  needed: 'Needed',
  requested: 'Requested',
  received: 'Received',
  waived: 'Waived',
};

export function informationStatusLabel(status: InformationStatus): string {
  return INFORMATION_STATUS_LABELS[status] ?? titleCase(status);
}

export function informationStatusTone(status: InformationStatus): Tone {
  switch (status) {
    case 'needed':
      return 'danger';
    case 'requested':
      return 'progress';
    case 'received':
      return 'success';
    case 'waived':
      return 'neutral';
  }
}

export function isInformationOutstanding(status: InformationStatus): boolean {
  return status === 'needed' || status === 'requested';
}

/**
 * Suggested missing-information items per line of business.
 *
 * A starting point for the picker, not a constraint: the field is free text because
 * a carrier can ask for anything. Deliberately excludes anything the CS intake
 * already collects.
 */
export const INFORMATION_SUGGESTIONS: Record<SpecialtyLine, readonly string[]> = {
  trucking: [
    'Loss runs (3-5 years)',
    'Driver list with licence numbers',
    'MVRs',
    'VINs for all units',
    'Vehicle registrations',
    'DOT / MC authority detail',
    'Current declarations page',
    'Operations detail (radius, commodities, states)',
    'Stated values for units',
  ],
  homeowners: [
    'Roof age and roof type',
    'Property photos (roof, exterior, interior)',
    'Four-point inspection',
    'Wind mitigation report',
    'Prior insurance and claims history',
    'Mortgagee name and loan number',
    'Current declarations page',
    'System update dates (electrical, plumbing, HVAC)',
    'Square footage confirmation',
  ],
  commercial_gl: [
    'Loss runs (3-5 years)',
    'Payroll and receipts by class',
    'Current declarations page',
    'Subcontractor detail',
  ],
};

// ── Documents ────────────────────────────────────────────────────────────────

export const DOCUMENT_CATEGORIES: readonly DocumentCategory[] = [
  'loss_runs',
  'declarations',
  'registration',
  'driver_license',
  'carrier_proposal',
  'quote_pdf',
  'photos',
  'underwriting',
  'other',
] as const;

const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  loss_runs: 'Loss Runs',
  declarations: 'Declarations',
  registration: 'Registration',
  driver_license: 'Driver Licence',
  carrier_proposal: 'Carrier Proposal',
  quote_pdf: 'Quote PDF',
  photos: 'Photos',
  underwriting: 'Underwriting',
  other: 'Other',
};

export function documentCategoryLabel(category: DocumentCategory | string): string {
  return DOCUMENT_CATEGORY_LABELS[category as DocumentCategory] ?? titleCase(category);
}

// ── Price delivery ───────────────────────────────────────────────────────────

export const PRICE_METHODS: readonly PriceMethod[] = [
  'phone',
  'whatsapp',
  'sms',
  'email',
  'in_person',
  'other',
] as const;

const PRICE_METHOD_LABELS: Record<PriceMethod, string> = {
  phone: 'Phone call',
  whatsapp: 'WhatsApp',
  sms: 'Text message',
  email: 'Email',
  in_person: 'In person',
  other: 'Other',
};

export function priceMethodLabel(method: PriceMethod | string | null | undefined): string {
  if (!method) return '—';
  return PRICE_METHOD_LABELS[method as PriceMethod] ?? titleCase(method);
}

// ── Views and attention buckets ──────────────────────────────────────────────

/**
 * The saved views, in the order they appear.
 *
 * `team` leads because the default operational visibility is all of the team's
 * work. `mine` is offered second as a workload filter — it narrows what is shown
 * and never what is reachable.
 */
export const VIEWS: readonly SpecialtyView[] = [
  'team',
  'mine',
  'unclaimed',
  'due_today',
  'overdue',
  'stale',
  'closed',
] as const;

const VIEW_LABELS: Record<SpecialtyView, string> = {
  team: 'All Team Work',
  mine: 'Assigned to Me',
  unclaimed: 'Unclaimed',
  due_today: 'Due Today',
  overdue: 'Overdue',
  stale: 'No Recent Activity',
  closed: 'Closed',
};

export function viewLabel(view: SpecialtyView): string {
  return VIEW_LABELS[view];
}

const VIEW_DESCRIPTIONS: Record<SpecialtyView, string> = {
  team: 'Everything the team is working. This is the default: a teammate\u2019s quote is one click away, not on another screen.',
  mine: 'Quotes you are primarily responsible for. A workload filter — you can still open and work anything on this list\u2019s other views.',
  unclaimed: 'Submitted and waiting for someone to take responsibility.',
  due_today: 'Next action falls today.',
  overdue: 'Next action is past due.',
  stale: 'Nothing has happened for a week.',
  closed: 'Sold and Not Sold.',
};

export function viewDescription(view: SpecialtyView): string {
  return VIEW_DESCRIPTIONS[view];
}

/** Which count bucket lights up a view chip. */
export function viewCountBucket(view: SpecialtyView): string | null {
  switch (view) {
    case 'team':
      return 'active';
    case 'mine':
      return 'mine';
    case 'unclaimed':
      return 'unclaimed';
    case 'due_today':
      return 'due_today';
    case 'overdue':
      return 'overdue';
    case 'stale':
      return 'stale';
    case 'closed':
      return null;
  }
}

const ATTENTION_LABELS: Record<string, string> = {
  unclaimed: 'Unclaimed too long',
  information_stalled: 'Information Needed too long',
  carrier_waiting: 'Carrier waiting too long',
  options_not_sent: 'Options ready but not sent',
  followup_overdue: 'Price sent with overdue follow-up',
  stale: 'No recent activity',
};

export function attentionLabel(bucket: string): string {
  return ATTENTION_LABELS[bucket] ?? titleCase(bucket);
}

// ── Activity ─────────────────────────────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  opportunity_created: 'Quote created',
  intake_received: 'Intake received from Customer Service',
  legacy_adopted: 'Migrated from the Commercial Board',
  claimed: 'Claimed',
  reassigned: 'Transferred',
  unassigned: 'Assignment removed',
  stage_changed: 'Stage changed',
  field_updated: 'Information updated',
  priority_changed: 'Priority changed',
  next_action_set: 'Next action set',
  note_added: 'Note added',
  document_uploaded: 'Document uploaded',
  document_deleted: 'Document removed',
  checklist_item_added: 'Checklist item added',
  checklist_item_toggled: 'Checklist item updated',
  information_requested: 'Information requested',
  information_received: 'Information received',
  information_waived: 'Information waived',
  carrier_added: 'Carrier added',
  carrier_updated: 'Carrier updated',
  carrier_submitted: 'Submitted to carrier',
  carrier_quote_received: 'Carrier quote received',
  carrier_declined: 'Carrier declined',
  carrier_withdrawn: 'Carrier withdrawn',
  carrier_removed: 'Carrier removed',
  price_sent: 'Price sent to customer',
  result_recorded: 'Result recorded',
  result_cleared: 'Reopened',
  team_changed: 'Team changed',
  // Intake-side events that appear in the merged timeline.
  created: 'Intake started',
  submitted: 'Intake submitted',
  converted_specialty: 'Handed to the specialty team',
  converted_commercial: 'Sent to the Commercial Board',
  specialty_edit: 'Customer information corrected',
  returned: 'Intake returned',
  note: 'Note added',
};

export function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? titleCase(eventType);
}

export function eventTone(eventType: string): Tone {
  if (eventType === 'result_recorded' || eventType === 'carrier_quote_received') return 'success';
  if (
    eventType === 'carrier_declined' ||
    eventType === 'information_requested' ||
    eventType === 'result_cleared'
  ) {
    return 'danger';
  }
  if (eventType === 'price_sent') return 'cyan';
  if (eventType === 'claimed' || eventType === 'reassigned') return 'violet';
  if (eventType === 'carrier_submitted' || eventType === 'stage_changed') return 'progress';
  return 'neutral';
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Formats a phone number without discarding anything unexpected. */
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

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `$${Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Short relative time. Today and yesterday are named, everything else is dated. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `Today ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** A due date, said the way an employee would say it. */
export function formatDue(value: string | null | undefined): string {
  if (!value) return 'No due date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No due date';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDue = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startOfDue.getTime() - startOfToday.getTime()) / 86_400_000);

  if (days === 0) return `Due today ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (days === 1) return 'Due tomorrow';
  if (days === -1) return 'Overdue by 1 day';
  if (days < -1) return `Overdue by ${Math.abs(days)} days`;
  return `Due in ${days} days`;
}

/**
 * The carrier progress line a summary card shows.
 *
 * Deliberately a summary rather than five rows: the card answers "how far along is
 * the marketing", and the detail drawer answers "what did each carrier say".
 */
export function carrierSummary(row: {
  markets_total: number;
  markets_submitted: number;
  markets_quoted: number;
}): string {
  if (row.markets_total === 0) return 'No carriers yet';
  const parts = [`${row.markets_submitted}/${row.markets_total} submitted`];
  if (row.markets_quoted > 0) {
    parts.push(`${row.markets_quoted} quote${row.markets_quoted === 1 ? '' : 's'} received`);
  }
  return parts.join(' · ');
}

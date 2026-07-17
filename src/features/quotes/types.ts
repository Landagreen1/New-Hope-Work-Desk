// src/features/quotes/types.ts
// Quote-specific TypeScript types for the Customer Intake, Claim, and Duplicate Quote feature

export type IntakeStatus =
  | 'draft'
  | 'submitted'
  | 'waiting_for_claim'
  | 'waiting_for_assignment'
  | 'claimed'
  | 'assigned'
  | 'converted'
  | 'deleted';

export type QuoteStatus =
  | 'assigned'
  | 'quoting'
  | 'pricing_sent'
  | 'not_sold'
  | 'activation_pending'
  | 'activated'
  | 'sold'
  | 'duplicate_review'
  | 'merged_duplicate';

/**
 * Decision on a finalized quote outcome.
 * When decision changes, `finalized_at` is updated — use `finalized_at` as the canonical
 * reporting date for period attribution, not `quote_created_at`.
 */
export type QuoteDecision = 'sold' | 'not_sold';

export type { NotSoldReason } from '@/lib/types';

export type AssignmentMethod =
  | 'ringcentral_claim'
  | 'manager_assignment'
  | 'automatic_rotation'
  | 'renewal_requote';

export type SourceType =
  | 'dealership'
  | 'walk_in_office'
  | 'whatsapp'
  | 'ringcentral'
  | 'customer_service'
  | 'renewal_requote'
  | 'existing_customer'
  | 'referral'
  | 'other';

export type NotificationType =
  | 'quote_assigned'
  | 'intake_claimed'
  | 'duplicate_flagged'
  | 'duplicate_resolved'
  | 'intake_updated'
  | 'quote_reassigned';

export type DuplicateDecision = 'not_duplicate' | 'merge' | 'keep_both_link';

export type UrgencyLevel = 'normal' | 'elevated' | 'high';

export interface OperationalQuote {
  id: string;
  customer_intake_id: string;
  customer_name: string;
  source_type: SourceType;
  dealer_id: string | null;
  dealer_salesperson_id: string | null;
  line_of_business: 'personal_auto' | 'commercial_auto';
  phone: string | null;
  email: string | null;
  quote_origin: string | null;
  status: QuoteStatus;
  pre_flag_status: QuoteStatus | null;
  assigned_to: string;
  intake_creator: string;
  assignment_method: AssignmentMethod;
  assigned_at: string;
  claimed_at: string | null;
  last_progression_at: string;
  linked_quote_id: string | null;
  merged_into_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DuplicateReview {
  id: string;
  flagged_quote_id: string;
  original_quote_id: string;
  flagged_by: string;
  flagged_at: string;
  reason: string;
  resolved_by: string | null;
  resolved_at: string | null;
  decision: DuplicateDecision | null;
  resolution_details: Record<string, unknown> | null;
  status: 'pending' | 'resolved';
}

export interface Notification {
  id: string;
  recipient_id: string;
  notification_type: NotificationType;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  action_url: string | null;
  is_read: boolean;
  is_dismissed: boolean;
  created_at: string;
  read_at: string | null;
}

export interface IntakeHistoryEvent {
  id: string;
  intake_id: string;
  linked_quote_id: string | null;
  actor_id: string;
  actor_display_name: string;
  event_type: string;
  changed_fields: Array<{ field: string; old_value: unknown; new_value: unknown }> | null;
  details: string | null;
  reason: string | null;
  created_at: string;
}

export interface QuoteHistoryEvent {
  id: string;
  quote_id: string;
  linked_intake_id: string | null;
  actor_id: string;
  actor_display_name: string;
  event_type: string;
  note_log_content: string | null;
  changed_fields: Array<{ field: string; old_value: unknown; new_value: unknown }> | null;
  details: string | null;
  reason: string | null;
  created_at: string;
}

// Valid transitions map (enforced in SQL, mirrored for UI)
export const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  assigned: ['quoting'],
  quoting: ['pricing_sent', 'not_sold'],
  pricing_sent: ['activation_pending', 'not_sold'],
  activation_pending: ['activated', 'not_sold'],
  activated: ['sold', 'not_sold'],
  sold: [],
  not_sold: [],
  duplicate_review: [], // resolved by manager
  merged_duplicate: [],
};

// Urgency calculation
export function calculateUrgency(quote: OperationalQuote): UrgencyLevel {
  if (quote.status !== 'assigned') return 'normal';
  const hoursSince = (Date.now() - new Date(quote.last_progression_at).getTime()) / 3_600_000;
  if (hoursSince > 48) return 'high';
  if (hoursSince > 24) return 'elevated';
  return 'normal';
}

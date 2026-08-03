// Cancellation domain: follow-up recording types and constants.
//
// REQ-6.2, REQ-6.3: Defines the outcome values, contact methods, and payload shape
// for the consolidated follow-up recording action.
//
// Pure module: no React, no Supabase, no I/O.

import type { NextRequiredAction } from './communication-status';

// ---------------------------------------------------------------------------
// Contact methods
// ---------------------------------------------------------------------------

export const FOLLOW_UP_CONTACT_METHODS = [
  'Phone',
  'Email',
  'SMS',
  'WhatsApp',
  'In-person',
] as const;

export type FollowUpContactMethod = (typeof FOLLOW_UP_CONTACT_METHODS)[number];

// ---------------------------------------------------------------------------
// Directions
// ---------------------------------------------------------------------------

export const FOLLOW_UP_DIRECTIONS = [
  'Inbound',
  'Outbound',
] as const;

export type FollowUpDirection = (typeof FOLLOW_UP_DIRECTIONS)[number];

// ---------------------------------------------------------------------------
// Outcomes (REQ-6.3)
// ---------------------------------------------------------------------------

export const FOLLOW_UP_OUTCOMES = [
  'No answer',
  'Left voicemail',
  'Message sent',
  'Email sent',
  'Spoke with customer',
  'Customer requested assistance',
  'Customer reports payment',
  'Wrong contact information',
  'Customer will not pay',
  'Customer accepts cancellation',
  'Other',
] as const;

export type FollowUpOutcome = (typeof FOLLOW_UP_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Payload (REQ-6.2)
// ---------------------------------------------------------------------------

/**
 * The full follow-up recording payload. Stored as `cancellation_events.detail` jsonb
 * with `event_type = 'follow_up'`.
 */
export interface FollowUpPayload {
  /** Contact method used. */
  contactMethod: FollowUpContactMethod;
  /** Whether the contact was inbound or outbound. */
  direction: FollowUpDirection;
  /** The contact value used (phone number, email, or manual entry). */
  contactUsed: string;
  /** The outcome of the follow-up attempt. */
  outcome: FollowUpOutcome;
  /** Required notes (1–4000 characters). */
  notes: string;
  /** Optional customer response summary. */
  customerResponse?: string | null;
  /** Whether the customer reported a payment. */
  paymentReported: boolean;
  /** Evidence file UUIDs (from cancellation-evidence bucket). */
  evidenceFiles?: string[];
  /** Optional next follow-up date (ISO date string). */
  nextFollowUpDate?: string | null;
  /** Optional next required action to set on the case. */
  nextRequiredAction?: NextRequiredAction | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const MIN_FOLLOW_UP_NOTES_LENGTH = 1;
export const MAX_FOLLOW_UP_NOTES_LENGTH = 4000;
export const MAX_FOLLOW_UP_EVIDENCE_FILES = 10;

/**
 * Validates a follow-up payload. Returns null if valid, or an error message.
 */
export function validateFollowUpPayload(payload: Partial<FollowUpPayload>): string | null {
  if (!payload.contactMethod || !FOLLOW_UP_CONTACT_METHODS.includes(payload.contactMethod)) {
    return 'Contact method is required.';
  }
  if (!payload.direction || !FOLLOW_UP_DIRECTIONS.includes(payload.direction)) {
    return 'Direction is required.';
  }
  if (!payload.contactUsed || payload.contactUsed.trim().length === 0) {
    return 'Contact used is required.';
  }
  if (!payload.outcome || !FOLLOW_UP_OUTCOMES.includes(payload.outcome)) {
    return 'Outcome is required.';
  }
  if (!payload.notes || payload.notes.length < MIN_FOLLOW_UP_NOTES_LENGTH) {
    return 'Notes are required.';
  }
  if (payload.notes.length > MAX_FOLLOW_UP_NOTES_LENGTH) {
    return `Notes must be at most ${MAX_FOLLOW_UP_NOTES_LENGTH} characters.`;
  }
  if (payload.evidenceFiles && payload.evidenceFiles.length > MAX_FOLLOW_UP_EVIDENCE_FILES) {
    return `At most ${MAX_FOLLOW_UP_EVIDENCE_FILES} evidence files are allowed.`;
  }
  return null;
}

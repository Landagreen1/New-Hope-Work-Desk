// Policy Follow-up: the Attention Required cards (Requirement 9.3, design 10.2).
//
// Requirement 9.3 asks for actionable exception cards and, crucially, that *each count be clickable
// into the underlying records with the corresponding filter applied*. A number a manager cannot open
// is a number they cannot act on, so the drill-down target is part of the card's definition rather
// than something the component decides while rendering.
//
// Every target reuses a filter the domain list already has, which is what design 10.2 asks for. The
// three that no existing filter can represent — unassigned policies, ownership conflicts, and the
// import review lists — target the manager and imports surfaces instead of inventing a domain filter
// for them.
//
// Pure module: no React, no Supabase, no clock.

import type { PolicyAttentionCard, PolicyFollowUpManagerOverview } from './types';

/**
 * The cards, in the order a manager should read them.
 *
 * Ordering rule: work that is already late first, then work that is blocked, then work that is
 * merely unowned. A zero count still produces a card — a manager reading "Overdue cancellations 0"
 * has learned something, and hiding the row would make its later appearance look like a new feature
 * rather than a new problem.
 */
export function buildAttentionCards(
  overview: PolicyFollowUpManagerOverview,
): PolicyAttentionCard[] {
  const { renewals, cancellations, attention } = overview;

  return [
    {
      id: 'cancellations-overdue',
      label: 'Cancellations overdue',
      count: cancellations.overdue,
      hint: 'A follow-up deadline has passed and the case is still active.',
      target: { tab: 'cancellations', filter: 'needs-action', extra: 'overdue' },
    },
    {
      id: 'renewals-overdue',
      label: 'Renewals overdue',
      count: renewals.overdue,
      hint: 'A scheduled renewal follow-up is past due.',
      target: { tab: 'renewals', filter: 'overdue-follow-up' },
    },
    {
      id: 'cancellations-no-contact',
      label: 'Cancellations with no successful contact',
      count: cancellations.neverContacted,
      hint: 'No message reached the customer and no response was recorded.',
      target: { tab: 'cancellations', filter: 'no-successful-contact' },
    },
    {
      id: 'renewals-no-contact',
      label: 'Renewals never contacted',
      count: renewals.neverContacted,
      hint: 'No contact of any kind has been recorded against the renewal.',
      target: { tab: 'renewals', filter: 'no-contact-recorded' },
    },
    {
      id: 'carrier-non-renewals',
      label: 'Carrier non-renewals awaiting a requote',
      count: attention.carrierNonRenewalAwaitingRequote,
      hint: 'The carrier will not renew and no requote has been started. Never a lost policy.',
      target: { tab: 'renewals', filter: 'requote-requested' },
    },
    {
      id: 'payment-verification',
      label: 'Payments awaiting verification',
      count: attention.paymentVerificationRequired,
      hint: 'A customer reported a payment and a manager has not verified it.',
      target: { tab: 'cancellations', filter: 'payment-verification-required' },
    },
    {
      id: 'failed-communications',
      label: 'Failed messages needing manual contact',
      count: attention.failedCommunications,
      hint: 'The last attempt on a channel failed. Somebody has to call.',
      target: { tab: 'cancellations', filter: 'communication-failed' },
    },
    {
      id: 'missing-contact',
      label: 'Active policies with no usable contact',
      count: attention.missingValidContact,
      hint: 'No valid, authorized phone or email is on file, so nothing can be sent at all.',
      target: { tab: 'cancellations', filter: 'contact-missing' },
    },
    {
      id: 'match-review',
      label: 'Imported rows with an uncertain customer match',
      count: attention.matchReviewRows,
      hint: 'The collector reported a probable match or none. Confirm before contacting.',
      target: { tab: 'imports', extra: 'match-review' },
    },
    {
      id: 'unknown-status',
      label: 'Imported rows with an unrecognized status',
      count: attention.unknownImportedStatus,
      hint: 'The carrier wording is not one Work Desk knows. The raw value was preserved.',
      target: { tab: 'imports', extra: 'unknown-status' },
    },
    {
      id: 'review-required-imports',
      label: 'Imports held for review',
      count: attention.reviewRequiredImports,
      hint: 'Held back from automatic customer messaging until a manager reviews them.',
      target: { tab: 'imports', extra: 'review-required' },
    },
    {
      id: 'unmatched-producers',
      label: 'Producer labels that map to nobody',
      count: attention.unmatchedProducerLabels,
      hint: 'An imported Productor value the assignment mapping does not recognize.',
      target: { tab: 'imports', extra: 'unmatched-producers' },
    },
    {
      id: 'unassigned-policies',
      label: 'Policies with no owner',
      count: attention.unassignedPolicies,
      hint: 'Live work in at least one domain and nobody accountable for it.',
      target: { tab: 'manager', extra: 'unassigned' },
    },
    {
      id: 'ownership-conflicts',
      label: 'Ownership conflicts to settle',
      count: attention.ownershipConflicts,
      hint: 'The renewal and the cancellation name different employees. Nothing was guessed.',
      target: { tab: 'manager', extra: 'conflict' },
    },
  ];
}

/** The cards with a non-zero count, for a compact rendering that hides the good news. */
export function pressingAttentionCards(
  overview: PolicyFollowUpManagerOverview,
): PolicyAttentionCard[] {
  return buildAttentionCards(overview).filter((card) => card.count > 0);
}

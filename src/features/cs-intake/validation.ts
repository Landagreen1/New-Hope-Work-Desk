// src/features/cs-intake/validation.ts
// Pure validation functions for intake identity and access control

import type { SourceType, IntakeStatus } from '../quotes/types';

/**
 * Input for identity matching comparison.
 * Uses the minimum identity criteria: customer_name, source_type, line_of_business.
 */
export interface IdentityMatchInput {
  customer_name: string;
  source_type: string;
  line_of_business: string;
}

/**
 * Checks if two intakes match on the minimum identity criteria:
 * customer_name, source_type, and line_of_business using case-insensitive
 * exact matching with whitespace trimming.
 *
 * Validates: Requirements 1.3
 */
export function identityMatches(a: IdentityMatchInput, b: IdentityMatchInput): boolean {
  return (
    a.customer_name.trim().toLowerCase() === b.customer_name.trim().toLowerCase() &&
    a.source_type.trim().toLowerCase() === b.source_type.trim().toLowerCase() &&
    a.line_of_business.trim().toLowerCase() === b.line_of_business.trim().toLowerCase()
  );
}

export interface IntakeIdentityInput {
  customer_name?: string | null;
  source_type?: SourceType | null;
  line_of_business?: string | null;
  phone?: string | null;
  email?: string | null;
  created_by?: string | null;
  dealer_id?: string | null;
  dealer_salesperson_id?: string | null;
  source_description?: string | null;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates that an intake has all required identity components before save.
 *
 * Requirements:
 * - customer_name must be non-empty after trim (Req 1.2)
 * - source_type is required (Req 1.2)
 * - line_of_business is required (Req 1.2)
 * - At least one of phone or email must be provided (Req 1.2)
 * - intake creator (created_by) is required (Req 1.2)
 * - When source_type is 'dealership', both dealer_id and dealer_salesperson_id are required (Req 1.5)
 * - When source_type is 'other', source_description is required and non-empty after trim (Req 1.6)
 */
export function validateIntakeIdentity(intake: IntakeIdentityInput): ValidationResult {
  const errors: string[] = [];

  // customer_name required and non-empty after trim
  if (!intake.customer_name || intake.customer_name.trim().length === 0) {
    errors.push('customer_name is required and must be non-empty');
  }

  // source_type required
  if (!intake.source_type) {
    errors.push('source_type is required');
  }

  // line_of_business required
  if (!intake.line_of_business) {
    errors.push('line_of_business is required');
  }

  // At least one of phone or email
  if (!intake.phone && !intake.email) {
    errors.push('At least one of phone or email is required');
  }

  // created_by (intake creator) required
  if (!intake.created_by) {
    errors.push('created_by (intake creator) is required');
  }

  // Dealership requires both dealer_id and dealer_salesperson_id
  if (intake.source_type === 'dealership') {
    if (!intake.dealer_id) {
      errors.push('dealer_id is required when source_type is dealership');
    }
    if (!intake.dealer_salesperson_id) {
      errors.push('dealer_salesperson_id is required when source_type is dealership');
    }
  }

  // Other requires source_description non-empty
  if (intake.source_type === 'other') {
    if (!intake.source_description || intake.source_description.trim().length === 0) {
      errors.push('source_description is required when source_type is other');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Determines whether a CS_User can edit a given intake.
 *
 * Rules:
 * - CS_Users can edit intakes they created (created_by matches their ID) (Req 2.1, 2.2)
 * - CS_Users cannot edit intakes created by another user (Req 2.5)
 * - CS_Users can edit in statuses: draft, submitted, waiting_for_claim, waiting_for_assignment,
 *   claimed, assigned, converted (Req 2.1, 2.2)
 * - CS_Users cannot permanently delete intakes (implied: 'deleted' status blocks edit)
 */
export function canCsUserEdit(
  intake: { created_by: string; status: string },
  userId: string
): boolean {
  // Must be the creator
  if (intake.created_by !== userId) {
    return false;
  }

  // Editable statuses for CS_User
  const editableStatuses: string[] = [
    'draft',
    'submitted',
    'waiting_for_claim',
    'waiting_for_assignment',
    'claimed',
    'assigned',
    'converted',
  ];

  return editableStatuses.includes(intake.status);
}

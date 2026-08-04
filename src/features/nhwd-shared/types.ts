import { roleToDepartment, type Department } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

export type { AppRole, Department };
export { roleToDepartment };

/**
 * Department mapping:
 *   Sales supervisors manage Sales only.
 *   Customer Service supervisors manage Customer Service only.
 *   Commercial supervisors manage Commercial only.
 *   Managers and Super Admins retain broad management access.
 */

/**
 * Insurance lines — currently only auto/personal lines are active.
 * Commercial, Homes, and Trucking will be added in future iterations.
 */
export type InsuranceLine = 'auto' | 'commercial' | 'homes' | 'trucking';

export interface ProfileLite {
  id: string;
  display_name: string;
  initials: string;
  role: AppRole;
  is_active: boolean;
  /**
   * Authorized to take walk-in Customer Service intakes
   * (`cs_intake_submissions.is_walk_in`). Enforced server-side by
   * public.profile_can_claim_walk_in() — see
   * supabase/migrations/v1.11.0-walk-in-claim-eligibility.sql. Optional here
   * because some callers build a ProfileLite from a narrower select.
   */
  can_claim_walk_in?: boolean;
}

// Re-export status types from quotes feature for shared access
export type { IntakeStatus, QuoteStatus } from '../quotes/types';

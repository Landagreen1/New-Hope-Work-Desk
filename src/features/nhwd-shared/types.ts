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
}

// Re-export status types from quotes feature for shared access
export type { IntakeStatus, QuoteStatus } from '../quotes/types';

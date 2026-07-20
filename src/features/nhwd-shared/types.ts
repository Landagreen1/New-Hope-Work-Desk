export type AppRole = 'agent' | 'customer_service' | 'manager' | 'commercial';

/**
 * Department mapping (maps to AppRole values in the database):
 *   Sales        → 'agent'
 *   Management   → 'manager'
 *   Customer Service → 'customer_service'
 *   Commercial   → 'commercial'
 *
 * Renewals is a cross-cutting concern available to ALL departments.
 * Intake forms and the sales intake queue are also shared across all departments.
 * The Commercial Board is accessible to commercial and manager roles only.
 */
export type Department = 'sales' | 'management' | 'customer_service' | 'commercial';

/** Maps the DB role value to a logical department. */
export function roleToDepartment(role: AppRole): Department {
  switch (role) {
    case 'agent': return 'sales';
    case 'manager': return 'management';
    case 'customer_service': return 'customer_service';
    case 'commercial': return 'commercial';
  }
}

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

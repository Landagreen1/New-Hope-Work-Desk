export type AppRole = 'agent' | 'customer_service' | 'manager';

export interface ProfileLite {
  id: string;
  display_name: string;
  initials: string;
  role: AppRole;
  is_active: boolean;
}

// Re-export status types from quotes feature for shared access
export type { IntakeStatus, QuoteStatus } from '../quotes/types';

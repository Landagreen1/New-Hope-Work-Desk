export type AppRole = 'agent' | 'customer_service' | 'manager';

export interface ProfileLite {
  id: string;
  display_name: string;
  initials: string;
  role: AppRole;
  is_active: boolean;
}

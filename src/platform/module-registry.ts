import type { AppRole } from '@/lib/types';
import {
  APP_ROLES,
  canAccessCommercial,
  canAccessCustomerService,
  canAccessRenewals,
  canAccessSales,
  canAccessSalesIntakeQueue,
} from '@/lib/permissions';

export type ModuleRole = AppRole;
export type ModuleStatus = 'active' | 'planned';

export interface AppModule {
  id: string;
  name: string;
  description: string;
  route: string;
  roles: ModuleRole[];
  status: ModuleStatus;
}

function rolesWhere(predicate: (role: AppRole) => boolean): ModuleRole[] {
  return APP_ROLES.filter(predicate);
}

export const appModules: AppModule[] = [
  {
    id: 'work-desk',
    name: 'Work Desk',
    description: 'Sales rotations, active work, pending pricing, quote records, and performance reporting.',
    route: '/',
    roles: [...APP_ROLES],
    status: 'active',
  },
  {
    id: 'operations-tools',
    name: 'Operations Tools',
    description: 'Role-aware launcher for Customer Service Quote Intake and Renewals Management.',
    route: '/tools',
    roles: rolesWhere((role) =>
      canAccessSales(role) || canAccessCustomerService(role) || canAccessRenewals(role),
    ),
    status: 'active',
  },
  {
    id: 'cs-intake',
    name: 'Customer Service Quote Intake',
    description: 'Structured Personal Auto and Commercial Auto intake for Customer Service.',
    route: '/tools/cs-intake',
    roles: rolesWhere(canAccessCustomerService),
    status: 'active',
  },
  {
    id: 'cs-intake-queue',
    name: 'Sales Intake Queue',
    description: 'Claim or assign completed Customer Service intakes and convert them into quotes.',
    route: '/tools/cs-intake/queue',
    roles: rolesWhere(canAccessSalesIntakeQueue),
    status: 'active',
  },
  {
    id: 'renewals',
    name: 'Renewals Management',
    description: 'Import, assign, document, monitor, and re-quote renewals.',
    route: '/tools/renewals',
    roles: rolesWhere(canAccessRenewals),
    status: 'active',
  },
  {
    id: 'commercial-board',
    name: 'Commercial Quotes Board',
    description: 'Kanban board for managing commercial policy quotes pipeline.',
    route: '/',
    roles: rolesWhere(canAccessCommercial),
    status: 'active',
  },
];

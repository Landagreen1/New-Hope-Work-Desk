import type { AppRole } from '@/lib/types';
import {
  APP_ROLES,
  canAccessCommercial,
  canAccessCustomerService,
  canAccessRenewals,
  canAccessSales,
  canAccessSalesIntakeQueue,
} from '@/lib/permissions';
import { viewQuoteCenter as canViewQuoteCenter } from '@/features/quote-center/permissions';

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
    // The queue is work, so it is now the Intake section of My Desk rather than a
    // destination of its own. The id and route are kept so an existing `cs-intake-queue`
    // lookup still resolves; the route redirects to My Desk with that section open.
    id: 'cs-intake-queue',
    name: 'Sales Intake Queue',
    description: 'Moved into My Desk. Opens the Intake section of the Work Desk.',
    route: '/?desk=intake',
    roles: rolesWhere(canAccessSalesIntakeQueue),
    status: 'active',
  },
  {
    id: 'quote-center',
    name: 'Quote Center',
    description:
      'One search across every stage of a customer quote journey: drafts, submitted intakes, active quotes, price sent, sold and not sold.',
    route: '/',
    roles: rolesWhere(canViewQuoteCenter),
    status: 'active',
  },
  {
    id: 'policy-follow-up',
    name: 'Policy Follow-up',
    description: 'Renewals coming due and policies heading to cancellation, in one workspace.',
    route: '/tools/policy-follow-up',
    roles: rolesWhere(canAccessRenewals),
    status: 'active',
  },
  {
    // Kept so existing `renewals` lookups keep resolving; retargeted to the workspace that now
    // hosts the Renewals tab.
    id: 'renewals',
    name: 'Renewals Management',
    description: 'Import, assign, document, monitor, and re-quote renewals.',
    route: '/tools/policy-follow-up',
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

export type ModuleRole = 'agent' | 'manager' | 'customer_service';
export type ModuleStatus = 'active' | 'planned';

export interface AppModule {
  id: string;
  name: string;
  description: string;
  route: string;
  roles: ModuleRole[];
  status: ModuleStatus;
}

export const appModules: AppModule[] = [
  {
    id: 'work-desk',
    name: 'Work Desk',
    description: 'Sales rotations, active work, pending pricing, quote records, and performance reporting.',
    route: '/',
    roles: ['agent', 'manager', 'customer_service'],
    status: 'active',
  },
  {
    id: 'operations-tools',
    name: 'Operations Tools',
    description: 'Role-aware launcher for Customer Service Quote Intake and Renewals Management.',
    route: '/tools',
    roles: ['agent', 'manager', 'customer_service'],
    status: 'active',
  },
  {
    id: 'cs-intake',
    name: 'Customer Service Quote Intake',
    description: 'Structured Personal Auto and Commercial Auto intake for Customer Service.',
    route: '/tools/cs-intake',
    roles: ['customer_service', 'manager'],
    status: 'active',
  },
  {
    id: 'cs-intake-queue',
    name: 'Sales Intake Queue',
    description: 'Claim or assign completed Customer Service intakes and convert them into quotes.',
    route: '/tools/cs-intake/queue',
    roles: ['agent', 'manager'],
    status: 'active',
  },
  {
    id: 'renewals',
    name: 'Renewals Management',
    description: 'Import, assign, document, monitor, and re-quote renewals.',
    route: '/tools/renewals',
    roles: ['agent', 'manager', 'customer_service'],
    status: 'active',
  },
];

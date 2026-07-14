export type ModuleRole = "agent" | "manager";

export type AppModuleDefinition = {
  id: string;
  name: string;
  description: string;
  route: string;
  roles: ModuleRole[];
  status: "live" | "planned";
};

/**
 * Central registry for internal tools that belong to the New Hope platform.
 * Future modules should register here instead of adding hard-coded navigation
 * in multiple places.
 */

ts
{ id: 'cs-intake',  name: 'Quote Intake', path: '/tools/cs-intake',
  roles: ['customer_service', 'manager'] },
{ id: 'cs-intake-queue', name: 'Intake Queue', path: '/tools/cs-intake/queue',
  roles: ['agent', 'manager'] },
{ id: 'renewals', name: 'Renewals', path: '/tools/renewals',
  roles: ['agent', 'manager'] },

export const appModules: AppModuleDefinition[] = [
  {
    id: "work-desk",
    name: "Work Desk",
    description: "Turns, assignments, follow-up, notifications, and performance.",
    route: "/",
    roles: ["agent", "manager"],
    status: "live",
  },
];

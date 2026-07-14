export type ModuleRole = "agent" | "manager" | "customer_service";
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
export const appModules: AppModuleDefinition[] = [
  {
    id: "work-desk",
    name: "Work Desk",
    description: "Turns, assignments, follow-up, notifications, and performance.",
    route: "/",
    roles: ["agent", "manager"],
    status: "live",
  },
  {
    id: "cs-intake",
    name: "Quote Intake",
    description: "Customer service collects standardized quote information for the sales queue.",
    route: "/tools/cs-intake",
    roles: ["customer_service", "manager"],
    status: "live",
  },
  {
    id: "cs-intake-queue",
    name: "Intake Queue",
    description: "Agents claim completed intakes and convert them into quotes.",
    route: "/tools/cs-intake/queue",
    roles: ["agent", "manager"],
    status: "live",
  },
  {
    id: "renewals",
    name: "Renewals",
    description: "Import HawkSoft renewals, assign, contact, monitor, and send to re-quote.",
    route: "/tools/renewals",
    roles: ["agent", "manager"],
    status: "live",
  },
];

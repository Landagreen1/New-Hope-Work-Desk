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

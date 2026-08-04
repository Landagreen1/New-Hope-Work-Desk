import type { AppRole } from "@/lib/types";

export const APP_ROLES = [
  "agent",
  "manager",
  "customer_service",
  "commercial",
  "commercial_supervisor",
  "customer_service_supervisor",
  "sales_supervisor",
  "super_admin",
] as const satisfies readonly AppRole[];

export type Department =
  | "sales"
  | "customer_service"
  | "commercial"
  | "management";

export interface RolePermissions {
  sales: boolean;
  customerService: boolean;
  commercial: boolean;
  renewals: boolean;
  timeAttendance: boolean;
  manageSales: boolean;
  manageCustomerService: boolean;
  manageCommercial: boolean;
  userAdministration: boolean;
  attendanceAdministration: boolean;
}

export function isSuperAdminRole(role: AppRole): boolean {
  return role === "super_admin";
}

/** Broad agency management. Scoped supervisors must never satisfy this check. */
export function isBroadManagerRole(role: AppRole): boolean {
  return role === "manager" || role === "super_admin";
}

export function canManageSales(role: AppRole): boolean {
  return isBroadManagerRole(role) || role === "sales_supervisor";
}

export function canManageCustomerService(role: AppRole): boolean {
  return isBroadManagerRole(role) || role === "customer_service_supervisor";
}

export function canManageCommercial(role: AppRole): boolean {
  return isBroadManagerRole(role) || role === "commercial_supervisor";
}

export function canAccessSales(role: AppRole): boolean {
  // Commercial role does not have sales access — only commercial, CS, and time/attendance
  if (role === "commercial" || role === "commercial_supervisor") return false;
  return true;
}

/**
 * Shared CS-to-Sales handoff queue. Customer Service supervisors need this
 * workflow even though they do not receive general Sales module access.
 */
export function canAccessSalesIntakeQueue(role: AppRole): boolean {
  return canAccessSales(role) || canManageCustomerService(role);
}

export function canAccessCustomerService(role: AppRole): boolean {
  return role === "agent" || role === "customer_service" || role === "commercial" || role === "commercial_supervisor" || canManageCustomerService(role) || role === "sales_supervisor";
}

export function canAccessCommercial(role: AppRole): boolean {
  return role === "commercial" || canManageCommercial(role);
}

export function canAccessRenewals(role: AppRole): boolean {
  return (
    role === "agent" ||
    role === "customer_service" ||
    role === "sales_supervisor" ||
    isBroadManagerRole(role)
  );
}

export function canAdministerUsers(role: AppRole): boolean {
  return isBroadManagerRole(role);
}

/** Any scoped supervisor. There is no bare "supervisor" role in this project. */
export function isSupervisorRole(role: AppRole): boolean {
  return (
    role === "sales_supervisor" ||
    role === "customer_service_supervisor" ||
    role === "commercial_supervisor"
  );
}

/**
 * Operational SLA alerts (unclaimed personal intakes, suspiciously fast pricing).
 * Managers, super admins, and supervisors only — these alerts are about agent
 * behaviour and queue neglect, so agents and CS reps must not see them.
 *
 * Mirrors public.can_view_manager_alerts() in
 * supabase/migrations/v1.11.1-manager-sla-alerts.sql, which is the enforcing
 * check. This helper only decides whether to bother asking.
 */
export function canViewManagerAlerts(role: AppRole): boolean {
  return isBroadManagerRole(role) || isSupervisorRole(role);
}

export function canAdministerAttendance(role: AppRole): boolean {
  return isSuperAdminRole(role);
}

export function getRolePermissions(role: AppRole): RolePermissions {
  return {
    sales: canAccessSales(role),
    customerService: canAccessCustomerService(role),
    commercial: canAccessCommercial(role),
    renewals: canAccessRenewals(role),
    timeAttendance: true,
    manageSales: canManageSales(role),
    manageCustomerService: canManageCustomerService(role),
    manageCommercial: canManageCommercial(role),
    userAdministration: canAdministerUsers(role),
    attendanceAdministration: canAdministerAttendance(role),
  };
}

export function roleToDepartment(role: AppRole): Department {
  switch (role) {
    case "agent":
    case "sales_supervisor":
      return "sales";
    case "customer_service":
    case "customer_service_supervisor":
      return "customer_service";
    case "commercial":
    case "commercial_supervisor":
      return "commercial";
    case "manager":
    case "super_admin":
      return "management";
  }
}

export function roleLabel(role: AppRole): string {
  switch (role) {
    case "agent":
      return "Sales";
    case "sales_supervisor":
      return "Sales Supervisor";
    case "customer_service":
      return "Customer Service";
    case "customer_service_supervisor":
      return "Customer Service Supervisor";
    case "commercial":
      return "Commercial";
    case "commercial_supervisor":
      return "Commercial Supervisor";
    case "manager":
      return "Manager / Admin";
    case "super_admin":
      return "Super Admin";
  }
}

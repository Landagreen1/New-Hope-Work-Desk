"use client";

import {
  BarChart3,
  Building2,
  Calendar,
  CalendarOff,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  Clock,
  FileSpreadsheet,
  Gauge,
  Headphones,
  LayoutDashboard,
  LogOut,
  Menu,
  ShieldCheck,
  Table2,
  TrendingUp,
  UserCog,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useState } from "react";

import type { AppRole } from "@/features/nhwd-shared/types";
import { getRolePermissions } from "@/lib/permissions";

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

// ---------- Types ----------

export type ModuleId =
  | "sales"
  | "customer_service"
  | "commercial"
  | "renewals"
  | "time_attendance"
  | "user_admin";

export type SubNavId =
  // Sales
  | "sales_overview"
  | "sales_work"
  | "sales_databases"
  | "sales_reports"
  // Sales Agent sub-tabs
  | "sales_desk"
  | "sales_pricing"
  | "sales_intake_queue"
  | "sales_team"
  | "sales_performance"
  // Customer Service
  | "cs_intakes"
  | "cs_queue"
  // Commercial
  | "commercial_board"
  | "commercial_database"
  | "commercial_commissions"
  | "commercial_timing"
  | "commercial_commission_report"
  | "commercial_reports"
  // Renewals
  | "renewals_dashboard"
  // Time & Attendance
  | "ta_today"
  | "ta_schedule"
  | "ta_timeoff"
  | "ta_review"
  | "ta_payroll"
  | "ta_workforce"
  // User Admin
  | "ua_users";

/**
 * What a {@link NavigationTarget}'s `recordId` names.
 *
 * - `attendance_day` — one employee on one work date, as `profileId:workDate`.
 * - `pto_request` — one `pto_requests` row, by id.
 * - `coverage_date` — one calendar date, as `YYYY-MM-DD`.
 */
export type NavigationTargetRecordKind = 'attendance_day' | 'pto_request' | 'coverage_date';

/**
 * A navigation instruction that names a record as well as a screen.
 *
 * The Needs Attention inbox lists items that live on four different screens, and
 * selecting one has to land on the owning screen with that record's drawer open
 * (Requirement 17, criterion 6). Navigation state alone could not express that:
 * it named a screen and nothing else.
 *
 * `recordKind` and `recordId` are optional so that a target may name a screen on
 * its own. `openDrawer` is what asks the screen to open the detail drawer rather
 * than only select the row.
 *
 * Deliberately not a URL. The Time & Attendance module has no route of its own,
 * so a deep link would mean introducing routing — a larger change than this
 * redesign needs. A target is React state, and it is cleared once the owning
 * screen has resolved it, so it cannot reopen a drawer on a later render.
 *
 * Requirements: 1.11, 1.12, 17.6
 */
export interface NavigationTarget {
  screen: SubNavId;
  recordKind?: NavigationTargetRecordKind;
  recordId?: string;
  openDrawer?: boolean;
}

export interface NavigationState {
  module: ModuleId;
  subNav: SubNavId;
  /** Set only by a navigation that names a record, such as an inbox selection. */
  target?: NavigationTarget;
}

interface SubNavItem {
  id: SubNavId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
}

interface ModuleDefinition {
  id: ModuleId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  subItems: SubNavItem[];
}

// ---------- Module Definitions ----------

function getModulesForRole(role: AppRole, badges?: Record<string, number>): ModuleDefinition[] {
  const permissions = getRolePermissions(role);
  const isCS = role === "customer_service";

  const modules: ModuleDefinition[] = [];

  // Sales module
  if (permissions.sales) {
    const salesSubs: SubNavItem[] = permissions.manageSales
      ? [
          { id: "sales_overview", label: "Overview", icon: ShieldCheck },
          { id: "sales_work", label: "Work & Pricing", icon: ClipboardList, badge: badges?.sales_work },
          { id: "sales_databases", label: "Databases", icon: Table2 },
          { id: "sales_reports", label: "Reports", icon: BarChart3 },
        ]
      : isCS
        ? [
            { id: "sales_desk", label: "My Desk", icon: Gauge },
          ]
        : [
            { id: "sales_desk", label: "My Desk", icon: Gauge, badge: badges?.sales_desk },
            { id: "sales_pricing", label: "Pending Pricing", icon: Clock, badge: badges?.sales_pricing },
            { id: "sales_intake_queue", label: "Intake Queue", icon: ClipboardCheck, badge: badges?.sales_intake_queue },
            { id: "sales_team", label: "My Team", icon: UsersRound },
            { id: "sales_databases", label: "Databases", icon: Table2 },
            { id: "sales_performance", label: "Performance", icon: TrendingUp },
          ];

    modules.push({
      id: "sales",
      label: "Sales",
      icon: LayoutDashboard,
      subItems: salesSubs,
    });
  }

  // Customer Service
  if (permissions.customerService) {
    modules.push({
      id: "customer_service",
      label: "Customer Service",
      icon: Headphones,
      subItems: [
        { id: "cs_intakes", label: "Quote Intakes", icon: Headphones },
        { id: "cs_queue", label: "Sales Queue", icon: ClipboardCheck },
      ],
    });
  }

  // Commercial
  if (permissions.commercial) {
    const commercialSubs: SubNavItem[] = [
      { id: "commercial_board", label: "Commercial Board", icon: Building2 },
      { id: "commercial_database", label: "Database", icon: Table2 },
    ];
    if (permissions.manageCommercial) {
      commercialSubs.push(
        { id: "commercial_commissions", label: "Commission Review", icon: ShieldCheck },
        { id: "commercial_timing", label: "Timing Report", icon: Clock },
        { id: "commercial_commission_report", label: "Commission Report", icon: BarChart3 },
        { id: "commercial_reports", label: "Overview", icon: Gauge },
      );
    }
    modules.push({
      id: "commercial",
      label: "Commercial",
      icon: Building2,
      subItems: commercialSubs,
    });
  }

  // Renewals
  if (permissions.renewals) {
    modules.push({
      id: "renewals",
      label: "Renewals",
      icon: FileSpreadsheet,
      subItems: [
        { id: "renewals_dashboard", label: "Dashboard", icon: FileSpreadsheet },
      ],
    });
  }

  // Time & Attendance (all roles — super_admin gets extra tabs)
  {
    const taSubItems: SubNavItem[] = [
      { id: "ta_today", label: "Today", icon: Clock },
      { id: "ta_schedule", label: "Schedule", icon: Calendar },
      { id: "ta_timeoff", label: "Time Off & Coverage", icon: CalendarOff },
    ];
    if (permissions.attendanceAdministration) {
      taSubItems.push(
        { id: "ta_review", label: "Review", icon: ClipboardCheck },
        { id: "ta_payroll", label: "Payroll", icon: LayoutDashboard },
        { id: "ta_workforce", label: "Workforce", icon: BarChart3 },
      );
    }
    modules.push({
      id: "time_attendance",
      label: "Time & Attendance",
      icon: Calendar,
      subItems: taSubItems,
    });
  }

  // User Admin (broad manager/super_admin only)
  if (permissions.userAdministration) {
    modules.push({
      id: "user_admin",
      label: "User Administration",
      icon: UserCog,
      subItems: [
        { id: "ua_users", label: "Users & Sources", icon: UserCog },
      ],
    });
  }

  return modules;
}

export function getDefaultNavigation(role: AppRole): NavigationState {
  switch (role) {
    case "commercial":
    case "commercial_supervisor":
      return { module: "commercial", subNav: "commercial_board" };
    case "customer_service_supervisor":
      return { module: "customer_service", subNav: "cs_intakes" };
    case "manager":
    case "sales_supervisor":
    case "super_admin":
      return { module: "sales", subNav: "sales_overview" };
    case "agent":
    case "customer_service":
      return { module: "sales", subNav: "sales_desk" };
  }
}

/**
 * The navigation state to render for a role, given the state that was asked for.
 *
 * Three outcomes, in order:
 *
 *  1. The module is reachable and the sub-navigation item exists on it, so the
 *     state stands as asked.
 *  2. The module is reachable and the sub-navigation item is not one of its
 *     items, so the module's **first** item is used. This is what a retired
 *     identifier resolves to, and it is the whole of the guarantee now that the
 *     retired identifiers are gone from `SubNavId`: the comparison below is a
 *     string comparison against the items the module actually offers, so a stored
 *     Time & Attendance state naming an identifier this build no longer declares
 *     lands on that module's first item — Today — rather than being thrown out of
 *     the module altogether (Requirement 1, criterion 10). Nothing is looked up,
 *     so there is no missing entry to fail on.
 *  3. The module is not reachable at all, so the role's default applies.
 *
 * Outcome 2 is the change this function needed. Falling straight through to
 * `getDefaultNavigation` sent a stale Time & Attendance state to the Sales
 * overview, which is a different module than the one the user was last in — an
 * unexplained jump rather than the graceful resolution the criterion asks for.
 *
 * A record target survives only while it names the screen being rendered. A
 * target that named a retired or unreachable screen describes a record on a
 * screen nobody is looking at, and carrying it onto Today would open the wrong
 * drawer.
 *
 * Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.10, 1.11
 */
export function resolveNavigationForRole(
  role: AppRole,
  navigation: NavigationState,
): NavigationState {
  const accessibleModule = getModulesForRole(role).find(
    (candidate) => candidate.id === navigation.module,
  );

  if (accessibleModule === undefined) return getDefaultNavigation(role);

  if (accessibleModule.subItems.some((subItem) => subItem.id === navigation.subNav)) {
    return navigation.target === undefined || navigation.target.screen === navigation.subNav
      ? navigation
      : { module: navigation.module, subNav: navigation.subNav };
  }

  const firstSubItem = accessibleModule.subItems[0];
  if (firstSubItem === undefined) return getDefaultNavigation(role);

  return { module: accessibleModule.id, subNav: firstSubItem.id };
}

// ---------- Sidebar Component ----------

export function AppSidebar({
  role,
  navigation,
  onNavigate,
  badges,
  displayName,
  roleLabel,
  onSignOut,
}: {
  role: AppRole;
  navigation: NavigationState;
  onNavigate: (nav: NavigationState) => void;
  badges?: Record<string, number>;
  displayName?: string;
  roleLabel?: string;
  onSignOut?: () => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedModules, setExpandedModules] = useState<Set<ModuleId>>(
    () => new Set([navigation.module]),
  );

  const modules = getModulesForRole(role, badges);
  const safeNavigation = resolveNavigationForRole(role, navigation);

  const toggleModule = useCallback((moduleId: ModuleId) => {
    setExpandedModules((prev) => {
      const next = new Set(prev);
      if (next.has(moduleId)) {
        next.delete(moduleId);
      } else {
        next.add(moduleId);
      }
      return next;
    });
  }, []);

  const handleSubNav = useCallback(
    (moduleId: ModuleId, subNavId: SubNavId) => {
      onNavigate({ module: moduleId, subNav: subNavId });
      setMobileOpen(false);
    },
    [onNavigate],
  );

  const sidebarContent = (
    <nav className="flex h-full flex-col" aria-label="Main navigation">
      {/* Module list */}
      <div className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="space-y-1">
          {modules.map((mod) => {
            const isExpanded = expandedModules.has(mod.id) || safeNavigation.module === mod.id;
            const isActiveModule = safeNavigation.module === mod.id;
            const ModIcon = mod.icon;

            return (
              <li key={mod.id}>
                {/* Module header */}
                <button
                  type="button"
                  onClick={() => {
                    toggleModule(mod.id);
                    // If collapsing, no navigation change. If expanding, navigate to first sub-item
                    if (!isExpanded && mod.subItems.length > 0) {
                      onNavigate({ module: mod.id, subNav: mod.subItems[0].id });
                      setMobileOpen(false);
                    }
                  }}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-black transition-all duration-150",
                    isActiveModule
                      ? "bg-[#223f7a]/8 text-[#223f7a]"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors",
                      isActiveModule
                        ? "bg-[#223f7a] text-white"
                        : "bg-slate-100 text-slate-400 group-hover:bg-slate-200 group-hover:text-slate-600",
                    )}
                  >
                    <ModIcon className="h-4 w-4" />
                  </span>
                  <span className="flex-1 truncate">{mod.label}</span>
                  {mod.subItems.length > 1 && (
                    <span className="text-slate-400">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </span>
                  )}
                </button>

                {/* Sub-items */}
                {isExpanded && mod.subItems.length > 1 && (
                  <ul className="ml-5 mt-1 space-y-0.5 border-l-2 border-slate-100 pl-4">
                    {mod.subItems.map((sub) => {
                      const isActive = safeNavigation.subNav === sub.id;
                      const SubIcon = sub.icon;

                      return (
                        <li key={sub.id}>
                          <button
                            type="button"
                            onClick={() => handleSubNav(mod.id, sub.id)}
                            className={cn(
                              "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-bold transition-all duration-150",
                              isActive
                                ? "bg-[#223f7a] text-white shadow-sm"
                                : "text-slate-500 hover:bg-slate-50 hover:text-slate-800",
                            )}
                          >
                            <SubIcon
                              className={cn(
                                "h-3.5 w-3.5 shrink-0",
                                isActive ? "text-white" : "text-slate-400",
                              )}
                            />
                            <span className="flex-1 truncate">{sub.label}</span>
                            {sub.badge ? (
                              <span
                                className={cn(
                                  "grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[10px] font-black",
                                  isActive
                                    ? "bg-white/20 text-white"
                                    : "bg-rose-50 text-rose-600",
                                )}
                              >
                                {sub.badge}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {/* Single sub-item modules: auto-navigate on module click (already handled above) */}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Bottom: user info + sign out */}
      <div className="border-t border-slate-100 px-3 py-3">
        {displayName && (
          <div className="flex items-center gap-2 px-1 pb-2">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#223f7a] text-[10px] font-black text-white">
              {displayName.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-black text-slate-800">{displayName}</p>
              {roleLabel && (
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{roleLabel}</p>
              )}
            </div>
          </div>
        )}
        {onSignOut && (
          <button
            type="button"
            onClick={onSignOut}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        )}
      </div>
    </nav>
  );

  return (
    <>
      {/* Mobile hamburger trigger */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed bottom-4 left-4 z-50 grid h-12 w-12 place-items-center rounded-2xl bg-[#223f7a] text-white shadow-xl lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        >
          <aside
            className="h-full w-72 overflow-hidden bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <p className="text-sm font-black text-[#223f7a]">Navigation</p>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:border-r lg:border-slate-200 lg:bg-white">
        {sidebarContent}
      </aside>
    </>
  );
}

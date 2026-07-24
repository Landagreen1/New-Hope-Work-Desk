"use client";

import {
  BarChart3,
  Building2,
  Calendar,
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
import { useCallback, useEffect, useState } from "react";

import type { AppRole } from "@/features/nhwd-shared/types";

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
  // Renewals
  | "renewals_dashboard"
  // Time & Attendance
  | "ta_dashboard"
  // User Admin
  | "ua_users";

export interface NavigationState {
  module: ModuleId;
  subNav: SubNavId;
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
  const isManager = role === "manager" || role === "super_admin";
  const isAgent = role === "agent";
  const isCS = role === "customer_service";
  const isCommercial = role === "commercial";

  const modules: ModuleDefinition[] = [];

  // Sales module
  if (!isCommercial) {
    const salesSubs: SubNavItem[] = isManager
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
  if (isManager || isCS) {
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
  if (isManager || isCommercial) {
    modules.push({
      id: "commercial",
      label: "Commercial",
      icon: Building2,
      subItems: [
        { id: "commercial_board", label: "Kanban Board", icon: Building2 },
      ],
    });
  }

  // Renewals
  if (!isCommercial) {
    modules.push({
      id: "renewals",
      label: "Renewals",
      icon: FileSpreadsheet,
      subItems: [
        { id: "renewals_dashboard", label: "Dashboard", icon: FileSpreadsheet },
      ],
    });
  }

  // Time & Attendance (manager/super_admin only)
  if (isManager) {
    modules.push({
      id: "time_attendance",
      label: "Time & Attendance",
      icon: Calendar,
      subItems: [
        { id: "ta_dashboard", label: "Dashboard", icon: Clock },
      ],
    });
  }

  // User Admin (manager/super_admin only)
  if (isManager) {
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

  // Keep active module expanded
  useEffect(() => {
    setExpandedModules((prev) => {
      if (prev.has(navigation.module)) return prev;
      const next = new Set(prev);
      next.add(navigation.module);
      return next;
    });
  }, [navigation.module]);

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
            const isExpanded = expandedModules.has(mod.id);
            const isActiveModule = navigation.module === mod.id;
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
                      const isActive = navigation.subNav === sub.id;
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

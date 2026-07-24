"use client";

import Image from "next/image";
import { type ReactNode } from "react";

import { AppSidebar, type ModuleId, type NavigationState, type SubNavId } from "@/components/app-sidebar";
import type { AppRole } from "@/features/nhwd-shared/types";

export type { ModuleId, NavigationState, SubNavId };

/**
 * SidebarLayout provides the enterprise-grade shell for New Hope Work Desk.
 *
 * Structure:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Header: Logo | Work Desk label | (right: headerRight slot)    │
 * ├──────────────┬──────────────────────────────────────────────────┤
 * │  Sidebar     │  Main Content                                    │
 * │  (nav)       │                                                  │
 * │  ...         │                                                  │
 * │  User+Logout │                                                  │
 * └──────────────┴──────────────────────────────────────────────────┘
 */
export function SidebarLayout({
  role,
  displayName,
  navigation,
  onNavigate,
  onSignOut,
  badges,
  headerRight,
  children,
}: {
  role: AppRole;
  displayName?: string;
  navigation: NavigationState;
  onNavigate: (nav: NavigationState) => void;
  onSignOut?: () => void;
  badges?: Record<string, number>;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  const roleLabel =
    role === "super_admin"
      ? "Super Admin"
      : role === "manager"
        ? "Manager"
        : role === "customer_service"
          ? "Customer Service"
          : role === "commercial"
            ? "Commercial"
            : "Agent";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#f3f5f9] text-slate-950">
      {/* Top header bar */}
      <header className="z-30 flex shrink-0 items-center justify-between border-b border-[#dbe3f0] bg-white/95 px-4 py-2.5 backdrop-blur-xl sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Image
            src="/new-hope-logo-horizontal.png"
            alt="New Hope Insurance"
            width={160}
            height={40}
            className="h-9 w-auto object-contain"
            priority
          />
          <div className="hidden border-l border-slate-200 pl-3 md:block">
            <h1 className="text-sm font-black tracking-tight text-[#17305f]">
              Work Desk
            </h1>
            <p className="text-[10px] font-semibold text-slate-400">
              Operations Platform
            </p>
          </div>
        </div>
        {headerRight && (
          <div className="flex items-center gap-3">
            {headerRight}
          </div>
        )}
      </header>

      {/* Body: sidebar + content */}
      <div className="flex min-h-0 flex-1">
        <AppSidebar
          role={role}
          navigation={navigation}
          onNavigate={onNavigate}
          badges={badges}
          displayName={displayName}
          roleLabel={roleLabel}
          onSignOut={onSignOut}
        />

        {/* Main content area - scrollable */}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1700px] px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

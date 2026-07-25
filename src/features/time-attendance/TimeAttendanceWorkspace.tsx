'use client';

import {
  BarChart3,
  Calendar,
  Clock,
  DollarSign,
  PalmtreeIcon,
  Users,
} from 'lucide-react';
import { Suspense, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import PayrollDashboard from './PayrollDashboard';
import PTORequests from './PTORequests';
import ScheduleManager from './ScheduleManager';
import StaffingCoverage from './StaffingCoverage';
import TimeClock from './TimeClock';
import WorkforceAdmin from './WorkforceAdmin';

interface TimeAttendanceWorkspaceProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
}

type TATab = 'clock' | 'schedule' | 'pto' | 'payroll' | 'staffing' | 'workforce';

interface NavItem {
  id: TATab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  managerOnly?: boolean;
  superAdminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'clock', label: 'Time Clock', icon: Clock },
  { id: 'schedule', label: 'Schedule', icon: Calendar },
  { id: 'pto', label: 'Time Off', icon: PalmtreeIcon },
  { id: 'payroll', label: 'Payroll', icon: DollarSign },
  { id: 'staffing', label: 'Coverage', icon: Users, managerOnly: true },
  { id: 'workforce', label: 'Workforce', icon: BarChart3, superAdminOnly: true },
];

function LoadingFallback() {
  return (
    <div className="grid min-h-[300px] place-items-center rounded-2xl border border-slate-200 bg-white">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-[#223f7a]" />
    </div>
  );
}

export default function TimeAttendanceWorkspace({ initialProfile, embedded = false }: TimeAttendanceWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<TATab>('clock');
  const isManager = initialProfile.role === 'manager' || initialProfile.role === 'super_admin';
  const isSuperAdmin = initialProfile.role === 'super_admin';

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (item.superAdminOnly) return isSuperAdmin;
    if (item.managerOnly) return isManager;
    return true;
  });

  const activeItem = visibleItems.find((item) => item.id === activeTab) ?? visibleItems[0];

  return (
    <section className={embedded ? 'text-slate-950' : ''}>
      <div className="grid min-w-0 gap-5 xl:grid-cols-[240px_minmax(0,1fr)]">
        {/* Left sidebar navigation */}
        <aside className="hidden xl:block">
          <div className="sticky top-5 overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 p-5">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
                Time & Attendance
              </p>
              <h3 className="mt-1 text-lg font-black text-slate-900">
                {initialProfile.display_name?.split(' ')[0] ?? 'Dashboard'}
              </h3>
            </div>
            <nav className="space-y-1 p-3">
              {visibleItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveTab(item.id)}
                    className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm font-black transition ${
                      isActive
                        ? 'bg-[#223f7a] text-white shadow-sm'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                    }`}
                  >
                    <span
                      className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl ${
                        isActive ? 'bg-white/15' : 'bg-slate-100 text-[#223f7a]'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 truncate">{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        </aside>

        {/* Mobile: horizontal tab bar (visible on small screens only) */}
        <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm xl:hidden">
          <div className="flex gap-1 overflow-x-auto">
            {visibleItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex min-w-fit items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-black transition ${
                    isActive
                      ? 'bg-[#223f7a] text-white shadow-sm'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-[#223f7a]'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Main content area */}
        <div className="min-w-0">
          {/* Active section header */}
          <div className="mb-5 rounded-[28px] border border-[#c9d5e9] bg-gradient-to-br from-white to-[#f3f6fb] p-5 shadow-sm sm:p-6">
            <div className="flex items-center gap-4">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#223f7a] text-white shadow-sm">
                <activeItem.icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#4d6aa8]">
                  Time & Attendance
                </p>
                <h3 className="mt-1 text-2xl font-black tracking-tight text-[#17305f]">
                  {activeItem.label}
                </h3>
              </div>
            </div>
          </div>

          {/* Tab content */}
          <Suspense fallback={<LoadingFallback />}>
            {activeTab === 'clock' && <TimeClock initialProfile={initialProfile} />}
            {activeTab === 'schedule' && <ScheduleManager initialProfile={initialProfile} />}
            {activeTab === 'pto' && <PTORequests initialProfile={initialProfile} />}
            {activeTab === 'payroll' && <PayrollDashboard initialProfile={initialProfile} />}
            {activeTab === 'staffing' && isManager && <StaffingCoverage />}
            {activeTab === 'workforce' && isSuperAdmin && <WorkforceAdmin initialProfile={initialProfile} />}
          </Suspense>
        </div>
      </div>
    </section>
  );
}

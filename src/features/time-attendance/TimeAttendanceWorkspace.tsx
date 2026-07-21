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

interface TimeAttendanceWorkspaceProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
}

type TATab = 'clock' | 'schedule' | 'pto' | 'payroll' | 'staffing';

interface SubTab {
  id: TATab;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  managerOnly?: boolean;
}

const TABS: SubTab[] = [
  { id: 'clock', label: 'Time Clock', shortLabel: 'Clock', icon: Clock },
  { id: 'schedule', label: 'Schedule', shortLabel: 'Schedule', icon: Calendar },
  { id: 'pto', label: 'Time Off', shortLabel: 'PTO', icon: PalmtreeIcon },
  { id: 'payroll', label: 'Payroll', shortLabel: 'Pay', icon: DollarSign },
  { id: 'staffing', label: 'Coverage', shortLabel: 'Staff', icon: Users, managerOnly: true },
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

  const visibleTabs = TABS.filter((t) => !t.managerOnly || isManager);

  return (
    <section className={embedded ? 'text-slate-950' : ''}>
      {/* Sub-navigation */}
      <div className="mb-5 flex items-center gap-1 overflow-x-auto rounded-2xl border border-[#d4dff0] bg-gradient-to-b from-white to-[#f8fafd] p-1.5 shadow-sm">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`group flex min-w-fit items-center gap-2 rounded-xl px-3.5 py-2.5 text-left transition-all duration-200 ${
                selected
                  ? 'bg-gradient-to-b from-[#223f7a] to-[#1a3265] text-white shadow-md shadow-[#223f7a]/20'
                  : 'text-slate-500 hover:bg-white hover:text-[#223f7a] hover:shadow-sm'
              }`}
            >
              <Icon className={`h-4 w-4 ${selected ? 'text-white' : 'text-slate-400 group-hover:text-[#223f7a]'}`} />
              <span className="text-xs font-black sm:text-sm">
                <span className="sm:hidden">{tab.shortLabel}</span>
                <span className="hidden sm:inline">{tab.label}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <Suspense fallback={<LoadingFallback />}>
        {activeTab === 'clock' && <TimeClock initialProfile={initialProfile} />}
        {activeTab === 'schedule' && <ScheduleManager initialProfile={initialProfile} />}
        {activeTab === 'pto' && <PTORequests initialProfile={initialProfile} />}
        {activeTab === 'payroll' && <PayrollDashboard initialProfile={initialProfile} />}
        {activeTab === 'staffing' && isManager && <StaffingCoverage />}
      </Suspense>
    </section>
  );
}

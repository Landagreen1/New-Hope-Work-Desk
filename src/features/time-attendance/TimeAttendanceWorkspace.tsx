'use client';

import { Suspense, useEffect, useState } from 'react';

import { canAdministerAttendance } from '@/lib/permissions';

import type { ProfileLite } from '../nhwd-shared/types';
import PayrollDashboard from './PayrollDashboard';
import PayrollProcessor from './PayrollProcessor';
import PTORequests from './PTORequests';
import ScheduleManager from './ScheduleManager';
import StaffingCoverage from './StaffingCoverage';
import TimeClock from './TimeClock';
import WorkforceAdmin from './WorkforceAdmin';

interface TimeAttendanceWorkspaceProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
  /** Active tab driven by the global sidebar navigation */
  activeSection?: 'clock' | 'schedule' | 'pto' | 'payroll' | 'staffing' | 'workforce';
}

function LoadingFallback() {
  return (
    <div className="grid min-h-[300px] place-items-center rounded-2xl border border-slate-200 bg-white">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-[#223f7a]" />
    </div>
  );
}

export default function TimeAttendanceWorkspace({ initialProfile, embedded = false, activeSection = 'clock' }: TimeAttendanceWorkspaceProps) {
  const [tab, setTab] = useState(activeSection);
  const canAdminister = canAdministerAttendance(initialProfile.role);

  // Sync tab with prop changes (sidebar navigation)
  useEffect(() => {
    setTab(activeSection);
  }, [activeSection]);

  return (
    <section className={embedded ? 'text-slate-950' : ''}>
      <Suspense fallback={<LoadingFallback />}>
        {tab === 'clock' && <TimeClock initialProfile={initialProfile} />}
        {tab === 'schedule' && <ScheduleManager initialProfile={initialProfile} />}
        {tab === 'pto' && <PTORequests initialProfile={initialProfile} />}
        {tab === 'payroll' && canAdminister && (
          <div className="space-y-6">
            <PayrollDashboard initialProfile={initialProfile} />
            <PayrollProcessor initialProfile={initialProfile} />
          </div>
        )}
        {tab === 'staffing' && canAdminister && <StaffingCoverage />}
        {tab === 'workforce' && canAdminister && <WorkforceAdmin initialProfile={initialProfile} />}
      </Suspense>
    </section>
  );
}

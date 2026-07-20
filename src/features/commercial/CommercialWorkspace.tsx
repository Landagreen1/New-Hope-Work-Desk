'use client';

import {
  BarChart3,
  Database,
  Kanban,
  Shield,
} from 'lucide-react';
import { Suspense, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import CommercialBoard from './CommercialBoard';
import CommercialCommissionReview from './CommercialCommissionReview';
import CommercialDatabase from './CommercialDatabase';
import CommercialReports from './CommercialReports';

interface CommercialWorkspaceProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
}

type CommercialTab = 'board' | 'database' | 'commissions' | 'reports';

interface SubTab {
  id: CommercialTab;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  managerOnly?: boolean;
}

const TABS: SubTab[] = [
  { id: 'board', label: 'Kanban Board', shortLabel: 'Board', icon: Kanban },
  { id: 'database', label: 'Database', shortLabel: 'Database', icon: Database },
  { id: 'commissions', label: 'Commission Review', shortLabel: 'Commissions', icon: Shield },
  { id: 'reports', label: 'Reports', shortLabel: 'Reports', icon: BarChart3, managerOnly: true },
];

function LoadingFallback() {
  return (
    <div className="grid min-h-[300px] place-items-center rounded-2xl border border-slate-200 bg-white">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-[#223f7a]" />
    </div>
  );
}

export default function CommercialWorkspace({ initialProfile, embedded = false }: CommercialWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<CommercialTab>('board');
  const isManager = initialProfile.role === 'manager';

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
        {activeTab === 'board' && (
          <CommercialBoard initialProfile={initialProfile} embedded />
        )}
        {activeTab === 'database' && (
          <CommercialDatabase initialProfile={initialProfile} embedded />
        )}
        {activeTab === 'commissions' && (
          <CommercialCommissionReview initialProfile={initialProfile} embedded />
        )}
        {activeTab === 'reports' && isManager && (
          <CommercialReports initialProfile={initialProfile} embedded />
        )}
      </Suspense>
    </section>
  );
}

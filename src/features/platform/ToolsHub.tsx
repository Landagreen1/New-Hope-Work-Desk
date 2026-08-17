'use client';

import Link from 'next/link';
import { ArrowRight, ClipboardCheck, FileSpreadsheet, Headphones, ShieldCheck } from 'lucide-react';

import {
  canAccessCustomerService,
  canAccessRenewals,
  canAccessSalesIntakeQueue,
} from '@/lib/permissions';
import type { AppRole } from '@/lib/types';
import { appModules } from '@/platform/module-registry';

import type { ProfileLite } from '../nhwd-shared/types';
import { ModuleShell } from '../nhwd-shared/ModuleShell';

/**
 * Which launcher cards a role still needs.
 *
 * Only Quote Intake remains, and only for the roles whose sidebar has no route to
 * it — commercial and commercial supervisors, who reach it through the Customer
 * Service module. Everything else that used to be advertised here now has exactly
 * one home:
 *
 *   Sales Intake Queue -> the Intake section of My Desk
 *   Policy Follow-up   -> the Renewals module
 *
 * Leaving them here as well is what made an employee guess which of several
 * destinations held the thing they wanted.
 */
function canAccessModule(moduleId: string, role: AppRole): boolean {
  switch (moduleId) {
    case 'cs-intake':
      return canAccessCustomerService(role);
    default:
      return false;
  }
}

const modulePresentation = {
  'cs-intake': { icon: Headphones, tone: 'bg-cyan-50 text-cyan-700 ring-cyan-200' },
};

/** Where the destinations that used to be launcher cards now live. */
const RELOCATED = [
  {
    name: 'Sales Intake Queue',
    icon: ClipboardCheck,
    tone: 'bg-blue-50 text-blue-700 ring-blue-200',
    home: 'My Desk \u2192 Intake',
    reason: 'Taking an intake is work, so it sits with the rest of your workload.',
    href: '/?desk=intake',
    visible: canAccessSalesIntakeQueue,
  },
  {
    name: 'Policy Follow-up',
    icon: FileSpreadsheet,
    tone: 'bg-violet-50 text-violet-700 ring-violet-200',
    home: 'Renewals \u2192 Dashboard',
    reason: 'Renewals and pending cancellations are one workspace in the sidebar.',
    href: '/',
    visible: canAccessRenewals,
  },
] as const;

export default function ToolsHub({ initialProfile: profile }: { initialProfile: ProfileLite }) {
  const visible = appModules.filter(
    (module) =>
      module.status === 'active'
      && module.id in modulePresentation
      && canAccessModule(module.id, profile.role),
  );
  const relocated = RELOCATED.filter((entry) => entry.visible(profile.role));

  return (
    <ModuleShell title="Operations Tools" subtitle="Choose the workspace that matches the customer request." role={profile.role}>
      <section className="mb-6 rounded-[28px] border border-[#c9d5e9] bg-gradient-to-br from-white to-[#eef3fb] p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#223f7a] text-white"><ShieldCheck className="h-6 w-6" /></div>
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">Signed in as {profile.display_name}</p>
            <h2 className="mt-1 text-xl font-black text-slate-950">Everything has one home in the sidebar</h2>
            <p className="mt-1 text-sm font-semibold leading-6 text-slate-600">
              Work you need to do is on <strong className="text-[#223f7a]">My Desk</strong>. Finding a
              customer&apos;s quote history is <strong className="text-[#223f7a]">Quote Center</strong>. Nothing
              needs to be looked for in two places.
            </p>
          </div>
        </div>
      </section>

      {relocated.length ? (
        <section className="mb-6 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Moved into the sidebar</p>
          <ul className="mt-4 space-y-3">
            {relocated.map((entry) => {
              const Icon = entry.icon;
              return (
                <li key={entry.name}>
                  <Link
                    href={entry.href}
                    className="flex flex-wrap items-center gap-4 rounded-2xl border border-slate-100 bg-slate-50/60 px-4 py-3 transition hover:border-[#b5c4df] hover:bg-[#f8faff]"
                  >
                    <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ${entry.tone}`}>
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-black text-slate-900">
                        {entry.name} is now {entry.home}
                      </span>
                      <span className="mt-0.5 block text-xs font-semibold text-slate-500">{entry.reason}</span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-black text-[#223f7a]">
                      Take me there <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {visible.map((module) => {
          const presentation = modulePresentation[module.id as keyof typeof modulePresentation];
          const Icon = presentation.icon;
          return (
            <Link key={module.id} href={module.route} className="group rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:border-[#b5c4df] hover:shadow-lg">
              <div className={`grid h-12 w-12 place-items-center rounded-2xl ring-1 ${presentation.tone}`}><Icon className="h-6 w-6" /></div>
              <h2 className="mt-5 text-xl font-black tracking-tight text-slate-950">{module.name}</h2>
              <p className="mt-2 min-h-20 text-sm font-semibold leading-6 text-slate-500">{module.description}</p>
              <span className="mt-5 inline-flex items-center gap-2 text-sm font-black text-[#223f7a]">Open workspace <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" /></span>
            </Link>
          );
        })}
      </div>
    </ModuleShell>
  );
}

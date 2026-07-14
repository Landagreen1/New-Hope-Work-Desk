'use client';

import Link from 'next/link';
import { ArrowRight, ClipboardCheck, FileSpreadsheet, Headphones, ShieldCheck } from 'lucide-react';

import { appModules } from '@/platform/module-registry';

import type { ProfileLite } from '../nhwd-shared/types';
import { ModuleShell } from '../nhwd-shared/ModuleShell';

const modulePresentation = {
  'cs-intake': { icon: Headphones, tone: 'bg-cyan-50 text-cyan-700 ring-cyan-200' },
  'cs-intake-queue': { icon: ClipboardCheck, tone: 'bg-blue-50 text-blue-700 ring-blue-200' },
  renewals: { icon: FileSpreadsheet, tone: 'bg-violet-50 text-violet-700 ring-violet-200' },
};

export default function ToolsHub({ initialProfile: profile }: { initialProfile: ProfileLite }) {
  const visible = appModules.filter(
    (module) =>
      module.status === 'active'
      && module.id in modulePresentation
      && module.roles.includes(profile.role),
  );

  return (
    <ModuleShell title="Operations Tools" subtitle="Choose the workspace that matches the customer request." role={profile.role}>
      <section className="mb-6 rounded-[28px] border border-[#c9d5e9] bg-gradient-to-br from-white to-[#eef3fb] p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#223f7a] text-white"><ShieldCheck className="h-6 w-6" /></div>
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">Signed in as {profile.display_name}</p>
            <h2 className="mt-1 text-xl font-black text-slate-950">One login, focused workspaces</h2>
            <p className="mt-1 text-sm font-semibold leading-6 text-slate-600">The main Work Desk stays focused on sales rotations. Quote Intake and Renewals remain separate so the Manager board does not become overcrowded.</p>
          </div>
        </div>
      </section>
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

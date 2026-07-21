import Link from 'next/link';
import { BriefcaseBusiness, ClipboardCheck, FileSpreadsheet, Headphones, Home, Menu } from 'lucide-react';

import type { AppRole } from '@/features/nhwd-shared/types';
import { appModules } from '@/platform/module-registry';

const moduleIcons = {
  'cs-intake': Headphones,
  'cs-intake-queue': ClipboardCheck,
  renewals: FileSpreadsheet,
};

export function OperationsDock({ role }: { role: AppRole }) {
  const links = appModules.filter(
    (module) =>
      module.status === 'active'
      && module.id in moduleIcons
      && (module.roles as readonly string[]).includes(role),
  );

  return (
    <details className="group fixed bottom-4 right-3 z-[100] w-[min(340px,calc(100vw-24px))] text-slate-900 sm:bottom-5 sm:right-5">
      <summary className="ml-auto flex w-fit cursor-pointer list-none items-center gap-2 rounded-2xl border border-[#9eb1d2] bg-[#223f7a] px-4 py-3 text-sm font-black text-white shadow-xl transition hover:bg-[#1a3263] focus:outline-none focus:ring-4 focus:ring-[#c9d5e9] [&::-webkit-details-marker]:hidden">
        <Menu className="h-4 w-4" />
        Operations
        <span className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_0_4px_rgba(110,231,183,0.18)]" />
      </summary>
      <div className="absolute bottom-[calc(100%+8px)] right-0 w-full overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-2xl">
        <div className="border-b border-slate-100 bg-gradient-to-r from-[#eef3fb] to-white p-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-2xl bg-[#223f7a] text-white"><BriefcaseBusiness className="h-5 w-5" /></div>
            <div><p className="text-xs font-black uppercase tracking-[0.14em] text-[#526b9a]">New Hope Work Desk</p><p className="text-base font-black">Operations tools</p></div>
          </div>
        </div>
        <nav className="space-y-2 p-3">
          {links.map((module) => {
            const Icon = moduleIcons[module.id as keyof typeof moduleIcons];
            return (
              <Link key={module.id} href={module.route} className="flex items-center gap-3 rounded-2xl border border-transparent p-3 transition hover:border-[#c9d5e9] hover:bg-[#f5f8fd]">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#eef3fb] text-[#223f7a]"><Icon className="h-5 w-5" /></div>
                <div className="min-w-0"><p className="font-black">{module.name}</p><p className="line-clamp-2 text-xs font-semibold text-slate-500">{module.description}</p></div>
              </Link>
            );
          })}
          <Link href="/tools" className="flex items-center gap-3 rounded-2xl p-3 text-sm font-black text-[#223f7a] hover:bg-[#f5f8fd]"><BriefcaseBusiness className="h-4 w-4" />Open all Operations tools</Link>
          <Link href="/" className="flex items-center gap-3 rounded-2xl p-3 text-sm font-black text-slate-600 hover:bg-slate-50"><Home className="h-4 w-4" />Return to Work Desk</Link>
        </nav>
      </div>
    </details>
  );
}

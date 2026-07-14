'use client';

import Link from 'next/link';
import { ArrowLeft, BriefcaseBusiness, ClipboardList, Home, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AppRole } from './types';
import { ui } from './ui';

interface ModuleShellProps {
  title: string;
  subtitle: string;
  role?: AppRole;
  lastUpdated?: Date | null;
  onRefresh?: () => void;
  embedded?: boolean;
  children: ReactNode;
}

export function ModuleShell({
  title,
  subtitle,
  role,
  lastUpdated,
  onRefresh,
  embedded = false,
  children,
}: ModuleShellProps) {
  if (embedded) {
    return (
      <section className="text-slate-950">
        <div className="mb-6 flex flex-col gap-3 rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#526b9a]">
              {role === 'manager' ? 'Management workspace' : role === 'customer_service' ? 'Customer Service workspace' : 'Sales workspace'}
            </p>
            <h1 className={ui.pageTitle}>{title}</h1>
            <p className={ui.pageSubtitle}>{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {lastUpdated && (
              <p className="text-xs font-bold text-slate-400">
                Last updated {lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </p>
            )}
            {onRefresh && (
              <button type="button" onClick={onRefresh} className={ui.btnSecondary}>
                <RefreshCw className="h-4 w-4" />Refresh
              </button>
            )}
          </div>
        </div>
        {children}
      </section>
    );
  }

  return (
    <div className="min-h-screen bg-[#f3f5f9] text-slate-950">
      <header className="sticky top-0 z-30 border-b border-[#dbe3f0] bg-white/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Link href="/" className="grid h-10 w-10 place-items-center rounded-2xl bg-[#223f7a] text-white shadow-sm" aria-label="Work Desk">
              <Home className="h-5 w-5" />
            </Link>
            <div>
              <p className="text-sm font-black tracking-tight text-[#17305f]">New Hope Work Desk</p>
              <p className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-400">Operations Tools</p>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-2">
            <Link href="/tools" className={ui.btnGhost}><BriefcaseBusiness className="h-4 w-4" />Tools</Link>
            {(role === 'customer_service' || role === 'manager') && (
              <Link href="/tools/cs-intake" className={ui.btnGhost}><ClipboardList className="h-4 w-4" />Quote Intake</Link>
            )}
            {(role === 'agent' || role === 'manager') && (
              <Link href="/tools/cs-intake/queue" className={ui.btnGhost}>Sales Intake Queue</Link>
            )}
            {(role === 'agent' || role === 'manager' || role === 'customer_service') && (
              <Link href="/tools/renewals" className={ui.btnGhost}>Renewals</Link>
            )}
            {onRefresh && (
              <button type="button" onClick={onRefresh} className={ui.btnSecondary}>
                <RefreshCw className="h-4 w-4" />Refresh
              </button>
            )}
          </nav>
        </div>
      </header>
      <main className={ui.page}>
        <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Link href="/" className="mb-3 inline-flex items-center gap-2 text-xs font-black text-[#223f7a] hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" />Back to Work Desk
            </Link>
            <h1 className={ui.pageTitle}>{title}</h1>
            <p className={ui.pageSubtitle}>{subtitle}</p>
          </div>
          {lastUpdated && <p className="text-xs font-bold text-slate-400">Last updated {lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>}
        </div>
        {children}
      </main>
    </div>
  );
}

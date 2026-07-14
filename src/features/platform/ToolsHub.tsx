'use client';

import Link from 'next/link';
import { ArrowRight, ClipboardCheck, FileSpreadsheet, Headphones, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getCurrentProfile, type ProfileLite } from '../nhwd-shared/client';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import { ui } from '../nhwd-shared/ui';

const cards = [
  {
    id: 'intake',
    title: 'Customer Service Quote Intake',
    description: 'Collect the essential information for Personal Auto or Commercial Auto and submit it to the Sales Team.',
    route: '/tools/cs-intake',
    roles: ['customer_service', 'manager'],
    icon: Headphones,
    tone: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
  },
  {
    id: 'queue',
    title: 'Sales Intake Queue',
    description: 'Claim or assign completed Customer Service intakes and convert them into the Quotes Database.',
    route: '/tools/cs-intake/queue',
    roles: ['agent', 'manager'],
    icon: ClipboardCheck,
    tone: 'bg-blue-50 text-blue-700 ring-blue-200',
  },
  {
    id: 'renewals',
    title: 'Renewals Management',
    description: 'Import, assign, contact, document, monitor, and send renewal customers to the Sales Team for re-quoting.',
    route: '/tools/renewals',
    roles: ['agent', 'manager', 'customer_service'],
    icon: FileSpreadsheet,
    tone: 'bg-violet-50 text-violet-700 ring-violet-200',
  },
];

export default function ToolsHub() {
  const [profile, setProfile] = useState<ProfileLite | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getCurrentProfile().then((value) => {
      setProfile(value);
      setLoaded(true);
    });
  }, []);

  if (!loaded) return <div className="grid min-h-screen place-items-center bg-[#f3f5f9]"><LoaderCircle className="h-7 w-7 animate-spin text-[#223f7a]" /></div>;
  if (!profile) return <div className={ui.page}><div className={ui.empty}>Sign in to use Operations Tools.</div></div>;

  const visible = cards.filter((card) => card.roles.includes(profile.role));

  return (
    <ModuleShell title="Operations Tools" subtitle="Choose the workspace that matches the customer request." role={profile.role}>
      <section className="mb-6 rounded-[28px] border border-[#c9d5e9] bg-gradient-to-br from-white to-[#eef3fb] p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#223f7a] text-white"><ShieldCheck className="h-6 w-6" /></div>
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">Signed in as {profile.display_name}</p>
            <h2 className="mt-1 text-xl font-black text-slate-950">One login, focused workspaces</h2>
            <p className="mt-1 text-sm font-semibold leading-6 text-slate-600">The main Work Desk stays focused on sales rotations. Quote Intake and Renewals are separated here so the Manager board does not become overcrowded.</p>
          </div>
        </div>
      </section>
      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {visible.map((card) => {
          const Icon = card.icon;
          return (
            <Link key={card.id} href={card.route} className="group rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:border-[#b5c4df] hover:shadow-lg">
              <div className={`grid h-12 w-12 place-items-center rounded-2xl ring-1 ${card.tone}`}><Icon className="h-6 w-6" /></div>
              <h2 className="mt-5 text-xl font-black tracking-tight text-slate-950">{card.title}</h2>
              <p className="mt-2 min-h-20 text-sm font-semibold leading-6 text-slate-500">{card.description}</p>
              <span className="mt-5 inline-flex items-center gap-2 text-sm font-black text-[#223f7a]">Open workspace <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" /></span>
            </Link>
          );
        })}
      </div>
    </ModuleShell>
  );
}

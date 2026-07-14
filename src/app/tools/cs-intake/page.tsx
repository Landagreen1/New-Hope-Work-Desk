import { Suspense } from "react";

import CsIntakeLanding from "@/features/cs-intake/CsIntakeLanding";

function QuoteIntakeLoading() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
          Customer Service
        </p>
        <h1 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
          Loading Quote Intake…
        </h1>
        <p className="mt-2 text-sm font-semibold text-slate-500">
          Preparing the intake workspace and checking your access.
        </p>
      </section>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<QuoteIntakeLoading />}>
      <CsIntakeLanding />
    </Suspense>
  );
}

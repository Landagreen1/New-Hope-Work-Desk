'use client';

/**
 * Where this quote is in the process.
 *
 * Five phases, read from `specialty_opportunities.stage` — no second status system
 * was introduced for this rail, and none was needed. The nine stored stages group
 * into the five things an agent actually distinguishes, and the caption under each
 * phase comes from the live children, so the rail says "3 of 5 submitted" instead of
 * repeating the stage name.
 */

import { AlertTriangle, Check } from 'lucide-react';

import { stageMeaning } from '../status';
import type { WorkflowPhase } from '../workflow';
import type { SpecialtyStage } from '../types';

export default function WorkflowProgress({
  phases,
  stage,
  stageLabel,
}: {
  phases: readonly WorkflowPhase[];
  stage: SpecialtyStage;
  stageLabel: string;
}) {
  return (
    <section aria-label="Quote progress" className="rounded-[22px] border border-[#dbe3f0] bg-white px-4 py-3.5 sm:px-5">
      <ol className="flex items-stretch gap-1 overflow-x-auto">
        {phases.map((phase, index) => {
          const isLast = index === phases.length - 1;
          return (
            <li key={phase.key} className="flex min-w-[7.5rem] flex-1 items-start gap-1">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-black ${
                      phase.state === 'done'
                        ? 'bg-emerald-500 text-white'
                        : phase.state === 'current'
                          ? phase.isBlocked
                            ? 'bg-rose-500 text-white'
                            : 'bg-[#223f7a] text-white'
                          : 'border-2 border-slate-200 bg-white text-slate-300'
                    }`}
                  >
                    {phase.state === 'done' ? (
                      <Check className="h-3 w-3" strokeWidth={3} />
                    ) : phase.state === 'current' && phase.isBlocked ? (
                      <AlertTriangle className="h-3 w-3" strokeWidth={3} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <p
                    className={`truncate text-xs font-black uppercase tracking-[0.08em] ${
                      phase.state === 'upcoming' ? 'text-slate-300' : 'text-slate-700'
                    }`}
                  >
                    {phase.label}
                  </p>
                </div>
                <p
                  className={`mt-1 pl-7 text-[11px] font-bold ${
                    phase.state === 'current'
                      ? phase.isBlocked
                        ? 'text-rose-600'
                        : 'text-[#223f7a]'
                      : phase.state === 'done'
                        ? 'text-slate-400'
                        : 'text-slate-300'
                  }`}
                >
                  {phase.caption}
                </p>
                {/* The stage itself, said once, on the phase that owns it. Repeating
                    it on every step would be five words for one fact. */}
                {phase.state === 'current' ? (
                  <p
                    className="mt-0.5 truncate pl-7 text-[11px] font-semibold text-slate-400"
                    title={stageMeaning(stage)}
                  >
                    {stageLabel}
                  </p>
                ) : null}
              </div>
              {!isLast ? (
                <span
                  aria-hidden
                  className={`mt-2.5 hidden h-0.5 w-4 shrink-0 rounded-full sm:block ${
                    phase.state === 'done' ? 'bg-emerald-300' : 'bg-slate-200'
                  }`}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

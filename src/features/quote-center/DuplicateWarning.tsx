'use client';

/**
 * Possible existing records, surfaced while a new intake is being typed.
 *
 * The point is to prevent an *accidental* duplicate, not to police the employee.
 * Two people genuinely share a name, and one person can legitimately have several
 * quote journeys — a renters policy in July and an auto quote in August is two
 * journeys, not a mistake. So this never blocks: it shows what already exists,
 * with enough context to tell whether it is the same situation, and lets the
 * employee open it or carry on.
 *
 * It reads the same journeys Quote Center searches, so it cannot show something
 * different from what the employee would find by searching themselves.
 */

import { ArrowUpRight, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import { checkForDuplicates } from './api';
import { formatPhone, lineOfBusinessLabel, stageTone } from './status';
import type { DuplicateCandidate, DuplicateCheckInput } from './types';

/** Long enough to let someone finish typing a phone number before asking. */
const CHECK_DEBOUNCE_MS = 600;

export interface DuplicateWarningProps {
  input: DuplicateCheckInput;
  /** Opens an existing record instead of continuing the new intake. */
  onOpenExisting?: (candidate: DuplicateCandidate) => void;
  /** Dismisses the panel for this intake. */
  onContinueNew?: () => void;
}

export default function DuplicateWarning({
  input,
  onOpenExisting,
  onContinueNew,
}: DuplicateWarningProps) {
  const [candidates, setCandidates] = useState<DuplicateCandidate[]>([]);
  const [dismissed, setDismissed] = useState(false);

  // Serialised so the effect re-runs on value changes rather than on every
  // parent render, which would otherwise fire a query per keystroke.
  const signature = JSON.stringify([
    input.excludeIntakeId ?? '',
    input.phone ?? '',
    input.email ?? '',
    input.firstName ?? '',
    input.lastName ?? '',
    input.businessName ?? '',
    input.dob ?? '',
  ]);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      checkForDuplicates(input)
        .then((found) => {
          if (active) setCandidates(found);
        })
        // A failed duplicate check must never get in the way of taking a quote.
        .catch(() => {
          if (active) setCandidates([]);
        });
    }, CHECK_DEBOUNCE_MS);

    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  if (dismissed || candidates.length === 0) return null;

  return (
    <section className="rounded-[22px] border-2 border-violet-200 bg-violet-50 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Users className="mt-0.5 h-5 w-5 shrink-0 text-violet-700" />
          <div>
            <p className="text-sm font-black text-violet-950">
              Possible Existing Records · {candidates.length}
            </p>
            <p className="mt-1 text-xs font-semibold text-violet-800">
              This may be a customer we already have. Open the existing record to continue
              its history, or carry on if this is genuinely a new quote.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="rounded-xl bg-white px-3 py-2 text-xs font-black text-violet-800 ring-1 ring-violet-200 transition hover:bg-violet-100"
          onClick={() => {
            setDismissed(true);
            onContinueNew?.();
          }}
        >
          Continue New Intake
        </button>
      </div>

      <ul className="mt-4 space-y-2">
        {candidates.map((candidate) => (
          <li key={candidate.journey_key}>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 ring-1 ring-violet-100">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-black text-slate-900">
                    {candidate.customer_name}
                  </p>
                  <span
                    className={`${ui.badge} ${ui.badgeTone[stageTone(candidate.stage)]}`}
                  >
                    {candidate.stage_label}
                  </span>
                  <span className={`${ui.badge} ${ui.badgeTone.violet}`}>
                    {candidate.match_reason}
                  </span>
                </div>
                <p className="mt-1 text-xs font-semibold text-slate-500">
                  {[
                    lineOfBusinessLabel(candidate.line_of_business),
                    formatPhone(candidate.phone_primary),
                    [candidate.addr_city, candidate.addr_state].filter(Boolean).join(', '),
                    candidate.source_label && candidate.source_label !== 'Not recorded'
                      ? candidate.source_label
                      : null,
                    candidate.assigned_agent_name
                      ? `Assigned ${candidate.assigned_agent_name}`
                      : null,
                  ]
                    .filter((part) => part && String(part).trim() !== '')
                    .join(' · ')}
                </p>
              </div>
              {onOpenExisting ? (
                <button
                  type="button"
                  className="shrink-0 rounded-xl bg-violet-700 px-3 py-2 text-xs font-black text-white transition hover:bg-violet-800"
                  onClick={() => onOpenExisting(candidate)}
                >
                  <ArrowUpRight className="mr-1 inline h-3.5 w-3.5" />
                  Open Existing
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

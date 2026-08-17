'use client';

/**
 * The specialty half of a customer's journey, inside Quote Center.
 *
 * Customer Service collects the intake and does not get the specialty operational
 * workspace. What they need instead is the answer to two questions a customer asks on
 * a callback: where is my quote, and does anyone need anything from me? This panel is
 * both, plus the ability to supply what is missing.
 *
 * What it deliberately does not show: carrier markets, premiums, decline reasons or
 * any of the marketing strategy. `specialty_cs_status` only selects the information
 * items and notes the specialty team marked as shared, so the boundary is enforced in
 * SQL rather than by leaving fields out of this component.
 */

import { CheckCircle2, MessageSquarePlus, ShieldQuestion, Truck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { addCsNote, getCsSpecialtyStatus, provideInformationFromCs } from '../specialty/api';
import type { CsSpecialtyStatus } from '../specialty/types';
import { ui } from '../nhwd-shared/ui';

function relative(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `today ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function statusTone(status: string): string {
  if (status === 'Information Needed') return ui.badgeTone.danger;
  if (status === 'Sold') return ui.badgeTone.success;
  if (status === 'Not Sold') return ui.badgeTone.neutral;
  if (status === 'Price Sent' || status === 'Options Ready') return ui.badgeTone.cyan;
  if (status === 'Customer Follow-Up') return ui.badgeTone.progress;
  return ui.badgeTone.info;
}

export interface SpecialtyStatusPanelProps {
  intakeId: string;
  /** Whether this role may add a note or supply missing information. */
  canAct: boolean;
}

export default function SpecialtyStatusPanel({ intakeId, canAct }: SpecialtyStatusPanelProps) {
  const [status, setStatus] = useState<CsSpecialtyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [provideFor, setProvideFor] = useState<string | null>(null);
  const [provideNote, setProvideNote] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getCsSpecialtyStatus(intakeId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The specialty status could not be read.');
    } finally {
      setLoading(false);
    }
  }, [intakeId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className={ui.empty}>Loading specialty status…</p>;
  }
  if (!status) return null;

  const run = async (action: () => Promise<void>, success: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-[22px] border border-[#c9d5e9] bg-[#f8faff] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#223f7a] text-white">
            <Truck className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-black uppercase tracking-[0.14em] text-[#526b9a]">
              With the {status.team_name}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className={`${ui.badge} ${statusTone(status.status)}`}>{status.status}</span>
              <span className="text-xs font-bold text-slate-500">{status.reference}</span>
            </div>
            <p className="mt-1 text-sm font-semibold text-slate-600">
              {status.assignee_name
                ? `${status.assignee_name} is primarily responsible.`
                : 'Waiting for a team member to claim it.'}{' '}
              Last activity {relative(status.last_activity_at)}.
            </p>
          </div>
        </div>
      </div>

      {error ? <div className={`${ui.error} mt-4`}>{error}</div> : null}
      {notice ? <div className={`${ui.success} mt-4`}>{notice}</div> : null}

      {/* What the team is waiting on. This is the callback answer. */}
      {status.information_needed.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <p className="flex items-center gap-2 text-sm font-black text-rose-900">
            <ShieldQuestion className="h-4 w-4" />
            The team is waiting on {status.information_needed.length} item
            {status.information_needed.length === 1 ? '' : 's'}
          </p>
          <ul className="mt-2 space-y-2">
            {status.information_needed.map((item) => (
              <li key={item.id} className="rounded-xl bg-white px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-black text-slate-900">{item.label}</p>
                    <p className="mt-0.5 text-xs font-bold text-slate-400">
                      {item.requested_by_name ? `Asked by ${item.requested_by_name} · ` : ''}
                      {relative(item.requested_at)}
                    </p>
                    {item.note ? (
                      <p className="mt-1 text-sm font-semibold text-slate-600">{item.note}</p>
                    ) : null}
                  </div>
                  {canAct ? (
                    <button
                      type="button"
                      className={ui.btnSecondary}
                      onClick={() => {
                        setProvideFor(item.id);
                        setProvideNote('');
                      }}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      I have this
                    </button>
                  ) : null}
                </div>

                {provideFor === item.id ? (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <label className="block">
                      <span className={ui.label}>What did the customer provide?</span>
                      <textarea
                        className={ui.textarea}
                        rows={2}
                        value={provideNote}
                        onChange={(event) => setProvideNote(event.target.value)}
                        placeholder="e.g. Customer emailed 3 years of loss runs to the office inbox"
                      />
                    </label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={ui.btnPrimary}
                        disabled={busy || provideNote.trim() === ''}
                        onClick={() =>
                          void run(async () => {
                            await provideInformationFromCs(item.id, provideNote);
                            setProvideFor(null);
                            setProvideNote('');
                          }, `${item.label} was marked as provided. The specialty team can see it.`)
                        }
                      >
                        Send to the specialty team
                      </button>
                      <button
                        type="button"
                        className={ui.btnGhost}
                        onClick={() => setProvideFor(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-4 text-sm font-semibold text-slate-500">
          Nothing is outstanding from Customer Service right now.
        </p>
      )}

      {/* Shared notes, both directions. */}
      {status.shared_notes.length > 0 ? (
        <div className="mt-4">
          <p className={ui.sectionTitle}>Shared notes</p>
          <ul className="mt-2 space-y-2">
            {status.shared_notes.slice(0, 6).map((entry) => (
              <li key={entry.id} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                <p className="text-xs font-black text-slate-500">
                  {entry.author_name} · {relative(entry.created_at)}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-slate-700">
                  {entry.content}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canAct ? (
        <div className="mt-4 border-t border-[#c9d5e9] pt-4">
          <label className="block">
            <span className={ui.label}>Add a note for the specialty team</span>
            <textarea
              className={ui.textarea}
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What did the customer say?"
            />
          </label>
          <button
            type="button"
            className={`${ui.btnPrimary} mt-2`}
            disabled={busy || note.trim() === ''}
            onClick={() =>
              void run(async () => {
                await addCsNote(intakeId, note);
                setNote('');
              }, 'The note was added. It does not change who is working the quote.')
            }
          >
            <MessageSquarePlus className="h-4 w-4" />
            Add note
          </button>
        </div>
      ) : null}
    </section>
  );
}

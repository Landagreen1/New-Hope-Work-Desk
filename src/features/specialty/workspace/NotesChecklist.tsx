'use client';

/**
 * The quote's notes and its checklist.
 *
 * Both live on the Overview rather than in a tab of their own, because both answer
 * "what is happening with this quote" and neither is a filing cabinet you go to
 * separately. The Activity tab tells the whole story in order; this is the working
 * surface.
 *
 * The checklist is seeded from the line of business's workflow template when the quote
 * arrives — sixteen items for Trucking — so it is not decoration. It is what stops a
 * submission going out without loss runs, and the list rows count it. Losing it in a
 * redesign would be losing a feature, not tidying one up.
 *
 * A note cannot be edited or deleted once added, including by a manager:
 * `specialty_notes` has a select and an insert policy and nothing else. That is
 * deliberate — nobody rewrites another employee's account of a call — and it is why the
 * composer says so.
 */

import { CheckSquare, Plus, Square } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ui } from '../../nhwd-shared/ui';
import { addChecklistItem, addNote, toggleChecklistItem } from '../api';
import { formatRelative, lineLabel } from '../status';
import type { OpportunityDetail } from '../types';
import { Badge, SectionCard, type Runner } from './shared';

export function NotesCard({
  detail,
  canEdit,
  run,
  busy,
}: {
  detail: OpportunityDetail;
  canEdit: boolean;
  run: Runner;
  busy: boolean;
}) {
  const [note, setNote] = useState('');
  const [shared, setShared] = useState(false);

  /** Quote-level only. A note about one carrier belongs in that carrier's workstream. */
  const notes = detail.notes.filter((entry) => entry.carrier_market_id === null);

  return (
    <SectionCard
      title="Notes"
      description="Anyone on the team can add a note to any of the team's quotes. Notes cannot be edited or deleted afterwards, including by a manager."
      actions={notes.length > 0 ? <Badge tone="neutral">{notes.length}</Badge> : undefined}
    >
      {canEdit ? (
        <div className="mb-4">
          <textarea
            className={ui.textarea}
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What happened?"
            aria-label="New note"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <label className={ui.checkboxRow}>
              <input
                type="checkbox"
                checked={shared}
                onChange={(event) => setShared(event.target.checked)}
              />
              Share with Customer Service
            </label>
            <button
              type="button"
              className={ui.btnPrimary}
              disabled={busy || note.trim() === ''}
              onClick={() =>
                void run(async () => {
                  await addNote(detail.opportunity.id, note, { csVisible: shared });
                }, 'The note was added.').then((ok) => {
                  if (ok) {
                    setNote('');
                    setShared(false);
                  }
                })
              }
            >
              Add note
            </button>
          </div>
        </div>
      ) : null}

      {notes.length === 0 ? (
        <p className={ui.empty}>No notes on the quote itself yet.</p>
      ) : (
        <div className="space-y-3">
          {notes.map((entry) => (
            <div key={entry.id} className="rounded-2xl border border-slate-200 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#eef3fb] text-[10px] font-black text-[#223f7a]">
                  {entry.author_initials ?? '—'}
                </span>
                <span className="text-sm font-black text-slate-900">{entry.author_name}</span>
                <span className="text-xs font-bold text-slate-400">
                  {formatRelative(entry.created_at)}
                </span>
                {entry.is_cs_visible ? <Badge tone="info">Shared with CS</Badge> : null}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm font-semibold text-slate-700">
                {entry.content}
              </p>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

export function ChecklistCard({
  detail,
  canEdit,
  run,
  busy,
}: {
  detail: OpportunityDetail;
  canEdit: boolean;
  run: Runner;
  busy: boolean;
}) {
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState('Other');
  const [showDone, setShowDone] = useState(false);

  // Grouped by category so the checklist reads as the process it came from rather than
  // as one long list.
  const grouped = useMemo(() => {
    const map = new Map<string, OpportunityDetail['checklist']>();
    for (const item of detail.checklist) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return Array.from(map.entries());
  }, [detail.checklist]);

  const { checklist_done: done, checklist_total: total } = detail.opportunity;
  const requiredOutstanding = detail.checklist.filter(
    (item) => item.is_required && !item.is_checked,
  ).length;

  return (
    <SectionCard
      title="Checklist"
      description={`Created from the ${lineLabel(detail.opportunity.line_of_business)} workflow template when the quote arrived. Add your own items as needed.`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {requiredOutstanding > 0 ? (
            <Badge tone="danger">{requiredOutstanding} required outstanding</Badge>
          ) : null}
          <Badge tone={done === total && total > 0 ? 'success' : 'neutral'}>
            {done} of {total} done
          </Badge>
          {/* Ticked items are history, and a finished checklist should not be a wall of
              struck-through text between the reader and what is left. */}
          <button
            type="button"
            className={ui.btnGhost}
            aria-expanded={showDone}
            onClick={() => setShowDone((current) => !current)}
          >
            {showDone ? 'Hide done' : 'Show done'}
          </button>
        </div>
      }
    >
      {detail.checklist.length === 0 ? (
        <p className={ui.empty}>No checklist items.</p>
      ) : (
        <div className="space-y-4">
          {grouped.map(([group, items]) => {
            const visible = showDone ? items : items.filter((item) => !item.is_checked);
            if (visible.length === 0) return null;
            return (
              <div key={group}>
                <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                  {group}
                </p>
                <ul className="mt-1.5 space-y-1">
                  {visible.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        disabled={!canEdit || busy}
                        onClick={() =>
                          void run(
                            () => toggleChecklistItem(item.id, !item.is_checked),
                            item.is_checked ? `${item.label} unticked.` : `${item.label} ticked.`,
                          )
                        }
                        className="flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left transition hover:bg-slate-50 disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        {item.is_checked ? (
                          <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                        ) : (
                          <Square className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
                        )}
                        <span
                          className={`text-sm font-semibold ${
                            item.is_checked ? 'text-slate-400 line-through' : 'text-slate-700'
                          }`}
                        >
                          {item.label}
                          {item.is_required && !item.is_checked ? (
                            <span className="ml-1.5 text-xs font-black text-rose-500">required</span>
                          ) : null}
                          {item.is_checked && item.checked_by_name ? (
                            <span className="ml-1.5 text-xs font-bold text-slate-400">
                              {item.checked_by_name} · {formatRelative(item.checked_at)}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {canEdit ? (
        <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-[1fr_1fr_auto]">
          <label className="block">
            <span className={ui.label}>Category</span>
            <input
              className={ui.input}
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            />
          </label>
          <label className="block">
            <span className={ui.label}>New checklist item</span>
            <input
              className={ui.input}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              className={ui.btnSecondary}
              disabled={busy || label.trim() === ''}
              onClick={() =>
                void run(async () => {
                  await addChecklistItem(detail.opportunity.id, category, label);
                }, 'The checklist item was added.').then((ok) => {
                  if (ok) setLabel('');
                })
              }
            >
              <Plus className="h-4 w-4" />
              Add
            </button>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

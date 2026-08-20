'use client';

/**
 * The quote-level actions, each as its own small dialog.
 *
 * These are the transitions the database protects: `specialty_guard_protected_columns`
 * refuses a direct PATCH to stage, assignment, pricing or result, so every one of them
 * goes through the security-definer RPC that validates it, stamps the timestamps and
 * writes the activity row. The dialogs below are thin — they collect the arguments and
 * hand them to `api.ts`. Nothing here decides whether an action is allowed; that is
 * `detail.can_edit`, `detail.can_reassign` and `detail.is_manager`, all computed by
 * the server.
 *
 * Ported from the retired side drawer with their behaviour unchanged, including the
 * two rules that are easy to lose: Sold and Not Sold are absent from the stage picker
 * because they carry a carrier, a premium or a reason, and receiving a carrier quote
 * is not the same event as sending a price to the customer.
 */

import { useState } from 'react';

import DateTimePicker from '../../nhwd-shared/DateTimePicker';
import DollarInput from '../../nhwd-shared/DollarInput';
import { ui } from '../../nhwd-shared/ui';
import {
  addNote,
  changeStage,
  reassignOpportunity,
  recordPriceSent,
  recordResult,
  updateOpportunity,
  uploadDocument,
} from '../api';
import {
  DOCUMENT_CATEGORIES,
  LOST_REASONS,
  PRICE_METHODS,
  documentCategoryLabel,
  formatMoney,
  lostReasonLabel,
  priceMethodLabel,
  stageLabel,
  stageMeaning,
} from '../status';
import type {
  DocumentCategory,
  OpportunityDetail,
  PriceMethod,
  SpecialtyLostReason,
  SpecialtyPriority,
  SpecialtyStage,
} from '../types';
import { EditModal, Field, type Runner } from './shared';

interface DialogProps {
  detail: OpportunityDetail;
  run: Runner;
  busy: boolean;
  onClose: () => void;
}

// ── Add note ─────────────────────────────────────────────────────────────────

export function AddNoteDialog({ detail, run, busy, onClose }: DialogProps) {
  const [content, setContent] = useState('');
  const [shared, setShared] = useState(false);
  const [carrierMarketId, setCarrierMarketId] = useState('');

  return (
    <EditModal
      title="Add a note"
      description="Notes cannot be edited or deleted afterwards, including by a manager. Anything shared with Customer Service appears on the customer's Quote Center journey."
      onClose={onClose}
      busy={busy}
      submitDisabled={content.trim() === ''}
      submitLabel="Add note"
      onSubmit={() =>
        void run(async () => {
          await addNote(detail.opportunity.id, content, {
            csVisible: shared,
            carrierMarketId: carrierMarketId || null,
          });
        }, 'The note was added.').then((ok) => {
          if (ok) onClose();
        })
      }
    >
      <textarea
        className={ui.textarea}
        rows={5}
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="What happened?"
        aria-label="Note"
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="About one carrier? (optional)">
          <select
            className={ui.select}
            value={carrierMarketId}
            onChange={(event) => setCarrierMarketId(event.target.value)}
          >
            <option value="">The quote itself</option>
            {detail.carrier_markets.map((market) => (
              <option key={market.id} value={market.id}>
                {market.carrier_name}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-end">
          <label className={ui.checkboxRow}>
            <input
              type="checkbox"
              checked={shared}
              onChange={(event) => setShared(event.target.checked)}
            />
            Share with Customer Service
          </label>
        </div>
      </div>
    </EditModal>
  );
}

// ── Upload document ──────────────────────────────────────────────────────────

export function UploadDocumentDialog({ detail, run, busy, onClose }: DialogProps) {
  const [category, setCategory] = useState<DocumentCategory>('other');
  const [carrierMarketId, setCarrierMarketId] = useState('');
  const [file, setFile] = useState<File | null>(null);

  return (
    <EditModal
      title="Upload a document"
      description="Up to 100 MB. The file is stored against this quote and appears on the Documents tab under the category you choose."
      onClose={onClose}
      busy={busy}
      submitDisabled={file === null}
      submitLabel="Upload"
      onSubmit={() => {
        if (!file) return;
        void run(async () => {
          await uploadDocument(detail.opportunity.id, file, {
            category,
            carrierMarketId: carrierMarketId || null,
          });
        }, `${file.name} was uploaded.`).then((ok) => {
          if (ok) onClose();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Category">
          <select
            className={ui.select}
            value={category}
            onChange={(event) => setCategory(event.target.value as DocumentCategory)}
          >
            {DOCUMENT_CATEGORIES.map((option) => (
              <option key={option} value={option}>
                {documentCategoryLabel(option)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Related carrier (optional)">
          <select
            className={ui.select}
            value={carrierMarketId}
            onChange={(event) => setCarrierMarketId(event.target.value)}
          >
            <option value="">The quote itself</option>
            {detail.carrier_markets.map((market) => (
              <option key={market.id} value={market.id}>
                {market.carrier_name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mt-4">
        <Field label="File">
          <input
            type="file"
            className={`${ui.input} file:mr-3 file:rounded-lg file:border-0 file:bg-[#eef3fb] file:px-3 file:py-1.5 file:text-xs file:font-black file:text-[#223f7a]`}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
      </div>
    </EditModal>
  );
}

// ── Transfer ─────────────────────────────────────────────────────────────────

export function TransferDialog({ detail, run, busy, onClose }: DialogProps) {
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');

  return (
    <EditModal
      title="Transfer primary responsibility"
      description="The previous assignee, the new assignee, who changed it and when are all recorded. Assignment is accountability — every eligible teammate can still work this quote."
      onClose={onClose}
      busy={busy}
      submitDisabled={target === ''}
      submitLabel="Transfer"
      onSubmit={() =>
        void run(
          () =>
            reassignOpportunity(
              detail.opportunity.id,
              target === '__unassign' ? null : target,
              reason,
            ),
          'The transfer was recorded.',
        ).then((ok) => {
          if (ok) onClose();
        })
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Assign to">
          <select
            className={ui.select}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">Choose an employee</option>
            {detail.assignable_members.map((member) => (
              <option key={member.profile_id} value={member.profile_id}>
                {member.display_name}
              </option>
            ))}
            <option value="__unassign">Leave unassigned</option>
          </select>
        </Field>
        <Field label="Reason (optional)">
          <input
            className={ui.input}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. covering while out of office"
          />
        </Field>
      </div>
    </EditModal>
  );
}

// ── Move stage ───────────────────────────────────────────────────────────────

export function StageDialog({ detail, run, busy, onClose }: DialogProps) {
  const [stage, setStage] = useState<SpecialtyStage>(detail.opportunity.stage);
  const [note, setNote] = useState('');

  // Sold and Not Sold are absent: they carry a carrier, a premium or a reason, so
  // they are recorded through Record Result rather than picked from a list.
  const options = detail.workflow_stages.filter((entry) => !entry.is_terminal);

  return (
    <EditModal
      title="Move stage"
      description="The stage is the quote's position in the workflow. Moving it is recorded with who moved it and when."
      onClose={onClose}
      busy={busy}
      submitLabel="Move"
      onSubmit={() =>
        void run(
          () => changeStage(detail.opportunity.id, stage, detail.opportunity.version, note),
          `Moved to ${stageLabel(stage)}.`,
        ).then((ok) => {
          if (ok) onClose();
        })
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Stage" hint={stageMeaning(stage)}>
          <select
            className={ui.select}
            value={stage}
            onChange={(event) => setStage(event.target.value as SpecialtyStage)}
          >
            {options.map((entry) => (
              <option key={entry.stage_key} value={entry.stage_key}>
                {entry.label}
                {entry.requires_next_action ? ' (needs a next action)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note (optional)">
          <input className={ui.input} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
    </EditModal>
  );
}

// ── Next action ──────────────────────────────────────────────────────────────

export function NextActionDialog({ detail, run, busy, onClose }: DialogProps) {
  const [action, setAction] = useState(detail.opportunity.next_action ?? '');
  const [due, setDue] = useState(
    detail.opportunity.next_action_due ? detail.opportunity.next_action_due.slice(0, 16) : '',
  );

  return (
    <EditModal
      title="What needs to happen next?"
      description="What you write here is what the team sees on the list and what the overdue and due-today views count. It sits alongside the reading the workspace derives on its own."
      onClose={onClose}
      busy={busy}
      onSubmit={() =>
        void run(async () => {
          await updateOpportunity(
            detail.opportunity.id,
            {
              next_action: action.trim() || null,
              next_action_due: due ? new Date(due).toISOString() : null,
            },
            detail.opportunity.version,
          );
        }, 'The next action was saved.').then((ok) => {
          if (ok) onClose();
        })
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Next action"
          hint="e.g. Request loss runs, Submit Progressive, Follow up with Canal, Call customer"
        >
          <input
            className={ui.input}
            value={action}
            onChange={(event) => setAction(event.target.value)}
          />
        </Field>
        {/* mt-2 because DateTimePicker, unlike ui.input, carries no top margin. */}
        <Field label="Due">
          <DateTimePicker value={due} onChange={setDue} className="mt-2" />
        </Field>
      </div>
    </EditModal>
  );
}

// ── Priority ─────────────────────────────────────────────────────────────────

export function PriorityDialog({ detail, run, busy, onClose }: DialogProps) {
  const [priority, setPriority] = useState<SpecialtyPriority>(detail.opportunity.priority);

  return (
    <EditModal
      title="Set priority"
      onClose={onClose}
      busy={busy}
      submitLabel="Save"
      onSubmit={() =>
        void run(async () => {
          await updateOpportunity(detail.opportunity.id, { priority }, detail.opportunity.version);
        }, 'The priority was saved.').then((ok) => {
          if (ok) onClose();
        })
      }
    >
      <Field label="Priority">
        <select
          className={ui.select}
          value={priority}
          onChange={(event) => setPriority(event.target.value as SpecialtyPriority)}
        >
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
      </Field>
    </EditModal>
  );
}

// ── Record price sent ────────────────────────────────────────────────────────

export function PriceSentDialog({ detail, run, busy, onClose }: DialogProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [method, setMethod] = useState<PriceMethod | ''>('');
  const [note, setNote] = useState('');

  const quotable = detail.carrier_markets.filter((market) => market.premium !== null);

  return (
    <EditModal
      title="Which options went to the customer?"
      description="Receiving a carrier quote is not the same as sending a price. What you tick here is frozen as the record of what the customer was told, so correcting a premium later cannot rewrite it."
      onClose={onClose}
      busy={busy}
      submitDisabled={selected.length === 0}
      submitLabel="Record"
      onSubmit={() =>
        void run(async () => {
          await recordPriceSent(detail.opportunity.id, selected, detail.opportunity.version, {
            method: method || null,
            note,
          });
        }, 'Recorded as sent to the customer.').then((ok) => {
          if (ok) onClose();
        })
      }
    >
      <div className="space-y-2">
        {quotable.length === 0 ? (
          <p className={ui.empty}>No carrier has recorded a premium yet.</p>
        ) : null}
        {quotable.map((market) => (
          <label
            key={market.id}
            className="flex items-start gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700"
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.includes(market.id)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, market.id]
                    : current.filter((id) => id !== market.id),
                )
              }
            />
            <span>
              <strong className="text-slate-900">{market.carrier_name}</strong> ·{' '}
              {formatMoney(market.premium)}
              {market.down_payment !== null ? ` · ${formatMoney(market.down_payment)} down` : ''}
              {market.payment_terms ? ` · ${market.payment_terms}` : ''}
              {market.presented_at ? ' · already sent once' : ''}
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="How was it delivered?">
          <select
            className={ui.select}
            value={method}
            onChange={(event) => setMethod(event.target.value as PriceMethod | '')}
          >
            <option value="">Not recorded</option>
            {PRICE_METHODS.map((option) => (
              <option key={option} value={option}>
                {priceMethodLabel(option)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note (optional)">
          <input className={ui.input} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
    </EditModal>
  );
}

// ── Record result ────────────────────────────────────────────────────────────

export function ResultDialog({ detail, run, busy, onClose }: DialogProps) {
  const [result, setResult] = useState<'sold' | 'not_sold'>('sold');
  const [boundMarketId, setBoundMarketId] = useState('');
  const [premium, setPremium] = useState<number | null>(null);
  const [lostReason, setLostReason] = useState<SpecialtyLostReason | ''>('');
  const [lostNote, setLostNote] = useState('');

  const incomplete =
    result === 'sold' ? boundMarketId === '' || premium === null : lostReason === '';

  return (
    <EditModal
      title="Record the result"
      description="Sold needs a carrier and a premium. Not Sold needs a reason — the lost-business report depends on it, so a blank one is refused by the server as well as here."
      onClose={onClose}
      busy={busy}
      submitDisabled={incomplete}
      submitLabel="Record"
      onSubmit={() =>
        void run(
          () =>
            recordResult(
              detail.opportunity.id,
              result === 'sold'
                ? { result: 'sold', boundMarketId, soldPremium: premium }
                : {
                    result: 'not_sold',
                    lostReason: lostReason || null,
                    lostReasonNote: lostNote,
                  },
              detail.opportunity.version,
            ),
          result === 'sold' ? 'Recorded as sold.' : 'Recorded as not sold.',
        ).then((ok) => {
          if (ok) onClose();
        })
      }
    >
      <div className="flex gap-1 rounded-2xl bg-slate-100 p-1.5">
        {(['sold', 'not_sold'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setResult(option)}
            aria-pressed={result === option}
            className={`flex-1 rounded-xl px-4 py-2 text-xs font-black transition ${
              result === option ? 'bg-[#223f7a] text-white shadow-sm' : 'text-slate-600 hover:bg-white'
            }`}
          >
            {option === 'sold' ? 'Sold' : 'Not sold'}
          </button>
        ))}
      </div>

      {result === 'sold' ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Bound with">
            <select
              className={ui.select}
              value={boundMarketId}
              onChange={(event) => {
                setBoundMarketId(event.target.value);
                const market = detail.carrier_markets.find(
                  (entry) => entry.id === event.target.value,
                );
                // Default the sold premium to what that carrier quoted; the employee
                // can still correct it if the bound figure differs.
                if (market?.premium !== null && market?.premium !== undefined) {
                  setPremium(market.premium);
                }
              }}
            >
              <option value="">Choose the carrier</option>
              {detail.carrier_markets.map((market) => (
                <option key={market.id} value={market.id}>
                  {market.carrier_name}
                  {market.premium !== null ? ` · ${formatMoney(market.premium)}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sold premium">
            <DollarInput value={premium} onChange={setPremium} />
          </Field>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Reason">
            <select
              className={ui.select}
              value={lostReason}
              onChange={(event) => setLostReason(event.target.value as SpecialtyLostReason | '')}
            >
              <option value="">Choose a reason</option>
              {LOST_REASONS.map((option) => (
                <option key={option} value={option}>
                  {lostReasonLabel(option)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Explanation (optional)">
            <input
              className={ui.input}
              value={lostNote}
              onChange={(event) => setLostNote(event.target.value)}
            />
          </Field>
        </div>
      )}
    </EditModal>
  );
}

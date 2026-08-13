'use client';

// Renewal detail drawer (Requirements 5.1, 5.2, 5.3, 5.5, 5.10, 5.11, 2.2, 2.7, 7.1, 7.2).
//
// Owns the detail queries of the selected renewal — `listContacts`, `listRenewalEvents`,
// `listSmsLogs` — and its four writes: `updateWorkflow` (next follow-up date and final outcome),
// `updateRenewalContactInfo`, `sendToRequote`, `sendRenewalSms`. Contact logging and evidence stay
// in `RenewalContactComposer`, the timeline merge in `RenewalTimeline`, import tooling in
// `RenewalManagerActions`. No direct Supabase client call and no renewal database function call
// appears here (Req 7.2); the outcome goes through `updateWorkflow`, not a new path (Req 2.1).
//
// Requirement 5.3 admits exactly one visually prominent primary control. The composer renders its
// own primary submit, so the drawer expands the composer only while the recommended action is a
// contact action and keeps every drawer-owned control secondary then. For a requote or an outcome
// recommendation the composer collapses behind its summary — one activation away, so no capability
// is lost (Req 2.4) — and that section's control becomes the single prominent one. Collapsing the
// composer while a contact action is recommended moves that prominence onto its expander, so the
// recommended action always has exactly one prominent control.
//
// Closed renewals disable the work controls exactly as the pre-revision drawer did, which gated
// every one of them on the record holding an open status (Req 2.4).

import {
  AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, LoaderCircle, RefreshCw, Send,
  ShieldAlert, Smartphone, UserCheck, X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { renewalStatusTone, statusLabel, ui } from '../nhwd-shared/ui';
import {
  listContacts, listRenewalEvents, listSmsLogs, sendRenewalSms, sendToRequote,
  updateRenewalContactInfo, updateWorkflow,
} from './api';
import type { RenewalAssignee, RenewalContact, RenewalEvent, RenewalRecord, RenewalSmsLog } from './api';
import RenewalContactComposer from './RenewalContactComposer';
import RenewalTimeline from './RenewalTimeline';
import {
  REQUOTE_EVENT_TYPES, addDays, currentBusinessDate, daysRemaining, isOpenRenewal, premiumChange,
  recommendedNextAction, renewalNormalizedStatus, renewalWaitingReason,
} from './derive';
import type { RenewalNextAction } from './derive';
// Absent values render as an em dash, an absent assigned employee reads Unassigned, and the
// literals the Power BI export writes for an absent field never reach the screen (Req 5.1).
import {
  assignedText, calendarText, failureText, money, signedMoney, signedPercent, text, wholeNumber,
} from './format';

/** A next follow-up date runs from the business date through business date + 365 (Req 5.10). */
const MAX_FOLLOW_UP_DAYS = 365;

/** The only permitted final outcomes (Req 2.2, 5.11). */
const OUTCOMES = [
  { value: 'renewed', label: 'Renewed' }, { value: 'lost', label: 'Lost' }, { value: 'cancelled', label: 'Cancelled' },
] as const;

type RenewalOutcome = (typeof OUTCOMES)[number]['value'];

/** Import bookkeeping events, hidden from non-manager profiles as before the revision (Req 2.4). */
const INTERNAL_IMPORT_EVENTS = new Set([
  'powerbi_record_created', 'powerbi_record_updated', 'powerbi_record_missing', 'powerbi_record_restored',
  'import_record_created', 'import_record_updated', 'premium_update',
]);
const REQUOTE_TYPES = new Set<string>(REQUOTE_EVENT_TYPES);

/**
 * Which section holds the single prominent control for each recommended action (Req 5.3).
 *
 * `Review renewal` belongs to the contact section: reviewing the renewal terms with the customer is
 * a conversation, and the control the agent needs is the contact composer — the same one
 * `Complete follow-up` points at.
 */
const PRIMARY_SECTION: Record<RenewalNextAction, 'contact' | 'requote' | 'outcome'> = {
  'Make first contact': 'contact', 'Complete follow-up': 'contact', 'Review renewal': 'contact',
  'Prepare requote': 'requote', 'Review requote': 'requote',
  'Record customer decision': 'outcome', 'Close renewal': 'outcome',
};

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
const LOAD_FAILURE = 'Could not load the renewal contacts, activity, and text messages.';

export interface RenewalDrawerProps {
  /** The selected renewal. Nothing is rendered while it is `null`. */
  record: RenewalRecord | null;
  /** Agency-local calendar date from `currentBusinessDate`, computed once per container render pass. */
  businessDate: string;
  assignees?: readonly RenewalAssignee[];
  onClose: () => void;
  /** Raised after every successful write so the list refreshes; the drawer stays open (Req 5.5). */
  onRecordChanged: () => void | Promise<void>;
  /** Manager or super_admin: reveals the imported fields and the import bookkeeping entries. */
  canManage?: boolean;
}

/** Detail rows plus the `renewal_records.id` they belong to, so a stale selection never renders. */
interface DrawerDetail {
  key: string;
  contacts: readonly RenewalContact[]; events: readonly RenewalEvent[]; smsLogs: readonly RenewalSmsLog[];
}

interface DrawerForm {
  /** `followUp` is `null` until the user edits it, so a newly stored date flows into the field. */
  draft: { followUp: string | null; outcome: RenewalOutcome | ''; note: string; phone: string; email: string };
  fieldError: { followUp?: string; outcome?: string };
  error: string | null;
  notice: string | null;
}

const BLANK_DETAIL: DrawerDetail = { key: '', contacts: [], events: [], smsLogs: [] };
const BLANK_FORM: DrawerForm = {
  draft: { followUp: null, outcome: '', note: '', phone: '', email: '' },
  fieldError: {}, error: null, notice: null,
};

async function fetchDetail(recordId: string): Promise<DrawerDetail> {
  const [contacts, events, smsLogs] = await Promise.all([
    listContacts(recordId), listRenewalEvents(recordId), listSmsLogs(recordId),
  ]);
  return { key: recordId, contacts, events, smsLogs };
}

export default function RenewalDrawer({
  record, businessDate, assignees = [], onClose, onRecordChanged, canManage = false,
}: RenewalDrawerProps) {
  const titleId = useId();
  const followUpId = useId();
  const outcomeId = useId();
  const noteId = useId();
  const phoneId = useId();
  const emailId = useId();

  const [detail, setDetail] = useState<DrawerDetail>(BLANK_DETAIL);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formState, setFormState] = useState<{ key: string; form: DrawerForm } | null>(null);
  const [toggle, setToggle] = useState<{ key: string; open: boolean } | null>(null);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<Element | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);

  const recordId = record?.id ?? null;
  const storedFollowUp = record?.next_follow_up_at ?? null;
  const today = businessDate.trim() || currentBusinessDate();
  const latestFollowUp = addDays(today, MAX_FOLLOW_UP_DAYS);

  // Form state is keyed by the selection, so a new selection starts from a blank draft without an
  // effect, no failure path ever clears entered values (Req 2.7), and a success message survives
  // the record refresh that follows the write.
  const formKey = recordId ?? '';
  const form = formState?.key === formKey ? formState.form : BLANK_FORM;
  const update = useCallback((change: (current: DrawerForm) => DrawerForm) => {
    setFormState((current) => ({ key: formKey, form: change(current?.key === formKey ? current.form : BLANK_FORM) }));
  }, [formKey]);

  // Detail rows are keyed the same way, so the previous record's activity never renders against a
  // new selection; the loading indicator takes its place instead.
  const fresh = detail.key === (recordId ?? '');
  const contacts = fresh ? detail.contacts : BLANK_DETAIL.contacts;
  const events = fresh ? detail.events : BLANK_DETAIL.events;
  const smsLogs = fresh ? detail.smsLogs : BLANK_DETAIL.smsLogs;
  const loading = Boolean(recordId) && (refreshing || !fresh);

  const loadDetail = useCallback(async () => {
    if (!recordId) return;
    setRefreshing(true);
    try {
      setDetail(await fetchDetail(recordId));
      setLoadError(null);
    } catch (caught) {
      setLoadError(failureText(caught, LOAD_FAILURE));
    } finally {
      setRefreshing(false);
    }
  }, [recordId]);

  useEffect(() => {
    if (!recordId) return undefined;
    let live = true;
    void fetchDetail(recordId).then(
      (loaded) => { if (live) { setDetail(loaded); setLoadError(null); } },
      (caught: unknown) => { if (live) setLoadError(failureText(caught, LOAD_FAILURE)); },
    );
    return () => { live = false; };
  }, [recordId]);

  // Focus moves into the drawer on open and returns to the triggering element on close.
  useEffect(() => {
    if (!recordId) return undefined;
    triggerRef.current = document.activeElement;
    panelRef.current?.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement && document.body.contains(trigger)) trigger.focus();
    };
  }, [recordId]);

  const actorNames = useMemo(() => new Map(assignees.map((one) => [one.id, one.display_name])), [assignees]);
  const visibleEvents = useMemo(
    () => (canManage ? events : events.filter((event) => !INTERNAL_IMPORT_EVENTS.has(event.event_type))),
    [canManage, events],
  );
  const requoteEvents = useMemo(() => events.filter((event) => REQUOTE_TYPES.has(event.event_type)), [events]);

  /** Every write path: refresh this drawer's own queries, then the container's, without closing. */
  const runWrite = useCallback(async (operation: string, task: () => Promise<void>, success: string) => {
    setBusy(true);
    update((current) => ({ ...current, error: null, notice: null }));
    try {
      await task();
      update((current) => ({ ...current, notice: success, error: null }));
      await loadDetail();
      await onRecordChanged();
    } catch (caught) {
      update((current) => ({ ...current, error: failureText(caught, operation), notice: null }));
    } finally {
      setBusy(false);
    }
  }, [loadDetail, onRecordChanged, update]);

  const onContactAdded = useCallback(async () => {
    await loadDetail();
    await onRecordChanged();
  }, [loadDetail, onRecordChanged]);

  if (!record) return null;

  const id = record.id;
  const action = recommendedNextAction(record, contacts, requoteEvents);
  const primary = PRIMARY_SECTION[action];
  // Open status, requote activity, and the recommended action all come from `derive.ts`, so the
  // drawer holds no second copy of a rule the list surface already renders (Req 3.5, 5.2).
  const isOpenRecord = isOpenRenewal(record);
  const locked = busy || !isOpenRecord;
  const change = premiumChange(record.premium_current, record.premium_renewal);
  const days = daysRemaining(record.renewal_date, today);
  const assignedName = assignees.find((one) => one.id === record.assigned_to)?.display_name;
  const banner = form.error ?? loadError;
  const { draft, fieldError } = form;
  const followUpValue = draft.followUp ?? (storedFollowUp ? storedFollowUp.slice(0, 16) : '');

  const toggleKey = `${id}|${primary}`;
  const composerOpen = toggle?.key === toggleKey ? toggle.open : primary === 'contact';
  const setComposerOpen = (open: boolean) => setToggle({ key: toggleKey, open });
  // While a contact action is recommended the composer's own submit is the prominent control. If
  // the reader collapses the composer, its expander carries that prominence and is named after the
  // recommended action instead, so exactly one prominent control stands in either state (Req 5.3).
  const promoteComposer = primary === 'contact' && !composerOpen;
  const patch = (part: Partial<DrawerForm['draft']>) =>
    update((current) => ({ ...current, draft: { ...current.draft, ...part }, fieldError: {} }));
  const fail = (next: DrawerForm['fieldError']) => update((current) => ({ ...current, fieldError: next }));

  /**
   * The operational header of Requirement 6.5 and task 8.1: the six things an agent needs before
   * doing anything, at the top, in operational language.
   *
   * `normalizedStatus` is not `statusLabel(record.status)`: a Carrier Non-Renewal record has to read
   * `Carrier Non-Renewal / Requote Required` however its workflow status happens to be stored,
   * because that is the fact the work turns on (Requirement 7.2).
   */
  const normalizedStatus = renewalNormalizedStatus(record);
  const waitingReason = renewalWaitingReason(record);
  const lastContactAt = contacts.reduce<string | null>((latest, contact) => {
    const at = Date.parse(contact.occurred_at ?? '');
    if (Number.isNaN(at)) return latest;
    const held = latest === null ? Number.NEGATIVE_INFINITY : Date.parse(latest);
    return at > held ? contact.occurred_at : latest;
  }, null);

  const headerFacts: readonly [string, string][] = [
    ['Renewal date', `${calendarText(record.renewal_date)} · ${wholeNumber(days)} days`],
    ['Assigned employee', assignedText(assignedName)],
    ['Last contact', calendarText(lastContactAt, true)],
    ['Next follow-up', calendarText(record.next_follow_up_at, true)],
  ];

  /**
   * The Requirement 5.1 operational fields.
   *
   * Requirement 6.5 and task 8.2 moved the imported source values out of this grid and under the
   * `Imported source data` disclosure below: they are audit answers, not the work, and eighteen
   * cells of equal weight is how the next action got lost in the first place.
   */
  const fields: readonly [string, string][] = [
    ['Carrier', text(record.carrier)],
    ['Line of business', text(record.line_of_business)],
    ['Current premium', money(record.premium_current)],
    ['Renewal premium', money(record.premium_renewal)],
    ['Premium change', signedMoney(change)],
    ['Premium change percentage', signedPercent(change?.percent)],
    ['Customer phone', text(record.customer_phone)],
    ['Customer email', text(record.customer_email)],
    ['Stored workflow status', statusLabel(record.status)],
    ['Requote activity', [record.requote_requested ? 'Requested' : 'Not requested',
      record.requote_sent_at ? `sent ${calendarText(record.requote_sent_at)}` : null,
      record.requote_work_item_id ? 'quote created' : null,
      `${requoteEvents.length} ${requoteEvents.length === 1 ? 'entry' : 'entries'}`].filter(Boolean).join(' · ')],
    ['Recorded outcome note', text(record.outcome_reason)],
  ];

  /**
   * The imported source values, behind a disclosure (Requirement 6.5, task 8.2).
   *
   * Requirement 1.1 keeps every raw collector value for audit and Requirement 11.3 lets a manager
   * inspect the file name, the row number, the raw status, the match result, and the warning. All of
   * that belongs here rather than in the agent's way — and the raw value is shown *beside* the
   * interpretation, so the answer to "what did the carrier actually say" is one glance away.
   */
  const sourceFields: readonly [string, string][] = [
    ...(record.source_system
      ? ([
        ['Imported by', record.source_system === 'renewal_collector'
          ? 'Renewals collector export' : record.source_system],
        ['Source file', text(record.source_file_name)],
        ['Source row', wholeNumber(record.source_row_number ?? null)],
        ['Raw record type (TipoRegistro)', text(record.source_record_type)],
        ['Read as', normalizedStatus],
        ['Raw carrier status (EstadoEnReporte)', text(record.source_status_raw)],
        ['Raw customer match (Cruce)', text(record.source_match_status_raw)],
        ['Match read as', text(record.source_match_status)],
        ['Match method (MetodoCruce)', text(record.source_match_method)],
        ['Collector warning', text(record.source_warning)],
      ] as [string, string][])
      : []),
    // The legacy Power BI / HawkSoft values, manager-visible as before the revision (Req 2.4).
    ...(canManage ? ([
      ['Imported responsible name', text(record.assigned_import_label)],
      ['Producer label', text(record.producer_label)],
      ['Assignment source', text(record.assignment_source)],
      ['Aviso call date', calendarText(record.notice_call_at)],
      ['EFT', text(record.eft_enabled)],
      ['Imported notes', text(record.import_notes)],
      ['Requote note', text(record.requote_note)],
    ] as [string, string][]) : []),
  ];

  const requoteLabel = record.requote_work_item_id ? 'Quote already created'
    : record.requote_intake_id ? (action === 'Review requote' ? 'Review requote intake' : 'Continue requote intake')
      : 'Prepare requote intake';

  /** Escape closes the drawer; Tab cycles inside it, so focus never leaves while it is open. */
  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    const stops = panel
      ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => node.offsetParent !== null)
      : [];
    if (stops.length === 0) return;
    const [first] = stops;
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  }

  function submitFollowUp() {
    const entered = followUpValue.trim();
    const range = `Choose a date from ${today} through ${latestFollowUp}.`;
    if (!entered) return fail({ followUp: `Enter the next follow-up date and time. ${range}` });
    if (entered.slice(0, 10) < today || entered.slice(0, 10) > latestFollowUp) {
      // Nothing is written, so the stored follow-up date is retained unchanged (Req 5.10).
      return fail({ followUp: `${range} The stored follow-up date is unchanged: ${calendarText(storedFollowUp, true)}.` });
    }
    return void runWrite('Could not schedule the next renewal follow-up.',
      () => updateWorkflow(id, { status: 'monitoring', nextFollowUpAt: new Date(entered).toISOString() }),
      'Next follow-up scheduled.');
  }

  function submitOutcome() {
    const outcome = draft.outcome;
    if (!outcome) return fail({ outcome: 'Select exactly one outcome: Renewed, Lost, or Cancelled.' });
    if (!draft.note.trim()) {
      return fail({ outcome: 'Enter an outcome note containing at least one character that is not a space.' });
    }
    // `renewal_update_workflow` stores the recording profile and the outcome time (Req 5.11, 2.1).
    return void runWrite('Could not record the renewal outcome.',
      () => updateWorkflow(id, { status: outcome, outcomeReason: draft.note.trim() }),
      `Renewal marked ${statusLabel(outcome)}.`);
  }

  function submitContactInfo() {
    const phone = record?.customer_phone ? null : draft.phone.trim() || null;
    const email = record?.customer_email ? null : draft.email.trim() || null;
    if (!phone && !email) {
      return update((current) => ({ ...current, error: 'Enter the missing customer phone number or email address.' }));
    }
    return void runWrite('Could not save the customer contact information.',
      () => updateRenewalContactInfo(id, { phone, email }), 'Customer contact information saved.');
  }

  async function openRequote() {
    setBusy(true);
    update((current) => ({ ...current, error: null, notice: null }));
    try {
      const intakeId = record?.requote_intake_id || await sendToRequote(id);
      window.location.assign(`/tools/cs-intake?edit=${encodeURIComponent(intakeId)}&from=renewal`);
    } catch (caught) {
      update((current) => ({ ...current, error: failureText(caught, 'Could not prepare the requote intake.') }));
      setBusy(false);
    }
  }

  /** Validation errors carry an icon and text, so no error is conveyed by colour alone. */
  const errorLine = (target: string, message: string) => (
    <p id={`${target}-error`} role="alert" className="mt-2 flex gap-1.5 text-xs font-bold text-rose-700">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>{message}</span>
    </p>
  );
  const labelled = (target: string, label: string, control: React.ReactNode) => (
    <div><label className={ui.label} htmlFor={target}>{label}</label>{control}</div>
  );
  const describe = (target: string, shown: boolean, extra?: string) =>
    [extra, shown ? `${target}-error` : ''].filter(Boolean).join(' ') || undefined;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={trapFocus}
        onMouseDown={(event) => event.stopPropagation()}
        className="ml-auto h-full w-full max-w-3xl overflow-y-auto bg-[#f3f5f9] shadow-2xl outline-none"
      >
        <div className="sticky top-0 z-20 flex items-start justify-between gap-3 border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur">
          <div>
            <p className="text-xs font-black tracking-[0.15em] text-[#223f7a] uppercase">Renewal record</p>
            <h2 id={titleId} className="text-lg font-black text-slate-950">
              {text(record.customer_name)} · Policy {text(record.policy_number)}
            </h2>
          </div>
          <div className="flex shrink-0 gap-1">
            <button type="button" className={ui.btnGhost} disabled={loading} onClick={() => void loadDetail()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />Refresh
            </button>
            <button type="button" className={ui.btnGhost} onClick={onClose} aria-label="Close the renewal drawer">
              <X className="h-4 w-4" aria-hidden="true" />Close
            </button>
          </div>
        </div>

        <div className="space-y-5 p-4 sm:p-6">
          {banner ? <p role="alert" className={`${ui.error} flex gap-2`}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{banner}</span>
          </p> : null}
          <p aria-live="polite" className="sr-only">{form.notice ?? ''}</p>
          {form.notice ? <p className={ui.success}>{form.notice}</p> : null}

          {/* The operational header (Requirement 6.5, task 8.1). Status, the one next action, the
              event date and days remaining, the owner, the last contact, and the next follow-up —
              before anything imported and before any other field. */}
          <section className={`${ui.card} ${ui.cardPad}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`${ui.badge} ${ui.badgeTone[renewalStatusTone[record.status] || 'neutral']}`}>
                {normalizedStatus}
              </span>
              {isOpenRecord ? null : <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>Closed renewal</span>}
              {record.source_review_required ? (
                <span className={`${ui.badge} ${ui.badgeTone.progress}`}>
                  <ShieldAlert className="mr-1 h-3 w-3" aria-hidden="true" />Manager review required
                </span>
              ) : null}
              {record.source_communication_blocked ? (
                <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>Automatic messaging held</span>
              ) : null}
            </div>

            <p className="mt-3 flex items-center gap-2 text-lg font-black text-[#223f7a]">
              <ArrowRight className="h-5 w-5 shrink-0" aria-hidden="true" />
              Next: {action}
            </p>
            {waitingReason === null ? null : (
              <p className="mt-1 text-sm font-bold text-slate-500">{waitingReason}</p>
            )}

            <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {headerFacts.map(([label, value]) => (
                <div key={label} className="rounded-2xl bg-[#eef3fb] px-3 py-2.5">
                  <dt className="text-[10px] font-black tracking-wider text-[#5b6f96] uppercase">{label}</dt>
                  <dd className="mt-1 text-sm font-black break-words text-slate-900">{value}</dd>
                </div>
              ))}
            </dl>

            <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {fields.map(([label, value]) => (
                <div key={label} className="rounded-2xl bg-slate-50 px-3 py-2.5">
                  <dt className="text-[10px] font-black tracking-wider text-slate-400 uppercase">{label}</dt>
                  <dd className="mt-1 text-sm font-black break-words text-slate-900">{value}</dd>
                </div>
              ))}
            </dl>

            {/* Requirements 1.1, 11.3, 6.5: the raw source values stay reachable and stay out of
                the way. Collapsed by default; the raw value sits beside its interpretation. */}
            {sourceFields.length > 0 ? (
              <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3">
                <summary className="cursor-pointer text-xs font-black text-slate-700">
                  Imported source data
                </summary>
                <p className="mt-2 text-xs font-semibold text-slate-500">
                  What the collector and the carrier actually wrote, kept exactly as received.
                </p>
                <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {sourceFields.map(([label, value]) => (
                    <div key={label} className="rounded-2xl bg-white px-3 py-2.5">
                      <dt className="text-[10px] font-black tracking-wider text-slate-400 uppercase">{label}</dt>
                      <dd className="mt-1 text-sm font-black break-words text-slate-900">{value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
          </section>

          {record.customer_phone && record.customer_email ? null : (
            <section className={`${ui.card} ${ui.cardPad}`}>
              <h3 className="font-black text-slate-950">Add missing customer contact information</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">An empty phone number or email address may be filled here. Management corrects existing information.</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {labelled(phoneId, 'Customer phone', <input id={phoneId} className={ui.input} disabled={busy || Boolean(record.customer_phone)} value={record.customer_phone || draft.phone} onChange={(event) => patch({ phone: event.target.value })} />)}
                {labelled(emailId, 'Customer email', <input id={emailId} type="email" className={ui.input} disabled={busy || Boolean(record.customer_email)} value={record.customer_email || draft.email} onChange={(event) => patch({ email: event.target.value })} />)}
              </div>
              <button type="button" className={`${ui.btnSecondary} mt-4`} disabled={busy} onClick={submitContactInfo}>
                <UserCheck className="h-4 w-4" aria-hidden="true" />Save contact information
              </button>
            </section>
          )}

          <details open={composerOpen} onToggle={(event) => setComposerOpen(event.currentTarget.open)} className={`${ui.card} overflow-hidden`}>
            <summary className={`cursor-pointer list-none px-5 py-4 font-black [&::-webkit-details-marker]:hidden ${promoteComposer ? 'bg-[#223f7a] text-white' : 'text-[#223f7a]'}`}>
              {promoteComposer ? action : 'Log a customer contact'}
              <span className={`ml-2 text-xs font-semibold ${promoteComposer ? 'text-white/80' : 'text-slate-500'}`}>{composerOpen ? 'Collapse' : 'Expand'} · {contacts.length} recorded</span>
            </summary>
            <div ref={composerRef} tabIndex={-1} className="border-t border-slate-100 p-1 outline-none">
              {/* Mounted only while expanded, so the composer's own primary submit is never a second
                  prominent control in the drawer (Req 5.3). */}
              {composerOpen ? <RenewalContactComposer recordId={id} onContactAdded={onContactAdded} disabled={locked} evidenceContacts={contacts} /> : null}
            </div>
          </details>

          <section className={`${ui.card} ${ui.cardPad} grid gap-5 lg:grid-cols-2`}>
            <div>
              {labelled(followUpId, 'Next follow-up date and time', (
                <input
                  id={followUpId} type="datetime-local" className={ui.input} disabled={locked} value={followUpValue}
                  min={`${today}T00:00`} max={`${latestFollowUp}T23:59`} aria-invalid={Boolean(fieldError.followUp)}
                  aria-describedby={describe(followUpId, Boolean(fieldError.followUp), `${followUpId}-range`)}
                  onChange={(event) => patch({ followUp: event.target.value })} />
              ))}
              <p id={`${followUpId}-range`} className="mt-2 text-xs font-semibold text-slate-500">
                Permitted range {today} through {latestFollowUp}. Currently scheduled {calendarText(storedFollowUp, true)}.
              </p>
              {fieldError.followUp ? errorLine(followUpId, fieldError.followUp) : null}
              <button type="button" className={`${ui.btnSecondary} mt-3`} disabled={locked} onClick={submitFollowUp}>
                <CalendarClock className="h-4 w-4" aria-hidden="true" />Schedule follow-up
              </button>
            </div>
            <div>
              <p className={ui.sectionTitle}>Requote and reminders</p>
              <p className="mt-2 text-sm font-semibold text-slate-500">The requote control creates or reopens the linked Sales intake. Sent text messages appear in the activity timeline below.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button" className={primary === 'requote' ? ui.btnPrimary : ui.btnSecondary}
                  disabled={locked || Boolean(record.requote_work_item_id)} onClick={() => void openRequote()}
                >
                  <Send className="h-4 w-4" aria-hidden="true" />{requoteLabel}
                </button>
                <button
                  type="button" className={ui.btnSecondary} disabled={locked || !record.customer_phone}
                  onClick={() => void runWrite('Could not send the renewal text message.',
                    async () => { await sendRenewalSms(id); }, 'Text message sent.')}
                >
                  <Smartphone className="h-4 w-4" aria-hidden="true" />Send text reminder
                </button>
              </div>
              {record.customer_phone ? null : (
                <p className="mt-2 text-xs font-bold text-amber-700">Add a customer phone number before sending a text message.</p>
              )}
            </div>
          </section>

          <section className={`${ui.card} ${ui.cardPad}`}>
            <h3 className="font-black text-slate-950">Record the final outcome</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">Exactly one outcome and a note are required. Logging a contact never closes the renewal.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {labelled(outcomeId, 'Outcome', (
                <select
                  id={outcomeId} className={ui.select} disabled={locked} value={draft.outcome}
                  aria-invalid={Boolean(fieldError.outcome) && !draft.outcome}
                  aria-describedby={describe(outcomeId, Boolean(fieldError.outcome))}
                  onChange={(event) => patch({
                    outcome: OUTCOMES.some((one) => one.value === event.target.value)
                      ? (event.target.value as RenewalOutcome) : '',
                  })}
                >
                  <option value="">Select an outcome…</option>
                  {OUTCOMES.map((one) => <option key={one.value} value={one.value}>{one.label}</option>)}
                </select>
              ))}
              {labelled(noteId, 'Outcome note (required)', (
                <textarea
                  id={noteId} rows={3} className={ui.textarea} disabled={locked} value={draft.note}
                  aria-invalid={Boolean(fieldError.outcome) && Boolean(draft.outcome)}
                  aria-describedby={describe(outcomeId, Boolean(fieldError.outcome))}
                  onChange={(event) => patch({ note: event.target.value })} />
              ))}
            </div>
            {fieldError.outcome ? errorLine(outcomeId, fieldError.outcome) : null}
            <button
              type="button" className={`mt-4 ${primary === 'outcome' ? ui.btnPrimary : ui.btnSecondary}`}
              disabled={locked} onClick={submitOutcome}
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
              {isOpenRecord ? 'Record outcome' : `Renewal already ${statusLabel(record.status)}`}
            </button>
          </section>

          <section className={`${ui.card} ${ui.cardPad}`}>
            <p className={`${ui.sectionTitle} mb-4`}>Renewal activity</p>
            {/* Evidence stays in the composer, which owns `getEvidenceUrl` and
                `downloadEvidenceFile`; a timeline entry hands the reader to those controls. */}
            <RenewalTimeline
              contacts={contacts} events={visibleEvents} smsLogs={smsLogs} actorNames={actorNames} loading={loading}
              onOpenEvidence={() => { setComposerOpen(true); composerRef.current?.scrollIntoView({ block: 'center' }); composerRef.current?.focus(); }}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

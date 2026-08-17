'use client';

/**
 * One journey, in full: who the customer is, where the quote stands, who is
 * responsible, what has happened, and the actions this employee may take.
 *
 * The actions here do not reimplement any business logic. Continue Intake opens
 * the existing intake form, and Add Note calls the existing note RPCs. Claiming,
 * pricing and outcomes deliberately stay on My Desk, because those are governed by
 * the queue and turn rules and Quote Center must not become a way around them.
 */

import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  FileText,
  MapPin,
  MessageSquarePlus,
  Phone,
  RefreshCw,
  Store,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AppRole } from '@/lib/types';
import { ui } from '../nhwd-shared/ui';
import { addJourneyNote, getJourney, getJourneyTimeline } from './api';
import { getQuoteCenterPermissions } from './permissions';
import {
  formatPhone,
  isContinuableDraft,
  journeyReference,
  lineOfBusinessLabel,
  notSoldReasonLabel,
  stageTone,
} from './status';
import type { JourneyDetail, TimelineEntry, TimelineOrigin } from './types';

/** Plain-language titles for the raw event names in the three logs. */
const EVENT_TITLES: Record<string, string> = {
  created: 'Intake started',
  draft_updated: 'Draft updated',
  submitted: 'Intake completed and submitted',
  claimed: 'Intake claimed',
  ringcentral_claimed: 'Claimed on the RingCentral turn',
  walk_in_claimed_on_turn: 'Walk-in claimed on turn',
  walk_in_claimed_out_of_turn: 'Walk-in claimed out of turn',
  ringcentral_claim_recovered: 'Claim recovered',
  manager_assigned: 'Assigned by a manager',
  converted: 'Converted to a quote',
  converted_commercial: 'Sent to the Commercial Board',
  returned: 'Returned to Customer Service',
  rejected: 'Intake rejected',
  note_added: 'Note added',
  created_from_cs_intake: 'Quote created from the intake',
  ringcentral_intake_claim_completed: 'RingCentral intake claim completed',
  walk_in_intake_claim_out_of_turn: 'Walk-in claim taken out of turn',
  assigned: 'Assigned',
  accepted: 'Accepted by the agent',
  reassigned: 'Reassigned',
  price_sent: 'Pricing sent',
  sold: 'Sold',
  not_sold: 'Not sold',
  outcome_change: 'Outcome changed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  taken: 'Taken',
  timer_claimed: 'Timed quote claimed',
  activation: 'Activation',
  change: 'Policy change',
};

function eventTitle(entry: TimelineEntry): string {
  return EVENT_TITLES[entry.event_type] ?? entry.event_type.replace(/_/g, ' ');
}

const ORIGIN_STYLES: Record<TimelineOrigin, { dot: string; label: string }> = {
  intake: { dot: 'bg-[#223f7a]', label: 'Intake' },
  quote: { dot: 'bg-emerald-600', label: 'Quote' },
  note: { dot: 'bg-amber-500', label: 'Note' },
};

function formatMoment(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDay(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function DetailRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | null | undefined;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</p>
      <p className="mt-1 flex items-center gap-1.5 text-sm font-bold text-slate-800">
        {icon}
        {value && value.trim() !== '' ? value : '—'}
      </p>
    </div>
  );
}

export interface JourneyDrawerProps {
  journeyKey: string;
  role: AppRole;
  onClose: () => void;
  /** Opens the intake editor for a continuable draft. */
  onContinueIntake?: (intakeId: string) => void;
  /** Navigates to My Desk, where the queue and turn rules live. */
  onGoToMyDesk?: () => void;
}

export default function JourneyDrawer({
  journeyKey,
  role,
  onClose,
  onContinueIntake,
  onGoToMyDesk,
}: JourneyDrawerProps) {
  const permissions = useMemo(() => getQuoteCenterPermissions(role), [role]);
  const [journey, setJourney] = useState<JourneyDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteNotice, setNoteNotice] = useState<string | null>(null);

  /**
   * Loads the journey and, once it is known, its timeline.
   *
   * Every state update happens in a promise callback and is guarded by `isCurrent`.
   * That guard is not decoration: opening one customer and immediately opening
   * another would otherwise let the first request resolve last and paint the wrong
   * customer's history under the second customer's name.
   *
   * Returns a function that abandons the in-flight result, which is what the effect
   * cleanup and the Refresh button both need.
   */
  const startLoad = useCallback(
    (journey: string, onSettled?: () => void) => {
      let isCurrent = true;

      getJourney(journey)
        .then((record) => {
          if (!isCurrent) return null;
          if (!record) {
            setError('This record is no longer available.');
            setJourney(null);
            return null;
          }
          setError(null);
          setJourney(record);
          // Fetched after the record so the header paints immediately rather than
          // waiting on three merged event logs.
          return getJourneyTimeline(record.intake_id, record.work_item_id);
        })
        .then((entries) => {
          if (isCurrent && entries) setTimeline(entries);
        })
        .catch((caught: unknown) => {
          if (!isCurrent) return;
          setError(caught instanceof Error ? caught.message : 'Unable to open this record.');
        })
        .finally(() => {
          if (!isCurrent) return;
          setLoading(false);
          onSettled?.();
        });

      return () => {
        isCurrent = false;
      };
    },
    [],
  );

  const refresh = useCallback(() => {
    setLoading(true);
    startLoad(journeyKey);
  }, [journeyKey, startLoad]);

  useEffect(() => startLoad(journeyKey), [journeyKey, startLoad]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  async function submitNote() {
    if (!journey || noteDraft.trim() === '') return;
    setSavingNote(true);
    setNoteNotice(null);
    setError(null);
    try {
      await addJourneyNote(journey, noteDraft.trim());
      setNoteDraft('');
      setNoteNotice('Note added. The quote stays with its current owner.');
      setTimeline(await getJourneyTimeline(journey.intake_id, journey.work_item_id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The note could not be added.');
    } finally {
      setSavingNote(false);
    }
  }

  const canContinue =
    journey !== null &&
    permissions.editSharedDraft &&
    journey.intake_id !== null &&
    isContinuableDraft(journey.intake_status);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/50 backdrop-blur-sm"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="h-full w-full max-w-3xl overflow-y-auto bg-[#f3f5f9] shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Quote journey detail"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur-xl sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              {journey ? (
                <>
                  <h2 className="truncate text-2xl font-black tracking-tight text-slate-950">
                    {journey.customer_name}
                  </h2>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>
                      {lineOfBusinessLabel(journey.line_of_business, journey.work_type)}
                    </span>
                    <span
                      className={`${ui.badge} ${ui.badgeTone[stageTone(journey.stage, journey.decision)]}`}
                    >
                      {journey.stage_label}
                    </span>
                    <span className="text-xs font-black text-slate-400">
                      {journeyReference(journey)}
                    </span>
                    {journey.is_voided ? (
                      <span className={`${ui.badge} ${ui.badgeTone.danger}`}>Voided</span>
                    ) : null}
                  </div>
                </>
              ) : (
                <h2 className="text-xl font-black text-slate-500">Quote journey</h2>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" className={ui.btnGhost} onClick={refresh}>
                <RefreshCw className="h-4 w-4" />
              </button>
              <button type="button" className={ui.btnGhost} onClick={onClose} aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-5 p-5 sm:p-6">
          {error ? <div className={ui.error}>{error}</div> : null}
          {noteNotice ? <div className={ui.success}>{noteNotice}</div> : null}

          {loading && !journey ? (
            <div className={ui.empty}>Loading the customer&apos;s history…</div>
          ) : null}

          {journey ? (
            <>
              {/* Actions. Only what this role may do at this stage. */}
              <section className={`${ui.card} ${ui.cardPad}`}>
                <p className={ui.sectionTitle}>Actions</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {canContinue ? (
                    <button
                      type="button"
                      className={ui.btnPrimary}
                      onClick={() => onContinueIntake?.(journey.intake_id!)}
                    >
                      <ClipboardList className="h-4 w-4" /> Continue Intake
                    </button>
                  ) : null}

                  {journey.stage === 'intake' &&
                  journey.intake_status === 'submitted' &&
                  permissions.takeIntakeWork ? (
                    <button type="button" className={ui.btnSecondary} onClick={onGoToMyDesk}>
                      <ArrowRight className="h-4 w-4" /> Take it on My Desk
                    </button>
                  ) : null}

                  {journey.stage === 'working' || journey.stage === 'price_sent' ? (
                    <button type="button" className={ui.btnSecondary} onClick={onGoToMyDesk}>
                      <ArrowRight className="h-4 w-4" /> Work this on My Desk
                    </button>
                  ) : null}
                </div>
                {journey.intake_status === 'submitted' && permissions.takeIntakeWork ? (
                  <p className="mt-3 text-xs font-semibold text-slate-500">
                    Seeing an available intake here is not the same as being able to take
                    it. The RingCentral turn, walk-in authorisation and claim rules still
                    apply, and they live on My Desk.
                  </p>
                ) : null}
                {!canContinue && journey.intake_id && !isContinuableDraft(journey.intake_status) ? (
                  <p className="mt-3 text-xs font-semibold text-slate-500">
                    This intake has been handed over, so its original answers are now
                    history. Add a note to record anything new the customer tells you.
                  </p>
                ) : null}
              </section>

              {/* Customer */}
              <section className={`${ui.card} ${ui.cardPad}`}>
                <p className={ui.sectionTitle}>Customer</p>
                <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <DetailRow
                    label="Primary phone"
                    value={formatPhone(journey.phone_primary)}
                    icon={<Phone className="h-3.5 w-3.5 text-slate-400" />}
                  />
                  <DetailRow label="Alternate phone" value={formatPhone(journey.phone_alt)} />
                  <DetailRow label="Email" value={journey.email} />
                  <DetailRow label="Date of birth" value={formatDay(journey.insured_dob)} />
                  <div className="sm:col-span-2">
                    <DetailRow
                      label="Address"
                      value={[
                        journey.addr_street,
                        journey.addr_unit,
                        journey.addr_city,
                        journey.addr_state,
                        journey.addr_zip,
                      ]
                        .filter((part) => part && String(part).trim() !== '')
                        .join(', ')}
                      icon={<MapPin className="h-3.5 w-3.5 text-slate-400" />}
                    />
                  </div>
                  {journey.business_name ? (
                    <DetailRow label="Business" value={journey.business_name} />
                  ) : null}
                  {journey.dot_number ? (
                    <DetailRow label="DOT number" value={journey.dot_number} />
                  ) : null}
                  {journey.renters_property_address ? (
                    <div className="sm:col-span-2">
                      <DetailRow
                        label="Rental property"
                        value={[
                          journey.renters_property_address,
                          journey.renters_city,
                          journey.renters_state,
                        ]
                          .filter((part) => part && String(part).trim() !== '')
                          .join(', ')}
                      />
                    </div>
                  ) : null}
                </div>
              </section>

              {/* Source and responsibility */}
              <div className="grid gap-5 lg:grid-cols-2">
                <section className={`${ui.card} ${ui.cardPad}`}>
                  <p className={ui.sectionTitle}>Source</p>
                  <div className="mt-3 space-y-4">
                    <DetailRow
                      label="Received through"
                      value={journey.source_label}
                      icon={<Store className="h-3.5 w-3.5 text-slate-400" />}
                    />
                    <DetailRow label="Dealer" value={journey.dealer_name} />
                    <DetailRow label="Dealer salesperson" value={journey.salesperson_name} />
                    {journey.is_walk_in ? (
                      <span className={`${ui.badge} ${ui.badgeTone.progress}`}>Walk-in</span>
                    ) : null}
                  </div>
                </section>

                <section className={`${ui.card} ${ui.cardPad}`}>
                  <p className={ui.sectionTitle}>Responsibility</p>
                  <div className="mt-3 space-y-4">
                    <DetailRow
                      label="Started by"
                      value={journey.started_by_name}
                      icon={<UserRound className="h-3.5 w-3.5 text-slate-400" />}
                    />
                    <DetailRow
                      label="Completed by"
                      value={
                        journey.completed_by_name ??
                        (journey.submitted_at
                          ? `${journey.started_by_name ?? 'Unknown'} (recorded before completion tracking)`
                          : null)
                      }
                      icon={<CheckCircle2 className="h-3.5 w-3.5 text-slate-400" />}
                    />
                    <DetailRow label="Assigned agent" value={journey.assigned_agent_name} />
                    {journey.last_edited_by_name ? (
                      <DetailRow label="Last edited by" value={journey.last_edited_by_name} />
                    ) : null}
                  </div>
                </section>
              </div>

              {/* Current state */}
              <section className={`${ui.card} ${ui.cardPad}`}>
                <p className={ui.sectionTitle}>Current state</p>
                <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <DetailRow label="Status" value={journey.stage_label} />
                  <DetailRow label="Started" value={formatMoment(journey.started_at)} />
                  <DetailRow label="Submitted" value={formatMoment(journey.submitted_at)} />
                  <DetailRow label="Pricing sent" value={formatMoment(journey.price_sent_at)} />
                  <DetailRow
                    label="Decision"
                    value={
                      journey.decision
                        ? journey.decision === 'sold'
                          ? 'Sold'
                          : `Not sold — ${notSoldReasonLabel(journey.not_sold_reason) ?? 'reason not recorded'}`
                        : null
                    }
                  />
                  <DetailRow
                    label="Last activity"
                    value={formatMoment(journey.last_activity_at)}
                    icon={<CalendarClock className="h-3.5 w-3.5 text-slate-400" />}
                  />
                </div>
              </section>

              {/* Add note — available regardless of ownership */}
              {permissions.addQuoteNote ? (
                <section className={`${ui.card} ${ui.cardPad}`}>
                  <p className={ui.sectionTitle}>Add a note</p>
                  <p className="mt-1 text-sm font-semibold text-slate-500">
                    Anyone who can see this record can document a call. The quote stays with
                    {journey.assigned_agent_name ? ` ${journey.assigned_agent_name}` : ' its current owner'}.
                  </p>
                  <textarea
                    className={ui.textarea}
                    rows={3}
                    value={noteDraft}
                    disabled={savingNote}
                    onChange={(event) => setNoteDraft(event.target.value)}
                    placeholder="What did the customer say? Include anything the next person needs to know."
                  />
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      className={ui.btnPrimary}
                      disabled={savingNote || noteDraft.trim() === ''}
                      onClick={() => void submitNote()}
                    >
                      <MessageSquarePlus className="h-4 w-4" />
                      {savingNote ? 'Saving…' : 'Add note'}
                    </button>
                  </div>
                </section>
              ) : null}

              {/* Timeline */}
              <section className={`${ui.card} overflow-hidden`}>
                <div className={ui.cardHeader}>
                  <div>
                    <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">
                      <FileText className="h-4 w-4" /> Journey
                    </div>
                    <h3 className="mt-1 text-lg font-black">Everything that has happened</h3>
                    <p className="mt-1 text-sm font-semibold text-slate-500">
                      The intake and the quote it became, as one history.
                    </p>
                  </div>
                </div>
                <div className={ui.cardPad}>
                  {timeline.length === 0 ? (
                    <p className={ui.empty}>No recorded activity yet.</p>
                  ) : (
                    <ol className="space-y-4">
                      {timeline.map((entry, index) => {
                        const style = ORIGIN_STYLES[entry.origin];
                        const changed = Array.isArray(entry.detail?.changed_fields)
                          ? (entry.detail!.changed_fields as unknown[]).length
                          : 0;
                        return (
                          <li
                            key={`${entry.occurred_at}-${entry.event_type}-${index}`}
                            className="flex gap-3"
                          >
                            <div className="flex flex-col items-center">
                              <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
                              {index < timeline.length - 1 ? (
                                <span className="mt-1 w-px flex-1 bg-slate-200" />
                              ) : null}
                            </div>
                            <div className="flex-1 pb-1">
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                <p className="text-sm font-black text-slate-900">
                                  {eventTitle(entry)}
                                </p>
                                <span className="text-[11px] font-black uppercase tracking-wider text-slate-300">
                                  {style.label}
                                </span>
                              </div>
                              <p className="mt-0.5 text-xs font-semibold text-slate-500">
                                {formatMoment(entry.occurred_at)} · {entry.actor_name}
                              </p>
                              {entry.note ? (
                                <p className="mt-1.5 whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700">
                                  {entry.note}
                                </p>
                              ) : null}
                              {entry.event_type === 'draft_updated' && changed > 0 ? (
                                <p className="mt-1 text-xs font-semibold text-slate-400">
                                  {changed} field{changed === 1 ? '' : 's'} changed
                                </p>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              </section>

              {journey.source_commercial_quote_id ? (
                <p className="flex items-start gap-2 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-900">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  This intake was routed to the Commercial Board. Its ongoing work is tracked
                  there, not in the Sales queues.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

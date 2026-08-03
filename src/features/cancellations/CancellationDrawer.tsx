'use client';

// Cancellation detail drawer — task 16.6
// (Requirements 17.1, 17.2, 17.3, 17.4, 17.7, 17.10, 17.12, 13.8).
//
// The cancellations twin of `../renewals/RenewalDrawer`: the same overlay and panel shell, the same
// `nhwd-shared/ui` tokens, the same focus contract (focus enters the panel on open and returns to
// the triggering element on close, Escape closes, Tab cycles inside), and the same rule that every
// write refreshes this drawer's own reads and then the container's without closing.
//
// **What this file owns.** The detail reads of the selected Cancellation_Case, all of them through
// `./api`, and the two manual send actions, both through `POST /api/cancellations/send`. No
// Supabase client is opened here and no database function is called here.
//
// **What this file composes rather than reimplements.**
//   * `./derive` decides every value on screen. The summary reads `cancellationRowCells`, which is
//     the same function the list row reads, and the prominent control reads `primaryAction`. The
//     eight-step ladder of Requirement 17.4 is never re-walked here — that is what makes
//     Requirements 16.9 and 16.10 hold: the list cell and this drawer name one action because
//     there is one implementation, called twice.
//   * `./CancellationContactPanel` (task 16.8) owns adding a contact, preferred language,
//     authorization, both opt-out writes, and the customer response form.
//   * `./CancellationPaymentReport` (task 16.9) owns the payment report.
//   * `./CancellationVerificationPanel` (task 16.10) owns the seven verification outcomes, Mark
//     Resolved, and the Case_Status override.
//   None of those forms is duplicated below. The nine controls of Requirement 17.3 are selectable
//   affordances that either run a send or hand the reader to the panel that performs the work.
//
// **Readings recorded where a criterion leaves something open.**
//
//  1. *The primary action is read, never recomputed.* Requirement 17.4's ladder already applies
//     Requirement 17.10's role visibility per step inside `primaryAction`, so a control hidden from
//     the signed-in profile is skipped and the next step is considered. `cancellationDrawerControls`
//     therefore asks `primaryAction` once and marks the control whose action came back, which makes
//     "exactly one prominent" a property of the data rather than of the markup. Confirm Cancellation
//     is one of the nine controls and is never a step of the ladder, so it is selectable and never
//     prominent — that is the criterion, not an omission.
//  2. *A cleared next required action leaves no prominent control.* `primaryAction` returns `null`
//     for a case whose stored action was cleared at Reinstated, Cancelled, or Resolved
//     (Requirement 16.9). Nine controls are still offered, none is promoted, and the summary cell
//     reads an em dash — promoting one anyway would name an action the case does not have.
//  3. *Prominence is carried by more than colour.* The promoted control takes the filled button
//     token, a filled star glyph, and the words "Do this next", and it is the only control wired to
//     the paragraph naming the primary action through `aria-describedby`.
//  4. *Requirement 17.2's roster is rendered here even though the contact panel lists contacts too.*
//     The panel shows a suppression badge only where a flag is set, and the criterion asks for the
//     SMS suppression state and the email suppression state of every row. So the drawer renders a
//     read-only roster naming all seven values plus the preferred language, and the panel below it
//     keeps the controls. One is the record, the other is the work surface.
//  5. *The Touchpoint schedule is derived, because it is stored nowhere.* Requirement 12.1 fixes a
//     Touchpoint's scheduled date as the calendar date that many days before the cancellation
//     effective date, and Requirement 12.2 schedules a channel only where it has at least one
//     eligible Contact_Recipient. `cancellation_cases` carries neither, so both are computed here
//     from the effective date, the contact rows, and the active suppressions —
//     `cancellationScheduledSends` is `scheduler/run.scheduledSendsFor` restated over the browser's
//     row types, deliberately NOT imported: that module constructs a service-role client and reads
//     the cron secret, neither of which may enter a browser bundle.
//  6. *A per-channel send state is the shared status derivation applied to one pair.* Each cell of
//     the schedule is `deriveCommunicationStatus` over the records of that Touchpoint and channel,
//     with that pair as the pending send when it is scheduled and unsent. So the schedule cannot
//     disagree with the SMS status and email status cells of Requirement 16.9 — same function.
//  7. *The pending-send count is derived or withheld, never guessed.* The three child panels
//     recompute Communication_Status only from a supplied count (Requirement 15.9). Where the
//     cancellation effective date is absent or unreadable the schedule is unknown, so the count is
//     passed as `undefined` and the stored status is left alone rather than set from a zero.
//  8. *Active suppressions are read, not inferred from the contact flags.* A contact row an import
//     created after an opt-out carries the flag cleared while an active `cancellation_suppressions`
//     row still exists (Requirements 21.3, 21.4). `listSuppressions` is read for the case's contact
//     values so the roster, the schedule, and the pending count all see the real state.
//  9. *The audit timeline is re-ordered here even though `api.ts` already orders it.* Requirement
//     17.7 fixes event time descending then stored insertion order descending. `orderedCancellation`
//     `Events` applies exactly that to whatever it is handed, so the ordering is a property of this
//     component rather than of the query that fed it, and an unreadable event time sorts last
//     instead of jumping to the top.
// 10. *Requirement 17.12's refusal is displayed in the endpoint's own words.* The route answers 422
//     with `code: 'no_eligible_contact'` and a message stating that valid authorized contact
//     information is required and that nothing was sent, nothing was recorded, and the case status
//     is unchanged. The drawer shows that message rather than a second copy of the sentence, and
//     reads the code only to point the reader at the contact section.
// 11. *The note composer belongs to the container.* Requirements 17.8 and 17.9 are task 16.12's, so
//     the notes section renders the stored notes and their evidence and hosts whatever composer the
//     container passes in. The drawer stores no note itself.

import {
  AlertTriangle,
  BellOff,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Download,
  ExternalLink,
  FileText,
  History,
  LoaderCircle,
  Mail,
  MessageSquare,
  Phone,
  RefreshCw,
  Send,
  ShieldCheck,
  Star,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import { ui } from '../nhwd-shared/ui';
import { addDays, currentBusinessDate } from '../renewals/derive';
import {
  calendarText,
  failureText,
  formatTimestamp,
  readableLabel,
  text,
  timeValue,
  wholeNumber,
} from '../renewals/format';
import {
  downloadEvidenceFile,
  evidenceDisplayName,
  getCancellationCase,
  getEvidenceUrl,
  listCancellationCommunications,
  listCancellationContacts,
  listCancellationEscalations,
  listCancellationEvents,
  listCancellationNotes,
  listCustomerResponses,
  listPaymentReports,
  listSuppressions,
  listVerificationOutcomes,
  type CancellationAssignee,
  type CancellationCaseDetail,
  type CancellationCommunication,
  type CancellationContact,
  type CancellationCustomerResponse,
  type CancellationEscalation,
  type CancellationEvent,
  type CancellationNote,
  type CancellationPaymentReport,
  type CancellationSettings,
  type CancellationSuppression,
  type CancellationVerificationOutcome,
} from './api';
import CancellationContactPanel, { type CancellationContactChange } from './CancellationContactPanel';
import CancellationPaymentReportPanel, {
  type CancellationPaymentReportChange,
} from './CancellationPaymentReport';
import CancellationVerificationPanel, {
  type CancellationVerificationChange,
} from './CancellationVerificationPanel';
import {
  EM_DASH,
  MANAGER_ONLY_ACTIONS,
  NEXT_REQUIRED_ACTIONS,
  cancellationRowCells,
  effectiveCalendarDate,
  isActionVisibleToRole,
  primaryAction,
  rowDaysRemaining,
  type CancellationRowState,
  type CaseStatus,
  type CommunicationStatus,
  type NextRequiredAction,
} from './derive';
import {
  deriveCommunicationStatus,
  pendingTouchpointChannelSends,
  type ScheduledSend,
} from './domain/communication-status';
import {
  SUPPRESSION_CHANNELS,
  eligibleContacts,
  type SuppressionChannel,
} from './domain/suppression';
import { TOUCHPOINTS, type Touchpoint } from './render/renderMessage';
// Type-only, so nothing from the scheduler reaches the browser bundle: `import type` is erased
// before bundling, and that module opens a service-role client (reading 5).
import type {
  ManualSendAction,
  ManualSendRejectionCode,
  ManualSendSummary,
} from './scheduler/manual-send';

// ---------------------------------------------------------------------------
// The nine controls (Requirements 17.3, 17.10)
// ---------------------------------------------------------------------------

/** Which part of the drawer performs a control's work. */
export type CancellationDrawerSection = 'contacts' | 'send' | 'payment' | 'verification';

/** One of the nine controls of Requirement 17.3, as data. */
export interface CancellationDrawerControl {
  /** The control's name, which is the action it performs — Requirement 17.3's own wording. */
  action: NextRequiredAction;
  /** True where Requirement 17.10 hides the control from Agent_Role. */
  managerOnly: boolean;
  /** The section the control activates. */
  section: CancellationDrawerSection;
  /** Set where activating the control itself sends; `null` where it opens a section instead. */
  sends: ManualSendAction | null;
  /** One sentence naming what happens on activation, for the control's own description. */
  hint: string;
}

/** One control resolved against a case and a role. */
export interface CancellationDrawerControlState extends CancellationDrawerControl {
  /** Requirement 17.10: shown to the signed-in profile. */
  visible: boolean;
  /** Requirement 17.4: the one visually prominent primary action. At most one is true. */
  prominent: boolean;
}

const CONTROL_SECTION: Record<NextRequiredAction, CancellationDrawerSection> = {
  'Add Contact Information': 'contacts',
  'Send Reminder Now': 'send',
  'Retry Failed Communication': 'send',
  'Call Customer': 'contacts',
  'Record Customer Response': 'contacts',
  'Verify Payment': 'verification',
  'Confirm Reinstatement': 'verification',
  'Confirm Cancellation': 'verification',
  'Mark Resolved': 'verification',
};

/** The two controls that send. Every other control opens the section that performs its write. */
const CONTROL_SEND: Partial<Record<NextRequiredAction, ManualSendAction>> = {
  'Send Reminder Now': 'send_now',
  'Retry Failed Communication': 'retry_failed',
};

const CONTROL_HINT: Record<NextRequiredAction, string> = {
  'Add Contact Information': 'Opens the contact information form.',
  'Send Reminder Now':
    'Sends the current touchpoint message to every valid, authorized, unsuppressed contact.',
  'Retry Failed Communication':
    'Re-sends only the contacts whose record for the current touchpoint failed.',
  'Call Customer': 'Opens the contact roster with the stored phone numbers.',
  'Record Customer Response': 'Opens the customer response form.',
  'Verify Payment': 'Opens the payment verification outcomes.',
  'Confirm Reinstatement': 'Opens the payment verification outcomes.',
  'Confirm Cancellation': 'Opens the payment verification outcomes.',
  'Mark Resolved': 'Opens Mark Resolved in the verification section.',
};

const MANAGER_ONLY_ACTION_SET: ReadonlySet<string> = new Set<string>(MANAGER_ONLY_ACTIONS);

/**
 * The nine controls in the order Requirement 17.3 lists them.
 *
 * The order is `NEXT_REQUIRED_ACTIONS` from `./domain/communication-status`, not a second list:
 * Requirement 17.3 and Requirement 16.9 name the same nine actions in the same order, so the
 * vocabulary is read from the one place that owns it.
 */
export const CANCELLATION_DRAWER_CONTROLS: readonly CancellationDrawerControl[] =
  NEXT_REQUIRED_ACTIONS.map((action) => ({
    action,
    managerOnly: MANAGER_ONLY_ACTION_SET.has(action),
    section: CONTROL_SECTION[action],
    sends: CONTROL_SEND[action] ?? null,
    hint: CONTROL_HINT[action],
  }));

/**
 * The nine controls resolved against one case and one role (Requirements 17.3, 17.4, 17.10).
 *
 * `visible` is `isActionVisibleToRole`, so the four manager-only controls are hidden from
 * `agent`, `customer_service`, and `sales_supervisor` and shown to `manager` and `super_admin`
 * alike. `prominent` marks the control whose action `primaryAction` returned — reading 1 — so at
 * most one control is prominent and a cleared next required action promotes none (reading 2).
 *
 * `role` overrides the role carried by the state bundle; omitted, the bundle's `viewerRole` is
 * used for both the visibility test and the ladder, so the two cannot disagree.
 */
export function cancellationDrawerControls(
  state: CancellationRowState,
  role?: AppRole | null,
): CancellationDrawerControlState[] {
  const viewerRole = role === undefined ? state.viewerRole ?? null : role;
  const primary = primaryAction(state, viewerRole);
  return CANCELLATION_DRAWER_CONTROLS.map((control) => {
    const visible = isActionVisibleToRole(control.action, viewerRole);
    return { ...control, visible, prominent: visible && control.action === primary };
  });
}

/** The controls the signed-in profile is shown, in Requirement 17.3 order. */
export function visibleCancellationDrawerControls(
  state: CancellationRowState,
  role?: AppRole | null,
): CancellationDrawerControlState[] {
  return cancellationDrawerControls(state, role).filter((control) => control.visible);
}

/** The one prominent control, or `null` where the next required action has been cleared. */
export function prominentCancellationDrawerControl(
  state: CancellationRowState,
  role?: AppRole | null,
): CancellationDrawerControlState | null {
  return cancellationDrawerControls(state, role).find((control) => control.prominent) ?? null;
}

// ---------------------------------------------------------------------------
// The audit timeline order (Requirement 17.7)
// ---------------------------------------------------------------------------

/**
 * Requirement 17.7's order over two entries: event time descending, then stored insertion order
 * descending so entries sharing an event time read latest-recorded-first.
 *
 * An unreadable or absent event time sorts after every readable one rather than comparing as zero,
 * which would place it at the end of time in one direction and the start in the other.
 */
export function compareCancellationEvents(a: CancellationEvent, b: CancellationEvent): number {
  const left = timeValue(a.event_time);
  const right = timeValue(b.event_time);
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  }
  return (b.sequence ?? 0) - (a.sequence ?? 0);
}

/** The audit timeline in the Requirement 17.7 order, as a new array (reading 9). */
export function orderedCancellationEvents(
  events: readonly CancellationEvent[],
): CancellationEvent[] {
  return [...events].sort(compareCancellationEvents);
}

/** Stored Communication_Record rows most recent first, insertion order breaking a tie (Req 17.1). */
export function orderedCancellationCommunications(
  rows: readonly CancellationCommunication[],
): CancellationCommunication[] {
  return [...rows].sort((a, b) => {
    const left = timeValue(a.send_time);
    const right = timeValue(b.send_time);
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    }
    const created = (timeValue(b.created_at) ?? 0) - (timeValue(a.created_at) ?? 0);
    return created;
  });
}

// ---------------------------------------------------------------------------
// The Touchpoint schedule (Requirements 12.1, 12.2, 17.1)
// ---------------------------------------------------------------------------

/** One channel of one Touchpoint in the schedule. */
export interface TouchpointChannelState {
  channel: SuppressionChannel;
  /** True where Requirement 12.2 schedules this pair: date not passed, channel has a recipient. */
  scheduled: boolean;
  /** Stored Communication_Record rows for this Touchpoint and channel. */
  records: number;
  /** The pair's send state, by the shared status derivation (reading 6). */
  state: CommunicationStatus;
}

/** One of the four Touchpoints with its scheduled date and its per-channel send state. */
export interface TouchpointScheduleRow {
  touchpoint: Touchpoint;
  /** `YYYY-MM-DD`, or `null` where the cancellation effective date is absent or unreadable. */
  scheduledDate: string | null;
  /** True where the scheduled date is earlier than the business date, so it will not be sent. */
  passed: boolean;
  channels: TouchpointChannelState[];
}

const sendKey = (touchpoint: Touchpoint, channel: SuppressionChannel): string =>
  `${touchpoint}|${channel}`;

/**
 * The Touchpoint and channel pairs scheduled for one case, or `null` where the schedule cannot be
 * derived because no cancellation effective date is readable (readings 5 and 7).
 *
 * A pair is scheduled where its date has not passed and the channel has at least one eligible
 * Contact_Recipient — valid, authorization permitting contact, and not suppressed on that channel,
 * which `domain/suppression.eligibleContacts` decides for the send path too. A passed Touchpoint is
 * excluded because Requirement 12.8 will never send it, and calling it pending would hold the case
 * at Partially Sent forever.
 */
export function cancellationScheduledSends(
  caseRow: Pick<CancellationCaseDetail, 'cancellation_effective_date'>,
  contacts: readonly CancellationContact[],
  suppressions: readonly CancellationSuppression[],
  businessDate: string,
): ScheduledSend[] | null {
  const effective = effectiveCalendarDate(caseRow);
  if (effective === null || businessDate.trim() === '') return null;
  const active = suppressions.filter((row) => row.cleared_at === null || row.cleared_at === undefined);

  const sends: ScheduledSend[] = [];
  for (const touchpoint of TOUCHPOINTS) {
    if (addDays(effective, -touchpoint) < businessDate) continue;
    for (const channel of SUPPRESSION_CHANNELS) {
      if (eligibleContacts(contacts, active, channel).length === 0) continue;
      sends.push({ touchpoint, channel });
    }
  }
  return sends;
}

/**
 * The four Touchpoints with their scheduled dates and per-channel send state (Requirement 17.1).
 * Every value comes from the state bundle the row cells were derived from, so the schedule and the
 * SMS and email status cells are two readings of the same facts.
 */
export function cancellationTouchpointSchedule(
  state: CancellationRowState,
): TouchpointScheduleRow[] {
  const effective = effectiveCalendarDate(state.case);
  const businessDate = (state.businessDate ?? '').trim();
  const communications = state.communications ?? [];
  const scheduled = new Set<string>(
    (state.scheduledSends ?? []).map((send) => sendKey(send.touchpoint, send.channel)),
  );

  return TOUCHPOINTS.map((touchpoint) => {
    const scheduledDate = effective === null ? null : addDays(effective, -touchpoint);
    return {
      touchpoint,
      scheduledDate,
      passed: scheduledDate !== null && businessDate !== '' && scheduledDate < businessDate,
      channels: SUPPRESSION_CHANNELS.map((channel) => {
        const records = communications.filter(
          (row) => row.touchpoint === touchpoint && row.channel === channel,
        );
        const isScheduled = scheduled.has(sendKey(touchpoint, channel));
        const pending: ScheduledSend[] =
          isScheduled && records.length === 0 ? [{ touchpoint, channel }] : [];
        return {
          channel,
          scheduled: isScheduled,
          records: records.length,
          state: deriveCommunicationStatus(state.case, [], records, pending, [], []),
        };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Combined multi-policy coverage (Requirement 13.8)
// ---------------------------------------------------------------------------

/**
 * The coverage line of a combined message, or `null` for a message that covered one policy.
 *
 * `coveredCaseIds` is joined through `cancellation_communication_cases` and carries this case, so
 * the same sentence comes out of any Cancellation_Case in the group. It names the covered cases the
 * signed-in profile MAY READ: the link table carries the read scope of the cases it points at, so a
 * group reaching outside that scope reports a shorter count rather than leaking a case
 * (Requirement 22.1).
 */
export function combinedCoverageText(
  coveredCaseIds: readonly string[] | null | undefined,
): string | null {
  const count = new Set(coveredCaseIds ?? []).size;
  return count > 1 ? `This notice covers ${count} policies` : null;
}

// ---------------------------------------------------------------------------
// The manual send report (Requirements 17.5, 17.11, 17.12)
// ---------------------------------------------------------------------------

/** `POST /api/cancellations/send` answers one of these two bodies. */
type ManualSendResponse =
  | { success: true; summary: ManualSendSummary }
  | { error: string; code?: ManualSendRejectionCode };

const SEND_ENDPOINT = '/api/cancellations/send';

/** Requirement 17.12 arrives as HTTP 422 carrying this code. */
const NO_ELIGIBLE_CONTACT_CODE: ManualSendRejectionCode = 'no_eligible_contact';

/** Named when the request itself failed, so the endpoint's own wording never arrived. */
const SEND_FAILURE = 'The send could not be completed.';

const SEND_ACTION_LABEL: Record<ManualSendAction, NextRequiredAction> = {
  send_now: 'Send Reminder Now',
  retry_failed: 'Retry Failed Communication',
};

/**
 * Requirement 17.5's report: the count of recipients sent, the count skipped, and the count
 * failed, with Requirement 17.11's indication that the current Touchpoint was already sent for the
 * keys skipped for that reason.
 */
export function manualSendNotice(summary: ManualSendSummary): string {
  const { sent, skipped, failed } = summary.counts;
  const already =
    summary.alreadySent > 0
      ? ` ${summary.alreadySent} of the skipped ${
          summary.alreadySent === 1 ? 'recipient was' : 'recipients were'
        } already sent the ${summary.touchpoint}-day touchpoint.`
      : '';
  return `${SEND_ACTION_LABEL[summary.action]} for the ${summary.touchpoint}-day touchpoint: ${sent} sent, ${skipped} skipped, ${failed} failed.${already}`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** What one successful write in the drawer changed, for the container's refresh. */
export interface CancellationDrawerChange {
  caseId: string;
  /** Which hosted surface performed the write. */
  source: 'contact' | 'payment' | 'verification' | 'send';
  /** Every case whose stored state the write touched; an opt-out spans more than this one. */
  affectedCaseIds: string[];
  /** Requirements 20.4, 20.6, 20.10: the container owes those cases an escalation evaluation. */
  escalationReevaluationDue: boolean;
}

export interface CancellationDrawerProps {
  /** `cancellation_cases.id` of the selected case. Nothing renders while it is `null`. */
  caseId: string | null;
  /**
   * The current business date as `YYYY-MM-DD`, computed once per container render pass. Blank text
   * falls back to the agency-local calendar date now, matching `../renewals/RenewalDrawer`.
   */
  businessDate: string;
  /**
   * The signed-in profile's role. `null` reads as the unrestricted Manager_Role view, matching
   * `derive.isActionVisibleToRole`; row level security remains the authorization boundary.
   */
  role?: AppRole | null;
  /** Employees, for the assigned-employee name and the audit timeline actor names. */
  assignees?: readonly CancellationAssignee[];
  /** The `cancellation_settings` row, for the business-day counts the two panels apply. */
  settings?: Pick<CancellationSettings, 'holidays'> | null;
  /** The container's note composer (Requirements 17.8, 17.9 belong to task 16.12) — reading 11. */
  noteComposer?: React.ReactNode;
  onClose: () => void;
  /** Raised after every successful write so the list refreshes; the drawer stays open. */
  onCaseChanged?: (change: CancellationDrawerChange) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Detail state
// ---------------------------------------------------------------------------

/** Every read of one case, plus the case id they belong to, so a stale selection never renders. */
interface DrawerDetail {
  key: string;
  caseRow: CancellationCaseDetail | null;
  contacts: CancellationContact[];
  communications: CancellationCommunication[];
  events: CancellationEvent[];
  notes: CancellationNote[];
  responses: CancellationCustomerResponse[];
  paymentReports: CancellationPaymentReport[];
  outcomes: CancellationVerificationOutcome[];
  escalations: CancellationEscalation[];
  suppressions: CancellationSuppression[];
}

/**
 * What the drawer has to say about the last thing that happened: the success notice of a write, the
 * report of a manual send (Requirements 17.5, 17.11), and a refusal (Requirement 17.12). Held as one
 * value keyed by the selected case, so nothing carries over to another cancellation.
 */
interface DrawerFeedback {
  notice: string | null;
  summary: ManualSendSummary | null;
  error: { message: string; code: string | null } | null;
}

const BLANK_FEEDBACK: DrawerFeedback = { notice: null, summary: null, error: null };

const BLANK_DETAIL: DrawerDetail = {
  key: '',
  caseRow: null,
  contacts: [],
  communications: [],
  events: [],
  notes: [],
  responses: [],
  paymentReports: [],
  outcomes: [],
  escalations: [],
  suppressions: [],
};

const LOAD_FAILURE = 'Could not load this cancellation.';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

/**
 * Every detail read of one case. The nine case-scoped reads run together; the suppression read
 * follows because it is keyed by the contact values the first wave returned (reading 8).
 */
async function fetchDetail(caseId: string): Promise<DrawerDetail> {
  const [
    caseRow,
    contacts,
    communications,
    events,
    notes,
    responses,
    paymentReports,
    outcomes,
    escalations,
  ] = await Promise.all([
    getCancellationCase(caseId),
    listCancellationContacts(caseId),
    listCancellationCommunications(caseId),
    listCancellationEvents(caseId),
    listCancellationNotes(caseId),
    listCustomerResponses(caseId),
    listPaymentReports(caseId),
    listVerificationOutcomes(caseId),
    listCancellationEscalations(caseId),
  ]);

  const values = [...new Set(contacts.map((contact) => contact.normalized_value))];
  const suppressions = await listSuppressions(values);

  return {
    key: caseId,
    caseRow,
    contacts,
    communications,
    events,
    notes,
    responses,
    paymentReports,
    outcomes,
    escalations,
    suppressions,
  };
}

// ---------------------------------------------------------------------------
// Small presentation helpers
// ---------------------------------------------------------------------------

const CASE_STATUS_TONE: Record<CaseStatus, string> = {
  Imported: 'neutral',
  Open: 'info',
  'Payment Reported': 'progress',
  'Verification Pending': 'progress',
  'Reinstatement Pending': 'violet',
  Reinstated: 'success',
  Cancelled: 'danger',
  Resolved: 'success',
  Invalid: 'neutral',
  Duplicate: 'neutral',
};

const COMMUNICATION_STATUS_TONE: Record<CommunicationStatus, string> = {
  'Not Scheduled': 'neutral',
  Scheduled: 'info',
  'Partially Sent': 'progress',
  Sent: 'cyan',
  Delivered: 'success',
  'Partially Failed': 'danger',
  Failed: 'danger',
  Suppressed: 'violet',
  'Manual Follow-up Required': 'danger',
};

const DELIVERY_TONE: Record<string, string> = {
  Sent: 'cyan',
  Delivered: 'success',
  Failed: 'danger',
};

const CHANNEL_LABEL: Record<SuppressionChannel, string> = { sms: 'SMS', email: 'Email' };

/** A badge carrying its value as text, so no state is expressed by colour alone. */
function badge(tone: string, label: string) {
  return <span className={`${ui.badge} ${ui.badgeTone[tone] ?? ui.badgeTone.neutral}`}>{label}</span>;
}

/** A stored timestamp as readable text, with an em dash where it is absent or unreadable. */
function whenText(value: string | null | undefined): string {
  return formatTimestamp(value) ?? EM_DASH;
}

/** At most eight `detail` entries of one audit entry, as label and value pairs. */
function detailEntries(detail: Record<string, unknown> | null): [string, string][] {
  if (detail === null) return [];
  return Object.entries(detail)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .slice(0, 8)
    .map(([key, value]) => [readableLabel(key), text(value)]);
}

/** `2 policies` / `1 policy`, for the counts in this drawer's own sentences. */
function countText(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------
// Evidence (Requirements 17.9, 18.10, 19.9)
// ---------------------------------------------------------------------------

/**
 * The stored evidence of one note, payment report, or verification outcome.
 *
 * The bucket is private, so a file leaves storage either as a download through
 * `downloadEvidenceFile` or behind a short-lived signed URL from `getEvidenceUrl`. No public URL is
 * ever produced here (Requirement 22.7).
 */
function EvidenceFiles({ paths, disabled = false }: { paths: readonly string[]; disabled?: boolean }) {
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (paths.length === 0) return null;

  async function run(path: string, task: () => Promise<void>, operation: string): Promise<void> {
    setBusyPath(path);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(failureText(caught, operation));
    } finally {
      setBusyPath(null);
    }
  }

  return (
    <div className="mt-2">
      <ul className="flex flex-wrap gap-2">
        {paths.map((path) => (
          <li
            key={path}
            className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5"
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="max-w-[14rem] truncate text-xs font-bold text-slate-700">
              {evidenceDisplayName(path)}
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1 text-xs font-black text-[#223f7a] transition hover:underline disabled:opacity-40"
              disabled={disabled || busyPath !== null}
              aria-label={`Download ${evidenceDisplayName(path)}`}
              onClick={() =>
                void run(
                  path,
                  () => downloadEvidenceFile(path),
                  'Could not download the evidence file.',
                )
              }
            >
              {busyPath === path ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Download
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1 text-xs font-black text-[#223f7a] transition hover:underline disabled:opacity-40"
              disabled={disabled || busyPath !== null}
              aria-label={`Open ${evidenceDisplayName(path)} in a new tab`}
              onClick={() =>
                void run(
                  path,
                  async () => {
                    const url = await getEvidenceUrl(path);
                    if (url === null) throw new Error('Storage returned no link for that file.');
                    window.open(url, '_blank', 'noopener,noreferrer');
                  },
                  'Could not open the evidence file.',
                )
              }
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Open
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mt-2 flex gap-1.5 text-xs font-bold text-rose-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CancellationDrawer({
  caseId,
  businessDate,
  role = null,
  assignees = [],
  settings = null,
  noteComposer,
  onClose,
  onCaseChanged,
}: CancellationDrawerProps) {
  const titleId = useId();
  const primaryNoteId = useId();
  const baseId = useId();

  const [detail, setDetail] = useState<DrawerDetail>(BLANK_DETAIL);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedbackState, setFeedbackState] = useState<{ key: string; feedback: DrawerFeedback } | null>(
    null,
  );

  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<Element | null>(null);
  const sectionRefs = useRef<Record<CancellationDrawerSection, HTMLElement | null>>({
    contacts: null,
    send: null,
    payment: null,
    verification: null,
  });

  const today = businessDate.trim() || currentBusinessDate();

  // The success notice and the send report are keyed by the selection, exactly as
  // `../renewals/RenewalDrawer` keys its form state: a new selection starts from a blank report
  // without an effect resetting anything, and a report survives the refresh that follows its write.
  const feedbackKey = caseId ?? '';
  const feedback = feedbackState?.key === feedbackKey ? feedbackState.feedback : BLANK_FEEDBACK;
  const setFeedback = useCallback(
    (next: DrawerFeedback) => setFeedbackState({ key: feedbackKey, feedback: next }),
    [feedbackKey],
  );

  // Detail rows are keyed by the selection, so the previous case's activity never renders against a
  // new one; the loading indicator takes its place instead.
  const fresh = detail.key === (caseId ?? '');
  const loading = Boolean(caseId) && (refreshing || !fresh);

  const loadDetail = useCallback(async () => {
    if (caseId === null) return;
    setRefreshing(true);
    try {
      setDetail(await fetchDetail(caseId));
      setLoadError(null);
    } catch (caught) {
      setLoadError(failureText(caught, LOAD_FAILURE));
    } finally {
      setRefreshing(false);
    }
  }, [caseId]);

  useEffect(() => {
    if (caseId === null) return undefined;
    let live = true;
    void fetchDetail(caseId).then(
      (loaded) => {
        if (!live) return;
        setDetail(loaded);
        setLoadError(null);
      },
      (caught: unknown) => {
        if (live) setLoadError(failureText(caught, LOAD_FAILURE));
      },
    );
    return () => {
      live = false;
    };
  }, [caseId]);

  // Focus moves into the drawer on open and returns to the triggering element on close.
  useEffect(() => {
    if (caseId === null) return undefined;
    triggerRef.current = document.activeElement;
    panelRef.current?.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement && document.body.contains(trigger)) trigger.focus();
    };
  }, [caseId]);

  const actorNames = useMemo(
    () => new Map(assignees.map((one) => [one.id, one.display_name])),
    [assignees],
  );

  const raiseChange = useCallback(
    async (change: Omit<CancellationDrawerChange, 'caseId'>) => {
      if (caseId === null) return;
      await loadDetail();
      await onCaseChanged?.({ caseId, ...change });
    },
    [caseId, loadDetail, onCaseChanged],
  );

  const activate = useCallback((section: CancellationDrawerSection) => {
    const node = sectionRefs.current[section];
    if (node === null) return;
    node.scrollIntoView({ block: 'start' });
    node.focus();
  }, []);

  const runManualSend = useCallback(
    async (action: ManualSendAction) => {
      if (caseId === null) return;
      setBusy(true);
      setFeedback(BLANK_FEEDBACK);
      try {
        const response = await fetch(SEND_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ caseId, action }),
        });
        const payload = (await response.json().catch(() => null)) as ManualSendResponse | null;

        if (payload !== null && 'success' in payload && response.ok) {
          setFeedback({
            notice: manualSendNotice(payload.summary),
            summary: payload.summary,
            error: null,
          });
          await raiseChange({
            source: 'send',
            affectedCaseIds: [caseId],
            escalationReevaluationDue: true,
          });
          return;
        }

        // Reading 10: the endpoint's own sentence is displayed, including Requirement 17.12's.
        setFeedback({
          notice: null,
          summary: null,
          error: {
            message:
              payload !== null && 'error' in payload
                ? payload.error
                : `${SEND_FAILURE} The server answered ${response.status}.`,
            code: payload !== null && 'code' in payload ? payload.code ?? null : null,
          },
        });
      } catch (caught) {
        setFeedback({
          notice: null,
          summary: null,
          error: { message: failureText(caught, SEND_FAILURE), code: null },
        });
      } finally {
        setBusy(false);
      }
    },
    [caseId, raiseChange, setFeedback],
  );

  const onContactChanged = useCallback(
    async (change: CancellationContactChange) => {
      await raiseChange({
        source: 'contact',
        affectedCaseIds: change.affectedCaseIds,
        escalationReevaluationDue: change.escalationReevaluationDue,
      });
    },
    [raiseChange],
  );

  const onPaymentChanged = useCallback(
    async (change: CancellationPaymentReportChange) => {
      await raiseChange({
        source: 'payment',
        affectedCaseIds: [change.caseId],
        escalationReevaluationDue: change.escalationReevaluationDue,
      });
    },
    [raiseChange],
  );

  const onVerificationChanged = useCallback(
    async (change: CancellationVerificationChange) => {
      await raiseChange({
        source: 'verification',
        affectedCaseIds: [change.caseId],
        escalationReevaluationDue: change.escalationReevaluationDue,
      });
    },
    [raiseChange],
  );

  if (caseId === null) return null;

  const caseRow = fresh ? detail.caseRow : null;
  const contacts = fresh ? detail.contacts : BLANK_DETAIL.contacts;
  const communications = fresh ? detail.communications : BLANK_DETAIL.communications;
  const events = fresh ? detail.events : BLANK_DETAIL.events;
  const notes = fresh ? detail.notes : BLANK_DETAIL.notes;
  const responses = fresh ? detail.responses : BLANK_DETAIL.responses;
  const paymentReports = fresh ? detail.paymentReports : BLANK_DETAIL.paymentReports;
  const outcomes = fresh ? detail.outcomes : BLANK_DETAIL.outcomes;
  const escalations = fresh ? detail.escalations : BLANK_DETAIL.escalations;
  const suppressions = fresh ? detail.suppressions : BLANK_DETAIL.suppressions;

  const assignedEmployee =
    caseRow?.assigned_to === null || caseRow?.assigned_to === undefined
      ? null
      : assignees.find((one) => one.id === caseRow.assigned_to) ?? null;

  // Requirements 12.1, 12.2, 15.3: the schedule and the pending count, or `null` and `undefined`
  // where no effective date is readable — readings 5 and 7.
  const scheduledSends =
    caseRow === null ? null : cancellationScheduledSends(caseRow, contacts, suppressions, today);
  const pendingSends =
    scheduledSends === null
      ? undefined
      : pendingTouchpointChannelSends(scheduledSends, communications).length;

  // One state bundle, so every value on screen is derived from the same facts as the list row.
  const rowState: CancellationRowState | null =
    caseRow === null
      ? null
      : {
          case: caseRow,
          contacts,
          communications,
          scheduledSends: scheduledSends ?? [],
          escalations,
          responses,
          suppressions,
          businessDate: today,
          assignedEmployee,
          viewerRole: role,
        };

  const cells = rowState === null ? null : cancellationRowCells(rowState);
  const controls = rowState === null ? [] : visibleCancellationDrawerControls(rowState, role);
  const prominent = controls.find((control) => control.prominent) ?? null;
  const schedule = rowState === null ? [] : cancellationTouchpointSchedule(rowState);
  const timeline = orderedCancellationEvents(events);
  const openEscalations = escalations.filter((row) => row.cleared_at === null);

  const smsHistory = orderedCancellationCommunications(
    communications.filter((row) => row.channel === 'sms'),
  );
  const emailHistory = orderedCancellationCommunications(
    communications.filter((row) => row.channel === 'email'),
  );

  const preferredLanguages = [
    ...new Set(
      contacts
        .map((contact) => contact.preferred_language)
        .filter((language): language is NonNullable<typeof language> => language !== null),
    ),
  ];

  const phoneContacts = contacts.filter(
    (contact) => contact.channel === 'phone' && contact.validation_status === 'valid',
  );

  const manager = isBroadManagerRole(role ?? 'manager');
  const locked = busy || loading;

  const summaryFields: readonly [string, string][] =
    cells === null || rowState === null
      ? []
      : [
          ['Carrier', cells.carrier],
          ['Cancellation effective date', calendarText(cells.cancellationEffectiveDate)],
          ['Days remaining', wholeNumber(rowDaysRemaining(rowState))],
          ['Cancellation reason', cells.cancellationReason],
          ['Amount due', cells.amountDue],
          ['Assigned employee', cells.assignedEmployee],
          ['Preferred language', preferredLanguages.join(', ') || EM_DASH],
          ['SMS status', cells.smsStatus],
          ['Email status', cells.emailStatus],
          ['Last contact', calendarText(cells.lastContact, true)],
          ['Case status', cells.caseStatus],
          ['Communication status', caseRow?.communication_status ?? EM_DASH],
          ['Next required action', cells.nextRequiredAction],
          ['Follow-up deadline', calendarText(caseRow?.follow_up_deadline, true)],
        ];

  /** Escape closes the drawer; Tab cycles inside it, so focus never leaves while it is open. */
  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    const stops = panel
      ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (node) => node.offsetParent !== null,
        )
      : [];
    if (stops.length === 0) return;
    const [first] = stops;
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapFocus}
        onMouseDown={(event) => event.stopPropagation()}
        className="ml-auto h-full w-full max-w-4xl overflow-y-auto bg-[#f3f5f9] shadow-2xl outline-none"
      >
        <div className="sticky top-0 z-20 flex items-start justify-between gap-3 border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur">
          <div>
            <p className="text-xs font-black tracking-[0.15em] text-[#223f7a] uppercase">
              Cancellation case
            </p>
            <h2 id={titleId} className="text-lg font-black text-slate-950">
              {cells === null ? 'Cancellation' : cells.customerName} · Policy{' '}
              {cells === null ? EM_DASH : cells.policyNumber}
            </h2>
          </div>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              className={ui.btnGhost}
              disabled={loading}
              onClick={() => void loadDetail()}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Refresh
            </button>
            <button
              type="button"
              className={ui.btnGhost}
              onClick={onClose}
              aria-label="Close the cancellation drawer"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              Close
            </button>
          </div>
        </div>

        <div className="space-y-5 p-4 sm:p-6">
          {loadError ? (
            <p role="alert" className={`${ui.error} flex gap-2`}>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{loadError}</span>
            </p>
          ) : null}
          <p aria-live="polite" className="sr-only">
            {feedback.notice ?? ''}
          </p>
          {feedback.notice ? <p className={ui.success}>{feedback.notice}</p> : null}

          {loading && caseRow === null ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-6 py-12 text-sm font-bold text-slate-500"
            >
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading this cancellation…
            </div>
          ) : null}

          {caseRow === null || cells === null || rowState === null ? (
            loading ? null : (
              <p className={ui.empty}>This cancellation is no longer available to you.</p>
            )
          ) : (
            <>
              {/* ---------------------------------------------------------------
                  Summary (Requirement 17.1)
                  --------------------------------------------------------------- */}
              <section className={`${ui.card} ${ui.cardPad}`}>
                <div className="flex flex-wrap items-center gap-2">
                  {badge(CASE_STATUS_TONE[caseRow.case_status], caseRow.case_status)}
                  {badge(
                    COMMUNICATION_STATUS_TONE[caseRow.communication_status],
                    caseRow.communication_status,
                  )}
                  {badge('info', `Next action: ${cells.nextRequiredAction}`)}
                  {caseRow.assistance_requested ? badge('progress', 'Assistance requested') : null}
                  {openEscalations.map((row) => (
                    <span key={row.id} className={`${ui.badge} ${ui.badgeTone.danger}`}>
                      {row.reason}
                    </span>
                  ))}
                </div>
                <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {summaryFields.map(([label, value]) => (
                    <div key={label} className="rounded-2xl bg-slate-50 px-3 py-2.5">
                      <dt className="text-[10px] font-black tracking-wider text-slate-400 uppercase">
                        {label}
                      </dt>
                      <dd
                        className={`mt-1 text-sm font-black break-words ${
                          value === EM_DASH ? 'text-slate-400' : 'text-slate-900'
                        }`}
                      >
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>

              {/* ---------------------------------------------------------------
                  The nine controls (Requirements 17.3, 17.4, 17.10)
                  --------------------------------------------------------------- */}
              <section
                ref={(node) => {
                  sectionRefs.current.send = node;
                }}
                tabIndex={-1}
                aria-labelledby={`${baseId}-actions`}
                className={`${ui.card} ${ui.cardPad} outline-none`}
              >
                <p id={`${baseId}-actions`} className={ui.sectionTitle}>
                  Actions
                </p>
                <p id={primaryNoteId} className="mt-2 text-sm font-semibold text-slate-500">
                  {prominent === null
                    ? 'This cancellation has no required action, so no action is recommended. Every control below stays available.'
                    : `Recommended next action: ${prominent.action}. ${prominent.hint}`}
                </p>

                <ul className="mt-4 flex flex-wrap gap-2">
                  {controls.map((control) => (
                    <li key={control.action}>
                      <button
                        type="button"
                        data-action={control.action}
                        data-prominent={control.prominent ? 'true' : 'false'}
                        aria-describedby={control.prominent ? primaryNoteId : undefined}
                        className={control.prominent ? ui.btnPrimary : ui.btnSecondary}
                        disabled={locked}
                        onClick={() =>
                          control.sends === null
                            ? activate(control.section)
                            : void runManualSend(control.sends)
                        }
                      >
                        {/* Reading 3: the promoted control is marked by a glyph and by words, not
                            by its fill alone. */}
                        {control.prominent ? (
                          <Star className="h-4 w-4 shrink-0" aria-hidden="true" />
                        ) : control.sends !== null ? (
                          <Send className="h-4 w-4 shrink-0" aria-hidden="true" />
                        ) : (
                          <ClipboardList className="h-4 w-4 shrink-0" aria-hidden="true" />
                        )}
                        {control.action}
                        {control.prominent ? (
                          <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-black tracking-wider uppercase">
                            Do this next
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>

                {manager ? null : (
                  <p className="mt-3 text-xs font-semibold text-slate-500">
                    Verify Payment, Confirm Reinstatement, Confirm Cancellation, and Retry Failed
                    Communication are reserved to a manager or super admin and are not shown here.
                  </p>
                )}

                {feedback.error ? (
                  <div className={`${ui.error} mt-4 flex gap-2`} role="alert">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>
                      {feedback.error.message}
                      {feedback.error.code === NO_ELIGIBLE_CONTACT_CODE ? (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="font-black underline"
                            onClick={() => activate('contacts')}
                          >
                            Add or correct the contact information
                          </button>
                          .
                        </>
                      ) : null}
                    </span>
                  </div>
                ) : null}

                {feedback.summary ? (
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-sm font-black text-slate-900">
                      {manualSendNotice(feedback.summary)}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">
                      Eligible recipients: {feedback.summary.eligibleContacts.sms} SMS,{' '}
                      {feedback.summary.eligibleContacts.email} email. Rows written{' '}
                      {feedback.summary.communicationRowsWritten}, rows updated{' '}
                      {feedback.summary.communicationRowsUpdated}.
                    </p>
                    {feedback.summary.keys.length > 0 ? (
                      <ul className="mt-2 space-y-1">
                        {feedback.summary.keys.map((key) => (
                          <li
                            key={`${key.contactId}-${key.channel}`}
                            className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-600"
                          >
                            {badge(
                              key.status === 'sent'
                                ? 'success'
                                : key.status === 'failed'
                                  ? 'danger'
                                  : 'neutral',
                              key.status,
                            )}
                            <span className="font-black">{CHANNEL_LABEL[key.channel]}</span>
                            <span>{key.recipient}</span>
                            {key.reason === null ? null : <span>{readableLabel(key.reason)}</span>}
                            {key.failureReason === null ? null : (
                              <span className="text-rose-700">{key.failureReason}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {feedback.summary.failures.length > 0 ? (
                      <ul className="mt-2 space-y-1">
                        {feedback.summary.failures.map((failure, index) => (
                          <li
                            key={`${failure.stage}-${index}`}
                            className="text-xs font-bold text-rose-700"
                          >
                            {readableLabel(failure.stage)}: {failure.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </section>

              {/* ---------------------------------------------------------------
                  The Touchpoint schedule (Requirement 17.1)
                  --------------------------------------------------------------- */}
              <section className={`${ui.card} ${ui.cardPad}`}>
                <p className={ui.sectionTitle}>Touchpoint schedule</p>
                <p className="mt-2 text-sm font-semibold text-slate-500">
                  Each touchpoint is scheduled for the calendar date that many days before the
                  cancellation effective date. A channel is scheduled only where it has at least one
                  valid, authorized, unsuppressed contact.
                  {pendingSends === undefined
                    ? ' This cancellation carries no readable effective date, so no schedule can be derived.'
                    : ` ${countText(pendingSends, 'pending send', 'pending sends')}.`}
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className={ui.table}>
                    <thead>
                      <tr>
                        <th scope="col" className={ui.th}>
                          Touchpoint
                        </th>
                        <th scope="col" className={ui.th}>
                          Scheduled date
                        </th>
                        <th scope="col" className={ui.th}>
                          SMS
                        </th>
                        <th scope="col" className={ui.th}>
                          Email
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {schedule.map((row) => (
                        <tr key={row.touchpoint}>
                          <td className={`${ui.td} font-black whitespace-nowrap text-slate-900`}>
                            {row.touchpoint} days before
                            {row.passed ? (
                              <span className="ml-2 text-[10px] font-black tracking-wider text-slate-400 uppercase">
                                Passed
                              </span>
                            ) : null}
                          </td>
                          <td className={`${ui.td} whitespace-nowrap`}>
                            {calendarText(row.scheduledDate)}
                          </td>
                          {row.channels.map((channel) => (
                            <td key={channel.channel} className={ui.td}>
                              <span className="flex flex-wrap items-center gap-1.5">
                                {badge(COMMUNICATION_STATUS_TONE[channel.state], channel.state)}
                                <span className="text-xs font-semibold text-slate-500">
                                  {countText(channel.records, 'record', 'records')}
                                </span>
                              </span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* ---------------------------------------------------------------
                  Contact roster (Requirement 17.2) — reading 4
                  --------------------------------------------------------------- */}
              <section
                ref={(node) => {
                  sectionRefs.current.contacts = node;
                }}
                tabIndex={-1}
                aria-labelledby={`${baseId}-contacts`}
                className={`${ui.card} ${ui.cardPad} outline-none`}
              >
                <p id={`${baseId}-contacts`} className={ui.sectionTitle}>
                  Contact recipients
                </p>
                {contacts.length === 0 ? (
                  <p className={`${ui.empty} mt-3`}>
                    This cancellation has no contact information, so no reminder can reach the
                    customer.
                  </p>
                ) : (
                  <div className="mt-3 overflow-x-auto">
                    <table className={ui.table}>
                      <thead>
                        <tr>
                          <th scope="col" className={ui.th}>
                            Channel
                          </th>
                          <th scope="col" className={ui.th}>
                            Stored value
                          </th>
                          <th scope="col" className={ui.th}>
                            Validation
                          </th>
                          <th scope="col" className={ui.th}>
                            SMS suppression
                          </th>
                          <th scope="col" className={ui.th}>
                            Email suppression
                          </th>
                          <th scope="col" className={ui.th}>
                            Authorization
                          </th>
                          <th scope="col" className={ui.th}>
                            Primary
                          </th>
                          <th scope="col" className={ui.th}>
                            Preferred language
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {contacts.map((contact) => (
                          <tr key={contact.id}>
                            <td className={`${ui.td} whitespace-nowrap`}>
                              <span className="flex items-center gap-1.5 font-black text-slate-900">
                                {contact.channel === 'phone' ? (
                                  <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                                ) : (
                                  <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                                )}
                                {contact.channel === 'phone' ? 'Phone' : 'Email'}
                              </span>
                            </td>
                            <td className={`${ui.td} font-semibold whitespace-nowrap`}>
                              {contact.channel === 'phone' ? (
                                <a
                                  href={`tel:${contact.normalized_value}`}
                                  className="font-black text-[#223f7a] underline-offset-2 hover:underline"
                                >
                                  {contact.normalized_value}
                                </a>
                              ) : (
                                <a
                                  href={`mailto:${contact.normalized_value}`}
                                  className="font-black text-[#223f7a] underline-offset-2 hover:underline"
                                >
                                  {contact.normalized_value}
                                </a>
                              )}
                            </td>
                            <td className={ui.td}>
                              {badge(
                                contact.validation_status === 'valid' ? 'success' : 'danger',
                                contact.validation_status,
                              )}
                            </td>
                            <td className={ui.td}>
                              {badge(
                                contact.sms_suppressed ? 'danger' : 'neutral',
                                contact.sms_suppressed ? 'Opted out' : 'Not opted out',
                              )}
                            </td>
                            <td className={ui.td}>
                              {badge(
                                contact.email_suppressed ? 'danger' : 'neutral',
                                contact.email_suppressed ? 'Opted out' : 'Not opted out',
                              )}
                            </td>
                            <td className={ui.td}>
                              {badge(
                                contact.authorization_status === 'Not Authorized'
                                  ? 'danger'
                                  : contact.authorization_status === 'Authorized'
                                    ? 'success'
                                    : 'progress',
                                contact.authorization_status,
                              )}
                            </td>
                            <td className={ui.td}>
                              {badge('neutral', contact.is_primary ? 'Primary' : 'Non-primary')}
                            </td>
                            <td className={ui.td}>
                              {badge('info', contact.preferred_language ?? 'Not set')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {phoneContacts.length > 0 ? (
                  <p className="mt-3 text-xs font-semibold text-slate-500">
                    Call Customer opens this roster; the stored phone numbers above are dialable
                    links.
                  </p>
                ) : null}
              </section>

              {/* The contact, preferred-language, authorization, opt-out, and customer-response
                  writes, all of them the contact panel's (task 16.8). */}
              <CancellationContactPanel
                caseId={caseRow.id}
                contacts={contacts}
                role={role}
                pendingSendsForCase={(id) => (id === caseRow.id ? pendingSends : undefined)}
                onChanged={onContactChanged}
                disabled={locked}
              />

              {/* ---------------------------------------------------------------
                  Delivery history (Requirement 17.1) with the combined-message
                  coverage of Requirement 13.8
                  --------------------------------------------------------------- */}
              <section className={`${ui.card} ${ui.cardPad} grid gap-5 lg:grid-cols-2`}>
                {(
                  [
                    ['sms', smsHistory] as const,
                    ['email', emailHistory] as const,
                  ] satisfies readonly (readonly [SuppressionChannel, CancellationCommunication[]])[]
                ).map(([channel, rows]) => (
                  <div key={channel}>
                    <p className={ui.sectionTitle}>
                      <span className="flex items-center gap-1.5">
                        {channel === 'sms' ? (
                          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {CHANNEL_LABEL[channel]} delivery history
                      </span>
                    </p>
                    {rows.length === 0 ? (
                      <p className="mt-3 text-sm font-semibold text-slate-500">
                        No {CHANNEL_LABEL[channel]} message has been stored for this cancellation.
                      </p>
                    ) : (
                      <ol className="mt-3 space-y-3">
                        {rows.map((row) => {
                          const coverage = combinedCoverageText(row.coveredCaseIds);
                          return (
                            <li
                              key={row.id}
                              className="rounded-2xl border border-slate-200 bg-slate-50 p-3"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                {badge(
                                  DELIVERY_TONE[row.delivery_result] ?? 'neutral',
                                  row.delivery_result,
                                )}
                                {badge('neutral', `${row.touchpoint}-day touchpoint`)}
                                <span className="text-xs font-bold text-slate-500">
                                  {whenText(row.send_time)}
                                </span>
                                {row.attempt_count > 1
                                  ? badge('progress', `Attempt ${row.attempt_count}`)
                                  : null}
                              </div>
                              {coverage ? (
                                <p className="mt-2 flex items-center gap-1.5 text-xs font-black text-[#223f7a]">
                                  <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                  {coverage}
                                </p>
                              ) : null}
                              {row.rendered_subject.trim() === '' ? null : (
                                <p className="mt-2 text-xs font-black text-slate-900">
                                  {row.rendered_subject}
                                </p>
                              )}
                              <p className="mt-1 text-xs font-semibold whitespace-pre-wrap text-slate-600">
                                {row.rendered_body}
                              </p>
                              {row.failure_reason === null ? null : (
                                <p className="mt-2 flex gap-1.5 text-xs font-bold text-rose-700">
                                  <AlertTriangle
                                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                                    aria-hidden="true"
                                  />
                                  <span>{row.failure_reason}</span>
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                ))}
              </section>

              {/* ---------------------------------------------------------------
                  Recorded customer responses (Requirement 17.1)
                  --------------------------------------------------------------- */}
              <section className={`${ui.card} ${ui.cardPad}`}>
                <p className={ui.sectionTitle}>Recorded customer responses</p>
                {responses.length === 0 ? (
                  <p className="mt-3 text-sm font-semibold text-slate-500">
                    No customer response has been recorded for this cancellation.
                  </p>
                ) : (
                  <ol className="mt-3 space-y-2">
                    {responses.map((response) => (
                      <li
                        key={response.id}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          {badge('violet', response.response_type)}
                          <span className="text-xs font-bold text-slate-500">
                            {whenText(response.response_time)}
                          </span>
                          {response.response_channel === null
                            ? null
                            : badge('neutral', response.response_channel)}
                          <span className="text-xs font-semibold text-slate-500">
                            {text(actorNames.get(response.created_by))}
                          </span>
                        </div>
                        {response.note === null ? null : (
                          <p className="mt-1 text-sm font-semibold whitespace-pre-wrap text-slate-700">
                            {response.note}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {/* ---------------------------------------------------------------
                  Payment reports (Requirement 18) — the write is the panel's
                  --------------------------------------------------------------- */}
              <section
                ref={(node) => {
                  sectionRefs.current.payment = node;
                }}
                tabIndex={-1}
                aria-labelledby={`${baseId}-payments`}
                className={`${ui.card} ${ui.cardPad} outline-none`}
              >
                <p id={`${baseId}-payments`} className={ui.sectionTitle}>
                  Reported payments
                </p>
                {paymentReports.length === 0 ? (
                  <p className="mt-3 text-sm font-semibold text-slate-500">
                    No payment report has been recorded for this cancellation.
                  </p>
                ) : (
                  <ol className="mt-3 space-y-2">
                    {paymentReports.map((report) => (
                      <li
                        key={report.id}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          {badge('progress', 'Payment reported')}
                          <span className="text-xs font-bold text-slate-500">
                            {whenText(report.reported_at)}
                          </span>
                          <span className="text-xs font-semibold text-slate-500">
                            {text(actorNames.get(report.reported_by))}
                          </span>
                          {report.reported_amount === null
                            ? null
                            : badge('neutral', `Amount ${String(report.reported_amount)}`)}
                          {report.confirmation_reference === null
                            ? null
                            : badge('neutral', report.confirmation_reference)}
                        </div>
                        <p className="mt-1 text-sm font-semibold whitespace-pre-wrap text-slate-700">
                          {report.note}
                        </p>
                        <EvidenceFiles paths={report.evidence} disabled={locked} />
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <CancellationPaymentReportPanel
                caseId={caseRow.id}
                caseRow={caseRow}
                settings={settings}
                businessDate={today}
                pendingSends={pendingSends}
                onChanged={onPaymentChanged}
                disabled={locked}
              />

              {/* ---------------------------------------------------------------
                  Verification outcomes (Requirement 19) — the writes are the
                  panel's, which also states the Manager_Role restriction of
                  Requirement 19.11 for the Mark Resolved control every role sees
                  under Requirement 17.10
                  --------------------------------------------------------------- */}
              <section
                ref={(node) => {
                  sectionRefs.current.verification = node;
                }}
                tabIndex={-1}
                aria-labelledby={`${baseId}-outcomes`}
                className={`${ui.card} ${ui.cardPad} outline-none`}
              >
                <p id={`${baseId}-outcomes`} className={ui.sectionTitle}>
                  Recorded verification outcomes
                </p>
                {outcomes.length === 0 ? (
                  <p className="mt-3 text-sm font-semibold text-slate-500">
                    No verification outcome has been recorded for this cancellation.
                  </p>
                ) : (
                  <ol className="mt-3 space-y-2">
                    {outcomes.map((outcome) => (
                      <li
                        key={outcome.id}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          {badge('cyan', outcome.outcome)}
                          <span className="text-xs font-bold text-slate-500">
                            {whenText(outcome.verified_at)}
                          </span>
                          <span className="text-xs font-semibold text-slate-500">
                            {text(actorNames.get(outcome.recorded_by))}
                          </span>
                          {outcome.next_case_status === null
                            ? null
                            : badge('neutral', outcome.next_case_status)}
                          {outcome.next_required_action === null
                            ? null
                            : badge('info', outcome.next_required_action)}
                        </div>
                        {outcome.note === null ? null : (
                          <p className="mt-1 text-sm font-semibold whitespace-pre-wrap text-slate-700">
                            {outcome.note}
                          </p>
                        )}
                        <EvidenceFiles paths={outcome.evidence} disabled={locked} />
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <CancellationVerificationPanel
                caseId={caseRow.id}
                caseStatus={caseRow.case_status}
                nextRequiredAction={caseRow.next_required_action}
                cancellationEffectiveDate={caseRow.cancellation_effective_date}
                holidays={settings?.holidays ?? []}
                role={role}
                pendingSends={pendingSends}
                onChanged={onVerificationChanged}
                disabled={locked}
              />

              {/* ---------------------------------------------------------------
                  Notes and evidence (Requirement 17.1) — reading 11
                  --------------------------------------------------------------- */}
              <section className={`${ui.card} ${ui.cardPad}`}>
                <p className={ui.sectionTitle}>Notes and evidence</p>
                {notes.length === 0 ? (
                  <p className="mt-3 text-sm font-semibold text-slate-500">
                    No note has been saved for this cancellation.
                  </p>
                ) : (
                  <ol className="mt-3 space-y-2">
                    {notes.map((note) => (
                      <li
                        key={note.id}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-slate-500">
                          <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {whenText(note.created_at)}
                          <span className="font-semibold">{text(actorNames.get(note.created_by))}</span>
                        </div>
                        <p className="mt-1 text-sm font-semibold whitespace-pre-wrap text-slate-700">
                          {note.note}
                        </p>
                        <EvidenceFiles paths={note.evidence} disabled={locked} />
                      </li>
                    ))}
                  </ol>
                )}
                {noteComposer ? <div className="mt-4">{noteComposer}</div> : null}
              </section>

              {/* ---------------------------------------------------------------
                  Audit timeline (Requirement 17.7)
                  --------------------------------------------------------------- */}
              <section className={`${ui.card} ${ui.cardPad}`}>
                <p className={ui.sectionTitle}>
                  <span className="flex items-center gap-1.5">
                    <History className="h-3.5 w-3.5" aria-hidden="true" />
                    Audit timeline
                  </span>
                </p>
                <p className="mt-2 text-sm font-semibold text-slate-500">
                  Most recent first. Entries recorded at the same time read latest-recorded-first.
                  This timeline is append-only.
                </p>
                {timeline.length === 0 ? (
                  <p className="mt-3 text-sm font-semibold text-slate-500">
                    No audit entry has been recorded for this cancellation.
                  </p>
                ) : (
                  <ol className="mt-3 space-y-2">
                    {timeline.map((event) => (
                      <li
                        key={event.id}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-black text-slate-900">
                            {readableLabel(event.event_type)}
                          </span>
                          <span className="text-xs font-bold text-slate-500">
                            {whenText(event.event_time)}
                          </span>
                          <span className="text-xs font-semibold text-slate-500">
                            {event.actor_id === null
                              ? 'Automatic process'
                              : text(actorNames.get(event.actor_id))}
                          </span>
                        </div>
                        {detailEntries(event.detail).length === 0 ? null : (
                          <dl className="mt-2 grid gap-1.5 sm:grid-cols-2">
                            {detailEntries(event.detail).map(([label, value]) => (
                              <div key={label} className="flex gap-1.5 text-xs">
                                <dt className="font-black text-slate-500">{label}</dt>
                                <dd className="font-semibold break-words text-slate-700">{value}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {openEscalations.length > 0 ? (
                <p className={`${ui.info} flex gap-2`}>
                  <BellOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    This cancellation is escalated as{' '}
                    {openEscalations.map((row) => row.reason).join(', ')}. Communication status stays
                    Manual Follow-up Required until the escalation is recorded resolved.
                  </span>
                </p>
              ) : null}

              {loading ? (
                <p
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2 text-sm font-bold text-slate-500"
                >
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Refreshing this cancellation…
                </p>
              ) : (
                <p className="flex items-center gap-2 text-xs font-semibold text-slate-400">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Business date {today}.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

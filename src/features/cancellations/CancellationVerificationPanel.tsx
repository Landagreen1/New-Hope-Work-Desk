'use client';

// Cancellation verification panel — task 16.10
// (Requirements 19.1 to 19.5, 19.7 to 19.11, 22.4, 22.10, 22.11).
//
// The manager half of the cancellation drawer, built on the same card shell, the same
// `nhwd-shared/ui` tokens, the same "a rejection keeps every entered value on screen" rule, and
// the same `role="alert"` / `aria-describedby` / `aria-invalid` wiring as its sibling
// `./CancellationContactPanel`. Three writes live here:
//
//   1. record one of the seven payment verification outcomes — `recordVerificationOutcome`
//   2. Mark Resolved on a case that is Reinstated or Cancelled — `addCancellationNote` then
//      `overrideCaseStatus`
//   3. override the Case_Status with reason text — `overrideCaseStatus`
//
// Every one goes through `./api`, the single data-access module for this tab. This file opens no
// Supabase client, calls no database function of its own, and writes nothing to
// `cancellation_communications`, so the "every existing Communication_Record is retained" half of
// Requirements 19.3, 19.7, and 19.8 holds structurally rather than by discipline.
//
// **Readings recorded where a criterion leaves something open.**
//
//  1. *Which outcome leads where is decided here, not in `api.ts`.* `recordVerificationOutcome`
//     derives nothing: it takes the resulting Case_Status, the next required action, and the
//     follow-up deadline as inputs and enforces only the shape Requirements 19.2 and 19.5 fix. The
//     mapping of Requirements 19.3, 19.4, and 19.7 is therefore written down once, as data, in
//     `VERIFICATION_OUTCOME_PLANS`, and the four conditional outcomes carry no mapping at all
//     because those two criteria put the decision in the manager's hands.
//  2. *A cancelled Touchpoint is a Case_Status, not a deleted row.* Requirements 19.3 and 19.7 ask
//     for every Touchpoint later than the verification time to be cancelled. The four Touchpoints
//     are derived from the cancellation effective date and stored nowhere, and the scheduler sends
//     only for Case_Status Imported or Open (`scheduler/run.SENDABLE_CASE_STATUSES`), so setting
//     Reinstated or Cancelled *is* the cancellation of every later Touchpoint. The panel reports
//     it as `touchpointsCancelled` so the container can say so in the timeline it renders rather
//     than each surface re-deriving the fact.
//  3. *Three business days is counted here and clamped the way an escalation deadline is clamped.*
//     Requirement 19.4 wants a deadline "no later than three business days after the verification
//     time". `verificationFollowUpDeadline` counts Monday to Friday, skips the
//     agency-configured holidays of `cancellation_settings.holidays`, and lands on the start of
//     the third business day read as UTC — the convention `domain/escalation.followUpDeadline`
//     already uses, and the convention `derive.followUpDeadlinePassed` reads back. The effective
//     date clamps it, so the deadline can never fall after the moment the policy cancels. Date
//     arithmetic is `renewals/derive.addDays` and `renewals/derive.currentBusinessDate`; none is
//     reimplemented here.
//  4. *The pending-send count is asked for, never guessed.* Requirement 15.9 makes a
//     Communication_Status recompute due after a Case_Status change. The count of pending
//     Touchpoint channel sends is derived from the schedule and only the container holds it, so it
//     arrives as `pendingSends` and is forwarded to `api.ts`, which recomputes only when it was
//     supplied. Where the container cannot answer, the panel says the recompute follows rather
//     than writing a status from a guessed zero.
//  5. *Mark Resolved writes the note first.* Requirement 19.8 requires note text *and* the move to
//     Resolved. The note is stored first, so a failure of the status write leaves a documented
//     case at its previous status; the reverse order could leave a Resolved case with no note,
//     which the criterion does not allow. The failure message says which of the two landed.
//  6. *A non-manager sees a statement, never a control.* Requirement 19.11 refuses the whole panel
//     to a profile outside Manager_Role, and `super_admin` holds every `manager` permission, so
//     the gate is `isBroadManagerRole` — never a bare `role === 'manager'`. Every handler re-checks
//     it before touching `api.ts`, which refuses again, as does row level security.
//
// **Known limit, reported with this task.** Requirement 19.8 also clears the next required action.
// `api.overrideCaseStatus` writes `case_status` and the audit entry and does not touch
// `next_required_action`, and `api.ts` is owned elsewhere, so Mark Resolved cannot clear a stored
// action here. It is a narrow gap: both outcomes that reach Reinstated or Cancelled through this
// panel pass `nextRequiredAction: null` and so arrive with the action already cleared. Only a case
// driven to one of those two statuses by a manual override still carries one, and for that case
// the success notice names the action that is still stored instead of claiming it was cleared.
// Closing it needs one optional `nextRequiredAction` input on `overrideCaseStatus`.

import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  FileUp,
  LoaderCircle,
  Paperclip,
  ShieldAlert,
  ShieldCheck,
  SquarePen,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import { ui } from '../nhwd-shared/ui';
import { AGENCY_TIME_ZONE, addDays, currentBusinessDate } from '../renewals/derive';
import {
  CONDITIONAL_VERIFICATION_OUTCOMES,
  MAX_ACTIVITY_NOTE_LENGTH,
  MAX_EVIDENCE_FILES,
  MAX_EVIDENCE_SIZE_BYTES,
  MAX_OVERRIDE_REASON_LENGTH,
  VERIFICATION_NEXT_CASE_STATUSES,
  VERIFICATION_OUTCOMES,
  addCancellationNote,
  overrideCaseStatus,
  recordVerificationOutcome,
  type CancellationVerificationOutcome,
  type CaseStatus,
  type NextRequiredAction,
  type VerificationOutcome,
} from './api';
import { visibleCancellationActions } from './derive';
import { CASE_STATUSES, isCaseStatus, isOpenCaseStatus } from './domain/communication-status';
import { parseCancellationDate } from './import/fields';

// ---------------------------------------------------------------------------
// The outcome mapping of Requirements 19.3, 19.4, and 19.7 — reading 1
// ---------------------------------------------------------------------------

/** Requirement 19.4: the follow-up deadline is no later than this many business days out. */
export const VERIFICATION_DEADLINE_BUSINESS_DAYS = 3;

/** What one verification outcome does to the case, or what it asks the manager to decide. */
export interface VerificationOutcomePlan {
  /**
   * True for the four outcomes of Requirements 19.2 and 19.5: note text, a next Case_Status from
   * the three permitted values, and a next required action are all required from the manager, and
   * this plan carries no Case_Status of its own.
   */
  requiresNextDecision: boolean;
  /** The Case_Status the outcome sets, or `null` where the manager selects it. */
  caseStatus: CaseStatus | null;
  /**
   * The next required action the outcome sets. `null` clears it (Requirements 19.3, 19.7); ignored
   * where `requiresNextDecision` holds, because the manager sets it.
   */
  nextRequiredAction: NextRequiredAction | null;
  /** Business days after the verification time to set the deadline to, or `null` to leave it. */
  deadlineBusinessDays: number | null;
  /** Requirements 19.3, 19.7: every Touchpoint later than the verification time is cancelled. */
  cancelsLaterTouchpoints: boolean;
  /** The sentence the panel shows before the write, and repeats after it. */
  effect: string;
}

/**
 * The seven outcomes of Requirement 19.1 and what each one does. The em dash of the first is
 * written as an escape, exactly as `api.ts` writes it, so the two strings cannot drift apart.
 */
export const VERIFICATION_OUTCOME_PLANS = {
  'Payment verified \u2014 reinstatement pending': {
    requiresNextDecision: false,
    caseStatus: 'Reinstatement Pending',
    nextRequiredAction: 'Confirm Reinstatement',
    deadlineBusinessDays: VERIFICATION_DEADLINE_BUSINESS_DAYS,
    cancelsLaterTouchpoints: false,
    effect:
      'Sets the case status to Reinstatement Pending, sets the next required action to Confirm Reinstatement, and sets a follow-up deadline no later than three business days after the verification time. Automatic sending stays suspended.',
  },
  'Policy reinstated': {
    requiresNextDecision: false,
    caseStatus: 'Reinstated',
    nextRequiredAction: null,
    deadlineBusinessDays: null,
    cancelsLaterTouchpoints: true,
    effect:
      'Sets the case status to Reinstated, cancels every touchpoint scheduled after the verification time, and clears the next required action. Every stored communication is kept.',
  },
  'Payment not found': {
    requiresNextDecision: true,
    caseStatus: null,
    nextRequiredAction: null,
    deadlineBusinessDays: null,
    cancelsLaterTouchpoints: false,
    effect:
      'Needs note text, the next case status, and the next required action. Nothing is saved until all three are supplied.',
  },
  'Additional payment required': {
    requiresNextDecision: true,
    caseStatus: null,
    nextRequiredAction: null,
    deadlineBusinessDays: null,
    cancelsLaterTouchpoints: false,
    effect:
      'Needs note text, the next case status, and the next required action. Nothing is saved until all three are supplied.',
  },
  'Policy still scheduled for cancellation': {
    requiresNextDecision: true,
    caseStatus: null,
    nextRequiredAction: null,
    deadlineBusinessDays: null,
    cancelsLaterTouchpoints: false,
    effect:
      'Needs note text, the next case status, and the next required action. Nothing is saved until all three are supplied.',
  },
  'Policy cancelled': {
    requiresNextDecision: false,
    caseStatus: 'Cancelled',
    nextRequiredAction: null,
    deadlineBusinessDays: null,
    cancelsLaterTouchpoints: true,
    effect:
      'Sets the case status to Cancelled, cancels every touchpoint scheduled after the verification time, and clears the next required action. Every stored communication is kept.',
  },
  Other: {
    requiresNextDecision: true,
    caseStatus: null,
    nextRequiredAction: null,
    deadlineBusinessDays: null,
    cancelsLaterTouchpoints: false,
    effect:
      'Needs note text, the next case status, and the next required action. Nothing is saved until all three are supplied.',
  },
} as const satisfies Record<VerificationOutcome, VerificationOutcomePlan>;

/** The plan of one outcome — reading 1. */
export function verificationOutcomePlan(outcome: VerificationOutcome): VerificationOutcomePlan {
  return VERIFICATION_OUTCOME_PLANS[outcome];
}

/** True for the four outcomes that require note text, a next status, and a next action. */
export function requiresNextDecision(outcome: VerificationOutcome): boolean {
  return verificationOutcomePlan(outcome).requiresNextDecision;
}

/** Narrows a submitted string to one of the seven outcomes of Requirement 19.1. */
export function isVerificationOutcome(value: string | null | undefined): value is VerificationOutcome {
  return (VERIFICATION_OUTCOMES as readonly string[]).includes(value ?? '');
}

/** Narrows a submitted string to the three next Case_Status values of Requirements 19.2 and 19.5. */
export function isVerificationNextCaseStatus(value: string | null | undefined): value is CaseStatus {
  return (VERIFICATION_NEXT_CASE_STATUSES as readonly string[]).includes(value ?? '');
}

/** The two Case_Status values Requirements 19.8 and 19.10 require for Mark Resolved. */
export const MARK_RESOLVED_CASE_STATUSES = ['Reinstated', 'Cancelled'] as const satisfies readonly CaseStatus[];

/** True where Mark Resolved is permitted on the stored status (Requirements 19.8, 19.10). */
export function markResolvedPermitted(caseStatus: CaseStatus): boolean {
  return (MARK_RESOLVED_CASE_STATUSES as readonly CaseStatus[]).includes(caseStatus);
}

// ---------------------------------------------------------------------------
// Rejection sentences
// ---------------------------------------------------------------------------

/** Requirement 19.11: the one sentence every refused attempt by a non-manager reads. */
export const MANAGER_ROLE_REJECTION =
  'Recording a verification outcome, marking a cancellation resolved, and changing a case status all require a manager or super admin. Nothing was changed.';

/** Requirement 19.10, naming the stored status the request was refused on. */
export function markResolvedRejection(caseStatus: CaseStatus): string {
  return `Mark Resolved requires case status ${MARK_RESOLVED_CASE_STATUSES.join(
    ' or ',
  )}; this cancellation is ${caseStatus}. Nothing was changed.`;
}

/** Requirements 22.4 and 22.11: the required reason length, with the stored status unchanged. */
export const OVERRIDE_REASON_REJECTION = `A case status change needs reason text of 1 to ${MAX_OVERRIDE_REASON_LENGTH.toLocaleString(
  'en-US',
)} characters, with at least one character that is not a space. The stored status is unchanged.`;

// ---------------------------------------------------------------------------
// The follow-up deadline of Requirement 19.4 — reading 3
// ---------------------------------------------------------------------------

/** The agency-configured non-business dates, as `YYYY-MM-DD`, from `cancellation_settings`. */
function holidaySet(holidays: readonly string[]): ReadonlySet<string> {
  const dates = new Set<string>();
  for (const entry of holidays) {
    const parsed = parseCancellationDate(entry);
    if (parsed.ok) dates.add(parsed.date);
  }
  return dates;
}

/** Whole days since the epoch read as UTC, the instant convention `domain/escalation` clamps at. */
function utcMidnight(date: string): number {
  const parsed = parseCancellationDate(date);
  if (!parsed.ok) return Number.NaN;
  return Date.UTC(parsed.year, parsed.month - 1, parsed.day);
}

/** True for Monday through Friday outside the agency-configured holidays (Requirement 18.4). */
export function isBusinessDate(date: string, holidays: ReadonlySet<string>): boolean {
  const instant = utcMidnight(date);
  if (Number.isNaN(instant)) return false;
  const weekday = new Date(instant).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !holidays.has(date);
}

/**
 * The calendar date `count` business days after `date`, counting Monday through Friday and
 * skipping the agency-configured holidays. Calendar stepping is `renewals/derive.addDays`.
 *
 * The walk is capped at two years of calendar days so a holiday list that named every weekday
 * could not spin: at the cap the last date reached is returned, which is later than the start and
 * still earlier than any real deadline would be useful, rather than hanging the browser.
 */
export function addBusinessDays(date: string, count: number, holidays: ReadonlySet<string>): string {
  let cursor = date;
  let remaining = Math.max(0, Math.trunc(count));
  let steps = 0;
  while (remaining > 0 && steps < 730) {
    cursor = addDays(cursor, 1);
    steps += 1;
    if (isBusinessDate(cursor, holidays)) remaining -= 1;
  }
  return cursor;
}

/**
 * The follow-up deadline of Requirement 19.4 as an ISO instant: the start of the third business
 * day after the verification time read as UTC, brought earlier by the cancellation effective date
 * — reading 3.
 *
 * Reading the third business day at UTC midnight keeps the deadline strictly inside "no later than
 * three business days", matches the clamp convention of `domain/escalation.followUpDeadline`, and
 * is the value `derive.followUpDeadlinePassed` compares against the business date. An absent or
 * unparseable effective date leaves the count unclamped.
 */
export function verificationFollowUpDeadline(
  verificationTime: Date,
  cancellationEffectiveDate: string | null | undefined,
  holidays: readonly string[] = [],
  businessDays: number = VERIFICATION_DEADLINE_BUSINESS_DAYS,
  timeZone: string = AGENCY_TIME_ZONE,
): string {
  const from = currentBusinessDate(verificationTime, timeZone);
  const due = addBusinessDays(from, businessDays, holidaySet(holidays));
  const candidate = utcMidnight(due);
  const effective = parseCancellationDate(cancellationEffectiveDate);
  if (!effective.ok) return new Date(candidate).toISOString();
  return new Date(
    Math.min(candidate, Date.UTC(effective.year, effective.month - 1, effective.day)),
  ).toISOString();
}

/** The UTC calendar date of a stored deadline, the value the Needs Action filter compares. */
export function deadlineCalendarDate(deadline: string): string {
  return deadline.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Which write landed, for the container's refetch and its timeline. */
export type CancellationVerificationChangeKind =
  | 'verification_outcome_recorded'
  | 'case_resolved'
  | 'case_status_overridden';

/** What one successful write changed. */
export interface CancellationVerificationChange {
  kind: CancellationVerificationChangeKind;
  caseId: string;
  /** The stored Case_Status before the write, as the audit entry recorded it. */
  previousCaseStatus: CaseStatus;
  /** The stored Case_Status after the write. */
  caseStatus: CaseStatus;
  /** The stored next required action after the write; `null` where it was cleared. */
  nextRequiredAction: NextRequiredAction | null;
  /** The instant written to the follow-up deadline, or `null` where it was left alone. */
  followUpDeadline: string | null;
  /** The recorded outcome, or `null` for Mark Resolved and for a status override. */
  outcome: VerificationOutcome | null;
  /** Requirements 19.3, 19.7: every Touchpoint later than the verification time is cancelled. */
  touchpointsCancelled: boolean;
  /** Requirements 18.2, 19.4: automatic Touchpoint sending stays suspended at this status. */
  sendingSuspended: boolean;
  /** Requirement 15.9: false where the pending-send count was unknown, so the container owes one. */
  recomputed: boolean;
  /** Requirement 20.10: the container owes this case an escalation evaluation. */
  escalationReevaluationDue: boolean;
}

export interface CancellationVerificationPanelProps {
  /** `cancellation_cases.id`. Every write on this panel is scoped to this case. */
  caseId: string;
  /** The stored Case_Status: gates Mark Resolved and is reported as the previous status. */
  caseStatus: CaseStatus;
  /** `cancellation_cases.next_required_action`, so a notice states what a write left stored. */
  nextRequiredAction?: NextRequiredAction | null;
  /** `cancellation_effective_date`; clamps the Requirement 19.4 deadline — reading 3. */
  cancellationEffectiveDate?: string | null;
  /** `cancellation_settings.holidays`: the dates the business-day count skips. */
  holidays?: readonly string[];
  /**
   * The signed-in profile's role. Anything outside `manager` and `super_admin` sees the role
   * statement and no control at all (Requirement 19.11). `null` reads as the unrestricted
   * Manager_Role view, matching `derive.isActionVisibleToRole`; row level security remains the
   * authorization boundary either way.
   */
  role?: AppRole | null;
  /**
   * The case's pending Touchpoint channel sends. Supplied, `api.ts` recomputes
   * Communication_Status in the same round trip; absent, the panel says the recompute follows
   * rather than writing a status from a guessed zero — reading 4.
   */
  pendingSends?: number;
  /** Raised after each successful write so the container refetches and re-evaluates escalations. */
  onChanged: (change: CancellationVerificationChange) => void | Promise<void>;
  disabled?: boolean;
  /** The clock, for the deadline count. Absent reads the real one. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Small presentation helpers
// ---------------------------------------------------------------------------

function badge(tone: string, text: string) {
  return <span className={`${ui.badge} ${ui.badgeTone[tone]}`}>{text}</span>;
}

function overLimitText(length: number, limit: number): string {
  return `${length.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} characters${
    length > limit ? ' \u2014 over the limit' : ''
  }`;
}

/** Megabytes of a byte count, for the evidence rejection sentence. */
function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * The evidence rejection of Requirement 19.9's limits, or `null` where every file is within them.
 * `api.ts` checks the same two limits on the write path and its answer is the one that counts;
 * this copy states the exceeded limit next to the field and stores nothing.
 */
export function evidenceRejection(files: readonly File[]): string | null {
  if (files.length > MAX_EVIDENCE_FILES) {
    return `At most ${MAX_EVIDENCE_FILES} evidence files can be attached to one outcome; this submission has ${files.length}. Nothing was saved.`;
  }
  const oversized = files.find((file) => file.size > MAX_EVIDENCE_SIZE_BYTES);
  if (oversized !== undefined) {
    return `"${oversized.name}" is ${megabytes(oversized.size)}. An evidence file must be ${megabytes(
      MAX_EVIDENCE_SIZE_BYTES,
    )} or smaller. Nothing was saved.`;
  }
  return null;
}

/** The sentence Requirement 15.9's recompute leaves behind when the count was unknown. */
const RECOMPUTE_PENDING_NOTE =
  ' Communication status is recomputed once the touchpoint schedule for this cancellation loads.';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CancellationVerificationPanel({
  caseId,
  caseStatus,
  nextRequiredAction = null,
  cancellationEffectiveDate = null,
  holidays = [],
  role = null,
  pendingSends,
  onChanged,
  disabled = false,
  now,
}: CancellationVerificationPanelProps) {
  const baseId = useId();

  // Outcome draft. Nothing here is cleared by a rejection (Requirements 19.2, 19.5).
  const [outcome, setOutcome] = useState<VerificationOutcome | ''>('');
  const [note, setNote] = useState('');
  const [nextStatus, setNextStatus] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [outcomeError, setOutcomeError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [nextStatusError, setNextStatusError] = useState<string | null>(null);
  const [nextActionError, setNextActionError] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [deadlinePreview, setDeadlinePreview] = useState<string | null>(null);

  // Mark Resolved draft.
  const [resolveNote, setResolveNote] = useState('');
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Case_Status override draft.
  const [overrideStatus, setOverrideStatus] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const nowRef = useRef<() => Date>(now ?? (() => new Date()));
  nowRef.current = now ?? (() => new Date());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const manager = isBroadManagerRole(role ?? 'manager');
  const busy = disabled || pending !== null;
  const plan = outcome === '' ? null : verificationOutcomePlan(outcome);
  const conditional = plan?.requiresNextDecision ?? false;
  const trimmedNote = note.trim();
  const trimmedResolveNote = resolveNote.trim();
  const trimmedOverrideReason = overrideReason.trim();
  const noteOverLimit = trimmedNote.length > MAX_ACTIVITY_NOTE_LENGTH;
  const resolveNoteOverLimit = trimmedResolveNote.length > MAX_ACTIVITY_NOTE_LENGTH;
  const reasonOverLimit = trimmedOverrideReason.length > MAX_OVERRIDE_REASON_LENGTH;
  // The nine controls a Manager_Role profile is shown, read from the one function that decides
  // control visibility (Requirement 17.10) rather than restated as a list here.
  const actionChoices = visibleCancellationActions(role);

  // The deadline preview is computed in an effect, never during render, so the server and the
  // browser cannot disagree about the clock on first paint — reading 3.
  useEffect(() => {
    const days = outcome === '' ? null : verificationOutcomePlan(outcome).deadlineBusinessDays;
    if (days === null) {
      setDeadlinePreview(null);
      return;
    }
    setDeadlinePreview(
      verificationFollowUpDeadline(nowRef.current(), cancellationEffectiveDate, holidays, days),
    );
    // `holidays` is a stable settings array in practice; its identity is part of the count.
  }, [outcome, cancellationEffectiveDate, holidays]);

  /** Requirement 19.11, checked before every write and again by `api.ts` — reading 6. */
  function refuseNonManager(show: (message: string) => void): boolean {
    if (manager) return false;
    setNotice(null);
    show(MANAGER_ROLE_REJECTION);
    return true;
  }

  /**
   * Runs one write. On success the notice is shown and `onChanged` is raised; on failure the
   * message goes to `fail`, which attaches it to the field it belongs to. No draft is cleared on
   * a failure, so every entered value stays on screen (Requirements 19.2, 19.5, 22.11).
   */
  async function perform(
    key: string,
    write: () => Promise<{ change: CancellationVerificationChange; notice: string }>,
    fail: (message: string) => void,
  ): Promise<void> {
    setPending(key);
    setNotice(null);
    try {
      const result = await write();
      if (mountedRef.current) setNotice(result.notice);
      await onChanged(result.change);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'The change could not be saved.';
      if (mountedRef.current) fail(message);
    } finally {
      if (mountedRef.current) setPending(null);
    }
  }

  // -------------------------------------------------------------------------
  // Record a verification outcome (Requirements 19.1 to 19.5, 19.7, 19.9, 19.11)
  // -------------------------------------------------------------------------

  const outcomeId = `${baseId}-outcome`;
  const noteId = `${baseId}-note`;
  const nextStatusId = `${baseId}-next-status`;
  const nextActionId = `${baseId}-next-action`;
  const evidenceId = `${baseId}-evidence`;

  function clearOutcomeErrors(): void {
    setOutcomeError(null);
    setNoteError(null);
    setNextStatusError(null);
    setNextActionError(null);
    setEvidenceError(null);
  }

  async function submitOutcome(): Promise<void> {
    clearOutcomeErrors();
    if (refuseNonManager(setOutcomeError)) return;

    if (!isVerificationOutcome(outcome)) {
      setOutcomeError(
        `Select one of the seven verification outcomes: ${VERIFICATION_OUTCOMES.join(', ')}. Nothing was saved.`,
      );
      return;
    }
    const selected = verificationOutcomePlan(outcome);

    if (noteOverLimit) {
      setNoteError(
        `Note text must be ${MAX_ACTIVITY_NOTE_LENGTH.toLocaleString(
          'en-US',
        )} characters or fewer; this one is ${trimmedNote.length.toLocaleString('en-US')}. Nothing was saved.`,
      );
      return;
    }

    // Requirements 19.2 and 19.5: the four conditional outcomes need all three inputs, and an
    // incomplete submission is refused with the entered outcome and note text still on screen.
    if (selected.requiresNextDecision) {
      let incomplete = false;
      if (trimmedNote === '') {
        setNoteError(
          `"${outcome}" requires note text with at least one character that is not a space. Nothing was saved.`,
        );
        incomplete = true;
      }
      if (!isVerificationNextCaseStatus(nextStatus)) {
        setNextStatusError(
          `"${outcome}" requires a next case status of ${VERIFICATION_NEXT_CASE_STATUSES.join(
            ', ',
          )}. Nothing was saved.`,
        );
        incomplete = true;
      }
      if (nextAction === '') {
        setNextActionError(`"${outcome}" requires a next required action. Nothing was saved.`);
        incomplete = true;
      }
      if (incomplete) return;
    }

    const evidenceProblem = evidenceRejection(files);
    if (evidenceProblem !== null) {
      setEvidenceError(evidenceProblem);
      return;
    }

    const verificationTime = nowRef.current();
    const resultingStatus = selected.requiresNextDecision
      ? (nextStatus as CaseStatus)
      : (selected.caseStatus as CaseStatus);
    const resultingAction = selected.requiresNextDecision
      ? (nextAction as NextRequiredAction)
      : selected.nextRequiredAction;
    const deadline =
      selected.deadlineBusinessDays === null
        ? undefined
        : verificationFollowUpDeadline(
            verificationTime,
            cancellationEffectiveDate,
            holidays,
            selected.deadlineBusinessDays,
          );

    await perform(
      'outcome',
      async () => {
        const stored: CancellationVerificationOutcome = await recordVerificationOutcome({
          caseId,
          outcome,
          note: trimmedNote === '' ? null : trimmedNote,
          nextCaseStatus: resultingStatus,
          nextRequiredAction: resultingAction,
          followUpDeadline: deadline,
          files,
          pendingSends,
        });

        if (mountedRef.current) {
          setOutcome('');
          setNote('');
          setNextStatus('');
          setNextAction('');
          setFiles([]);
          if (fileInputRef.current !== null) fileInputRef.current.value = '';
        }

        const suspended = !isOpenCaseStatus(resultingStatus);
        const sentences = [`"${stored.outcome}" recorded.`, `The case status is ${resultingStatus}.`];
        sentences.push(
          resultingAction === null
            ? 'The next required action is cleared.'
            : `The next required action is ${resultingAction}.`,
        );
        if (deadline !== undefined) {
          sentences.push(`The follow-up deadline is ${deadlineCalendarDate(deadline)}.`);
        }
        if (selected.cancelsLaterTouchpoints) {
          sentences.push('Every touchpoint scheduled after the verification time is cancelled.');
        }
        sentences.push(
          suspended
            ? 'Automatic sending stays suspended.'
            : 'Automatic sending resumes, and every touchpoint scheduled before today is excluded.',
        );
        sentences.push('Every stored communication is unchanged.');

        return {
          change: {
            kind: 'verification_outcome_recorded',
            caseId,
            previousCaseStatus: caseStatus,
            caseStatus: resultingStatus,
            nextRequiredAction: resultingAction,
            followUpDeadline: deadline ?? null,
            outcome: stored.outcome,
            touchpointsCancelled: selected.cancelsLaterTouchpoints,
            sendingSuspended: suspended,
            recomputed: pendingSends !== undefined,
            escalationReevaluationDue: true,
          },
          notice: `${sentences.join(' ')}${pendingSends === undefined ? RECOMPUTE_PENDING_NOTE : ''}`,
        };
      },
      setOutcomeError,
    );
  }

  // -------------------------------------------------------------------------
  // Mark Resolved (Requirements 19.8, 19.10, 19.11) — reading 5
  // -------------------------------------------------------------------------

  const resolveNoteId = `${baseId}-resolve-note`;

  async function submitMarkResolved(): Promise<void> {
    setResolveError(null);
    if (refuseNonManager(setResolveError)) return;

    if (!markResolvedPermitted(caseStatus)) {
      setResolveError(markResolvedRejection(caseStatus));
      return;
    }
    if (trimmedResolveNote === '') {
      setResolveError(
        'Mark Resolved requires note text with at least one character that is not a space. Nothing was changed.',
      );
      return;
    }
    if (resolveNoteOverLimit) {
      setResolveError(
        `Note text must be ${MAX_ACTIVITY_NOTE_LENGTH.toLocaleString(
          'en-US',
        )} characters or fewer; this one is ${trimmedResolveNote.length.toLocaleString(
          'en-US',
        )}. Nothing was changed.`,
      );
      return;
    }

    await perform(
      'resolve',
      async () => {
        // The note lands first: a case that reaches Resolved must carry note text, so the order
        // that can fail safely is the documented one — reading 5.
        await addCancellationNote({ caseId, note: trimmedResolveNote });
        try {
          await overrideCaseStatus({
            caseId,
            caseStatus: 'Resolved',
            reason: trimmedResolveNote,
            pendingSends,
          });
        } catch (caught) {
          const detail = caught instanceof Error ? caught.message : 'The case status was not changed.';
          throw new Error(`${detail} The note was saved and the case status is unchanged.`);
        }

        if (mountedRef.current) setResolveNote('');

        const sentences = ['Marked Resolved.'];
        sentences.push(
          nextRequiredAction === null
            ? 'The next required action is cleared.'
            : `The next required action is still recorded as ${nextRequiredAction}.`,
        );
        sentences.push('Every stored communication is unchanged.');

        return {
          change: {
            kind: 'case_resolved',
            caseId,
            previousCaseStatus: caseStatus,
            caseStatus: 'Resolved',
            nextRequiredAction,
            followUpDeadline: null,
            outcome: null,
            touchpointsCancelled: true,
            sendingSuspended: true,
            recomputed: pendingSends !== undefined,
            escalationReevaluationDue: true,
          },
          notice: `${sentences.join(' ')}${pendingSends === undefined ? RECOMPUTE_PENDING_NOTE : ''}`,
        };
      },
      setResolveError,
    );
  }

  // -------------------------------------------------------------------------
  // Case_Status override (Requirements 22.4, 22.10, 22.11)
  // -------------------------------------------------------------------------

  const overrideStatusId = `${baseId}-override-status`;
  const overrideReasonId = `${baseId}-override-reason`;

  async function submitOverride(): Promise<void> {
    setOverrideError(null);
    if (refuseNonManager(setOverrideError)) return;

    if (!isCaseStatus(overrideStatus)) {
      setOverrideError(
        `Select one of the ten case statuses: ${CASE_STATUSES.join(', ')}. The stored status is unchanged.`,
      );
      return;
    }
    if (trimmedOverrideReason === '' || reasonOverLimit) {
      setOverrideError(OVERRIDE_REASON_REJECTION);
      return;
    }

    const requested = overrideStatus;
    await perform(
      'override',
      async () => {
        const stored = await overrideCaseStatus({
          caseId,
          caseStatus: requested,
          reason: trimmedOverrideReason,
          pendingSends,
        });

        if (mountedRef.current) {
          setOverrideStatus('');
          setOverrideReason('');
        }

        const suspended = !isOpenCaseStatus(stored.case_status);
        return {
          change: {
            kind: 'case_status_overridden',
            caseId,
            previousCaseStatus: caseStatus,
            caseStatus: stored.case_status,
            nextRequiredAction: stored.next_required_action,
            followUpDeadline: null,
            outcome: null,
            touchpointsCancelled: suspended,
            sendingSuspended: suspended,
            recomputed: pendingSends !== undefined,
            escalationReevaluationDue: true,
          },
          notice: `Case status changed from ${caseStatus} to ${
            stored.case_status
          }. The reason, your profile, the time, and both statuses are stored as one timeline entry.${
            pendingSends === undefined ? RECOMPUTE_PENDING_NOTE : ''
          }`,
        };
      },
      setOverrideError,
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Requirement 19.11: a profile outside Manager_Role is told the rule and shown no control at
  // all, so no attempt can be started from this panel — reading 6.
  if (!manager) {
    return (
      <section className={`${ui.card} ${ui.cardPad} space-y-3`}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-2xl bg-slate-100 text-slate-500">
            <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="font-black text-slate-950">Payment verification</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">{MANAGER_ROLE_REJECTION}</p>
          </div>
        </div>
        <p className="text-xs font-semibold text-slate-400">
          Current case status: {caseStatus}. Ask a manager or super admin to record the verification outcome.
        </p>
      </section>
    );
  }

  return (
    <section className={`${ui.card} ${ui.cardPad} space-y-6`}>
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-2xl bg-violet-50 text-violet-700">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h3 className="font-black text-slate-950">Payment verification and reinstatement</h3>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            Recording an outcome stores your profile, the verification time, the outcome, the note, and any
            evidence, and adds the outcome to the audit timeline. No stored communication is ever changed.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {badge('neutral', `Case status: ${caseStatus}`)}
            {badge('info', `Next required action: ${nextRequiredAction ?? 'Cleared'}`)}
          </div>
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {notice ?? ''}
      </p>
      {notice ? <p className={ui.success}>{notice}</p> : null}

      {/* ---------------------------------------------------------------- */}
      {/* Record a verification outcome                                    */}
      {/* ---------------------------------------------------------------- */}
      <form
        noValidate
        aria-busy={pending === 'outcome'}
        className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submitOutcome();
        }}
      >
        <p className={ui.sectionTitle}>
          <BadgeCheck className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
          Record a verification outcome
        </p>

        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label className={ui.label} htmlFor={outcomeId}>
              Verification outcome
            </label>
            <select
              id={outcomeId}
              className={ui.select}
              disabled={busy}
              value={outcome}
              aria-invalid={Boolean(outcomeError)}
              aria-describedby={`${outcomeId}-effect${outcomeError ? ` ${outcomeId}-error` : ''}`}
              onChange={(event) => {
                const next = event.target.value;
                setOutcome(isVerificationOutcome(next) ? next : '');
                clearOutcomeErrors();
              }}
            >
              <option value="">Select an outcome…</option>
              {VERIFICATION_OUTCOMES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <p
              id={`${outcomeId}-effect`}
              aria-live="polite"
              className="mt-2 text-xs font-semibold text-slate-500"
            >
              {plan === null
                ? 'Seven outcomes are available. Four of them ask you for the next case status and the next required action.'
                : plan.effect}
            </p>
            {outcomeError ? (
              <p
                id={`${outcomeId}-error`}
                role="alert"
                className="mt-1 flex gap-1.5 text-xs font-bold text-rose-700"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{outcomeError}</span>
              </p>
            ) : null}
          </div>

          <div>
            <label className={ui.label} htmlFor={noteId}>
              Verification note{conditional ? ' (required)' : ' (optional)'}
            </label>
            <textarea
              id={noteId}
              rows={4}
              className={ui.textarea}
              disabled={busy}
              value={note}
              aria-invalid={Boolean(noteError) || noteOverLimit}
              aria-describedby={`${noteId}-count${noteError ? ` ${noteId}-error` : ''}`}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteError(null);
              }}
            />
            <p
              id={`${noteId}-count`}
              className={`mt-2 text-xs font-bold tabular-nums ${
                noteOverLimit ? 'text-rose-700' : 'text-slate-500'
              }`}
            >
              {overLimitText(trimmedNote.length, MAX_ACTIVITY_NOTE_LENGTH)}
            </p>
            {noteError ? (
              <p
                id={`${noteId}-error`}
                role="alert"
                className="mt-1 flex gap-1.5 text-xs font-bold text-rose-700"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{noteError}</span>
              </p>
            ) : null}
          </div>
        </div>

        {/* The two inputs Requirements 19.2 and 19.5 put in the manager's hands. */}
        {conditional ? (
          <div className="mt-4 grid gap-4 rounded-2xl border border-amber-200 bg-amber-50/60 p-4 sm:grid-cols-2">
            <div>
              <label className={ui.label} htmlFor={nextStatusId}>
                Next case status (required)
              </label>
              <select
                id={nextStatusId}
                className={ui.select}
                disabled={busy}
                value={nextStatus}
                aria-invalid={Boolean(nextStatusError)}
                aria-describedby={nextStatusError ? `${nextStatusId}-error` : undefined}
                onChange={(event) => {
                  setNextStatus(event.target.value);
                  setNextStatusError(null);
                }}
              >
                <option value="">Select a case status…</option>
                {VERIFICATION_NEXT_CASE_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              {nextStatusError ? (
                <p
                  id={`${nextStatusId}-error`}
                  role="alert"
                  className="mt-2 flex gap-1.5 text-xs font-bold text-rose-700"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{nextStatusError}</span>
                </p>
              ) : null}
            </div>

            <div>
              <label className={ui.label} htmlFor={nextActionId}>
                Next required action (required)
              </label>
              <select
                id={nextActionId}
                className={ui.select}
                disabled={busy}
                value={nextAction}
                aria-invalid={Boolean(nextActionError)}
                aria-describedby={nextActionError ? `${nextActionId}-error` : undefined}
                onChange={(event) => {
                  setNextAction(event.target.value);
                  setNextActionError(null);
                }}
              >
                <option value="">Select an action…</option>
                {actionChoices.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              {nextActionError ? (
                <p
                  id={`${nextActionId}-error`}
                  role="alert"
                  className="mt-2 flex gap-1.5 text-xs font-bold text-rose-700"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{nextActionError}</span>
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {deadlinePreview !== null ? (
          <p className="mt-4 flex items-center gap-1.5 text-xs font-bold text-slate-600">
            <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Follow-up deadline: {deadlineCalendarDate(deadlinePreview)} — three business days after the
            verification time, brought earlier where the policy cancels sooner.
          </p>
        ) : null}

        <div className="mt-4">
          <label className={ui.label} htmlFor={evidenceId}>
            Evidence files (optional)
          </label>
          <input
            id={evidenceId}
            ref={fileInputRef}
            type="file"
            multiple
            className={`${ui.input} file:mr-3 file:rounded-lg file:border-0 file:bg-[#eef3fb] file:px-3 file:py-1.5 file:text-xs file:font-black file:text-[#223f7a]`}
            disabled={busy}
            aria-invalid={Boolean(evidenceError)}
            aria-describedby={`${evidenceId}-hint${evidenceError ? ` ${evidenceId}-error` : ''}`}
            onChange={(event) => {
              setFiles(Array.from(event.target.files ?? []));
              setEvidenceError(null);
            }}
          />
          <p id={`${evidenceId}-hint`} className="mt-2 text-xs font-semibold text-slate-400">
            At most {MAX_EVIDENCE_FILES} files, {megabytes(MAX_EVIDENCE_SIZE_BYTES)} each. Downloads are signed
            links, never public URLs.
          </p>
          {files.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {files.map((file) => (
                <li
                  key={`${file.name}-${file.size}-${file.lastModified}`}
                  className="flex items-center gap-1.5 text-xs font-semibold text-slate-600"
                >
                  <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {file.name} — {megabytes(file.size)}
                </li>
              ))}
            </ul>
          ) : null}
          {evidenceError ? (
            <p
              id={`${evidenceId}-error`}
              role="alert"
              className="mt-2 flex gap-1.5 text-xs font-bold text-rose-700"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{evidenceError}</span>
            </p>
          ) : null}
        </div>

        <button type="submit" className={`${ui.btnPrimary} mt-4`} disabled={busy}>
          {pending === 'outcome' ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileUp className="h-4 w-4" aria-hidden="true" />
          )}
          {pending === 'outcome' ? 'Recording outcome…' : 'Record verification outcome'}
        </button>
      </form>

      {/* ---------------------------------------------------------------- */}
      {/* Mark Resolved                                                    */}
      {/* ---------------------------------------------------------------- */}
      <form
        noValidate
        aria-busy={pending === 'resolve'}
        className="rounded-2xl border border-slate-200 bg-white p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submitMarkResolved();
        }}
      >
        <p className={ui.sectionTitle}>
          <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
          Mark resolved
        </p>
        <p className="mt-1 text-xs font-semibold text-slate-500">
          Available on a cancellation that is {MARK_RESOLVED_CASE_STATUSES.join(' or ')}. This cancellation is{' '}
          {caseStatus}. Note text is required, and every stored communication is kept.
        </p>

        <div className="mt-3">
          <label className={ui.label} htmlFor={resolveNoteId}>
            Resolution note (required)
          </label>
          <textarea
            id={resolveNoteId}
            rows={3}
            className={ui.textarea}
            disabled={busy}
            value={resolveNote}
            aria-invalid={Boolean(resolveError) || resolveNoteOverLimit}
            aria-describedby={`${resolveNoteId}-count${resolveError ? ` ${resolveNoteId}-error` : ''}`}
            onChange={(event) => {
              setResolveNote(event.target.value);
              setResolveError(null);
            }}
          />
          <p
            id={`${resolveNoteId}-count`}
            className={`mt-2 text-xs font-bold tabular-nums ${
              resolveNoteOverLimit ? 'text-rose-700' : 'text-slate-500'
            }`}
          >
            {overLimitText(trimmedResolveNote.length, MAX_ACTIVITY_NOTE_LENGTH)}
          </p>
          {resolveError ? (
            <p
              id={`${resolveNoteId}-error`}
              role="alert"
              className="mt-1 flex gap-1.5 text-xs font-bold text-rose-700"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{resolveError}</span>
            </p>
          ) : null}
        </div>

        <button type="submit" className={`${ui.btnSecondary} mt-3`} disabled={busy}>
          {pending === 'resolve' ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          )}
          {pending === 'resolve' ? 'Marking resolved…' : 'Mark resolved'}
        </button>
      </form>

      {/* ---------------------------------------------------------------- */}
      {/* Case status override                                             */}
      {/* ---------------------------------------------------------------- */}
      <form
        noValidate
        aria-busy={pending === 'override'}
        className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submitOverride();
        }}
      >
        <p className={ui.sectionTitle}>
          <SquarePen className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
          Change the case status
        </p>
        <p className="mt-1 text-xs font-semibold text-slate-500">
          The reason, your profile, the time, the previous status, and the new status are stored as one timeline
          entry.
        </p>

        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label className={ui.label} htmlFor={overrideStatusId}>
              New case status
            </label>
            <select
              id={overrideStatusId}
              className={ui.select}
              disabled={busy}
              value={overrideStatus}
              aria-invalid={Boolean(overrideError)}
              aria-describedby={overrideError ? `${overrideStatusId}-error` : undefined}
              onChange={(event) => {
                setOverrideStatus(event.target.value);
                setOverrideError(null);
              }}
            >
              <option value="">Select a case status…</option>
              {CASE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={ui.label} htmlFor={overrideReasonId}>
              Reason for the change (required)
            </label>
            <textarea
              id={overrideReasonId}
              rows={3}
              className={ui.textarea}
              disabled={busy}
              value={overrideReason}
              aria-invalid={Boolean(overrideError) || reasonOverLimit}
              aria-describedby={`${overrideReasonId}-count${overrideError ? ` ${overrideStatusId}-error` : ''}`}
              onChange={(event) => {
                setOverrideReason(event.target.value);
                setOverrideError(null);
              }}
            />
            <p
              id={`${overrideReasonId}-count`}
              className={`mt-2 text-xs font-bold tabular-nums ${
                reasonOverLimit ? 'text-rose-700' : 'text-slate-500'
              }`}
            >
              {overLimitText(trimmedOverrideReason.length, MAX_OVERRIDE_REASON_LENGTH)}
            </p>
          </div>
        </div>

        {overrideError ? (
          <p
            id={`${overrideStatusId}-error`}
            role="alert"
            className="mt-3 flex gap-1.5 text-xs font-bold text-rose-700"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{overrideError}</span>
          </p>
        ) : null}

        <button type="submit" className={`${ui.btnSecondary} mt-3`} disabled={busy}>
          {pending === 'override' ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <SquarePen className="h-4 w-4" aria-hidden="true" />
          )}
          {pending === 'override' ? 'Changing case status…' : 'Change case status'}
        </button>
      </form>
    </section>
  );
}

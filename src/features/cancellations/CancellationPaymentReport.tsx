'use client';

// Cancellation payment report — task 16.9
// (Requirements 18.1, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10).
//
// The cancellations twin of `./CancellationContactPanel` and of `../renewals/RenewalContactComposer`:
// the same card shell, the same field tokens from `nhwd-shared/ui`, the same rule that a rejection
// keeps every entered value on screen, the same `role="alert"` / `aria-describedby` / `aria-invalid`
// wiring on every error, and the same `onChanged` callback reporting what the write changed.
//
// One write lives here and no other component performs it: `recordPaymentReport`. It goes through
// `./api`, the single data-access module for this tab. This file opens no Supabase client and calls
// no database function of its own, which is how Requirement 18.9's "leaves every existing
// Communication_Record unchanged" holds structurally rather than by discipline — no code path here
// can reach `cancellation_communications`.
//
// `api.recordPaymentReport` owns the stored side: the note bound, the amount range, the reference
// length, the evidence limits checked before the first upload, the closed-case refusal, the
// `Payment Reported` / `Verify Payment` case write, and the one `cancellation_events` entry of
// Requirement 18.9. What this file owns is the part the data-access module deliberately does not:
// the Requirement 18.4 deadline, and rejecting a submission locally so the entered values survive.
//
// **Readings recorded where a criterion leaves something open.**
//
//  1. *The Requirement 18.4 deadline is computed here, not in `api.ts`.* The rule counts Monday
//     through Friday and excludes agency-configured holidays, which is a pure computation over
//     `cancellation_settings.holidays` and a calendar date — no business of a data-access module.
//     `recordPaymentReport` therefore takes `followUpDeadline` as an input, and
//     `paymentReportFollowUpDeadline` below is the one place the rule is expressed. The calendar
//     arithmetic itself is `addDays` and `currentBusinessDate` from `../renewals/derive`, reused
//     rather than reimplemented, so the agency time zone and the epoch-day arithmetic have one
//     definition across both tabs.
//  2. *"The end of the second business day" is stored as the last instant of that calendar date
//     read as UTC.* `followUpDeadlinePassed` in `./derive` compares the UTC calendar date of the
//     stored deadline against the current business date and treats equality as due
//     (Requirement 16.8), so a deadline whose UTC date is the second business day puts the case in
//     Needs Action on that day — which is what "you have until the end of today" means. Shifting
//     it to the following midnight would surface the case only after it had already expired.
//  3. *The effective-date clamp is UTC midnight of that date, matching `domain/escalation`.* Its
//     reading 7 established the convention: `cancellation_effective_date` is a `date` with no time
//     component, and UTC midnight is the earlier of the two candidate instants for
//     `America/New_York`, so clamping there can only pull the deadline earlier than the moment the
//     policy cancels in agency local time. Both branches of the deadline therefore carry the UTC
//     calendar date of the day they name, and reading 2 holds for either.
//  4. *The clamp applies only where the effective date is strictly earlier.* Requirement 18.4 says
//     "WHERE the cancellation effective date is earlier than that second business day", so the two
//     are compared as calendar dates and equality is not a clamp. Nothing downstream can tell the
//     two apart at equality anyway — both instants fall on the same UTC calendar date (reading 2) —
//     so the criterion is followed word for word rather than approximated with a minimum.
//  5. *An unreadable effective date leaves the deadline unclamped.* `parseCancellationDate` reads
//     `YYYY-MM-DD` and `M/D/YYYY` and nothing else, and an unparseable value names no date to clamp
//     against. `domain/escalation.followUpDeadline` makes the same choice for the same reason.
//  6. *A holiday list that leaves no second business day refuses the submission.* The walk is
//     capped at one year. A `holidays` value covering every date in it has no second business day,
//     so there is no deadline to write and the panel says so and stores nothing, rather than
//     falling back to a plain calendar date the criterion does not name.
//  7. *Evidence limits are checked as files are staged, before any upload.* Requirements 18.10 and
//     17.9 require a rejected submission to store no evidence file at all. `api.ts` checks the same
//     two limits before its first upload, so the guarantee does not depend on this file; staging is
//     where the message can name the offending file and its size, which is what Requirement 18.10
//     asks to be displayed.
//  8. *A reported amount is read as whole cents, with no floating-point step.*
//     `cancellation_payment_reports.reported_amount` is `numeric(12,2)`, so a value carrying a third
//     decimal place names no storable amount and is refused with the field named rather than
//     silently rounded — the same reading `import/fields.parseAmountDue` applies to `amount_due`,
//     and the same currency grammar: an optional symbol, comma thousands groups, and at most two
//     decimal places. Rounding in binary floating point would also be wrong rather than merely
//     surprising: `1.005 * 100` is `100.49999999999999`, so a rounded preview would read `1.00`
//     while PostgreSQL's exact decimal arithmetic stored `1.01`. Parsing to cents keeps the preview
//     and the range check on the value that actually lands — the same advisory-preview convention
//     `./CancellationContactPanel` uses for a normalized contact value.
//  9. *A closed case keeps its form and loses its submit control.* Requirement 18.8 refuses the
//     submission on a case already Reinstated, Cancelled, Resolved, Invalid, or Duplicate. The
//     fields stay on screen so a case another user closed mid-draft does not discard what was
//     typed, the closed-case reason is announced, and a submission attempted anyway is refused here
//     with nothing written and the case status, next required action, and deadline untouched.
// 10. *The escalation re-evaluation is requested here, not performed here.* Requirement 20.6 raises
//     the `Payment Reported` escalation as soon as the case reaches that status, and the evaluator
//     writes `cancellation_escalations` and `user_notifications` with server-side scope
//     (`scheduler/`), which a browser component must not do. Every success reports
//     `escalationReevaluationDue` through `onChanged` and the container runs the evaluation.
// 11. *The pending-send count is asked for, never guessed.* `recordPaymentReport` recomputes
//     Communication_Status only when the count is supplied and leaves the stored value alone
//     otherwise. Only the container holds it — it is derived from the cancellation effective date
//     and stored nowhere — so it arrives as `pendingSends`, and a case the container cannot answer
//     for is left alone and told so: guessing zero would silently move a `Scheduled` case to
//     `Not Scheduled`.

import { AlertTriangle, BadgeDollarSign, CalendarClock, LoaderCircle, Paperclip, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import { AGENCY_TIME_ZONE, addDays, currentBusinessDate } from '../renewals/derive';
import { megabytes } from '../renewals/format';
import {
  MAX_ACTIVITY_NOTE_LENGTH,
  MAX_CONFIRMATION_REFERENCE_LENGTH,
  MAX_EVIDENCE_FILES,
  MAX_EVIDENCE_SIZE_BYTES,
  MAX_REPORTED_AMOUNT,
  MIN_REPORTED_AMOUNT,
  TERMINAL_CASE_STATUSES,
  recordPaymentReport,
  type CancellationCase,
  type CancellationPaymentReport as StoredPaymentReport,
  type CancellationSettings,
  type CaseStatus,
  type NextRequiredAction,
} from './api';
import { amountDueCell } from './derive';
import { parseCancellationDate } from './import/fields';

// ---------------------------------------------------------------------------
// The stored values Requirement 18 fixes
// ---------------------------------------------------------------------------

/**
 * Requirement 18.1: the Case_Status a stored payment report sets, and Requirement 18.3: the next
 * required action it sets. Both are narrowed with `satisfies` rather than annotated, so the change
 * record reports the one value each criterion fixes while still being checked against the stored
 * vocabulary — a rename in `domain/communication-status` breaks this file rather than passing.
 */
export const PAYMENT_REPORTED_CASE_STATUS = 'Payment Reported' as const satisfies CaseStatus;
export const VERIFY_PAYMENT_ACTION = 'Verify Payment' as const satisfies NextRequiredAction;

/** Requirement 18.5: note text of 1 to 2,000 characters, measured after trimming. */
export const MIN_PAYMENT_REPORT_NOTE_LENGTH = 1;

/** Requirement 18.4: the deadline is the *second* business day after the report date. */
export const PAYMENT_REPORT_BUSINESS_DAYS = 2;

/**
 * How far the business-day walk looks before giving up — one year (reading 6). A `holidays` value
 * covering every date in that span names no second business day, and the panel refuses rather than
 * inventing one.
 */
const BUSINESS_DAY_WALK_LIMIT = 366;

/** Requirement 18.8: the five Case_Status values a payment report is refused on. */
const CLOSED_CASE_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>(TERMINAL_CASE_STATUSES);

/**
 * The currency grammar of `import/fields.AMOUNT_DUE_PATTERN`: an optional currency symbol, digits
 * with well-formed comma thousands groups, and at most two decimal places (reading 8). No sign, so
 * a negative value names no amount and is refused.
 */
const AMOUNT_PATTERN = /^[$€£¥]?(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/;

const AMOUNT_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Requirement 18.6's bounds in whole cents, so the range check needs no floating point. */
const MIN_REPORTED_CENTS = Math.round(MIN_REPORTED_AMOUNT * 100);
const MAX_REPORTED_CENTS = Math.round(MAX_REPORTED_AMOUNT * 100);

const FILE_ACCEPT = 'image/*,application/pdf,.txt,.csv,.doc,.docx,.xls,.xlsx';

// ---------------------------------------------------------------------------
// Requirement 18.4 — the follow-up deadline
// ---------------------------------------------------------------------------

/** Sunday and Saturday as `Date#getUTCDay` reports them. */
const WEEKEND_DAYS: ReadonlySet<number> = new Set([0, 6]);

/**
 * `cancellation_settings.holidays` as a set of canonical `YYYY-MM-DD` dates.
 *
 * Each entry goes through `parseCancellationDate`, the importer's one date reader, so a holiday
 * written `7/4/2026` counts exactly as one written `2026-07-04`. An entry naming no readable date
 * is dropped rather than treated as a holiday: a typo must not silently push a deadline out.
 */
export function normalizeHolidays(holidays: readonly string[] | null | undefined): Set<string> {
  const dates = new Set<string>();
  for (const entry of holidays ?? []) {
    const parsed = parseCancellationDate(entry);
    if (parsed.ok) dates.add(parsed.date);
  }
  return dates;
}

/**
 * True for a business day under Requirement 18.4: Monday through Friday, and not an
 * agency-configured holiday. `date` is a canonical `YYYY-MM-DD`, read as UTC so the weekday is the
 * calendar's own and carries no time-zone offset.
 */
export function isBusinessDay(date: string, holidays: ReadonlySet<string>): boolean {
  const at = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(at)) return false;
  if (WEEKEND_DAYS.has(new Date(at).getUTCDay())) return false;
  return !holidays.has(date);
}

/**
 * The `count`-th business day strictly after `date`, or `null` where the configured holidays leave
 * none within a year (reading 6).
 *
 * The walk steps one calendar day at a time through `addDays` — the renewals module's epoch-day
 * arithmetic, reused rather than reimplemented — and counts only the days `isBusinessDay` admits.
 * The report date itself is never counted: Requirement 18.4 says "after the report date".
 */
export function nthBusinessDayAfter(
  date: string,
  count: number,
  holidays: ReadonlySet<string>,
): string | null {
  if (count < 1) return date;
  let cursor = date;
  let found = 0;
  for (let step = 0; step < BUSINESS_DAY_WALK_LIMIT; step += 1) {
    cursor = addDays(cursor, 1);
    if (!isBusinessDay(cursor, holidays)) continue;
    found += 1;
    if (found === count) return cursor;
  }
  return null;
}

/** The Requirement 18.4 deadline, and the facts behind it, for the notice and the audit detail. */
export interface PaymentReportDeadline {
  /** `cancellation_cases.follow_up_deadline` as a `timestamptz` (readings 2 and 3). */
  deadline: string;
  /** The calendar date the deadline names, `YYYY-MM-DD`. */
  deadlineDate: string;
  /** The second business day after the report date, before the clamp. */
  secondBusinessDay: string;
  /** True where the cancellation effective date pulled the deadline earlier (reading 4). */
  clampedToEffectiveDate: boolean;
}

/**
 * The Requirement 18.4 follow-up deadline: the end of the second business day after the report
 * date, counting Monday through Friday and excluding Saturday, Sunday, and agency-configured
 * holidays, set instead to the cancellation effective date where that date is earlier.
 *
 * `null` where the configured holidays leave no second business day inside a year (reading 6); the
 * caller refuses the submission rather than writing a deadline the criterion does not name.
 *
 * The two branches carry the UTC calendar date of the day they name (readings 2 and 3): the end of
 * the second business day is the last instant of that date read as UTC, and the clamp is UTC
 * midnight of the effective date, which is the convention `domain/escalation.followUpDeadline`
 * established. `./derive.followUpDeadlinePassed` reads that UTC date, so either branch surfaces the
 * case in Needs Action on the day it names and not a day later.
 */
export function paymentReportFollowUpDeadline(input: {
  /** The report date as `YYYY-MM-DD` — the current business date in the agency time zone. */
  reportDate: string;
  /** `cancellation_cases.cancellation_effective_date`, as stored. */
  cancellationEffectiveDate: string | null | undefined;
  /** `cancellation_settings.holidays`, as stored. */
  holidays?: readonly string[] | null;
}): PaymentReportDeadline | null {
  const secondBusinessDay = nthBusinessDayAfter(
    input.reportDate,
    PAYMENT_REPORT_BUSINESS_DAYS,
    normalizeHolidays(input.holidays),
  );
  if (secondBusinessDay === null) return null;

  const effective = parseCancellationDate(input.cancellationEffectiveDate);
  // Reading 4: strictly earlier, compared as calendar dates, exactly as the criterion words it.
  // Reading 5: an unreadable effective date names no date to clamp against.
  const clamped = effective.ok && effective.date < secondBusinessDay;

  if (clamped) {
    return {
      deadline: new Date(`${effective.date}T00:00:00.000Z`).toISOString(),
      deadlineDate: effective.date,
      secondBusinessDay,
      clampedToEffectiveDate: true,
    };
  }
  return {
    deadline: new Date(`${secondBusinessDay}T23:59:59.999Z`).toISOString(),
    deadlineDate: secondBusinessDay,
    secondBusinessDay,
    clampedToEffectiveDate: false,
  };
}

// ---------------------------------------------------------------------------
// Requirements 18.6 and 18.7 — the reported amount
// ---------------------------------------------------------------------------

/** What a typed amount resolves to: absent, the value that will be stored, or a named rejection. */
export type ReportedAmountReading =
  | { state: 'absent' }
  | { state: 'accepted'; amount: number; cents: number; display: string }
  | { state: 'rejected'; message: string };

/** Requirement 18.7's wording for an amount that names no storable value in the accepted range. */
export const REPORTED_AMOUNT_REJECTION = `Reported amount must be an amount from ${AMOUNT_FORMAT.format(
  MIN_REPORTED_AMOUNT,
)} to ${AMOUNT_FORMAT.format(
  MAX_REPORTED_AMOUNT,
)}, written to at most two decimal places. Nothing was saved.`;

/**
 * Reads the amount field (Requirements 18.6, 18.7).
 *
 * An empty field is absent and accepted — Requirement 18.6 accepts an absent reported amount.
 * Anything else is read through the importer's currency grammar and converted to whole cents, then
 * range-checked in cents, so neither the check nor the preview passes through binary floating point
 * (reading 8). A third decimal place, a sign, a malformed comma group, and any non-numeric text all
 * name no storable amount and are refused with the field named.
 */
export function readReportedAmount(value: string): ReportedAmountReading {
  const text = value.trim();
  if (text === '') return { state: 'absent' };

  const match = AMOUNT_PATTERN.exec(text);
  if (match === null) return { state: 'rejected', message: REPORTED_AMOUNT_REJECTION };

  const wholeDigits = match[1].split(',').join('').replace(/^0+(?=\d)/, '');
  const fractionDigits = (match[2] ?? '').padEnd(2, '0');
  if (wholeDigits.length > 10) return { state: 'rejected', message: REPORTED_AMOUNT_REJECTION };

  const cents = Number(`${wholeDigits}${fractionDigits}`);
  if (cents < MIN_REPORTED_CENTS || cents > MAX_REPORTED_CENTS) {
    return { state: 'rejected', message: REPORTED_AMOUNT_REJECTION };
  }
  // `cents / 100` is the nearest double to the exact decimal, which is the same double the literal
  // would produce, so the value serializes back as the digits that were entered.
  const amount = cents / 100;
  return { state: 'accepted', amount, cents, display: AMOUNT_FORMAT.format(amount) };
}

/** Requirement 18.7's wording for a reference longer than the stored limit. */
export function confirmationReferenceRejection(length: number): string {
  return `Confirmation reference must be ${MAX_CONFIRMATION_REFERENCE_LENGTH} characters or fewer; this one is ${length.toLocaleString(
    'en-US',
  )}. Nothing was saved.`;
}

/** Requirement 18.5's wording for note text outside 1 to 2,000 trimmed characters. */
export function noteRejection(length: number): string {
  if (length < MIN_PAYMENT_REPORT_NOTE_LENGTH) {
    return 'A payment report requires note text with at least one character that is not a space. Nothing was saved.';
  }
  return `Note text must be ${MAX_ACTIVITY_NOTE_LENGTH.toLocaleString(
    'en-US',
  )} characters or fewer; this one is ${length.toLocaleString('en-US')}. Nothing was saved.`;
}

/** Requirement 18.8's wording for a case that is already closed. */
export function closedCaseRejection(caseStatus: CaseStatus): string {
  return `This cancellation is already ${caseStatus}. A payment report cannot be recorded on a closed case, so the case status, the next required action, and the follow-up deadline are unchanged.`;
}

/** True for the five Case_Status values Requirement 18.8 refuses a payment report on. */
export function isClosedCaseStatus(caseStatus: CaseStatus): boolean {
  return CLOSED_CASE_STATUSES.has(caseStatus);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** The `cancellation_cases` columns this panel reads. One selected row satisfies it. */
export type PaymentReportCase = Pick<
  CancellationCase,
  'case_status' | 'cancellation_effective_date' | 'amount_due'
>;

/** What one stored payment report changed — the container's refetch and re-evaluation input. */
export interface CancellationPaymentReportChange {
  kind: 'payment_reported';
  caseId: string;
  /** The stored `cancellation_payment_reports` row. */
  report: StoredPaymentReport;
  /** Requirement 18.1. */
  caseStatus: typeof PAYMENT_REPORTED_CASE_STATUS;
  /** Requirement 18.3. */
  nextRequiredAction: typeof VERIFY_PAYMENT_ACTION;
  /** Requirement 18.4, with the facts behind it. */
  followUpDeadline: PaymentReportDeadline;
  /** Requirement 20.6: the container owes this case an escalation evaluation — reading 10. */
  escalationReevaluationDue: true;
  /** True where `pendingSends` was supplied, so Communication_Status was recomputed — reading 11. */
  communicationStatusRecomputed: boolean;
}

export interface CancellationPaymentReportProps {
  /** `cancellation_cases.id`. The write is scoped to this case. */
  caseId: string;
  /** The case row, as `getCancellationCase` or `listCancellationCases` returned it. */
  caseRow: PaymentReportCase;
  /** The `cancellation_settings` row, for the Requirement 18.4 holidays. */
  settings?: Pick<CancellationSettings, 'holidays'> | null;
  /**
   * The report date as `YYYY-MM-DD` — the current business date the container computes once per
   * render pass. Defaults to the calendar date in the agency time zone right now.
   */
  businessDate?: string;
  /**
   * The pending Touchpoint channel sends of this case. Absent for a case whose schedule the
   * container has not derived; the stored Communication_Status is then left alone rather than set
   * from a guessed zero — reading 11.
   */
  pendingSends?: number;
  /** Raised after the write lands so the container refetches and re-evaluates escalations. */
  onChanged: (change: CancellationPaymentReportChange) => void | Promise<void>;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** One staged evidence file. Nothing is uploaded until the submission passes every check. */
interface StagedEvidence {
  id: string;
  file: File;
}

export default function CancellationPaymentReport({
  caseId,
  caseRow,
  settings = null,
  businessDate,
  pendingSends,
  onChanged,
  disabled = false,
}: CancellationPaymentReportProps) {
  const baseId = useId();

  // Draft state. Nothing here is cleared by a rejection, on any path.
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [evidence, setEvidence] = useState<StagedEvidence[]>([]);

  const [noteError, setNoteError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const nextEvidenceId = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const noteId = `${baseId}-note`;
  const amountId = `${baseId}-amount`;
  const referenceId = `${baseId}-reference`;
  const evidenceId = `${baseId}-evidence`;

  const closed = isClosedCaseStatus(caseRow.case_status);
  const busy = disabled || submitting;
  const trimmedNote = note.trim();
  const noteOverLimit = trimmedNote.length > MAX_ACTIVITY_NOTE_LENGTH;
  const amountReading = readReportedAmount(amount);
  const referenceLength = reference.trim().length;
  const amountDue = amountDueCell(caseRow);

  // The report date, and the deadline the write will set. Both are derived on every render pass so
  // the preview cannot drift from what a submission stores.
  const reportDate = businessDate ?? currentBusinessDate(new Date(), AGENCY_TIME_ZONE);
  const deadline = paymentReportFollowUpDeadline({
    reportDate,
    cancellationEffectiveDate: caseRow.cancellation_effective_date,
    holidays: settings?.holidays,
  });

  /**
   * Stages evidence files (Requirements 18.10, 17.9) — reading 7.
   *
   * Each file is checked for size first and then against the ten-file ceiling, and only the first
   * limit that actually fails is reported, so a rejected oversized file does not also report the
   * count. Files that pass are kept, and nothing is uploaded until the submission passes every
   * check, so a rejected submission stores no evidence file at all.
   */
  function stageEvidence(selected: readonly File[]): void {
    if (selected.length === 0) return;
    const accepted: StagedEvidence[] = [];
    let failure: string | null = null;

    for (const file of selected) {
      if (file.size > MAX_EVIDENCE_SIZE_BYTES) {
        failure ??= `"${file.name}" is ${megabytes(
          file.size,
        )}. The limit is 100 MB per evidence file, so it was not attached and nothing was saved.`;
        continue;
      }
      if (evidence.length + accepted.length >= MAX_EVIDENCE_FILES) {
        failure ??= `"${file.name}" was not attached. One payment report holds at most ${MAX_EVIDENCE_FILES} evidence files.`;
        continue;
      }
      nextEvidenceId.current += 1;
      accepted.push({ id: `evidence-${nextEvidenceId.current}`, file });
    }

    setNotice(null);
    setEvidenceError(failure);
    if (accepted.length > 0) {
      setEvidence((current) => [...current, ...accepted].slice(0, MAX_EVIDENCE_FILES));
    }
  }

  function removeEvidence(id: string): void {
    setEvidence((current) => current.filter((item) => item.id !== id));
    setEvidenceError(null);
  }

  /**
   * Validates, then records the payment report.
   *
   * Every rejection below names the field it refuses, writes nothing, and leaves the entered values
   * on screen (Requirements 18.7, 18.8, 18.10). Each check runs before the call, so a rejected
   * submission never reaches storage and the case status, the next required action, and the
   * follow-up deadline are all untouched.
   */
  async function submit(): Promise<void> {
    setSubmitError(null);
    setNoteError(null);
    setAmountError(null);
    setReferenceError(null);

    // Requirement 18.8. Reading 9: refused here as well as in `api.ts`, so a case closed while this
    // draft was open is refused with the typed values retained.
    if (closed) {
      setSubmitError(closedCaseRejection(caseRow.case_status));
      return;
    }

    const noteFailure =
      trimmedNote.length < MIN_PAYMENT_REPORT_NOTE_LENGTH || noteOverLimit
        ? noteRejection(trimmedNote.length)
        : null;
    const amountFailure = amountReading.state === 'rejected' ? amountReading.message : null;
    const referenceFailure =
      referenceLength > MAX_CONFIRMATION_REFERENCE_LENGTH
        ? confirmationReferenceRejection(referenceLength)
        : null;

    setNoteError(noteFailure);
    setAmountError(amountFailure);
    setReferenceError(referenceFailure);
    if (noteFailure !== null || amountFailure !== null || referenceFailure !== null) {
      setNotice(null);
      return;
    }

    // Reading 6: no second business day means no Requirement 18.4 deadline to write.
    if (deadline === null) {
      setSubmitError(
        'The configured holiday list leaves no second business day within the next year, so the follow-up deadline cannot be set. Nothing was saved. Ask a manager to correct the cancellation holidays.',
      );
      return;
    }

    setSubmitting(true);
    setNotice(null);
    try {
      const stored = await recordPaymentReport({
        caseId,
        note: trimmedNote,
        reportedAmount: amountReading.state === 'accepted' ? amountReading.amount : null,
        confirmationReference: reference.trim() === '' ? null : reference.trim(),
        followUpDeadline: deadline.deadline,
        files: evidence.map((item) => item.file),
        // Supplied where the container knows it, absent where it does not — reading 11.
        pendingSends,
      });

      if (mountedRef.current) {
        setNote('');
        setAmount('');
        setReference('');
        setEvidence([]);
        setEvidenceError(null);
        setNotice(
          `Payment report recorded. This cancellation is now ${PAYMENT_REPORTED_CASE_STATUS}, the next required action is ${VERIFY_PAYMENT_ACTION}, and the follow-up deadline is ${
            deadline.deadlineDate
          }${
            deadline.clampedToEffectiveDate
              ? ' — the cancellation effective date, which falls before the second business day'
              : ', the end of the second business day'
          }. Automatic reminders are paused and every stored communication is unchanged.${
            pendingSends === undefined
              ? ' Communication status is recomputed once the touchpoint schedule for this case loads.'
              : ''
          }`,
        );
      }

      await onChanged({
        kind: 'payment_reported',
        caseId,
        report: stored,
        caseStatus: PAYMENT_REPORTED_CASE_STATUS,
        nextRequiredAction: VERIFY_PAYMENT_ACTION,
        followUpDeadline: deadline,
        escalationReevaluationDue: true,
        communicationStatusRecomputed: pendingSends !== undefined,
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'The payment report could not be saved.';
      if (mountedRef.current) {
        // `api.ts` refuses an oversized or failed upload with the file named, so that message
        // belongs on the evidence field rather than in the panel-wide line (Requirement 18.10).
        if (/evidence|upload|100 MB/i.test(message)) setEvidenceError(message);
        else setSubmitError(message);
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <section className={`${ui.card} ${ui.cardPad} space-y-5`}>
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-2xl bg-emerald-50 text-emerald-700">
          <BadgeDollarSign className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h3 className="font-black text-slate-950">Report a customer payment</h3>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            Recording a payment report moves this cancellation to {PAYMENT_REPORTED_CASE_STATUS}, sets the next
            required action to {VERIFY_PAYMENT_ACTION}, and pauses automatic reminders until the payment is verified.
            The amount, the confirmation reference, and evidence are all optional. Every stored communication is left
            exactly as it is.
          </p>
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {notice ?? ''}
      </p>
      {notice ? <p className={ui.success}>{notice}</p> : null}

      {/* Requirement 18.8 — reading 9. Announced, and stated in words rather than by colour. */}
      {closed ? (
        <p role="alert" className={`${ui.error} flex gap-2`}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{closedCaseRejection(caseRow.case_status)}</span>
        </p>
      ) : null}

      {/* Requirement 18.4 — what the write will set, derived from the same call the write uses. */}
      <p className={`${ui.info} flex gap-2`}>
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          {deadline === null ? (
            <>
              No second business day falls within the next year under the configured cancellation holidays, so no
              follow-up deadline can be set. A manager needs to correct the holiday list before a payment report can be
              recorded.
            </>
          ) : (
            <>
              Reported today ({reportDate}), the follow-up deadline becomes{' '}
              <strong className="font-black">{deadline.deadlineDate}</strong>
              {deadline.clampedToEffectiveDate ? (
                <>
                  {' '}
                  — the cancellation effective date, which falls before the second business day (
                  {deadline.secondBusinessDay}).
                </>
              ) : (
                <> — the end of the second business day, skipping weekends and agency holidays.</>
              )}
            </>
          )}
        </span>
      </p>

      <form
        noValidate
        aria-busy={submitting}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label className={ui.label} htmlFor={noteId}>
            What the customer reported (required)
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
            className={`mt-2 text-xs font-bold tabular-nums ${noteOverLimit ? 'text-rose-700' : 'text-slate-500'}`}
          >
            {trimmedNote.length.toLocaleString('en-US')} of {MAX_ACTIVITY_NOTE_LENGTH.toLocaleString('en-US')}{' '}
            characters
            {noteOverLimit ? ' — over the limit' : ''}
          </p>
          {noteError ? (
            <p id={`${noteId}-error`} role="alert" className="mt-1 flex gap-1.5 text-xs font-bold text-rose-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{noteError}</span>
            </p>
          ) : null}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className={ui.label} htmlFor={amountId}>
              Amount the customer reported paying (optional)
            </label>
            <input
              id={amountId}
              className={ui.input}
              disabled={busy}
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              aria-invalid={Boolean(amountError) || amountReading.state === 'rejected'}
              aria-describedby={`${amountId}-hint${amountError ? ` ${amountId}-error` : ''}`}
              onChange={(event) => {
                setAmount(event.target.value);
                setAmountError(null);
              }}
            />
            {/* Advisory only: `submit` reads the same function and its result is the one that counts. */}
            <p
              id={`${amountId}-hint`}
              aria-live="polite"
              className={`mt-2 text-xs font-bold ${
                amountReading.state === 'rejected' ? 'text-amber-700' : 'text-slate-500'
              }`}
            >
              {amountReading.state === 'absent'
                ? `Leave empty if the amount is unknown. Amount due on this cancellation: ${amountDue}.`
                : amountReading.state === 'accepted'
                  ? `Stored as ${amountReading.display}. Amount due on this cancellation: ${amountDue}.`
                  : `Enter an amount from ${AMOUNT_FORMAT.format(MIN_REPORTED_AMOUNT)} to ${AMOUNT_FORMAT.format(
                      MAX_REPORTED_AMOUNT,
                    )} with at most two decimal places, or leave the field empty.`}
            </p>
            {amountError ? (
              <p id={`${amountId}-error`} role="alert" className="mt-1 flex gap-1.5 text-xs font-bold text-rose-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{amountError}</span>
              </p>
            ) : null}
          </div>

          <div>
            <label className={ui.label} htmlFor={referenceId}>
              Confirmation reference (optional)
            </label>
            <input
              id={referenceId}
              className={ui.input}
              disabled={busy}
              maxLength={MAX_CONFIRMATION_REFERENCE_LENGTH}
              value={reference}
              aria-invalid={Boolean(referenceError)}
              aria-describedby={`${referenceId}-count${referenceError ? ` ${referenceId}-error` : ''}`}
              onChange={(event) => {
                setReference(event.target.value);
                setReferenceError(null);
              }}
            />
            <p
              id={`${referenceId}-count`}
              className={`mt-2 text-xs font-bold tabular-nums ${
                referenceLength > MAX_CONFIRMATION_REFERENCE_LENGTH ? 'text-rose-700' : 'text-slate-500'
              }`}
            >
              {referenceLength.toLocaleString('en-US')} of {MAX_CONFIRMATION_REFERENCE_LENGTH} characters — the
              carrier confirmation number, receipt number, or transaction id.
            </p>
            {referenceError ? (
              <p
                id={`${referenceId}-error`}
                role="alert"
                className="mt-1 flex gap-1.5 text-xs font-bold text-rose-700"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{referenceError}</span>
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-4">
          <label className={ui.label} htmlFor={evidenceId}>
            Attach payment evidence (optional)
          </label>
          <input
            id={evidenceId}
            type="file"
            multiple
            accept={FILE_ACCEPT}
            className={`${ui.input} file:mr-3 file:rounded-lg file:border-0 file:bg-[#eef3fb] file:px-3 file:py-1.5 file:text-xs file:font-black file:text-[#223f7a]`}
            disabled={busy}
            aria-invalid={Boolean(evidenceError)}
            aria-describedby={`${evidenceId}-count${evidenceError ? ` ${evidenceId}-error` : ''}`}
            onChange={(event) => {
              stageEvidence(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <p id={`${evidenceId}-count`} aria-live="polite" className="mt-2 text-xs font-bold tabular-nums text-slate-500">
            {evidence.length} of {MAX_EVIDENCE_FILES} evidence files attached, 100 MB each
            {evidence.length >= MAX_EVIDENCE_FILES ? ' — limit reached' : ''}
          </p>
          {evidenceError ? (
            <p id={`${evidenceId}-error`} role="alert" className="mt-1 flex gap-1.5 text-xs font-bold text-rose-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{evidenceError}</span>
            </p>
          ) : null}

          {evidence.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {evidence.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700"
                >
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-[#223f7a]" aria-hidden="true" />
                  <span className="truncate">{item.file.name}</span>
                  <span className="shrink-0 font-semibold text-slate-400">{megabytes(item.file.size)}</span>
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 font-black text-slate-500 transition hover:bg-slate-200 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-[#7890bc] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={busy}
                    onClick={() => removeEvidence(item.id)}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    Remove
                    <span className="sr-only"> {item.file.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {submitError ? (
          <p role="alert" className={`${ui.error} mt-4 flex gap-2`}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{submitError}</span>
          </p>
        ) : null}

        <button type="submit" className={`${ui.btnPrimary} mt-4`} disabled={busy || closed || deadline === null}>
          {submitting ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <BadgeDollarSign className="h-4 w-4" aria-hidden="true" />
          )}
          {submitting ? 'Recording payment report…' : 'Record payment report'}
        </button>
      </form>
    </section>
  );
}

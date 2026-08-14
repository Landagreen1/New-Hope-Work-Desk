'use client';

// Cancellation contact panel — task 16.8
// (Requirements 10.9, 11.1, 11.5, 20.4, 21.1, 21.2, 21.5, 21.6, 21.7, 22.2).
//
// The cancellations twin of `../renewals/RenewalContactComposer`: the same card shell, the same
// field tokens from `nhwd-shared/ui`, the same rule that a rejection keeps every entered value on
// screen, and the same `aria-describedby` / `role="alert"` wiring on every error.
//
// Five writes live here and no other component performs them:
//
//   1. add one Contact_Recipient — `addCancellationContact`
//   2. set a contact's preferred language — `updateContactPreferredLanguage`
//   3. set a contact's authorization status — `updateContactAuthorization`
//   4. record an SMS or email opt-out, and clear one — `recordContactOptOut`, `clearContactOptOut`
//   5. record a customer response — `recordCustomerResponse`
//
// Every one goes through `./api`, which is the single data-access module for this tab. This file
// opens no Supabase client and calls no database function of its own, so Requirement 21.6 holds
// structurally rather than by discipline: no code path here can reach
// `cancellation_communications`, and nothing below updates or deletes a stored communication.
// Requirement 22.2's audit demand is met the same way — `api.ts` writes the previous value, the
// new value, the profile, and the time to `cancellation_events` on every one of these writes.
//
// **Readings recorded where a criterion leaves something open.**
//
//  1. *The pending-send count is asked for, never guessed.* `recomputeCommunicationStatus` needs
//     the number of scheduled Touchpoint sends with no stored Communication_Record, which is
//     derived from the cancellation effective date and stored nowhere. Only the container holds
//     it, so it arrives as `pendingSendsForCase`, and a case the container cannot answer for is
//     left alone: guessing zero would silently move a `Scheduled` case to `Not Scheduled`. Where
//     the count is unknown the panel says so instead of writing a status.
//  2. *An escalation re-evaluation is requested here, not performed here.* Requirement 20.10 makes
//     a re-evaluation due after every change to a Contact_Recipient, and Requirement 20.4 makes
//     one due for an assistance response. The evaluator writes `cancellation_escalations` and
//     `user_notifications` with server-side scope (`scheduler/`), which a browser component must
//     not do, so every successful write reports `escalationReevaluationDue` through `onChanged`
//     and the container runs the evaluation.
//  3. *A rejected preferred language is retained by dropping the draft.* Each select reads the
//     stored value unless a draft exists for that contact. A rejection — local or from `api.ts` —
//     deletes the draft, so the control snaps back to the stored value in the same render that
//     shows the error naming the three accepted values (Requirement 11.1).
//  4. *The response types `Opted out of SMS` and `Opted out of email` record a response, not a
//     suppression.* Requirement 21.5 stores the response; Requirements 21.1 and 21.2 tie a
//     suppression to an identified Contact_Recipient, and only the per-contact opt-out control
//     identifies one. So recording one of those two types shows the reminder to record the opt-out
//     on the contact that asked, rather than guessing which value the customer meant.
//  5. *One write at a time.* `pending` names the write in flight and every control on the panel is
//     disabled while it is set, so two writes cannot interleave against one contact row.
//  6. *Clearing an opt-out is Manager_Role's.* Requirement 21.9 reserves it, and `super_admin`
//     holds every `manager` permission, so the gate is `isBroadManagerRole`. An Agent_Role profile
//     is told the state and who can change it rather than shown a control that will be refused.

import {
  AlertTriangle,
  BellOff,
  CheckCircle2,
  Languages,
  LoaderCircle,
  Mail,
  MessageSquare,
  Phone,
  Save,
  ShieldCheck,
  Undo2,
  UserPlus,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { canManageRenewals } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import { ui } from '../nhwd-shared/ui';
import {
  ASSISTANCE_REQUEST_RESPONSE_TYPES,
  AUTHORIZATION_STATUSES,
  CUSTOMER_RESPONSE_TYPES,
  MAX_ACTIVITY_NOTE_LENGTH,
  PREFERRED_LANGUAGES,
  addCancellationContact,
  clearContactOptOut,
  recomputeCommunicationStatus,
  recordContactOptOut,
  recordCustomerResponse,
  updateContactAuthorization,
  updateContactPreferredLanguage,
  type CancellationContact,
  type CustomerResponseType,
} from './api';
import { isActionVisibleToRole } from './derive';
import {
  contactSuppressionColumn,
  suppressionChannelForContactChannel,
} from './domain/suppression';
import { normalizeEmailSegment, normalizePhoneSegment } from './import/contacts';
import type {
  ContactAuthorizationStatus,
  ContactChannel,
  ContactPreferredLanguage,
} from './import/contacts';

// ---------------------------------------------------------------------------
// Rules this panel states in its own words
// ---------------------------------------------------------------------------

/**
 * The two response types whose note text must carry at least one non-whitespace character
 * (Requirement 21.5). `api.ts` holds the same set privately and is the authority; this copy only
 * moves the message next to the note field instead of into the panel-wide error line.
 */
export const NOTE_REQUIRED_RESPONSE_TYPES = [
  'Assistance requested',
  'Other',
] as const satisfies readonly CustomerResponseType[];

/**
 * Requirement 11.1: a rejection names the three accepted values and states that the stored value
 * is unchanged. Built from `PREFERRED_LANGUAGES` and worded as `api.ts` words it, so the local
 * rejection and the server-side one read identically.
 */
export const PREFERRED_LANGUAGE_REJECTION = `Preferred language must be ${PREFERRED_LANGUAGES.join(
  ', ',
)}. The stored value is unchanged.`;

/** Requirement 10.9: the same sentence for the three authorization statuses. */
export const AUTHORIZATION_STATUS_REJECTION = `Authorization status must be ${AUTHORIZATION_STATUSES.join(
  ', ',
)}. The stored value is unchanged.`;

/** Requirement 21.9: reason text of 1 to 2,000 characters, the activity-note bound. */
export const MAX_OPT_OUT_REASON_LENGTH = MAX_ACTIVITY_NOTE_LENGTH;

/** Narrows a submitted string to the three values of Requirement 11.1. */
export function isPermittedPreferredLanguage(
  value: string | null | undefined,
): value is ContactPreferredLanguage {
  return (PREFERRED_LANGUAGES as readonly string[]).includes(value ?? '');
}

/** Narrows a submitted string to the three values of Requirement 10.9. */
export function isPermittedAuthorizationStatus(
  value: string | null | undefined,
): value is ContactAuthorizationStatus {
  return (AUTHORIZATION_STATUSES as readonly string[]).includes(value ?? '');
}

/** Narrows a submitted string to the six response types of Requirement 21.5. */
export function isCustomerResponseType(
  value: string | null | undefined,
): value is CustomerResponseType {
  return (CUSTOMER_RESPONSE_TYPES as readonly string[]).includes(value ?? '');
}

/** True where Requirement 21.5 requires non-blank note text for a response type. */
export function noteRequiredForResponseType(type: CustomerResponseType): boolean {
  return (NOTE_REQUIRED_RESPONSE_TYPES as readonly CustomerResponseType[]).includes(type);
}

/** True for the two response types that set the case assistance flag (Requirements 20.4, 21.7). */
export function requestsAssistance(type: CustomerResponseType): boolean {
  return (ASSISTANCE_REQUEST_RESPONSE_TYPES as readonly CustomerResponseType[]).includes(type);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Which write landed, for the container's refetch and escalation re-evaluation. */
export type CancellationContactChangeKind =
  | 'contact_added'
  | 'preferred_language_changed'
  | 'authorization_changed'
  | 'opt_out_recorded'
  | 'opt_out_cleared'
  | 'customer_response_recorded';

/** What one successful write changed — reading 2. */
export interface CancellationContactChange {
  kind: CancellationContactChangeKind;
  /**
   * Every case whose stored state the write touched. One entry for a contact edit or a response;
   * an opt-out spans every case holding that contact value (Requirements 21.1, 21.2).
   */
  affectedCaseIds: string[];
  /** Requirements 20.4, 20.10: the container owes these cases an escalation evaluation. */
  escalationReevaluationDue: boolean;
  /** The cases whose Communication_Status was recomputed, because their count was known. */
  recomputedCaseIds: string[];
}

export interface CancellationContactPanelProps {
  /** `cancellation_cases.id`. Every write on this panel is scoped to this case. */
  caseId: string;
  /** The case's Contact_Recipient rows, as `listCancellationContacts` returned them (Req 17.2). */
  contacts: readonly CancellationContact[];
  /**
   * The signed-in profile's role. `null` reads as the unrestricted Manager_Role view, matching
   * `isActionVisibleToRole`; row level security remains the authorization boundary either way.
   */
  role?: AppRole | null;
  /**
   * The pending Touchpoint channel sends of one case — the count `recomputeCommunicationStatus`
   * needs. Return `undefined` for a case whose schedule the container has not derived; the panel
   * then leaves that case's stored status alone rather than guessing zero — reading 1.
   */
  pendingSendsForCase?: (caseId: string) => number | undefined;
  /** Raised after each successful write so the container refetches and re-evaluates escalations. */
  onChanged: (change: CancellationContactChange) => void | Promise<void>;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Small presentation helpers
// ---------------------------------------------------------------------------

const CHANNEL_LABEL: Record<ContactChannel, string> = { phone: 'Phone', email: 'Email' };

function badge(tone: string, text: string) {
  return <span className={`${ui.badge} ${ui.badgeTone[tone]}`}>{text}</span>;
}

function caseCountText(count: number): string {
  return count === 1 ? '1 cancellation' : `${count} cancellations`;
}

/** A local `datetime-local` value as an instant, or `undefined` to let the store time it. */
function isoFromLocalDateTime(value: string): string | undefined {
  if (value.trim() === '') return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/**
 * Advisory feedback on a typed contact value, produced by the importer's own helpers so the panel
 * previews exactly the value that will be stored (Requirements 10.3, 10.4, 10.5, 10.7). It is
 * feedback only: `addCancellationContact` normalizes and validates again on the write path and its
 * result is the one that counts, so nothing here gates the submission.
 */
function contactPreview(
  channel: ContactChannel,
  value: string,
): { normalizedValue: string; valid: boolean; detail: string | null } | null {
  if (value.trim() === '') return null;
  if (channel === 'phone') {
    const normalization = normalizePhoneSegment(value);
    return {
      normalizedValue: normalization.normalizedValue,
      valid: normalization.validationStatus === 'valid',
      detail:
        normalization.validationStatus === 'valid'
          ? null
          : 'Enter a 10-digit number, an 11-digit number beginning with 1, or a plus-prefixed international number.',
    };
  }
  const normalization = normalizeEmailSegment(value);
  return {
    normalizedValue: normalization.normalizedValue,
    valid: normalization.validationStatus === 'valid',
    detail: normalization.failures[0]?.message ?? null,
  };
}

/** The result of recomputing the statuses a write made due — reading 1. */
interface RecomputeReport {
  recomputed: string[];
  /** Cases left alone because their pending-send count was unknown, or the recompute failed. */
  note: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CancellationContactPanel({
  caseId,
  contacts,
  role = null,
  pendingSendsForCase,
  onChanged,
  disabled = false,
}: CancellationContactPanelProps) {
  const baseId = useId();

  // Add-contact draft. Nothing here is cleared by a rejection.
  const [channel, setChannel] = useState<ContactChannel>('phone');
  const [value, setValue] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactRole, setContactRole] = useState('');
  const [addLanguage, setAddLanguage] = useState<ContactPreferredLanguage | ''>('');
  const [addAuthorization, setAddAuthorization] = useState<ContactAuthorizationStatus>('Unknown');
  const [addError, setAddError] = useState<string | null>(null);

  // Per-contact drafts, keyed by contact id. An absent entry means "show the stored value".
  const [languageDrafts, setLanguageDrafts] = useState<Record<string, string>>({});
  const [authorizationDrafts, setAuthorizationDrafts] = useState<Record<string, string>>({});
  const [optOutReasons, setOptOutReasons] = useState<Record<string, string>>({});
  const [clearReasons, setClearReasons] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Customer response draft.
  const [responseType, setResponseType] = useState<CustomerResponseType | ''>('');
  const [responseChannel, setResponseChannel] = useState('');
  const [responseTime, setResponseTime] = useState('');
  const [responseNote, setResponseNote] = useState('');
  const [responseTypeError, setResponseTypeError] = useState<string | null>(null);
  const [responseNoteError, setResponseNoteError] = useState<string | null>(null);

  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const manager = canManageRenewals(role ?? 'manager');
  // Requirement 17.10 by way of `derive.ts`: Record Customer Response is shown to every role, and
  // the gate is read from the one function that decides control visibility rather than restated.
  const responseVisible = isActionVisibleToRole('Record Customer Response', role);
  const busy = disabled || pending !== null;

  const trimmedResponseNote = responseNote.trim();
  const responseNoteOverLimit = trimmedResponseNote.length > MAX_ACTIVITY_NOTE_LENGTH;
  const preview = contactPreview(channel, value);

  function fieldError(key: string): string | null {
    return fieldErrors[key] ?? null;
  }

  function setFieldError(key: string, message: string | null): void {
    setFieldErrors((current) => {
      if (message === null) {
        if (current[key] === undefined) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: message };
    });
  }

  function dropDraft(
    set: React.Dispatch<React.SetStateAction<Record<string, string>>>,
    key: string,
  ): void {
    set((current) => {
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  /**
   * Recomputes Communication_Status for the cases a write made due (Requirement 15.9), for each
   * case the container could supply a pending-send count for — reading 1.
   *
   * Never throws. The write it follows has already landed, so a recompute failure is reported as a
   * sentence on the success notice: raising it as a failure would claim nothing was saved.
   */
  async function recomputeKnown(caseIds: readonly string[]): Promise<RecomputeReport> {
    const unique = [...new Set(caseIds)];
    const recomputed: string[] = [];
    const unknown: string[] = [];
    let failure: string | null = null;

    for (const id of unique) {
      const count = pendingSendsForCase?.(id);
      if (count === undefined) {
        unknown.push(id);
        continue;
      }
      try {
        await recomputeCommunicationStatus(id, count);
        recomputed.push(id);
      } catch (caught) {
        failure ??= caught instanceof Error ? caught.message : 'A communication status was not recomputed.';
      }
    }

    const parts: string[] = [];
    if (unknown.length > 0) {
      parts.push(
        `Communication status for ${caseCountText(unknown.length)} is recomputed once the touchpoint schedule for ${
          unknown.length === 1 ? 'that case' : 'those cases'
        } loads.`,
      );
    }
    if (failure !== null) parts.push(`A communication status was not recomputed: ${failure}`);
    return { recomputed, note: parts.length === 0 ? '' : ` ${parts.join(' ')}` };
  }

  /**
   * Runs one write. On success the notice is shown and `onChanged` is raised; on failure the
   * message is handed to `fail`, which is where each caller attaches it to its own field and, for
   * the two restricted selects, restores the stored value on screen — reading 3.
   */
  async function perform(
    key: string,
    write: () => Promise<{ change: CancellationContactChange; notice: string }>,
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
  // Add contact information (Requirements 10.9, 11.1, 22.2)
  // -------------------------------------------------------------------------

  const addValueId = `${baseId}-add-value`;

  async function submitContact(): Promise<void> {
    setAddError(null);
    await perform(
      'add-contact',
      async () => {
        const stored = await addCancellationContact({
          caseId,
          channel,
          value,
          contactName,
          contactRole,
          preferredLanguage: addLanguage === '' ? null : addLanguage,
          authorizationStatus: addAuthorization,
        });
        const status = await recomputeKnown([caseId]);
        if (mountedRef.current) {
          setValue('');
          setContactName('');
          setContactRole('');
        }
        return {
          change: {
            kind: 'contact_added',
            affectedCaseIds: [caseId],
            escalationReevaluationDue: true,
            recomputedCaseIds: status.recomputed,
          },
          notice: `${CHANNEL_LABEL[stored.channel]} contact ${stored.normalized_value} added as ${
            stored.validation_status
          }, ${stored.authorization_status}.${status.note}`,
        };
      },
      setAddError,
    );
  }

  // -------------------------------------------------------------------------
  // Preferred language and authorization (Requirements 10.9, 11.1, 11.5, 22.2)
  // -------------------------------------------------------------------------

  async function saveLanguage(contact: CancellationContact): Promise<void> {
    const key = `${contact.id}-language`;
    const draft = languageDrafts[contact.id] ?? contact.preferred_language ?? '';
    setFieldError(key, null);

    if (!isPermittedPreferredLanguage(draft)) {
      // No write is attempted, and dropping the draft puts the stored value back on screen in the
      // same render as the message that names the three accepted values (Requirement 11.1).
      dropDraft(setLanguageDrafts, contact.id);
      setFieldError(key, PREFERRED_LANGUAGE_REJECTION);
      return;
    }

    await perform(
      key,
      async () => {
        await updateContactPreferredLanguage(contact.id, draft);
        const status = await recomputeKnown([contact.case_id]);
        dropDraft(setLanguageDrafts, contact.id);
        return {
          change: {
            kind: 'preferred_language_changed',
            affectedCaseIds: [contact.case_id],
            escalationReevaluationDue: true,
            recomputedCaseIds: status.recomputed,
          },
          notice: `Preferred language for ${contact.normalized_value} set to ${draft}. Every message rendered for this contact after now uses it.${status.note}`,
        };
      },
      (message) => {
        dropDraft(setLanguageDrafts, contact.id);
        setFieldError(key, message);
      },
    );
  }

  async function saveAuthorization(contact: CancellationContact): Promise<void> {
    const key = `${contact.id}-authorization`;
    const draft = authorizationDrafts[contact.id] ?? contact.authorization_status;
    setFieldError(key, null);

    if (!isPermittedAuthorizationStatus(draft)) {
      dropDraft(setAuthorizationDrafts, contact.id);
      setFieldError(key, AUTHORIZATION_STATUS_REJECTION);
      return;
    }

    await perform(
      key,
      async () => {
        await updateContactAuthorization(contact.id, draft);
        const status = await recomputeKnown([contact.case_id]);
        dropDraft(setAuthorizationDrafts, contact.id);
        return {
          change: {
            kind: 'authorization_changed',
            affectedCaseIds: [contact.case_id],
            escalationReevaluationDue: true,
            recomputedCaseIds: status.recomputed,
          },
          notice: `Authorization for ${contact.normalized_value} set to ${draft}.${
            draft === 'Not Authorized' ? ' This contact is excluded from every send.' : ''
          }${status.note}`,
        };
      },
      (message) => {
        dropDraft(setAuthorizationDrafts, contact.id);
        setFieldError(key, message);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Opt-out and clear (Requirements 21.1, 21.2, 21.9)
  // -------------------------------------------------------------------------

  async function submitOptOut(contact: CancellationContact): Promise<void> {
    const key = `${contact.id}-opt-out`;
    const suppressionChannel = suppressionChannelForContactChannel(contact.channel);
    const reason = (optOutReasons[contact.id] ?? '').trim();
    setFieldError(key, null);

    if (reason.length > MAX_OPT_OUT_REASON_LENGTH) {
      setFieldError(
        key,
        `Opt-out notes must be ${MAX_OPT_OUT_REASON_LENGTH.toLocaleString('en-US')} characters or fewer; this one is ${reason.length.toLocaleString(
          'en-US',
        )}. Nothing was saved.`,
      );
      return;
    }

    await perform(
      key,
      async () => {
        const result = await recordContactOptOut({
          channel: suppressionChannel,
          normalizedValue: contact.normalized_value,
          reason: reason === '' ? null : reason,
        });
        const status = await recomputeKnown(result.affectedCaseIds);
        dropDraft(setOptOutReasons, contact.id);
        const other = suppressionChannel === 'sms' ? 'Email' : 'SMS';
        return {
          change: {
            kind: 'opt_out_recorded',
            affectedCaseIds: result.affectedCaseIds,
            escalationReevaluationDue: true,
            recomputedCaseIds: status.recomputed,
          },
          notice: `${suppressionChannel === 'sms' ? 'SMS' : 'Email'} opt-out recorded for ${
            result.normalizedValue
          } across ${caseCountText(result.affectedCaseIds.length)}. ${other} delivery is unchanged.${
            result.alreadyInState ? ' That value was already opted out; stale contact flags were repaired.' : ''
          }${status.note}`,
        };
      },
      (message) => setFieldError(key, message),
    );
  }

  async function submitClearOptOut(contact: CancellationContact): Promise<void> {
    const key = `${contact.id}-clear`;
    const suppressionChannel = suppressionChannelForContactChannel(contact.channel);
    const reason = (clearReasons[contact.id] ?? '').trim();
    setFieldError(key, null);

    if (reason === '') {
      setFieldError(
        key,
        'Clearing an opt-out needs reason text with at least one character that is not a space. Nothing was changed.',
      );
      return;
    }
    if (reason.length > MAX_OPT_OUT_REASON_LENGTH) {
      setFieldError(
        key,
        `Reason text must be ${MAX_OPT_OUT_REASON_LENGTH.toLocaleString('en-US')} characters or fewer; this one is ${reason.length.toLocaleString(
          'en-US',
        )}. Nothing was changed.`,
      );
      return;
    }

    await perform(
      key,
      async () => {
        const result = await clearContactOptOut({
          channel: suppressionChannel,
          normalizedValue: contact.normalized_value,
          reason,
        });
        const status = await recomputeKnown(result.affectedCaseIds);
        dropDraft(setClearReasons, contact.id);
        return {
          change: {
            kind: 'opt_out_cleared',
            affectedCaseIds: result.affectedCaseIds,
            escalationReevaluationDue: true,
            recomputedCaseIds: status.recomputed,
          },
          notice: `${suppressionChannel === 'sms' ? 'SMS' : 'Email'} opt-out cleared for ${
            result.normalizedValue
          } across ${caseCountText(
            result.affectedCaseIds.length,
          )}. Every stored communication is unchanged.${status.note}`,
        };
      },
      (message) => setFieldError(key, message),
    );
  }

  // -------------------------------------------------------------------------
  // Customer response (Requirements 20.4, 21.5, 21.6, 21.7)
  // -------------------------------------------------------------------------

  const responseTypeId = `${baseId}-response-type`;
  const responseNoteId = `${baseId}-response-note`;

  async function submitResponse(): Promise<void> {
    const type = responseType;
    setResponseTypeError(null);
    setResponseNoteError(null);

    if (!isCustomerResponseType(type)) {
      setResponseTypeError(
        `Select one of the six customer response types: ${CUSTOMER_RESPONSE_TYPES.join(', ')}. Nothing was saved.`,
      );
      return;
    }
    if (noteRequiredForResponseType(type) && trimmedResponseNote === '') {
      setResponseNoteError(
        `"${type}" requires note text with at least one character that is not a space. Nothing was saved.`,
      );
      return;
    }
    if (responseNoteOverLimit) {
      setResponseNoteError(
        `Note text must be ${MAX_ACTIVITY_NOTE_LENGTH.toLocaleString('en-US')} characters or fewer; this one is ${trimmedResponseNote.length.toLocaleString(
          'en-US',
        )}. Nothing was saved.`,
      );
      return;
    }

    // Supplied where the container knows it, absent where it does not: `recordCustomerResponse`
    // recomputes only on a supplied count and leaves the stored status alone otherwise — reading 1.
    const count = pendingSendsForCase?.(caseId);

    await perform(
      'customer-response',
      async () => {
        const stored = await recordCustomerResponse({
          caseId,
          responseType: type,
          responseChannel: responseChannel.trim() === '' ? null : responseChannel.trim(),
          responseTime: isoFromLocalDateTime(responseTime),
          note: trimmedResponseNote === '' ? null : trimmedResponseNote,
          pendingSends: count,
        });
        if (mountedRef.current) {
          setResponseType('');
          setResponseChannel('');
          setResponseTime('');
          setResponseNote('');
        }
        const assistance = requestsAssistance(stored.response_type);
        return {
          change: {
            kind: 'customer_response_recorded',
            affectedCaseIds: [caseId],
            escalationReevaluationDue: assistance,
            recomputedCaseIds: count === undefined ? [] : [caseId],
          },
          notice: `"${stored.response_type}" recorded. Every stored communication is unchanged.${
            assistance
              ? ' The assistance flag is set on this cancellation and it is escalated as Customer Assistance Requested.'
              : ''
          }${
            stored.response_type === 'Opted out of SMS' || stored.response_type === 'Opted out of email'
              ? ' Record the opt-out on the contact that asked so the suppression is stored.'
              : ''
          }`,
        };
      },
      (message) => setResponseTypeError(message),
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <section className={`${ui.card} ${ui.cardPad} space-y-6`}>
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan-50 text-cyan-700">
          <UserPlus className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h3 className="font-black text-slate-950">Contact information and customer responses</h3>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            Phone numbers and email addresses are normalized exactly as the import normalizes them. Every change
            below is written to the audit timeline with the previous value, the new value, your profile, and the
            time, and no stored communication is ever changed.
          </p>
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {notice ?? ''}
      </p>
      {notice ? <p className={ui.success}>{notice}</p> : null}

      {/* ---------------------------------------------------------------- */}
      {/* Add contact information                                          */}
      {/* ---------------------------------------------------------------- */}
      <form
        noValidate
        aria-busy={pending === 'add-contact'}
        className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submitContact();
        }}
      >
        <p className={ui.sectionTitle}>Add contact information</p>

        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className={ui.label} htmlFor={`${baseId}-add-channel`}>
              Channel
            </label>
            <select
              id={`${baseId}-add-channel`}
              className={ui.select}
              disabled={busy}
              value={channel}
              onChange={(event) => {
                setChannel(event.target.value === 'email' ? 'email' : 'phone');
                setAddError(null);
              }}
            >
              <option value="phone">Phone</option>
              <option value="email">Email</option>
            </select>
          </div>

          <div className="sm:col-span-1 lg:col-span-2">
            <label className={ui.label} htmlFor={addValueId}>
              {channel === 'phone' ? 'Phone number' : 'Email address'}
            </label>
            <input
              id={addValueId}
              className={ui.input}
              disabled={busy}
              inputMode={channel === 'phone' ? 'tel' : 'email'}
              value={value}
              aria-invalid={Boolean(addError)}
              aria-describedby={`${addValueId}-preview${addError ? ` ${addValueId}-error` : ''}`}
              onChange={(event) => {
                setValue(event.target.value);
                setAddError(null);
              }}
            />
            {/* Advisory only: the write path normalizes and validates again and decides. */}
            <p
              id={`${addValueId}-preview`}
              aria-live="polite"
              className={`mt-2 text-xs font-bold ${preview && !preview.valid ? 'text-amber-700' : 'text-slate-500'}`}
            >
              {preview === null
                ? channel === 'phone'
                  ? 'Stored as +1 followed by ten digits, or as the international number you enter.'
                  : 'Stored in lower case.'
                : preview.valid
                  ? `Stored as ${preview.normalizedValue}`
                  : `Stored as "${preview.normalizedValue}" and marked invalid. ${preview.detail ?? ''}`}
            </p>
            {addError ? (
              <p
                id={`${addValueId}-error`}
                role="alert"
                className="mt-1 flex gap-1.5 text-xs font-bold text-rose-700"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{addError}</span>
              </p>
            ) : null}
          </div>

          <div>
            <label className={ui.label} htmlFor={`${baseId}-add-name`}>
              Contact name (optional)
            </label>
            <input
              id={`${baseId}-add-name`}
              className={ui.input}
              disabled={busy}
              value={contactName}
              onChange={(event) => setContactName(event.target.value)}
            />
          </div>

          <div>
            <label className={ui.label} htmlFor={`${baseId}-add-role`}>
              Contact role (optional)
            </label>
            <input
              id={`${baseId}-add-role`}
              className={ui.input}
              disabled={busy}
              value={contactRole}
              onChange={(event) => setContactRole(event.target.value)}
            />
          </div>

          <div>
            {/* Named for the new contact so it and the per-contact select of a stored contact carry
                distinct accessible names. */}
            <label className={ui.label} htmlFor={`${baseId}-add-language`}>
              New contact preferred language (optional)
            </label>
            <select
              id={`${baseId}-add-language`}
              className={ui.select}
              disabled={busy}
              value={addLanguage}
              onChange={(event) => {
                const next = event.target.value;
                setAddLanguage(isPermittedPreferredLanguage(next) ? next : '');
              }}
            >
              <option value="">Not specified — renders Bilingual</option>
              {PREFERRED_LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={ui.label} htmlFor={`${baseId}-add-authorization`}>
              New contact authorization status
            </label>
            <select
              id={`${baseId}-add-authorization`}
              className={ui.select}
              disabled={busy}
              value={addAuthorization}
              onChange={(event) => {
                const next = event.target.value;
                if (isPermittedAuthorizationStatus(next)) setAddAuthorization(next);
              }}
            >
              {AUTHORIZATION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button type="submit" className={`${ui.btnPrimary} mt-4`} disabled={busy}>
          {pending === 'add-contact' ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <UserPlus className="h-4 w-4" aria-hidden="true" />
          )}
          {pending === 'add-contact' ? 'Adding contact…' : 'Add contact'}
        </button>
      </form>

      {/* ---------------------------------------------------------------- */}
      {/* Stored contacts                                                  */}
      {/* ---------------------------------------------------------------- */}
      <div>
        <p className={ui.sectionTitle}>Contacts on this cancellation</p>
        {contacts.length === 0 ? (
          <p className={`${ui.empty} mt-3`}>
            This cancellation has no contact information. Add a phone number or an email address so reminders can
            reach the customer.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {contacts.map((contact) => {
              const suppressionChannel = suppressionChannelForContactChannel(contact.channel);
              const suppressed = contact[contactSuppressionColumn(suppressionChannel)];
              const channelWord = suppressionChannel === 'sms' ? 'SMS' : 'email';
              const languageKey = `${contact.id}-language`;
              const authorizationKey = `${contact.id}-authorization`;
              const optOutKey = `${contact.id}-opt-out`;
              const clearKey = `${contact.id}-clear`;
              const languageDraft = languageDrafts[contact.id] ?? contact.preferred_language ?? '';
              const authorizationDraft = authorizationDrafts[contact.id] ?? contact.authorization_status;
              const languageId = `${baseId}-${contact.id}-language`;
              const authorizationId = `${baseId}-${contact.id}-authorization`;
              const optOutId = `${baseId}-${contact.id}-opt-out`;
              const clearId = `${baseId}-${contact.id}-clear`;
              const languageError = fieldError(languageKey);
              const authorizationError = fieldError(authorizationKey);
              const optOutError = fieldError(optOutKey);
              const clearError = fieldError(clearKey);

              return (
                <li key={contact.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {contact.channel === 'phone' ? (
                      <Phone className="h-4 w-4 shrink-0 text-[#223f7a]" aria-hidden="true" />
                    ) : (
                      <Mail className="h-4 w-4 shrink-0 text-[#223f7a]" aria-hidden="true" />
                    )}
                    <span className="text-sm font-black text-slate-900">{contact.normalized_value}</span>
                    {badge(
                      contact.validation_status === 'valid' ? 'success' : 'danger',
                      contact.validation_status === 'valid' ? 'Valid' : 'Invalid',
                    )}
                    {badge(
                      contact.authorization_status === 'Not Authorized'
                        ? 'danger'
                        : contact.authorization_status === 'Authorized'
                          ? 'success'
                          : 'progress',
                      contact.authorization_status,
                    )}
                    {badge('neutral', contact.is_primary ? 'Primary' : 'Non-primary')}
                    {badge('info', contact.preferred_language ?? 'Language not set')}
                    {contact.sms_suppressed ? badge('danger', 'SMS opted out') : null}
                    {contact.email_suppressed ? badge('danger', 'Email opted out') : null}
                  </div>

                  {contact.contact_name || contact.contact_role || contact.raw_segment !== contact.normalized_value ? (
                    <p className="mt-2 text-xs font-semibold text-slate-500">
                      {[contact.contact_name, contact.contact_role].filter(Boolean).join(' \u00B7 ')}
                      {contact.contact_name || contact.contact_role ? ' \u00B7 ' : ''}
                      Imported as &ldquo;{contact.raw_segment}&rdquo;
                    </p>
                  ) : null}

                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className={ui.label} htmlFor={languageId}>
                        <Languages className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                        Preferred language
                      </label>
                      <div className="flex items-end gap-2">
                        <select
                          id={languageId}
                          className={`${ui.select} flex-1`}
                          disabled={busy}
                          value={languageDraft}
                          aria-invalid={Boolean(languageError)}
                          aria-describedby={languageError ? `${languageId}-error` : undefined}
                          onChange={(event) => {
                            setLanguageDrafts((current) => ({ ...current, [contact.id]: event.target.value }));
                            setFieldError(languageKey, null);
                          }}
                        >
                          <option value="">Not set</option>
                          {PREFERRED_LANGUAGES.map((language) => (
                            <option key={language} value={language}>
                              {language}
                            </option>
                          ))}
                        </select>
                        {/* The accessible name opens with the visible word, so it satisfies label in
                            name while still naming which contact the control saves. */}
                        <button
                          type="button"
                          className={`${ui.btnSecondary} mt-2 shrink-0 px-3 py-2.5`}
                          disabled={busy || languageDraft === (contact.preferred_language ?? '')}
                          aria-label={`Save preferred language for ${contact.normalized_value}`}
                          onClick={() => void saveLanguage(contact)}
                        >
                          {pending === languageKey ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <Save className="h-4 w-4" aria-hidden="true" />
                          )}
                          Save
                        </button>
                      </div>
                      {languageError ? (
                        <p
                          id={`${languageId}-error`}
                          role="alert"
                          className="mt-2 flex gap-1.5 text-xs font-bold text-rose-700"
                        >
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>{languageError}</span>
                        </p>
                      ) : null}
                    </div>

                    <div>
                      <label className={ui.label} htmlFor={authorizationId}>
                        <ShieldCheck className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                        Authorization status
                      </label>
                      <div className="flex items-end gap-2">
                        <select
                          id={authorizationId}
                          className={`${ui.select} flex-1`}
                          disabled={busy}
                          value={authorizationDraft}
                          aria-invalid={Boolean(authorizationError)}
                          aria-describedby={authorizationError ? `${authorizationId}-error` : undefined}
                          onChange={(event) => {
                            setAuthorizationDrafts((current) => ({ ...current, [contact.id]: event.target.value }));
                            setFieldError(authorizationKey, null);
                          }}
                        >
                          {AUTHORIZATION_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={`${ui.btnSecondary} mt-2 shrink-0 px-3 py-2.5`}
                          disabled={busy || authorizationDraft === contact.authorization_status}
                          aria-label={`Save authorization status for ${contact.normalized_value}`}
                          onClick={() => void saveAuthorization(contact)}
                        >
                          {pending === authorizationKey ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <Save className="h-4 w-4" aria-hidden="true" />
                          )}
                          Save
                        </button>
                      </div>
                      {authorizationError ? (
                        <p
                          id={`${authorizationId}-error`}
                          role="alert"
                          className="mt-2 flex gap-1.5 text-xs font-bold text-rose-700"
                        >
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>{authorizationError}</span>
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {/* Opt-out state and controls. A recorded opt-out reaches every case holding this
                      value and leaves the other channel alone (Requirements 21.1, 21.2). */}
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    {suppressed ? (
                      <div>
                        <p className="flex items-center gap-1.5 text-xs font-black text-rose-700">
                          <BellOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          This value is opted out of {channelWord}. No {channelWord} message is sent to it.
                        </p>
                        {manager ? (
                          <div className="mt-2">
                            <label className={ui.label} htmlFor={clearId}>
                              Reason the customer asked to resume {channelWord} (required)
                            </label>
                            <input
                              id={clearId}
                              className={ui.input}
                              disabled={busy}
                              maxLength={MAX_OPT_OUT_REASON_LENGTH}
                              value={clearReasons[contact.id] ?? ''}
                              aria-invalid={Boolean(clearError)}
                              aria-describedby={clearError ? `${clearId}-error` : undefined}
                              onChange={(event) => {
                                setClearReasons((current) => ({ ...current, [contact.id]: event.target.value }));
                                setFieldError(clearKey, null);
                              }}
                            />
                            <button
                              type="button"
                              className={`${ui.btnSecondary} mt-2`}
                              disabled={busy}
                              onClick={() => void submitClearOptOut(contact)}
                            >
                              {pending === clearKey ? (
                                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                              ) : (
                                <Undo2 className="h-4 w-4" aria-hidden="true" />
                              )}
                              Clear the {channelWord} opt-out
                            </button>
                            {clearError ? (
                              <p
                                id={`${clearId}-error`}
                                role="alert"
                                className="mt-2 flex gap-1.5 text-xs font-bold text-rose-700"
                              >
                                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span>{clearError}</span>
                              </p>
                            ) : null}
                          </div>
                        ) : (
                          <p className="mt-1 text-xs font-semibold text-slate-500">
                            Only a manager or super admin can clear an opt-out.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div>
                        <label className={ui.label} htmlFor={optOutId}>
                          Opt-out note (optional)
                        </label>
                        <input
                          id={optOutId}
                          className={ui.input}
                          disabled={busy}
                          maxLength={MAX_OPT_OUT_REASON_LENGTH}
                          value={optOutReasons[contact.id] ?? ''}
                          aria-invalid={Boolean(optOutError)}
                          aria-describedby={`${optOutId}-hint${optOutError ? ` ${optOutId}-error` : ''}`}
                          onChange={(event) => {
                            setOptOutReasons((current) => ({ ...current, [contact.id]: event.target.value }));
                            setFieldError(optOutKey, null);
                          }}
                        />
                        <p id={`${optOutId}-hint`} className="mt-2 text-xs font-semibold text-slate-400">
                          Recording the opt-out stops {channelWord} to this value on every cancellation that holds
                          it. The other channel is unchanged.
                        </p>
                        <button
                          type="button"
                          className={`${ui.btnDanger} mt-2`}
                          disabled={busy}
                          onClick={() => void submitOptOut(contact)}
                        >
                          {pending === optOutKey ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <BellOff className="h-4 w-4" aria-hidden="true" />
                          )}
                          Record {channelWord} opt-out
                        </button>
                        {optOutError ? (
                          <p
                            id={`${optOutId}-error`}
                            role="alert"
                            className="mt-2 flex gap-1.5 text-xs font-bold text-rose-700"
                          >
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span>{optOutError}</span>
                          </p>
                        ) : null}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Customer response                                                */}
      {/* ---------------------------------------------------------------- */}
      {responseVisible ? (
        <form
          noValidate
          aria-busy={pending === 'customer-response'}
          className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submitResponse();
          }}
        >
          <p className={ui.sectionTitle}>
            <MessageSquare className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
            Record a customer response
          </p>
          <p className="mt-1 text-xs font-semibold text-slate-500">
            Assistance requested and Callback requested set the assistance flag on this cancellation and escalate it
            as Customer Assistance Requested. Recording a response never changes a stored communication.
          </p>

          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className={ui.label} htmlFor={responseTypeId}>
                Response type
              </label>
              <select
                id={responseTypeId}
                className={ui.select}
                disabled={busy}
                value={responseType}
                aria-invalid={Boolean(responseTypeError)}
                aria-describedby={responseTypeError ? `${responseTypeId}-error` : undefined}
                onChange={(event) => {
                  const next = event.target.value;
                  setResponseType(isCustomerResponseType(next) ? next : '');
                  setResponseTypeError(null);
                  setResponseNoteError(null);
                }}
              >
                <option value="">Select a response type…</option>
                {CUSTOMER_RESPONSE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              {responseTypeError ? (
                <p
                  id={`${responseTypeId}-error`}
                  role="alert"
                  className="mt-2 flex gap-1.5 text-xs font-bold text-rose-700"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{responseTypeError}</span>
                </p>
              ) : null}
            </div>

            <div>
              <label className={ui.label} htmlFor={`${baseId}-response-channel`}>
                How the customer responded (optional)
              </label>
              <input
                id={`${baseId}-response-channel`}
                className={ui.input}
                disabled={busy}
                value={responseChannel}
                placeholder="Call, SMS, email, in person"
                onChange={(event) => setResponseChannel(event.target.value)}
              />
            </div>

            <div>
              <label className={ui.label} htmlFor={`${baseId}-response-time`}>
                When the customer responded (optional)
              </label>
              <input
                id={`${baseId}-response-time`}
                type="datetime-local"
                className={ui.input}
                disabled={busy}
                value={responseTime}
                aria-describedby={`${baseId}-response-time-hint`}
                onChange={(event) => setResponseTime(event.target.value)}
              />
              <p id={`${baseId}-response-time-hint`} className="mt-2 text-xs font-semibold text-slate-400">
                Leave empty to record it as now.
              </p>
            </div>
          </div>

          <div className="mt-4">
            <label className={ui.label} htmlFor={responseNoteId}>
              Response note
              {responseType !== '' && noteRequiredForResponseType(responseType) ? ' (required)' : ' (optional)'}
            </label>
            <textarea
              id={responseNoteId}
              rows={3}
              className={ui.textarea}
              disabled={busy}
              value={responseNote}
              aria-invalid={Boolean(responseNoteError) || responseNoteOverLimit}
              aria-describedby={`${responseNoteId}-count${responseNoteError ? ` ${responseNoteId}-error` : ''}`}
              onChange={(event) => {
                setResponseNote(event.target.value);
                setResponseNoteError(null);
              }}
            />
            <p
              id={`${responseNoteId}-count`}
              className={`mt-2 text-xs font-bold tabular-nums ${
                responseNoteOverLimit ? 'text-rose-700' : 'text-slate-500'
              }`}
            >
              {trimmedResponseNote.length.toLocaleString('en-US')} of{' '}
              {MAX_ACTIVITY_NOTE_LENGTH.toLocaleString('en-US')} characters
              {responseNoteOverLimit ? ' — over the limit' : ''}
            </p>
            {responseNoteError ? (
              <p
                id={`${responseNoteId}-error`}
                role="alert"
                className="mt-1 flex gap-1.5 text-xs font-bold text-rose-700"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{responseNoteError}</span>
              </p>
            ) : null}
          </div>

          <button type="submit" className={`${ui.btnPrimary} mt-4`} disabled={busy}>
            {pending === 'customer-response' ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            )}
            {pending === 'customer-response' ? 'Recording response…' : 'Record customer response'}
          </button>
        </form>
      ) : null}
    </section>
  );
}

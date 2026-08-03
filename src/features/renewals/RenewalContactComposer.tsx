'use client';

// Renewal contact composer (Requirements 5.4, 5.5, 5.6, 5.7, 5.9, 2.3).
//
// The only renewal component permitted to write a contact entry. It calls exactly three
// functions from `api.ts` — `addContact`, `getEvidenceUrl`, `downloadEvidenceFile` — and
// performs zero direct Supabase access and zero renewal database function calls of its own
// (Requirement 7.2).
//
// Channel set (Req 2.3, 5.9): the six values below are the values already stored on
// `renewal_contacts.channel` and typed as `RenewalChannel` in `api.ts`. They are read from
// the existing storage contract, not invented here: `call`, `sms`, `whatsapp`, `email`,
// `in_person`, `other`.
//
// Storage shape: one `renewal_contacts` row carries at most one uploaded evidence file plus
// one free-text evidence reference, and Phase 1 changes no column and no bucket. A contact
// entry that carries several attachments is therefore written as one `addContact` call per
// attachment, every call sharing the one contact time, channel, direction, outcome, and
// notes text of the entry. When the first upload fails nothing at all is stored, which is
// the Requirement 5.7 guarantee; when a later upload fails the composer reports exactly how
// many attachments were stored instead of claiming an unsaved entry, and retry resumes with
// the attachments that are still pending.

import {
  AlertTriangle,
  ClipboardCheck,
  Download,
  ExternalLink,
  LoaderCircle,
  Paperclip,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import { addContact, downloadEvidenceFile, getEvidenceUrl } from './api';
import type { RenewalChannel, RenewalContact, RenewalDirection } from './api';
import { megabytes } from './format';

/** The permitted contact channels, in the Requirement 2.3 order, as stored on `renewal_contacts`. */
export const RENEWAL_CONTACT_CHANNELS: readonly { value: RenewalChannel; label: string }[] = [
  { value: 'call', label: 'Call' },
  { value: 'sms', label: 'SMS' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'in_person', label: 'In Person' },
  { value: 'other', label: 'Other' },
];

/** Contact results carried over unchanged from the pre-revision composer (Req 2.4). */
const CONTACT_RESULTS: readonly string[] = [
  'No answer',
  'Left voicemail',
  'Customer reached',
  'Customer requested callback',
  'Customer reviewing renewal',
  'Customer wants re-quote',
  'Wrong number',
  'Other',
];

/** Notes hold 1 to 5,000 characters once leading and trailing whitespace is removed (Req 5.4). */
export const MAX_NOTES_LENGTH = 5_000;

/** At most ten evidence files on one contact entry (Req 5.6). */
export const MAX_EVIDENCE_FILES = 10;

/** At most 100 megabytes per evidence file (Req 5.6). */
export const MAX_EVIDENCE_BYTES = 100 * 1024 * 1024;

/** An evidence upload that has not finished by this bound is treated as failed (Req 5.7). */
export const EVIDENCE_UPLOAD_TIMEOUT_MS = 120_000;

const CHANNEL_REQUIRED_MESSAGE =
  'Select a contact method. The permitted methods are Call, SMS, WhatsApp, Email, In Person, and Other.';
const NOTES_REQUIRED_MESSAGE = 'Contact notes are required. Enter at least one character that is not a space.';
const UPLOAD_TIMEOUT_MESSAGE = 'The evidence upload did not finish within 120 seconds.';
const UNMOUNT_ABORT_MESSAGE = 'The composer closed before the evidence upload finished.';

const FILE_ACCEPT = 'image/*,application/pdf,audio/*,video/*,.txt,.csv,.doc,.docx';

const PERMITTED_CHANNELS = new Set<string>(RENEWAL_CONTACT_CHANNELS.map((channel) => channel.value));

/** Narrows arbitrary submitted text to the permitted channel set (Req 2.3, 5.9). */
export function isPermittedChannel(value: string | null | undefined): value is RenewalChannel {
  return typeof value === 'string' && PERMITTED_CHANNELS.has(value);
}

function notesLengthMessage(length: number): string {
  return `Contact notes are limited to ${MAX_NOTES_LENGTH.toLocaleString('en-US')} characters. Remove ${(
    length - MAX_NOTES_LENGTH
  ).toLocaleString('en-US')} characters.`;
}

/** One attachment staged in the composer. `stored` flips once its `addContact` call succeeds. */
interface StagedAttachment {
  id: string;
  file: File;
  stored: boolean;
}

/**
 * Rejects as soon as `signal` aborts. Paired with `withUploadTimeout` so the 120-second bound
 * is carried by an `AbortController` whose timer is always cleared.
 */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error(UPLOAD_TIMEOUT_MESSAGE));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

/**
 * Runs one `addContact` call under the Requirement 5.7 bound. `addContact` accepts no signal,
 * so the bound is enforced by an `AbortController` that this helper owns: the timer is cleared
 * in `finally` whether the call resolves, rejects, or times out, and the forwarded unmount
 * listener is removed with it, so neither a pending timer nor a listener survives the call.
 */
async function withUploadTimeout<T>(
  task: () => Promise<T>,
  outerSignal: AbortSignal | null,
  timeoutMs: number = EVIDENCE_UPLOAD_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(new Error(UNMOUNT_ABORT_MESSAGE));
  const timer = setTimeout(() => controller.abort(new Error(UPLOAD_TIMEOUT_MESSAGE)), timeoutMs);
  outerSignal?.addEventListener('abort', forwardAbort, { once: true });
  try {
    return await Promise.race([task(), abortRejection(controller.signal)]);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', forwardAbort);
  }
}

export interface RenewalContactComposerProps {
  /** `renewal_records.id` the contact entry is recorded against. */
  recordId: string;
  /** Raised after at least one contact row is stored so the parent refreshes its own queries (Req 5.5). */
  onContactAdded: () => void | Promise<void>;
  disabled?: boolean;
  /**
   * Contact entries already stored on this renewal. Supplied so the evidence viewing and
   * download controls, which are the composer's other two `api.ts` calls, stay in this file.
   */
  evidenceContacts?: readonly RenewalContact[];
}

export default function RenewalContactComposer({
  recordId,
  onContactAdded,
  disabled = false,
  evidenceContacts = [],
}: RenewalContactComposerProps) {
  const channelId = useId();
  const directionId = useId();
  const resultId = useId();
  const notesId = useId();
  const fileId = useId();
  const referenceId = useId();

  // Draft state. Nothing here is cleared by a rejection, so the entered channel, notes text,
  // and previously accepted attachments survive every failure path (Req 5.4, 5.6, 5.7, 5.9).
  const [channel, setChannel] = useState<RenewalChannel | ''>('');
  const [direction, setDirection] = useState<RenewalDirection>('outbound');
  const [result, setResult] = useState<string>(CONTACT_RESULTS[0]);
  const [notes, setNotes] = useState('');
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [reference, setReference] = useState('');

  const [channelError, setChannelError] = useState<string | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [retryOffered, setRetryOffered] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [evidenceBusyId, setEvidenceBusyId] = useState<string | null>(null);

  const nextAttachmentId = useRef(0);
  /** One contact time for the whole entry, held across a retry that resumes attachments. */
  const occurredAtRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const unmountAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    unmountAbortRef.current = controller;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      unmountAbortRef.current = null;
      controller.abort(new Error(UNMOUNT_ABORT_MESSAGE));
    };
  }, []);

  const trimmedNotes = notes.trim();
  const notesLength = trimmedNotes.length;
  const notesOverLimit = notesLength > MAX_NOTES_LENGTH;
  const pendingAttachments = attachments.filter((item) => !item.stored);
  const busy = disabled || submitting;

  /**
   * Stages a file selection (Req 5.6). Each file is checked for size first and then for the
   * ten-file ceiling, and only the first limit that actually fails is reported, so a rejected
   * oversized file never also reports the count limit. Files that pass are kept.
   */
  const stageFiles = useCallback(
    (selected: readonly File[]) => {
      if (selected.length === 0) return;
      const accepted: StagedAttachment[] = [];
      let failure: string | null = null;

      for (const file of selected) {
        if (file.size > MAX_EVIDENCE_BYTES) {
          failure ??= `"${file.name}" is ${megabytes(file.size)}. The limit is 100 MB per file, so it was not attached.`;
          continue;
        }
        if (attachments.length + accepted.length >= MAX_EVIDENCE_FILES) {
          failure ??= `"${file.name}" was not attached. One contact entry holds at most ${MAX_EVIDENCE_FILES} evidence files.`;
          continue;
        }
        nextAttachmentId.current += 1;
        accepted.push({ id: `attachment-${nextAttachmentId.current}`, file, stored: false });
      }

      setNotice(null);
      setAttachmentError(failure);
      // The slice keeps the ten-file ceiling a hard invariant even if two selections land in
      // one batch; in the ordinary one-selection-per-event path it removes nothing.
      if (accepted.length > 0) {
        setAttachments((current) => [...current, ...accepted].slice(0, MAX_EVIDENCE_FILES));
      }
    },
    [attachments.length],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((item) => item.id !== id || item.stored));
    setAttachmentError(null);
  }, []);

  /**
   * Validates, then stores the entry with one `addContact` call per pending attachment and a
   * single call when no attachment is staged. A validation rejection writes nothing, so the
   * timeline is untouched (Req 5.4, 5.9). An upload failure stops at the failing attachment,
   * keeps every draft value, and offers retry (Req 5.5, 5.7).
   *
   * Both the submit control and the retry control land here, so a draft edited between a
   * failure and a retry is validated again rather than trusted.
   */
  const submitEntry = useCallback(async () => {
    const entryChannel = isPermittedChannel(channel) ? channel : null;
    const channelFailure = entryChannel ? null : CHANNEL_REQUIRED_MESSAGE;
    const notesFailure = notesLength === 0
      ? NOTES_REQUIRED_MESSAGE
      : notesLength > MAX_NOTES_LENGTH
        ? notesLengthMessage(notesLength)
        : null;

    setChannelError(channelFailure);
    setNotesError(notesFailure);

    if (!entryChannel || notesFailure) {
      // The upload failure reason and its retry control are left standing: a validation
      // rejection is not evidence that an earlier upload succeeded (Req 5.7).
      setNotice(null);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setRetryOffered(false);
    setNotice(null);

    const occurredAt = occurredAtRef.current ?? new Date().toISOString();
    occurredAtRef.current = occurredAt;
    const queue = attachments.filter((item) => !item.stored);
    const referenceText = reference.trim() || null;
    const alreadyStored = attachments.length - queue.length;
    let storedNow = 0;

    try {
      if (queue.length === 0) {
        await withUploadTimeout(
          () =>
            addContact({
              recordId,
              channel: entryChannel,
              direction,
              outcome: result,
              notes: trimmedNotes,
              occurredAt,
              evidenceFile: null,
              evidenceReference: referenceText,
            }),
          unmountAbortRef.current?.signal ?? null,
        );
        storedNow += 1;
      } else {
        for (const item of queue) {
          await withUploadTimeout(
            () =>
              addContact({
                recordId,
                channel: entryChannel,
                direction,
                outcome: result,
                notes: trimmedNotes,
                occurredAt,
                evidenceFile: item.file,
                evidenceReference: referenceText,
              }),
            unmountAbortRef.current?.signal ?? null,
          );
          storedNow += 1;
          if (mountedRef.current) {
            setAttachments((current) =>
              current.map((entry) => (entry.id === item.id ? { ...entry, stored: true } : entry)),
            );
          }
        }
      }

      if (mountedRef.current) {
        occurredAtRef.current = null;
        setNotes('');
        setAttachments([]);
        setReference('');
        setNotice(
          queue.length > 1
            ? `Contact entry recorded with ${queue.length} evidence files. The renewal stays open until a final outcome is selected.`
            : 'Contact entry recorded. The renewal stays open until a final outcome is selected.',
        );
      }
      await onContactAdded();
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : 'The evidence upload failed.';
      const total = alreadyStored + queue.length;
      const stored = alreadyStored + storedNow;
      if (mountedRef.current) {
        setSubmitError(
          stored === 0
            ? `${reason} The contact entry was not saved.`
            : `${reason} ${stored} of ${total} evidence files were saved; retry to save the rest.`,
        );
        setRetryOffered(true);
      }
      if (stored > 0) await onContactAdded();
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    attachments,
    channel,
    direction,
    notesLength,
    onContactAdded,
    recordId,
    reference,
    result,
    trimmedNotes,
  ]);

  const openEvidence = useCallback(async (contact: RenewalContact) => {
    setEvidenceBusyId(contact.id);
    setSubmitError(null);
    try {
      const url = await getEvidenceUrl(contact);
      if (!url) throw new Error('No viewable file or recording is attached to this contact entry.');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (caught) {
      if (mountedRef.current) {
        setSubmitError(caught instanceof Error ? caught.message : 'The attached file could not be opened.');
      }
    } finally {
      if (mountedRef.current) setEvidenceBusyId(null);
    }
  }, []);

  const saveEvidence = useCallback(async (contact: RenewalContact) => {
    setEvidenceBusyId(contact.id);
    setSubmitError(null);
    try {
      await downloadEvidenceFile(contact);
    } catch (caught) {
      if (mountedRef.current) {
        setSubmitError(caught instanceof Error ? caught.message : 'The attached file could not be downloaded.');
      }
    } finally {
      if (mountedRef.current) setEvidenceBusyId(null);
    }
  }, []);

  const withEvidence = evidenceContacts.filter(
    (contact) => contact.evidence_path || contact.evidence_reference || contact.rc_recording_content_uri,
  );

  return (
    <section className={`${ui.card} ${ui.cardPad}`}>
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan-50 text-cyan-700">
          <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h3 className="font-black text-slate-950">Log customer contact</h3>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            A contact method and notes are always required. Attach up to {MAX_EVIDENCE_FILES} evidence files of at most
            100 MB each. Logging a contact never closes the renewal.
          </p>
        </div>
      </div>

      <form
        noValidate
        aria-busy={submitting}
        className="mt-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submitEntry();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className={ui.label} htmlFor={channelId}>
              Contact method
            </label>
            <select
              id={channelId}
              className={ui.select}
              disabled={busy}
              value={channel}
              aria-invalid={Boolean(channelError)}
              aria-describedby={channelError ? `${channelId}-error` : undefined}
              onChange={(event) => {
                const next = event.target.value;
                setChannel(isPermittedChannel(next) ? next : '');
                if (isPermittedChannel(next)) setChannelError(null);
              }}
            >
              <option value="">Select a contact method…</option>
              {RENEWAL_CONTACT_CHANNELS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {channelError ? (
              <p id={`${channelId}-error`} role="alert" className="mt-2 flex gap-1.5 text-xs font-bold text-rose-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{channelError}</span>
              </p>
            ) : null}
          </div>

          <div>
            <label className={ui.label} htmlFor={directionId}>
              Direction
            </label>
            <select
              id={directionId}
              className={ui.select}
              disabled={busy}
              value={direction}
              onChange={(event) => setDirection(event.target.value === 'inbound' ? 'inbound' : 'outbound')}
            >
              <option value="outbound">Outbound</option>
              <option value="inbound">Inbound</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className={ui.label} htmlFor={resultId}>
              Contact result — does not close the renewal
            </label>
            <select
              id={resultId}
              className={ui.select}
              disabled={busy}
              value={result}
              onChange={(event) => setResult(event.target.value)}
            >
              {CONTACT_RESULTS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4">
          <label className={ui.label} htmlFor={notesId}>
            Notes (required)
          </label>
          <textarea
            id={notesId}
            rows={4}
            className={ui.textarea}
            disabled={busy}
            value={notes}
            aria-invalid={Boolean(notesError) || notesOverLimit}
            aria-describedby={`${notesId}-count${notesError ? ` ${notesId}-error` : ''}`}
            onChange={(event) => {
              setNotes(event.target.value);
              setNotesError(null);
            }}
          />
          <p
            id={`${notesId}-count`}
            className={`mt-2 text-xs font-bold tabular-nums ${notesOverLimit ? 'text-rose-700' : 'text-slate-500'}`}
          >
            {notesLength.toLocaleString('en-US')} of {MAX_NOTES_LENGTH.toLocaleString('en-US')} characters
            {notesOverLimit ? ' — over the limit' : ''}
          </p>
          {notesError ? (
            <p id={`${notesId}-error`} role="alert" className="mt-1 flex gap-1.5 text-xs font-bold text-rose-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{notesError}</span>
            </p>
          ) : null}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className={ui.label} htmlFor={fileId}>
              Attach evidence or a call recording
            </label>
            <input
              id={fileId}
              type="file"
              multiple
              accept={FILE_ACCEPT}
              className={`${ui.input} file:mr-3 file:rounded-lg file:border-0 file:bg-[#eef3fb] file:px-3 file:py-1.5 file:text-xs file:font-black file:text-[#223f7a]`}
              disabled={busy}
              aria-invalid={Boolean(attachmentError)}
              aria-describedby={`${fileId}-count${attachmentError ? ` ${fileId}-error` : ''}`}
              onChange={(event) => {
                stageFiles(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
            <p id={`${fileId}-count`} aria-live="polite" className="mt-2 text-xs font-bold tabular-nums text-slate-500">
              {attachments.length} of {MAX_EVIDENCE_FILES} evidence files attached
              {attachments.length >= MAX_EVIDENCE_FILES ? ' — limit reached' : ''}
            </p>
            {attachmentError ? (
              <p id={`${fileId}-error`} role="alert" className="mt-1 flex gap-1.5 text-xs font-bold text-rose-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{attachmentError}</span>
              </p>
            ) : null}
          </div>

          <div>
            <label className={ui.label} htmlFor={referenceId}>
              Or a contact reference record
            </label>
            <input
              id={referenceId}
              className={ui.input}
              disabled={busy}
              value={reference}
              aria-describedby={`${referenceId}-hint`}
              onChange={(event) => setReference(event.target.value)}
            />
            <p id={`${referenceId}-hint`} className="mt-2 text-xs font-semibold text-slate-400">
              RingCentral call id, attachment reference, or email message id.
            </p>
          </div>
        </div>

        {attachments.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {attachments.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700"
              >
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-[#223f7a]" aria-hidden="true" />
                <span className="truncate">{item.file.name}</span>
                <span className="shrink-0 font-semibold text-slate-400">{megabytes(item.file.size)}</span>
                {item.stored ? (
                  <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-black text-emerald-700">
                    Saved
                  </span>
                ) : (
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 font-black text-slate-500 transition hover:bg-slate-200 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-[#7890bc] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={busy}
                    onClick={() => removeAttachment(item.id)}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    Remove
                    <span className="sr-only"> {item.file.name}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {submitError ? (
          <p role="alert" className={`${ui.error} mt-4 flex gap-2`}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{submitError}</span>
          </p>
        ) : null}
        <p aria-live="polite" className="sr-only">
          {notice ?? ''}
        </p>
        {notice ? <p className={`${ui.success} mt-4`}>{notice}</p> : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="submit" className={ui.btnPrimary} disabled={busy}>
            {submitting ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Upload className="h-4 w-4" aria-hidden="true" />
            )}
            {submitting ? 'Saving contact entry…' : 'Save contact entry'}
          </button>
          {retryOffered ? (
            <button type="button" className={ui.btnSecondary} disabled={busy} onClick={() => void submitEntry()}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Retry
              {pendingAttachments.length > 0 ? ` ${pendingAttachments.length} pending upload${
                pendingAttachments.length === 1 ? '' : 's'
              }` : ''}
            </button>
          ) : null}
        </div>
      </form>

      {withEvidence.length > 0 ? (
        <div className="mt-6 border-t border-slate-100 pt-4">
          <p className={ui.sectionTitle}>Evidence on this renewal</p>
          <ul className="mt-3 space-y-2">
            {withEvidence.map((contact) => (
              <li
                key={contact.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700"
              >
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-[#223f7a]" aria-hidden="true" />
                <span className="truncate">
                  {contact.evidence_name?.trim() || contact.evidence_reference?.trim() || 'Call recording'}
                </span>
                <span className="shrink-0 font-semibold text-slate-400">
                  {new Date(contact.occurred_at).toLocaleString()}
                </span>
                <span className="ml-auto flex shrink-0 gap-1">
                  <button
                    type="button"
                    className={`${ui.btnGhost} px-2 py-1 text-xs`}
                    disabled={disabled || evidenceBusyId === contact.id}
                    onClick={() => void openEvidence(contact)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    Open
                  </button>
                  <button
                    type="button"
                    className={`${ui.btnGhost} px-2 py-1 text-xs`}
                    disabled={disabled || evidenceBusyId === contact.id}
                    onClick={() => void saveEvidence(contact)}
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    Download
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

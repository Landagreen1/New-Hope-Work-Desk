'use client';

// Agent follow-up recording form (REQ-6.1, REQ-6.2, REQ-6.3).
//
// A prominent "Record Follow-up" action in the cancellation drawer. Collects contact method,
// direction, contact used, outcome, notes, customer response, payment reported, evidence,
// next follow-up date, and next required action in one consolidated form.

import { CheckCircle2, LoaderCircle, Phone, X } from 'lucide-react';
import { useCallback, useId, useState } from 'react';

import type { AppRole } from '@/lib/types';

import { ui } from '../nhwd-shared/ui';
import type { NextRequiredAction } from './domain/communication-status';
import { NEXT_REQUIRED_ACTIONS } from './domain/communication-status';
import {
  FOLLOW_UP_CONTACT_METHODS,
  FOLLOW_UP_DIRECTIONS,
  FOLLOW_UP_OUTCOMES,
  MAX_FOLLOW_UP_NOTES_LENGTH,
  MIN_FOLLOW_UP_NOTES_LENGTH,
  validateFollowUpPayload,
  type FollowUpContactMethod,
  type FollowUpDirection,
  type FollowUpOutcome,
  type FollowUpPayload,
} from './domain/follow-up';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CancellationFollowUpFormProps {
  caseId: string;
  /** Available contact values from the case's contact rows. */
  contactOptions: readonly string[];
  role: AppRole;
  onSubmit: (caseId: string, payload: FollowUpPayload) => Promise<void>;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CancellationFollowUpForm({
  caseId,
  contactOptions,
  role,
  onSubmit,
  onClose,
}: CancellationFollowUpFormProps) {
  const baseId = useId();

  const [contactMethod, setContactMethod] = useState<FollowUpContactMethod | ''>('');
  const [direction, setDirection] = useState<FollowUpDirection | ''>('');
  const [contactUsed, setContactUsed] = useState('');
  const [outcome, setOutcome] = useState<FollowUpOutcome | ''>('');
  const [notes, setNotes] = useState('');
  const [customerResponse, setCustomerResponse] = useState('');
  const [paymentReported, setPaymentReported] = useState(false);
  const [nextFollowUpDate, setNextFollowUpDate] = useState('');
  const [nextRequiredAction, setNextRequiredAction] = useState<NextRequiredAction | ''>('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = useCallback(async () => {
    const payload: FollowUpPayload = {
      contactMethod: contactMethod as FollowUpContactMethod,
      direction: direction as FollowUpDirection,
      contactUsed: contactUsed.trim(),
      outcome: outcome as FollowUpOutcome,
      notes,
      customerResponse: customerResponse.trim() || null,
      paymentReported,
      nextFollowUpDate: nextFollowUpDate || null,
      nextRequiredAction: (nextRequiredAction as NextRequiredAction) || null,
    };

    const validationError = validateFollowUpPayload(payload);
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onSubmit(caseId, payload);
      setSuccess(true);
      setTimeout(() => onClose(), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The follow-up could not be recorded.');
    } finally {
      setBusy(false);
    }
  }, [
    caseId, contactMethod, direction, contactUsed, outcome, notes,
    customerResponse, paymentReported, nextFollowUpDate, nextRequiredAction,
    onSubmit, onClose,
  ]);

  if (success) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
        <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
        Follow-up recorded successfully.
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Phone className="h-4 w-4" aria-hidden="true" />
          Record Follow-up
        </h4>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="Close follow-up form"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {error ? (
        <p className={ui.error} role="alert">{error}</p>
      ) : null}

      {/* Contact Method + Direction row */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${baseId}-method`} className="mb-1 block text-xs font-medium text-slate-600">
            Contact Method *
          </label>
          <select
            id={`${baseId}-method`}
            value={contactMethod}
            onChange={(e) => setContactMethod(e.target.value as FollowUpContactMethod)}
            className={ui.select}
            disabled={busy}
          >
            <option value="">Select...</option>
            {FOLLOW_UP_CONTACT_METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${baseId}-direction`} className="mb-1 block text-xs font-medium text-slate-600">
            Direction *
          </label>
          <select
            id={`${baseId}-direction`}
            value={direction}
            onChange={(e) => setDirection(e.target.value as FollowUpDirection)}
            className={ui.select}
            disabled={busy}
          >
            <option value="">Select...</option>
            {FOLLOW_UP_DIRECTIONS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Contact Used */}
      <div>
        <label htmlFor={`${baseId}-contact`} className="mb-1 block text-xs font-medium text-slate-600">
          Contact Used *
        </label>
        {contactOptions.length > 0 ? (
          <select
            id={`${baseId}-contact`}
            value={contactUsed}
            onChange={(e) => setContactUsed(e.target.value)}
            className={ui.select}
            disabled={busy}
          >
            <option value="">Select or enter manually...</option>
            {contactOptions.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
            <option value="__manual__">Enter manually...</option>
          </select>
        ) : (
          <input
            id={`${baseId}-contact`}
            type="text"
            value={contactUsed}
            onChange={(e) => setContactUsed(e.target.value)}
            placeholder="Phone number, email, or description"
            className={ui.input}
            disabled={busy}
          />
        )}
        {contactUsed === '__manual__' ? (
          <input
            type="text"
            value=""
            onChange={(e) => setContactUsed(e.target.value)}
            placeholder="Enter contact value"
            className={`${ui.input} mt-1`}
            disabled={busy}
          />
        ) : null}
      </div>

      {/* Outcome */}
      <div>
        <label htmlFor={`${baseId}-outcome`} className="mb-1 block text-xs font-medium text-slate-600">
          Outcome *
        </label>
        <select
          id={`${baseId}-outcome`}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as FollowUpOutcome)}
          className={ui.select}
          disabled={busy}
        >
          <option value="">Select outcome...</option>
          {FOLLOW_UP_OUTCOMES.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>

      {/* Notes */}
      <div>
        <label htmlFor={`${baseId}-notes`} className="mb-1 block text-xs font-medium text-slate-600">
          Notes * ({notes.length}/{MAX_FOLLOW_UP_NOTES_LENGTH})
        </label>
        <textarea
          id={`${baseId}-notes`}
          value={notes}
          onChange={(e) => setNotes(e.target.value.slice(0, MAX_FOLLOW_UP_NOTES_LENGTH))}
          rows={3}
          placeholder="Describe the follow-up interaction..."
          className={ui.textarea}
          disabled={busy}
          aria-invalid={notes.length > 0 && notes.length < MIN_FOLLOW_UP_NOTES_LENGTH}
        />
      </div>

      {/* Customer Response */}
      <div>
        <label htmlFor={`${baseId}-response`} className="mb-1 block text-xs font-medium text-slate-600">
          Customer Response
        </label>
        <input
          id={`${baseId}-response`}
          type="text"
          value={customerResponse}
          onChange={(e) => setCustomerResponse(e.target.value)}
          placeholder="Brief summary of customer response"
          className={ui.input}
          disabled={busy}
        />
      </div>

      {/* Payment Reported */}
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={paymentReported}
          onChange={(e) => setPaymentReported(e.target.checked)}
          disabled={busy}
          className="h-4 w-4 rounded border-slate-300"
        />
        Customer reports payment made
      </label>

      {/* Next follow-up date + Next action row */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${baseId}-next-date`} className="mb-1 block text-xs font-medium text-slate-600">
            Next Follow-up Date
          </label>
          <input
            id={`${baseId}-next-date`}
            type="date"
            value={nextFollowUpDate}
            onChange={(e) => setNextFollowUpDate(e.target.value)}
            className={ui.input}
            disabled={busy}
          />
        </div>
        <div>
          <label htmlFor={`${baseId}-next-action`} className="mb-1 block text-xs font-medium text-slate-600">
            Next Required Action
          </label>
          <select
            id={`${baseId}-next-action`}
            value={nextRequiredAction}
            onChange={(e) => setNextRequiredAction(e.target.value as NextRequiredAction)}
            className={ui.select}
            disabled={busy}
          >
            <option value="">No change</option>
            {NEXT_REQUIRED_ACTIONS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Submit */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button type="button" className={ui.btnSecondary} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={ui.btnPrimary}
          onClick={handleSubmit}
          disabled={busy}
        >
          {busy ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          Record Follow-up
        </button>
      </div>
    </div>
  );
}

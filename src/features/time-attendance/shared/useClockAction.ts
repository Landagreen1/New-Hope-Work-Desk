// src/features/time-attendance/shared/useClockAction.ts
// Submitting a clock action, once, for both places that offer one.
//
// My Day gives an employee the full shift card and its primary action
// (Requirement 4, criteria 7 through 11). Team Today gives an administrator the
// same action reduced to a compact header control (Requirement 5, criterion 1).
// The two look nothing alike and the rule behind them is identical: which action
// is primary comes from `primaryClockAction`, and the request that action sends
// is the map below.
//
// Both live here rather than in the two panels because a second copy of the map
// is a second place `/api/time-clock` is called, and the two would be free to
// disagree about which verb closes a break. That is the same reason
// Requirement 19, criterion 8 keeps one implementation of every rule.
//
// ## What it guarantees
//
// - **Criterion 20** — a failed action leaves the displayed state untouched.
//   Nothing here is optimistic: `onRecorded` fires on success only, and a failure
//   is reported through `failure` for the caller to render beside its unchanged
//   figures.
// - **Criterion 21** — a second identical submission records at most one event.
//   The guard is a ref rather than the `busy` state, so two clicks inside one
//   tick — before React has re-rendered — still see the first one in flight. The
//   clock-in and break-start routes are backed by partial unique indexes as the
//   second guard, for the race a browser cannot see.
//
// Requirements: 4.8, 4.9, 4.10, 4.20, 4.21, 5.1, 22.16

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ClockAction } from '../domain/presentation';
import { asApiFailure, attendanceJson, jsonRequest, type ApiFailure } from './api-failure';

/**
 * The request each clock action sends.
 *
 * The actions map onto the two existing clock routes, whose contract this
 * redesign leaves alone: a POST opens something and a PATCH closes it.
 *
 * `start_lunch` sends `break_type: 'lunch'` — an unpaid break, deducted from
 * worked hours. `start_break` sends `break_type: 'short'` — a paid break, NOT
 * deducted from worked hours. The `/api/time-clock/breaks` route already accepts
 * both types and the attendance policy classifies them accordingly.
 *
 * Requirements: 4.8, 4.9, 4.10
 */
export const CLOCK_ACTION_REQUEST: Record<ClockAction, { url: string; init: RequestInit }> = {
  clock_in: { url: '/api/time-clock', init: jsonRequest('POST', {}) },
  start_lunch: { url: '/api/time-clock/breaks', init: jsonRequest('POST', { break_type: 'lunch' }) },
  start_break: { url: '/api/time-clock/breaks', init: jsonRequest('POST', { break_type: 'short' }) },
  end_break: { url: '/api/time-clock/breaks', init: { method: 'PATCH' } },
  clock_out: { url: '/api/time-clock', init: jsonRequest('PATCH', { action: 'clock_out' }) },
};

export interface ClockActionState {
  /** The action in flight, or null. A caller disables its controls on this. */
  busy: ClockAction | null;
  /** The last failure, or null. Cleared when the next action is submitted. */
  failure: ApiFailure | null;
  /** Submit one action. Ignored while any action is already in flight. */
  submit: (action: ClockAction) => void;
}

/**
 * One clock action at a time, with its failure.
 *
 * `onRecorded` is called after the server has accepted the action, and is where
 * the caller refetches. It is held in a ref, so a caller may pass an inline
 * closure without `submit` changing identity on every render.
 *
 * Requirements: 4.20, 4.21
 */
export function useClockAction(onRecorded?: () => void): ClockActionState {
  const [busy, setBusy] = useState<ClockAction | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const recordedRef = useRef(onRecorded);
  useEffect(() => {
    recordedRef.current = onRecorded;
  }, [onRecorded]);

  // The in-flight guard of criterion 21. A ref rather than the state above,
  // because two clicks in one tick both read the same render's state.
  const inFlightRef = useRef<ClockAction | null>(null);

  // A response arriving after the panel has gone must not set state on it.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = useCallback((action: ClockAction) => {
    if (inFlightRef.current !== null) return;

    inFlightRef.current = action;
    setBusy(action);
    setFailure(null);

    void (async () => {
      try {
        const request = CLOCK_ACTION_REQUEST[action];
        await attendanceJson(request.url, request.init);
        // Criterion 20: the displayed state moves only on a success, and it moves
        // to what the service reports rather than to what the browser assumed.
        if (mountedRef.current) recordedRef.current?.();
      } catch (error) {
        if (mountedRef.current) setFailure(asApiFailure(error));
      } finally {
        inFlightRef.current = null;
        if (mountedRef.current) setBusy(null);
      }
    })();
  }, []);

  return { busy, failure, submit };
}

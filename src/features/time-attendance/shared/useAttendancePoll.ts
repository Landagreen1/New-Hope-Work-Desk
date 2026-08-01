// src/features/time-attendance/shared/useAttendancePoll.ts
// The module's one polling read: sixty seconds, paused while the tab is hidden,
// refetched the moment it comes back.
//
// Three panels have to keep themselves current — My Day's worked hours while a
// session is open (Requirement 4, criterion 4), Team Today's attendance state
// (Requirement 5, criterion 19), and the Live Coverage panel (Requirement 6,
// criterion 16) — each at sixty seconds or shorter. This is that read, once, so
// the three cannot end up on three different intervals, and so the visibility
// rule is written in one place rather than three.
//
// It is `useAsyncResource` with a timer on top: the same `status`, the same
// `failure`, the same `retry`. A polling screen therefore renders its loading,
// empty, and failed states exactly as a non-polling one does.
//
// ## Why the tab's visibility matters
//
// A minute timer left running in a background tab is a request a minute against
// four range queries, for a screen nobody is looking at, for as long as the
// browser stays open. Worse, when the reader comes back the panel is up to a
// minute stale and says nothing about it — which on a live clock display is the
// one thing it must not do. So the interval stops when
// `document.visibilityState` turns `hidden` and, on becoming visible, the read
// fires immediately and the interval restarts from that moment. A laptop reopened
// after lunch shows current state without a reload.
//
// Browsers throttle timers in background tabs rather than freezing them, so the
// pause is not something the runtime does for us — a throttled minute timer still
// fires, just late and unpredictably.
//
// ## Testing it
//
// Everything that decides *when* a read happens is a timer and a document event,
// so both are drivable without a network:
//
// ```ts
// vi.useFakeTimers();
// render(<TeamToday />);
// await vi.advanceTimersByTimeAsync(ATTENDANCE_POLL_INTERVAL_MS);   // one refetch
//
// Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
// document.dispatchEvent(new Event('visibilitychange'));
// await vi.advanceTimersByTimeAsync(ATTENDANCE_POLL_INTERVAL_MS * 3);   // none
// ```
//
// The interval is exported as a constant so a test asserts against the value the
// hook uses rather than against a literal that could drift away from it.
//
// Requirements: 4.4, 5.19, 5.20, 6.16, 22.14, 22.15, 22.16

'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';

import { useAsyncResource, type AsyncResource, type AsyncResourceOptions } from './useAsyncResource';

/**
 * Sixty seconds: the longest interval Requirements 4.4, 5.19, and 6.16 allow.
 *
 * The ceiling rather than something shorter because every one of these reads
 * answers a whole panel — a roster-wide day read, or a department's coverage —
 * and a screen open all day is 480 of them. The requirements set the bar at "60
 * seconds or shorter"; sitting on it is the cheapest way to clear it.
 */
export const ATTENDANCE_POLL_INTERVAL_MS = 60_000;

export interface AttendancePollOptions<T> extends AsyncResourceOptions<T> {
  /** Defaults to `ATTENDANCE_POLL_INTERVAL_MS`. A value of 0 or less polls not at all. */
  intervalMs?: number;
  /**
   * False keeps the read and drops the timer — for a screen that has taken over
   * refreshing itself, such as one showing a past date, where there is nothing
   * live to track.
   */
  poll?: boolean;
}

export interface AttendancePollResource<T> extends AsyncResource<T> {
  /** True while the timer is suspended because the tab is hidden. */
  paused: boolean;
}

/** Whether the tab is currently hidden. False anywhere `document` is absent. */
function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * The tab's visibility as an external store.
 *
 * `paused` is read from here rather than kept in state, because the browser owns
 * that fact and React is only reflecting it. Subscribing means the value is right
 * on the first render — a screen restored into a hidden tab reports paused
 * immediately, without a render in which it claims to be polling — and it means
 * nothing in this hook writes state outside an event callback.
 */
function subscribeToVisibility(onStoreChange: () => void): () => void {
  document.addEventListener('visibilitychange', onStoreChange);
  return () => document.removeEventListener('visibilitychange', onStoreChange);
}

/** On the server there is no tab to hide, so nothing is paused. */
function neverHidden(): boolean {
  return false;
}

/**
 * A polling read of a whole panel.
 *
 * Requirements: 4.4, 5.19, 6.16
 */
export function useAttendancePoll<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: AttendancePollOptions<T> = {},
): AttendancePollResource<T> {
  const { intervalMs = ATTENDANCE_POLL_INTERVAL_MS, poll = true, ...resourceOptions } = options;

  const resource = useAsyncResource(fetcher, resourceOptions);
  const { pending, refresh } = resource;

  const hidden = useSyncExternalStore(subscribeToVisibility, documentHidden, neverHidden);

  // A tick while a read is already outstanding would abort that read and start it
  // over, so a read slower than the interval would never finish. The ref is what
  // lets the timer see the current answer without being rebuilt each render.
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const active = poll && (resourceOptions.enabled ?? true) && intervalMs > 0;

  // The timer and the visibility listener are the external system this effect
  // synchronises with; every read it starts is started from one of their
  // callbacks, so the effect body itself only sets timers up and tears them down.
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;

    let timer: ReturnType<typeof setInterval> | null = null;

    function stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }

    function tick() {
      if (pendingRef.current) return;
      refresh();
    }

    function start() {
      stop();
      timer = setInterval(tick, intervalMs);
    }

    function handleVisibilityChange() {
      if (documentHidden()) {
        stop();
        return;
      }

      // Restarted before the immediate read, so the next tick is a full interval
      // after the tab came back rather than after whatever was left of the one
      // that was running when it went away.
      start();
      tick();
    }

    if (!documentHidden()) start();

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [active, intervalMs, refresh]);

  return { ...resource, paused: active && hidden };
}

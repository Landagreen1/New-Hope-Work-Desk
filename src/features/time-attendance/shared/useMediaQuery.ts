// src/features/time-attendance/shared/useMediaQuery.ts
// The module's one viewport test, and the two widths it is asked about.
//
// Almost every responsive rule in this module is expressible in CSS, and where it
// is, CSS is what implements it: a stacked arrangement becoming three columns at
// 1280 pixels is a `grid-cols` variant, and it needs no JavaScript to know how
// wide the window is.
//
// One rule is not. Requirement 7 asks the Request_Decision_Drawer to be the right
// *pane* of a three-pane layout at 1280 pixels and above (criterion 1), the third
// *stacked block* below that (criterion 2), and a full-width *overlay* below 768
// pixels (criterion 3). The first two are the same node in a different grid; the
// third is a different node in a different place in the tree, with a focus trap,
// an Escape handler, and a scrim — `SideDrawer`, which is the module's only drawer
// (Requirement 22, criteria 10 and 11). A stylesheet cannot move a subtree into a
// focus trap, so the choice between "inline pane" and "drawer" has to be made in
// the component, and that means asking how wide the viewport is.
//
// ## Why `useSyncExternalStore`
//
// The browser owns the answer; React is only reflecting it. Subscribing means the
// value is correct on the first render rather than after an effect, so a screen
// opened on a phone does not render the pane inline and then move it into a
// drawer — which would run the drawer's focus effect a frame after the reader
// already got a full-width panel. It is the same reason `useAttendancePoll` reads
// `document.visibilityState` this way rather than mirroring it into state.
//
// The server snapshot is `false` for both queries. On the server there is no
// viewport, and `false` is the arrangement that needs no JavaScript to be
// correct: panes in document order, and the decision pane inline rather than a
// drawer with nothing to trap focus for.
//
// Requirements: 7.1, 7.2, 7.3, 22.3, 22.8

'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Below 768 pixels: the width at which a detail pane becomes a full-width
 * overlay.
 *
 * `767.9px` rather than `767px`, because a viewport can be a fractional width on
 * a scaled display and `max-width: 767px` would leave 767.5 matching neither this
 * query nor `min-width: 768px`. The two together partition every width.
 *
 * Requirements: 7.3, 22.3
 */
export const OVERLAY_VIEWPORT_QUERY = '(max-width: 767.9px)';

/**
 * 1280 pixels and above: the width at which the Time Off & Coverage panes sit
 * side by side rather than stacked.
 *
 * Exported for the screens that need it in JavaScript. A screen that can express
 * the same rule in a `xl:` variant should do that instead — this constant is the
 * same breakpoint Tailwind's `xl` uses, so the two cannot disagree.
 *
 * Requirements: 7.1, 7.2
 */
export const THREE_PANE_VIEWPORT_QUERY = '(min-width: 1280px)';

/** Nothing to unsubscribe from: no `window`, or no `matchMedia` on it. */
function noSubscription(): void {}

/** The server, and any runtime without `matchMedia`, match nothing. */
function neverMatches(): boolean {
  return false;
}

/**
 * Whether the viewport currently matches a media query.
 *
 * ```ts
 * const overlay = useMediaQuery(OVERLAY_VIEWPORT_QUERY);
 * ```
 *
 * Requirements: 7.1, 7.2, 7.3, 22.3
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return noSubscription;
      }

      const list = window.matchMedia(query);
      // Guarded because a `MediaQueryList` without `addEventListener` still
      // answers `matches`, and a static answer is better than a thrown render.
      if (typeof list.addEventListener !== 'function') return noSubscription;

      list.addEventListener('change', onStoreChange);
      return () => list.removeEventListener('change', onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, neverMatches);
}

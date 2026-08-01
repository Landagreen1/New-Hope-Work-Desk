// src/features/time-attendance/shared/useNavigationTarget.tsx
// How the section being rendered receives the record it was navigated to.
//
// `TimeAttendanceWorkspace` resolves the navigation target, decides which
// section owns it, and provides the checked target to that section's subtree.
// The owning screen reads it with `useNavigationTarget`, opens the record's
// drawer, and calls `consume` — which clears the target from navigation state so
// the same record cannot reopen on a later render.
//
// ## Why a context rather than a prop
//
// The target belongs to whichever screen owns the record, and the screens that
// own records are being built across several tasks. A context means the workspace
// hands the target to the active section once, and a screen picks it up wherever
// in its own tree the drawer happens to live, without a prop threaded through
// every component in between. A screen rendered without the provider — in a test,
// or before it consumes targets at all — sees no target and behaves as it does
// today.
//
// ## The pattern a screen uses
//
// ```tsx
// const { target, consume } = useNavigationTarget();
//
// // Resolved once, from the target that was present on mount.
// const [openRecordId, setOpenRecordId] = useState(
//   () => (target?.openDrawer === true ? target.recordId : null),
// );
//
// useEffect(() => {
//   if (target !== null) consume();
// }, [target, consume]);
// ```
//
// The drawer state is seeded from the target rather than set in an effect, so the
// first paint already has the drawer open and nothing re-opens it afterwards. If
// the screen's own read then comes back empty or refused, it clears that state and
// renders `NavigationTargetNotice` with the reason instead, which is the second
// half of Requirement 1, criterion 12.
//
// Requirements: 1.11, 1.12, 17.6

'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { SectionNavigationTarget } from './navigation-target';

export interface NavigationTargetContextValue {
  /**
   * The record this screen was navigated to, or null when it was reached
   * directly. Becomes null once consumed.
   */
  target: SectionNavigationTarget | null;
  /**
   * Called by the owning screen once it has acted on the target. Clears the
   * target from navigation state; calling it more than once is harmless.
   */
  consume: () => void;
}

const EMPTY: NavigationTargetContextValue = { target: null, consume: () => {} };

const NavigationTargetContext = createContext<NavigationTargetContextValue>(EMPTY);

export function NavigationTargetProvider({
  target,
  onConsumed,
  children,
}: {
  target: SectionNavigationTarget | null;
  onConsumed?: () => void;
  children: ReactNode;
}) {
  const value = useMemo<NavigationTargetContextValue>(
    () => ({ target, consume: () => onConsumed?.() }),
    [target, onConsumed],
  );

  return (
    <NavigationTargetContext.Provider value={value}>{children}</NavigationTargetContext.Provider>
  );
}

/** The record target for the screen calling this hook. */
export function useNavigationTarget(): NavigationTargetContextValue {
  return useContext(NavigationTargetContext);
}

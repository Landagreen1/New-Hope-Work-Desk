// src/features/time-attendance/shared/StatusIcon.tsx
// The one place a `StatusToken.icon` name becomes a glyph.
//
// `domain/presentation.ts` names icons as strings because the domain layer holds
// no React. Something has to turn those names into components, and doing it here
// — once — means the icon set is imported in exactly one module, and a token
// naming an icon nobody registered is a single failure to find rather than a
// missing glyph on whichever screen happened to render that status.
//
// Requirements: 22.6

'use client';

import {
  Activity,
  AlarmClock,
  Ban,
  CalendarClock,
  CalendarOff,
  CalendarPlus,
  CalendarX,
  CircleCheck,
  CircleGauge,
  CirclePercent,
  CircleQuestionMark,
  CircleX,
  Coffee,
  Hourglass,
  ListOrdered,
  LogIn,
  LogOut,
  MessageSquareWarning,
  OctagonAlert,
  ShieldCheck,
  TimerOff,
  TreePalm,
  TriangleAlert,
  UserX,
  type LucideIcon,
} from 'lucide-react';

/**
 * Every icon name the status table uses.
 *
 * Keyed by the string `STATUS_PRESENTATION` carries, so the two are checked
 * against each other by a single lookup rather than by matching two lists by
 * eye.
 */
export const STATUS_ICONS: Record<string, LucideIcon> = {
  Activity,
  AlarmClock,
  Ban,
  CalendarClock,
  CalendarOff,
  CalendarPlus,
  CalendarX,
  CircleCheck,
  CircleGauge,
  CirclePercent,
  CircleQuestionMark,
  CircleX,
  Coffee,
  Hourglass,
  ListOrdered,
  LogIn,
  LogOut,
  MessageSquareWarning,
  OctagonAlert,
  ShieldCheck,
  TimerOff,
  TreePalm,
  TriangleAlert,
  UserX,
};

/**
 * A status token's icon.
 *
 * Always decorative: the pill renders the token's label as text beside it, so
 * the glyph is hidden from assistive technology to avoid announcing the same
 * status twice.
 *
 * A name with no entry falls back to the question mark rather than rendering
 * nothing, so the pill still carries a glyph beside its colour — which is the
 * whole of criterion 6 — while the missing registration stays visible as a
 * question mark on screen.
 */
export function StatusIcon({ name, className }: { name: string; className?: string }) {
  const Icon = STATUS_ICONS[name] ?? CircleQuestionMark;
  return <Icon className={className} aria-hidden="true" />;
}

// src/features/time-attendance/shared/CoverageBadge.tsx
// A Coverage_Status or Health_Ribbon state rendered as colour, label, icon, and —
// where the caller has them — the two headcounts behind it.
//
// The same rule as `StatusPill`: the component takes a status value and reads
// `statusToken` for the colour, the label, and the icon, so a coverage figure
// cannot be rendered in a colour a cell picked for itself. It exists separately
// because coverage is the one status family that is displayed with its own
// arithmetic beside it — available against required — and the coverage panel, the
// calendar, the impact preview, and the ribbon all need that pairing spelled the
// same way.
//
// A date cell using this badge renders one status indicator and two of the four
// numeric values Requirement 8, criterion 3 allows, leaving the cell two more for
// the counts it adds itself.
//
// When `requiredStaff` is null the badge says so in words. An unconfigured
// `staffing_thresholds` slot reports required staffing as unconfigured and status
// Healthy (Requirement 6, criterion 4), and a blank or a zero in place of the
// number would read as a requirement of none rather than as a gap in the
// configuration.
//
// Requirements: 6.4, 8.4, 18.7, 22.5, 22.6, 22.12, 22.13

'use client';

import type { CoverageStatus, RibbonState } from '../domain/coverage';
import { statusToken } from '../domain/presentation';
import { StatusIcon } from './StatusIcon';
import { PILL_ICON_SIZE, pillClassName, type PillSize } from './tokens';

export interface CoverageBadgeProps {
  /** A Coverage_Status, or one of the five Health_Ribbon states. */
  status: CoverageStatus | RibbonState;
  /**
   * The available headcount the status was classified from. Omitted where the
   * badge stands for a date rather than a figure, as on the ribbon.
   */
  available?: number;
  /**
   * `staffing_thresholds.minimum_staff`, or null for an unconfigured slot.
   * Ignored unless `available` is supplied.
   */
  requiredStaff?: number | null;
  /** `sm` for table rows and calendar cells, `md` for a heading. Defaults to `sm`. */
  size?: PillSize;
  className?: string;
}

/**
 * The counts as visible text, and the whole badge as an accessible name.
 *
 * Split out from the component so the wording is testable without a DOM, and so
 * the visible text and the announced name are produced together — the two cannot
 * describe different figures.
 *
 * Requirements: 6.4, 22.12
 */
export function coverageBadgeText(input: {
  label: string;
  available?: number;
  requiredStaff?: number | null;
}): { counts: string | null; accessibleName: string } {
  const { label, available, requiredStaff } = input;

  if (available === undefined) {
    return { counts: null, accessibleName: `Coverage ${label.toLowerCase()}` };
  }

  const counts =
    requiredStaff === undefined || requiredStaff === null
      ? `${available}, no minimum set`
      : `${available} of ${requiredStaff}`;

  const spoken =
    requiredStaff === undefined || requiredStaff === null
      ? `${available} available, no minimum staffing configured`
      : `${available} available of ${requiredStaff} required`;

  return { counts, accessibleName: `Coverage ${label.toLowerCase()}: ${spoken}` };
}

/**
 * One coverage status, as a badge.
 *
 * Requirements: 6.4, 8.4, 18.7, 22.5, 22.6, 22.12
 */
export function CoverageBadge({
  status,
  available,
  requiredStaff,
  size = 'sm',
  className,
}: CoverageBadgeProps) {
  const token = statusToken(status);
  const { counts, accessibleName } = coverageBadgeText({
    label: token.label,
    available,
    requiredStaff,
  });

  // With the counts, the pill is one compound indicator, so it carries its own
  // name; without them the label is the name already and a second one would
  // only be a copy of it.
  const naming: { role?: 'img'; 'aria-label'?: string } =
    counts === null ? {} : { role: 'img', 'aria-label': accessibleName };

  return (
    <span className={pillClassName(token.role, size, className)} data-status={status} {...naming}>
      <StatusIcon name={token.icon} className={PILL_ICON_SIZE[size]} />
      {token.label}
      {counts !== null ? <span className="font-bold opacity-80">{counts}</span> : null}
    </span>
  );
}

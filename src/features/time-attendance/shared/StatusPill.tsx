// src/features/time-attendance/shared/StatusPill.tsx
// A status rendered as colour, label, and icon together.
//
// Every status the module shows goes through this component or through
// `CoverageBadge`. Neither takes a colour, a label, or an icon as a prop: they
// take a status value and read `statusToken` for all three. A screen therefore
// cannot render a status in a colour of its own choosing, which is how
// Requirement 22, criteria 5 and 6, along with Requirement 8, criterion 4,
// Requirement 12, criterion 9, and Requirement 18, criterion 7, hold across
// every screen at once.
//
// The label is real text, so the pill's accessible name is its label with no
// `aria-label` needed (Requirement 22, criterion 12), and the icon is hidden from
// assistive technology so the status is announced once rather than twice.
//
// Requirements: 8.4, 12.9, 18.7, 22.5, 22.6, 22.12, 22.13

'use client';

import { statusToken, type StatusValue } from '../domain/presentation';
import { StatusIcon } from './StatusIcon';
import { PILL_ICON_SIZE, pillClassName, type PillSize } from './tokens';

export interface StatusPillProps {
  /** A value from any of the four status families. */
  status: StatusValue;
  /** `sm` for table rows and calendar cells, `md` for a heading. Defaults to `sm`. */
  size?: PillSize;
  className?: string;
}

/**
 * One status, as a pill.
 *
 * Requirements: 22.5, 22.6, 22.13
 */
export function StatusPill({ status, size = 'sm', className }: StatusPillProps) {
  const token = statusToken(status);

  return (
    <span className={pillClassName(token.role, size, className)} data-status={status}>
      <StatusIcon name={token.icon} className={PILL_ICON_SIZE[size]} />
      {token.label}
    </span>
  );
}

// src/features/time-attendance/shared/NavigationTargetNotice.tsx
// The reason a navigated-to record could not be opened.
//
// Rendered in place of the detail drawer when a target names a record this
// caller cannot read, names no record, or names one the owning screen's read did
// not return. The screen itself still renders: the reader arrived somewhere
// useful and is told why the record is not in front of them, rather than
// watching a drawer fail to open.
//
// The reason is visible text beside a labelled icon, not a tooltip and not
// colour alone, which is Requirement 22, criteria 6 and 7.
//
// Requirements: 1.12, 22.6, 22.7

'use client';

import { Info } from 'lucide-react';

export function NavigationTargetNotice({ reason }: { reason: string }) {
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-amber-900"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-xs font-black uppercase tracking-wider">Record unavailable</p>
        <p className="mt-0.5 text-[13px] font-semibold">{reason}</p>
      </div>
    </div>
  );
}

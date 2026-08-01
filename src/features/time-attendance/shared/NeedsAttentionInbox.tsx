// src/features/time-attendance/shared/NeedsAttentionInbox.tsx
// The Needs_Attention_Inbox: one control, mounted on every Time & Attendance
// screen, listing everything the module has left unresolved.
//
// Requirement 17 exists because the work an administrator has to do is spread
// across four screens. This control is the answer: a count that is visible from
// wherever they are, a compact list behind it, and one selection that lands on the
// screen that owns the record with that record open.
//
// ## What it decides, and what it does not
//
// Nothing about the items. The item set, the collapse of a record that qualifies
// under several categories, the reason text, and the order are all `buildInbox`'s,
// through `/api/attendance/inbox`, which is a single request for the whole set
// (Requirement 17, criterion 9). This component renders that list and turns a
// selection into a `NavigationTarget`; the screen a target lands on is
// `navigationTargetForRecord`'s answer, not this component's.
//
// What it holds is the presentation of a category — a colour role and a glyph —
// which is the same division `useAsyncResource` makes for its four states: the
// domain names the category, `shared/tokens.ts` owns the palette, and the table
// below picks a role from it. So no category is ever conveyed by colour alone
// (Requirement 22, criteria 6 and 7): every row carries the category's label and
// icon beside its colour, and the reason as visible text under it.
//
// ## Refreshing
//
// The read runs once on mount, so the count is right from the first paint, and
// again whenever the list is opened or Refresh is pressed. That is Requirement 17,
// criterion 10: the item set is rebuilt from the sources on the server every time,
// so a record whose condition has been resolved is simply absent from the next
// answer — there is nothing here to remove.
//
// It deliberately does not poll. The three panels that poll are the ones showing a
// live clock or a live headcount (Requirements 4.4, 5.19, 6.16); this control is
// mounted on all six screens at once, and a minute timer on a composite read in six
// places is load nobody asked for. A reader who wants the current list opens it,
// which reads it.
//
// Requirements: 17.1, 17.2, 17.5, 17.6, 17.7, 17.10, 22.6, 22.7, 22.9, 22.12,
// 22.14, 22.15, 22.16

'use client';

import { ChevronDown, Inbox, RotateCw } from 'lucide-react';
import { useCallback, useState } from 'react';

import type { NavigationTarget } from '@/components/app-sidebar';

import { INBOX_CATEGORIES, type InboxCategory, type InboxItem } from '../domain/inbox';
import type { InboxResponse } from '../server/inbox-service';
import { attendanceJson } from './api-failure';
import { AsyncStateBlock } from './AsyncStateBlock';
import { formatElapsedMinutes, NO_VALUE } from './format';
import { navigationTargetForRecord } from './navigation-target';
import { StatusIcon } from './StatusIcon';
import { colorRoleToken, PILL_ICON_SIZE, pillClassName, type ColorRole } from './tokens';
import { useAsyncResource } from './useAsyncResource';

/** The colour role and glyph one category renders as. */
interface CategoryPresentation {
  role: ColorRole;
  /** A glyph name registered in `shared/StatusIcon.tsx`. */
  icon: string;
}

/**
 * Colour role and icon per category.
 *
 * Roles follow the same reading of Requirement 22, criterion 5 that
 * `STATUS_PRESENTATION` uses, so an inbox row and the status pill on the record it
 * points at carry the same colour: a held payroll and a date below minimum
 * staffing are Critical, a missing punch is payroll-blocking and Critical with
 * them, and the three categories whose next step is a human decision are Pending.
 *
 * The labels are not here. They are `INBOX_CATEGORIES`', so the words in a row and
 * the words in the domain's own description of that category cannot drift apart.
 *
 * Requirements: 22.5, 22.6
 */
const CATEGORY_PRESENTATION: Record<InboxCategory, CategoryPresentation> = {
  payroll_blocking: { role: 'critical', icon: 'OctagonAlert' },
  critical_coverage: { role: 'critical', icon: 'CircleGauge' },
  missing_punch: { role: 'critical', icon: 'TimerOff' },
  pending_request: { role: 'pending', icon: 'Hourglass' },
  unapproved_unscheduled: { role: 'pending', icon: 'CalendarPlus' },
  unapproved_correction: { role: 'pending', icon: 'CircleQuestionMark' },
  unresolved_exception: { role: 'pending', icon: 'TriangleAlert' },
};

/** The label, colour, and glyph for one category. */
function categoryToken(category: InboxCategory) {
  const presentation = CATEGORY_PRESENTATION[category];
  return { label: INBOX_CATEGORIES[category].label, ...presentation };
}

/**
 * How long an item has been waiting, or how long until the date it is about:
 * `3 days ago`, `in 2 days`, `just now`.
 *
 * `ageMinutes` is signed — negative for a critical coverage date the evaluation
 * instant has not reached — so the direction is stated rather than dropped. A
 * future date rendered as "2 days ago" would be a plain falsehood about the one
 * source that looks forward.
 *
 * The magnitude is `formatElapsedMinutes`', which is the module's one elapsed
 * spelling, so an age in the inbox reads as an age in the Request_Inbox does.
 *
 * Requirements: 17.7, 22.12
 */
export function inboxAgePhrase(ageMinutes: number): string {
  if (!Number.isFinite(ageMinutes)) return NO_VALUE;
  if (ageMinutes >= 1) return `${formatElapsedMinutes(ageMinutes)} ago`;
  if (ageMinutes <= -1) return `in ${formatElapsedMinutes(-ageMinutes)}`;
  return 'just now';
}

/** The categories an item qualified under besides the one it is filed as. */
function alsoLabels(item: InboxItem): string {
  return item.categories
    .filter((category) => category !== item.category)
    .map((category) => INBOX_CATEGORIES[category].label)
    .join(', ');
}

export interface NeedsAttentionInboxProps {
  /**
   * Whether the signed-in user administers attendance, which decides the screen a
   * selected record opens on. It does not decide the item set: that is scoped on
   * the server, by the same visibility seam every other read uses (Requirement 17,
   * criterion 8).
   */
  canAdminister: boolean;
  /**
   * Called with the target a selected item names. The workspace's caller puts it
   * into navigation state, which is what moves the reader to the owning screen.
   *
   * Requirements: 17.6
   */
  onSelect: (target: NavigationTarget) => void;
  className?: string;
}

/**
 * The unresolved count, and the compact list behind it.
 *
 * Requirements: 17.1, 17.2, 17.5, 17.6, 17.7, 17.10
 */
export function NeedsAttentionInbox({
  canAdminister,
  onSelect,
  className,
}: NeedsAttentionInboxProps) {
  const [open, setOpen] = useState(false);

  const inbox = useAsyncResource(
    (signal) => attendanceJson<InboxResponse>('/api/attendance/inbox', { signal }),
    { subject: 'unresolved items', isEmpty: (response) => response.items.length === 0 },
  );

  const { refresh } = inbox;
  const items = inbox.data?.items ?? [];
  const count = inbox.data === null ? null : inbox.data.unresolvedCount;

  // Opening the list reads it again, which is the refresh criterion 10 describes:
  // an item whose condition was resolved on the screen behind this control is
  // absent from the answer that arrives.
  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next) refresh();
  }, [open, refresh]);

  const select = useCallback(
    (item: InboxItem) => {
      setOpen(false);
      onSelect(navigationTargetForRecord(item.recordKind, item.recordId, canAdminister));
    },
    [canAdminister, onSelect],
  );

  // The badge takes the worst item's colour, and the list is ordered worst first,
  // so a collapsed inbox says how serious the waiting work is as well as how much
  // of it there is. Nothing waiting reads as Healthy rather than as an absence.
  const badgeRole: ColorRole =
    items.length === 0 ? 'healthy' : CATEGORY_PRESENTATION[items[0].category].role;

  return (
    <section
      aria-labelledby="needs-attention-heading"
      className={[
        'rounded-[22px] border border-slate-200 bg-white px-4 py-3 shadow-sm sm:px-5',
        className ?? '',
      ]
        .filter((part) => part !== '')
        .join(' ')}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="needs-attention-list"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1 py-1 text-left transition hover:bg-slate-50"
        >
          <Inbox className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
          <span
            id="needs-attention-heading"
            className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
          >
            Needs attention
          </span>
          <span className={pillClassName(badgeRole)}>
            {count === null ? NO_VALUE : count}
            {count === 0 ? ' \u2014 all clear' : ''}
          </span>
          <ChevronDown
            className={`ml-auto h-4 w-4 shrink-0 text-slate-400 transition-transform${open ? ' rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>

        {/* Its own control rather than part of the toggle: pressing Refresh should
            not also collapse the list the reader is looking at. */}
        <button
          type="button"
          onClick={refresh}
          disabled={inbox.pending}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCw
            className={`h-3 w-3${inbox.pending ? ' animate-spin' : ''}`}
            aria-hidden="true"
          />
          Refresh
        </button>
      </div>

      <div id="needs-attention-list" hidden={!open} className="mt-2">
        <AsyncStateBlock
          status={inbox.status}
          failure={inbox.failure}
          message={inbox.emptyMessage}
          onRetry={inbox.retry}
          pending={inbox.pending}
          subject="unresolved items"
        />

        {items.length > 0 && (
          <ul className="max-h-[24rem] space-y-1.5 overflow-y-auto pr-0.5">
            {items.map((item) => {
              const token = categoryToken(item.category);
              const roleToken = colorRoleToken(token.role);
              const also = alsoLabels(item);

              return (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => select(item)}
                    className={`w-full rounded-xl border px-3 py-2 text-left transition hover:bg-slate-50 ${roleToken.border}`}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={pillClassName(token.role)}>
                        <StatusIcon name={token.icon} className={PILL_ICON_SIZE.sm} />
                        {token.label}
                      </span>
                      <span className="min-w-0 text-[13px] font-black text-slate-950">
                        {item.subject.label}
                      </span>
                      <span className="ml-auto text-[11px] font-semibold text-slate-400">
                        {inboxAgePhrase(item.ageMinutes)}
                      </span>
                    </span>
                    <span className="mt-1 block text-[12px] font-semibold text-slate-600">
                      {item.reason}
                    </span>
                    {also !== '' && (
                      <span className="mt-0.5 block text-[11px] font-semibold text-slate-400">
                        Also: {also}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

export default NeedsAttentionInbox;

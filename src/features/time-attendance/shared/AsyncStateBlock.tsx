// src/features/time-attendance/shared/AsyncStateBlock.tsx
// The loading, empty, and failed states of Requirement 22, criteria 14 through
// 16, rendered once for the whole module.
//
// `useAsyncResource` decides which of the four non-content states a read is in
// and `asyncStateToken` decides how that state looks. This is the component that
// puts the two on screen, so a failed read on Today and a failed read on Review
// are the same event and are presented as one — which is the reason the token
// table exists at all.
//
// Three rules it holds for every screen:
//
//   - The reason is visible text beside a glyph and a heading, never colour on
//     its own (criteria 6 and 7).
//   - A failure offers the retry control, and only a failure the contract calls
//     retryable offers it: pressing Retry on a refusal changes nothing and reads
//     as a broken screen.
//   - The empty state names the active filters, which the caller supplies as
//     `message` from `AsyncResource.emptyMessage`.
//
// It renders `null` for `ready`, so a screen can place it above its content
// unconditionally and let it disappear when there is content to show.
//
// Requirements: 22.6, 22.7, 22.12, 22.14, 22.15, 22.16

'use client';

import { RotateCw } from 'lucide-react';

import type { ApiFailure } from './api-failure';
import { StatusIcon } from './StatusIcon';
import { asyncStateToken, type AsyncResourceStatus } from './useAsyncResource';

export interface AsyncStateBlockProps {
  /** The resource's status. `ready` renders nothing. */
  status: AsyncResourceStatus;
  /**
   * The last failure, or null. A failure is displayed whenever it is present,
   * including over held content, so a poll that stopped working says so instead
   * of leaving a stale panel looking current.
   */
  failure?: ApiFailure | null;
  /** The empty-state sentence, naming the active filters. */
  message?: string;
  /** The retry control of criterion 16. Offered for a retryable failure only. */
  onRetry?: () => void;
  /** True while a retry is in flight, so the control reads as busy. */
  pending?: boolean;
  /** What is being loaded, for the loading heading: `your shift`, `records`. */
  subject?: string;
  className?: string;
}

/**
 * One non-content state: a glyph, a heading, the reason in words, and a retry
 * control where retrying could help.
 *
 * Requirements: 22.14, 22.15, 22.16
 */
export function AsyncStateBlock({
  status,
  failure = null,
  message,
  onRetry,
  pending = false,
  subject,
  className,
}: AsyncStateBlockProps) {
  // A failure is reported as a failure even when content is held, because the
  // reader needs to know the figures in front of them stopped refreshing.
  const effective: AsyncResourceStatus = failure !== null ? 'failed' : status;
  const token = asyncStateToken(effective);
  if (token === null) return null;

  const detail =
    failure !== null
      ? failure.reason
      : effective === 'empty'
        ? (message ?? 'There is nothing to show here yet.')
        : effective === 'loading'
          ? `Loading ${subject ?? 'this section'}\u2026`
          : (message ?? 'Nothing has been selected yet.');

  const heading = effective === 'loading' && subject !== undefined ? `Loading ${subject}` : token.title;
  const showRetry = onRetry !== undefined && failure !== null && failure.retryable;

  return (
    <div
      role={effective === 'failed' ? 'alert' : 'status'}
      className={[
        'flex items-start gap-2.5 rounded-xl border px-3.5 py-3',
        token.surface,
        token.text,
        token.border,
        className ?? '',
      ]
        .filter((part) => part !== '')
        .join(' ')}
    >
      <StatusIcon
        name={token.icon}
        className={`mt-0.5 h-4 w-4 shrink-0${effective === 'loading' ? ' animate-pulse' : ''}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-black uppercase tracking-wider">{heading}</p>
        <p className="mt-0.5 text-[13px] font-semibold">{detail}</p>
      </div>
      {showRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={pending}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-current/20 bg-white/70 px-2.5 py-1.5 text-[11px] font-black transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCw className={`h-3 w-3${pending ? ' animate-spin' : ''}`} aria-hidden="true" />
          {pending ? 'Retrying' : 'Retry'}
        </button>
      )}
    </div>
  );
}

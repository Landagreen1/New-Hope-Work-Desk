// src/features/time-attendance/today/SalesQueueStatus.tsx
// Two statuses, two labels, one explicit action.
//
// Spec: .kiro/specs/attendance-queue-status-separation, task 7.2
// Requirements: 2.14, 2.15, 2.16, 2.17, 2.18
//
// Attendance status and sales-queue status are two different facts about an
// employee, and until this fix the desk showed the second one labelled
// `Available` with no mention of sales queues, the first one on a different
// screen, and the two never together. `Available` was ambiguous and a clocked-in
// employee had no visible or actionable queue status (defect 1.9).
//
// So: both values, each under its own label, from the payload the server returned
// or the next `/api/time-clock/active` read — never from an assumption (2.18).
// The sales-queue line is absent for a non-agent, because queue status governs
// nothing for them.
//
// Every string on this panel comes from `domain/queue-status.ts`. The wording of
// 2.15, 2.16 and 2.17 is a rule, so it lives in the domain layer beside the rule
// that selects it, and this component renders what it is given.

'use client';

import { ui } from '../../nhwd-shared/ui';
import {
  QUEUE_ACTION_LABELS,
  queueStatusNotice,
  statusLines,
  type QueueStatusAction,
  type StatusView,
} from '../domain/queue-status';
import { StatusIcon } from '../shared/StatusIcon';
import { colorRoleToken } from '../shared/tokens';

export interface SalesQueueStatusProps extends StatusView {
  /** True while a queue-status change is in flight. */
  busy?: boolean;
  /** The message from a refused queue-status change, displayed unchanged. */
  failure?: string | null;
  /** Perform the explicit action the notice offers. */
  onAction?: (action: QueueStatusAction) => void;
}

/**
 * The two labelled statuses and, when one applies, the sentence and the action
 * that go with them.
 *
 * Requirements: 2.14, 2.15, 2.16, 2.17, 2.18
 */
export function SalesQueueStatus({
  attendanceStatus,
  queueStatus,
  queueStatusMode,
  isAgent,
  busy = false,
  failure = null,
  onAction,
}: SalesQueueStatusProps) {
  const view: StatusView = { attendanceStatus, queueStatus, queueStatusMode, isAgent };
  const lines = statusLines(view);
  const notice = queueStatusNotice(view);
  const critical = colorRoleToken('critical');

  return (
    <div className="space-y-2.5" data-testid="sales-queue-status">
      {/* Criterion 2.14: two separately labelled values. The label and the value
          are one string, so nothing renders the bare word `Available`. */}
      <ul className="flex flex-wrap gap-2">
        {lines.map((line) => (
          <li
            key={line.id}
            data-testid={`status-line-${line.id}`}
            className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-black uppercase tracking-[0.12em] text-slate-600"
          >
            {line.text}
          </li>
        ))}
      </ul>

      {notice !== null && (
        <div
          data-testid="queue-status-notice"
          className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3"
        >
          <p className="text-[13px] font-semibold text-slate-700">{notice.message}</p>
          {notice.action !== null && onAction !== undefined && (
            <button
              type="button"
              onClick={() => onAction(notice.action as QueueStatusAction)}
              disabled={busy}
              className={notice.action === 'join_sales_queues' ? ui.btnPrimary : ui.btnSecondary}
            >
              {busy
                ? `${QUEUE_ACTION_LABELS[notice.action]}\u2026`
                : QUEUE_ACTION_LABELS[notice.action]}
            </button>
          )}
        </div>
      )}

      {failure !== null && failure !== '' && (
        <div
          role="alert"
          data-testid="queue-status-failure"
          className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 ${critical.surface} ${critical.text} ${critical.border}`}
        >
          <StatusIcon name="TriangleAlert" className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-black uppercase tracking-wider">
              Sales queue status not changed
            </p>
            <p className="mt-0.5 text-[13px] font-semibold">{failure}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default SalesQueueStatus;

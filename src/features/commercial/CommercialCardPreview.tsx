'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CheckSquare, MessageSquare, Paperclip } from 'lucide-react';
import { useState } from 'react';

import CommercialCardDetail from './CommercialCardDetail';
import type { CommercialQuote } from './types';
import { LOCKED_COLUMNS } from './types';

interface CommercialCardPreviewProps {
  quote: CommercialQuote;
  onRefresh?: () => Promise<void>;
  isManager?: boolean;
  currentUserId?: string;
  boardAgents?: { id: string; display_name: string; initials: string }[];
  onReassign?: (cardId: string, newAssignee: string) => Promise<void>;
}

function getRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 1) return 'Today';
  if (days === 1) return '1 day';
  if (days < 7) return `${days} days`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return '1 week';
  if (weeks < 5) return `${weeks} weeks`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month';
  return `${months} months`;
}

function getCommentCount(quote: CommercialQuote): number {
  if (!quote.commercial_quote_comments) return 0;
  const arr = quote.commercial_quote_comments as Array<{ count: number }>;
  if (arr.length === 0) return 0;
  return arr[0]?.count ?? 0;
}

function getAttachmentCount(quote: CommercialQuote): number {
  if (!quote.commercial_quote_attachments) return 0;
  const arr = quote.commercial_quote_attachments as Array<{ count: number }>;
  if (arr.length === 0) return 0;
  return arr[0]?.count ?? 0;
}

function getChecklistProgress(quote: CommercialQuote): { checked: number; total: number } | null {
  if (!quote.commercial_quote_checklists || quote.commercial_quote_checklists.length === 0) return null;
  let checked = 0;
  let total = 0;
  for (const cl of quote.commercial_quote_checklists) {
    for (const item of cl.commercial_quote_checklist_items) {
      total++;
      if (item.is_checked) checked++;
    }
  }
  if (total === 0) return null;
  return { checked, total };
}

export default function CommercialCardPreview({
  quote,
  onRefresh,
  isManager,
  currentUserId,
  boardAgents,
  onReassign,
}: CommercialCardPreviewProps) {
  const [showDetail, setShowDetail] = useState(false);
  const [showReassign, setShowReassign] = useState(false);

  const isLocked = !isManager && LOCKED_COLUMNS.includes(quote.board_column);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: quote.id,
    disabled: isLocked,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const commentCount = getCommentCount(quote);
  const attachmentCount = getAttachmentCount(quote);
  const checklistProgress = getChecklistProgress(quote);
  const agentName = quote.profiles?.display_name ?? 'Unassigned';

  // Time since last update — visual staleness marker
  const daysSinceUpdate = Math.floor((Date.now() - new Date(quote.updated_at).getTime()) / 86400000);
  const lastUpdateLabel = getRelativeTime(quote.updated_at);
  const lastUpdateDate = (() => { const d = new Date(quote.updated_at); const m = String(d.getMonth()+1).padStart(2,'0'); const dy = String(d.getDate()).padStart(2,'0'); const h = d.getHours(); const mi = String(d.getMinutes()).padStart(2,'0'); const ap = h >= 12 ? 'PM' : 'AM'; const h12 = h % 12 || 12; return `${m}/${dy}/${d.getFullYear()} ${h12}:${mi} ${ap}`; })();
  const lastUpdateColor =
    daysSinceUpdate <= 2 ? 'bg-emerald-500' :
    daysSinceUpdate <= 7 ? 'bg-amber-400' :
    daysSinceUpdate <= 14 ? 'bg-orange-500' :
    'bg-rose-500';

  // Agent label color based on first letter (matching Trello's member colors)
  const labelColors = [
    'bg-blue-600', 'bg-emerald-600', 'bg-violet-600', 'bg-amber-600',
    'bg-rose-600', 'bg-cyan-600', 'bg-pink-600', 'bg-indigo-600',
  ];
  const labelColor = labelColors[agentName.charCodeAt(0) % labelColors.length];

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...(isLocked ? {} : listeners)}
        onClick={() => setShowDetail(true)}
        className={`rounded-xl border bg-white p-3.5 transition ${
          isLocked
            ? 'cursor-default border-slate-200 opacity-70'
            : 'cursor-pointer border-slate-100 shadow-sm hover:border-[#223f7a]/20 hover:shadow-lg hover:shadow-slate-200/60'
        }`}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setShowDetail(true);
          }
        }}
      >
        {/* Agent label */}
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className={`rounded-md px-2 py-0.5 text-[10px] font-black text-white ${labelColor}`}>
              {agentName.split(' ')[0]}
            </span>
            {/* Reassign button — managers only */}
            {isManager && onReassign && boardAgents && boardAgents.length > 0 && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowReassign(!showReassign); }}
                className="rounded px-1 py-0.5 text-[9px] font-bold text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="Reassign card"
              >
                ↻
              </button>
            )}
          </div>
          {quote.is_mirrored && isManager && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500">
              Mirrored
            </span>
          )}
          {isLocked && (
            <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[9px] font-bold text-slate-600">
              View Only
            </span>
          )}
        </div>

        {/* Reassign dropdown */}
        {showReassign && isManager && onReassign && boardAgents && (
          <div className="mb-2 rounded-lg border border-slate-200 bg-white p-1.5 shadow-sm">
            <select
              className="w-full rounded border-slate-200 text-[11px] font-semibold text-slate-700"
              defaultValue={quote.assigned_to}
              onChange={(e) => {
                if (e.target.value !== quote.assigned_to) {
                  void onReassign(quote.id, e.target.value);
                }
                setShowReassign(false);
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {boardAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.display_name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Business name */}
        <p className="text-sm font-black leading-snug text-slate-900">{quote.business_name}</p>

        {/* Metadata row */}
        <div className="mt-2.5 flex items-center gap-3 text-[10px] font-semibold text-slate-400">
          {commentCount > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageSquare className="h-3 w-3" />
              {commentCount}
            </span>
          )}
          {attachmentCount > 0 && (
            <span className="flex items-center gap-0.5">
              <Paperclip className="h-3 w-3" />
              {attachmentCount}
            </span>
          )}
          {checklistProgress && (
            <span
              className={`flex items-center gap-0.5 ${
                checklistProgress.checked === checklistProgress.total
                  ? 'text-emerald-600'
                  : ''
              }`}
            >
              <CheckSquare className="h-3 w-3" />
              {checklistProgress.checked}/{checklistProgress.total}
            </span>
          )}
        </div>

        {/* Time row */}
        <div className="mt-2 flex items-center justify-between text-[10px] font-semibold text-slate-400">
          <span title="Last updated">{lastUpdateDate}</span>
          <span className="flex items-center gap-1" title={`${lastUpdateLabel} since last update`}>
            <span className={`inline-block h-2 w-2 rounded-full ${lastUpdateColor}`} />
            <span>{lastUpdateLabel}</span>
          </span>
        </div>
      </div>

      {/* Detail modal */}
      {showDetail && (
        <CommercialCardDetail
          quoteId={quote.id}
          onClose={() => setShowDetail(false)}
          onRefresh={onRefresh}
          currentUserId={currentUserId}
          isManager={isManager}
        />
      )}
    </>
  );
}

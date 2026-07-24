'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CheckSquare, MessageSquare, Paperclip } from 'lucide-react';
import { useState } from 'react';

import CommercialCardDetail from './CommercialCardDetail';
import type { CommercialQuote } from './types';
import { LOCKED_COLUMNS, STATUS_STYLES } from './types';

interface CommercialCardPreviewProps {
  quote: CommercialQuote;
  onRefresh?: () => Promise<void>;
  isManager?: boolean;
  currentUserId?: string;
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
}: CommercialCardPreviewProps) {
  const [showDetail, setShowDetail] = useState(false);

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

  const statusStyle = STATUS_STYLES[quote.card_status];
  const commentCount = getCommentCount(quote);
  const attachmentCount = getAttachmentCount(quote);
  const checklistProgress = getChecklistProgress(quote);
  const agentName = quote.profiles?.display_name ?? 'Unassigned';
  const agentInitials = quote.profiles?.initials ?? '?';
  const timeInList = getRelativeTime(quote.column_entered_at);
  const timeOnBoard = getRelativeTime(quote.board_entered_at);

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
          <span className={`rounded-md px-2 py-0.5 text-[10px] font-black text-white ${labelColor}`}>
            {agentName.split(' ')[0]}
          </span>
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

        {/* Business name */}
        <p className="text-sm font-black leading-snug text-slate-900">{quote.business_name}</p>

        {/* Badges row */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${statusStyle.bg} ${statusStyle.text}`}>
            {statusStyle.label}
          </span>
        </div>

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
        <div className="mt-2 flex items-center gap-3 text-[10px] font-semibold text-slate-400">
          <span title="Time in list">{timeInList}</span>
          <span title="Time on board">{timeOnBoard}</span>
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

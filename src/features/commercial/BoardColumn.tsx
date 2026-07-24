'use client';

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';

import CommercialCardPreview from './CommercialCardPreview';
import type { BoardColumn, CommercialQuote } from './types';

interface BoardColumnProps {
  column: { id: BoardColumn; label: string; color: string };
  quotes: CommercialQuote[];
  onAddCard: () => void;
  onRefresh: () => Promise<void>;
  isManager: boolean;
  currentUserId?: string;
  canAddCard?: boolean;
}

export default function BoardColumnComponent({
  column,
  quotes,
  onAddCard,
  onRefresh,
  isManager,
  currentUserId,
  canAddCard = true,
}: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div
      ref={setNodeRef}
      className={`flex w-full flex-col rounded-2xl border transition-colors ${
        isOver
          ? 'border-[#223f7a]/30 bg-[#f5f8fd]'
          : 'border-slate-100 bg-white'
      }`}
    >
      {/* Column Header */}
      <div className="flex items-center justify-between px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className={`h-3 w-3 rounded-full ${column.color}`} />
          <h3 className="text-xs font-black uppercase tracking-[0.1em] text-slate-700">
            {column.label}
          </h3>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-black text-slate-500">
            {quotes.length}
          </span>
          {canAddCard && (
          <button
            type="button"
            onClick={onAddCard}
            className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-50 hover:text-[#223f7a]"
            aria-label={`Add card to ${column.label}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          )}
        </div>
      </div>

      {/* Cards */}
      <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-3" style={{ maxHeight: '70vh' }}>
        <SortableContext items={quotes.map((q) => q.id)} strategy={verticalListSortingStrategy}>
          {quotes.map((quote) => (
            <CommercialCardPreview
              key={quote.id}
              quote={quote}
              onRefresh={onRefresh}
              isManager={isManager}
              currentUserId={currentUserId}
            />
          ))}
        </SortableContext>

        {quotes.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-200 px-3 py-6 text-center text-[11px] font-semibold text-slate-400">
            No cards
          </div>
        )}
      </div>

      {/* Add Card Button (bottom) */}
      {canAddCard && (
      <button
        type="button"
        onClick={onAddCard}
        className="flex w-full items-center gap-2 rounded-b-2xl border-t border-slate-100 px-4 py-3 text-xs font-bold text-slate-500 transition hover:bg-slate-50 hover:text-[#223f7a]"
      >
        <Plus className="h-3.5 w-3.5" />
        Add a card
      </button>
      )}
    </div>
  );
}

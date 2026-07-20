'use client';

import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { AlertCircle, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import BoardColumnComponent from './BoardColumn';
import CommercialCardPreview from './CommercialCardPreview';
import NewCardForm from './NewCardForm';
import type { BoardColumn, CommercialQuote } from './types';
import { AGENT_ALLOWED_COLUMNS, BOARD_COLUMNS, LOCKED_COLUMNS, MANAGER_ONLY_COLUMNS } from './types';

interface CommercialBoardProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
}

export default function CommercialBoard({ initialProfile, embedded = false }: CommercialBoardProps) {
  const [quotes, setQuotes] = useState<CommercialQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [activeCard, setActiveCard] = useState<CommercialQuote | null>(null);
  const [showNewCardForm, setShowNewCardForm] = useState<BoardColumn | null>(null);
  const [showArchive, setShowArchive] = useState(false);

  const isManager = initialProfile.role === 'manager';

  // ─── Drag-and-drop sensors ───────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ─── Data fetching ───────────────────────────────────────────────────────────
  const fetchQuotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (showArchive) params.set('board_column', 'archive');

      const res = await fetch(`/api/commercial-quotes?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load commercial quotes.');
      }
      const body = await res.json();
      setQuotes(body.quotes as CommercialQuote[]);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load quotes.');
    } finally {
      setLoading(false);
    }
  }, [showArchive]);

  useEffect(() => {
    void fetchQuotes();
  }, [fetchQuotes]);

  // ─── Drag handlers ──────────────────────────────────────────────────────────

  /** Check if a move is allowed based on role */
  const isMoveAllowed = (fromColumn: BoardColumn, toColumn: BoardColumn): boolean => {
    if (isManager) return true; // Managers can move anywhere

    // Agents cannot move cards FROM locked columns
    if (LOCKED_COLUMNS.includes(fromColumn)) return false;

    // Agents cannot move cards TO manager-only columns
    if (MANAGER_ONLY_COLUMNS.includes(toColumn)) return false;

    // Agents can only move within allowed columns
    return AGENT_ALLOWED_COLUMNS.includes(toColumn);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const card = quotes.find((q) => q.id === event.active.id);
    if (!card) return;

    // Don't allow dragging locked cards (for agents)
    if (!isManager && LOCKED_COLUMNS.includes(card.board_column)) return;

    setActiveCard(card);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeQuote = quotes.find((q) => q.id === active.id);
    if (!activeQuote) return;

    // Determine target column from overId
    const overQuote = quotes.find((q) => q.id === over.id);
    const targetColumn = overQuote ? overQuote.board_column : (over.id as BoardColumn);

    if (activeQuote.board_column !== targetColumn && BOARD_COLUMNS.some((c) => c.id === targetColumn)) {
      // Check if move is allowed
      if (!isMoveAllowed(activeQuote.board_column, targetColumn)) return;

      // Optimistically move the card to the new column in local state
      setQuotes((prev) =>
        prev.map((q) =>
          q.id === active.id ? { ...q, board_column: targetColumn } : q,
        ),
      );
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveCard(null);

    if (!over) return;

    const activeQuote = quotes.find((q) => q.id === active.id);
    if (!activeQuote) return;

    // Determine final target column
    const overQuote = quotes.find((q) => q.id === over.id);
    const targetColumn = overQuote ? overQuote.board_column : (over.id as BoardColumn);

    if (!BOARD_COLUMNS.some((c) => c.id === targetColumn)) return;

    // Validate move is allowed
    if (!isMoveAllowed(activeQuote.board_column, targetColumn)) {
      await fetchQuotes(); // revert
      return;
    }

    // API call to persist the move
    try {
      const res = await fetch(`/api/commercial-quotes/${active.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board_column: targetColumn }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to move card.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Move failed.');
      // Revert on failure
      await fetchQuotes();
    }
  };

  // ─── Card creation ──────────────────────────────────────────────────────────

  const handleCreateCard = async (data: {
    business_name: string;
    description?: string;
    risk_level?: string;
    coverage_type?: string;
    board_column: BoardColumn;
  }) => {
    try {
      const res = await fetch('/api/commercial-quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to create card.');
      }
      setShowNewCardForm(null);
      await fetchQuotes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed.');
    }
  };

  // ─── Helpers ────────────────────────────────────────────────────────────────

  const getColumnQuotes = (columnId: BoardColumn) =>
    quotes
      .filter((q) => q.board_column === columnId)
      .sort((a, b) => a.column_position - b.column_position);

  const visibleColumns = showArchive
    ? BOARD_COLUMNS.filter((c) => c.id === 'archive')
    : BOARD_COLUMNS.filter((c) => c.id !== 'archive');

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <section className={embedded ? 'text-slate-950' : ''}>
      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-[#526b9a]">
            {isManager ? 'Management Overview' : 'Commercial Department'}
          </p>
          <h2 className={ui.pageTitle}>Better Trello</h2>
          <p className={ui.pageSubtitle}>
            {isManager
              ? 'All commercial policy quotes across the team'
              : 'Your commercial policy quotes pipeline'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {lastUpdated && (
            <p className="text-xs font-bold text-slate-400">
              Last updated{' '}
              {lastUpdated.toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </p>
          )}
          <button
            type="button"
            onClick={() => setShowArchive(!showArchive)}
            className={showArchive ? ui.btnPrimary : ui.btnSecondary}
          >
            {showArchive ? 'Show Board' : 'Archive'}
          </button>
          <button type="button" onClick={() => void fetchQuotes()} className={ui.btnSecondary}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className={ui.error + ' mb-4'}>
          <AlertCircle className="mr-2 inline h-4 w-4" />
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-3 text-xs font-bold underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && quotes.length === 0 && (
        <div className="flex items-center justify-center py-16">
          <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
          <span className="ml-2 text-sm font-semibold text-slate-500">Loading board...</span>
        </div>
      )}

      {/* Kanban Board */}
      {!loading || quotes.length > 0 ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="pb-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-4">
              {visibleColumns.map((column) => (
                <BoardColumnComponent
                  key={column.id}
                  column={column}
                  quotes={getColumnQuotes(column.id)}
                  onAddCard={() => setShowNewCardForm(column.id)}
                  onRefresh={fetchQuotes}
                  isManager={isManager}
                />
              ))}
            </div>
          </div>

          {/* Drag overlay - shows a preview of the card being dragged */}
          <DragOverlay>
            {activeCard ? <CommercialCardPreview quote={activeCard} /> : null}
          </DragOverlay>
        </DndContext>
      ) : null}

      {/* New Card Form Modal */}
      {showNewCardForm && (
        <NewCardForm
          column={showNewCardForm}
          onSubmit={handleCreateCard}
          onCancel={() => setShowNewCardForm(null)}
        />
      )}
    </section>
  );
}

'use client';

import {
  CheckSquare,
  Clock,
  Download,
  Eye,
  FileText,
  MessageSquare,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import type {
  BoardColumn,
  CardStatus,
  Checklist,
  CoverageType,
  CommercialAttachment,
  CommercialComment,
  CommercialQuote,
  ColumnHistory,
} from './types';
import {
  BOARD_COLUMNS,
  COVERAGE_LABELS,
  STATUS_STYLES,
} from './types';

interface CommercialCardDetailProps {
  quoteId: string;
  onClose: () => void;
  onRefresh?: () => Promise<void>;
  /** Current user's profile ID */
  currentUserId?: string;
  /** Whether current user is manager/super_admin */
  isManager?: boolean;
}

export default function CommercialCardDetail({
  quoteId,
  onClose,
  onRefresh,
  currentUserId,
  isManager = false,
}: CommercialCardDetailProps) {
  const [quote, setQuote] = useState<CommercialQuote | null>(null);
  const [comments, setComments] = useState<CommercialComment[]>([]);
  const [attachments, setAttachments] = useState<CommercialAttachment[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [history, setHistory] = useState<ColumnHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [newComment, setNewComment] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [newChecklistTitle, setNewChecklistTitle] = useState('');
  const [showChecklistForm, setShowChecklistForm] = useState(false);
  const [newItemInputs, setNewItemInputs] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);

  // Description editing
  const [editingDescription, setEditingDescription] = useState(false);
  const [draftDescription, setDraftDescription] = useState('');
  const [savingDescription, setSavingDescription] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Can the current user edit card fields (not comments/attachments)?
  // Only the card creator (assigned_to) and managers/super_admin can edit fields.
  const canEditFields = isManager || (currentUserId != null && quote?.assigned_to === currentUserId);

  // ─── Fetch full card detail ──────────────────────────────────────────────────
  const fetchDetail = useCallback(async () => {
    try {
      const res = await fetch(`/api/commercial-quotes/${quoteId}`);
      if (!res.ok) throw new Error('Failed to load card details.');
      const body = await res.json();
      const data = body.quote;

      setQuote(data);
      setComments(data.commercial_quote_comments ?? []);
      setAttachments(data.commercial_quote_attachments ?? []);
      setChecklists(data.commercial_quote_checklists ?? []);
      setHistory(data.commercial_quote_column_history ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed.');
    } finally {
      setLoading(false);
    }
  }, [quoteId]);

  useEffect(() => {
    void fetchDetail();
  }, [fetchDetail]);

  // ─── Card field updates ─────────────────────────────────────────────────────
  const updateField = async (field: string, value: unknown) => {
    try {
      const res = await fetch(`/api/commercial-quotes/${quoteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) throw new Error('Update failed.');
      await fetchDetail();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed.');
    }
  };

  // ─── Comments ───────────────────────────────────────────────────────────────
  const submitComment = async () => {
    if (!newComment.trim()) return;
    setSubmittingComment(true);
    try {
      const res = await fetch(`/api/commercial-quotes/${quoteId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newComment.trim() }),
      });
      if (!res.ok) throw new Error('Failed to add comment.');
      setNewComment('');
      await fetchDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Comment failed.');
    } finally {
      setSubmittingComment(false);
    }
  };

  // ─── Attachments ────────────────────────────────────────────────────────────
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/commercial-quotes/${quoteId}/attachments`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Upload failed.');
      }
      await fetchDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const deleteAttachment = async (attachmentId: string) => {
    try {
      const res = await fetch(`/api/commercial-quotes/${quoteId}/attachments`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachment_id: attachmentId }),
      });
      if (!res.ok) throw new Error('Delete failed.');
      await fetchDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    }
  };

  // ─── Checklists ─────────────────────────────────────────────────────────────
  const createChecklist = async () => {
    if (!newChecklistTitle.trim()) return;
    try {
      const res = await fetch(`/api/commercial-quotes/${quoteId}/checklists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newChecklistTitle.trim() }),
      });
      if (!res.ok) throw new Error('Failed to create checklist.');
      setNewChecklistTitle('');
      setShowChecklistForm(false);
      await fetchDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checklist creation failed.');
    }
  };

  const addChecklistItem = async (checklistId: string) => {
    const label = newItemInputs[checklistId]?.trim();
    if (!label) return;
    try {
      const res = await fetch(`/api/commercial-quotes/${quoteId}/checklists/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checklist_id: checklistId, label }),
      });
      if (!res.ok) throw new Error('Failed to add item.');
      setNewItemInputs((prev) => ({ ...prev, [checklistId]: '' }));
      await fetchDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Add item failed.');
    }
  };

  const toggleChecklistItem = async (itemId: string, currentChecked: boolean) => {
    try {
      const res = await fetch(`/api/commercial-quotes/${quoteId}/checklists/items`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: itemId, is_checked: !currentChecked }),
      });
      if (!res.ok) throw new Error('Toggle failed.');
      await fetchDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toggle failed.');
    }
  };

  const deleteChecklistItem = async (itemId: string) => {
    try {
      const res = await fetch(`/api/commercial-quotes/${quoteId}/checklists/items`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: itemId }),
      });
      if (!res.ok) throw new Error('Delete failed.');
      await fetchDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    }
  };

  // ─── Helpers ────────────────────────────────────────────────────────────────
  function formatDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  // ─── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="rounded-2xl bg-white p-8 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-[#223f7a]" />
            <span className="text-sm font-semibold text-slate-600">Loading card...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!quote) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="rounded-2xl bg-white p-8 shadow-2xl">
          <p className="text-sm font-bold text-rose-700">Card not found.</p>
          <button type="button" onClick={onClose} className={ui.btnSecondary + ' mt-4'}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const statusStyle = STATUS_STYLES[quote.card_status];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="my-8 w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-100 px-6 py-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-black text-slate-900">{quote.business_name}</h2>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              in <span className="font-bold text-[#223f7a]">{BOARD_COLUMNS.find((c) => c.id === quote.board_column)?.label}</span>
              {' · '}Assigned to {quote.profiles?.display_name ?? 'Unknown'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-400 hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className={ui.error + ' mx-6 mt-4'}>
            {error}
            <button type="button" onClick={() => setError(null)} className="ml-2 underline">
              Dismiss
            </button>
          </div>
        )}

        <div className="grid gap-6 px-6 py-5 lg:grid-cols-[minmax(0,1fr)_240px]">
          {/* Main content */}
          <div className="min-w-0 space-y-6">
            {/* Description */}
            <section>
              <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-500">
                <FileText className="h-3.5 w-3.5" /> Description
                {canEditFields && !editingDescription && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraftDescription(quote.description ?? '');
                      setEditingDescription(true);
                    }}
                    className="ml-auto grid h-6 w-6 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-[#223f7a]"
                    title="Edit description"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </h4>
              {editingDescription ? (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={draftDescription}
                    onChange={(e) => setDraftDescription(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium outline-none transition focus:border-[#7890bc] focus:ring-2 focus:ring-[#eef3fb]"
                    rows={5}
                    placeholder="Add a description..."
                    autoFocus
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={savingDescription}
                      onClick={async () => {
                        setSavingDescription(true);
                        await updateField('description', draftDescription.trim() || null);
                        setSavingDescription(false);
                        setEditingDescription(false);
                      }}
                      className={ui.btnPrimary + ' text-xs px-3 py-1.5'}
                    >
                      {savingDescription ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingDescription(false)}
                      className="text-xs font-bold text-slate-500 hover:text-slate-700"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p
                  className={`mt-2 whitespace-pre-wrap break-words text-sm font-medium ${
                    quote.description ? 'text-slate-700' : 'text-slate-400 italic'
                  } ${canEditFields ? 'cursor-pointer rounded-lg p-2 -mx-2 hover:bg-slate-50' : ''}`}
                  onClick={() => {
                    if (canEditFields) {
                      setDraftDescription(quote.description ?? '');
                      setEditingDescription(true);
                    }
                  }}
                >
                  {quote.description || 'No description yet. Click to add one.'}
                </p>
              )}
            </section>

            {/* Checklists */}
            {checklists.length > 0 && (
              <section className="space-y-4">
                {checklists.map((cl) => {
                  const totalItems = cl.commercial_quote_checklist_items.length;
                  const checkedItems = cl.commercial_quote_checklist_items.filter((i) => i.is_checked).length;
                  const pct = totalItems > 0 ? Math.round((checkedItems / totalItems) * 100) : 0;

                  return (
                    <div key={cl.id}>
                      <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-500">
                        <CheckSquare className="h-3.5 w-3.5" /> {cl.title}
                        <span className="text-[10px] font-bold text-slate-400">
                          {checkedItems}/{totalItems}
                        </span>
                      </h4>
                      {/* Progress bar */}
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                        <div
                          className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-emerald-500' : 'bg-[#223f7a]'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      {/* Items */}
                      <div className="mt-2 space-y-1">
                        {cl.commercial_quote_checklist_items
                          .sort((a, b) => a.position - b.position)
                          .map((item) => (
                            <div
                              key={item.id}
                              className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50"
                            >
                              <button
                                type="button"
                                onClick={() => void toggleChecklistItem(item.id, item.is_checked)}
                                className="shrink-0 text-slate-400 hover:text-[#223f7a]"
                              >
                                {item.is_checked ? (
                                  <CheckSquare className="h-4 w-4 text-emerald-600" />
                                ) : (
                                  <Square className="h-4 w-4" />
                                )}
                              </button>
                              <span
                                className={`flex-1 text-sm font-medium ${item.is_checked ? 'text-slate-400 line-through' : 'text-slate-700'}`}
                              >
                                {item.label}
                              </span>
                              <button
                                type="button"
                                onClick={() => void deleteChecklistItem(item.id)}
                                className="hidden shrink-0 text-slate-300 hover:text-rose-500 group-hover:block"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ))}
                      </div>
                      {/* Add item input */}
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          type="text"
                          value={newItemInputs[cl.id] ?? ''}
                          onChange={(e) =>
                            setNewItemInputs((prev) => ({ ...prev, [cl.id]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void addChecklistItem(cl.id);
                          }}
                          placeholder="Add item..."
                          className="flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium outline-none focus:border-[#7890bc]"
                        />
                        <button
                          type="button"
                          onClick={() => void addChecklistItem(cl.id)}
                          className="grid h-7 w-7 place-items-center rounded-lg bg-slate-100 text-slate-500 hover:bg-[#223f7a] hover:text-white"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            )}

            {/* Attachments */}
            <section>
              <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-500">
                <Paperclip className="h-3.5 w-3.5" /> Attachments ({attachments.length})
              </h4>
              <div className="mt-2 space-y-2">
                {attachments.map((att) => {
                  const ext = att.file_name.split('.').pop()?.toLowerCase() ?? '';
                  const isAudio = ['mp3', 'wav', 'ogg', 'm4a'].includes(ext);
                  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
                  const isPdf = ext === 'pdf';

                  return (
                    <AttachmentItem
                      key={att.id}
                      attachment={att}
                      quoteId={quoteId}
                      isAudio={isAudio}
                      isImage={isImage}
                      isPdf={isPdf}
                      onDelete={() => void deleteAttachment(att.id)}
                      formatFileSize={formatFileSize}
                      formatDate={formatDate}
                    />
                  );
                })}
                {attachments.length === 0 && (
                  <p className="text-xs font-semibold text-slate-400">No attachments yet.</p>
                )}
              </div>
              {/* Upload button */}
              <div className="mt-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={handleFileUpload}
                  className="hidden"
                  id="attachment-upload"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className={ui.btnSecondary + ' text-xs'}
                >
                  <Upload className="h-3.5 w-3.5" />
                  {uploading ? 'Uploading...' : 'Upload File'}
                </button>
              </div>
            </section>

            {/* Comments */}
            <section>
              <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-500">
                <MessageSquare className="h-3.5 w-3.5" /> Comments ({comments.length})
              </h4>
              {/* New comment input */}
              <div className="mt-3 flex gap-2">
                <textarea
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Write a comment..."
                  className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium outline-none transition focus:border-[#7890bc] focus:ring-2 focus:ring-[#eef3fb]"
                  rows={2}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      void submitComment();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => void submitComment()}
                  disabled={submittingComment || !newComment.trim()}
                  className="grid h-10 w-10 shrink-0 place-items-center self-end rounded-xl bg-[#223f7a] text-white transition hover:bg-[#17305f] disabled:opacity-40"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
              {/* Comment list */}
              <div className="mt-4 space-y-3">
                {comments.map((comment) => (
                  <div key={comment.id} className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-black text-slate-700">
                        {comment.profiles?.display_name ?? 'Unknown'}
                      </span>
                      <span className="text-[10px] font-semibold text-slate-400">
                        {formatDate(comment.created_at)}
                      </span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-sm font-medium text-slate-600">
                      {comment.content}
                    </p>
                  </div>
                ))}
                {comments.length === 0 && (
                  <p className="text-xs font-semibold text-slate-400">No comments yet.</p>
                )}
              </div>
            </section>
          </div>

          {/* Sidebar - Custom Fields */}
          <aside className="space-y-4">
            {/* Policy Number */}
            <div>
              <label className={ui.label}>Policy Number</label>
              <input
                type="text"
                defaultValue={quote.policy_number ?? ''}
                onBlur={(e) => void updateField('policy_number', e.target.value || null)}
                placeholder="Enter policy #"
                className={ui.input + ' mt-1 text-xs'}
                disabled={!canEditFields}
              />
            </div>

            {/* Coverage Type */}
            <div>
              <label className={ui.label}>Coverage Type</label>
              <select
                value={quote.coverage_type ?? ''}
                onChange={(e) => void updateField('coverage_type', e.target.value || null)}
                className={ui.select + ' mt-1 text-xs'}
                disabled={!canEditFields}
              >
                <option value="">Select...</option>
                {Object.entries(COVERAGE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            {/* Sold Premium */}
            <div>
              <label className={ui.label}>Sold Premium ($)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                defaultValue={quote.sold_premium ?? ''}
                onBlur={(e) => {
                  const val = e.target.value ? parseFloat(e.target.value) : null;
                  if (val !== quote.sold_premium) void updateField('sold_premium', val);
                }}
                placeholder="e.g. 1200.00"
                className={ui.input + ' mt-1 text-xs'}
                disabled={!canEditFields}
              />
              <p className="mt-1 text-[10px] font-semibold text-slate-400">
                Total annual premium for this policy.
              </p>
            </div>

            {/* Time tracking */}
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Time In List</p>
              <p className="mt-0.5 text-sm font-bold text-slate-700">
                <Clock className="mr-1 inline h-3 w-3" />
                {getRelativeTime(quote.column_entered_at)}
              </p>
              <p className="mt-2 text-[10px] font-black uppercase tracking-wider text-slate-400">Time On Board</p>
              <p className="mt-0.5 text-sm font-bold text-slate-700">
                <Clock className="mr-1 inline h-3 w-3" />
                {getRelativeTime(quote.board_entered_at)}
              </p>
            </div>

            {/* Add Checklist */}
            <div>
              {showChecklistForm ? (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={newChecklistTitle}
                    onChange={(e) => setNewChecklistTitle(e.target.value)}
                    placeholder="Checklist title"
                    className={ui.input + ' mt-0 text-xs'}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createChecklist();
                    }}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void createChecklist()}
                      className={ui.btnPrimary + ' text-xs py-1.5 px-3'}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowChecklistForm(false)}
                      className="text-xs font-bold text-slate-500"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowChecklistForm(true)}
                  className={ui.btnSecondary + ' w-full text-xs'}
                >
                  <CheckSquare className="h-3.5 w-3.5" />
                  Add Checklist
                </button>
              )}
            </div>

            {/* Column History */}
            {history.length > 0 && (
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Card History</p>
                <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
                  {history
                    .sort((a, b) => new Date(b.moved_at).getTime() - new Date(a.moved_at).getTime())
                    .slice(0, 10)
                    .map((entry) => (
                      <div key={entry.id} className="text-[10px] font-medium text-slate-500">
                        <span className="font-bold">{entry.profiles?.display_name ?? 'System'}</span>
                        {' moved to '}
                        <span className="font-bold">
                          {BOARD_COLUMNS.find((c) => c.id === entry.to_column)?.label ?? entry.to_column}
                        </span>
                        <br />
                        <span className="text-slate-400">{formatDate(entry.moved_at)}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

// ─── AttachmentItem with inline preview/playback ─────────────────────────────

interface AttachmentItemProps {
  attachment: CommercialAttachment;
  quoteId: string;
  isAudio: boolean;
  isImage: boolean;
  isPdf: boolean;
  onDelete: () => void;
  formatFileSize: (bytes: number) => string;
  formatDate: (iso: string) => string;
}

function AttachmentItem({ attachment: att, quoteId, isAudio, isImage, isPdf, onDelete, formatFileSize, formatDate }: AttachmentItemProps) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const fetchSignedUrl = async () => {
    if (signedUrl) return signedUrl;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/commercial-quotes/${quoteId}/attachments/download?path=${encodeURIComponent(att.storage_path)}`
      );
      if (!res.ok) return null;
      const body = await res.json();
      setSignedUrl(body.url);
      return body.url as string;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  };

  const handleView = async () => {
    const url = await fetchSignedUrl();
    if (!url) return;

    if (isImage || isPdf) {
      setExpanded(!expanded);
    } else {
      // Download other files
      window.open(url, '_blank');
    }
  };

  const handlePlayPause = async () => {
    const url = await fetchSignedUrl();
    if (!url) return;

    if (!audioRef.current) {
      audioRef.current = new Audio(url);
      audioRef.current.onended = () => setPlaying(false);
    }

    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      await audioRef.current.play();
      setPlaying(true);
    }
  };

  const handleDownload = async () => {
    const url = await fetchSignedUrl();
    if (url) window.open(url, '_blank');
  };

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 overflow-hidden">
      <div className="flex items-center justify-between px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-slate-700">{att.file_name}</p>
          <p className="text-[10px] font-semibold text-slate-400">
            {formatFileSize(att.file_size)} · {formatDate(att.created_at)}
            {att.profiles && ` · ${att.profiles.display_name}`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {/* Play button for audio */}
          {isAudio && (
            <button
              type="button"
              onClick={() => void handlePlayPause()}
              disabled={loading}
              className="grid h-7 w-7 place-items-center rounded-lg text-[#223f7a] hover:bg-[#eef3fb]"
              title={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
          )}
          {/* View button for images/PDFs */}
          {(isImage || isPdf) && (
            <button
              type="button"
              onClick={() => void handleView()}
              disabled={loading}
              className="grid h-7 w-7 place-items-center rounded-lg text-[#223f7a] hover:bg-[#eef3fb]"
              title="Preview"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          )}
          {/* Download button */}
          <button
            type="button"
            onClick={() => void handleDownload()}
            disabled={loading}
            className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-slate-200"
            title="Download"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          {/* Delete button */}
          <button
            type="button"
            onClick={onDelete}
            className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:text-rose-500"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Inline audio player */}
      {isAudio && signedUrl && (
        <div className="border-t border-slate-100 px-3.5 py-2">
          <audio
            src={signedUrl}
            controls
            className="w-full h-8"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
        </div>
      )}

      {/* Inline image preview */}
      {isImage && expanded && signedUrl && (
        <div className="border-t border-slate-100 p-3">
          <img
            src={signedUrl}
            alt={att.file_name}
            className="max-h-64 w-full rounded-lg object-contain bg-white"
          />
        </div>
      )}

      {/* Inline PDF (iframe) */}
      {isPdf && expanded && signedUrl && (
        <div className="border-t border-slate-100 p-2">
          <iframe
            src={signedUrl}
            title={att.file_name}
            className="h-72 w-full rounded-lg border border-slate-200"
          />
        </div>
      )}
    </div>
  );
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

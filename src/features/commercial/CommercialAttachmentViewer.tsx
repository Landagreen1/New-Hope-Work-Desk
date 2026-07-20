'use client';

import {
  Download,
  Eye,
  File,
  FileImage,
  FileText,
  Paperclip,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import type { CommercialAttachment } from './types';

interface CommercialAttachmentViewerProps {
  quoteId: string;
  onClose: () => void;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return FileImage;
  if (mimeType === 'application/pdf') return FileText;
  return File;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

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

function isPreviewable(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType === 'application/pdf';
}

export default function CommercialAttachmentViewer({ quoteId, onClose }: CommercialAttachmentViewerProps) {
  const [attachments, setAttachments] = useState<CommercialAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<string>('');
  const [previewName, setPreviewName] = useState<string>('');

  const fetchAttachments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/commercial-quotes/${quoteId}/attachments`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load attachments.');
      }
      const body = await res.json();
      setAttachments(body.attachments as CommercialAttachment[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed.');
    } finally {
      setLoading(false);
    }
  }, [quoteId]);

  useEffect(() => {
    void fetchAttachments();
  }, [fetchAttachments]);

  const handlePreview = async (attachment: CommercialAttachment) => {
    // Generate a signed URL for preview
    try {
      const res = await fetch(
        `/api/commercial-quotes/${quoteId}/attachments/download?path=${encodeURIComponent(attachment.storage_path)}`,
      );
      if (!res.ok) {
        // Fallback: just try to get a signed URL from Supabase directly through our endpoint
        throw new Error('Preview not available.');
      }
      const body = await res.json();
      setPreviewUrl(body.url);
      setPreviewType(attachment.mime_type);
      setPreviewName(attachment.file_name);
    } catch {
      // If no download route exists, we'll construct the URL from the storage path
      // This is a placeholder - the actual signed URL needs to come from the server
      setError('Preview requires a download endpoint. Please download the file instead.');
    }
  };

  const handleDownload = async (attachment: CommercialAttachment) => {
    try {
      const res = await fetch(
        `/api/commercial-quotes/${quoteId}/attachments/download?path=${encodeURIComponent(attachment.storage_path)}`,
      );
      if (!res.ok) throw new Error('Download URL generation failed.');
      const body = await res.json();
      // Open signed URL in new tab for download
      window.open(body.url, '_blank');
    } catch {
      setError('Download failed. The file may not be accessible.');
    }
  };

  const handleDelete = async (attachmentId: string) => {
    try {
      const res = await fetch(`/api/commercial-quotes/${quoteId}/attachments`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachment_id: attachmentId }),
      });
      if (!res.ok) throw new Error('Delete failed.');
      await fetchAttachments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div className="flex items-center gap-2">
            <Paperclip className="h-5 w-5 text-[#223f7a]" />
            <h3 className="text-lg font-black text-slate-900">
              Attachments ({attachments.length})
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-xl text-slate-400 hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className={ui.error + ' mx-6 mt-4'}>
            {error}
            <button type="button" onClick={() => setError(null)} className="ml-2 text-xs underline">
              Dismiss
            </button>
          </div>
        )}

        {/* Content */}
        <div className="max-h-[70vh] overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
              <span className="ml-2 text-sm font-semibold text-slate-500">Loading attachments...</span>
            </div>
          ) : attachments.length === 0 ? (
            <div className="py-12 text-center text-sm font-semibold text-slate-400">
              No attachments on this card.
            </div>
          ) : (
            <div className="space-y-3">
              {attachments.map((att) => {
                const FileIcon = getFileIcon(att.mime_type);
                const canPreview = isPreviewable(att.mime_type);

                return (
                  <div
                    key={att.id}
                    className="flex items-center gap-4 rounded-xl border border-slate-100 bg-slate-50 p-4 transition hover:border-slate-200 hover:bg-white"
                  >
                    {/* File icon */}
                    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white border border-slate-200">
                      <FileIcon className="h-5 w-5 text-slate-500" />
                    </div>

                    {/* File info */}
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-black text-slate-800">{att.file_name}</p>
                      <div className="mt-0.5 flex items-center gap-3 text-[10px] font-semibold text-slate-400">
                        <span>{formatFileSize(att.file_size)}</span>
                        <span>{att.mime_type.split('/')[1]?.toUpperCase() ?? att.mime_type}</span>
                        <span>{formatDate(att.created_at)}</span>
                        {att.profiles && <span>by {att.profiles.display_name}</span>}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5">
                      {canPreview && (
                        <button
                          type="button"
                          onClick={() => void handlePreview(att)}
                          className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-blue-50 hover:text-[#223f7a]"
                          title="Preview"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDownload(att)}
                        className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-emerald-50 hover:text-emerald-700"
                        title="Download"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(att.id)}
                        className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Preview panel */}
        {previewUrl && (
          <div className="border-t border-slate-200 p-6">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-black text-slate-700">Preview: {previewName}</p>
              <button
                type="button"
                onClick={() => { setPreviewUrl(null); setPreviewType(''); setPreviewName(''); }}
                className="text-xs font-bold text-slate-500 hover:text-rose-600"
              >
                Close Preview
              </button>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              {previewType.startsWith('image/') ? (
                <img
                  src={previewUrl}
                  alt={previewName}
                  className="max-h-[400px] w-full object-contain"
                />
              ) : previewType === 'application/pdf' ? (
                <iframe
                  src={previewUrl}
                  title={previewName}
                  className="h-[500px] w-full"
                />
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

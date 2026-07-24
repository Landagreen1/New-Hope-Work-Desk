'use client';

import { X } from 'lucide-react';
import { useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import type { BoardColumn, CoverageType } from './types';
import { BOARD_COLUMNS, COVERAGE_LABELS } from './types';

interface NewCardFormProps {
  column: BoardColumn;
  onSubmit: (data: {
    business_name: string;
    description?: string;
    coverage_type?: string;
    card_status?: string;
    board_column: BoardColumn;
  }) => Promise<void>;
  onCancel: () => void;
}

export default function NewCardForm({ column, onSubmit, onCancel }: NewCardFormProps) {
  const [businessName, setBusinessName] = useState('');
  const [description, setDescription] = useState('');
  const [coverageType, setCoverageType] = useState<CoverageType | ''>('');
  const [cardStatus, setCardStatus] = useState('in_progress');
  const [submitting, setSubmitting] = useState(false);

  const columnLabel = BOARD_COLUMNS.find((c) => c.id === column)?.label ?? column;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit({
        business_name: businessName.trim(),
        description: description.trim() || undefined,
        coverage_type: coverageType || undefined,
        card_status: cardStatus,
        board_column: column,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-[28px] border border-slate-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <h3 className="text-xl font-black text-slate-900">
              New Commercial Quote
            </h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              Creating in <span className="font-black text-[#223f7a]">{columnLabel}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="grid h-9 w-9 place-items-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-5 px-6 py-6">
          {/* Business Name */}
          <div>
            <label className={ui.label}>Business Name *</label>
            <input
              type="text"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="e.g. Letstart Construction LLC"
              className={ui.input + ' mt-1'}
              required
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <label className={ui.label}>Description / Notes</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Coverage details, special notes, contact info..."
              className={ui.textarea + ' mt-1'}
              rows={4}
            />
          </div>

          {/* Two-column row */}
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Coverage Type */}
            <div>
              <label className={ui.label}>Coverage Type</label>
              <select
                value={coverageType}
                onChange={(e) => setCoverageType(e.target.value as CoverageType | '')}
                className={ui.select + ' mt-1'}
              >
                <option value="">Select...</option>
                {Object.entries(COVERAGE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            {/* Status */}
            <div>
              <label className={ui.label}>Initial Status</label>
              <select
                value={cardStatus}
                onChange={(e) => setCardStatus(e.target.value)}
                className={ui.select + ' mt-1'}
              >
                <option value="in_progress">In Progress</option>
                <option value="price_sent">Price Sent</option>
                <option value="waiting">Waiting</option>
                <option value="blocked">Blocked</option>
                <option value="done">Done</option>
              </select>
            </div>
          </div>

          {/* Info box */}
          <div className="rounded-xl bg-[#f3f6fb] px-4 py-3 text-xs font-semibold text-[#223f7a]">
            A checklist with Email, Recording, and Form items will be added automatically.
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={submitting || !businessName.trim()}
              className="flex-1 rounded-xl bg-[#223f7a] px-5 py-3 text-sm font-black text-white transition hover:bg-[#17305f] disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Quote'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-black text-slate-600 transition hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

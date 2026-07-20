'use client';

import { X } from 'lucide-react';
import { useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import type { BoardColumn, CoverageType, RiskLevel } from './types';
import { BOARD_COLUMNS, COVERAGE_LABELS } from './types';

interface NewCardFormProps {
  column: BoardColumn;
  onSubmit: (data: {
    business_name: string;
    description?: string;
    risk_level?: string;
    coverage_type?: string;
    board_column: BoardColumn;
  }) => Promise<void>;
  onCancel: () => void;
}

export default function NewCardForm({ column, onSubmit, onCancel }: NewCardFormProps) {
  const [businessName, setBusinessName] = useState('');
  const [description, setDescription] = useState('');
  const [riskLevel, setRiskLevel] = useState<RiskLevel>('medium');
  const [coverageType, setCoverageType] = useState<CoverageType | ''>('');
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
        risk_level: riskLevel,
        coverage_type: coverageType || undefined,
        board_column: column,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-lg font-black text-slate-900">
            New Card — {columnLabel}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Business Name */}
          <div>
            <label className={ui.label}>Business Name *</label>
            <input
              type="text"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="e.g. Letstart Construction LLC"
              className={ui.input}
              required
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <label className={ui.label}>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Coverage details, notes..."
              className={ui.textarea}
              rows={3}
            />
          </div>

          {/* Risk Level */}
          <div>
            <label className={ui.label}>Risk Level</label>
            <select
              value={riskLevel}
              onChange={(e) => setRiskLevel(e.target.value as RiskLevel)}
              className={ui.select}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>

          {/* Coverage Type */}
          <div>
            <label className={ui.label}>Coverage Type</label>
            <select
              value={coverageType}
              onChange={(e) => setCoverageType(e.target.value as CoverageType | '')}
              className={ui.select}
            >
              <option value="">Select...</option>
              {Object.entries(COVERAGE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <button type="submit" disabled={submitting || !businessName.trim()} className={ui.btnPrimary}>
              {submitting ? 'Creating...' : 'Create Card'}
            </button>
            <button type="button" onClick={onCancel} className={ui.btnSecondary}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

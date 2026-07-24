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
  // --- Company Info ---
  const [businessName, setBusinessName] = useState('');
  const [address, setAddress] = useState('');
  const [einW7, setEinW7] = useState('');
  const [states, setStates] = useState('');
  const [employeeCount, setEmployeeCount] = useState('');

  // --- Owner Info ---
  const [ownerName, setOwnerName] = useState('');
  const [ownerDob, setOwnerDob] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');

  // --- Job Details ---
  const [jobType, setJobType] = useState('');
  const [roofingCode, setRoofingCode] = useState('');
  const [height, setHeight] = useState('');
  const [roofType, setRoofType] = useState('');
  const [heatApplication, setHeatApplication] = useState('');
  const [commercialResidential, setCommercialResidential] = useState('');

  // --- Card Settings ---
  const [coverageType, setCoverageType] = useState<CoverageType | ''>('');
  const [cardStatus, setCardStatus] = useState('in_progress');
  const [additionalNotes, setAdditionalNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const columnLabel = BOARD_COLUMNS.find((c) => c.id === column)?.label ?? column;

  function buildDescription(): string {
    const lines: string[] = [];

    lines.push('Company Information:');
    lines.push(`Name: ${businessName}`);
    if (address) lines.push(`Address: ${address}`);
    if (einW7) lines.push(`EIN / W7: ${einW7}`);
    if (states) lines.push(`States of operation: ${states}`);
    if (employeeCount) lines.push(`Employees & Payroll (WC): ${employeeCount}`);

    if (ownerName || ownerDob || ownerPhone || ownerEmail) {
      lines.push('');
      lines.push('Owner Information:');
      if (ownerName) lines.push(`Name: ${ownerName}`);
      if (ownerDob) lines.push(`Date of birth: ${ownerDob}`);
      if (ownerPhone) lines.push(`Phone: ${ownerPhone}`);
      if (ownerEmail) lines.push(`Email: ${ownerEmail}`);
    }

    if (jobType || roofingCode || height || roofType || heatApplication || commercialResidential) {
      lines.push('');
      lines.push('Job Details:');
      if (jobType) lines.push(`Type of work: ${jobType}`);
      if (roofingCode) lines.push(`Roofing code: ${roofingCode}`);
      if (height) lines.push(`Height: ${height}`);
      if (roofType) lines.push(`Roof type: ${roofType}`);
      if (heatApplication) lines.push(`Heat application / Torch: ${heatApplication}`);
      if (commercialResidential) lines.push(`Commercial / Residential: ${commercialResidential}`);
    }

    if (additionalNotes.trim()) {
      lines.push('');
      lines.push('Additional Notes:');
      lines.push(additionalNotes.trim());
    }

    return lines.join('\n');
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit({
        business_name: businessName.trim(),
        description: buildDescription(),
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
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-[28px] border border-slate-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <h3 className="text-xl font-black text-slate-900">
              New Commercial Quote
            </h3>
            <p className="mt-0.5 text-sm font-semibold text-slate-500">
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

        {/* Scrollable form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-6">

            {/* ── Company Info ── */}
            <section>
              <h4 className="mb-3 text-xs font-black uppercase tracking-widest text-[#526b9a]">
                Company Information
              </h4>
              <div className="space-y-3">
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
                <div>
                  <label className={ui.label}>Address</label>
                  <input
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Street, City, State, ZIP"
                    className={ui.input + ' mt-1'}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={ui.label}>EIN or W7</label>
                    <input
                      type="text"
                      value={einW7}
                      onChange={(e) => setEinW7(e.target.value)}
                      placeholder="XX-XXXXXXX"
                      className={ui.input + ' mt-1'}
                    />
                  </div>
                  <div>
                    <label className={ui.label}>States of Operation</label>
                    <input
                      type="text"
                      value={states}
                      onChange={(e) => setStates(e.target.value)}
                      placeholder="e.g. FL, TX, GA"
                      className={ui.input + ' mt-1'}
                    />
                  </div>
                </div>
                <div>
                  <label className={ui.label}>Employees & Payroll (WC)</label>
                  <input
                    type="text"
                    value={employeeCount}
                    onChange={(e) => setEmployeeCount(e.target.value)}
                    placeholder="e.g. 5 employees, $250k annual payroll"
                    className={ui.input + ' mt-1'}
                  />
                </div>
              </div>
            </section>

            {/* ── Owner Info ── */}
            <section>
              <h4 className="mb-3 text-xs font-black uppercase tracking-widest text-[#526b9a]">
                Owner Information
              </h4>
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={ui.label}>Full Name</label>
                    <input
                      type="text"
                      value={ownerName}
                      onChange={(e) => setOwnerName(e.target.value)}
                      placeholder="Owner full name"
                      className={ui.input + ' mt-1'}
                    />
                  </div>
                  <div>
                    <label className={ui.label}>Date of Birth</label>
                    <input
                      type="date"
                      value={ownerDob}
                      onChange={(e) => setOwnerDob(e.target.value)}
                      className={ui.input + ' mt-1'}
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={ui.label}>Phone Number</label>
                    <input
                      type="tel"
                      value={ownerPhone}
                      onChange={(e) => setOwnerPhone(e.target.value)}
                      placeholder="(555) 555-5555"
                      className={ui.input + ' mt-1'}
                    />
                  </div>
                  <div>
                    <label className={ui.label}>Email</label>
                    <input
                      type="email"
                      value={ownerEmail}
                      onChange={(e) => setOwnerEmail(e.target.value)}
                      placeholder="email@example.com"
                      className={ui.input + ' mt-1'}
                    />
                  </div>
                </div>
              </div>
            </section>

            {/* ── Job Details ── */}
            <section>
              <h4 className="mb-3 text-xs font-black uppercase tracking-widest text-[#526b9a]">
                Job Details
              </h4>
              <div className="space-y-3">
                <div>
                  <label className={ui.label}>Type of Work</label>
                  <input
                    type="text"
                    value={jobType}
                    onChange={(e) => setJobType(e.target.value)}
                    placeholder="e.g. Roofing, General Contractor, Painting"
                    className={ui.input + ' mt-1'}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={ui.label}>Roofing Code</label>
                    <input
                      type="text"
                      value={roofingCode}
                      onChange={(e) => setRoofingCode(e.target.value)}
                      placeholder="e.g. 5551"
                      className={ui.input + ' mt-1'}
                    />
                  </div>
                  <div>
                    <label className={ui.label}>Height</label>
                    <input
                      type="text"
                      value={height}
                      onChange={(e) => setHeight(e.target.value)}
                      placeholder="e.g. 2 stories, 35 ft"
                      className={ui.input + ' mt-1'}
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <label className={ui.label}>Roof Type</label>
                    <input
                      type="text"
                      value={roofType}
                      onChange={(e) => setRoofType(e.target.value)}
                      placeholder="e.g. Shingle, Tile"
                      className={ui.input + ' mt-1'}
                    />
                  </div>
                  <div>
                    <label className={ui.label}>Heat / Torch</label>
                    <select
                      value={heatApplication}
                      onChange={(e) => setHeatApplication(e.target.value)}
                      className={ui.select + ' mt-1'}
                    >
                      <option value="">Select...</option>
                      <option value="Yes">Yes</option>
                      <option value="No">No</option>
                    </select>
                  </div>
                  <div>
                    <label className={ui.label}>Commercial / Residential</label>
                    <select
                      value={commercialResidential}
                      onChange={(e) => setCommercialResidential(e.target.value)}
                      className={ui.select + ' mt-1'}
                    >
                      <option value="">Select...</option>
                      <option value="Commercial">Commercial</option>
                      <option value="Residential">Residential</option>
                      <option value="Both">Both</option>
                    </select>
                  </div>
                </div>
              </div>
            </section>

            {/* ── Card Settings ── */}
            <section>
              <h4 className="mb-3 text-xs font-black uppercase tracking-widest text-[#526b9a]">
                Card Settings
              </h4>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={ui.label}>Coverage Type</label>
                  <select
                    value={coverageType}
                    onChange={(e) => setCoverageType(e.target.value as CoverageType | '')}
                    className={ui.select + ' mt-1'}
                  >
                    <option value="">Select...</option>
                    {Object.entries(COVERAGE_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
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
              <div className="mt-3">
                <label className={ui.label}>Additional Notes</label>
                <textarea
                  value={additionalNotes}
                  onChange={(e) => setAdditionalNotes(e.target.value)}
                  placeholder="Any extra information..."
                  className={ui.textarea + ' mt-1'}
                  rows={3}
                />
              </div>
            </section>

          </div>
        </form>

        {/* Footer actions */}
        <div className="flex shrink-0 items-center gap-3 border-t border-slate-100 px-6 py-4">
          <button
            type="submit"
            form=""
            disabled={submitting || !businessName.trim()}
            onClick={handleSubmit as unknown as () => void}
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
          <p className="hidden text-[10px] font-semibold text-slate-400 sm:block">
            Checklist auto-added
          </p>
        </div>
      </div>
    </div>
  );
}

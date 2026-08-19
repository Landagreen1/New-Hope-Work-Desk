'use client';

/**
 * Shared field primitives for the trucking intake sections.
 *
 * The rest of cs-intake duplicates a local `Field` helper per file. The trucking
 * sections added in v1.19.2 share these instead, so the Requested Coverages,
 * Underwriting and Trailer cards cannot drift apart visually. The markup is
 * character-for-character the same as the existing local copies.
 */

import { AlertTriangle, Info } from 'lucide-react';
import { ui } from '../nhwd-shared/ui';

export function Field({
  label,
  required,
  children,
  hint,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className={ui.label}>{label}{required ? ' *' : ''}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs font-semibold text-slate-400">{hint}</span>}
    </label>
  );
}

/** Tri-state Yes / No. Unanswered is `null`, never `false`. */
export function YesNo({
  value,
  onChange,
  disabled,
}: {
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  disabled?: boolean;
}) {
  return (
    <select
      className={ui.select}
      value={value === null || value === undefined ? '' : value ? 'yes' : 'no'}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value === 'yes')}
      disabled={disabled}
    >
      <option value="">— Select —</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
  );
}

/**
 * Yes / No / Not Sure, stored as a string.
 *
 * Customer Service genuinely does not always know on the first call, and
 * recording "not sure" is more useful to underwriting than a guessed No.
 */
export function YesNoNotSure({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      className={ui.select}
      value={value || ''}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    >
      <option value="">— Select —</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
      <option value="not_sure">Not Sure</option>
    </select>
  );
}

/** A whole-dollar input. Plain number, matching the existing cs-intake convention. */
export function MoneyInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      min={0}
      className={ui.input}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}

export function AgentGuidance({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-blue-100 bg-blue-50/60 px-4 py-3">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
      <div className="text-xs font-semibold leading-5 text-blue-800">{children}</div>
    </div>
  );
}

export function WarningBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div className="text-sm font-bold text-amber-800">{children}</div>
    </div>
  );
}

/** A titled sub-block inside a coverage card, so each coverage reads as a unit. */
export function CoverageBlock({
  title,
  children,
  accent,
}: {
  title: string;
  children: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-4 ${
        accent ? 'border-[#c9d5e9] bg-[#f8faff]' : 'border-slate-200 bg-white'
      }`}
    >
      <p className="mb-3 text-xs font-black uppercase tracking-[0.12em] text-[#526b9a]">{title}</p>
      {children}
    </div>
  );
}

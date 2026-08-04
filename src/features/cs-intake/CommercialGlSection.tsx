'use client';

import { Building2, Plus, Trash2, UserRound } from 'lucide-react';
import { ui } from '../nhwd-shared/ui';
import DatePicker from '../nhwd-shared/DatePicker';
import DollarInput from '../nhwd-shared/DollarInput';
import StatesMultiSelect from '../nhwd-shared/StatesMultiSelect';
import EinInput from '../nhwd-shared/EinInput';
import type { CsIntakeOwner } from './api';

const COVERAGE_OPTIONS = [
  { value: 'gl', label: 'General Liability (GL)' },
  { value: 'wc', label: 'Workers Compensation (WC)' },
  { value: 'umbrella', label: 'Umbrella' },
  { value: 'bop', label: 'Business Owners Policy (BOP)' },
  { value: 'commercial_auto', label: 'Commercial Auto' },
  { value: 'other', label: 'Other' },
];

export interface CommercialGlData {
  business_name: string;
  business_type: string;
  ein: string;
  states_of_operation: string;
  employee_count: number | null;
  annual_payroll: number | null;
  years_in_business: number | null;
  coverage_types_needed: string[];
  // Legacy single-owner fields (kept for backward compat with insured_* mapping)
  owner_first_name: string;
  owner_middle_name: string;
  owner_last_name: string;
  owner_dob: string;
  owner_phone: string;
  owner_email: string;
}

interface CommercialGlSectionProps {
  data: CommercialGlData;
  onChange: (patch: Partial<CommercialGlData>) => void;
  owners: CsIntakeOwner[];
  onOwnersChange: (owners: CsIntakeOwner[]) => void;
  disabled?: boolean;
}

export function emptyOwner(position = 1): CsIntakeOwner {
  return {
    position,
    first_name: '',
    middle_name: null,
    last_name: '',
    dob: null,
    phone: null,
    email: null,
    ownership_percentage: null,
  };
}

function Field({ label, required, children, hint }: { label: string; required?: boolean; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className={ui.label}>{label}{required ? ' *' : ''}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs font-semibold text-slate-400">{hint}</span>}
    </label>
  );
}

export default function CommercialGlSection({ data, onChange, owners, onOwnersChange, disabled }: CommercialGlSectionProps) {
  function toggleCoverage(value: string) {
    const current = data.coverage_types_needed;
    const updated = current.includes(value)
      ? current.filter((c) => c !== value)
      : [...current, value];
    onChange({ coverage_types_needed: updated });
  }

  function patchOwner(index: number, values: Partial<CsIntakeOwner>) {
    onOwnersChange(owners.map((owner, i) => i === index ? { ...owner, ...values } : owner));
  }

  function removeOwner(index: number) {
    onOwnersChange(owners.filter((_, i) => i !== index).map((owner, i) => ({ ...owner, position: i + 1 })));
  }

  function addOwner() {
    onOwnersChange([...owners, emptyOwner(owners.length + 1)]);
  }

  return (
    <div className="space-y-5">
      {/* Business Information */}
      <section className={ui.card}>
        <div className={ui.cardHeader}>
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-950">Business Information</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                Company details for GL, WC, BOP, and umbrella policies
              </p>
            </div>
          </div>
        </div>
        <div className={ui.cardPad}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Business Name" required>
                <input
                  type="text"
                  className={ui.input}
                  value={data.business_name}
                  onChange={(e) => onChange({ business_name: e.target.value })}
                  placeholder="e.g. Rodriguez Roofing Inc"
                  disabled={disabled}
                />
              </Field>

              <Field label="Type of Work">
                <input
                  type="text"
                  className={ui.input}
                  value={data.business_type}
                  onChange={(e) => onChange({ business_type: e.target.value })}
                  placeholder="e.g. Roofing, General Contractor"
                  disabled={disabled}
                />
              </Field>

              <Field label="EIN" hint="9 digits: XX-XXXXXXX">
                <EinInput
                  value={data.ein}
                  onChange={(v) => onChange({ ein: v })}
                  disabled={disabled}
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="States of Operation">
                <StatesMultiSelect
                  value={data.states_of_operation}
                  onChange={(v) => onChange({ states_of_operation: v })}
                  disabled={disabled}
                />
              </Field>

              <Field label="Number of Employees">
                <input
                  type="number"
                  className={ui.input}
                  value={data.employee_count ?? ''}
                  onChange={(e) => onChange({ employee_count: e.target.value ? Number(e.target.value) : null })}
                  placeholder="Employee count"
                  min={0}
                  disabled={disabled}
                />
              </Field>

              <Field label="Annual Payroll">
                <DollarInput
                  value={data.annual_payroll}
                  onChange={(v) => onChange({ annual_payroll: v })}
                  placeholder="e.g. $250,000"
                  disabled={disabled}
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Years in Business">
                <input
                  type="number"
                  className={ui.input}
                  value={data.years_in_business ?? ''}
                  onChange={(e) => onChange({ years_in_business: e.target.value ? Number(e.target.value) : null })}
                  placeholder="Years"
                  min={0}
                  disabled={disabled}
                />
              </Field>
            </div>
          </div>
        </div>
      </section>

      {/* Owners Section (multiple) */}
      <section className={ui.card}>
        <div className={ui.cardHeader}>
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
              <UserRound className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-950">Owners ({owners.length})</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                Add all business owners. At least one owner is required.
              </p>
            </div>
          </div>
        </div>
        <div className={ui.cardPad}>
          <div className="space-y-4">
            {owners.map((owner, index) => (
              <div key={owner.id || `owner-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-black text-slate-900">Owner {index + 1}{index === 0 ? ' · Primary' : ''}</p>
                  {!disabled && index > 0 ? (
                    <button type="button" className={ui.btnDanger} onClick={() => removeOwner(index)}>
                      <Trash2 className="h-4 w-4" /> Remove
                    </button>
                  ) : null}
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="First Name" required>
                    <input
                      type="text"
                      className={ui.input}
                      value={owner.first_name}
                      onChange={(e) => patchOwner(index, { first_name: e.target.value })}
                      placeholder="First name"
                      disabled={disabled}
                    />
                  </Field>

                  <Field label="Middle Name">
                    <input
                      type="text"
                      className={ui.input}
                      value={owner.middle_name || ''}
                      onChange={(e) => patchOwner(index, { middle_name: e.target.value || null })}
                      placeholder="Middle name (optional)"
                      disabled={disabled}
                    />
                  </Field>

                  <Field label="Last Name" required>
                    <input
                      type="text"
                      className={ui.input}
                      value={owner.last_name}
                      onChange={(e) => patchOwner(index, { last_name: e.target.value })}
                      placeholder="Last name"
                      disabled={disabled}
                    />
                  </Field>

                  <Field label="Date of Birth">
                    <DatePicker
                      value={owner.dob || ''}
                      onChange={(val) => patchOwner(index, { dob: val || null })}
                      placeholder="Date of birth"
                      disabled={disabled}
                    />
                  </Field>

                  <Field label="Phone" required>
                    <input
                      type="tel"
                      className={ui.input}
                      value={owner.phone || ''}
                      onChange={(e) => patchOwner(index, { phone: e.target.value || null })}
                      placeholder="(555) 555-5555"
                      disabled={disabled}
                    />
                  </Field>

                  <Field label="Email">
                    <input
                      type="email"
                      className={ui.input}
                      value={owner.email || ''}
                      onChange={(e) => patchOwner(index, { email: e.target.value || null })}
                      placeholder="email@example.com"
                      disabled={disabled}
                    />
                  </Field>

                  <Field label="Ownership %" hint="Optional">
                    <input
                      type="number"
                      className={ui.input}
                      value={owner.ownership_percentage ?? ''}
                      onChange={(e) => patchOwner(index, { ownership_percentage: e.target.value ? Number(e.target.value) : null })}
                      placeholder="e.g. 50"
                      min={0}
                      max={100}
                      disabled={disabled}
                    />
                  </Field>
                </div>
              </div>
            ))}
          </div>
          {!disabled ? (
            <button type="button" className={`${ui.btnSecondary} mt-4`} onClick={addOwner}>
              <Plus className="h-4 w-4" /> Add another owner
            </button>
          ) : null}
        </div>
      </section>

      {/* Coverage Types Needed */}
      <section className={ui.card}>
        <div className={ui.cardHeader}>
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-950">Coverage Types Needed</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                Select all coverage types the customer needs
              </p>
            </div>
          </div>
        </div>
        <div className={ui.cardPad}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {COVERAGE_OPTIONS.map((opt) => (
              <label key={opt.value} className={ui.checkboxRow + ' cursor-pointer'}>
                <input
                  type="checkbox"
                  checked={data.coverage_types_needed.includes(opt.value)}
                  onChange={() => toggleCoverage(opt.value)}
                  disabled={disabled}
                  className="h-4 w-4 rounded border-slate-300 text-[#223f7a] focus:ring-[#223f7a]"
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

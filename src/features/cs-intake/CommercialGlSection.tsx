'use client';

import { Building2 } from 'lucide-react';
import { ui } from '../nhwd-shared/ui';
import DatePicker from '../nhwd-shared/DatePicker';
import DollarInput from '../nhwd-shared/DollarInput';
import StatesMultiSelect from '../nhwd-shared/StatesMultiSelect';
import EinInput from '../nhwd-shared/EinInput';

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
  // Owner info
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
  disabled?: boolean;
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

export default function CommercialGlSection({ data, onChange, disabled }: CommercialGlSectionProps) {
  function toggleCoverage(value: string) {
    const current = data.coverage_types_needed;
    const updated = current.includes(value)
      ? current.filter((c) => c !== value)
      : [...current, value];
    onChange({ coverage_types_needed: updated });
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

      {/* Owner Information */}
      <section className={ui.card}>
        <div className={ui.cardHeader}>
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-950">Owner Information</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                Business owner contact details (mandatory)
              </p>
            </div>
          </div>
        </div>
        <div className={ui.cardPad}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Owner First Name" required>
              <input
                type="text"
                className={ui.input}
                value={data.owner_first_name}
                onChange={(e) => onChange({ owner_first_name: e.target.value })}
                placeholder="First name"
                disabled={disabled}
              />
            </Field>

            <Field label="Owner Middle Name">
              <input
                type="text"
                className={ui.input}
                value={data.owner_middle_name}
                onChange={(e) => onChange({ owner_middle_name: e.target.value })}
                placeholder="Middle name (optional)"
                disabled={disabled}
              />
            </Field>

            <Field label="Owner Last Name" required>
              <input
                type="text"
                className={ui.input}
                value={data.owner_last_name}
                onChange={(e) => onChange({ owner_last_name: e.target.value })}
                placeholder="Last name"
                disabled={disabled}
              />
            </Field>

            <Field label="Owner Date of Birth">
              <DatePicker
                value={data.owner_dob}
                onChange={(val) => onChange({ owner_dob: val })}
                placeholder="Date of birth"
                className="mt-2"
                disabled={disabled}
              />
            </Field>

            <Field label="Owner Phone" required>
              <input
                type="tel"
                className={ui.input}
                value={data.owner_phone}
                onChange={(e) => onChange({ owner_phone: e.target.value })}
                placeholder="(555) 555-5555"
                disabled={disabled}
              />
            </Field>

            <Field label="Owner Email">
              <input
                type="email"
                className={ui.input}
                value={data.owner_email}
                onChange={(e) => onChange({ owner_email: e.target.value })}
                placeholder="email@example.com"
                disabled={disabled}
              />
            </Field>
          </div>
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

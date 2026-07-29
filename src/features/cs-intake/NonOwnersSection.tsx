'use client';

import { ShieldCheck } from 'lucide-react';
import { ui } from '../nhwd-shared/ui';
import DatePicker from '../nhwd-shared/DatePicker';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

export interface NonOwnersData {
  sr22_filing_state: string;
  court_order_date: string;
  desired_coverage: string;
  // ID / Passport fields
  document_type: string;
  document_number: string;
  document_state: string;
  document_expiration: string;
}

interface NonOwnersSectionProps {
  data: NonOwnersData;
  onChange: (patch: Partial<NonOwnersData>) => void;
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

export default function NonOwnersSection({ data, onChange, disabled }: NonOwnersSectionProps) {
  return (
    <div className="space-y-5">
      {/* SR-22 Details */}
      <section className={ui.card}>
        <div className={ui.cardHeader}>
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-950">Non-Owner / SR-22 Details</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                SR-22 filing information — no vehicles needed for this policy type
              </p>
            </div>
          </div>
        </div>
        <div className={ui.cardPad}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="SR-22 Filing State" required>
              <select
                className={ui.select}
                value={data.sr22_filing_state}
                onChange={(e) => onChange({ sr22_filing_state: e.target.value })}
                disabled={disabled}
              >
                <option value="">Select state...</option>
                {US_STATES.map((st) => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
            </Field>

            <Field label="Court Order Date" hint="If applicable">
              <DatePicker
                value={data.court_order_date}
                onChange={(val) => onChange({ court_order_date: val })}
                placeholder="Court order date"
                className="mt-2"
                disabled={disabled}
              />
            </Field>

            <Field label="Desired Liability Limits">
              <select
                className={ui.select}
                value={data.desired_coverage}
                onChange={(e) => onChange({ desired_coverage: e.target.value })}
                disabled={disabled}
              >
                <option value="">Select...</option>
                <option value="state_minimum">State Minimum</option>
                <option value="25/50/25">25/50/25</option>
                <option value="50/100/50">50/100/50</option>
                <option value="100/300/100">100/300/100</option>
                <option value="unsure">Unsure</option>
              </select>
            </Field>
          </div>
        </div>
      </section>

      {/* ID / Passport */}
      <section className={ui.card}>
        <div className={ui.cardHeader}>
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-950">Identification</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                Driver license, state ID, or passport information
              </p>
            </div>
          </div>
        </div>
        <div className={ui.cardPad}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Document Type" required>
              <select
                className={ui.select}
                value={data.document_type}
                onChange={(e) => onChange({ document_type: e.target.value })}
                disabled={disabled}
              >
                <option value="">Select...</option>
                <option value="driver_license">Driver License</option>
                <option value="state_id">State ID</option>
                <option value="passport">Passport</option>
              </select>
            </Field>

            <Field label="Document Number" required>
              <input
                type="text"
                className={ui.input}
                value={data.document_number}
                onChange={(e) => onChange({ document_number: e.target.value })}
                placeholder="License/ID/Passport #"
                disabled={disabled}
              />
            </Field>

            <Field label="Issuing State" required={data.document_type !== 'passport'}>
              <select
                className={ui.select}
                value={data.document_state}
                onChange={(e) => onChange({ document_state: e.target.value })}
                disabled={disabled || data.document_type === 'passport'}
              >
                <option value="">{data.document_type === 'passport' ? 'N/A (Passport)' : 'Select state...'}</option>
                {US_STATES.map((st) => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
            </Field>

            <Field label="Expiration Date" required>
              <DatePicker
                value={data.document_expiration}
                onChange={(val) => onChange({ document_expiration: val })}
                placeholder="Expiration date"
                className="mt-2"
                disabled={disabled}
              />
            </Field>
          </div>
        </div>
      </section>
    </div>
  );
}

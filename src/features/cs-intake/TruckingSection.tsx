'use client';

import { Truck } from 'lucide-react';
import { ui } from '../nhwd-shared/ui';
import DatePicker from '../nhwd-shared/DatePicker';

export interface TruckingData {
  business_name: string;
  business_type: string;
  years_in_business: number | null;
  dot_number: string;
  mc_number: string;
  mcs150_date: string;
  cargo_type: string;
  power_unit_count: number | null;
  operating_radius_miles: number | null;
}

interface TruckingSectionProps {
  data: TruckingData;
  onChange: (patch: Partial<TruckingData>) => void;
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

export default function TruckingSection({ data, onChange, disabled }: TruckingSectionProps) {
  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
            <Truck className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-950">Trucking / Motor Carrier Details</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              DOT and FMCSA information — DOT number is required
            </p>
          </div>
        </div>
      </div>
      <div className={ui.cardPad}>
        <div className="space-y-4">
          {/* Business Info Row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Business Name" required>
              <input
                type="text"
                className={ui.input}
                value={data.business_name}
                onChange={(e) => onChange({ business_name: e.target.value })}
                placeholder="e.g. Smith Trucking LLC"
                disabled={disabled}
              />
            </Field>

            <Field label="Type of Work">
              <input
                type="text"
                className={ui.input}
                value={data.business_type}
                onChange={(e) => onChange({ business_type: e.target.value })}
                placeholder="e.g. Long-haul freight, Local delivery"
                disabled={disabled}
              />
            </Field>

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

          {/* DOT / MC Row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="DOT Number" required hint="Required for trucking policies">
              <input
                type="text"
                className={ui.input}
                value={data.dot_number}
                onChange={(e) => onChange({ dot_number: e.target.value })}
                placeholder="e.g. 1234567"
                disabled={disabled}
              />
            </Field>

            <Field label="MC Number" hint="Motor Carrier number if applicable">
              <input
                type="text"
                className={ui.input}
                value={data.mc_number}
                onChange={(e) => onChange({ mc_number: e.target.value })}
                placeholder="e.g. MC-123456"
                disabled={disabled}
              />
            </Field>

            <Field label="MCS-150 Filing Date">
              <DatePicker
                value={data.mcs150_date}
                onChange={(val) => onChange({ mcs150_date: val })}
                placeholder="Last MCS-150 filing"
                className="mt-2"
                disabled={disabled}
              />
            </Field>
          </div>

          {/* Operations Row — Cargo Type moved to dedicated CargoSection */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Power Units" hint="Number of trucks">
              <input
                type="number"
                className={ui.input}
                value={data.power_unit_count ?? ''}
                onChange={(e) => onChange({ power_unit_count: e.target.value ? Number(e.target.value) : null })}
                placeholder="Number of trucks"
                min={0}
                disabled={disabled}
              />
            </Field>

            <Field label="Operating Radius (miles)">
              <input
                type="number"
                className={ui.input}
                value={data.operating_radius_miles ?? ''}
                onChange={(e) => onChange({ operating_radius_miles: e.target.value ? Number(e.target.value) : null })}
                placeholder="e.g. 500"
                min={0}
                disabled={disabled}
              />
            </Field>
          </div>
        </div>
      </div>
    </section>
  );
}

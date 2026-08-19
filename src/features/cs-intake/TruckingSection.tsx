'use client';

import { Truck } from 'lucide-react';
import { ui } from '../nhwd-shared/ui';
import DatePicker from '../nhwd-shared/DatePicker';
import StatesMultiSelect from '../nhwd-shared/StatesMultiSelect';

/**
 * Selectable operation types, replacing the old free-text "Type of Work".
 *
 * A carrier commonly runs more than one, so this is a multi-select. The joined
 * labels are mirrored into the legacy `business_type` column by IntakeForm so
 * existing saved intakes, server validation and reporting keep working.
 */
export const TRUCKING_OPERATION_TYPES = [
  { key: 'local_delivery', label: 'Local Delivery' },
  { key: 'regional', label: 'Regional' },
  { key: 'long_haul', label: 'Long Haul' },
  { key: 'hotshot', label: 'Hotshot' },
  { key: 'dump', label: 'Dump' },
  { key: 'auto_hauling', label: 'Auto Hauling' },
  { key: 'moving', label: 'Moving' },
  { key: 'construction', label: 'Construction' },
  { key: 'towing', label: 'Towing' },
  { key: 'other', label: 'Other' },
] as const;

/**
 * Banded operating radius.
 *
 * `miles` is the representative numeric value written back to the legacy
 * `operating_radius_miles` column, so anything that still reads a number keeps
 * getting one.
 */
export const RADIUS_BANDS = [
  { key: '0_50', label: '0 – 50 miles', miles: 50 },
  { key: '51_100', label: '51 – 100 miles', miles: 100 },
  { key: '101_200', label: '101 – 200 miles', miles: 200 },
  { key: '201_300', label: '201 – 300 miles', miles: 300 },
  { key: '301_500', label: '301 – 500 miles', miles: 500 },
  { key: '500_plus', label: '500+ miles', miles: 1000 },
] as const;

/** Turns stored operation keys into a human label string for `business_type`. */
export function operationTypesLabel(keys: string[] | null | undefined): string {
  if (!keys || keys.length === 0) return '';
  return keys
    .map((key) => TRUCKING_OPERATION_TYPES.find((option) => option.key === key)?.label ?? key)
    .join(', ');
}

/** The representative mileage for a band, for the legacy numeric column. */
export function radiusBandMiles(band: string | null | undefined): number | null {
  if (!band) return null;
  return RADIUS_BANDS.find((option) => option.key === band)?.miles ?? null;
}

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
  // ── Operations (v1.19.2) ───────────────────────────────────────────────────
  operation_types: string[];
  operation_description: string;
  desired_effective_date: string;
  interstate: boolean | null;
  for_hire: boolean | null;
  radius_band: string;
  farthest_states_cities: string;
  states_of_operation: string;
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

/** The tri-state Yes / No select used across the trucking sections. */
function YesNo({
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
      value={value === null ? '' : value ? 'yes' : 'no'}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value === 'yes')}
      disabled={disabled}
    >
      <option value="">— Select —</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
  );
}

export default function TruckingSection({ data, onChange, disabled }: TruckingSectionProps) {
  const selectedOperations = new Set(data.operation_types ?? []);
  const isLongRadius = data.radius_band === '500_plus';

  /** Toggling an operation also refreshes the legacy `business_type` label. */
  function toggleOperation(key: string) {
    if (disabled) return;
    const next = selectedOperations.has(key)
      ? (data.operation_types ?? []).filter((existing) => existing !== key)
      : [...(data.operation_types ?? []), key];
    onChange({ operation_types: next, business_type: operationTypesLabel(next) });
  }

  /** Choosing a band also refreshes the legacy numeric radius. */
  function selectRadiusBand(band: string) {
    onChange({
      radius_band: band || '',
      operating_radius_miles: radiusBandMiles(band),
      // Only the 500+ band asks for the farthest states, so clear a stale answer.
      ...(band === '500_plus' ? {} : { farthest_states_cities: '' }),
    });
  }

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
        <div className="space-y-5">
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

            <Field label="Desired Effective Date">
              <DatePicker
                value={data.desired_effective_date}
                onChange={(val) => onChange({ desired_effective_date: val })}
                placeholder="When should coverage start?"
                className="mt-2"
                disabled={disabled}
              />
            </Field>
          </div>

          {/* DOT / MC Row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          </div>

          {/* ─── Operation Types (replaces free-text Type of Work) ─────────── */}
          <div>
            <span className={ui.label}>Type of Operation *</span>
            <p className="mt-1 mb-3 text-xs font-semibold text-slate-400">
              Select every operation the customer runs. Click again to remove.
            </p>
            <div className="flex flex-wrap gap-2">
              {TRUCKING_OPERATION_TYPES.map((option) => {
                const isSelected = selectedOperations.has(option.key);
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => toggleOperation(option.key)}
                    disabled={disabled}
                    className={`rounded-xl border px-3 py-2 text-xs font-bold transition ${
                      isSelected
                        ? 'border-[#223f7a] bg-[#eef3fb] text-[#223f7a]'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Optional description — only worth asking once an operation is chosen. */}
          {selectedOperations.size > 0 && (
            <Field
              label="Operation Description"
              hint="Optional. Anything that helps underwriting picture the operation."
            >
              <textarea
                rows={2}
                className={ui.textarea}
                value={data.operation_description}
                onChange={(e) => onChange({ operation_description: e.target.value })}
                placeholder="e.g. Regional dry van freight between Miami and Atlanta, mostly regular lanes"
                disabled={disabled}
              />
            </Field>
          )}

          {/* ─── Operations detail ────────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

            <Field label="Operating Radius" required>
              <select
                className={ui.select}
                value={data.radius_band}
                onChange={(e) => selectRadiusBand(e.target.value)}
                disabled={disabled}
              >
                <option value="">— Select —</option>
                {RADIUS_BANDS.map((band) => (
                  <option key={band.key} value={band.key}>{band.label}</option>
                ))}
              </select>
            </Field>

            <Field label="Interstate?" hint="Does the customer cross state lines?">
              <YesNo
                value={data.interstate}
                onChange={(val) => onChange({ interstate: val })}
                disabled={disabled}
              />
            </Field>

            <Field label="For Hire?" hint="Hauling for others, not just own goods">
              <YesNo
                value={data.for_hire}
                onChange={(val) => onChange({ for_hire: val })}
                disabled={disabled}
              />
            </Field>
          </div>

          {/* States Traveled */}
          <Field label="States Traveled" hint="Every state the customer regularly operates in.">
            <div className="mt-2">
              <StatesMultiSelect
                value={data.states_of_operation}
                onChange={(val) => onChange({ states_of_operation: val })}
                disabled={disabled}
                placeholder="Select states traveled..."
              />
            </div>
          </Field>

          {/* 500+ radius follow-up */}
          {isLongRadius && (
            <Field
              label="Farthest States / Cities Travelled"
              required
              hint="Carriers ask for this whenever the radius exceeds 500 miles."
            >
              <textarea
                rows={2}
                className={ui.textarea}
                value={data.farthest_states_cities}
                onChange={(e) => onChange({ farthest_states_cities: e.target.value })}
                placeholder="e.g. Farthest is Los Angeles CA; regular lanes Miami FL to Dallas TX"
                disabled={disabled}
              />
            </Field>
          )}

          {/* MCS-150 stays available but is no longer a primary intake field. */}
          <details className="rounded-2xl border border-slate-100 bg-slate-50/40">
            <summary className="cursor-pointer px-4 py-3 text-xs font-black uppercase tracking-wider text-slate-400">
              FMCSA filing detail (optional)
            </summary>
            <div className="px-4 pb-4">
              <Field label="MCS-150 Filing Date" hint="Last MCS-150 filing, if the customer knows it.">
                <DatePicker
                  value={data.mcs150_date}
                  onChange={(val) => onChange({ mcs150_date: val })}
                  placeholder="Last MCS-150 filing"
                  className="mt-2"
                  disabled={disabled}
                />
              </Field>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}

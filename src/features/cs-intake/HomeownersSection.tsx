'use client';

import { Home } from 'lucide-react';
import { ui } from '../nhwd-shared/ui';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

const DWELLING_TYPES = [
  'Single Family',
  'Condo',
  'Townhouse',
  'Mobile Home',
  'Multi-Family',
  'Duplex',
  'Other',
];

const ROOF_TYPES = [
  'Shingle',
  'Tile',
  'Metal',
  'Flat',
  'Slate',
  'Wood Shake',
  'Other',
];

export interface HomeownersData {
  property_address_street: string;
  property_address_city: string;
  property_address_state: string;
  property_address_zip: string;
  dwelling_type: string;
  year_built: number | null;
  square_footage: number | null;
  roof_type: string;
  roof_age: number | null;
  coverage_amount: number | null;
  prior_claims: boolean;
  prior_claims_detail: string;
}

interface HomeownersSectionProps {
  data: HomeownersData;
  onChange: (patch: Partial<HomeownersData>) => void;
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

export default function HomeownersSection({ data, onChange, disabled }: HomeownersSectionProps) {
  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
            <Home className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-950">Property Details</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              Dwelling and property information for homeowners coverage
            </p>
          </div>
        </div>
      </div>
      <div className={ui.cardPad}>
        <div className="space-y-4">
          {/* Property Address */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Property Street Address" required>
              <input
                type="text"
                className={ui.input}
                value={data.property_address_street}
                onChange={(e) => onChange({ property_address_street: e.target.value })}
                placeholder="123 Main St"
                disabled={disabled}
              />
            </Field>

            <Field label="City">
              <input
                type="text"
                className={ui.input}
                value={data.property_address_city}
                onChange={(e) => onChange({ property_address_city: e.target.value })}
                placeholder="City"
                disabled={disabled}
              />
            </Field>

            <Field label="State">
              <select
                className={ui.select}
                value={data.property_address_state}
                onChange={(e) => onChange({ property_address_state: e.target.value })}
                disabled={disabled}
              >
                <option value="">Select...</option>
                {US_STATES.map((st) => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
            </Field>

            <Field label="ZIP">
              <input
                type="text"
                className={ui.input}
                value={data.property_address_zip}
                onChange={(e) => onChange({ property_address_zip: e.target.value })}
                placeholder="ZIP code"
                maxLength={10}
                disabled={disabled}
              />
            </Field>
          </div>

          {/* Dwelling Details */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Dwelling Type">
              <select
                className={ui.select}
                value={data.dwelling_type}
                onChange={(e) => onChange({ dwelling_type: e.target.value })}
                disabled={disabled}
              >
                <option value="">Select...</option>
                {DWELLING_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </Field>

            <Field label="Year Built">
              <input
                type="number"
                className={ui.input}
                value={data.year_built ?? ''}
                onChange={(e) => onChange({ year_built: e.target.value ? Number(e.target.value) : null })}
                placeholder="e.g. 1995"
                min={1800}
                max={new Date().getFullYear()}
                disabled={disabled}
              />
            </Field>

            <Field label="Square Footage">
              <input
                type="number"
                className={ui.input}
                value={data.square_footage ?? ''}
                onChange={(e) => onChange({ square_footage: e.target.value ? Number(e.target.value) : null })}
                placeholder="e.g. 2400"
                min={0}
                disabled={disabled}
              />
            </Field>

            <Field label="Coverage Amount ($)">
              <input
                type="number"
                className={ui.input}
                value={data.coverage_amount ?? ''}
                onChange={(e) => onChange({ coverage_amount: e.target.value ? Number(e.target.value) : null })}
                placeholder="e.g. 350000"
                min={0}
                disabled={disabled}
              />
            </Field>
          </div>

          {/* Roof Details */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Roof Type">
              <select
                className={ui.select}
                value={data.roof_type}
                onChange={(e) => onChange({ roof_type: e.target.value })}
                disabled={disabled}
              >
                <option value="">Select...</option>
                {ROOF_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </Field>

            <Field label="Roof Age (years)">
              <input
                type="number"
                className={ui.input}
                value={data.roof_age ?? ''}
                onChange={(e) => onChange({ roof_age: e.target.value ? Number(e.target.value) : null })}
                placeholder="e.g. 5"
                min={0}
                disabled={disabled}
              />
            </Field>
          </div>

          {/* Prior Claims */}
          <div className="space-y-3">
            <label className={ui.checkboxRow + ' cursor-pointer'}>
              <input
                type="checkbox"
                checked={data.prior_claims}
                onChange={(e) => onChange({ prior_claims: e.target.checked })}
                disabled={disabled}
                className="h-4 w-4 rounded border-slate-300 text-[#223f7a] focus:ring-[#223f7a]"
              />
              <span>Prior claims on this property</span>
            </label>

            {data.prior_claims && (
              <Field label="Claims Detail" hint="Describe prior claims (dates, amounts, cause)">
                <textarea
                  className={ui.textarea}
                  rows={3}
                  value={data.prior_claims_detail}
                  onChange={(e) => onChange({ prior_claims_detail: e.target.value })}
                  placeholder="e.g. 2022 water damage claim, $15,000 payout"
                  disabled={disabled}
                />
              </Field>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

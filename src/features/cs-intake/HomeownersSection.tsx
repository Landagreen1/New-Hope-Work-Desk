'use client';

import { Home, Plus, Trash2, UserRound } from 'lucide-react';
import { ui } from '../nhwd-shared/ui';
import VerifiedAddressField from '../nhwd-shared/VerifiedAddressField';
import DatePicker from '../nhwd-shared/DatePicker';
import type { VerifiedAddressValue } from '../nhwd-shared/verified-address';
import type { CsIntakeOwner } from './api';

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

const COVERAGE_TYPES = [
  'Homeowners',
  'Landlord',
  'Mobile Home',
];

export interface HomeownersData {
  property_address_street: string;
  property_address_unit: string;
  property_address_city: string;
  property_address_state: string;
  property_address_zip: string;
  property_place_id: string | null;
  property_formatted: string | null;
  property_addr_verified: boolean;
  dwelling_type: string;
  year_built: number | null;
  square_footage: number | null;
  roof_type: string;
  roof_age: number | null;
  last_roof_update: string;
  coverage_amount: number | null;
  coverage_type: string;
  prior_claims: boolean;
  prior_claims_detail: string;
}

export interface HomeownersPerson {
  position: number;
  first_name: string;
  last_name: string;
  dob: string | null;
  relationship: string;
  phone: string | null;
  email: string | null;
}

export function emptyHomeownersPerson(position = 1): HomeownersPerson {
  return {
    position,
    first_name: '',
    last_name: '',
    dob: null,
    relationship: 'spouse',
    phone: null,
    email: null,
  };
}

interface HomeownersSectionProps {
  data: HomeownersData;
  onChange: (patch: Partial<HomeownersData>) => void;
  persons: HomeownersPerson[];
  onPersonsChange: (persons: HomeownersPerson[]) => void;
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

export default function HomeownersSection({ data, onChange, persons, onPersonsChange, disabled }: HomeownersSectionProps) {
  // Adapter: flat homeowners address fields → VerifiedAddressValue
  const propertyAddress: VerifiedAddressValue = {
    street: data.property_address_street,
    unit: data.property_address_unit,
    city: data.property_address_city,
    state: data.property_address_state,
    zip: data.property_address_zip,
    placeId: data.property_place_id,
    formatted: data.property_formatted,
    verified: data.property_addr_verified,
  };

  function handleAddressChange(next: VerifiedAddressValue) {
    onChange({
      property_address_street: next.street,
      property_address_unit: next.unit,
      property_address_city: next.city,
      property_address_state: next.state,
      property_address_zip: next.zip,
      property_place_id: next.placeId,
      property_formatted: next.formatted,
      property_addr_verified: next.verified,
    });
  }

  function patchPerson(index: number, values: Partial<HomeownersPerson>) {
    onPersonsChange(persons.map((p, i) => i === index ? { ...p, ...values } : p));
  }

  function removePerson(index: number) {
    onPersonsChange(persons.filter((_, i) => i !== index).map((p, i) => ({ ...p, position: i + 1 })));
  }

  function addPerson() {
    onPersonsChange([...persons, emptyHomeownersPerson(persons.length + 1)]);
  }

  return (
    <div className="space-y-5">
      {/* Property Address (Google-verified) */}
      <section className={ui.card}>
        <div className={ui.cardHeader}>
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
              <Home className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-950">Property Address</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                The physical address of the property to be insured. Start typing to search with Google.
              </p>
            </div>
          </div>
        </div>
        <div className={ui.cardPad}>
          <VerifiedAddressField
            value={propertyAddress}
            onChange={handleAddressChange}
            disabled={disabled}
            streetLabel="Property street address"
            required
            requireVerification
          />
        </div>
      </section>

      {/* Property Details */}
      <section className={ui.card}>
        <div className={ui.cardHeader}>
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
              <Home className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-950">Property Details</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                Dwelling and coverage information
              </p>
            </div>
          </div>
        </div>
        <div className={ui.cardPad}>
          <div className="space-y-4">
            {/* Type of Coverage */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Type of Coverage" required>
                <select
                  className={ui.select}
                  value={data.coverage_type}
                  onChange={(e) => onChange({ coverage_type: e.target.value })}
                  disabled={disabled}
                >
                  <option value="">Select...</option>
                  {COVERAGE_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
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

              <Field label="Last Roof Update">
                <input
                  type="text"
                  className={ui.input}
                  value={data.last_roof_update}
                  onChange={(e) => onChange({ last_roof_update: e.target.value })}
                  placeholder="e.g. 2020"
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

      {/* Additional Insured Persons */}
      <section className={ui.card}>
        <div className={ui.cardHeader}>
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
              <UserRound className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-950">Additional Insured ({persons.length})</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                Add any co-insured persons or additional people who should be listed on the policy.
              </p>
            </div>
          </div>
        </div>
        <div className={ui.cardPad}>
          <div className="space-y-4">
            {persons.length === 0 && (
              <p className="text-sm font-semibold text-slate-400">No additional persons added yet.</p>
            )}
            {persons.map((person, index) => (
              <div key={`person-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-black text-slate-900">Person {index + 1}</p>
                  {!disabled ? (
                    <button type="button" className={ui.btnDanger} onClick={() => removePerson(index)}>
                      <Trash2 className="h-4 w-4" /> Remove
                    </button>
                  ) : null}
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="First name" required>
                    <input
                      className={ui.input}
                      disabled={disabled}
                      value={person.first_name}
                      onChange={(e) => patchPerson(index, { first_name: e.target.value })}
                    />
                  </Field>
                  <Field label="Last name" required>
                    <input
                      className={ui.input}
                      disabled={disabled}
                      value={person.last_name}
                      onChange={(e) => patchPerson(index, { last_name: e.target.value })}
                    />
                  </Field>
                  <Field label="Date of birth">
                    <DatePicker
                      value={person.dob || ''}
                      onChange={(val) => patchPerson(index, { dob: val || null })}
                      disabled={disabled}
                      placeholder="Date of birth"
                    />
                  </Field>
                  <Field label="Relationship">
                    <select
                      className={ui.select}
                      disabled={disabled}
                      value={person.relationship}
                      onChange={(e) => patchPerson(index, { relationship: e.target.value })}
                    >
                      <option value="spouse">Spouse</option>
                      <option value="child">Child</option>
                      <option value="parent">Parent</option>
                      <option value="sibling">Sibling</option>
                      <option value="roommate">Roommate</option>
                      <option value="other">Other</option>
                    </select>
                  </Field>
                  <Field label="Phone">
                    <input
                      type="tel"
                      className={ui.input}
                      disabled={disabled}
                      value={person.phone || ''}
                      onChange={(e) => patchPerson(index, { phone: e.target.value || null })}
                      placeholder="(555) 555-5555"
                    />
                  </Field>
                  <Field label="Email">
                    <input
                      type="email"
                      className={ui.input}
                      disabled={disabled}
                      value={person.email || ''}
                      onChange={(e) => patchPerson(index, { email: e.target.value || null })}
                      placeholder="email@example.com"
                    />
                  </Field>
                </div>
              </div>
            ))}
          </div>
          {!disabled ? (
            <button type="button" className={`${ui.btnSecondary} mt-4`} onClick={addPerson}>
              <Plus className="h-4 w-4" /> Add another person
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

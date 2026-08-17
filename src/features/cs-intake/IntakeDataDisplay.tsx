'use client';

import { ui } from '../nhwd-shared/ui';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface IntakeDataDetails {
  // Insured Personal Info
  insured_first_name?: string | null;
  insured_last_name?: string | null;
  insured_dob?: string | null;
  insured_email?: string | null;
  insured_phone_primary?: string | null;
  insured_phone_alt?: string | null;
  preferred_language?: string | null;
  preferred_contact?: string | null;
  addr_street?: string | null;
  addr_unit?: string | null;
  addr_city?: string | null;
  addr_state?: string | null;
  addr_zip?: string | null;
  // Business info (commercial)
  business_name?: string | null;
  dot_number?: string | null;
  // Drivers
  drivers?: Array<{
    first_name?: string;
    last_name?: string;
    dob?: string | null;
    license_number?: string | null;
    license_state?: string | null;
    years_licensed?: number | null;
    sr22_required?: boolean;
  }>;
  // Vehicles
  vehicles?: Array<{
    year?: number | null;
    make?: string | null;
    model?: string | null;
    vin?: string | null;
    usage?: string | null;
    annual_mileage?: number | null;
  }>;
  // Owners (commercial)
  owners?: Array<{
    first_name?: string;
    middle_name?: string | null;
    last_name?: string;
    dob?: string | null;
    phone?: string | null;
    email?: string | null;
    ownership_percentage?: number | null;
  }>;
  // Coverage
  desired_coverage?: string | null;
  liability_limit?: string | null;
  comprehensive_deductible?: string | null;
  collision_deductible?: string | null;
  // Current Policy
  current_carrier?: string | null;
  current_policy_number?: string | null;
  current_premium?: number | null;
  current_expiration?: string | null;
  // Notes
  csr_notes?: string | null;
  /**
   * Line-of-business specific answers.
   *
   * Deliberately loose. A Renters intake and a Trucking intake record entirely
   * different things, and enumerating all eight LOBs here would add ~70 optional
   * fields to a type whose job is the shape common to every intake. The fields that
   * matter per LOB are declared once in LOB_SECTIONS below and read from here.
   */
  [key: string]: unknown;
}

interface IntakeDataDisplayProps {
  details: IntakeDataDetails;
  /**
   * Which line of business this intake is, so its own answers can be shown.
   *
   * Optional: callers that only have the flat conversion payload (the Intake Queue)
   * omit it and see the common sections exactly as before.
   */
  lineOfBusiness?: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Display a value or "N/A" when null/undefined/empty. */
function val(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'N/A';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** Format an ISO date string (YYYY-MM-DD) to M/D/YYYY. Returns 'N/A' for invalid/empty. */
function fmtDate(value: string | null | undefined): string {
  if (!value) return 'N/A';
  const parts = value.split('-');
  if (parts.length === 3) {
    const [y, m, d] = parts;
    return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
  }
  // Already formatted (e.g. M/D/YYYY from DB) — pass through
  return value;
}

/** Human-readable label for desired_coverage values. */
function fmtCoverage(value: string | null | undefined): string {
  if (!value) return 'N/A';
  const labels: Record<string, string> = {
    liability_only: 'Liability Only',
    full_coverage: 'Full Coverage',
    both_prices: 'Customer Wants Both Prices',
    unsure: 'Customer Unsure',
  };
  return labels[value] || value;
}

/** Check if at least one of the provided values is non-null/defined. */
function hasAny(...values: (string | number | boolean | null | undefined)[]): boolean {
  return values.some((v) => v !== null && v !== undefined && v !== '');
}

/* -------------------------------------------------------------------------- */
/*  Line-of-business answers                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The questions each line of business actually asks.
 *
 * Declared as data rather than as eight more JSX blocks: the sections differ only
 * in which fields they list, and a table makes it obvious what is shown for a
 * Renters quote versus a Trucking one. Empty values are dropped at render, so a
 * partly filled intake shows what it has instead of a wall of "N/A".
 */
type LobField = [key: string, label: string, kind?: 'date' | 'money' | 'bool' | 'list'];

const LOB_SECTIONS: Record<string, { title: string; fields: LobField[] }> = {
  renters: {
    title: 'Rental Property',
    fields: [
      ['renters_property_address', 'Property address'],
      ['renters_unit', 'Unit / Apt'],
      ['renters_city', 'City'],
      ['renters_state', 'State'],
      ['renters_zip', 'ZIP'],
      ['renters_landlord_name', 'Landlord'],
      ['renters_personal_property_value', 'Personal property value', 'money'],
      ['renters_liability_limit', 'Liability limit', 'money'],
      ['renters_move_in_date', 'Move-in date'],
    ],
  },
  motorcycle: {
    title: 'Motorcycle',
    fields: [
      ['moto_year', 'Year'],
      ['moto_make', 'Make'],
      ['moto_model', 'Model'],
      ['moto_vin', 'VIN'],
      ['moto_cc', 'Engine (cc)'],
      ['moto_type', 'Type'],
    ],
  },
  boat: {
    title: 'Watercraft',
    fields: [
      ['boat_year', 'Year'],
      ['boat_make', 'Make'],
      ['boat_model', 'Model'],
      ['boat_hin', 'Hull ID (HIN)'],
      ['boat_length', 'Length'],
      ['boat_type', 'Type'],
      ['boat_hp', 'Horsepower'],
      ['boat_value', 'Value', 'money'],
      ['boat_trailer_included', 'Trailer included', 'bool'],
    ],
  },
  trailer: {
    title: 'Trailer / Mobile Home',
    fields: [
      ['trailer_year', 'Year'],
      ['trailer_make', 'Make'],
      ['trailer_model', 'Model'],
      ['trailer_vin', 'VIN'],
      ['trailer_length', 'Length'],
      ['trailer_type', 'Type'],
      ['trailer_value', 'Value', 'money'],
      ['trailer_park_name', 'Park name'],
      ['trailer_lot_number', 'Lot number'],
    ],
  },
  non_owners: {
    title: 'Non-Owners / SR-22',
    fields: [
      ['sr22_filing_state', 'SR-22 filing state'],
      ['court_order_date', 'Court order date', 'date'],
      ['no_document_type', 'Document type'],
      ['no_document_number', 'Document number'],
      ['no_document_state', 'Issuing state'],
      ['no_document_expiration', 'Document expiration', 'date'],
    ],
  },
  trucking: {
    title: 'Trucking Operation',
    fields: [
      ['business_type', 'Type of work'],
      ['years_in_business', 'Years in business'],
      ['dot_number', 'DOT number'],
      ['mc_number', 'MC number'],
      ['mcs150_date', 'MCS-150 date', 'date'],
      ['cargo_type', 'Cargo type (legacy)'],
      ['cargo_coverage_desired', 'Cargo coverage desired', 'bool'],
      ['primary_commodity', 'Primary commodity'],
      ['cargo_description', 'Cargo description'],
      ['broker_load_board', 'Broker / Load board', 'bool'],
      ['commodity_mix_known', 'Commodity mix fully known', 'bool'],
      ['power_unit_count', 'Power units'],
      ['operating_radius_miles', 'Operating radius (miles)'],
      ['typical_load_value', 'Typical load value', 'money'],
      ['max_load_value', 'Maximum load value', 'money'],
      ['requested_cargo_limit', 'Requested cargo limit', 'money'],
      ['cargo_deductible', 'Cargo deductible', 'money'],
      ['refrigerated', 'Refrigerated', 'bool'],
      ['temperature_controlled_equipment', 'Temp-controlled equipment', 'bool'],
      ['reefer_breakdown_requested', 'Reefer breakdown coverage'],
      ['hazmat', 'Hazardous materials'],
      ['high_value_cargo_flag', 'High-value cargo flag', 'bool'],
      ['auto_hauling_vehicles_per_load', 'Vehicles per load (auto hauling)'],
      ['auto_hauling_max_value', 'Max value vehicles per load', 'money'],
      ['machinery_max_value', 'Max machinery/equipment value', 'money'],
    ],
  },
  commercial_gl: {
    title: 'Commercial Operation',
    fields: [
      ['business_type', 'Type of work'],
      ['years_in_business', 'Years in business'],
      ['ein', 'EIN'],
      ['states_of_operation', 'States of operation'],
      ['employee_count', 'Employees'],
      ['annual_payroll', 'Annual payroll', 'money'],
      ['coverage_types_needed', 'Coverage needed', 'list'],
    ],
  },
  homeowners: {
    title: 'Property',
    fields: [
      ['property_address_street', 'Property address'],
      ['property_address_city', 'City'],
      ['property_address_state', 'State'],
      ['property_address_zip', 'ZIP'],
      ['dwelling_type', 'Dwelling type'],
      ['year_built', 'Year built'],
      ['square_footage', 'Square footage'],
      ['roof_type', 'Roof type'],
      ['roof_age', 'Roof age'],
      ['coverage_amount', 'Coverage amount', 'money'],
      ['prior_claims', 'Prior claims', 'bool'],
      ['prior_claims_detail', 'Prior claims detail'],
    ],
  },
  commercial_auto: {
    title: 'Business',
    fields: [
      ['business_type', 'Type of work'],
      ['years_in_business', 'Years in business'],
      ['dot_number', 'DOT number'],
      ['dot_not_applicable', 'DOT not applicable', 'bool'],
      ['operating_radius_miles', 'Operating radius (miles)'],
    ],
  },
};

/** Renders one LOB value according to its declared kind. */
function formatLobValue(raw: unknown, kind: LobField[2]): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (kind === 'bool') return raw ? 'Yes' : 'No';
  if (kind === 'list') {
    const items = Array.isArray(raw) ? raw.filter(Boolean) : [raw];
    return items.length ? items.join(', ') : null;
  }
  if (kind === 'money') {
    const numeric = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.]/g, ''));
    return Number.isFinite(numeric) && numeric > 0
      ? `$${numeric.toLocaleString()}`
      : String(raw);
  }
  if (kind === 'date') return fmtDate(String(raw));
  return String(raw);
}

/* -------------------------------------------------------------------------- */
/*  Section Sub-Components                                                     */
/* -------------------------------------------------------------------------- */

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={ui.card}>
      <div className="px-5 py-4">
        <h4 className={ui.sectionTitle}>{title}</h4>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className={ui.label}>{label}</span>
      <p className="mt-1 text-sm font-semibold text-slate-800">{value}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Main Component                                                             */
/* -------------------------------------------------------------------------- */

export default function IntakeDataDisplay({ details, lineOfBusiness }: IntakeDataDisplayProps) {
  const d = details;

  // The answers specific to this line of business, with blanks dropped.
  const lobSection = lineOfBusiness ? LOB_SECTIONS[lineOfBusiness] : undefined;
  const lobValues = (lobSection?.fields ?? [])
    .map(([key, label, kind]) => ({ label, value: formatLobValue(d[key], kind) }))
    .filter((entry): entry is { label: string; value: string } => entry.value !== null);

  // Determine which sections have content
  const hasPersonalInfo = hasAny(
    d.insured_first_name, d.insured_last_name, d.insured_dob,
    d.insured_email, d.insured_phone_primary, d.insured_phone_alt,
    d.preferred_language, d.preferred_contact,
    d.addr_street, d.addr_city, d.addr_state, d.addr_zip,
    d.business_name, d.dot_number,
  );
  const hasDrivers = d.drivers && d.drivers.length > 0;
  const hasVehicles = d.vehicles && d.vehicles.length > 0;
  const hasOwners = d.owners && d.owners.length > 0;
  const hasCoverage = hasAny(
    d.desired_coverage, d.liability_limit,
    d.comprehensive_deductible, d.collision_deductible,
  );
  const hasCurrentPolicy = hasAny(
    d.current_carrier, d.current_policy_number,
    d.current_premium, d.current_expiration,
  );
  const hasNotes = hasAny(d.csr_notes);

  if (
    !hasPersonalInfo && !hasDrivers && !hasVehicles && !hasCoverage
    && !hasCurrentPolicy && !hasNotes && lobValues.length === 0
  ) {
    return (
      <div className={ui.empty}>
        No intake data available.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {/* Insured Personal Info */}
      {hasPersonalInfo && (
        <SectionCard title="Insured Personal Info">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="First Name" value={val(d.insured_first_name)} />
            <Field label="Last Name" value={val(d.insured_last_name)} />
            <Field label="Date of Birth" value={fmtDate(d.insured_dob)} />
            <Field label="Email" value={val(d.insured_email)} />
            <Field label="Phone" value={val(d.insured_phone_primary)} />
            {d.insured_phone_alt && <Field label="Alt Phone" value={val(d.insured_phone_alt)} />}
            <Field label="Preferred Language" value={val(d.preferred_language)} />
            <Field label="Preferred Contact" value={val(d.preferred_contact)} />
            {hasAny(d.addr_street, d.addr_unit, d.addr_city, d.addr_state, d.addr_zip) && (
              <div className="sm:col-span-2">
                <span className={ui.label}>Address</span>
                <p className="mt-1 text-sm font-semibold text-slate-800">
                  {[
                    d.addr_unit ? `${d.addr_street}, ${d.addr_unit}` : d.addr_street,
                    d.addr_city, d.addr_state, d.addr_zip,
                  ].filter(Boolean).join(', ') || 'N/A'}
                </p>
              </div>
            )}
            {d.business_name && <Field label="Business Name" value={val(d.business_name)} />}
            {d.dot_number && <Field label="DOT Number" value={val(d.dot_number)} />}
          </div>
        </SectionCard>
      )}

      {/* Whatever this line of business asked about — the rental property, the
          motorcycle, the trucking operation, and so on. */}
      {lobSection && lobValues.length > 0 && (
        <SectionCard title={lobSection.title}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {lobValues.map((entry) => (
              <Field key={entry.label} label={entry.label} value={entry.value} />
            ))}
          </div>
        </SectionCard>
      )}

      {/* Coverage Preferences */}
      {hasCoverage && (
        <SectionCard title="Coverage Preferences">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Desired Coverage" value={fmtCoverage(d.desired_coverage)} />
            <Field label="Liability Limit" value={val(d.liability_limit)} />
            <Field label="Comprehensive Deductible" value={val(d.comprehensive_deductible)} />
            <Field label="Collision Deductible" value={val(d.collision_deductible)} />
          </div>
        </SectionCard>
      )}

      {/* Current Policy Info */}
      {hasCurrentPolicy && (
        <SectionCard title="Current Policy Info">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Current Carrier" value={val(d.current_carrier)} />
            <Field label="Policy Number" value={val(d.current_policy_number)} />
            <Field label="Premium" value={d.current_premium != null ? `$${d.current_premium}` : 'N/A'} />
            <Field label="Expiration" value={val(d.current_expiration)} />
          </div>
        </SectionCard>
      )}

      {/* Drivers */}
      {hasDrivers && (
        <div className="md:col-span-2">
          <SectionCard title="Drivers">
            <div className="overflow-x-auto">
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>Name</th>
                    <th className={ui.th}>DOB</th>
                    <th className={ui.th}>License #</th>
                    <th className={ui.th}>State</th>
                    <th className={ui.th}>Yrs Licensed</th>
                    <th className={ui.th}>SR-22</th>
                  </tr>
                </thead>
                <tbody>
                  {d.drivers!.map((driver, idx) => (
                    <tr key={idx}>
                      <td className={ui.td}>
                        {val(driver.first_name)} {val(driver.last_name)}
                      </td>
                      <td className={ui.td}>{fmtDate(driver.dob)}</td>
                      <td className={ui.td}>{val(driver.license_number)}</td>
                      <td className={ui.td}>{val(driver.license_state)}</td>
                      <td className={ui.td}>{val(driver.years_licensed)}</td>
                      <td className={ui.td}>
                        {driver.sr22_required ? (
                          <span className={`${ui.badge} ${ui.badgeTone.danger}`}>Yes</span>
                        ) : (
                          <span className="text-sm text-slate-500">No</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      )}

      {/* Vehicles */}
      {hasVehicles && (
        <div className="md:col-span-2">
          <SectionCard title="Vehicles">
            <div className="overflow-x-auto">
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>Year</th>
                    <th className={ui.th}>Make</th>
                    <th className={ui.th}>Model</th>
                    <th className={ui.th}>VIN</th>
                    <th className={ui.th}>Usage</th>
                    <th className={ui.th}>Annual Mileage</th>
                  </tr>
                </thead>
                <tbody>
                  {d.vehicles!.map((vehicle, idx) => (
                    <tr key={idx}>
                      <td className={ui.td}>{val(vehicle.year)}</td>
                      <td className={ui.td}>{val(vehicle.make)}</td>
                      <td className={ui.td}>{val(vehicle.model)}</td>
                      <td className={ui.td}>{val(vehicle.vin)}</td>
                      <td className={ui.td}>{val(vehicle.usage)}</td>
                      <td className={ui.td}>
                        {vehicle.annual_mileage != null
                          ? vehicle.annual_mileage.toLocaleString()
                          : 'N/A'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      )}

      {/* Owners */}
      {hasOwners && (
        <div className="md:col-span-2">
          <SectionCard title="Business Owners">
            <div className="overflow-x-auto">
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>Name</th>
                    <th className={ui.th}>DOB</th>
                    <th className={ui.th}>Phone</th>
                    <th className={ui.th}>Email</th>
                    <th className={ui.th}>Ownership %</th>
                  </tr>
                </thead>
                <tbody>
                  {d.owners!.map((owner, idx) => (
                    <tr key={idx}>
                      <td className={ui.td}>
                        {val(owner.first_name)} {owner.middle_name ? `${owner.middle_name} ` : ''}{val(owner.last_name)}
                      </td>
                      <td className={ui.td}>{fmtDate(owner.dob)}</td>
                      <td className={ui.td}>{val(owner.phone)}</td>
                      <td className={ui.td}>{val(owner.email)}</td>
                      <td className={ui.td}>{owner.ownership_percentage != null ? `${owner.ownership_percentage}%` : 'N/A'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      )}

      {/* CSR Notes */}
      {hasNotes && (
        <div className="md:col-span-2">
          <div className={`${ui.card} border-amber-200 bg-amber-50`}>
            <div className="px-5 py-4">
              <h4 className={ui.sectionTitle}>CSR Notes</h4>
              <p className="mt-3 whitespace-pre-wrap text-sm font-semibold leading-relaxed text-slate-800">
                {d.csr_notes}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

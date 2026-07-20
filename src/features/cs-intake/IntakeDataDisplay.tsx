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
}

interface IntakeDataDisplayProps {
  details: IntakeDataDetails;
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

/** Check if at least one of the provided values is non-null/defined. */
function hasAny(...values: (string | number | boolean | null | undefined)[]): boolean {
  return values.some((v) => v !== null && v !== undefined && v !== '');
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

export default function IntakeDataDisplay({ details }: IntakeDataDisplayProps) {
  const d = details;

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
  const hasCoverage = hasAny(
    d.desired_coverage, d.liability_limit,
    d.comprehensive_deductible, d.collision_deductible,
  );
  const hasCurrentPolicy = hasAny(
    d.current_carrier, d.current_policy_number,
    d.current_premium, d.current_expiration,
  );
  const hasNotes = hasAny(d.csr_notes);

  if (!hasPersonalInfo && !hasDrivers && !hasVehicles && !hasCoverage && !hasCurrentPolicy && !hasNotes) {
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
            <Field label="Date of Birth" value={val(d.insured_dob)} />
            <Field label="Email" value={val(d.insured_email)} />
            <Field label="Phone" value={val(d.insured_phone_primary)} />
            {d.insured_phone_alt && <Field label="Alt Phone" value={val(d.insured_phone_alt)} />}
            <Field label="Preferred Language" value={val(d.preferred_language)} />
            <Field label="Preferred Contact" value={val(d.preferred_contact)} />
            {hasAny(d.addr_street, d.addr_city, d.addr_state, d.addr_zip) && (
              <div className="sm:col-span-2">
                <span className={ui.label}>Address</span>
                <p className="mt-1 text-sm font-semibold text-slate-800">
                  {[d.addr_street, d.addr_city, d.addr_state, d.addr_zip]
                    .filter(Boolean)
                    .join(', ') || 'N/A'}
                </p>
              </div>
            )}
            {d.business_name && <Field label="Business Name" value={val(d.business_name)} />}
            {d.dot_number && <Field label="DOT Number" value={val(d.dot_number)} />}
          </div>
        </SectionCard>
      )}

      {/* Coverage Preferences */}
      {hasCoverage && (
        <SectionCard title="Coverage Preferences">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Desired Coverage" value={val(d.desired_coverage)} />
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
                      <td className={ui.td}>{val(driver.dob)}</td>
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

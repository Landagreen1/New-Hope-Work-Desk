'use client';

import {
  Building2,
  Car,
  CheckCircle2,
  FileText,
  Plus,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import VinDecoder from './VinDecoder';
import AddressAutocomplete from './AddressAutocomplete';
import {
  type CsIntakeDriver,
  type CsIntakeLob,
  type CsIntakePriority,
  type CsIntakeSubmission,
  type CsIntakeVehicle,
  type Dealer,
  type DealerSalesperson,
  type DesiredCoverage,
  listDealers,
  listSalespeople,
  listCommercialAssignees,
  saveDraft,
  submitIntake,
  submitCommercialIntake,
} from './api';
import DatePicker from '../nhwd-shared/DatePicker';
import LobPicker, { type ExtendedLob, isCommercialRoute } from './LobPicker';
import NonOwnersSection, { type NonOwnersData } from './NonOwnersSection';
import TruckingSection, { type TruckingData } from './TruckingSection';
import CommercialGlSection, { type CommercialGlData } from './CommercialGlSection';
import HomeownersSection, { type HomeownersData } from './HomeownersSection';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

const emptyDriver = (position = 1): CsIntakeDriver => ({
  position,
  first_name: '',
  last_name: '',
  dob: null,
  relationship: position === 1 ? 'self' : 'other',
  document_type: 'driver_license',
  license_number: null,
  license_state: null,
  license_status: 'valid',
  years_licensed: null,
  sr22_required: false,
});

const emptyVehicle = (position = 1): CsIntakeVehicle => ({
  position,
  year: null,
  make: null,
  model: null,
  vin: null,
  vin_pending: false,
  ownership: 'owned',
  lienholder: null,
  usage: 'commute',
  annual_mileage: null,
  garaging_zip: null,
});

type DraftSubmission = Partial<CsIntakeSubmission> & {
  priority: CsIntakePriority;
  line_of_business: CsIntakeLob;
  quote_kind: 'new_quote' | 'requote';
  insured_first_name: string;
  insured_last_name: string;
  mailing_same_as_addr: boolean;
  dot_not_applicable: boolean;
};

/** LOBs that need drivers/vehicles sections */
const LOBS_WITH_DRIVERS: ExtendedLob[] = ['personal_auto', 'commercial_auto', 'trucking', 'commercial_gl'];
const LOBS_WITH_VEHICLES: ExtendedLob[] = ['personal_auto', 'commercial_auto', 'trucking', 'commercial_gl'];

/** LOBs where at least 1 driver and 1 vehicle are required */
const LOBS_REQUIRE_DRIVERS: ExtendedLob[] = ['personal_auto', 'commercial_auto', 'trucking'];
const LOBS_REQUIRE_VEHICLES: ExtendedLob[] = ['personal_auto', 'commercial_auto', 'trucking'];

interface Props {
  profileId: string;
  initial?: {
    submission: CsIntakeSubmission;
    drivers: CsIntakeDriver[];
    vehicles: CsIntakeVehicle[];
  };
  readOnly?: boolean;
  onDone: () => void;
}

function Field({ label, required, children, hint }: { label: string; required?: boolean; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className={ui.label}>{label}{required ? ' *' : ''}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs font-semibold text-slate-400">{hint}</span> : null}
    </label>
  );
}

function Section({ icon, title, subtitle, children }: { icon: React.ReactNode; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">{icon}</div>
          <div>
            <h3 className="text-lg font-black text-slate-950">{title}</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">{subtitle}</p>
          </div>
        </div>
      </div>
      <div className={ui.cardPad}>{children}</div>
    </section>
  );
}

export default function IntakeForm({ profileId, initial, readOnly = false, onDone }: Props) {
  const [lobPicked, setLobPicked] = useState<boolean>(!!initial);
  const [submission, setSubmission] = useState<DraftSubmission>(() => {
    const row = initial?.submission;
    return row
      ? { ...row, line_of_business: row.line_of_business === 'auto' ? 'personal_auto' : row.line_of_business }
      : {
          priority: 'normal',
          line_of_business: 'personal_auto',
          quote_kind: 'new_quote',
          insured_first_name: '',
          insured_last_name: '',
          mailing_same_as_addr: true,
          dot_not_applicable: false,
          desired_coverage: 'full_coverage',
          prior_insurance: null,
          prior_lapse: null,
        };
  });
  const [drivers, setDrivers] = useState<CsIntakeDriver[]>(
    initial?.drivers?.length ? initial.drivers.map((row) => ({ ...row, document_type: row.document_type || 'driver_license' })) : (submission.line_of_business === 'commercial_gl' ? [] : [emptyDriver()]),
  );
  const [vehicles, setVehicles] = useState<CsIntakeVehicle[]>(initial?.vehicles?.length ? initial.vehicles : (submission.line_of_business === 'commercial_gl' ? [] : [emptyVehicle()]));
  const [dealers, setDealers] = useState<Dealer[]>([]);
  const [salespeople, setSalespeople] = useState<DealerSalesperson[]>([]);
  const [loadingSalespeople, setLoadingSalespeople] = useState(false);
  const [commercialAssignees, setCommercialAssignees] = useState<{ id: string; display_name: string; role: string }[]>([]);
  const [selectedAssignee, setSelectedAssignee] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isCommercial = submission.line_of_business === 'commercial_auto';
  const currentLob = submission.line_of_business as ExtendedLob;
  const showDrivers = LOBS_WITH_DRIVERS.includes(currentLob);
  const showVehicles = LOBS_WITH_VEHICLES.includes(currentLob);
  const isCommercialRouted = isCommercialRoute(currentLob);
  const disabled = readOnly || busy;

  useEffect(() => {
    listDealers().then(setDealers).catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load sources.'));
  }, []);

  useEffect(() => {
    if (isCommercialRouted) {
      listCommercialAssignees().then(setCommercialAssignees).catch(() => {});
    }
  }, [isCommercialRouted]);

  useEffect(() => {
    let active = true;
    if (!submission.dealer_id) {
      setSalespeople([]);
      return;
    }
    setLoadingSalespeople(true);
    listSalespeople(submission.dealer_id)
      .then((rows) => { if (active) setSalespeople(rows); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : 'Unable to load salespeople.'); })
      .finally(() => { if (active) setLoadingSalespeople(false); });
    return () => { active = false; };
  }, [submission.dealer_id]);

  useEffect(() => {
    // Only auto-sync insured→driver for personal/commercial auto and trucking (not commercial_gl)
    if (currentLob === 'commercial_gl') return;
    setDrivers((current) => {
      if (!current.length) return [emptyDriver()];
      const primary = current[0];
      const synced = {
        ...primary,
        position: 1,
        relationship: 'self',
        first_name: submission.insured_first_name,
        last_name: submission.insured_last_name,
        dob: submission.insured_dob || null,
      };
      if (
        primary.first_name === synced.first_name
        && primary.last_name === synced.last_name
        && primary.dob === synced.dob
        && primary.relationship === synced.relationship
        && primary.position === synced.position
      ) return current;
      return [synced, ...current.slice(1)];
    });
  }, [currentLob, submission.insured_dob, submission.insured_first_name, submission.insured_last_name]);

  const selectedDealer = dealers.find((dealer) => dealer.id === submission.dealer_id);
  const selectedSalesperson = salespeople.find((person) => person.id === submission.salesperson_id);

  const completeness = useMemo(() => {
    const required: unknown[] = [
      submission.insured_first_name,
      submission.insured_last_name,
      submission.insured_phone_primary,
    ];

    // LOB-specific required fields
    if (currentLob === 'non_owners') {
      required.push(submission.sr22_filing_state);
    } else if (currentLob === 'trucking') {
      required.push(submission.business_name, submission.dot_number);
    } else if (currentLob === 'commercial_gl') {
      required.push(submission.business_name, submission.insured_phone_primary);
    } else if (currentLob === 'homeowners') {
      required.push(submission.property_address_street);
    } else {
      // personal_auto / commercial_auto
      required.push(
        submission.insured_dob,
        submission.addr_street,
        submission.addr_city,
        submission.addr_state,
        submission.addr_zip,
        submission.desired_coverage,
      );
      if (isCommercial) {
        required.push(submission.business_name, submission.business_type, submission.dot_number || (submission.dot_not_applicable ? 'n/a' : ''));
      }
    }

    if (showDrivers && LOBS_REQUIRE_DRIVERS.includes(currentLob)) {
      required.push(...drivers.flatMap((driver) => [driver.first_name, driver.last_name, driver.dob, driver.license_number, driver.license_state]));
    }
    if (showVehicles && LOBS_REQUIRE_VEHICLES.includes(currentLob)) {
      required.push(...vehicles.flatMap((vehicle) => [vehicle.year, vehicle.make, vehicle.model, vehicle.vin || (vehicle.vin_pending ? 'pending' : '')]));
    }

    const completed = required.filter((value) => value !== null && value !== undefined && String(value).trim() !== '').length;
    return Math.round((completed / Math.max(1, required.length)) * 100);
  }, [currentLob, drivers, isCommercial, showDrivers, showVehicles, submission, vehicles]);

  function patch(values: Partial<DraftSubmission>) {
    setSubmission((current) => ({ ...current, ...values }));
  }

  function patchDriver(index: number, values: Partial<CsIntakeDriver>) {
    setDrivers((current) => current.map((driver, currentIndex) => currentIndex === index ? { ...driver, ...values } : driver));
  }

  function patchVehicle(index: number, values: Partial<CsIntakeVehicle>) {
    setVehicles((current) => current.map((vehicle, currentIndex) => currentIndex === index ? { ...vehicle, ...values } : vehicle));
  }

  function validate(): string | null {
    // Common: name + phone always required
    if (!submission.insured_first_name || !submission.insured_last_name) return 'Full name is required.';
    if (!submission.insured_phone_primary) return 'Primary phone is required.';

    // Non-owners: minimal validation
    if (currentLob === 'non_owners') {
      if (!submission.sr22_filing_state) return 'SR-22 filing state is required for Non-Owners.';
      return null;
    }

    // Trucking validation
    if (currentLob === 'trucking') {
      if (!submission.business_name?.trim()) return 'Business name is required for Trucking.';
      if (!submission.dot_number?.trim()) return 'DOT number is required for Trucking.';
    }

    // Commercial GL validation
    if (currentLob === 'commercial_gl') {
      if (!submission.business_name?.trim()) return 'Business name is required for Commercial GL.';
      if (!submission.insured_phone_primary?.trim()) return 'Owner phone is required for Commercial GL.';
    }

    // Commercial-routed LOBs require an assignee
    if (isCommercialRouted && !selectedAssignee) {
      return 'Select a commercial team member to assign this quote to.';
    }

    // Homeowners validation
    if (currentLob === 'homeowners') {
      if (!submission.property_address_street?.trim()) return 'Property address is required for Homeowners.';
    }

    // Personal auto / commercial auto standard validation
    if (currentLob === 'personal_auto' || currentLob === 'commercial_auto') {
      if (!submission.insured_dob) return 'Date of birth is required.';
      if (!submission.addr_street) return 'Street address is required.';
      if (!submission.addr_city) return 'City is required.';
      if (!submission.addr_state) return 'State is required.';
      if (!submission.addr_zip) return 'ZIP is required.';
      if (!submission.desired_coverage) return 'Coverage needed is required.';
      if (salespeople.length > 0 && !submission.salesperson_id) return `Choose the salesperson for ${selectedDealer?.name || 'this source'}.`;
      if (isCommercial) {
        if (!submission.business_name?.trim()) return 'Business name is required for Commercial Auto.';
        if (!submission.business_type?.trim()) return 'Type of work is required for Commercial Auto.';
        if (!submission.dot_not_applicable && !submission.dot_number?.trim()) return 'Enter the DOT number or mark DOT not applicable.';
      }
    }

    // Drivers validation (for LOBs that need them)
    if (showDrivers) {
      if (LOBS_REQUIRE_DRIVERS.includes(currentLob) && !drivers.length) return 'Add at least one person or driver.';
      for (const [index, driver] of drivers.entries()) {
        if (!driver.first_name || !driver.last_name || !driver.dob || !driver.license_number || !driver.license_state) {
          return `Complete the name, DOB, ${driver.document_type === 'state_id' ? 'ID' : driver.document_type === 'passport' ? 'passport' : 'license'} number and state for person ${index + 1}.`;
        }
      }
    }

    // Vehicles validation (for LOBs that need them)
    if (showVehicles) {
      if (LOBS_REQUIRE_VEHICLES.includes(currentLob) && !vehicles.length) return 'Add at least one vehicle.';
      for (const [index, vehicle] of vehicles.entries()) {
        if (!vehicle.year || !vehicle.make || !vehicle.model || (!vehicle.vin && !vehicle.vin_pending)) {
          return `Complete year, make, model and VIN (or VIN pending) for vehicle ${index + 1}.`;
        }
      }
    }

    return null;
  }

  async function persist(alsoSubmit: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (alsoSubmit) {
        const validationError = validate();
        if (validationError) throw new Error(validationError);
      }
      const requestedCoverage = {
        desired_coverage: submission.desired_coverage,
        liability_limit: submission.liability_limit || null,
        comprehensive_deductible: submission.comprehensive_deductible || null,
        collision_deductible: submission.collision_deductible || null,
      };
      const id = await saveDraft(
        profileId,
        {
          ...submission,
          line_of_business: submission.line_of_business,
          salesperson_id: salespeople.length ? submission.salesperson_id || null : null,
          requested_coverage: requestedCoverage,
        },
        drivers,
        vehicles,
      );
      patch({ id });
      if (alsoSubmit) {
        if (isCommercialRouted) {
          const cardId = await submitCommercialIntake(id, selectedAssignee || undefined);
          setNotice(`Intake submitted to the Commercial Board. Card created (${cardId.slice(0, 8)}…).`);
        } else {
          await submitIntake(id);
          setNotice('Intake submitted to the Sales Intake Queue. Agents were notified.');
        }
        window.setTimeout(onDone, 900);
      } else {
        setNotice('Draft saved.');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The intake could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  // LOB picker handler
  function handleLobSelect(lob: ExtendedLob) {
    patch({ line_of_business: lob as CsIntakeLob });
    setLobPicked(true);
  }

  // Helper data objects for LOB-specific sections
  const truckingData: TruckingData = {
    business_name: submission.business_name || '',
    business_type: submission.business_type || '',
    years_in_business: submission.years_in_business ?? null,
    dot_number: submission.dot_number || '',
    mc_number: submission.mc_number || '',
    mcs150_date: submission.mcs150_date || '',
    cargo_type: submission.cargo_type || '',
    power_unit_count: submission.power_unit_count ?? null,
    operating_radius_miles: submission.operating_radius_miles ?? null,
  };

  const commercialGlData: CommercialGlData = {
    business_name: submission.business_name || '',
    business_type: submission.business_type || '',
    ein: submission.ein || '',
    states_of_operation: submission.states_of_operation || '',
    employee_count: submission.employee_count ?? null,
    annual_payroll: submission.annual_payroll ?? null,
    years_in_business: submission.years_in_business ?? null,
    coverage_types_needed: submission.coverage_types_needed || [],
    owner_first_name: submission.insured_first_name || '',
    owner_middle_name: ((submission as Record<string, unknown>).insured_middle_name as string) || '',
    owner_last_name: ((submission as Record<string, unknown>).insured_last_name as string) || '',
    owner_dob: submission.insured_dob || '',
    owner_phone: submission.insured_phone_primary || '',
    owner_email: submission.insured_email || '',
  };

  const homeownersData: HomeownersData = {
    property_address_street: submission.property_address_street || '',
    property_address_city: submission.property_address_city || '',
    property_address_state: submission.property_address_state || '',
    property_address_zip: submission.property_address_zip || '',
    dwelling_type: submission.dwelling_type || '',
    year_built: submission.year_built ?? null,
    square_footage: submission.square_footage ?? null,
    roof_type: submission.roof_type || '',
    roof_age: submission.roof_age ?? null,
    coverage_amount: submission.coverage_amount ?? null,
    prior_claims: submission.prior_claims || false,
    prior_claims_detail: submission.prior_claims_detail || '',
  };

  const nonOwnersData: NonOwnersData = {
    sr22_filing_state: submission.sr22_filing_state || '',
    court_order_date: submission.court_order_date || '',
    desired_coverage: submission.desired_coverage || '',
    document_type: ((submission as Record<string, unknown>).no_document_type as string) || '',
    document_number: ((submission as Record<string, unknown>).no_document_number as string) || '',
    document_state: ((submission as Record<string, unknown>).no_document_state as string) || '',
    document_expiration: ((submission as Record<string, unknown>).no_document_expiration as string) || '',
  };

  // If LOB hasn't been picked yet, show the picker
  if (!lobPicked) {
    return (
      <div className="space-y-5">
        {error ? <div className={ui.error}>{error}</div> : null}
        <LobPicker
          selected={currentLob}
          onSelect={handleLobSelect}
          disabled={readOnly}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {submission.status === 'returned' && submission.return_reason ? (
        <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm font-bold text-violet-900">
          Returned by Sales: {submission.return_reason}
        </div>
      ) : null}
      {error ? <div className={ui.error}>{error}</div> : null}
      {notice ? <div className={ui.success}>{notice}</div> : null}

      {/* Header with LOB change option */}
      <section className="rounded-[26px] border border-[#c9d5e9] bg-gradient-to-br from-white to-[#eef3fb] p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">Quote Intake</p>
            <h2 className="mt-1 text-2xl font-black text-slate-950">
              {currentLob === 'personal_auto' && 'Personal Auto'}
              {currentLob === 'commercial_auto' && 'Commercial Auto'}
              {currentLob === 'trucking' && 'Trucking'}
              {currentLob === 'commercial_gl' && 'Commercial (GL, WC)'}
              {currentLob === 'homeowners' && 'Homeowners'}
              {currentLob === 'non_owners' && 'Non-Owners / SR-22'}
            </h2>
            <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-slate-600">
              {isCommercialRouted
                ? 'This intake will create a card on the Commercial Board.'
                : 'This intake will be sent to the Personal Sales Queue.'}
            </p>
            {!readOnly && !initial && (
              <button
                type="button"
                className="mt-2 text-xs font-black text-[#223f7a] hover:underline"
                onClick={() => setLobPicked(false)}
              >
                <RotateCcw className="mr-1 inline h-3 w-3" />
                Change coverage type
              </button>
            )}
          </div>
          <div className="min-w-36 rounded-2xl bg-white p-4 text-center ring-1 ring-[#c9d5e9]">
            <p className="text-3xl font-black text-[#223f7a]">{completeness}%</p>
            <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">Complete</p>
          </div>
        </div>
      </section>

      {/* Coverage and routing section — shown for personal_auto and commercial_auto */}
      {(currentLob === 'personal_auto' || currentLob === 'commercial_auto') && (
      <Section icon={<ShieldCheck className="h-5 w-5" />} title="Coverage and routing" subtitle="Tell Sales what kind of quote is needed and where the lead came from.">
        <div className={ui.fieldRow}>
          <Field label="Quote type" required>
            <select className={ui.select} disabled={disabled} value={submission.quote_kind || 'new_quote'} onChange={(event) => patch({ quote_kind: event.target.value as 'new_quote' | 'requote' })}>
              <option value="new_quote">New Quote</option>
              <option value="requote">Requote</option>
            </select>
          </Field>
          <Field label="Dealer / source">
            <select
              className={ui.select}
              disabled={disabled}
              value={submission.dealer_id || ''}
              onChange={(event) => patch({ dealer_id: event.target.value || null, salesperson_id: null })}
            >
              <option value="">Direct / No source</option>
              {dealers.map((dealer) => <option key={dealer.id} value={dealer.id}>{dealer.name}</option>)}
            </select>
          </Field>
          <Field
            label="Salesperson"
            required={salespeople.length > 0}
            hint={submission.dealer_id && !loadingSalespeople && !salespeople.length ? 'This dealer has no active salesperson. You may continue without one.' : undefined}
          >
            <select
              className={ui.select}
              disabled={disabled || !submission.dealer_id || loadingSalespeople || !salespeople.length}
              value={submission.salesperson_id || ''}
              onChange={(event) => patch({ salesperson_id: event.target.value || null })}
            >
              <option value="">{loadingSalespeople ? 'Loading…' : salespeople.length ? 'Select salesperson' : 'No salesperson required'}</option>
              {salespeople.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </Field>
          <Field label="Coverage needed" required>
            <select className={ui.select} disabled={disabled} value={submission.desired_coverage || ''} onChange={(event) => patch({ desired_coverage: event.target.value as DesiredCoverage })}>
              <option value="">Select coverage</option>
              <option value="liability_only">Liability Only</option>
              <option value="full_coverage">Full Coverage</option>
              <option value="unsure">Customer Unsure / Agent to Review</option>
            </select>
          </Field>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field label="Liability limit (optional)"><input className={ui.input} disabled={disabled} value={submission.liability_limit || ''} onChange={(event) => patch({ liability_limit: event.target.value || null })} placeholder="Example: 100/300/100" /></Field>
          <Field label="Comprehensive deductible"><input className={ui.input} disabled={disabled} value={submission.comprehensive_deductible || ''} onChange={(event) => patch({ comprehensive_deductible: event.target.value || null })} placeholder="Example: $500" /></Field>
          <Field label="Collision deductible"><input className={ui.input} disabled={disabled} value={submission.collision_deductible || ''} onChange={(event) => patch({ collision_deductible: event.target.value || null })} placeholder="Example: $1,000" /></Field>
        </div>
        {(selectedDealer || selectedSalesperson) ? <p className="mt-4 text-xs font-bold text-slate-500">Routing: {selectedDealer?.name || 'Direct'}{selectedSalesperson ? ` · ${selectedSalesperson.name}` : ''}</p> : null}
      </Section>
      )}

      {/* Priority and quote type for commercial-routed LOBs */}
      {isCommercialRouted && (
      <Section icon={<ShieldCheck className="h-5 w-5" />} title="Quote details" subtitle="Priority and quote type for this intake.">
        <div className={ui.fieldRow}>
          <Field label="Quote type" required>
            <select className={ui.select} disabled={disabled} value={submission.quote_kind || 'new_quote'} onChange={(event) => patch({ quote_kind: event.target.value as 'new_quote' | 'requote' })}>
              <option value="new_quote">New Quote</option>
              <option value="requote">Requote</option>
            </select>
          </Field>
          <Field label="Priority">
            <select className={ui.select} disabled={disabled} value={submission.priority} onChange={(event) => patch({ priority: event.target.value as CsIntakePriority })}>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </Field>
          <Field label="Assign to" required>
            <select className={ui.select} disabled={disabled} value={selectedAssignee} onChange={(e) => setSelectedAssignee(e.target.value)}>
              <option value="">— Select assignee —</option>
              {commercialAssignees.map((u) => (
                <option key={u.id} value={u.id}>{u.display_name}{u.role === 'super_admin' || u.role === 'commercial_supervisor' ? ' (Supervisor)' : ''}</option>
              ))}
            </select>
          </Field>
        </div>
      </Section>
      )}

      {/* Commercial Auto section (existing) */}
      {isCommercial ? (
        <Section icon={<Building2 className="h-5 w-5" />} title="Commercial operation" subtitle="Basic business information needed for a Commercial Auto submission.">
          <div className={ui.fieldRow}>
            <Field label="Business name" required><input className={ui.input} disabled={disabled} value={submission.business_name || ''} onChange={(event) => patch({ business_name: event.target.value || null })} /></Field>
            <Field label="DOT number" required={!submission.dot_not_applicable}><input className={ui.input} disabled={disabled || submission.dot_not_applicable} value={submission.dot_number || ''} onChange={(event) => patch({ dot_number: event.target.value || null })} placeholder="USDOT number" /></Field>
            <Field label="Type of work" required><input className={ui.input} disabled={disabled} value={submission.business_type || ''} onChange={(event) => patch({ business_type: event.target.value || null })} placeholder="Trucking, landscaping, contractor…" /></Field>
            <Field label="Years in business"><input type="number" min="0" className={ui.input} disabled={disabled} value={submission.years_in_business ?? ''} onChange={(event) => patch({ years_in_business: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
            <Field label="Operating radius (miles)"><input type="number" min="0" className={ui.input} disabled={disabled} value={submission.operating_radius_miles ?? ''} onChange={(event) => patch({ operating_radius_miles: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
          </div>
          <label className={`${ui.checkboxRow} mt-4`}>
            <input type="checkbox" disabled={disabled} checked={submission.dot_not_applicable || false} onChange={(event) => patch({ dot_not_applicable: event.target.checked, dot_number: event.target.checked ? null : submission.dot_number })} />
            DOT number is not applicable / not yet issued
          </label>
        </Section>
      ) : null}

      {/* Trucking section */}
      {currentLob === 'trucking' && (
        <TruckingSection
          data={truckingData}
          onChange={(truckPatch) => {
            const mapped: Partial<DraftSubmission> = {};
            if ('business_name' in truckPatch) mapped.business_name = truckPatch.business_name || null;
            if ('business_type' in truckPatch) mapped.business_type = truckPatch.business_type || null;
            if ('years_in_business' in truckPatch) mapped.years_in_business = truckPatch.years_in_business;
            if ('dot_number' in truckPatch) mapped.dot_number = truckPatch.dot_number || null;
            if ('mc_number' in truckPatch) (mapped as Record<string, unknown>).mc_number = truckPatch.mc_number || null;
            if ('mcs150_date' in truckPatch) (mapped as Record<string, unknown>).mcs150_date = truckPatch.mcs150_date || null;
            if ('cargo_type' in truckPatch) (mapped as Record<string, unknown>).cargo_type = truckPatch.cargo_type || null;
            if ('power_unit_count' in truckPatch) (mapped as Record<string, unknown>).power_unit_count = truckPatch.power_unit_count;
            if ('operating_radius_miles' in truckPatch) mapped.operating_radius_miles = truckPatch.operating_radius_miles;
            patch(mapped);
          }}
          disabled={disabled}
        />
      )}

      {/* Commercial GL section */}
      {currentLob === 'commercial_gl' && (
        <CommercialGlSection
          data={commercialGlData}
          onChange={(glPatch) => {
            const mapped: Partial<DraftSubmission> = {};
            if ('business_name' in glPatch) mapped.business_name = glPatch.business_name || null;
            if ('business_type' in glPatch) mapped.business_type = glPatch.business_type || null;
            if ('ein' in glPatch) (mapped as Record<string, unknown>).ein = glPatch.ein || null;
            if ('states_of_operation' in glPatch) (mapped as Record<string, unknown>).states_of_operation = glPatch.states_of_operation || null;
            if ('employee_count' in glPatch) (mapped as Record<string, unknown>).employee_count = glPatch.employee_count;
            if ('annual_payroll' in glPatch) (mapped as Record<string, unknown>).annual_payroll = glPatch.annual_payroll;
            if ('years_in_business' in glPatch) mapped.years_in_business = glPatch.years_in_business;
            if ('coverage_types_needed' in glPatch) (mapped as Record<string, unknown>).coverage_types_needed = glPatch.coverage_types_needed;
            // Owner info maps to insured fields directly
            if ('owner_first_name' in glPatch) mapped.insured_first_name = glPatch.owner_first_name || '';
            if ('owner_middle_name' in glPatch) (mapped as Record<string, unknown>).insured_middle_name = glPatch.owner_middle_name || '';
            if ('owner_last_name' in glPatch) (mapped as Record<string, unknown>).insured_last_name = glPatch.owner_last_name || '';
            if ('owner_dob' in glPatch) (mapped as Record<string, unknown>).insured_dob = glPatch.owner_dob || null;
            if ('owner_phone' in glPatch) (mapped as Record<string, unknown>).insured_phone_primary = glPatch.owner_phone || null;
            if ('owner_email' in glPatch) (mapped as Record<string, unknown>).insured_email = glPatch.owner_email || null;
            patch(mapped);
          }}
          disabled={disabled}
        />
      )}

      {/* Homeowners section */}
      {currentLob === 'homeowners' && (
        <HomeownersSection
          data={homeownersData}
          onChange={(hoPatch) => {
            const mapped: Record<string, unknown> = {};
            if ('property_address_street' in hoPatch) mapped.property_address_street = hoPatch.property_address_street || null;
            if ('property_address_city' in hoPatch) mapped.property_address_city = hoPatch.property_address_city || null;
            if ('property_address_state' in hoPatch) mapped.property_address_state = hoPatch.property_address_state || null;
            if ('property_address_zip' in hoPatch) mapped.property_address_zip = hoPatch.property_address_zip || null;
            if ('dwelling_type' in hoPatch) mapped.dwelling_type = hoPatch.dwelling_type || null;
            if ('year_built' in hoPatch) mapped.year_built = hoPatch.year_built;
            if ('square_footage' in hoPatch) mapped.square_footage = hoPatch.square_footage;
            if ('roof_type' in hoPatch) mapped.roof_type = hoPatch.roof_type || null;
            if ('roof_age' in hoPatch) mapped.roof_age = hoPatch.roof_age;
            if ('coverage_amount' in hoPatch) mapped.coverage_amount = hoPatch.coverage_amount;
            if ('prior_claims' in hoPatch) mapped.prior_claims = hoPatch.prior_claims;
            if ('prior_claims_detail' in hoPatch) mapped.prior_claims_detail = hoPatch.prior_claims_detail || null;
            patch(mapped as Partial<DraftSubmission>);
          }}
          disabled={disabled}
        />
      )}

      {/* Non-Owners section */}
      {currentLob === 'non_owners' && (
        <NonOwnersSection
          data={nonOwnersData}
          onChange={(noPatch) => {
            const mapped: Record<string, unknown> = {};
            if ('sr22_filing_state' in noPatch) mapped.sr22_filing_state = noPatch.sr22_filing_state || null;
            if ('court_order_date' in noPatch) mapped.court_order_date = noPatch.court_order_date || null;
            if ('desired_coverage' in noPatch) mapped.desired_coverage = noPatch.desired_coverage || null;
            if ('document_type' in noPatch) mapped.no_document_type = noPatch.document_type || null;
            if ('document_number' in noPatch) mapped.no_document_number = noPatch.document_number || null;
            if ('document_state' in noPatch) mapped.no_document_state = noPatch.document_state || null;
            if ('document_expiration' in noPatch) mapped.no_document_expiration = noPatch.document_expiration || null;
            patch(mapped as Partial<DraftSubmission>);
          }}
          disabled={disabled}
        />
      )}

      <Section icon={<UserRound className="h-5 w-5" />} title={isCommercial ? 'Primary contact' : 'Named insured'} subtitle="The person Customer Service is speaking with and the garaging/mailing address.">
        <div className={ui.fieldRow}>
          <Field label="First name" required><input className={ui.input} disabled={disabled} value={submission.insured_first_name} onChange={(event) => patch({ insured_first_name: event.target.value })} /></Field>
          <Field label="Middle name"><input className={ui.input} disabled={disabled} value={(submission as Record<string, unknown>).insured_middle_name as string || ''} onChange={(event) => patch({ insured_middle_name: event.target.value || null } as Partial<DraftSubmission>)} /></Field>
          <Field label="Last name" required><input className={ui.input} disabled={disabled} value={submission.insured_last_name} onChange={(event) => patch({ insured_last_name: event.target.value })} /></Field>
          <Field label="Date of birth" required><DatePicker value={submission.insured_dob || ''} onChange={(value) => patch({ insured_dob: value || null })} disabled={disabled} placeholder="Date of birth" /></Field>
          <Field label="Primary phone" required><input type="tel" className={ui.input} disabled={disabled} value={submission.insured_phone_primary || ''} onChange={(event) => patch({ insured_phone_primary: event.target.value || null })} /></Field>
          <Field label="Alternate phone"><input type="tel" className={ui.input} disabled={disabled} value={submission.insured_phone_alt || ''} onChange={(event) => patch({ insured_phone_alt: event.target.value || null })} /></Field>
          <Field label="Email"><input type="email" className={ui.input} disabled={disabled} value={submission.insured_email || ''} onChange={(event) => patch({ insured_email: event.target.value || null })} /></Field>
          <Field label="Preferred language"><select className={ui.select} disabled={disabled} value={submission.preferred_language || ''} onChange={(event) => patch({ preferred_language: event.target.value || null })}><option value="">Not specified</option><option value="English">English</option><option value="Spanish">Spanish</option><option value="Other">Other</option></select></Field>
          <Field label="Preferred contact"><select className={ui.select} disabled={disabled} value={submission.preferred_contact || ''} onChange={(event) => patch({ preferred_contact: event.target.value || null })}><option value="">Not specified</option><option value="Call">Call</option><option value="SMS">SMS</option><option value="WhatsApp">WhatsApp</option><option value="Email">Email</option></select></Field>
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2"><Field label="Street address" required><AddressAutocomplete defaultValue={submission.addr_street || ''} disabled={disabled} onChange={(val) => patch({ addr_street: val || null })} onAddressSelected={({ street, unit, city, state, zip }) => patch({ addr_street: street || null, addr_unit: unit, addr_city: city || null, addr_state: state || null, addr_zip: zip || null })} /></Field></div>
          <Field label="Unit / Apt"><input className={ui.input} disabled={disabled} value={submission.addr_unit || ''} onChange={(event) => patch({ addr_unit: event.target.value || null })} /></Field>
          <Field label="City" required><input className={ui.input} disabled={disabled} value={submission.addr_city || ''} onChange={(event) => patch({ addr_city: event.target.value || null })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="State" required><select className={ui.select} disabled={disabled} value={submission.addr_state || ''} onChange={(event) => patch({ addr_state: event.target.value || null })}><option value="">—</option>{US_STATES.map((state) => <option key={state}>{state}</option>)}</select></Field>
            <Field label="ZIP" required><input className={ui.input} disabled={disabled} value={submission.addr_zip || ''} onChange={(event) => {
              const zip = event.target.value || null;
              patch({ addr_zip: zip });
              // Auto-fill city and state from ZIP using Zippopotam API
              if (zip && zip.length === 5 && /^\d{5}$/.test(zip)) {
                fetch(`https://api.zippopotam.us/us/${zip}`)
                  .then(r => r.ok ? r.json() : null)
                  .then(data => {
                    if (data?.places?.[0]) {
                      const place = data.places[0];
                      patch({
                        addr_city: place['place name'] || submission.addr_city,
                        addr_state: place['state abbreviation'] || submission.addr_state,
                      });
                    }
                  })
                  .catch(() => {});
              }
            }} /></Field>
          </div>
        </div>
      </Section>

      {showDrivers && (
      <Section icon={<UsersRound className="h-5 w-5" />} title={`People / drivers (${drivers.length})`} subtitle="Add the primary insured and every additional person who may drive or needs to be listed.">
        <div className="space-y-4">
          {drivers.map((driver, index) => (
            <div key={driver.id || `driver-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="font-black text-slate-900">Person {index + 1}{index === 0 ? ' · Primary' : ''}</p>
                {!readOnly && index > 0 ? <button type="button" className={ui.btnDanger} onClick={() => setDrivers((current) => current.filter((_, currentIndex) => currentIndex !== index).map((row, currentIndex) => ({ ...row, position: currentIndex + 1 })))}><Trash2 className="h-4 w-4" /> Remove</button> : null}
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {index === 0 ? (
                  <div className="rounded-xl border border-[#c9d5e9] bg-white p-3 sm:col-span-2 lg:col-span-4">
                    <p className="text-xs font-black uppercase tracking-wider text-[#526b9a]">Primary insured</p>
                    <p className="mt-1 font-black text-slate-900">{submission.insured_first_name || 'First name'} {submission.insured_last_name || 'Last name'}{submission.insured_dob ? ` · DOB ${submission.insured_dob}` : ''}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">Name and DOB are taken from the Named Insured section above, so Customer Service does not enter them twice.</p>
                  </div>
                ) : (
                  <>
                    <Field label="First name" required><input className={ui.input} disabled={disabled} value={driver.first_name} onChange={(event) => patchDriver(index, { first_name: event.target.value })} /></Field>
                    <Field label="Last name" required><input className={ui.input} disabled={disabled} value={driver.last_name} onChange={(event) => patchDriver(index, { last_name: event.target.value })} /></Field>
                    <Field label="Date of birth" required><DatePicker value={driver.dob || ''} onChange={(value) => patchDriver(index, { dob: value || null })} disabled={disabled} placeholder="Date of birth" /></Field>
                    <Field label="Relationship"><select className={ui.select} disabled={disabled} value={driver.relationship || 'other'} onChange={(event) => patchDriver(index, { relationship: event.target.value })}><option value="spouse">Spouse</option><option value="child">Child</option><option value="employee">Employee</option><option value="other">Other</option></select></Field>
                  </>
                )}
                <Field label="Document type" required><select className={ui.select} disabled={disabled} value={driver.document_type || 'driver_license'} onChange={(event) => { const docType = event.target.value as 'driver_license' | 'state_id' | 'passport'; patchDriver(index, { document_type: docType, ...(docType === 'passport' ? { license_state: 'Foreign' } : {}) }); }}><option value="driver_license">Driver License</option><option value="state_id">State ID</option><option value="passport">Passport</option></select></Field>
                <Field label={driver.document_type === 'state_id' ? 'ID number' : driver.document_type === 'passport' ? 'Passport number' : 'License number'} required><input className={ui.input} disabled={disabled} value={driver.license_number || ''} onChange={(event) => patchDriver(index, { license_number: event.target.value || null })} /></Field>
                <Field label="Issuing state" required><select className={ui.select} disabled={disabled || driver.document_type === 'passport'} value={driver.license_state || ''} onChange={(event) => patchDriver(index, { license_state: event.target.value || null })}><option value="">Select</option>{US_STATES.map((state) => <option key={state}>{state}</option>)}<option value="Foreign">Foreign</option></select></Field>
                <Field label="License status"><select className={ui.select} disabled={disabled} value={driver.license_status || 'valid'} onChange={(event) => patchDriver(index, { license_status: event.target.value })}><option value="valid">Valid</option><option value="permit">Permit</option><option value="foreign">Foreign</option><option value="suspended">Suspended</option><option value="not_licensed">Not licensed / ID only</option></select></Field>
                <Field label="Years licensed"><input type="number" min="0" className={ui.input} disabled={disabled} value={driver.years_licensed ?? ''} onChange={(event) => patchDriver(index, { years_licensed: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
              </div>
              <label className={`${ui.checkboxRow} mt-4`}><input type="checkbox" disabled={disabled} checked={driver.sr22_required} onChange={(event) => patchDriver(index, { sr22_required: event.target.checked })} /> SR-22 required</label>
            </div>
          ))}
        </div>
        {!readOnly ? <button type="button" className={`${ui.btnSecondary} mt-4`} onClick={() => setDrivers((current) => [...current, emptyDriver(current.length + 1)])}><Plus className="h-4 w-4" /> Add another person</button> : null}
      </Section>
      )}

      {showVehicles && (
      <Section icon={<Car className="h-5 w-5" />} title={`Vehicles (${vehicles.length})`} subtitle="Add every vehicle the customer wants quoted. Enter the VIN to auto-fill year, make, and model.">
        <div className="space-y-4">
          {vehicles.map((vehicle, index) => (
            <div key={vehicle.id || `vehicle-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="font-black text-slate-900">Vehicle {index + 1}</p>
                {!readOnly && vehicles.length > 1 ? <button type="button" className={ui.btnDanger} onClick={() => setVehicles((current) => current.filter((_, currentIndex) => currentIndex !== index).map((row, currentIndex) => ({ ...row, position: currentIndex + 1 })))}><Trash2 className="h-4 w-4" /> Remove</button> : null}
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {/* VIN first with decoder */}
                <div className="sm:col-span-2">
                  <VinDecoder
                    vin={vehicle.vin || ''}
                    disabled={disabled || vehicle.vin_pending}
                    onVinChange={(vin) => patchVehicle(index, { vin: vin || null })}
                    onDecoded={({ year, make, model }) => patchVehicle(index, { year, make, model })}
                  />
                </div>
                <label className={`${ui.checkboxRow} self-end`}><input type="checkbox" disabled={disabled} checked={vehicle.vin_pending} onChange={(event) => patchVehicle(index, { vin_pending: event.target.checked, vin: event.target.checked ? null : vehicle.vin })} /> VIN pending</label>
                <div />
                <Field label="Year" required><input type="number" min="1900" max="2100" className={ui.input} disabled={disabled} value={vehicle.year ?? ''} onChange={(event) => patchVehicle(index, { year: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
                <Field label="Make" required><input className={ui.input} disabled={disabled} value={vehicle.make || ''} onChange={(event) => patchVehicle(index, { make: event.target.value || null })} /></Field>
                <Field label="Model" required><input className={ui.input} disabled={disabled} value={vehicle.model || ''} onChange={(event) => patchVehicle(index, { model: event.target.value || null })} /></Field>
                <Field label="Ownership"><select className={ui.select} disabled={disabled} value={vehicle.ownership || 'owned'} onChange={(event) => patchVehicle(index, { ownership: event.target.value })}><option value="owned">Owned</option><option value="financed">Financed</option><option value="leased">Leased</option></select></Field>
                <Field label="Lienholder"><input className={ui.input} disabled={disabled} value={vehicle.lienholder || ''} onChange={(event) => patchVehicle(index, { lienholder: event.target.value || null })} /></Field>
                <Field label="Use"><select className={ui.select} disabled={disabled} value={vehicle.usage || 'commute'} onChange={(event) => patchVehicle(index, { usage: event.target.value })}><option value="commute">Commute</option><option value="pleasure">Pleasure</option><option value="business">Business</option><option value="delivery">Delivery</option><option value="rideshare">Rideshare</option></select></Field>
                <Field label="Annual mileage"><input type="number" min="0" className={ui.input} disabled={disabled} value={vehicle.annual_mileage ?? ''} onChange={(event) => patchVehicle(index, { annual_mileage: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
                <Field label="Garaging ZIP"><input className={ui.input} disabled={disabled} value={vehicle.garaging_zip || submission.addr_zip || ''} onChange={(event) => patchVehicle(index, { garaging_zip: event.target.value || null })} /></Field>
              </div>
            </div>
          ))}
        </div>
        {!readOnly ? <button type="button" className={`${ui.btnSecondary} mt-4`} onClick={() => setVehicles((current) => [...current, emptyVehicle(current.length + 1)])}><Plus className="h-4 w-4" /> Add another vehicle</button> : null}
      </Section>
      )}

      {currentLob !== 'non_owners' && (
      <Section icon={<FileText className="h-5 w-5" />} title="Current policy and notes" subtitle="Optional information that helps Sales compare or prepare a requote.">
        <div className={ui.fieldRow}>
          <Field label="Current carrier"><input className={ui.input} disabled={disabled} value={submission.current_carrier || ''} onChange={(event) => patch({ current_carrier: event.target.value || null })} /></Field>
          <Field label="Current policy number"><input className={ui.input} disabled={disabled} value={submission.current_policy_number || ''} onChange={(event) => patch({ current_policy_number: event.target.value || null })} /></Field>
          <Field label="Current premium"><input type="number" min="0" step="0.01" className={ui.input} disabled={disabled} value={submission.current_premium ?? ''} onChange={(event) => patch({ current_premium: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
          <Field label="Expiration date"><DatePicker value={submission.current_expiration || ''} onChange={(value) => patch({ current_expiration: value || null })} disabled={disabled} placeholder="Expiration date" /></Field>
          <Field label="Continuous coverage (months)"><input type="number" min="0" className={ui.input} disabled={disabled} value={submission.months_continuous_coverage ?? ''} onChange={(event) => patch({ months_continuous_coverage: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-5">
          <label className={ui.checkboxRow}><input type="checkbox" disabled={disabled} checked={submission.prior_insurance === true} onChange={(event) => patch({ prior_insurance: event.target.checked })} /> Has prior insurance</label>
          <label className={ui.checkboxRow}><input type="checkbox" disabled={disabled} checked={submission.prior_lapse === true} onChange={(event) => patch({ prior_lapse: event.target.checked })} /> Has a lapse in coverage</label>
        </div>
        <div className="mt-4"><Field label="Notes for Sales"><textarea rows={4} className={ui.textarea} disabled={disabled} value={submission.csr_notes || ''} onChange={(event) => patch({ csr_notes: event.target.value || null })} placeholder="Anything important that is not already captured above." /></Field></div>
      </Section>
      )}

      {currentLob === 'non_owners' && (
      <Section icon={<FileText className="h-5 w-5" />} title="Notes" subtitle="Any additional information for the quote.">
        <Field label="Notes for Sales"><textarea rows={4} className={ui.textarea} disabled={disabled} value={submission.csr_notes || ''} onChange={(event) => patch({ csr_notes: event.target.value || null })} placeholder="Anything important that is not already captured above." /></Field>
      </Section>
      )}

      {!readOnly ? (
        <div className="sticky bottom-4 z-20 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-xl backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 text-sm font-semibold text-slate-500"><CheckCircle2 className="h-5 w-5 text-emerald-500" /> Drafts can be reopened. Submission sends the intake to {isCommercialRouted ? 'the Commercial Board' : 'Sales'}.</div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={ui.btnGhost} disabled={busy} onClick={onDone}>Close</button>
            <button type="button" className={ui.btnSecondary} disabled={busy} onClick={() => void persist(false)}><Save className="h-4 w-4" /> Save Draft</button>
            <button type="button" className={ui.btnPrimary} disabled={busy} onClick={() => void persist(true)}><Send className="h-4 w-4" /> {isCommercialRouted ? 'Submit to Commercial' : 'Submit to Sales'}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

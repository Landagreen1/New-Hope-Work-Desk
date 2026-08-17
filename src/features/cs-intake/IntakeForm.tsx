'use client';

import {
  Building2,
  Car,
  CheckCircle2,
  FileText,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import DuplicateWarning from '../quote-center/DuplicateWarning';
import type { DuplicateCandidate } from '../quote-center/types';
import VinDecoder from './VinDecoder';
import VerifiedAddressField from '../nhwd-shared/VerifiedAddressField';
import {
  deriveFromCustomerAddress,
  type VerifiedAddressValue,
} from '../nhwd-shared/verified-address';
import {
  type CsIntakeDriver,
  type CsIntakeLob,
  type CsIntakeOwner,
  type CsIntakePriority,
  type CsIntakeSubmission,
  type CsIntakeVehicle,
  type Dealer,
  type DealerSalesperson,
  type DesiredCoverage,
  DraftConflictError,
  getIntake,
  listDealers,
  listSalespeople,
  listCommercialAssignees,
  saveDraft,
  submitIntake,
  submitCommercialIntake,
  submitSpecialtyIntake,
  isSpecialtyLob,
} from './api';
import DatePicker from '../nhwd-shared/DatePicker';
import LobPicker, { type ExtendedLob, isCommercialRoute } from './LobPicker';
import NonOwnersSection, { type NonOwnersData } from './NonOwnersSection';
import TruckingSection, { type TruckingData } from './TruckingSection';
import CommercialGlSection, { type CommercialGlData, emptyOwner } from './CommercialGlSection';
import HomeownersSection, { type HomeownersData } from './HomeownersSection';
import OtherPersonalSection, { type OtherPersonalData } from './OtherPersonalSection';

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
const LOBS_WITH_DRIVERS: ExtendedLob[] = ['personal_auto', 'commercial_auto', 'trucking'];
const LOBS_WITH_VEHICLES: ExtendedLob[] = ['personal_auto', 'commercial_auto', 'trucking'];

/** LOBs where at least 1 driver and 1 vehicle are required */
const LOBS_REQUIRE_DRIVERS: ExtendedLob[] = ['personal_auto', 'commercial_auto', 'trucking'];
const LOBS_REQUIRE_VEHICLES: ExtendedLob[] = ['personal_auto', 'commercial_auto', 'trucking'];

interface Props {
  profileId: string;
  initial?: {
    submission: CsIntakeSubmission;
    drivers: CsIntakeDriver[];
    vehicles: CsIntakeVehicle[];
    owners?: CsIntakeOwner[];
  };
  readOnly?: boolean;
  onDone: () => void;
  /**
   * Opens an existing customer record found by the duplicate check, so the
   * employee continues that history instead of starting a second one. When
   * omitted the duplicate panel is informational only.
   */
  onOpenExisting?: (candidate: DuplicateCandidate) => void;
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

export default function IntakeForm({
  profileId,
  initial,
  readOnly = false,
  onDone,
  onOpenExisting,
}: Props) {
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
  const [owners, setOwners] = useState<CsIntakeOwner[]>(
    initial?.owners?.length ? initial.owners : [emptyOwner()],
  );
  const [dealers, setDealers] = useState<Dealer[]>([]);
  const [salespeople, setSalespeople] = useState<DealerSalesperson[]>([]);
  const [loadingSalespeople, setLoadingSalespeople] = useState(false);
  const [commercialAssignees, setCommercialAssignees] = useState<{ id: string; display_name: string; role: string }[]>([]);
  const [selectedAssignee, setSelectedAssignee] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Set when a save was refused because another employee saved first. */
  const [conflict, setConflict] = useState<string | null>(null);

  const isCommercial = submission.line_of_business === 'commercial_auto';
  const currentLob = submission.line_of_business as ExtendedLob;
  const showDrivers = LOBS_WITH_DRIVERS.includes(currentLob);
  const showVehicles = LOBS_WITH_VEHICLES.includes(currentLob);
  const isCommercialRouted = isCommercialRoute(currentLob);
  /**
   * Trucking and Homeowners are still "commercial-routed" in the sense that they leave
   * the personal sales queue, but their destination is now Specialty Quotes rather than
   * the Commercial Board. Kept as a separate predicate so the copy, the assignee
   * requirement and the submit call each stay honest about where the intake is going.
   */
  const isSpecialtyRouted = isSpecialtyLob(currentLob);
  const isFromRenewal = Boolean(submission.source_renewal_id);
  const disabled = readOnly || busy;

  /**
   * Whether to run the duplicate check at all.
   *
   * Only while the intake is still being written — once it is submitted the
   * decision has been made and a warning would be noise. And only once at least
   * one real identity signal exists, because asking on a half-typed name would
   * warn on nearly everyone.
   */
  const identityPhoneDigits = (submission.insured_phone_primary ?? '').replace(/\D/g, '');
  const hasIdentitySignal =
    identityPhoneDigits.length >= 10 ||
    Boolean(submission.insured_email?.trim()) ||
    Boolean(submission.business_name?.trim()) ||
    Boolean(submission.insured_dob) ||
    (Boolean(submission.insured_first_name?.trim()) && Boolean(submission.insured_last_name?.trim()));
  const showDuplicateCheck =
    hasIdentitySignal &&
    !isFromRenewal &&
    (!submission.status || submission.status === 'draft' || submission.status === 'returned');

  useEffect(() => {
    listDealers().then(setDealers).catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load sources.'));
  }, []);

  useEffect(() => {
    // Only Commercial GL needs an assignee list. A specialty intake is claimed by the
    // team, so there is nobody for Customer Service to choose.
    if (isCommercialRouted && !isSpecialtyRouted) {
      listCommercialAssignees().then(setCommercialAssignees).catch(() => {});
    }
  }, [isCommercialRouted, isSpecialtyRouted]);

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

    // Commercial GL still needs an assignee, because a commercial card is created for
    // one person. Trucking and Homeowners deliberately do not: they route to a quoting
    // team and stay unclaimed until an eligible member takes them, so Customer Service
    // is never asked to pick between Oscar, Jason and Brenda.
    if (isCommercialRouted && !isSpecialtyRouted && !selectedAssignee) {
      return 'Select a commercial team member to assign this quote to.';
    }

    // Homeowners validation
    if (currentLob === 'homeowners') {
      if (!submission.property_address_street?.trim()) return 'Property address is required for Homeowners.';
    }

    // Motorcycle validation
    if (currentLob === 'motorcycle') {
      const s = submission as Record<string, unknown>;
      if (!s.moto_year || !String(s.moto_year).trim()) return 'Motorcycle year is required.';
      if (!s.moto_make || !String(s.moto_make).trim()) return 'Motorcycle make is required.';
      if (!s.moto_model || !String(s.moto_model).trim()) return 'Motorcycle model is required.';
    }

    // Boat validation
    if (currentLob === 'boat') {
      const s = submission as Record<string, unknown>;
      if (!s.boat_year || !String(s.boat_year).trim()) return 'Boat year is required.';
      if (!s.boat_make || !String(s.boat_make).trim()) return 'Boat make is required.';
      if (!s.boat_model || !String(s.boat_model).trim()) return 'Boat model is required.';
      if (!s.boat_type || !String(s.boat_type).trim()) return 'Watercraft type is required.';
    }

    // Trailer validation
    if (currentLob === 'trailer') {
      const s = submission as Record<string, unknown>;
      if (!s.trailer_year || !String(s.trailer_year).trim()) return 'Trailer year is required.';
      if (!s.trailer_make || !String(s.trailer_make).trim()) return 'Trailer make is required.';
      if (!s.trailer_model || !String(s.trailer_model).trim()) return 'Trailer model is required.';
      if (!s.trailer_type || !String(s.trailer_type).trim()) return 'Trailer type is required.';
    }

    // Renters validation. The rental property is the insured risk, so its address
    // has to be a place Google actually returned. cs_intake_submit enforces the
    // same rule server-side; this check only produces the better message.
    if (currentLob === 'renters') {
      const s = submission as Record<string, unknown>;
      if (!s.renters_property_address || !String(s.renters_property_address).trim()) return 'Rental property address is required.';
      if (!s.renters_city || !String(s.renters_city).trim()) return 'City is required for renters.';
      if (!s.renters_state || !String(s.renters_state).trim()) return 'State is required for renters.';
      if (!s.renters_zip || !String(s.renters_zip).trim()) return 'ZIP is required for renters.';
      if (!s.renters_addr_verified) {
        return s.renters_same_as_customer
          ? 'Verify the customer address by choosing it from the address suggestions. The rental property inherits that verification.'
          : 'Choose the rental property address from the address suggestions so it can be verified.';
      }
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
      const saved = await saveDraft(
        profileId,
        {
          ...submission,
          line_of_business: submission.line_of_business,
          salesperson_id: salespeople.length ? submission.salesperson_id || null : null,
          requested_coverage: requestedCoverage,
        },
        drivers,
        vehicles,
        owners,
        submission.version ?? null,
      );
      const id = saved.id;
      // The stored version has moved on, so hold the new one: otherwise the very
      // next save from this editor would look stale to the concurrency check.
      patch({ id, version: saved.version } as Partial<DraftSubmission>);
      if (alsoSubmit) {
        if (isSpecialtyRouted) {
          // Trucking and Homeowners go to the specialty team that owns the line, not to
          // the Commercial Board and not to a named person.
          await submitSpecialtyIntake(id);
          setNotice(
            'Intake submitted to the specialty quoting team. Every eligible member was notified and one of them will claim it.',
          );
        } else if (isCommercialRouted) {
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
      if (caught instanceof DraftConflictError) {
        // Another employee saved while this editor was open. Refusing the write
        // and asking for a reload is the whole point — their information must not
        // be silently replaced by this older copy.
        setConflict(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : 'The intake could not be saved.');
      }
    } finally {
      setBusy(false);
    }
  }

  /** Reloads the stored intake, discarding this editor's unsaved copy. */
  async function reloadAfterConflict() {
    if (!submission.id) return;
    setBusy(true);
    try {
      const fresh = await getIntake(submission.id);
      if (!fresh) throw new Error('The intake could not be reloaded.');
      setSubmission({ ...(fresh.submission as unknown as DraftSubmission) });
      setDrivers(fresh.drivers);
      setVehicles(fresh.vehicles);
      setOwners(fresh.owners ?? []);
      setConflict(null);
      setNotice('Reloaded the latest saved information.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The intake could not be reloaded.');
    } finally {
      setBusy(false);
    }
  }

  // LOB picker handler
  function handleLobSelect(lob: ExtendedLob) {
    patch({ line_of_business: lob as CsIntakeLob });
    if (lob === 'non_owners') {
      patch({ desired_coverage: 'liability_only' } as Partial<DraftSubmission>);
    }
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
    liability_limit: ((submission as Record<string, unknown>).liability_limit as string) || '',
    document_type: ((submission as Record<string, unknown>).no_document_type as string) || '',
    document_number: ((submission as Record<string, unknown>).no_document_number as string) || '',
    document_state: ((submission as Record<string, unknown>).no_document_state as string) || '',
    document_expiration: ((submission as Record<string, unknown>).no_document_expiration as string) || '',
  };

  const sub = submission as Record<string, unknown>;
  const otherPersonalData: OtherPersonalData = {
    moto_year: (sub.moto_year as string) || '',
    moto_make: (sub.moto_make as string) || '',
    moto_model: (sub.moto_model as string) || '',
    moto_vin: (sub.moto_vin as string) || '',
    moto_cc: (sub.moto_cc as string) || '',
    moto_type: (sub.moto_type as string) || '',
    boat_year: (sub.boat_year as string) || '',
    boat_make: (sub.boat_make as string) || '',
    boat_model: (sub.boat_model as string) || '',
    boat_hin: (sub.boat_hin as string) || '',
    boat_length: (sub.boat_length as string) || '',
    boat_type: (sub.boat_type as string) || '',
    boat_hp: (sub.boat_hp as string) || '',
    boat_value: (sub.boat_value as string) || '',
    boat_trailer_included: (sub.boat_trailer_included as boolean) || false,
    trailer_year: (sub.trailer_year as string) || '',
    trailer_make: (sub.trailer_make as string) || '',
    trailer_model: (sub.trailer_model as string) || '',
    trailer_vin: (sub.trailer_vin as string) || '',
    trailer_length: (sub.trailer_length as string) || '',
    trailer_type: (sub.trailer_type as string) || '',
    trailer_value: (sub.trailer_value as string) || '',
    trailer_park_name: (sub.trailer_park_name as string) || '',
    trailer_lot_number: (sub.trailer_lot_number as string) || '',
    renters_property_address: (sub.renters_property_address as string) || '',
    renters_city: (sub.renters_city as string) || '',
    renters_state: (sub.renters_state as string) || '',
    renters_zip: (sub.renters_zip as string) || '',
    renters_unit: (sub.renters_unit as string) || '',
    renters_landlord_name: (sub.renters_landlord_name as string) || '',
    renters_personal_property_value: (sub.renters_personal_property_value as string) || '',
    renters_liability_limit: (sub.renters_liability_limit as string) || '',
    renters_move_in_date: (sub.renters_move_in_date as string) || '',
    renters_place_id: (sub.renters_place_id as string) || null,
    renters_formatted: (sub.renters_formatted as string) || null,
    renters_addr_verified: Boolean(sub.renters_addr_verified),
    renters_same_as_customer: Boolean(sub.renters_same_as_customer),
  };

  // ── Address adapters ───────────────────────────────────────────────────────
  // The submission is a flat row of columns; VerifiedAddressField works with a
  // single address object. These two functions are the only place that mapping
  // lives, for either address.
  const customerAddress: VerifiedAddressValue = {
    street: submission.addr_street || '',
    unit: submission.addr_unit || '',
    city: submission.addr_city || '',
    state: submission.addr_state || '',
    zip: submission.addr_zip || '',
    placeId: (sub.addr_place_id as string) || null,
    formatted: (sub.addr_formatted as string) || null,
    verified: Boolean(sub.addr_verified),
  };

  function applyCustomerAddress(next: VerifiedAddressValue) {
    const changes: Record<string, unknown> = {
      addr_street: next.street || null,
      addr_unit: next.unit || null,
      addr_city: next.city || null,
      addr_state: next.state || null,
      addr_zip: next.zip || null,
      addr_place_id: next.placeId,
      addr_formatted: next.formatted,
      addr_verified: next.verified,
    };

    // A rental address marked "same as customer" tracks the customer address,
    // including its verification. Letting the two drift would leave a Renters
    // intake claiming a verified rental address that no longer matches anything.
    if (Boolean(sub.renters_same_as_customer)) {
      const derived = deriveFromCustomerAddress(next);
      Object.assign(changes, {
        renters_property_address: derived.street || null,
        renters_unit: derived.unit || null,
        renters_city: derived.city || null,
        renters_state: derived.state || null,
        renters_zip: derived.zip || null,
        renters_place_id: derived.placeId,
        renters_formatted: derived.formatted,
        renters_addr_verified: derived.verified,
      });
    }

    patch(changes as Partial<DraftSubmission>);
  }

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
      {isFromRenewal && (
        <div className="rounded-2xl border border-cyan-200 bg-cyan-50 p-4 text-sm font-bold text-cyan-900">
          Renewal Requote — This intake was created from a renewal and is locked as a requote. Complete the missing information and submit.
        </div>
      )}
      {submission.status === 'returned' && submission.return_reason ? (
        <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm font-bold text-violet-900">
          Returned by Sales: {submission.return_reason}
        </div>
      ) : null}
      {error ? <div className={ui.error}>{error}</div> : null}
      {notice ? <div className={ui.success}>{notice}</div> : null}

      {/*
        A shared draft can be open in two places at once. When the stored version
        has moved on, the save is refused rather than applied, and the employee is
        told plainly and offered the newer information.
      */}
      {conflict ? (
        <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 px-4 py-4">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
            <div className="flex-1">
              <p className="text-sm font-black text-amber-950">{conflict}</p>
              <p className="mt-1 text-xs font-semibold text-amber-800">
                Nothing was overwritten. Reload to see what your teammate added, then
                re-enter anything of yours that is still missing.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={ui.btnPrimary}
                  disabled={busy}
                  onClick={() => void reloadAfterConflict()}
                >
                  <RefreshCw className="h-4 w-4" /> Reload latest information
                </button>
                <button type="button" className={ui.btnGhost} onClick={() => setConflict(null)}>
                  Keep editing my copy
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/*
        Possible existing records, checked in the background as identity details
        are entered. Never blocks: it prevents the accidental duplicate while
        leaving the legitimate second quote alone.
      */}
      {!readOnly && showDuplicateCheck ? (
        <DuplicateWarning
          input={{
            excludeIntakeId: submission.id ?? null,
            phone: submission.insured_phone_primary ?? null,
            email: submission.insured_email ?? null,
            firstName: submission.insured_first_name ?? null,
            lastName: submission.insured_last_name ?? null,
            businessName: submission.business_name ?? null,
            dob: submission.insured_dob ?? null,
          }}
          onOpenExisting={onOpenExisting}
        />
      ) : null}

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
              {currentLob === 'motorcycle' && 'Motorcycle / ATV'}
              {currentLob === 'boat' && 'Boat / Watercraft'}
              {currentLob === 'trailer' && 'Home / Trailer'}
              {currentLob === 'renters' && 'Renters Insurance'}
            </h2>
            <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-slate-600">
              {isSpecialtyRouted
                ? 'This intake goes to the specialty quoting team for this line. You do not choose who works it — every eligible member is notified and one of them claims it.'
                : isCommercialRouted
                  ? 'This intake will create a card on the Commercial Board.'
                  : 'This intake will be sent to the Personal Sales Queue.'}
            </p>
            {!readOnly && !initial && !isFromRenewal && (
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

      {/* Walk-in office flag */}
      <label className={`${ui.checkboxRow} rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4`}>
        <input type="checkbox" disabled={disabled} checked={submission.is_walk_in ?? false} onChange={(event) => patch({ is_walk_in: event.target.checked } as Partial<DraftSubmission>)} />
        <span className="text-sm font-black text-amber-900">Walk-in (Office)</span>
        <span className="ml-2 text-xs font-semibold text-amber-700">— Customer is physically present. US team priority.</span>
      </label>

      {/* Coverage and routing section — shown for personal-route LOBs (not commercial-routed, not non_owners which has its own) */}
      {(currentLob === 'personal_auto' || currentLob === 'commercial_auto' || currentLob === 'motorcycle' || currentLob === 'boat' || currentLob === 'trailer' || currentLob === 'renters') && (
      <Section icon={<ShieldCheck className="h-5 w-5" />} title="Coverage and routing" subtitle="Tell Sales what kind of quote is needed and where the lead came from.">
        <div className={ui.fieldRow}>
          <Field label="Quote type" required>
            <select className={ui.select} disabled={disabled || isFromRenewal} value={submission.quote_kind || 'new_quote'} onChange={(event) => patch({ quote_kind: event.target.value as 'new_quote' | 'requote' })}>
              <option value="new_quote">New Quote</option>
              <option value="requote">Requote</option>
            </select>
            {isFromRenewal && <span className="mt-1 block text-xs font-bold text-amber-600">Locked — this intake originated from a renewal requote.</span>}
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
              <option value="both_prices">Customer Wants Both Prices</option>
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

      {/* Quote details and source for commercial-routed LOBs */}
      {isCommercialRouted && (
      <Section icon={<ShieldCheck className="h-5 w-5" />} title="Quote details" subtitle="Quote type, source, and assignment for this intake.">
        <div className={ui.fieldRow}>
          <Field label="Quote type" required>
            <select className={ui.select} disabled={disabled || isFromRenewal} value={submission.quote_kind || 'new_quote'} onChange={(event) => patch({ quote_kind: event.target.value as 'new_quote' | 'requote' })}>
              <option value="new_quote">New Quote</option>
              <option value="requote">Requote</option>
            </select>
            {isFromRenewal && <span className="mt-1 block text-xs font-bold text-amber-600">Locked — this intake originated from a renewal requote.</span>}
          </Field>
          <Field label="Source / Dealer">
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
          {/* Only Commercial GL is assigned at intake. A specialty intake is claimed
              by the quoting team that owns the line, so asking Customer Service to
              pick a person here would be asking them to make a decision that is not
              theirs and that the rotation-free shared-claim model exists to avoid. */}
          {isSpecialtyRouted ? (
            <Field label="Assignment">
              <p className={`${ui.info} mt-2`}>
                Handled by the specialty quoting team. Nobody to choose.
              </p>
            </Field>
          ) : (
            <Field label="Assign to" required>
              <select className={ui.select} disabled={disabled} value={selectedAssignee} onChange={(e) => setSelectedAssignee(e.target.value)}>
                <option value="">— Select assignee —</option>
                {commercialAssignees.map((u) => (
                  <option key={u.id} value={u.id}>{u.display_name}{u.role === 'super_admin' || u.role === 'commercial_supervisor' ? ' (Supervisor)' : ''}</option>
                ))}
              </select>
            </Field>
          )}
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
            // Owner info maps to insured fields directly (kept for backward compat)
            if ('owner_first_name' in glPatch) mapped.insured_first_name = glPatch.owner_first_name || '';
            if ('owner_middle_name' in glPatch) (mapped as Record<string, unknown>).insured_middle_name = glPatch.owner_middle_name || '';
            if ('owner_last_name' in glPatch) (mapped as Record<string, unknown>).insured_last_name = glPatch.owner_last_name || '';
            if ('owner_dob' in glPatch) (mapped as Record<string, unknown>).insured_dob = glPatch.owner_dob || null;
            if ('owner_phone' in glPatch) (mapped as Record<string, unknown>).insured_phone_primary = glPatch.owner_phone || null;
            if ('owner_email' in glPatch) (mapped as Record<string, unknown>).insured_email = glPatch.owner_email || null;
            patch(mapped);
          }}
          owners={owners}
          onOwnersChange={(updated) => {
            setOwners(updated);
            // Sync primary owner to insured fields
            if (updated.length > 0) {
              const primary = updated[0];
              patch({
                insured_first_name: primary.first_name || '',
                insured_last_name: primary.last_name || '',
                insured_dob: primary.dob || null,
                insured_phone_primary: primary.phone || null,
                insured_email: primary.email || null,
                insured_middle_name: primary.middle_name || null,
              } as Partial<DraftSubmission>);
            }
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
            if ('liability_limit' in noPatch) mapped.liability_limit = noPatch.liability_limit || null;
            if ('document_type' in noPatch) mapped.no_document_type = noPatch.document_type || null;
            if ('document_number' in noPatch) mapped.no_document_number = noPatch.document_number || null;
            if ('document_state' in noPatch) mapped.no_document_state = noPatch.document_state || null;
            if ('document_expiration' in noPatch) mapped.no_document_expiration = noPatch.document_expiration || null;
            patch(mapped as Partial<DraftSubmission>);
          }}
          disabled={disabled}
        />
      )}

      {/* Motorcycle, Boat, Trailer, Renters sections */}
      {(currentLob === 'motorcycle' || currentLob === 'boat' || currentLob === 'trailer' || currentLob === 'renters') && (
        <OtherPersonalSection
          lob={currentLob}
          data={otherPersonalData}
          customerAddress={customerAddress}
          onChange={(opPatch) => {
            patch(opPatch as unknown as Partial<DraftSubmission>);
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
        {/*
          Customer / mailing address. One reusable control now owns the whole
          address, including whether it was actually verified. The previous
          version wired the autocomplete to the street line only and left city,
          state and ZIP as independent inputs with a ZIP-lookup side effect —
          which meant an address could be assembled by hand and there was no way
          to tell that apart from one Google returned.
        */}
        <div className="mt-5">
          <p className={`${ui.sectionTitle} mb-1`}>Customer / Mailing Address</p>
          <VerifiedAddressField
            value={customerAddress}
            onChange={applyCustomerAddress}
            disabled={disabled}
            required
            hint="Pick the address from the suggestions so the structured city, state and ZIP come from Google rather than being typed."
          />
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
          <div className="flex items-center gap-3 text-sm font-semibold text-slate-500"><CheckCircle2 className="h-5 w-5 text-emerald-500" /> Drafts can be reopened. Submission sends the intake to {isSpecialtyRouted ? 'the specialty quoting team' : isCommercialRouted ? 'the Commercial Board' : 'Sales'}.</div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={ui.btnGhost} disabled={busy} onClick={onDone}>Close</button>
            <button type="button" className={ui.btnSecondary} disabled={busy} onClick={() => void persist(false)}><Save className="h-4 w-4" /> Save Draft</button>
            <button type="button" className={ui.btnPrimary} disabled={busy} onClick={() => void persist(true)}><Send className="h-4 w-4" /> {isSpecialtyRouted ? 'Submit to Specialty Team' : isCommercialRouted ? 'Submit to Commercial' : 'Submit to Sales'}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

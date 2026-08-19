import type { LinkedIntake } from '../types';
import type {
  TruckingBusiness,
  TruckingCommodity,
  TruckingCoverages,
  TruckingDataPacket,
  TruckingDriver,
  TruckingOperations,
  TruckingOwner,
  TruckingPriorInsurance,
  TruckingTrailer,
  TruckingUnderwriting,
  TruckingVehicle,
} from './types';

/*
 * Label maps are duplicated here rather than imported from the intake form
 * components. Those components are `'use client'` React modules, and this
 * adapter runs inside a server API route — importing them would drag React into
 * the route bundle. Keep these in sync with:
 *   TRUCKING_OPERATION_TYPES / RADIUS_BANDS  → cs-intake/TruckingSection.tsx
 *   AUTO_LIABILITY_LIMITS                     → cs-intake/RequestedCoveragesSection.tsx
 *   TRAILER_TYPES                             → cs-intake/TrailersSection.tsx
 *   TRUCK_USAGE_OPTIONS                       → cs-intake/IntakeForm.tsx
 *   COMMODITY_CATEGORIES                      → cs-intake/CargoSection.tsx
 */

const OPERATION_TYPE_LABELS: Record<string, string> = {
  local_delivery: 'Local Delivery',
  regional: 'Regional',
  long_haul: 'Long Haul',
  hotshot: 'Hotshot',
  dump: 'Dump',
  auto_hauling: 'Auto Hauling',
  moving: 'Moving',
  construction: 'Construction',
  towing: 'Towing',
  other: 'Other',
};

const RADIUS_BAND_LABELS: Record<string, string> = {
  '0_50': '0-50 miles',
  '51_100': '51-100 miles',
  '101_200': '101-200 miles',
  '201_300': '201-300 miles',
  '301_500': '301-500 miles',
  '500_plus': '500+ miles',
};

const AUTO_LIABILITY_LABELS: Record<string, string> = {
  '300000': '$300,000',
  '500000': '$500,000',
  '750000': '$750,000',
  '1000000': '$1,000,000',
};

const TRUCK_USAGE_LABELS: Record<string, string> = {
  long_haul: 'Long Haul',
  regional: 'Regional',
  local: 'Local',
  delivery: 'Delivery',
  construction: 'Construction',
  dump: 'Dump',
  hotshot: 'Hotshot',
  other: 'Other',
};

const TRUCK_TYPE_LABELS: Record<string, string> = {
  box_truck: 'Box Truck',
  truck_tractor: 'Truck Tractor',
  sprinter_van: 'Sprinter Van',
  flatbed: 'Flatbed',
  reefer: 'Reefer',
  tanker: 'Tanker',
  dump_truck: 'Dump Truck',
  car_hauler: 'Car Hauler',
  step_van: 'Step Van',
  other: 'Other',
};

const TRAILER_TYPE_LABELS: Record<string, string> = {
  dry_van: 'Dry Van',
  flatbed: 'Flatbed',
  reefer: 'Reefer / Refrigerated',
  tanker: 'Tanker',
  dump: 'Dump Trailer',
  lowboy: 'Lowboy',
  step_deck: 'Step Deck',
  car_hauler: 'Car Hauler',
  utility: 'Utility',
  other: 'Other',
};

const OWNERSHIP_LABELS: Record<string, string> = {
  owned: 'Owned',
  financed: 'Financed',
  leased: 'Leased',
};

/** Turns a stored key into a readable label, or title-cases it as a fallback. */
function labelFor(map: Record<string, string>, key: string | null | undefined): string | null {
  if (!key) return null;
  if (map[key]) return map[key];
  return key
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** `$1,000,000`. Returns null rather than `$0` for a missing amount. */
function money(amount: number | null | undefined): string | null {
  if (amount === null || amount === undefined) return null;
  return `$${Number(amount).toLocaleString()}`;
}

/**
 * The requested Auto Liability limit as it should print on a carrier form.
 * Prefers the structured v1.19.2 answer, falls back to the legacy free-text
 * `liability_limit` column so intakes taken before the upgrade still fill.
 */
function autoLiabilityLimit(intake: LinkedIntake): string | null {
  if (intake.auto_liability_limit === 'other') {
    return intake.auto_liability_limit_other?.trim() || intake.liability_limit || null;
  }
  if (intake.auto_liability_limit) {
    return AUTO_LIABILITY_LABELS[intake.auto_liability_limit] ?? intake.auto_liability_limit;
  }
  return intake.liability_limit ?? null;
}

/**
 * Builds a TruckingDataPacket from the existing linked intake data.
 * Does NOT duplicate data into another table — reads live from the intake.
 */
export function buildTruckingDataPacket(intake: LinkedIntake): TruckingDataPacket {
  return {
    business: extractBusiness(intake),
    owners: extractOwners(intake),
    drivers: extractDrivers(intake),
    vehicles: extractVehicles(intake),
    trailers: extractTrailers(intake),
    commodities: extractCommodities(intake),
    operations: extractOperations(intake),
    coverages: extractCoverages(intake),
    underwriting: extractUnderwriting(intake),
    prior_insurance: extractPriorInsurance(intake),
  };
}

function extractBusiness(intake: LinkedIntake): TruckingBusiness {
  // Garaging defaults to the first truck's garaging ZIP when the customer never
  // gave a separate garaging address, which is the common case.
  const garagingZip = intake.vehicles?.find((vehicle) => vehicle.garaging_zip)?.garaging_zip ?? null;

  return {
    legal_name: intake.business_name ?? null,
    dba: null, // Not in current intake schema
    entity_type: intake.business_type ?? null,
    mailing_street: intake.addr_street ?? null,
    mailing_unit: intake.addr_unit ?? null,
    mailing_city: intake.addr_city ?? null,
    mailing_state: intake.addr_state ?? null,
    mailing_zip: intake.addr_zip ?? null,
    garaging_street: null, // Not separated in current intake
    garaging_city: null,
    garaging_state: null,
    garaging_zip: garagingZip,
    phone: intake.insured_phone_primary ?? null,
    email: intake.insured_email ?? null,
    dot_number: intake.dot_number ?? null,
    mc_number: intake.mc_number ?? null,
    fein: intake.ein ?? null,
    years_in_business: intake.years_in_business ?? null,
    years_experience: null, // Not separated in current intake
  };
}

function extractOwners(intake: LinkedIntake): TruckingOwner[] {
  // If cs_intake_owners has entries, use them
  if (intake.owners && Array.isArray(intake.owners) && intake.owners.length > 0) {
    return intake.owners.map((owner) => {
      const row = owner as Record<string, unknown>;
      // The owners table stores first/middle/last separately; the carrier forms
      // want one name box.
      const composed = [row.first_name, row.middle_name, row.last_name]
        .filter((part) => typeof part === 'string' && part.trim() !== '')
        .join(' ');
      return {
        name: ((row.name as string | null) ?? null) || composed || null,
        dob: (row.dob as string | null) ?? null,
        license_number: (row.license_number as string | null) ?? null,
        license_state: (row.license_state as string | null) ?? null,
        ownership_percentage: (row.ownership_percentage as number | null) ?? null,
      };
    });
  }

  // Fallback: the insured person IS the owner for most trucking operations
  const insuredName = [intake.insured_first_name, intake.insured_last_name].filter(Boolean).join(' ');
  if (insuredName) {
    // The primary driver row carries the insured's licence, so borrow it here —
    // carrier forms ask for the owner's licence and CDL status on page 1.
    const primaryDriver = intake.drivers?.[0];
    return [{
      name: insuredName,
      dob: intake.insured_dob ?? null,
      license_number: primaryDriver?.license_number ?? null,
      license_state: primaryDriver?.license_state ?? null,
      ownership_percentage: null,
    }];
  }

  return [];
}

function extractDrivers(intake: LinkedIntake): TruckingDriver[] {
  if (!intake.drivers || !Array.isArray(intake.drivers)) return [];

  return intake.drivers.map((driver) => {
    const summary = [
      driver.accidents_36mo ? `Accidents: ${driver.accidents_detail?.trim() || 'Yes'}` : null,
      driver.violations_36mo ? `Violations: ${driver.violations_detail?.trim() || 'Yes'}` : null,
    ].filter(Boolean);

    return {
      position: driver.position,
      first_name: driver.first_name ?? null,
      last_name: driver.last_name ?? null,
      full_name: [driver.first_name, driver.last_name].filter(Boolean).join(' ') || null,
      dob: driver.dob ?? null,
      license_number: driver.license_number ?? null,
      license_state: driver.license_state ?? null,
      license_status: driver.license_status ?? null,
      years_licensed: driver.years_licensed ?? null,
      // CDL experience is what carriers actually rate on; years licensed is the
      // fallback for intakes taken before that field existed.
      experience: driver.cdl_years_experience ?? driver.years_licensed ?? null,
      sr22_required: driver.sr22_required ?? false,
      cdl: driver.cdl ?? null,
      cdl_date: driver.cdl_date ?? null,
      cdl_years_experience: driver.cdl_years_experience ?? null,
      owner_operator: driver.owner_operator ?? null,
      accidents_36mo: driver.accidents_36mo ?? null,
      accidents_detail: driver.accidents_detail ?? null,
      violations_36mo: driver.violations_36mo ?? null,
      violations_detail: driver.violations_detail ?? null,
      // An explicit "None" is more useful to an underwriter than a blank box,
      // but only once we know the questions were actually answered.
      violation_accident_summary: summary.length
        ? summary.join('; ')
        : driver.accidents_36mo === false && driver.violations_36mo === false
          ? 'None'
          : null,
    };
  });
}

function extractVehicles(intake: LinkedIntake): TruckingVehicle[] {
  if (!intake.vehicles || !Array.isArray(intake.vehicles)) return [];

  return intake.vehicles.map((vehicle) => ({
    position: vehicle.position,
    year: vehicle.year ?? null,
    make: vehicle.make ?? null,
    model: vehicle.model ?? null,
    // Body type is what the carrier "Body Type" column wants. Fall back to
    // usage only when no truck type was recorded.
    type: labelFor(TRUCK_TYPE_LABELS, vehicle.truck_type)
      ?? labelFor(TRUCK_USAGE_LABELS, vehicle.usage)
      ?? null,
    vin: vehicle.vin ?? null,
    value: vehicle.physical_damage_value ?? null,
    gvw: null,
    radius: intake.operating_radius_miles ?? null,
    usage: labelFor(TRUCK_USAGE_LABELS, vehicle.usage),
    ownership: labelFor(OWNERSHIP_LABELS, vehicle.ownership),
    lessor_name: vehicle.lessor_name ?? null,
    lessor_address: vehicle.lessor_address ?? null,
    physical_damage_deductible: vehicle.physical_damage_deductible ?? null,
    annual_mileage: vehicle.annual_mileage ?? null,
    garaging_zip: vehicle.garaging_zip ?? null,
  }));
}

function extractTrailers(intake: LinkedIntake): TruckingTrailer[] {
  if (!intake.trailers || !Array.isArray(intake.trailers)) return [];

  return intake.trailers.map((trailer) => ({
    position: trailer.position,
    year: trailer.year ?? null,
    make: trailer.make ?? null,
    type: labelFor(TRAILER_TYPE_LABELS, trailer.trailer_type),
    vin: trailer.vin ?? null,
    value: trailer.actual_cash_value ?? null,
    ownership: labelFor(OWNERSHIP_LABELS, trailer.ownership),
    lessor_name: trailer.lessor_name ?? null,
    lessor_address: trailer.lessor_address ?? null,
  }));
}

function extractCommodities(intake: LinkedIntake): TruckingCommodity[] {
  if (!intake.commodities || !Array.isArray(intake.commodities)) return [];

  return intake.commodities.map((row) => ({
    description: labelFor({}, row.category),
    frequency: row.frequency ?? null,
    is_primary: row.is_primary ?? false,
    percent_hauled: row.percent_hauled ?? null,
    average_value: row.average_value ?? null,
    maximum_value: row.maximum_value ?? null,
  }));
}

function extractOperations(intake: LinkedIntake): TruckingOperations {
  const operationTypes = (intake.operation_types ?? [])
    .map((key) => labelFor(OPERATION_TYPE_LABELS, key))
    .filter(Boolean)
    .join(', ');

  // Prefer the structured commodity rows; fall back to the free-text
  // description, then to the legacy `cargo_type` column.
  const commoditySummary = (intake.commodities ?? [])
    .map((row) => labelFor({}, row.category))
    .filter(Boolean)
    .join(', ');

  return {
    commodities: commoditySummary || intake.cargo_description || intake.cargo_type || null,
    radius: intake.operating_radius_miles ?? null,
    states: intake.states_of_operation ?? null,
    revenue: null, // Not in current intake
    mileage: null, // Not in current intake
    brokerage_percentage: null, // Not in current intake
    interstate: intake.interstate ?? null,
    for_hire: intake.for_hire ?? null,
    owner_operators: intake.owner_operator_count ?? null,
    operation_types: operationTypes || intake.business_type || null,
    operation_description: intake.operation_description ?? null,
    radius_band: labelFor(RADIUS_BAND_LABELS, intake.radius_band),
    farthest_states_cities: intake.farthest_states_cities ?? null,
    desired_effective_date: intake.desired_effective_date ?? null,
    power_unit_count: intake.power_unit_count ?? intake.vehicles?.length ?? null,
    pulls_non_owned_trailers: intake.pulls_non_owned_trailers ?? null,
  };
}

function extractCoverages(intake: LinkedIntake): TruckingCoverages {
  // Physical Damage is now an explicit question. Older intakes never answered
  // it, so fall back to the desired-coverage selection they did answer.
  const physicalDamage = intake.physical_damage_needed
    ?? (intake.desired_coverage === 'full_coverage' || intake.desired_coverage === 'both_prices' || null);

  const pdDeductible = intake.physical_damage_deductible_requested
    ?? (intake.vehicles?.find((vehicle) => vehicle.physical_damage_deductible)?.physical_damage_deductible
      ? money(intake.vehicles.find((vehicle) => vehicle.physical_damage_deductible)!.physical_damage_deductible)
      : null);

  return {
    auto_liability_limit: autoLiabilityLimit(intake),
    cargo_limit: intake.cargo_coverage_desired === false ? null : money(intake.requested_cargo_limit),
    cargo_deductible: money(intake.cargo_deductible),
    physical_damage: physicalDamage,
    general_liability: intake.general_liability_requested ?? null,
    trailer_interchange: intake.pulls_non_owned_trailers ?? null,
    // Comprehensive / Collision deductibles: the trucking form asks for one PD
    // deductible, so mirror it into both when only the PD answer exists.
    comprehensive_deductible: intake.comprehensive_deductible
      ?? (intake.pd_comprehensive ? pdDeductible : null),
    collision_deductible: intake.collision_deductible
      ?? (intake.pd_collision ? pdDeductible : null),
    medical_payments: intake.medical_payments_limit ?? null,
    um_uim_limit: intake.um_uim_limit ?? null,
    hired_auto: intake.hired_auto ?? null,
    non_owned_auto: intake.non_owned_auto ?? null,
    physical_damage_requested: intake.physical_damage_needed ?? null,
    physical_damage_deductible: pdDeductible,
    pd_comprehensive: intake.pd_comprehensive ?? null,
    pd_collision: intake.pd_collision ?? null,
    pd_specified_causes: intake.pd_specified_causes ?? null,
    trailer_interchange_limit: intake.trailer_interchange_limit ?? null,
    trailer_interchange_deductible: intake.trailer_interchange_deductible ?? null,
    trailer_interchange_agreement: intake.trailer_interchange_agreement ?? null,
    general_liability_limit: intake.general_liability_limit ?? null,
    medical_payments_requested: intake.medical_payments_requested ?? null,
    additional_coverages_other: intake.additional_coverages_other ?? null,
    max_load_value: intake.max_load_value ?? null,
    typical_load_value: intake.typical_load_value ?? null,
    reefer_breakdown_requested: intake.reefer_breakdown_requested ?? null,
  };
}

function extractUnderwriting(intake: LinkedIntake): TruckingUnderwriting {
  return {
    coverage_lapse: intake.uw_coverage_lapse ?? intake.prior_lapse ?? null,
    coverage_lapse_detail: intake.uw_coverage_lapse_detail ?? intake.prior_lapse_explanation ?? null,
    cancelled_nonrenewed: intake.uw_cancelled_nonrenewed ?? null,
    cancelled_nonrenewed_detail: intake.uw_cancelled_nonrenewed_detail ?? null,
    losses_3yr: intake.uw_losses_3yr ?? null,
    losses_3yr_detail: intake.uw_losses_3yr_detail ?? null,
    major_al_loss: intake.uw_major_al_loss ?? null,
    major_al_loss_detail: intake.uw_major_al_loss_detail ?? null,
    hazmat: intake.hazmat ?? null,
    hazmat_detail: intake.hazmat_detail ?? null,
    owner_operators: intake.uw_owner_operators ?? null,
    owner_operators_detail: intake.uw_owner_operators_detail ?? null,
    owner_operator_count: intake.owner_operator_count ?? null,
  };
}

function extractPriorInsurance(intake: LinkedIntake): TruckingPriorInsurance {
  return {
    carrier: intake.current_carrier ?? null,
    policy_number: intake.current_policy_number ?? null,
    premium: intake.current_premium ?? null,
    expiration: intake.current_expiration ?? null,
    lapse: intake.uw_coverage_lapse ?? intake.prior_lapse ?? null,
    lapse_explanation: intake.uw_coverage_lapse_detail ?? intake.prior_lapse_explanation ?? null,
    months_continuous_coverage: intake.months_continuous_coverage ?? null,
  };
}

/**
 * Computes a simple hash of the source data for stale-detection.
 * If a generated application's source_data_hash differs from the current hash,
 * the user should be warned that regeneration may be needed.
 */
export function computeDataHash(packet: TruckingDataPacket): string {
  const str = JSON.stringify(packet);
  // Simple hash — adequate for change detection, not for security
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Checks whether a question can be auto-filled from existing intake data.
 * Returns the value if available, null if not.
 */
export function autoFillFromIntake(
  autoFillSource: string | null,
  packet: TruckingDataPacket,
): string | null {
  if (!autoFillSource) return null;

  const yesNo = (value: boolean | null): string | null =>
    value === null || value === undefined ? null : value ? 'Yes' : 'No';

  // Map common auto_fill_source keys to packet values
  const mappings: Record<string, () => string | null> = {
    'business.dot_number': () => packet.business.dot_number,
    'business.mc_number': () => packet.business.mc_number,
    'business.legal_name': () => packet.business.legal_name,
    'business.entity_type': () => packet.business.entity_type,
    'business.phone': () => packet.business.phone,
    'business.email': () => packet.business.email,
    'business.fein': () => packet.business.fein,
    'business.years_in_business': () => packet.business.years_in_business?.toString() ?? null,
    'business.mailing_street': () => packet.business.mailing_street,
    'business.mailing_city': () => packet.business.mailing_city,
    'business.mailing_state': () => packet.business.mailing_state,
    'business.mailing_zip': () => packet.business.mailing_zip,
    'operations.commodities': () => packet.operations.commodities,
    'operations.radius': () => packet.operations.radius?.toString() ?? null,
    'operations.states': () => packet.operations.states,
    'operations.operation_types': () => packet.operations.operation_types,
    'operations.radius_band': () => packet.operations.radius_band,
    'operations.desired_effective_date': () => packet.operations.desired_effective_date,
    'operations.interstate': () => yesNo(packet.operations.interstate),
    'operations.for_hire': () => yesNo(packet.operations.for_hire),
    'operations.owner_operators': () => packet.operations.owner_operators?.toString() ?? null,
    'coverages.auto_liability_limit': () => packet.coverages.auto_liability_limit,
    'coverages.cargo_limit': () => packet.coverages.cargo_limit,
    'coverages.cargo_deductible': () => packet.coverages.cargo_deductible,
    'coverages.um_uim_limit': () => packet.coverages.um_uim_limit,
    'coverages.physical_damage_deductible': () => packet.coverages.physical_damage_deductible,
    'coverages.general_liability_limit': () => packet.coverages.general_liability_limit,
    'coverages.medical_payments': () => packet.coverages.medical_payments,
    'coverages.trailer_interchange_limit': () => packet.coverages.trailer_interchange_limit,
    'underwriting.hazmat': () => packet.underwriting.hazmat,
    'underwriting.coverage_lapse': () => yesNo(packet.underwriting.coverage_lapse),
    'underwriting.cancelled_nonrenewed': () => yesNo(packet.underwriting.cancelled_nonrenewed),
    'underwriting.losses_3yr': () => yesNo(packet.underwriting.losses_3yr),
    'underwriting.major_al_loss': () => yesNo(packet.underwriting.major_al_loss),
    'underwriting.owner_operators': () => yesNo(packet.underwriting.owner_operators),
    'prior_insurance.carrier': () => packet.prior_insurance.carrier,
    'prior_insurance.expiration': () => packet.prior_insurance.expiration,
  };

  const getter = mappings[autoFillSource];
  return getter ? getter() : null;
}

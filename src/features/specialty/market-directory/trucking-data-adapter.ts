/**
 * Trucking Data Adapter
 *
 * Aggregates existing structured data from the CS intake and specialty opportunity
 * into a consistent shape for carrier document generation. This is NOT a new
 * customer database — it reads live data from the linked intake.
 *
 * v1.17.0
 */

import type { LinkedIntake } from '../types';
import type {
  TruckingBusiness,
  TruckingCoverages,
  TruckingDataPacket,
  TruckingDriver,
  TruckingOperations,
  TruckingOwner,
  TruckingPriorInsurance,
  TruckingVehicle,
} from './types';

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
    operations: extractOperations(intake),
    coverages: extractCoverages(intake),
    prior_insurance: extractPriorInsurance(intake),
  };
}

function extractBusiness(intake: LinkedIntake): TruckingBusiness {
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
    garaging_zip: null,
    phone: intake.insured_phone_primary ?? null,
    email: intake.insured_email ?? null,
    dot_number: intake.dot_number ?? null,
    mc_number: intake.mc_number ?? null,
    fein: null, // Not in current intake schema
    years_in_business: intake.years_in_business ?? null,
    years_experience: null, // Not separated in current intake
  };
}

function extractOwners(intake: LinkedIntake): TruckingOwner[] {
  // If cs_intake_owners has entries, use them
  if (intake.owners && Array.isArray(intake.owners) && intake.owners.length > 0) {
    return intake.owners.map((owner) => ({
      name: (owner as Record<string, unknown>).name as string | null ?? null,
      dob: (owner as Record<string, unknown>).dob as string | null ?? null,
      license_number: (owner as Record<string, unknown>).license_number as string | null ?? null,
      license_state: (owner as Record<string, unknown>).license_state as string | null ?? null,
      ownership_percentage: (owner as Record<string, unknown>).ownership_percentage as number | null ?? null,
    }));
  }

  // Fallback: the insured person IS the owner for most trucking operations
  const insuredName = [intake.insured_first_name, intake.insured_last_name].filter(Boolean).join(' ');
  if (insuredName) {
    return [{
      name: insuredName,
      dob: intake.insured_dob ?? null,
      license_number: null,
      license_state: null,
      ownership_percentage: null,
    }];
  }

  return [];
}

function extractDrivers(intake: LinkedIntake): TruckingDriver[] {
  if (!intake.drivers || !Array.isArray(intake.drivers)) return [];

  return intake.drivers.map((driver) => ({
    position: driver.position,
    first_name: driver.first_name ?? null,
    last_name: driver.last_name ?? null,
    dob: driver.dob ?? null,
    license_number: driver.license_number ?? null,
    license_state: driver.license_state ?? null,
    license_status: driver.license_status ?? null,
    years_licensed: driver.years_licensed ?? null,
    experience: driver.years_licensed ?? null, // Best available proxy
    sr22_required: driver.sr22_required ?? false,
  }));
}

function extractVehicles(intake: LinkedIntake): TruckingVehicle[] {
  if (!intake.vehicles || !Array.isArray(intake.vehicles)) return [];

  return intake.vehicles.map((vehicle) => ({
    position: vehicle.position,
    year: vehicle.year ?? null,
    make: vehicle.make ?? null,
    model: vehicle.model ?? null,
    type: vehicle.usage ?? null, // usage maps to vehicle type/class
    vin: vehicle.vin ?? null,
    value: null, // Not in current intake vehicles
    gvw: null, // Not in current intake vehicles
    radius: null, // Per-vehicle radius not tracked in intake
  }));
}

function extractOperations(intake: LinkedIntake): TruckingOperations {
  return {
    commodities: intake.cargo_type ?? null,
    radius: intake.operating_radius_miles ?? null,
    states: intake.states_of_operation ?? null,
    revenue: null, // Not in current intake
    mileage: null, // Not in current intake
    brokerage_percentage: null, // Not in current intake
    interstate: null, // Inferred from states but not explicit
    for_hire: null, // Not in current intake
    owner_operators: null, // Not in current intake
  };
}

function extractCoverages(intake: LinkedIntake): TruckingCoverages {
  return {
    auto_liability_limit: intake.liability_limit ?? null,
    cargo_limit: intake.requested_cargo_limit ? `$${intake.requested_cargo_limit.toLocaleString()}` : null,
    cargo_deductible: intake.cargo_deductible ? `$${intake.cargo_deductible.toLocaleString()}` : null,
    physical_damage: intake.desired_coverage === 'full_coverage' || intake.desired_coverage === 'both_prices' || null,
    general_liability: null,
    trailer_interchange: null,
    comprehensive_deductible: intake.comprehensive_deductible ?? null,
    collision_deductible: intake.collision_deductible ?? null,
    medical_payments: null, // Collected via JSA-specific supplemental question
  };
}

function extractPriorInsurance(intake: LinkedIntake): TruckingPriorInsurance {
  return {
    carrier: intake.current_carrier ?? null,
    policy_number: intake.current_policy_number ?? null,
    premium: intake.current_premium ?? null,
    expiration: intake.current_expiration ?? null,
    lapse: intake.prior_lapse ?? null,
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

  // Map common auto_fill_source keys to packet values
  const mappings: Record<string, () => string | null> = {
    'business.dot_number': () => packet.business.dot_number,
    'business.mc_number': () => packet.business.mc_number,
    'business.legal_name': () => packet.business.legal_name,
    'business.entity_type': () => packet.business.entity_type,
    'business.phone': () => packet.business.phone,
    'business.email': () => packet.business.email,
    'business.years_in_business': () => packet.business.years_in_business?.toString() ?? null,
    'business.mailing_street': () => packet.business.mailing_street,
    'business.mailing_city': () => packet.business.mailing_city,
    'business.mailing_state': () => packet.business.mailing_state,
    'business.mailing_zip': () => packet.business.mailing_zip,
    'operations.commodities': () => packet.operations.commodities,
    'operations.radius': () => packet.operations.radius?.toString() ?? null,
    'operations.states': () => packet.operations.states,
    'coverages.auto_liability_limit': () => packet.coverages.auto_liability_limit,
    'prior_insurance.carrier': () => packet.prior_insurance.carrier,
    'prior_insurance.expiration': () => packet.prior_insurance.expiration,
  };

  const getter = mappings[autoFillSource];
  return getter ? getter() : null;
}

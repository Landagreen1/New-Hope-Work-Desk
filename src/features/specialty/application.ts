/**
 * Reading the master application.
 *
 * The specialty side stores no customer or risk detail of its own: every field below
 * is read live from the linked Customer Service intake through
 * `specialty_opportunity_detail`, and a correction is written back to that intake by
 * `specialty_update_intake`. There is deliberately no per-carrier copy of the
 * application — one intake, many carrier submissions.
 *
 * What this module adds is *shape*. The intake is a flat row of a hundred-odd
 * columns; an agent works in sections, and underwriting cares about structured cargo
 * rather than the word "dry freight". So the sections, their completion state and the
 * requested coverage lines are derived here, once, and the Application tab renders
 * what it is given.
 *
 * No React and no `getSupabase`: these are functions over an intake row, so they can
 * be tested without a database or a renderer. The one import that is not local is the
 * intake form's own option tables — `auto_liability_limit` stores a key, not a label,
 * and the table that maps the two belongs to the form that writes it. Restating it
 * here is how the two screens would come to disagree about what `1000000` means.
 */

import { autoLiabilityLimitLabel } from '../cs-intake/RequestedCoveragesSection';
import { RADIUS_BANDS, operationTypesLabel } from '../cs-intake/TruckingSection';
import { formatMoney, titleCase } from './status';
import type { LinkedIntake, SpecialtyLine } from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// Value formatting
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Formats a requested limit.
 *
 * These columns are free text on the intake, because Customer Service records what
 * the customer said: "1,000,000", "$1M", "CSL 1M", "state minimum". A bare number is
 * shown as money; anything else is shown as the person typed it, because rewriting
 * it would be guessing at what they meant.
 */
export function formatLimit(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return formatMoney(value);

  const trimmed = value.trim();
  if (trimmed === '') return null;

  const digits = trimmed.replace(/[$,\s]/g, '');
  if (/^\d+$/.test(digits)) return formatMoney(Number(digits));
  return trimmed;
}

function yesNo(value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value ? 'Yes' : 'No';
}

/** `radius_band` stores a key such as `51_100`. The form's table names it. */
export function radiusBandLabel(band: string | null | undefined): string | null {
  if (!band) return null;
  return RADIUS_BANDS.find((option) => option.key === band)?.label ?? titleCase(band);
}

/**
 * The intake's three-way answers.
 *
 * `hired_auto`, `non_owned_auto`, `reefer_breakdown_requested` and `hazmat` are stored
 * as `yes` / `no` / `unsure`, because Customer Service often genuinely does not know on
 * the first call and a guessed No is worse for an underwriter than an honest Unsure.
 * That third answer has to survive into this screen rather than being flattened.
 */
export function yesNoUnsure(value: string | null | undefined): string | null {
  if (!value) return null;
  switch (value) {
    case 'yes':
      return 'Yes';
    case 'no':
      return 'No';
    case 'unsure':
      return 'Unsure';
    default:
      return titleCase(value);
  }
}

function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * A number, or null.
 *
 * `undefined` is folded into null on purpose. `specialty_opportunity_detail` returns
 * explicit nulls today, but a column added to the intake and not yet to the RPC's select
 * arrives as `undefined`, and `x !== null` would then read it as an answer. That is the
 * kind of gap that shows up as a screen confidently reporting a limit of "—".
 */
function num(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : value;
}

/** A boolean answer, or null for "nobody has answered". Same reasoning as {@link num}. */
function bool(value: boolean | null | undefined): boolean | null {
  return value === null || value === undefined ? null : value;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Requested coverage
// ═══════════════════════════════════════════════════════════════════════════════

export interface CoverageLine {
  key: string;
  label: string;
  /** Formatted for display, or null when the intake does not have it. */
  value: string | null;
  /** The secondary line: a deductible, a form, a qualifier. */
  note: string | null;
  /**
   * True when this coverage is one the product always asks about, so an empty value
   * is a gap worth showing rather than a line to hide.
   */
  isCore: boolean;
}

/**
 * The limits the customer asked for, per line of business.
 *
 * Product-specific by construction: `line_of_business` picks the set, so adding a
 * third product means adding a branch here and nothing in the components.
 */
export function requestedCoverage(
  line: SpecialtyLine,
  intake: LinkedIntake | null,
): CoverageLine[] {
  if (!intake) return [];
  return line === 'trucking' ? truckingCoverage(intake) : propertyCoverage(intake);
}

function truckingCoverage(intake: LinkedIntake): CoverageLine[] {
  // Physical damage is carried per unit, so the requested figure is the sum of the
  // stated values rather than a column of its own.
  const statedValue = intake.vehicles.reduce(
    (total, vehicle) => total + (vehicle.physical_damage_value ?? 0),
    0,
  );
  const trailerValue = intake.trailers.reduce(
    (total, trailer) => total + (trailer.actual_cash_value ?? 0),
    0,
  );

  const lines: CoverageLine[] = [
    {
      key: 'auto_liability',
      label: 'Auto Liability',
      // The stored value is a key, so the form's own table names it. `other` carries
      // its meaning in the companion column.
      value:
        autoLiabilityLimitLabel(intake.auto_liability_limit, intake.auto_liability_limit_other) ||
        formatLimit(intake.liability_limit),
      note:
        [
          intake.um_uim_limit ? `UM/UIM ${intake.um_uim_limit}` : null,
          yesNoUnsure(intake.hired_auto) ? `hired auto ${yesNoUnsure(intake.hired_auto)}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      isCore: true,
    },
    {
      key: 'cargo',
      label: 'Cargo',
      value: formatLimit(num(intake.requested_cargo_limit)),
      note:
        num(intake.cargo_deductible) !== null
          ? `${formatMoney(intake.cargo_deductible)} deductible`
          : bool(intake.cargo_coverage_desired) === false
            ? 'Not requested'
            : null,
      isCore: true,
    },
    {
      key: 'physical_damage',
      label: 'Physical Damage',
      value:
        bool(intake.physical_damage_needed) === false
          ? 'Not requested'
          : statedValue > 0
            ? formatMoney(statedValue)
            : null,
      note: [
        statedValue > 0 && intake.vehicles.length > 0
          ? `stated value across ${intake.vehicles.length} unit${intake.vehicles.length === 1 ? '' : 's'}`
          : null,
        formatLimit(intake.physical_damage_deductible_requested)
          ? `${formatLimit(intake.physical_damage_deductible_requested)} deductible`
          : null,
        [
          intake.pd_comprehensive ? 'comprehensive' : null,
          intake.pd_collision ? 'collision' : null,
          intake.pd_specified_causes ? 'specified causes' : null,
        ]
          .filter(Boolean)
          .join(' + ') || null,
      ]
        .filter(Boolean)
        .join(' · ') || null,
      isCore: true,
    },
    {
      key: 'trailer_interchange',
      label: 'Trailer Interchange',
      value:
        bool(intake.trailer_interchange_agreement) === false
          ? 'No interchange agreement'
          : formatLimit(intake.trailer_interchange_limit),
      note: [
        formatLimit(intake.trailer_interchange_deductible)
          ? `${formatLimit(intake.trailer_interchange_deductible)} deductible`
          : null,
        intake.pulls_non_owned_trailers ? 'pulls non-owned trailers' : null,
        trailerValue > 0 ? `${formatMoney(trailerValue)} owned trailer value` : null,
      ]
        .filter(Boolean)
        .join(' · ') || null,
      isCore: true,
    },
  ];

  // Offered only when asked for. A blank row for a coverage nobody requested is
  // noise, which is exactly what the spec's "avoid" list names.
  if (intake.general_liability_requested) {
    lines.push({
      key: 'general_liability',
      label: 'General Liability',
      value: formatLimit(intake.general_liability_limit),
      note: null,
      isCore: false,
    });
  }
  if (intake.medical_payments_requested) {
    lines.push({
      key: 'medical_payments',
      label: 'Medical Payments',
      value: formatLimit(intake.medical_payments_limit),
      note: null,
      isCore: false,
    });
  }
  if (present(intake.non_owned_auto)) {
    lines.push({
      key: 'non_owned',
      label: 'Non-Owned Auto',
      value: yesNoUnsure(intake.non_owned_auto),
      note: null,
      isCore: false,
    });
  }
  if (present(intake.additional_coverages_other)) {
    lines.push({
      key: 'additional',
      label: 'Also requested',
      value: intake.additional_coverages_other,
      note: null,
      isCore: false,
    });
  }

  return lines;
}

function propertyCoverage(intake: LinkedIntake): CoverageLine[] {
  const lines: CoverageLine[] = [
    {
      key: 'dwelling',
      label: 'Dwelling',
      value: formatLimit(num(intake.coverage_amount)),
      note: intake.coverage_type ?? null,
      isCore: true,
    },
    {
      key: 'liability',
      label: 'Personal Liability',
      value: formatLimit(intake.liability_limit),
      note: null,
      isCore: true,
    },
  ];

  if (present(intake.desired_coverage)) {
    lines.push({
      key: 'desired',
      label: 'Also requested',
      value: intake.desired_coverage,
      note: null,
      isCore: false,
    });
  }

  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cargo
//
// Cargo gets its own reading because "Dry Freight" is the answer agents give and it
// is not an answer an underwriter can rate. The structured columns added in v1.18.0
// and v1.18.2 already exist; what was missing was a screen that shows them and makes
// the gap obvious when they are empty.
// ═══════════════════════════════════════════════════════════════════════════════

export interface CargoCommodity {
  label: string;
  frequency: string | null;
  isPrimary: boolean;
  percentHauled: number | null;
  averageValue: number | null;
  maximumValue: number | null;
}

export interface CargoProfile {
  /** The headline category, from the structured field or the legacy free text. */
  primaryCategory: string | null;
  /** True when `primaryCategory` came from the legacy free-text `cargo_type`. */
  primaryIsLegacy: boolean;
  description: string | null;
  commodities: CargoCommodity[];
  /** Commodities the insured answered "yes" to hauling, from `excluded_cargo`. */
  excluded: string[];
  /** Commodities explicitly ruled out. */
  notHauled: string[];
  typicalLoadValue: number | null;
  maximumLoadValue: number | null;
  requestedLimit: number | null;
  deductible: number | null;
  handling: { label: string; value: string }[];
  /**
   * What an underwriter would send back for. Empty means the cargo section is
   * genuinely answerable, not that it is perfect.
   */
  gaps: string[];
}

export function cargoProfile(intake: LinkedIntake | null): CargoProfile | null {
  if (!intake) return null;

  const structuredPrimary =
    intake.primary_commodity ??
    intake.commodities.find((commodity) => commodity.is_primary)?.category ??
    null;

  const excluded: string[] = [];
  const notHauled: string[] = [];
  for (const [item, answer] of Object.entries(intake.excluded_cargo ?? {})) {
    (answer === 'yes' ? excluded : notHauled).push(titleCase(item));
  }

  const handling = [
    { label: 'Refrigerated', value: yesNo(bool(intake.refrigerated)) },
    {
      label: 'Temp-controlled equipment',
      value: yesNo(bool(intake.temperature_controlled_equipment)),
    },
    { label: 'Reefer breakdown', value: yesNoUnsure(intake.reefer_breakdown_requested) },
    { label: 'Hazmat', value: yesNoUnsure(intake.hazmat) },
    { label: 'Broker / load board', value: yesNo(bool(intake.broker_load_board)) },
    { label: 'Commodity mix known', value: yesNo(bool(intake.commodity_mix_known)) },
  ].filter((entry): entry is { label: string; value: string } => present(entry.value));

  const maximumLoadValue =
    num(intake.max_load_value) ??
    intake.commodities.reduce<number | null>(
      (highest, commodity) =>
        commodity.maximum_value === null
          ? highest
          : highest === null
            ? commodity.maximum_value
            : Math.max(highest, commodity.maximum_value),
      null,
    );

  const gaps: string[] = [];
  if (!structuredPrimary) gaps.push('No primary commodity category');
  if (intake.commodities.length === 0) gaps.push('No commodity breakdown');
  if (maximumLoadValue === null) gaps.push('No maximum value per load');
  if (
    num(intake.requested_cargo_limit) === null &&
    bool(intake.cargo_coverage_desired) !== false
  ) {
    gaps.push('No requested cargo limit');
  }
  if (Object.keys(intake.excluded_cargo ?? {}).length === 0) {
    gaps.push('Prohibited-cargo questions unanswered');
  }
  // The tell-tale answer. A one-word generic description is what the spec calls out
  // as insufficient for underwriting, so it is named rather than accepted.
  const generic = (intake.cargo_type ?? '').trim();
  if (!structuredPrimary && generic !== '' && generic.split(/\s+/).length <= 2) {
    gaps.push(`"${generic}" is too general for an underwriter to rate`);
  }

  return {
    primaryCategory: structuredPrimary ? titleCase(structuredPrimary) : (intake.cargo_type ?? null),
    primaryIsLegacy: !structuredPrimary && present(intake.cargo_type),
    description: intake.cargo_description,
    commodities: intake.commodities.map((commodity) => ({
      label: titleCase(commodity.category),
      frequency: commodity.frequency ? titleCase(commodity.frequency) : null,
      isPrimary: commodity.is_primary,
      percentHauled: commodity.percent_hauled,
      averageValue: commodity.average_value,
      maximumValue: commodity.maximum_value,
    })),
    excluded,
    notHauled,
    typicalLoadValue: num(intake.typical_load_value),
    maximumLoadValue,
    requestedLimit: num(intake.requested_cargo_limit),
    deductible: num(intake.cargo_deductible),
    handling,
    gaps,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Application sections
// ═══════════════════════════════════════════════════════════════════════════════

export type SectionKey =
  | 'business'
  | 'operations'
  | 'drivers'
  | 'vehicles'
  | 'cargo'
  | 'coverage'
  | 'prior_insurance'
  | 'loss_history'
  | 'property'
  | 'customer';

export interface ApplicationSection {
  key: SectionKey;
  label: string;
  /**
   * `complete` — nothing an underwriter needs is blank.
   * `attention` — answerable but thin, and named as such.
   * `empty` — nothing recorded at all.
   */
  state: 'complete' | 'attention' | 'empty';
  /** The one line worth reading without opening the section. */
  summary: string;
  /** Named gaps. Shown under the section header when it is open. */
  missing: string[];
}

/**
 * The sections of the master application, in the order an agent works them.
 *
 * Trucking and property share Customer, Prior Insurance and Loss History and differ
 * in the middle, which is why the list is built per product rather than filtered from
 * one superset.
 */
export function applicationSections(
  line: SpecialtyLine,
  intake: LinkedIntake | null,
): ApplicationSection[] {
  if (!intake) return [];
  return line === 'trucking' ? truckingSections(intake) : propertySections(intake);
}

function state(missing: string[], anything: boolean): ApplicationSection['state'] {
  if (!anything) return 'empty';
  return missing.length === 0 ? 'complete' : 'attention';
}

/**
 * Rolls per-row gaps up into one line each.
 *
 * A twenty-driver fleet with no licence numbers would otherwise produce twenty entries
 * saying the same thing, which is a wall rather than a list of what to do. "17 drivers are
 * missing a licence number" is the sentence somebody acts on, and it stays one line
 * however large the fleet is.
 */
function countGaps(
  leading: string[],
  counts: readonly [field: string, count: number, noun: string][],
): string[] {
  const lines = [...leading];
  for (const [field, count, noun] of counts) {
    if (count === 0) continue;
    lines.push(
      count === 1
        ? `One ${noun} is missing ${field}`
        : `${count} ${noun}s are missing ${field}`,
    );
  }
  return lines;
}

function customerSection(intake: LinkedIntake): ApplicationSection {
  const name = [intake.insured_first_name, intake.insured_last_name].filter(Boolean).join(' ');
  const missing: string[] = [];
  if (!present(name)) missing.push('Insured name');
  if (!present(intake.insured_phone_primary)) missing.push('Phone number');
  if (!present(intake.addr_street) && !present(intake.addr_city)) missing.push('Mailing address');

  return {
    key: 'customer',
    label: 'Customer',
    state: state(missing, present(name) || present(intake.insured_phone_primary)),
    summary:
      [name || null, intake.insured_phone_primary, intake.insured_email]
        .filter(Boolean)
        .join(' · ') || 'Nothing recorded',
    missing,
  };
}

function priorInsuranceSection(intake: LinkedIntake): ApplicationSection {
  const anything =
    present(intake.current_carrier) ||
    present(intake.prior_insurance) ||
    present(intake.current_expiration);
  const missing: string[] = [];
  if (!present(intake.prior_insurance)) missing.push('Whether there is prior insurance');
  if (intake.prior_insurance && !present(intake.current_carrier)) missing.push('Current carrier');
  if (intake.prior_lapse && !present(intake.prior_lapse_explanation)) {
    missing.push('Explanation for the lapse');
  }

  return {
    key: 'prior_insurance',
    label: 'Prior Insurance',
    state: state(missing, anything),
    summary:
      [
        intake.current_carrier,
        !present(intake.current_premium) ? null : `${formatMoney(intake.current_premium)} current`,
        intake.current_expiration ? `expires ${intake.current_expiration}` : null,
        intake.prior_lapse ? 'lapse recorded' : null,
      ]
        .filter(Boolean)
        .join(' · ') || 'No prior insurance recorded',
    missing,
  };
}

function truckingSections(intake: LinkedIntake): ApplicationSection[] {
  const businessMissing: string[] = [];
  if (!present(intake.business_name)) businessMissing.push('Business name');
  if (!present(intake.dot_number)) businessMissing.push('DOT number');
  if (!present(intake.years_in_business)) businessMissing.push('Years in business');
  if (!present(intake.ein)) businessMissing.push('FEIN');

  const operationsMissing: string[] = [];
  if (!present(intake.operation_types) && !present(intake.business_type)) {
    operationsMissing.push('Type of operation');
  }
  if (!present(intake.operating_radius_miles) && !present(intake.radius_band)) {
    operationsMissing.push('Operating radius');
  }
  if (!present(intake.states_of_operation) && !present(intake.farthest_states_cities)) {
    operationsMissing.push('States of operation');
  }
  if (!present(intake.power_unit_count)) operationsMissing.push('Power unit count');

  const driversMissing = countGaps(
    intake.drivers.length === 0 ? ['No drivers listed'] : [],
    [
      [
        'a licence number',
        intake.drivers.filter((d) => !present(d.license_number)).length,
        'driver',
      ],
      ['a date of birth', intake.drivers.filter((d) => !present(d.dob)).length, 'driver'],
      [
        'years of commercial driving experience',
        intake.drivers.filter((d) => d.cdl && !present(d.cdl_years_experience)).length,
        'CDL driver',
      ],
    ],
  );

  const vehiclesMissing = countGaps(
    intake.vehicles.length === 0 ? ['No units listed'] : [],
    [
      ['a VIN', intake.vehicles.filter((v) => !present(v.vin) && !v.vin_pending).length, 'unit'],
      ['a stated value', intake.vehicles.filter((v) => !present(v.physical_damage_value)).length, 'unit'],
    ],
  );

  const cargo = cargoProfile(intake);
  const coverage = requestedCoverage('trucking', intake);
  const coverageMissing = coverage
    .filter((entry) => entry.isCore && entry.value === null)
    .map((entry) => `${entry.label} limit`);

  const lossMissing: string[] = [];
  if (!present(intake.uw_losses_3yr)) {
    lossMissing.push('Whether there were losses in three years');
  }
  if (intake.uw_losses_3yr && !present(intake.uw_losses_3yr_detail)) {
    lossMissing.push('Detail of the losses');
  }
  if (!present(intake.uw_cancelled_nonrenewed)) {
    lossMissing.push('Whether a policy was cancelled or non-renewed');
  }

  return [
    customerSection(intake),
    {
      key: 'business',
      label: 'Business',
      state: state(businessMissing, present(intake.business_name)),
      summary:
        [
          intake.business_name,
          intake.dot_number ? `DOT ${intake.dot_number}` : null,
          intake.mc_number ? `MC ${intake.mc_number}` : null,
          !present(intake.years_in_business) ? null : `${intake.years_in_business} yrs in business`,
        ]
          .filter(Boolean)
          .join(' · ') || 'Nothing recorded',
      missing: businessMissing,
    },
    {
      key: 'operations',
      label: 'Operations',
      state: state(
        operationsMissing,
        present(intake.operation_types) || present(intake.business_type),
      ),
      summary:
        [
          present(intake.operation_types)
            ? operationTypesLabel(intake.operation_types)
            : intake.business_type,
          radiusBandLabel(intake.radius_band) ??
            (!present(intake.operating_radius_miles)
              ? null
              : `${intake.operating_radius_miles} mi radius`),
          !present(intake.power_unit_count) ? null : `${intake.power_unit_count} power units`,
          !present(intake.interstate) ? null : intake.interstate ? 'interstate' : 'intrastate',
        ]
          .filter(Boolean)
          .join(' · ') || 'Nothing recorded',
      missing: operationsMissing,
    },
    {
      key: 'drivers',
      label: 'Drivers',
      state: state(driversMissing, intake.drivers.length > 0),
      summary:
        intake.drivers.length === 0
          ? 'No drivers listed'
          : `${intake.drivers.length} driver${intake.drivers.length === 1 ? '' : 's'} · ${
              intake.drivers.filter((driver) => driver.cdl).length
            } with a CDL`,
      missing: driversMissing,
    },
    {
      key: 'vehicles',
      label: 'Vehicles',
      state: state(vehiclesMissing, intake.vehicles.length > 0),
      summary:
        intake.vehicles.length === 0
          ? 'No units listed'
          : [
              `${intake.vehicles.length} unit${intake.vehicles.length === 1 ? '' : 's'}`,
              intake.trailers.length === 0
                ? null
                : `${intake.trailers.length} trailer${intake.trailers.length === 1 ? '' : 's'}`,
            ]
              .filter(Boolean)
              .join(' · '),
      missing: vehiclesMissing,
    },
    {
      key: 'cargo',
      label: 'Cargo',
      state: state(cargo?.gaps ?? [], present(cargo?.primaryCategory)),
      summary:
        [
          cargo?.primaryCategory,
          cargo?.maximumLoadValue === null || cargo?.maximumLoadValue === undefined
            ? null
            : `max ${formatMoney(cargo.maximumLoadValue)} per load`,
        ]
          .filter(Boolean)
          .join(' · ') || 'Nothing recorded',
      missing: cargo?.gaps ?? [],
    },
    {
      key: 'coverage',
      label: 'Coverage',
      state: state(coverageMissing, coverage.some((entry) => entry.value !== null)),
      summary:
        coverage
          .filter((entry) => entry.value !== null)
          .map((entry) => `${entry.label} ${entry.value}`)
          .join(' · ') || 'Nothing requested yet',
      missing: coverageMissing,
    },
    priorInsuranceSection(intake),
    {
      key: 'loss_history',
      label: 'Loss History',
      state: state(lossMissing, present(intake.uw_losses_3yr)),
      summary:
        [
          !present(intake.uw_losses_3yr)
            ? null
            : intake.uw_losses_3yr
              ? 'Losses in the last three years'
              : 'No losses in the last three years',
          intake.uw_major_al_loss ? 'major auto liability loss' : null,
          intake.uw_coverage_lapse ? 'coverage lapse' : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'Nothing recorded',
      missing: lossMissing,
    },
  ];
}

function propertySections(intake: LinkedIntake): ApplicationSection[] {
  const propertyMissing: string[] = [];
  if (!present(intake.property_address_street)) propertyMissing.push('Property address');
  if (!present(intake.year_built)) propertyMissing.push('Year built');
  if (!present(intake.square_footage)) propertyMissing.push('Square footage');
  if (!present(intake.roof_type)) propertyMissing.push('Roof type');
  if (!present(intake.roof_age) && !present(intake.last_roof_update)) {
    propertyMissing.push('Roof age or last roof update');
  }
  if (intake.property_addr_verified === false) {
    propertyMissing.push('Address was typed by hand and not verified');
  }

  const coverage = requestedCoverage('homeowners', intake);
  const coverageMissing = coverage
    .filter((entry) => entry.isCore && entry.value === null)
    .map((entry) => `${entry.label} amount`);

  const lossMissing: string[] = [];
  if (!present(intake.prior_claims)) lossMissing.push('Whether there are prior claims');
  if (intake.prior_claims && !present(intake.prior_claims_detail)) {
    lossMissing.push('Detail of the prior claims');
  }

  return [
    customerSection(intake),
    {
      key: 'property',
      label: 'Property',
      state: state(propertyMissing, present(intake.property_address_street)),
      summary:
        [
          intake.property_formatted ??
            [intake.property_address_street, intake.property_address_city]
              .filter(Boolean)
              .join(', '),
          intake.dwelling_type,
          !present(intake.year_built) ? null : `built ${intake.year_built}`,
          !present(intake.square_footage) ? null : `${intake.square_footage} sq ft`,
        ]
          .filter(Boolean)
          .join(' · ') || 'Nothing recorded',
      missing: propertyMissing,
    },
    {
      key: 'coverage',
      label: 'Coverage',
      state: state(coverageMissing, coverage.some((entry) => entry.value !== null)),
      summary:
        coverage
          .filter((entry) => entry.value !== null)
          .map((entry) => `${entry.label} ${entry.value}`)
          .join(' · ') || 'Nothing requested yet',
      missing: coverageMissing,
    },
    priorInsuranceSection(intake),
    {
      key: 'loss_history',
      label: 'Loss History',
      state: state(lossMissing, present(intake.prior_claims)),
      summary: !present(intake.prior_claims)
        ? 'Nothing recorded'
        : intake.prior_claims
          ? (intake.prior_claims_detail ?? 'Prior claims recorded')
          : 'No prior claims',
      missing: lossMissing,
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Document grouping
// ═══════════════════════════════════════════════════════════════════════════════

export type DocumentGroupKey =
  | 'customer'
  | 'carrier_applications'
  | 'carrier_quotes'
  | 'underwriting'
  | 'other';

const DOCUMENT_GROUP_LABELS: Record<DocumentGroupKey, string> = {
  customer: 'Customer Documents',
  carrier_applications: 'Carrier Applications',
  carrier_quotes: 'Carrier Quotes',
  underwriting: 'Underwriting Documents',
  other: 'Other',
};

export const DOCUMENT_GROUP_ORDER: readonly DocumentGroupKey[] = [
  'customer',
  'carrier_applications',
  'carrier_quotes',
  'underwriting',
  'other',
] as const;

export function documentGroupLabel(group: DocumentGroupKey): string {
  return DOCUMENT_GROUP_LABELS[group];
}

/**
 * Which workspace group a stored category belongs to.
 *
 * The ten `specialty_documents.category` values stay exactly as they are in the
 * database. This is the reading that turns one flat attachment list into the five
 * shelves an agent looks on.
 */
export function documentGroup(category: string): DocumentGroupKey {
  switch (category) {
    case 'loss_runs':
    case 'declarations':
    case 'registration':
    case 'driver_license':
    case 'photos':
      return 'customer';
    case 'generated_application':
      return 'carrier_applications';
    case 'carrier_proposal':
    case 'quote_pdf':
      return 'carrier_quotes';
    case 'underwriting':
      return 'underwriting';
    default:
      return 'other';
  }
}

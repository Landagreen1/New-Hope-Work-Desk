/**
 * What each Application section lets you edit.
 *
 * One declaration per section, so the editor is a renderer rather than eight
 * hand-written forms. Every `key` here is a column `specialty_update_intake` accepts
 * — the server keeps its own allow-list and refuses anything else by name, so this
 * list is the offer and that list is the authority.
 *
 * The option tables come from the intake form itself. `auto_liability_limit` stores
 * `1000000`, not `$1,000,000`, and `radius_band` stores `51_100`; a second table of
 * those keys living here is how the two screens would start writing values the other
 * cannot read.
 */

import { COMMODITY_CATEGORIES } from '../../cs-intake/CargoSection';
import { AUTO_LIABILITY_LIMITS } from '../../cs-intake/RequestedCoveragesSection';
import { RADIUS_BANDS, TRUCKING_OPERATION_TYPES } from '../../cs-intake/TruckingSection';
import type { SectionKey } from '../application';
import type { SpecialtyLine } from '../types';

export type IntakeFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'money'
  | 'date'
  | 'select'
  /** Yes / No / not recorded. Writes true, false or null — null is a real answer. */
  | 'boolean'
  /** Yes / No / Unsure, stored as text. Unsure is honest and must survive. */
  | 'tristate'
  /** A `text[]` column, edited as a checkbox group. */
  | 'multiselect';

export interface IntakeFieldSpec {
  key: string;
  label: string;
  type: IntakeFieldType;
  options?: readonly { value: string; label: string }[];
  hint?: string;
  /** Spans the grid. For textareas and long checkbox groups. */
  wide?: boolean;
}

const YES_NO_UNSURE = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'unsure', label: 'Unsure' },
] as const;

const AUTO_LIABILITY_OPTIONS = AUTO_LIABILITY_LIMITS.map((option) => ({
  value: option.key,
  label: option.label,
}));

const RADIUS_OPTIONS = RADIUS_BANDS.map((band) => ({ value: band.key, label: band.label }));

const OPERATION_OPTIONS = TRUCKING_OPERATION_TYPES.map((entry) => ({
  value: entry.key,
  label: entry.label,
}));

const COMMODITY_OPTIONS = COMMODITY_CATEGORIES.map((entry) => ({
  value: entry.key,
  label: entry.label,
}));

// ── Sections ─────────────────────────────────────────────────────────────────

const CUSTOMER_FIELDS: IntakeFieldSpec[] = [
  { key: 'insured_first_name', label: 'First name', type: 'text' },
  { key: 'insured_middle_name', label: 'Middle name', type: 'text' },
  { key: 'insured_last_name', label: 'Last name', type: 'text' },
  { key: 'insured_dob', label: 'Date of birth', type: 'date' },
  { key: 'insured_phone_primary', label: 'Phone', type: 'text' },
  { key: 'insured_phone_alt', label: 'Alternate phone', type: 'text' },
  { key: 'insured_email', label: 'Email', type: 'text' },
  { key: 'preferred_language', label: 'Preferred language', type: 'text' },
  { key: 'addr_street', label: 'Mailing street', type: 'text' },
  { key: 'addr_unit', label: 'Unit / apt', type: 'text' },
  { key: 'addr_city', label: 'City', type: 'text' },
  { key: 'addr_state', label: 'State', type: 'text' },
  { key: 'addr_zip', label: 'ZIP', type: 'text' },
  { key: 'csr_notes', label: 'Notes from Customer Service', type: 'textarea', wide: true },
];

const BUSINESS_FIELDS: IntakeFieldSpec[] = [
  { key: 'business_name', label: 'Business name', type: 'text' },
  { key: 'ein', label: 'FEIN', type: 'text', hint: 'Printed as FEIN on carrier applications.' },
  { key: 'dot_number', label: 'DOT number', type: 'text' },
  { key: 'mc_number', label: 'MC number', type: 'text' },
  { key: 'mcs150_date', label: 'MCS-150 date', type: 'date' },
  { key: 'years_in_business', label: 'Years in business', type: 'number' },
];

const OPERATIONS_FIELDS: IntakeFieldSpec[] = [
  {
    key: 'operation_types',
    label: 'Type of operation',
    type: 'multiselect',
    options: OPERATION_OPTIONS,
    wide: true,
  },
  {
    key: 'operation_description',
    label: 'What do they actually haul and where?',
    type: 'textarea',
    wide: true,
    hint: 'The sentence an underwriter reads first. Specific beats short.',
  },
  { key: 'radius_band', label: 'Operating radius', type: 'select', options: RADIUS_OPTIONS },
  {
    key: 'farthest_states_cities',
    label: 'Farthest states or cities',
    type: 'text',
    hint: 'Asked when the radius is 500+ miles.',
  },
  { key: 'states_of_operation', label: 'States of operation', type: 'text' },
  { key: 'power_unit_count', label: 'Power units', type: 'number' },
  /*
   * The two legacy columns, kept editable.
   *
   * `operation_types` and `radius_band` above superseded them, and the intake form keeps
   * them in step when it writes. A quote migrated from the Commercial Board, or one taken
   * before v1.19.2, can carry a wrong value in either — and a field the workspace displays
   * but cannot correct is a dead end. Both are still in the server's allow-list.
   */
  {
    key: 'business_type',
    label: 'Type of operation (legacy)',
    type: 'text',
    hint: 'Superseded by the checkboxes above. Editable so a migrated quote can be corrected.',
  },
  {
    key: 'operating_radius_miles',
    label: 'Operating radius in miles (legacy)',
    type: 'number',
    hint: 'Superseded by the radius band above, and derived from it when the intake form saves.',
  },
  { key: 'interstate', label: 'Interstate?', type: 'boolean' },
  { key: 'for_hire', label: 'For hire?', type: 'boolean' },
  { key: 'owns_or_leases_trailers', label: 'Owns or leases trailers?', type: 'boolean' },
  { key: 'owner_operator_count', label: 'Owner-operators', type: 'number' },
  { key: 'desired_effective_date', label: 'Desired effective date', type: 'date' },
];

/**
 * Cargo.
 *
 * The section that most needs structure. "Dry freight" is what gets typed and it is
 * not something a carrier can rate, so the category, the commodity mix, the per-load
 * values and the prohibited-cargo answers are all asked for by name.
 */
const CARGO_FIELDS: IntakeFieldSpec[] = [
  {
    key: 'primary_commodity',
    label: 'Primary commodity category',
    type: 'select',
    options: COMMODITY_OPTIONS,
    hint: 'The single category that describes most of what they haul.',
  },
  {
    key: 'cargo_description',
    label: 'Typical commodities, in the customer\u2019s own words',
    type: 'textarea',
    wide: true,
    hint: 'e.g. "Packaged foods, paper products and consumer goods on pallets" — not "dry freight".',
  },
  { key: 'typical_load_value', label: 'Typical value per load', type: 'money' },
  { key: 'max_load_value', label: 'Maximum value per load', type: 'money' },
  { key: 'cargo_coverage_desired', label: 'Cargo coverage wanted?', type: 'boolean' },
  { key: 'requested_cargo_limit', label: 'Requested cargo limit', type: 'money' },
  { key: 'cargo_deductible', label: 'Cargo deductible', type: 'money' },
  { key: 'refrigerated', label: 'Hauls refrigerated cargo?', type: 'boolean' },
  {
    key: 'temperature_controlled_equipment',
    label: 'Temperature-controlled equipment?',
    type: 'boolean',
  },
  { key: 'reefer_breakdown_requested', label: 'Refrigeration breakdown wanted?', type: 'tristate' },
  { key: 'hazmat', label: 'Hazardous materials?', type: 'tristate' },
  { key: 'hazmat_detail', label: 'Hazmat detail', type: 'textarea', wide: true },
  { key: 'broker_load_board', label: 'Works brokers or load boards?', type: 'boolean' },
  { key: 'commodity_mix_known', label: 'Is the commodity mix known?', type: 'boolean' },
  {
    key: 'cargo_type',
    label: 'Legacy cargo type',
    type: 'text',
    hint: 'The old free-text field. Kept editable so a migrated quote can be corrected; prefer the category above.',
  },
];

const TRUCKING_COVERAGE_FIELDS: IntakeFieldSpec[] = [
  {
    key: 'auto_liability_limit',
    label: 'Auto Liability limit',
    type: 'select',
    options: AUTO_LIABILITY_OPTIONS,
  },
  {
    key: 'auto_liability_limit_other',
    label: 'Other Auto Liability limit',
    type: 'text',
    hint: 'Used when the limit above is Other. e.g. $2,000,000 CSL',
  },
  { key: 'um_uim_limit', label: 'UM / UIM limit', type: 'text', hint: 'e.g. $100,000 or Rejected' },
  { key: 'hired_auto', label: 'Hired auto?', type: 'tristate' },
  { key: 'non_owned_auto', label: 'Non-owned auto?', type: 'tristate' },
  {
    key: 'physical_damage_needed',
    label: 'Physical Damage wanted?',
    type: 'boolean',
    hint: 'Each unit\u2019s stated value is entered on that unit.',
  },
  {
    key: 'physical_damage_deductible_requested',
    label: 'Physical Damage deductible',
    type: 'text',
  },
  { key: 'pd_comprehensive', label: 'Comprehensive', type: 'boolean' },
  { key: 'pd_collision', label: 'Collision', type: 'boolean' },
  { key: 'pd_specified_causes', label: 'Specified causes of loss', type: 'boolean' },
  { key: 'pulls_non_owned_trailers', label: 'Pulls non-owned trailers?', type: 'boolean' },
  {
    key: 'trailer_interchange_agreement',
    label: 'Written interchange agreement?',
    type: 'boolean',
    hint: 'Most carriers will not write Trailer Interchange without one.',
  },
  { key: 'trailer_interchange_limit', label: 'Trailer Interchange limit', type: 'text' },
  { key: 'trailer_interchange_deductible', label: 'Trailer Interchange deductible', type: 'text' },
  { key: 'general_liability_requested', label: 'General Liability wanted?', type: 'boolean' },
  { key: 'general_liability_limit', label: 'General Liability limit', type: 'text' },
  { key: 'medical_payments_requested', label: 'Medical Payments wanted?', type: 'boolean' },
  { key: 'medical_payments_limit', label: 'Medical Payments limit', type: 'text' },
  {
    key: 'additional_coverages_other',
    label: 'Anything else requested',
    type: 'textarea',
    wide: true,
  },
];

const PROPERTY_COVERAGE_FIELDS: IntakeFieldSpec[] = [
  { key: 'coverage_amount', label: 'Dwelling coverage', type: 'money' },
  {
    key: 'coverage_type',
    label: 'Policy form',
    type: 'select',
    options: [
      { value: 'Homeowners', label: 'Homeowners' },
      { value: 'Landlord', label: 'Landlord' },
      { value: 'Mobile Home', label: 'Mobile Home' },
    ],
  },
  { key: 'liability_limit', label: 'Personal Liability limit', type: 'text' },
  { key: 'desired_coverage', label: 'Also requested', type: 'textarea', wide: true },
];

const PROPERTY_FIELDS: IntakeFieldSpec[] = [
  { key: 'property_address_street', label: 'Property street', type: 'text' },
  { key: 'property_address_unit', label: 'Unit / apt', type: 'text' },
  { key: 'property_address_city', label: 'City', type: 'text' },
  { key: 'property_address_state', label: 'State', type: 'text' },
  { key: 'property_address_zip', label: 'ZIP', type: 'text' },
  { key: 'dwelling_type', label: 'Dwelling type', type: 'text' },
  { key: 'year_built', label: 'Year built', type: 'number' },
  { key: 'square_footage', label: 'Square footage', type: 'number' },
  { key: 'roof_type', label: 'Roof type', type: 'text' },
  { key: 'roof_age', label: 'Roof age (years)', type: 'number' },
  {
    key: 'last_roof_update',
    label: 'Last roof update',
    type: 'text',
    hint: 'Free text — a year, an approximation, or a note. Not a date.',
  },
];

const PRIOR_INSURANCE_FIELDS: IntakeFieldSpec[] = [
  { key: 'prior_insurance', label: 'Has prior insurance?', type: 'boolean' },
  { key: 'current_carrier', label: 'Current carrier', type: 'text' },
  { key: 'current_policy_number', label: 'Policy number', type: 'text' },
  { key: 'current_premium', label: 'Current premium', type: 'money' },
  { key: 'current_expiration', label: 'Expires', type: 'date' },
  { key: 'months_continuous_coverage', label: 'Months of continuous coverage', type: 'number' },
  { key: 'prior_lapse', label: 'Was there a lapse?', type: 'boolean' },
  {
    key: 'prior_lapse_explanation',
    label: 'Explanation for the lapse',
    type: 'textarea',
    wide: true,
  },
];

const TRUCKING_LOSS_FIELDS: IntakeFieldSpec[] = [
  { key: 'uw_losses_3yr', label: 'Losses in the last three years?', type: 'boolean' },
  { key: 'uw_losses_3yr_detail', label: 'Loss detail', type: 'textarea', wide: true },
  { key: 'uw_major_al_loss', label: 'Major auto liability loss?', type: 'boolean' },
  { key: 'uw_major_al_loss_detail', label: 'Major loss detail', type: 'textarea', wide: true },
  { key: 'uw_cancelled_nonrenewed', label: 'Cancelled or non-renewed?', type: 'boolean' },
  {
    key: 'uw_cancelled_nonrenewed_detail',
    label: 'Cancellation detail',
    type: 'textarea',
    wide: true,
  },
  { key: 'uw_coverage_lapse', label: 'Coverage lapse?', type: 'boolean' },
  { key: 'uw_coverage_lapse_detail', label: 'Lapse detail', type: 'textarea', wide: true },
  { key: 'uw_owner_operators', label: 'Uses owner-operators?', type: 'boolean' },
  {
    key: 'uw_owner_operators_detail',
    label: 'Owner-operator detail',
    type: 'textarea',
    wide: true,
  },
];

const PROPERTY_LOSS_FIELDS: IntakeFieldSpec[] = [
  { key: 'prior_claims', label: 'Prior claims?', type: 'boolean' },
  { key: 'prior_claims_detail', label: 'Claims detail', type: 'textarea', wide: true },
];

/** The fields one section offers. Drivers and vehicles have their own editors. */
export function fieldsForSection(
  section: SectionKey,
  line: SpecialtyLine,
): IntakeFieldSpec[] {
  switch (section) {
    case 'customer':
      return CUSTOMER_FIELDS;
    case 'business':
      return BUSINESS_FIELDS;
    case 'operations':
      return OPERATIONS_FIELDS;
    case 'cargo':
      return CARGO_FIELDS;
    case 'coverage':
      return line === 'trucking' ? TRUCKING_COVERAGE_FIELDS : PROPERTY_COVERAGE_FIELDS;
    case 'property':
      return PROPERTY_FIELDS;
    case 'prior_insurance':
      return PRIOR_INSURANCE_FIELDS;
    case 'loss_history':
      return line === 'trucking' ? TRUCKING_LOSS_FIELDS : PROPERTY_LOSS_FIELDS;
    // Drivers and vehicles are rows, not fields. They are edited row by row.
    case 'drivers':
    case 'vehicles':
      return [];
  }
}

/** The commodity categories, for the cargo breakdown editor. */
export { COMMODITY_OPTIONS as COMMODITY_CATEGORY_OPTIONS, YES_NO_UNSURE };

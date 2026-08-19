/**
 * Market Directory types.
 *
 * The Market Directory is a reusable master record of submission targets (carriers,
 * brokers, MGAs, wholesalers). It is separate from the per-quote specialty_carriers
 * table (which remains the carrier picker for existing Carrier Markets).
 *
 * v1.17.0
 */

export type MarketType =
  | 'direct_carrier'
  | 'broker'
  | 'mga'
  | 'wholesaler'
  | 'program_administrator'
  | 'other';

export type RequirementType = 'data' | 'document' | 'application';

export type QuestionFieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'currency'
  | 'percentage'
  | 'date'
  | 'yes_no'
  | 'select';

export type GeneratedApplicationStatus =
  | 'review_required'
  | 'approved'
  | 'submitted'
  | 'superseded';

export type ReadinessState =
  | 'ready'
  | 'missing_information'
  | 'missing_documents'
  | 'review_required';

// ── Market Directory ─────────────────────────────────────────────────────────

export interface MarketDirectoryEntry {
  id: string;
  name: string;
  market_type: MarketType;
  lines_of_business: string[];
  is_active: boolean;
  website_url: string | null;
  portal_url: string | null;
  submission_email: string | null;
  phone: string | null;
  submission_instructions: string | null;
  territory_notes: string | null;
  equipment_notes: string | null;
  new_venture_notes: string | null;
  coverage_appetite: string | null;
  underwriting_notes: string | null;
  created_at: string;
  updated_at: string;
  // Joined data
  aliases: MarketAlias[];
  contacts: MarketContact[];
}

export interface MarketAlias {
  id: string;
  market_id: string;
  alias: string;
}

export interface MarketContact {
  id: string;
  market_id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  is_primary: boolean;
  is_active: boolean;
}

// ── Market Requirements ──────────────────────────────────────────────────────

export interface MarketRequirement {
  id: string;
  market_id: string;
  line_of_business: string;
  requirement_type: RequirementType;
  label: string;
  description: string | null;
  is_required: boolean;
  is_active: boolean;
  sort_order: number;
}

export interface RequirementSatisfaction {
  id: string;
  carrier_market_id: string;
  requirement_id: string;
  is_satisfied: boolean;
  satisfied_by: string | null;
  satisfied_at: string | null;
  document_id: string | null;
  data_value: string | null;
  notes: string | null;
}

// ── Market Questions ─────────────────────────────────────────────────────────

export interface MarketQuestion {
  id: string;
  market_id: string;
  line_of_business: string;
  question_text: string;
  field_type: QuestionFieldType;
  select_options: string[] | null;
  is_required: boolean;
  is_active: boolean;
  sort_order: number;
  auto_fill_source: string | null;
}

export interface MarketQuestionAnswer {
  id: string;
  carrier_market_id: string;
  question_id: string;
  answer_value: string | null;
  answered_by: string | null;
  answered_at: string | null;
}

// ── Underwriting Results ─────────────────────────────────────────────────────

export interface UnderwritingResult {
  id: string;
  carrier_market_id: string;
  underwriting_carrier: string;
  coverage_type: string;
  premium: number | null;
  fees: number | null;
  down_payment: number | null;
  installment_count: number | null;
  installment_amount: number | null;
  limits: string | null;
  deductible: string | null;
  quote_reference_number: string | null;
  notes: string | null;
  proposal_document_id: string | null;
  recorded_by: string;
  created_at: string;
  updated_at: string;
}

// ── PDF Templates ────────────────────────────────────────────────────────────

export interface MarketPdfTemplate {
  id: string;
  market_id: string;
  line_of_business: string;
  template_name: string;
  version_label: string;
  is_active: boolean;
  storage_bucket: string;
  storage_path: string | null;
  field_mapping: Record<string, unknown>;
  total_pages: number | null;
  max_drivers: number | null;
  max_vehicles: number | null;
  max_trailers: number | null;
  created_at: string;
  updated_at: string;
}

// ── Generated Applications ───────────────────────────────────────────────────

export interface GeneratedApplication {
  id: string;
  carrier_market_id: string;
  template_id: string;
  opportunity_id: string;
  storage_bucket: string;
  storage_path: string;
  file_name: string;
  file_size: number | null;
  generated_by: string;
  generated_by_name?: string | null;
  generated_at: string;
  generation_version: number;
  source_data_hash: string | null;
  is_submitted: boolean;
  submitted_by: string | null;
  submitted_at: string | null;
  status: GeneratedApplicationStatus;
  notes: string | null;
  template_name?: string;
}

// ── Readiness ────────────────────────────────────────────────────────────────

export interface ReadinessInfo {
  state: ReadinessState;
  total_requirements: number;
  satisfied_requirements: number;
  missing_items: ReadinessMissingItem[];
}

export interface ReadinessMissingItem {
  requirement_id: string;
  label: string;
  requirement_type: RequirementType;
  is_required: boolean;
}

// ── Trucking Data Adapter ────────────────────────────────────────────────────

export interface TruckingDataPacket {
  business: TruckingBusiness;
  owners: TruckingOwner[];
  drivers: TruckingDriver[];
  vehicles: TruckingVehicle[];
  /** Scheduled trailers (v1.19.2). Rated separately from power units. */
  trailers: TruckingTrailer[];
  /** Per-commodity detail (v1.19.2). `operations.commodities` stays the summary string. */
  commodities: TruckingCommodity[];
  operations: TruckingOperations;
  coverages: TruckingCoverages;
  /** The standard carrier eligibility answers (v1.19.2). */
  underwriting: TruckingUnderwriting;
  prior_insurance: TruckingPriorInsurance;
}

export interface TruckingBusiness {
  legal_name: string | null;
  dba: string | null;
  entity_type: string | null;
  mailing_street: string | null;
  mailing_unit: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  garaging_street: string | null;
  garaging_city: string | null;
  garaging_state: string | null;
  garaging_zip: string | null;
  phone: string | null;
  email: string | null;
  dot_number: string | null;
  mc_number: string | null;
  fein: string | null;
  years_in_business: number | null;
  years_experience: number | null;
}

export interface TruckingOwner {
  name: string | null;
  dob: string | null;
  license_number: string | null;
  license_state: string | null;
  ownership_percentage: number | null;
}

export interface TruckingDriver {
  position: number;
  first_name: string | null;
  last_name: string | null;
  /** Convenience: "First Last", already joined for form rows. */
  full_name: string | null;
  dob: string | null;
  license_number: string | null;
  license_state: string | null;
  license_status: string | null;
  years_licensed: number | null;
  /** CDL years where known, falling back to years licensed. */
  experience: number | null;
  sr22_required: boolean;
  // ── v1.19.2 ───────────────────────────────────────────────────────────────
  cdl: boolean | null;
  cdl_date: string | null;
  cdl_years_experience: number | null;
  owner_operator: boolean | null;
  accidents_36mo: boolean | null;
  accidents_detail: string | null;
  violations_36mo: boolean | null;
  violations_detail: string | null;
  /**
   * Accident and violation history combined into one line, because the carrier
   * forms give a single narrow column for it.
   */
  violation_accident_summary: string | null;
}

export interface TruckingVehicle {
  position: number;
  year: number | null;
  make: string | null;
  model: string | null;
  /** Body type as printed on carrier forms (Tractor, Box Truck, Flatbed...). */
  type: string | null;
  vin: string | null;
  /** Actual cash value. Drives Physical Damage rating. */
  value: number | null;
  gvw: number | null;
  radius: number | null;
  // ── v1.19.2 ───────────────────────────────────────────────────────────────
  /** How the unit is operated (Long Haul, Regional, Local...). */
  usage: string | null;
  /** Owned / Financed / Leased, already title-cased for the form. */
  ownership: string | null;
  lessor_name: string | null;
  lessor_address: string | null;
  physical_damage_deductible: number | null;
  annual_mileage: number | null;
  garaging_zip: string | null;
}

export interface TruckingTrailer {
  position: number;
  year: number | null;
  make: string | null;
  /** Body type label (Dry Van, Flatbed, Reefer...). */
  type: string | null;
  vin: string | null;
  value: number | null;
  ownership: string | null;
  lessor_name: string | null;
  lessor_address: string | null;
}

export interface TruckingCommodity {
  /** Human label, not the stored key. */
  description: string | null;
  frequency: string | null;
  is_primary: boolean;
  percent_hauled: number | null;
  average_value: number | null;
  maximum_value: number | null;
}

/**
 * The eligibility answers every trucking carrier asks. `*_detail` is only
 * meaningful when its answer is Yes.
 */
export interface TruckingUnderwriting {
  coverage_lapse: boolean | null;
  coverage_lapse_detail: string | null;
  cancelled_nonrenewed: boolean | null;
  cancelled_nonrenewed_detail: string | null;
  losses_3yr: boolean | null;
  losses_3yr_detail: string | null;
  major_al_loss: boolean | null;
  major_al_loss_detail: string | null;
  /** Yes / No / Not Sure, as stored. */
  hazmat: string | null;
  hazmat_detail: string | null;
  owner_operators: boolean | null;
  owner_operators_detail: string | null;
  owner_operator_count: number | null;
}

export interface TruckingOperations {
  /** Summary string of what is hauled. See `commodities` for the breakdown. */
  commodities: string | null;
  radius: number | null;
  states: string | null;
  revenue: number | null;
  mileage: number | null;
  brokerage_percentage: number | null;
  interstate: boolean | null;
  for_hire: boolean | null;
  owner_operators: number | null;
  // ── v1.19.2 ───────────────────────────────────────────────────────────────
  /** Joined operation-type labels (Long Haul, Dump, Auto Hauling...). */
  operation_types: string | null;
  operation_description: string | null;
  /** The radius band label, e.g. "201-300 miles". */
  radius_band: string | null;
  farthest_states_cities: string | null;
  desired_effective_date: string | null;
  power_unit_count: number | null;
  /** True when the customer pulls trailers they do not own. */
  pulls_non_owned_trailers: boolean | null;
}

export interface TruckingCoverages {
  auto_liability_limit: string | null;
  cargo_limit: string | null;
  cargo_deductible: string | null;
  physical_damage: boolean | null;
  general_liability: boolean | null;
  trailer_interchange: boolean | null;
  comprehensive_deductible: string | null;
  collision_deductible: string | null;
  medical_payments: string | null;
  // ── v1.19.2 ───────────────────────────────────────────────────────────────
  um_uim_limit: string | null;
  /** Yes / No / Not Sure. */
  hired_auto: string | null;
  non_owned_auto: string | null;
  /** The explicit answer, rather than inferring PD from vehicle values. */
  physical_damage_requested: boolean | null;
  physical_damage_deductible: string | null;
  pd_comprehensive: boolean | null;
  pd_collision: boolean | null;
  pd_specified_causes: boolean | null;
  trailer_interchange_limit: string | null;
  trailer_interchange_deductible: string | null;
  /** Whether a written interchange agreement is in place. */
  trailer_interchange_agreement: boolean | null;
  general_liability_limit: string | null;
  medical_payments_requested: boolean | null;
  additional_coverages_other: string | null;
  /** Highest single-load value, used to sanity-check the cargo limit. */
  max_load_value: number | null;
  typical_load_value: number | null;
  reefer_breakdown_requested: string | null;
}

export interface TruckingPriorInsurance {
  carrier: string | null;
  policy_number: string | null;
  premium: number | null;
  expiration: string | null;
  lapse: boolean | null;
  /** Why the coverage lapsed. Carriers always ask when lapse is Yes. */
  lapse_explanation: string | null;
  months_continuous_coverage: number | null;
}

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
  operations: TruckingOperations;
  coverages: TruckingCoverages;
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
  dob: string | null;
  license_number: string | null;
  license_state: string | null;
  license_status: string | null;
  years_licensed: number | null;
  experience: number | null;
  sr22_required: boolean;
}

export interface TruckingVehicle {
  position: number;
  year: number | null;
  make: string | null;
  model: string | null;
  type: string | null;
  vin: string | null;
  value: number | null;
  gvw: number | null;
  radius: number | null;
}

export interface TruckingOperations {
  commodities: string | null;
  radius: number | null;
  states: string | null;
  revenue: number | null;
  mileage: number | null;
  brokerage_percentage: number | null;
  interstate: boolean | null;
  for_hire: boolean | null;
  owner_operators: number | null;
}

export interface TruckingCoverages {
  auto_liability_limit: string | null;
  cargo_limit: string | null;
  physical_damage: boolean | null;
  general_liability: boolean | null;
  trailer_interchange: boolean | null;
  comprehensive_deductible: string | null;
  collision_deductible: string | null;
}

export interface TruckingPriorInsurance {
  carrier: string | null;
  policy_number: string | null;
  premium: number | null;
  expiration: string | null;
  lapse: boolean | null;
}

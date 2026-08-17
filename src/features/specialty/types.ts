/**
 * Specialty Quotes types.
 *
 * These mirror the return shapes of the `specialty_*` RPCs in
 * supabase/migrations/v1.16.0 … v1.16.6. Field names stay in the database's
 * snake_case so there is no silent translation layer: a rename on one side that the
 * other does not know about fails at the type level rather than arriving as
 * undefined at runtime.
 */

/** The nine shared workflow stages. One vocabulary for every line of business. */
export type SpecialtyStage =
  | 'new'
  | 'information_needed'
  | 'ready_to_market'
  | 'marketing'
  | 'options_ready'
  | 'price_sent'
  | 'follow_up'
  | 'sold'
  | 'not_sold';

/** Lines of business the engine supports. `commercial_gl` is architecturally
 *  permitted and deliberately not routed here — Commercial keeps its own board. */
export type SpecialtyLine = 'trucking' | 'homeowners' | 'commercial_gl';

export type SpecialtyPriority = 'normal' | 'high' | 'urgent';

export type SpecialtyResult = 'sold' | 'not_sold';

export type SpecialtyLostReason =
  | 'price_too_high'
  | 'stayed_with_current_carrier'
  | 'customer_stopped_responding'
  | 'competitor'
  | 'ineligible'
  | 'unable_to_place'
  | 'customer_postponed'
  | 'duplicate'
  | 'other';

export type CarrierMarketStatus =
  | 'not_started'
  | 'preparing'
  | 'submitted'
  | 'waiting'
  | 'more_info_needed'
  | 'quote_received'
  | 'declined'
  | 'not_competitive'
  | 'withdrawn';

export type InformationStatus = 'needed' | 'requested' | 'received' | 'waived';

export type DocumentCategory =
  | 'loss_runs'
  | 'declarations'
  | 'registration'
  | 'driver_license'
  | 'carrier_proposal'
  | 'quote_pdf'
  | 'photos'
  | 'underwriting'
  | 'other'
  | 'generated_application';

export type PriceMethod = 'phone' | 'whatsapp' | 'sms' | 'email' | 'in_person' | 'other';

export type AssignmentMethod =
  | 'shared_claim'
  | 'manual_assignment'
  | 'automatic_balanced'
  | 'round_robin';

/**
 * The saved views. `team` is the default because the team works together — an
 * employee lands on all of the team's work and narrows to their own by choice.
 * `mine` is a workload filter, never an access boundary.
 */
export type SpecialtyView =
  | 'team'
  | 'mine'
  | 'unclaimed'
  | 'due_today'
  | 'overdue'
  | 'stale'
  | 'closed';

/** One row of the operational list: exactly what a summary card shows. */
export interface SpecialtyRow {
  id: string;
  reference: string;
  line_of_business: SpecialtyLine;
  team_id: string;
  team_name: string;
  stage: SpecialtyStage;
  stage_label: string;
  priority: SpecialtyPriority;
  display_name: string;
  business_name: string | null;
  primary_assignee_id: string | null;
  assignee_name: string | null;
  assignee_initials: string | null;
  next_action: string | null;
  next_action_due: string | null;
  result: SpecialtyResult | null;
  lost_reason: SpecialtyLostReason | null;
  sold_premium: number | null;
  bound_carrier_name: string | null;
  source: string;
  source_intake_id: string | null;
  legacy_commercial_quote_id: string | null;
  customer_phone: string | null;
  customer_city: string | null;
  customer_state: string | null;
  dot_number: string | null;
  mc_number: string | null;
  property_address: string | null;
  created_at: string;
  claimed_at: string | null;
  price_sent_at: string | null;
  finalized_at: string | null;
  last_activity_at: string;
  markets_total: number;
  markets_submitted: number;
  markets_quoted: number;
  markets_declined: number;
  markets_waiting: number;
  markets_info_needed: number;
  best_premium: number | null;
  next_carrier_follow_up: string | null;
  open_information_count: number;
  open_information_labels: string | null;
  checklist_total: number;
  checklist_done: number;
  notes_count: number;
  documents_count: number;
  is_overdue: boolean;
  is_due_today: boolean;
  is_unclaimed: boolean;
  is_stale: boolean;
  version: number;
  /** Total matches across all pages, so the list can show "showing N of M". */
  total_count: number;
}

export interface CarrierMarket {
  id: string;
  carrier_id: string;
  carrier_name: string;
  status: CarrierMarketStatus;
  handled_by: string | null;
  handled_by_name: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  submitted_by_name: string | null;
  last_action_at: string;
  last_action_by_name: string | null;
  follow_up_date: string | null;
  premium: number | null;
  down_payment: number | null;
  payment_terms: string | null;
  deductible: string | null;
  coverage_notes: string | null;
  installment_count: number | null;
  installment_amount: number | null;
  quote_received_at: string | null;
  quote_received_by_name: string | null;
  decline_reason: string | null;
  info_requested: string | null;
  notes: string | null;
  presented_at: string | null;
  document_count: number;
  version: number;
}

export interface ChecklistItem {
  id: string;
  category: string;
  label: string;
  position: number;
  is_required: boolean;
  is_custom: boolean;
  is_checked: boolean;
  checked_at: string | null;
  checked_by_name: string | null;
}

export interface InformationRequest {
  id: string;
  label: string;
  status: InformationStatus;
  note: string | null;
  visible_to_cs: boolean;
  requested_at: string | null;
  requested_by_name: string | null;
  resolved_at: string | null;
  resolved_by_name: string | null;
}

export interface SpecialtyNote {
  id: string;
  content: string;
  created_at: string;
  author_id: string;
  author_name: string | null;
  author_initials: string | null;
  carrier_market_id: string | null;
  is_cs_visible: boolean;
}

export interface SpecialtyDocument {
  id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  category: DocumentCategory;
  storage_bucket: string;
  storage_path: string;
  carrier_market_id: string | null;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
  is_legacy: boolean;
}

export interface PricePresentationOption {
  carrier_market_id: string;
  carrier_id: string;
  carrier_name: string;
  premium: number | null;
  down_payment: number | null;
  payment_terms: string | null;
  deductible: string | null;
}

export interface PricePresentation {
  id: string;
  presented_at: string;
  method: PriceMethod | null;
  note: string | null;
  options: PricePresentationOption[];
  presented_by: string;
  presented_by_name: string | null;
}

/**
 * Someone who has actually done something on this quote.
 *
 * Derived from recorded activity, not from the assignment. The primary assignee
 * appears here only if they have in fact acted.
 */
export interface Contributor {
  profile_id: string;
  display_name: string;
  initials: string;
  action_count: number;
  last_action_at: string;
  is_primary_assignee: boolean;
}

/** The linked CS intake, read live. The specialty side keeps no second copy. */
export interface LinkedIntake {
  id: string;
  status: string;
  line_of_business: string;
  version: number;
  insured_first_name: string | null;
  insured_middle_name: string | null;
  insured_last_name: string | null;
  insured_dob: string | null;
  insured_email: string | null;
  insured_phone_primary: string | null;
  insured_phone_alt: string | null;
  preferred_language: string | null;
  preferred_contact: string | null;
  addr_street: string | null;
  addr_unit: string | null;
  addr_city: string | null;
  addr_state: string | null;
  addr_zip: string | null;
  current_carrier: string | null;
  current_policy_number: string | null;
  current_premium: number | null;
  current_expiration: string | null;
  prior_insurance: boolean | null;
  prior_lapse: boolean | null;
  csr_notes: string | null;
  business_name: string | null;
  business_type: string | null;
  years_in_business: number | null;
  dot_number: string | null;
  mc_number: string | null;
  mcs150_date: string | null;
  cargo_type: string | null;
  power_unit_count: number | null;
  operating_radius_miles: number | null;
  states_of_operation: string | null;
  property_address_street: string | null;
  property_address_city: string | null;
  property_address_state: string | null;
  property_address_zip: string | null;
  dwelling_type: string | null;
  year_built: number | null;
  square_footage: number | null;
  roof_type: string | null;
  roof_age: number | null;
  coverage_amount: number | null;
  prior_claims: boolean | null;
  prior_claims_detail: string | null;
  desired_coverage: string | null;
  liability_limit: string | null;
  comprehensive_deductible: string | null;
  collision_deductible: string | null;
  created_by_name: string | null;
  submitted_at: string | null;
  // Cargo / Commodity Classification (v1.18.0+)
  primary_commodity: string | null;
  cargo_description: string | null;
  broker_load_board: boolean | null;
  commodity_mix_known: boolean | null;
  typical_load_value: number | null;
  max_load_value: number | null;
  requested_cargo_limit: number | null;
  cargo_deductible: number | null;
  refrigerated: boolean | null;
  temperature_controlled_equipment: boolean | null;
  reefer_breakdown_requested: string | null;
  hazmat: string | null;
  high_value_cargo_flag: boolean | null;
  cargo_coverage_desired: boolean | null;
  excluded_cargo: Record<string, string> | null;
  commodities: IntakeCommodityRow[];
  drivers: IntakeDriverRow[];
  vehicles: IntakeVehicleRow[];
  owners: Record<string, unknown>[];
}

export interface IntakeCommodityRow {
  category: string;
  frequency: string;
  is_primary: boolean;
}

export interface IntakeVehicleRow {
  id?: string;
  position: number;
  year: number | null;
  make: string | null;
  model: string | null;
  vin: string | null;
  vin_pending: boolean;
  ownership: string | null;
  lienholder: string | null;
  usage: string | null;
  annual_mileage: number | null;
  garaging_zip: string | null;
  truck_type: string | null;
  physical_damage_value: number | null;
  physical_damage_deductible: number | null;
}

export interface IntakeDriverRow {
  id?: string;
  position: number;
  first_name: string;
  last_name: string;
  dob: string | null;
  relationship: string | null;
  document_type: string;
  license_number: string | null;
  license_state: string | null;
  license_status: string | null;
  years_licensed: number | null;
  sr22_required: boolean;
  cdl: boolean;
  cdl_date: string | null;
}

export interface WorkflowStage {
  stage_key: SpecialtyStage;
  label: string;
  position: number;
  requires_next_action: boolean;
  is_terminal: boolean;
}

export interface AssignableMember {
  profile_id: string;
  display_name: string;
  initials: string;
}

/** Everything the detail drawer needs, in one round trip. */
export interface OpportunityDetail {
  opportunity: Omit<SpecialtyRow, 'total_count'> & {
    workflow_template_id: string;
    stage_position: number | null;
    lost_reason_note: string | null;
    bound_carrier_id: string | null;
    ready_to_market_at: string | null;
    first_submission_at: string | null;
    first_quote_at: string | null;
    created_by_name: string | null;
    intake_status: string | null;
    intake_created_by_name: string | null;
    intake_submitted_at: string | null;
    intake_version: number | null;
    customer_email: string | null;
  };
  /** Server's answer, not the client's guess. The RPCs re-derive it anyway. */
  can_edit: boolean;
  can_reassign: boolean;
  is_manager: boolean;
  carrier_markets: CarrierMarket[];
  checklist: ChecklistItem[];
  information_requests: InformationRequest[];
  notes: SpecialtyNote[];
  documents: SpecialtyDocument[];
  price_presentations: PricePresentation[];
  contributors: Contributor[];
  intake: LinkedIntake | null;
  workflow_stages: WorkflowStage[];
  assignable_members: AssignableMember[];
}

export interface TimelineEntry {
  occurred_at: string;
  origin: 'specialty' | 'intake' | 'note';
  event_type: string;
  actor_name: string;
  actor_initials: string;
  carrier_market_id: string | null;
  detail: Record<string, unknown> | null;
}

export interface SpecialtyCarrier {
  id: string;
  name: string;
  lines_of_business: string[];
}

export interface TeamMembership {
  team_id: string;
  team_name: string;
  assignment_method: AssignmentMethod;
  collaborative_editing: boolean;
  can_view: boolean;
  can_claim: boolean;
  can_edit: boolean;
  can_be_assigned: boolean;
  can_reassign: boolean;
  can_view_reports: boolean;
}

export interface LineRoute {
  line_of_business: SpecialtyLine;
  team_id: string;
  team_name: string;
}

/** What the module needs before its first search. */
export interface WorkspaceContext {
  is_manager: boolean;
  can_view_reports: boolean;
  /** Only the lines this user may work. A filter is never offered for anything else. */
  lines_of_business: LineRoute[];
  my_teams: TeamMembership[];
  teammates: AssignableMember[];
  carriers: SpecialtyCarrier[];
}

/** Bucket counts driving the filter chips and the attention strip. */
export interface SpecialtyCount {
  bucket: string;
  kind: 'stage' | 'lob' | 'attention';
  count: number;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export interface PipelineRow {
  line_of_business: SpecialtyLine;
  stage: SpecialtyStage;
  stage_label: string;
  stage_position: number | null;
  opportunity_count: number;
  overdue_count: number;
  stale_count: number;
  unclaimed_count: number;
  avg_age_days: number | null;
  sold_premium_total: number | null;
}

export interface WorkloadRow {
  profile_id: string;
  display_name: string;
  initials: string;
  active_count: number;
  information_needed_count: number;
  marketing_count: number;
  options_ready_count: number;
  price_sent_count: number;
  follow_up_count: number;
  due_today_count: number;
  overdue_count: number;
  stale_count: number;
  sold_count: number;
  not_sold_count: number;
}

export interface ContributionRow {
  profile_id: string;
  display_name: string;
  initials: string;
  primary_count: number;
  contributed_count: number;
  carrier_submissions: number;
  carrier_quotes_recorded: number;
  price_sent_actions: number;
  notes_added: number;
  information_requests: number;
  results_recorded: number;
  total_actions: number;
  last_action_at: string | null;
}

export interface TimingRow {
  line_of_business: SpecialtyLine;
  measured_count: number;
  avg_submitted_to_claimed_hours: number | null;
  avg_claimed_to_ready_hours: number | null;
  avg_ready_to_first_submission_hours: number | null;
  avg_first_submission_to_first_quote_hours: number | null;
  avg_first_quote_to_price_sent_hours: number | null;
  avg_price_sent_to_decision_hours: number | null;
  avg_intake_to_decision_days: number | null;
}

export interface CarrierPerformanceRow {
  carrier_id: string;
  carrier_name: string;
  submissions: number;
  quotes_received: number;
  declines: number;
  more_info_requests: number;
  not_competitive: number;
  withdrawn: number;
  still_waiting: number;
  quote_rate: number | null;
  avg_response_hours: number | null;
  bound_count: number;
  bind_rate: number | null;
  avg_quoted_premium: number | null;
  avg_sold_premium: number | null;
}

export interface LostBusinessRow {
  opportunity_id: string;
  reference: string;
  display_name: string;
  line_of_business: SpecialtyLine;
  lost_reason: SpecialtyLostReason;
  lost_reason_note: string | null;
  primary_assignee_id: string | null;
  assignee_name: string | null;
  recorded_by_name: string | null;
  finalized_at: string;
  markets_submitted: number;
  markets_quoted: number;
  best_premium: number | null;
  carriers_offered: string | null;
  intake_source: string;
  days_to_decision: number | null;
}

export interface AttentionRow {
  bucket: string;
  bucket_label: string;
  opportunity_id: string;
  reference: string;
  display_name: string;
  line_of_business: SpecialtyLine;
  stage: SpecialtyStage;
  stage_label: string;
  assignee_name: string | null;
  next_action: string | null;
  next_action_due: string | null;
  age_days: number | null;
  detail: string | null;
}

// ── Team administration ──────────────────────────────────────────────────────

export interface TeamMemberAdmin {
  profile_id: string;
  display_name: string;
  initials: string;
  role: string;
  can_view: boolean;
  can_claim: boolean;
  can_edit: boolean;
  can_be_assigned: boolean;
  can_reassign: boolean;
  can_view_reports: boolean;
  is_active: boolean;
  added_at: string;
  removed_at: string | null;
  removed_reason: string | null;
  active_assignment_count: number;
}

export interface TeamAdmin {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  assignment_method: AssignmentMethod;
  collaborative_editing: boolean;
  team_visibility: 'team' | 'agency';
  created_at: string;
  lines_of_business: SpecialtyLine[];
  active_opportunity_count: number;
  members: TeamMemberAdmin[];
}

export interface TeamsAdminPayload {
  teams: TeamAdmin[];
  routes: {
    line_of_business: SpecialtyLine;
    team_id: string;
    team_name: string;
    workflow_template_id: string;
    is_active: boolean;
  }[];
  templates: {
    id: string;
    template_key: string;
    name: string;
    line_of_business: SpecialtyLine;
    is_active: boolean;
  }[];
  assignable_profiles: { profile_id: string; display_name: string; initials: string; role: string }[];
}

/** The Customer Service view of a specialty journey, for Quote Center. */
export interface CsSpecialtyStatus {
  opportunity_id: string;
  reference: string;
  line_of_business: SpecialtyLine;
  team_name: string;
  display_name: string;
  status: string;
  stage: SpecialtyStage;
  result: SpecialtyResult | null;
  assignee_name: string | null;
  created_at: string;
  claimed_at: string | null;
  price_sent_at: string | null;
  finalized_at: string | null;
  last_activity_at: string;
  information_needed: {
    id: string;
    label: string;
    status: InformationStatus;
    note: string | null;
    requested_at: string | null;
    requested_by_name: string | null;
  }[];
  shared_notes: { id: string; content: string; created_at: string; author_name: string | null }[];
}

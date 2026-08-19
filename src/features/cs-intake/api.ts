'use client';

import { getSupabase, type ProfileLite } from '../nhwd-shared/client';
import type { IntakeHistoryEvent } from '../quotes/types';

export type CsIntakeStatus =
  | 'draft'
  | 'submitted'
  | 'claimed'
  | 'converted'
  | 'returned'
  | 'rejected'
  | 'deleted';
export type CsIntakePriority = 'normal' | 'high' | 'urgent';
export type CsIntakeLob = 'personal_auto' | 'commercial_auto' | 'auto' | 'trucking' | 'commercial_gl' | 'homeowners' | 'non_owners' | 'motorcycle' | 'boat' | 'trailer' | 'renters';
export type DesiredCoverage = 'liability_only' | 'full_coverage' | 'both_prices' | 'unsure';
export type QuoteKind = 'new_quote' | 'requote';

export interface CsIntakeSubmission {
  id: string;
  status: CsIntakeStatus;
  priority: CsIntakePriority;
  line_of_business: CsIntakeLob;
  quote_kind: QuoteKind;
  intake_channel?: 'ringcentral' | 'manual';
  source_renewal_id: string | null;
  source_type: string | null;
  created_by: string;
  claimed_by: string | null;
  claimed_at: string | null;
  dealer_id: string | null;
  salesperson_id: string | null;
  work_item_id: string | null;
  converted_at: string | null;
  insured_first_name: string;
  insured_middle_name: string | null;
  insured_last_name: string;
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
  mailing_same_as_addr: boolean;
  is_walk_in: boolean;
  business_name: string | null;
  dot_number: string | null;
  dot_not_applicable: boolean;
  business_type: string | null;
  years_in_business: number | null;
  operating_radius_miles: number | null;
  desired_coverage: DesiredCoverage | null;
  liability_limit: string | null;
  comprehensive_deductible: string | null;
  collision_deductible: string | null;
  current_carrier: string | null;
  current_policy_number: string | null;
  current_premium: number | null;
  current_expiration: string | null;
  prior_insurance: boolean | null;
  prior_lapse: boolean | null;
  months_continuous_coverage: number | null;
  requested_coverage: Record<string, unknown> | null;
  return_reason: string | null;
  reject_reason: string | null;
  csr_notes: string | null;
  // ── Shared-draft attribution and concurrency (v1.15.0) ────────────────────
  /** The employee who STARTED the draft. See also created_by, which is the same fact. */
  last_edited_by: string | null;
  last_edited_at: string | null;
  /** The employee who performed the successful final submission. */
  completed_by: string | null;
  /** Optimistic-concurrency counter. Must be echoed back when saving. */
  version: number;
  /** The durable quote link. work_item_id is nulled by its own FK once a quote advances. */
  source_work_item_id: string | null;
  // ── Address verification (v1.15.0) ────────────────────────────────────────
  addr_verified: boolean;
  addr_place_id: string | null;
  addr_formatted: string | null;
  renters_addr_verified: boolean;
  renters_place_id: string | null;
  renters_formatted: string | null;
  renters_same_as_customer: boolean;
  // Trucking fields
  mc_number: string | null;
  mcs150_date: string | null;
  cargo_type: string | null;
  power_unit_count: number | null;
  // Trucking — Cargo / Commodity Classification (v1.18.0)
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
  high_value_cargo_flag: boolean;
  auto_hauling_vehicles_per_load: number | null;
  auto_hauling_max_value: number | null;
  machinery_max_value: number | null;
  excluded_cargo: Record<string, string> | null;
  cargo_coverage_desired: boolean | null;
  // ── Trucking — Operations (v1.19.2) ───────────────────────────────────────
  /** Selected operation types. `business_type` is kept in sync with the joined labels. */
  operation_types: string[] | null;
  operation_description: string | null;
  desired_effective_date: string | null;
  interstate: boolean | null;
  for_hire: boolean | null;
  /** Banded radius. `operating_radius_miles` holds a representative number derived from this. */
  radius_band: string | null;
  farthest_states_cities: string | null;
  // ── Trucking — Requested Coverages: Auto Liability (v1.19.2) ──────────────
  auto_liability_limit: string | null;
  auto_liability_limit_other: string | null;
  um_uim_limit: string | null;
  hired_auto: string | null;
  non_owned_auto: string | null;
  // ── Trucking — Requested Coverages: Physical Damage (v1.19.2) ─────────────
  physical_damage_needed: boolean | null;
  physical_damage_deductible_requested: string | null;
  pd_comprehensive: boolean | null;
  pd_collision: boolean | null;
  pd_specified_causes: boolean | null;
  // ── Trucking — Requested Coverages: Trailer Interchange (v1.19.2) ─────────
  pulls_non_owned_trailers: boolean | null;
  trailer_interchange_agreement: boolean | null;
  trailer_interchange_limit: string | null;
  trailer_interchange_deductible: string | null;
  // ── Trucking — Additional coverages (v1.19.2) ─────────────────────────────
  general_liability_requested: boolean | null;
  general_liability_limit: string | null;
  medical_payments_requested: boolean | null;
  medical_payments_limit: string | null;
  additional_coverages_other: string | null;
  // ── Trucking — Underwriting / Eligibility (v1.19.2) ───────────────────────
  uw_coverage_lapse: boolean | null;
  uw_coverage_lapse_detail: string | null;
  uw_cancelled_nonrenewed: boolean | null;
  uw_cancelled_nonrenewed_detail: string | null;
  uw_losses_3yr: boolean | null;
  uw_losses_3yr_detail: string | null;
  uw_major_al_loss: boolean | null;
  uw_major_al_loss_detail: string | null;
  /** Explanation for the hazmat question. The answer itself lives on `hazmat`. */
  hazmat_detail: string | null;
  uw_owner_operators: boolean | null;
  uw_owner_operators_detail: string | null;
  owner_operator_count: number | null;
  // ── Trucking — trailer gate + prior lapse (v1.19.2) ───────────────────────
  owns_or_leases_trailers: boolean | null;
  prior_lapse_explanation: string | null;
  // Commercial GL fields
  ein: string | null;
  states_of_operation: string | null;
  employee_count: number | null;
  annual_payroll: number | null;
  coverage_types_needed: string[] | null;
  // Homeowners fields
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
  prior_claims: boolean;
  prior_claims_detail: string | null;
  // Non-owners fields
  sr22_filing_state: string | null;
  court_order_date: string | null;
  // Commercial card link
  source_commercial_quote_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

export interface CsIntakeDriver {
  id?: string;
  submission_id?: string;
  position: number;
  first_name: string;
  last_name: string;
  dob: string | null;
  relationship: string | null;
  document_type: 'driver_license' | 'state_id' | 'passport';
  license_number: string | null;
  license_state: string | null;
  license_status: string | null;
  years_licensed: number | null;
  sr22_required: boolean;
  cdl: boolean;
  cdl_date: string | null;
  // ── Trucking driver detail (v1.19.2) ──────────────────────────────────────
  /** Years of CDL experience. Collected only when `cdl` is true. */
  cdl_years_experience: number | null;
  owner_operator: boolean;
  accidents_36mo: boolean;
  accidents_detail: string | null;
  violations_36mo: boolean;
  violations_detail: string | null;
}

export interface CsIntakeVehicle {
  id?: string;
  submission_id?: string;
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
  coverage_type: string | null;
  /** Lessor / additional insured. Collected only when `ownership` is `leased`. */
  lessor_name: string | null;
  lessor_address: string | null;
}

export interface CsIntakeOwner {
  id?: string;
  submission_id?: string;
  position: number;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  dob: string | null;
  phone: string | null;
  email: string | null;
  ownership_percentage: number | null;
}

export interface CsIntakeCommodity {
  id?: string;
  submission_id?: string;
  category: string;
  frequency: 'mostly' | 'sometimes' | 'occasionally';
  is_primary: boolean;
  // ── Commodity detail (v1.19.2) ────────────────────────────────────────────
  /** Share of hauling this commodity represents. The form validates ≈100% total. */
  percent_hauled?: number | null;
  average_value?: number | null;
  maximum_value?: number | null;
}

/**
 * A trailer the insured owns or leases (trucking only).
 *
 * Gated in the form by `cs_intake_submissions.owns_or_leases_trailers`. Distinct
 * from the personal Trailer / Mobile-Home line of business, which stores single
 * `trailer_*` scalars on the submission itself.
 */
export interface CsIntakeTrailer {
  id?: string;
  submission_id?: string;
  position: number;
  year: number | null;
  make: string | null;
  trailer_type: string | null;
  vin: string | null;
  actual_cash_value: number | null;
  ownership: string | null;
  lessor_name: string | null;
  lessor_address: string | null;
}

export interface Dealer {
  id: string;
  name: string;
}

export interface DealerSalesperson {
  id: string;
  dealer_id: string;
  name: string;
}

export interface IntakeEvent {
  id: string;
  submission_id: string;
  actor_id: string | null;
  event_type: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

const SUBMISSION_COLS = '*';

function throwIfError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || 'The request could not be completed.');
}

export async function listDealers(): Promise<Dealer[]> {
  const { data, error } = await getSupabase()
    .from('dealers')
    .select('id,name')
    .eq('is_active', true)
    .order('name');
  throwIfError(error);
  return (data as Dealer[]) ?? [];
}

export async function listSalespeople(dealerId: string): Promise<DealerSalesperson[]> {
  if (!dealerId) return [];
  const { data, error } = await getSupabase()
    .from('dealer_salespeople')
    .select('id,dealer_id,name')
    .eq('dealer_id', dealerId)
    .eq('is_active', true)
    .order('name');
  throwIfError(error);
  return (data as DealerSalesperson[]) ?? [];
}

/** How an employee was involved in an intake. */
export type IntakeInvolvement = 'started' | 'completed' | 'edited';

/**
 * The intakes this employee has a hand in.
 *
 * Previously a plain `created_by = profileId` filter, which stopped being the whole
 * truth once drafts became shared: an intake that Maria finished for Vivian would
 * not appear for Maria at all, even though she is the one who completed it. The RPC
 * returns anything the employee started, last edited, or completed, and tags which.
 */
export async function listMyIntakes(
  profileId: string,
): Promise<(CsIntakeSubmission & { _involvement: IntakeInvolvement[] })[]> {
  const supabase = getSupabase();

  const { data: involvement, error: involvementError } = await supabase.rpc('cs_intake_my_work', {
    p_limit: 300,
  });
  throwIfError(involvementError);

  const rows = (involvement as { submission_id: string; involvement: IntakeInvolvement[] }[]) ?? [];
  if (rows.length === 0) return [];

  const byId = new Map(rows.map((row) => [row.submission_id, row.involvement]));
  const { data, error } = await supabase
    .from('cs_intake_submissions')
    .select(SUBMISSION_COLS)
    .in('id', Array.from(byId.keys()))
    .order('updated_at', { ascending: false });
  throwIfError(error);

  void profileId;
  return ((data as CsIntakeSubmission[]) ?? []).map((row) => ({
    ...row,
    _involvement: byId.get(row.id) ?? [],
  }));
}

export interface IntakeProductionRow {
  profile_id: string;
  display_name: string;
  drafts_started: number;
  intakes_completed: number;
  completed_for_others: number;
  started_completed_by_others: number;
  drafts_open: number;
}

/**
 * Intake production for a date range.
 *
 * Two separate numbers on purpose. Drafts Started counts who opened the record;
 * Intakes Completed counts who finished and submitted it, falling back to the
 * starter for rows submitted before completion was tracked. An unfinished draft is
 * never counted as a completed intake.
 */
export async function getIntakeProduction(
  from: string,
  to: string,
  profileId?: string | null,
): Promise<IntakeProductionRow[]> {
  const { data, error } = await getSupabase().rpc('cs_intake_production', {
    p_from: from,
    p_to: to,
    p_profile_id: profileId ?? null,
  });
  throwIfError(error);
  return (data as IntakeProductionRow[]) ?? [];
}

export async function listQueue(): Promise<CsIntakeSubmission[]> {
  const { data, error } = await getSupabase()
    .from('cs_intake_submissions')
    .select(SUBMISSION_COLS)
    .in('status', ['submitted', 'claimed'])
    .not('line_of_business', 'in', '("commercial_gl","homeowners","trucking")')
    .order('priority', { ascending: false })
    .order('submitted_at', { ascending: true })
    .limit(500);
  throwIfError(error);
  return (data as CsIntakeSubmission[]) ?? [];
}

export async function listAllIntakes(): Promise<CsIntakeSubmission[]> {
  const { data, error } = await getSupabase()
    .from('cs_intake_submissions')
    .select(SUBMISSION_COLS)
    .not('line_of_business', 'in', '("commercial_gl","homeowners","trucking")')
    .order('updated_at', { ascending: false })
    .limit(2000);
  throwIfError(error);
  return (data as CsIntakeSubmission[]) ?? [];
}

export async function getIntake(id: string): Promise<{
  submission: CsIntakeSubmission;
  drivers: CsIntakeDriver[];
  vehicles: CsIntakeVehicle[];
  owners: CsIntakeOwner[];
  commodities: CsIntakeCommodity[];
  trailers: CsIntakeTrailer[];
  events: IntakeEvent[];
} | null> {
  const supabase = getSupabase();
  const { data: submission, error } = await supabase
    .from('cs_intake_submissions')
    .select(SUBMISSION_COLS)
    .eq('id', id)
    .single();
  if (error || !submission) return null;

  const [driversResult, vehiclesResult, ownersResult, commoditiesResult, trailersResult, eventsResult] = await Promise.all([
    supabase.from('cs_intake_drivers').select('*').eq('submission_id', id).order('position'),
    supabase.from('cs_intake_vehicles').select('*').eq('submission_id', id).order('position'),
    supabase.from('cs_intake_owners').select('*').eq('submission_id', id).order('position'),
    supabase.from('cs_intake_commodities').select('*').eq('submission_id', id).order('created_at'),
    supabase.from('cs_intake_trailers').select('*').eq('submission_id', id).order('position'),
    supabase.from('cs_intake_events').select('*').eq('submission_id', id).order('created_at', { ascending: false }),
  ]);
  throwIfError(driversResult.error);
  throwIfError(vehiclesResult.error);
  throwIfError(ownersResult.error);
  throwIfError(commoditiesResult.error);
  throwIfError(trailersResult.error);
  throwIfError(eventsResult.error);

  return {
    submission: submission as CsIntakeSubmission,
    drivers: (driversResult.data as CsIntakeDriver[]) ?? [],
    vehicles: (vehiclesResult.data as CsIntakeVehicle[]) ?? [],
    owners: (ownersResult.data as CsIntakeOwner[]) ?? [],
    commodities: (commoditiesResult.data as CsIntakeCommodity[]) ?? [],
    trailers: (trailersResult.data as CsIntakeTrailer[]) ?? [],
    events: (eventsResult.data as IntakeEvent[]) ?? [],
  };
}

/** Columns the database owns. Sending them would be ignored at best and wrong at worst. */
const SERVER_OWNED_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'submitted_at',
  'claimed_at',
  'converted_at',
  'work_item_id',
  'source_work_item_id',
  'source_commercial_quote_id',
  'version',
  'completed_by',
  'last_edited_by',
  'last_edited_at',
] as const;

/** Raised when another employee saved the same draft first. */
export class DraftConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftConflictError';
  }
}

export interface SaveDraftResult {
  id: string;
  /** The stored version after this save. Pass it to the next save. */
  version: number;
  changedFields: { field: string; old_value: string | null; new_value: string | null }[];
}

function stripServerOwned(submission: Partial<CsIntakeSubmission>): Record<string, unknown> {
  const row = { ...submission } as Record<string, unknown>;
  if (row.line_of_business === 'personal_auto') row.line_of_business = 'auto';
  for (const key of SERVER_OWNED_COLUMNS) delete row[key];
  // Strip internal-only keys that don't exist as DB columns
  for (const key of Object.keys(row)) {
    if (key.startsWith('_')) delete row[key];
  }
  return row;
}

function stripChildIds<T extends { id?: string; submission_id?: string }>(rows: T[]) {
  return rows.map(({ id: _id, submission_id: _sid, ...rest }) => rest);
}

/**
 * Saves an intake draft.
 *
 * A brand-new intake is inserted directly, because RLS requires
 * `created_by = auth.uid()` on insert and that is exactly the guarantee wanted:
 * the starter is recorded as the row is born.
 *
 * An existing intake goes through `cs_intake_save_draft`, which does the whole
 * save — parent row, drivers, vehicles, owners, the version bump and the audit
 * event — in one transaction. The old client-side version issued six separate
 * statements, so a failure halfway through left a draft with new parent data and
 * old vehicles, and two employees editing at once silently overwrote each other.
 *
 * @param expectedVersion the version the editor loaded. Omit only for a first
 *   save. When it no longer matches, a {@link DraftConflictError} is raised
 *   instead of overwriting the other employee's work.
 */
/**
 * In-flight creation guard: prevents a rapid second call from creating a
 * duplicate row when submission.id is still undefined. The promise is shared
 * so both callers get the same result.
 */
let createInFlight: Promise<SaveDraftResult> | null = null;

export async function saveDraft(
  profileId: string,
  submission: Partial<CsIntakeSubmission> & { id?: string },
  drivers: CsIntakeDriver[],
  vehicles: CsIntakeVehicle[],
  owners: CsIntakeOwner[] = [],
  commodities: CsIntakeCommodity[] = [],
  trailers: CsIntakeTrailer[] = [],
  expectedVersion?: number | null,
): Promise<SaveDraftResult> {
  const supabase = getSupabase();
  const row = stripServerOwned(submission);

  if (!submission.id) {
    // If another call is already creating a new intake, share its result to
    // prevent duplicate rows from concurrent rapid clicks.
    if (createInFlight) {
      return createInFlight;
    }

    const doCreate = async (): Promise<SaveDraftResult> => {
      const { data, error } = await supabase
        .from('cs_intake_submissions')
        .insert({ ...row, created_by: profileId, last_edited_by: profileId, last_edited_at: new Date().toISOString() })
        .select('id,version')
        .single();
      throwIfError(error);
      const created = data as { id: string; version: number };

      const { error: eventError } = await supabase.from('cs_intake_events').insert({
        submission_id: created.id,
        actor_id: profileId,
        event_type: 'created',
        detail: { line_of_business: row.line_of_business },
      });
      throwIfError(eventError);

      // Children are attached through the same atomic path the next save uses, so
      // there is only one code path that writes them.
      return saveDraft(profileId, { ...submission, id: created.id }, drivers, vehicles, owners, commodities, trailers, created.version);
    };

    createInFlight = doCreate().finally(() => { createInFlight = null; });
    return createInFlight;
  }

  const { data, error } = await supabase.rpc('cs_intake_save_draft', {
    p_submission_id: submission.id,
    p_payload: row,
    p_drivers: stripChildIds(drivers),
    p_vehicles: stripChildIds(vehicles),
    p_owners: stripChildIds(owners),
    p_commodities: stripChildIds(commodities),
    p_trailers: stripChildIds(trailers),
    p_expected_version: expectedVersion ?? null,
  });

  if (error) {
    // 40001 is the serialization-failure class the RPC raises for a stale save.
    if (error.code === '40001' || /updated by another employee/i.test(error.message ?? '')) {
      throw new DraftConflictError(
        error.message ||
          'This intake was updated by another employee while you were working on it. Review the latest information before saving.',
      );
    }
    throwIfError(error);
  }

  const result = data as {
    id: string;
    version: number;
    changed_fields: { field: string; old_value: string | null; new_value: string | null }[];
  };
  return { id: result.id, version: result.version, changedFields: result.changed_fields ?? [] };
}

export async function submitIntake(id: string): Promise<void> {
  const { error } = await getSupabase().rpc('cs_intake_submit', { p_submission_id: id });
  throwIfError(error);
}

/**
 * Appends a note to an intake that has not become a quote yet.
 *
 * Requires read access, not ownership: Customer Service and Sales both have to be
 * able to document a call about work someone else started. Writes to
 * cs_intake_events, which has no UPDATE or DELETE policy, so the note cannot be
 * rewritten afterwards.
 */
export async function addIntakeNote(submissionId: string, note: string): Promise<void> {
  const { error } = await getSupabase().rpc('cs_intake_add_note', {
    p_submission_id: submissionId,
    p_note: note,
  });
  throwIfError(error);
}

/**
 * Submit a Commercial GL intake. Creates a commercial_quotes card on the board and
 * marks the intake converted. Returns the new commercial quote card ID.
 *
 * Trucking and Homeowners no longer come through here. As of v1.16.5 they go to
 * Specialty Quotes via {@link submitSpecialtyIntake}, and this RPC refuses them — as
 * does a trigger on commercial_quotes — so the same live quote cannot end up on both
 * the Commercial Board and the specialty list. Commercial GL is deliberately
 * unchanged.
 */
export async function submitCommercialIntake(id: string, assignTo?: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('cs_intake_submit_commercial', {
    p_submission_id: id,
    p_assigned_to: assignTo ?? null,
  });
  throwIfError(error);
  return data as string;
}

/**
 * Submit a Trucking or Homeowners intake into Specialty Quotes.
 *
 * Returns the new specialty opportunity id. Customer Service does not choose an
 * assignee: the line of business routes the work to a quoting team, every eligible
 * member is notified, and one of them claims it. Idempotent per intake, so a retried
 * request returns the opportunity that already exists rather than making a second one.
 */
export async function submitSpecialtyIntake(id: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('cs_intake_submit_specialty', {
    p_submission_id: id,
  });
  throwIfError(error);
  return data as string;
}

/** True for the lines of business that Specialty Quotes now owns. */
export function isSpecialtyLob(lob: string | null | undefined): boolean {
  return lob === 'trucking' || lob === 'homeowners';
}

/**
 * List users who can be assigned commercial quotes.
 * Shows: commercial role users, commercial_supervisor, and super_admins.
 * Also includes specific non-commercial users who handle commercial work (e.g. Brenda Morales).
 */
export async function listCommercialAssignees(): Promise<{ id: string; display_name: string; role: string }[]> {
  const supabase = getSupabase();
  // Fetch by role
  const { data: byRole, error: err1 } = await supabase
    .from('profiles')
    .select('id,display_name,role')
    .eq('is_active', true)
    .in('role', ['commercial', 'commercial_supervisor', 'super_admin'])
    .order('display_name');
  throwIfError(err1);

  // Also fetch specific users who handle commercial but have other roles
  const { data: byName, error: err2 } = await supabase
    .from('profiles')
    .select('id,display_name,role')
    .eq('is_active', true)
    .ilike('display_name', '%Brenda Morales%');
  throwIfError(err2);

  // Merge without duplicates
  const map = new Map<string, { id: string; display_name: string; role: string }>();
  for (const u of [...(byRole ?? []), ...(byName ?? [])]) {
    map.set(u.id, u as { id: string; display_name: string; role: string });
  }
  return Array.from(map.values()).sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export async function claimIntake(id: string): Promise<void> {
  const { error } = await getSupabase().rpc('cs_intake_claim', { p_submission_id: id });
  throwIfError(error);
}

export async function claimRingcentralQueueIntake(id: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('cs_intake_claim_ringcentral', {
    p_submission_id: id,
  });
  throwIfError(error);
  return data as string;
}

export async function managerAssignIntake(id: string, agentId: string): Promise<void> {
  const { error } = await getSupabase().rpc('cs_intake_manager_assign', {
    p_submission_id: id,
    p_agent_id: agentId,
  });
  throwIfError(error);
}

export async function convertIntake(id: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('cs_intake_convert', { p_submission_id: id });
  throwIfError(error);
  return data as string;
}

export async function returnIntake(id: string, actorId: string, reason: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('cs_intake_return', {
    p_submission_id: id,
    p_reason: reason,
  });
  if (!error) return;

  // Compatibility fallback for databases that have not yet installed the helper RPC.
  const { error: updateError } = await supabase
    .from('cs_intake_submissions')
    .update({ status: 'returned', return_reason: reason, claimed_by: null, claimed_at: null })
    .eq('id', id);
  throwIfError(updateError);
  const { error: eventError } = await supabase.from('cs_intake_events').insert({
    submission_id: id,
    actor_id: actorId,
    event_type: 'returned',
    detail: { reason },
  });
  throwIfError(eventError);
}

export async function rejectIntake(id: string, actorId: string, reason: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('cs_intake_submissions')
    .update({ status: 'rejected', reject_reason: reason })
    .eq('id', id);
  throwIfError(error);
  const { error: eventError } = await supabase.from('cs_intake_events').insert({
    submission_id: id,
    actor_id: actorId,
    event_type: 'rejected',
    detail: { reason },
  });
  throwIfError(eventError);
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW: Customer Intakes (v1.0.0 - Structured Intake Table)
// ═══════════════════════════════════════════════════════════════════════════

/** Update fields on a customer_intake via the update_customer_intake RPC */
export async function updateCustomerIntake(
  intakeId: string,
  changes: Record<string, unknown>,
  reason?: string,
): Promise<{ success: boolean; affected_ids?: string[]; error?: string }> {
  const { data, error } = await getSupabase().rpc('update_customer_intake', {
    p_intake_id: intakeId,
    p_changes: changes,
    p_reason: reason ?? null,
  });
  throwIfError(error);
  return data as { success: boolean; affected_ids?: string[]; error?: string };
}

/** Submit a new customer_intake (transition from draft to submitted) */
export async function submitCustomerIntake(intakeId: string): Promise<void> {
  const { error } = await getSupabase().rpc('submit_customer_intake', {
    p_intake_id: intakeId,
  });
  throwIfError(error);
}

/** Get the history events for a customer_intake */
export async function getCustomerIntakeHistory(intakeId: string): Promise<IntakeHistoryEvent[]> {
  const { data, error } = await getSupabase()
    .from('intake_history_events')
    .select('*')
    .eq('intake_id', intakeId)
    .order('created_at', { ascending: false });
  throwIfError(error);
  return (data ?? []) as IntakeHistoryEvent[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Manager Actions (v1.0.0 - Customer Intakes)
// ═══════════════════════════════════════════════════════════════════════════

/** Manager assigns a customer_intake to an agent. Returns the quote ID. */
export async function assignCustomerIntake(
  intakeId: string,
  agentId: string,
  reason?: string,
): Promise<string> {
  const { data, error } = await getSupabase().rpc('assign_customer_intake', {
    p_intake_id: intakeId,
    p_agent_id: agentId,
    p_reason: reason ?? null,
  });
  throwIfError(error);
  return data as string;
}

/** Manager deletes a cs_intake_submission */
export async function deleteCustomerIntake(
  intakeId: string,
  reason: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabase();

  // Get current user for audit trail
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Authentication required.');

  // Delete child records first (drivers, vehicles, owners, events)
  await supabase.from('cs_intake_vehicles').delete().eq('submission_id', intakeId);
  await supabase.from('cs_intake_drivers').delete().eq('submission_id', intakeId);
  await supabase.from('cs_intake_owners').delete().eq('submission_id', intakeId);
  await supabase.from('cs_intake_events').delete().eq('submission_id', intakeId);

  // Hard delete the intake submission
  const { error: deleteError } = await supabase
    .from('cs_intake_submissions')
    .delete()
    .eq('id', intakeId);
  throwIfError(deleteError);

  // Log deletion in audit_log for traceability
  await supabase.from('audit_log').insert({
    actor_profile_id: user.id,
    action: 'cs_intake_deleted',
    entity_type: 'cs_intake_submission',
    entity_id: intakeId,
    reason,
  });

  return { success: true };
}

/** Manager restores a soft-deleted customer_intake — no longer applicable with hard delete */
export async function restoreCustomerIntake(
  _intakeId: string,
  _reason: string,
): Promise<{ success: boolean; restored_status?: string; error?: string }> {
  return { success: false, error: 'Hard-deleted records cannot be restored.' };
}

export function profileName(profiles: ProfileLite[], id: string | null): string {
  return profiles.find((profile) => profile.id === id)?.display_name ?? 'Unassigned';
}

// ═══════════════════════════════════════════════════════════════════════════
// Quote Visibility (CS Intake → Work Desk link)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Batch-fetches the current status for a set of linked work items (quotes).
 * Checks quote_outcomes for sold/not_sold decisions and pending_pricing for price_sent.
 * Only call with work_item_ids from converted intakes to avoid unnecessary queries.
 */
export async function getLinkedQuoteStatuses(workItemIds: string[]): Promise<Map<string, string>> {
  if (!workItemIds.length) return new Map();
  const supabase = getSupabase();

  const [workResult, outcomesResult, pricingResult] = await Promise.all([
    supabase
      .from('work_items')
      .select('id, status')
      .in('id', workItemIds),
    supabase
      .from('quote_outcomes')
      .select('source_work_item_id, decision')
      .in('source_work_item_id', workItemIds),
    supabase
      .from('pending_pricing_quotes')
      .select('source_work_item_id, price_sent_at')
      .in('source_work_item_id', workItemIds)
      .not('price_sent_at', 'is', null),
  ]);
  throwIfError(workResult.error);
  throwIfError(outcomesResult.error);
  throwIfError(pricingResult.error);

  // Build outcome map (sold/not_sold takes precedence)
  const outcomeMap = new Map<string, string>();
  for (const row of (outcomesResult.data ?? [])) {
    outcomeMap.set(row.source_work_item_id, row.decision);
  }

  // Build price_sent set
  const priceSentSet = new Set<string>();
  for (const row of (pricingResult.data ?? [])) {
    priceSentSet.add(row.source_work_item_id);
  }

  // Build final status map with priority: outcome > price_sent > work_item status
  const map = new Map<string, string>();
  for (const row of (workResult.data ?? [])) {
    const outcome = outcomeMap.get(row.id);
    if (outcome) {
      // Use the outcome decision directly (sold / not_sold)
      map.set(row.id, outcome);
    } else if (priceSentSet.has(row.id)) {
      map.set(row.id, 'price_sent');
    } else {
      map.set(row.id, row.status);
    }
  }
  return map;
}

export interface LinkedQuoteEvent {
  id: string;
  event_type: string;
  details: Record<string, unknown> | null;
  created_at: string;
  actor_name: string;
}

/**
 * Fetches all work_item_events for a linked quote, ordered chronologically.
 * Resolves actor display names from the profiles table.
 */
export async function getLinkedQuoteEvents(workItemId: string): Promise<LinkedQuoteEvent[]> {
  const supabase = getSupabase();

  // Work Desk quotes use work_item_events/quote_notes. The older operational
  // quote flow stores its timeline in quote_history_events under the quote ID.
  // Query both so QuoteActivityModal is the single timeline UI for either
  // quote model.
  const [eventsResult, notesResult, operationalHistoryResult] = await Promise.all([
    supabase
      .from('work_item_events')
      .select('id, event_type, details, created_at, actor_profile_id')
      .eq('source_work_item_id', workItemId)
      .order('created_at', { ascending: true }),
    supabase
      .from('quote_notes')
      .select('id, author_profile_id, note, created_at')
      .eq('source_work_item_id', workItemId)
      .order('created_at', { ascending: true }),
    supabase
      .from('quote_history_events')
      .select('id, event_type, details, reason, note_log_content, changed_fields, created_at, actor_display_name')
      .eq('quote_id', workItemId)
      .order('created_at', { ascending: true }),
  ]);
  throwIfError(eventsResult.error);
  throwIfError(notesResult.error);
  throwIfError(operationalHistoryResult.error);

  const events = eventsResult.data ?? [];
  const notes = notesResult.data ?? [];
  const operationalHistory = operationalHistoryResult.data ?? [];

  if (!events.length && !notes.length && !operationalHistory.length) return [];

  // Resolve actor display names for Work Desk events and notes. Operational
  // history already snapshots actor_display_name on each event.
  const allActorIds = [
    ...events.map(e => e.actor_profile_id),
    ...notes.map(n => n.author_profile_id),
  ].filter(Boolean);
  const uniqueActorIds = [...new Set(allActorIds)] as string[];

  const actorMap = new Map<string, string>();
  if (uniqueActorIds.length) {
    const { data: profiles, error: profileError } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', uniqueActorIds);
    throwIfError(profileError);
    for (const profile of (profiles ?? [])) {
      actorMap.set(profile.id, profile.display_name);
    }
  }

  const eventItems: LinkedQuoteEvent[] = events.map(event => ({
    id: `work-${event.id}`,
    event_type: event.event_type,
    details: event.details,
    created_at: event.created_at,
    actor_name: actorMap.get(event.actor_profile_id) ?? 'System',
  }));

  const noteItems: LinkedQuoteEvent[] = notes.map(note => ({
    id: `note-${note.id}`,
    event_type: 'note',
    details: { note: note.note },
    created_at: note.created_at,
    actor_name: actorMap.get(note.author_profile_id) ?? 'Unknown',
  }));

  const operationalItems: LinkedQuoteEvent[] = operationalHistory.map(event => {
    const details: Record<string, unknown> = {};
    if (event.details) details.details = event.details;
    if (event.reason) details.reason = event.reason;
    if (event.note_log_content) details.intake_note_log = event.note_log_content;
    if (event.changed_fields) details.changed_fields = event.changed_fields;

    return {
      id: `operational-${event.id}`,
      event_type: event.event_type,
      details: Object.keys(details).length ? details : null,
      created_at: event.created_at,
      actor_name: event.actor_display_name || 'System',
    };
  });

  return [...eventItems, ...noteItems, ...operationalItems].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

/**
 * Soft-deletes a linked work item (quote) by marking it as cancelled.
 * Creates an audit event in work_item_events with reason and actor.
 * Manager-only: caller must verify role before invoking.
 */
export async function deleteLinkedWorkItem(workItemId: string, reason: string): Promise<{ success: boolean }> {
  const supabase = getSupabase();

  // Get current user for audit trail
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Authentication required.');

  // Soft-delete: mark work item as cancelled
  const { error: updateError } = await supabase
    .from('work_items')
    .update({ status: 'cancelled' })
    .eq('id', workItemId);
  throwIfError(updateError);

  // Insert audit event
  const { error: eventError } = await supabase
    .from('work_item_events')
    .insert({
      source_work_item_id: workItemId,
      event_type: 'cancelled_from_cs_queue',
      details: { reason },
      actor_profile_id: user.id,
    });
  throwIfError(eventError);

  return { success: true };
}

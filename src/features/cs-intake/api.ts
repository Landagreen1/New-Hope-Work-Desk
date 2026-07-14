'use client';

import { getSupabase, type ProfileLite } from '../nhwd-shared/client';

export type CsIntakeStatus =
  | 'draft'
  | 'submitted'
  | 'claimed'
  | 'converted'
  | 'returned'
  | 'rejected';
export type CsIntakePriority = 'normal' | 'high' | 'urgent';
export type CsIntakeLob = 'personal_auto' | 'commercial_auto' | 'auto';
export type DesiredCoverage = 'liability_only' | 'full_coverage' | 'unsure';
export type QuoteKind = 'new_quote' | 'requote';

export interface CsIntakeSubmission {
  id: string;
  status: CsIntakeStatus;
  priority: CsIntakePriority;
  line_of_business: CsIntakeLob;
  quote_kind: QuoteKind;
  source_renewal_id: string | null;
  created_by: string;
  claimed_by: string | null;
  claimed_at: string | null;
  dealer_id: string | null;
  salesperson_id: string | null;
  work_item_id: string | null;
  converted_at: string | null;
  insured_first_name: string;
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
  document_type: 'driver_license' | 'state_id';
  license_number: string | null;
  license_state: string | null;
  license_status: string | null;
  years_licensed: number | null;
  sr22_required: boolean;
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

export async function listMyIntakes(profileId: string): Promise<CsIntakeSubmission[]> {
  const { data, error } = await getSupabase()
    .from('cs_intake_submissions')
    .select(SUBMISSION_COLS)
    .eq('created_by', profileId)
    .order('updated_at', { ascending: false })
    .limit(300);
  throwIfError(error);
  return (data as CsIntakeSubmission[]) ?? [];
}

export async function listQueue(): Promise<CsIntakeSubmission[]> {
  const { data, error } = await getSupabase()
    .from('cs_intake_submissions')
    .select(SUBMISSION_COLS)
    .in('status', ['submitted', 'claimed'])
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
    .order('updated_at', { ascending: false })
    .limit(500);
  throwIfError(error);
  return (data as CsIntakeSubmission[]) ?? [];
}

export async function getIntake(id: string): Promise<{
  submission: CsIntakeSubmission;
  drivers: CsIntakeDriver[];
  vehicles: CsIntakeVehicle[];
  events: IntakeEvent[];
} | null> {
  const supabase = getSupabase();
  const { data: submission, error } = await supabase
    .from('cs_intake_submissions')
    .select(SUBMISSION_COLS)
    .eq('id', id)
    .single();
  if (error || !submission) return null;

  const [driversResult, vehiclesResult, eventsResult] = await Promise.all([
    supabase.from('cs_intake_drivers').select('*').eq('submission_id', id).order('position'),
    supabase.from('cs_intake_vehicles').select('*').eq('submission_id', id).order('position'),
    supabase.from('cs_intake_events').select('*').eq('submission_id', id).order('created_at', { ascending: false }),
  ]);
  throwIfError(driversResult.error);
  throwIfError(vehiclesResult.error);
  throwIfError(eventsResult.error);

  return {
    submission: submission as CsIntakeSubmission,
    drivers: (driversResult.data as CsIntakeDriver[]) ?? [],
    vehicles: (vehiclesResult.data as CsIntakeVehicle[]) ?? [],
    events: (eventsResult.data as IntakeEvent[]) ?? [],
  };
}

export async function saveDraft(
  profileId: string,
  submission: Partial<CsIntakeSubmission> & { id?: string },
  drivers: CsIntakeDriver[],
  vehicles: CsIntakeVehicle[],
): Promise<string> {
  const supabase = getSupabase();
  let id = submission.id;
  const row = { ...submission } as Record<string, unknown>;
  if (row.line_of_business === 'personal_auto') row.line_of_business = 'auto';
  for (const key of ['id', 'created_at', 'updated_at', 'submitted_at', 'claimed_at', 'converted_at', 'work_item_id']) {
    delete row[key];
  }

  if (id) {
    const { error } = await supabase.from('cs_intake_submissions').update(row).eq('id', id);
    throwIfError(error);
  } else {
    const { data, error } = await supabase
      .from('cs_intake_submissions')
      .insert({ ...row, created_by: profileId })
      .select('id')
      .single();
    throwIfError(error);
    id = (data as { id: string }).id;
    const { error: eventError } = await supabase.from('cs_intake_events').insert({
      submission_id: id,
      actor_id: profileId,
      event_type: 'created',
      detail: { line_of_business: row.line_of_business },
    });
    throwIfError(eventError);
  }

  const { error: driverDeleteError } = await supabase.from('cs_intake_drivers').delete().eq('submission_id', id);
  throwIfError(driverDeleteError);
  const { error: vehicleDeleteError } = await supabase.from('cs_intake_vehicles').delete().eq('submission_id', id);
  throwIfError(vehicleDeleteError);

  if (drivers.length) {
    const { error } = await supabase.from('cs_intake_drivers').insert(
      drivers.map((driver, index) => ({
        ...driver,
        id: undefined,
        submission_id: id,
        position: index + 1,
      })),
    );
    throwIfError(error);
  }

  if (vehicles.length) {
    const { error } = await supabase.from('cs_intake_vehicles').insert(
      vehicles.map((vehicle, index) => ({
        ...vehicle,
        id: undefined,
        submission_id: id,
        position: index + 1,
      })),
    );
    throwIfError(error);
  }

  return id!;
}

export async function submitIntake(id: string): Promise<void> {
  const { error } = await getSupabase().rpc('cs_intake_submit', { p_submission_id: id });
  throwIfError(error);
}

export async function claimIntake(id: string): Promise<void> {
  const { error } = await getSupabase().rpc('cs_intake_claim', { p_submission_id: id });
  throwIfError(error);
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

export function profileName(profiles: ProfileLite[], id: string | null): string {
  return profiles.find((profile) => profile.id === id)?.display_name ?? 'Unassigned';
}

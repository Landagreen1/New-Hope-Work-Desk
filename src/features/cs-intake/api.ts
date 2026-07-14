// src/features/cs-intake/api.ts
// Data layer for the CS Quote Intake module. Targets the v0.9.5-r3 schema:
// cs_intake_submissions / _drivers / _vehicles / _events and the RPCs
// cs_intake_submit, cs_intake_claim, cs_intake_convert.
'use client';

import { getSupabase } from '../nhwd-shared/client';

export type CsIntakeStatus =
  | 'draft' | 'submitted' | 'claimed' | 'converted' | 'returned' | 'rejected';
export type CsIntakePriority = 'normal' | 'high' | 'urgent';
export type CsIntakeLob =
  | 'auto' | 'motorcycle' | 'home' | 'renters'
  | 'commercial_auto' | 'general_liability' | 'other';

export interface CsIntakeSubmission {
  id: string;
  status: CsIntakeStatus;
  priority: CsIntakePriority;
  line_of_business: CsIntakeLob;
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
  current_carrier: string | null;
  current_policy_number: string | null;
  current_premium: number | null;
  current_expiration: string | null;
  prior_insurance: boolean | null;
  prior_lapse: boolean | null;
  months_continuous_coverage: number | null;
  requested_coverage: Record<string, unknown>;
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

export interface Dealer { id: string; name: string; }
export interface DealerSalesperson { id: string; dealer_id: string; name: string; }

const SUBMISSION_COLS = '*';

export async function listDealers(): Promise<Dealer[]> {
  const { data } = await getSupabase()
    .from('dealers').select('id, name').eq('is_active', true).order('name');
  return (data as Dealer[]) ?? [];
}

export async function listSalespeople(dealerId: string): Promise<DealerSalesperson[]> {
  const { data } = await getSupabase()
    .from('dealer_salespeople')
    .select('id, dealer_id, name')
    .eq('dealer_id', dealerId)
    .eq('is_active', true)
    .order('name');
  return (data as DealerSalesperson[]) ?? [];
}

export async function listMyIntakes(profileId: string): Promise<CsIntakeSubmission[]> {
  const { data } = await getSupabase()
    .from('cs_intake_submissions')
    .select(SUBMISSION_COLS)
    .eq('created_by', profileId)
    .order('updated_at', { ascending: false });
  return (data as CsIntakeSubmission[]) ?? [];
}

export async function listQueue(): Promise<CsIntakeSubmission[]> {
  const { data } = await getSupabase()
    .from('cs_intake_submissions')
    .select(SUBMISSION_COLS)
    .in('status', ['submitted', 'claimed'])
    .order('priority', { ascending: false })
    .order('submitted_at', { ascending: true });
  return (data as CsIntakeSubmission[]) ?? [];
}

export async function listAllIntakes(): Promise<CsIntakeSubmission[]> {
  const { data } = await getSupabase()
    .from('cs_intake_submissions')
    .select(SUBMISSION_COLS)
    .order('updated_at', { ascending: false })
    .limit(300);
  return (data as CsIntakeSubmission[]) ?? [];
}

export async function getIntake(id: string): Promise<{
  submission: CsIntakeSubmission;
  drivers: CsIntakeDriver[];
  vehicles: CsIntakeVehicle[];
} | null> {
  const supabase = getSupabase();
  const { data: submission } = await supabase
    .from('cs_intake_submissions').select(SUBMISSION_COLS).eq('id', id).single();
  if (!submission) return null;
  const [{ data: drivers }, { data: vehicles }] = await Promise.all([
    supabase.from('cs_intake_drivers').select('*').eq('submission_id', id).order('position'),
    supabase.from('cs_intake_vehicles').select('*').eq('submission_id', id).order('position'),
  ]);
  return {
    submission: submission as CsIntakeSubmission,
    drivers: (drivers as CsIntakeDriver[]) ?? [],
    vehicles: (vehicles as CsIntakeVehicle[]) ?? [],
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
  delete row.id;
  delete row.created_at;
  delete row.updated_at;

  if (id) {
    const { error } = await supabase.from('cs_intake_submissions').update(row).eq('id', id);
    if (error) throw error;
  } else {
    const { data, error } = await supabase
      .from('cs_intake_submissions')
      .insert({ ...row, created_by: profileId })
      .select('id')
      .single();
    if (error) throw error;
    id = (data as { id: string }).id;
    await supabase.from('cs_intake_events').insert({
      submission_id: id, actor_id: profileId, event_type: 'created',
    });
  }

  // Replace children with the current form state (draft-stage only).
  await supabase.from('cs_intake_drivers').delete().eq('submission_id', id);
  await supabase.from('cs_intake_vehicles').delete().eq('submission_id', id);
  if (drivers.length) {
    const { error } = await supabase.from('cs_intake_drivers').insert(
      drivers.map((d, i) => ({ ...d, id: undefined, submission_id: id, position: i + 1 })),
    );
    if (error) throw error;
  }
  if (vehicles.length) {
    const { error } = await supabase.from('cs_intake_vehicles').insert(
      vehicles.map((v, i) => ({ ...v, id: undefined, submission_id: id, position: i + 1 })),
    );
    if (error) throw error;
  }
  return id!;
}

export async function submitIntake(id: string): Promise<void> {
  const { error } = await getSupabase().rpc('cs_intake_submit', { p_submission_id: id });
  if (error) throw error;
}

export async function claimIntake(id: string): Promise<void> {
  const { error } = await getSupabase().rpc('cs_intake_claim', { p_submission_id: id });
  if (error) throw error;
}

export async function convertIntake(id: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('cs_intake_convert', { p_submission_id: id });
  if (error) throw error;
  return data as string;
}

export async function returnIntake(id: string, actorId: string, reason: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('cs_intake_submissions')
    .update({ status: 'returned', return_reason: reason, claimed_by: null, claimed_at: null })
    .eq('id', id);
  if (error) throw error;
  await supabase.from('cs_intake_events').insert({
    submission_id: id, actor_id: actorId, event_type: 'returned',
    detail: { reason },
  });
}

export async function rejectIntake(id: string, actorId: string, reason: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('cs_intake_submissions')
    .update({ status: 'rejected', reject_reason: reason })
    .eq('id', id);
  if (error) throw error;
  await supabase.from('cs_intake_events').insert({
    submission_id: id, actor_id: actorId, event_type: 'rejected',
    detail: { reason },
  });
}

'use client';

/**
 * Specialty Quotes data access.
 *
 * Every call goes to a security-definer RPC. Nothing here selects from a specialty
 * table directly, and `specialty_opportunity_rows` is revoked from `authenticated`,
 * so the team boundary cannot be sidestepped by crafting a different query from the
 * browser.
 *
 * Searching, filtering, paging and every roll-up happen in SQL. The browser holds
 * one page of the list and one opportunity's detail — never the whole database.
 *
 * There are no optimistic updates. The server decides, the client refetches. That is
 * the house pattern, and here it is load-bearing: several people work the same quote,
 * so a locally-applied change would be exactly the silent overwrite the concurrency
 * rules exist to prevent.
 */

import { getSupabase } from '../nhwd-shared/client';
import type {
  AttentionRow,
  CarrierMarketStatus,
  CarrierPerformanceRow,
  ContributionRow,
  CsSpecialtyStatus,
  DocumentCategory,
  LostBusinessRow,
  OpportunityDetail,
  PipelineRow,
  PriceMethod,
  SpecialtyCount,
  SpecialtyLine,
  SpecialtyLostReason,
  SpecialtyPriority,
  SpecialtyRow,
  SpecialtyStage,
  SpecialtyView,
  TeamsAdminPayload,
  TimelineEntry,
  TimingRow,
  WorkloadRow,
  WorkspaceContext,
} from './types';

const SPECIALTY_BUCKET = 'specialty-quote-documents';
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

/**
 * Raised when a teammate saved the same record first.
 *
 * The specialty RPCs raise SQLSTATE 40001 for a version mismatch, matching
 * `cs_intake_save_draft`, so a conflict is recognisable rather than looking like a
 * generic failure — and the caller can reload and show what changed instead of
 * overwriting it.
 */
export class SpecialtyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecialtyConflictError';
  }
}

/** Raised when two people claimed at once and this caller lost. */
export class AlreadyClaimedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyClaimedError';
  }
}

function throwIfError(error: { message?: string; code?: string } | null): void {
  if (!error) return;
  const message = error.message || 'The request could not be completed.';
  if (error.code === '40001' || /updated by another employee/i.test(message)) {
    throw new SpecialtyConflictError(message);
  }
  if (/already been claimed/i.test(message)) {
    throw new AlreadyClaimedError(message);
  }
  throw new Error(message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Context and configuration
// ═══════════════════════════════════════════════════════════════════════════════

/** True when this account may open the module. Cheap enough for the app shell. */
export async function canAccessSpecialtyModule(): Promise<boolean> {
  const { data, error } = await getSupabase().rpc('specialty_can_access');
  if (error) return false;
  return data === true;
}

export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  const { data, error } = await getSupabase().rpc('specialty_workspace_context');
  throwIfError(error);
  return data as WorkspaceContext;
}

// ═══════════════════════════════════════════════════════════════════════════════
// The list
// ═══════════════════════════════════════════════════════════════════════════════

export interface SearchOptions {
  query?: string | null;
  lineOfBusiness?: SpecialtyLine | 'all';
  stage?: SpecialtyStage | 'all';
  assignee?: string | null;
  view?: SpecialtyView;
  carrierId?: string | null;
  result?: 'all' | 'open' | 'sold' | 'not_sold';
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  rows: SpecialtyRow[];
  totalCount: number;
}

export async function searchOpportunities(options: SearchOptions = {}): Promise<SearchResult> {
  const { data, error } = await getSupabase().rpc('specialty_search_opportunities', {
    p_query: options.query?.trim() || null,
    p_line_of_business: options.lineOfBusiness ?? 'all',
    p_stage: options.stage ?? 'all',
    p_assignee: options.assignee ?? null,
    p_view: options.view ?? 'team',
    p_carrier_id: options.carrierId ?? null,
    p_result: options.result ?? 'all',
    p_limit: options.limit ?? 25,
    p_offset: options.offset ?? 0,
  });
  throwIfError(error);
  const rows = (data as SpecialtyRow[]) ?? [];
  // total_count is a window function over the filtered set, so every row carries the
  // same value and an empty page legitimately means zero.
  return { rows, totalCount: rows[0]?.total_count ?? 0 };
}

export async function getCounts(
  query?: string | null,
  lineOfBusiness: SpecialtyLine | 'all' = 'all',
  assignee: string | null = null,
): Promise<SpecialtyCount[]> {
  const { data, error } = await getSupabase().rpc('specialty_stage_counts', {
    p_query: query?.trim() || null,
    p_line_of_business: lineOfBusiness,
    p_assignee: assignee,
  });
  throwIfError(error);
  return (data as SpecialtyCount[]) ?? [];
}

/** Pulls one bucket out of the count list. */
export function countFor(
  counts: readonly SpecialtyCount[],
  kind: 'stage' | 'lob' | 'attention',
  bucket: string,
): number {
  return counts.find((entry) => entry.kind === kind && entry.bucket === bucket)?.count ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Detail
// ═══════════════════════════════════════════════════════════════════════════════

export async function getOpportunityDetail(id: string): Promise<OpportunityDetail> {
  const { data, error } = await getSupabase().rpc('specialty_opportunity_detail', {
    p_opportunity_id: id,
  });
  throwIfError(error);
  return data as OpportunityDetail;
}

/** The merged timeline. Lazy: the list never pays for it. */
export async function getTimeline(id: string, limit = 200): Promise<TimelineEntry[]> {
  const { data, error } = await getSupabase().rpc('specialty_activity_timeline', {
    p_opportunity_id: id,
    p_limit: limit,
  });
  throwIfError(error);
  return (data as TimelineEntry[]) ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Assignment
// ═══════════════════════════════════════════════════════════════════════════════

export interface ClaimResult {
  claimed: boolean;
  already_mine?: boolean;
  assignee_id: string | null;
  version: number;
}

/**
 * Takes primary responsibility.
 *
 * The RPC locks the row before reading the assignee, so a simultaneous second claim
 * loses and receives {@link AlreadyClaimedError} naming the winner. Claiming
 * establishes accountability only — the quote stays visible and editable to every
 * eligible team member either way.
 */
export async function claimOpportunity(id: string): Promise<ClaimResult> {
  const { data, error } = await getSupabase().rpc('specialty_claim_opportunity', {
    p_opportunity_id: id,
  });
  throwIfError(error);
  return data as ClaimResult;
}

/** Explicit transfer. Never a side effect of an edit. */
export async function reassignOpportunity(
  id: string,
  profileId: string | null,
  reason?: string,
): Promise<void> {
  const { error } = await getSupabase().rpc('specialty_reassign_opportunity', {
    p_opportunity_id: id,
    p_profile_id: profileId,
    p_reason: reason?.trim() || null,
  });
  throwIfError(error);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Collaborative edits
// ═══════════════════════════════════════════════════════════════════════════════

export interface OpportunityPatch {
  display_name?: string;
  priority?: SpecialtyPriority;
  next_action?: string | null;
  next_action_due?: string | null;
}

export async function updateOpportunity(
  id: string,
  patch: OpportunityPatch,
  expectedVersion: number,
): Promise<{ version: number }> {
  const { data, error } = await getSupabase().rpc('specialty_update_opportunity', {
    p_opportunity_id: id,
    p_patch: patch,
    p_expected_version: expectedVersion,
  });
  throwIfError(error);
  return data as { version: number };
}

export async function changeStage(
  id: string,
  stage: SpecialtyStage,
  expectedVersion: number,
  note?: string,
): Promise<void> {
  const { error } = await getSupabase().rpc('specialty_change_stage', {
    p_opportunity_id: id,
    p_stage: stage,
    p_expected_version: expectedVersion,
    p_note: note?.trim() || null,
  });
  throwIfError(error);
}

/**
 * Corrects the linked intake.
 *
 * The customer, business, property, vehicle and driver record lives on the original
 * CS intake and is never copied into the opportunity, so this is how a specialty
 * member fixes a VIN or a roof age. Concurrency is checked against the intake's own
 * version, which is why the drawer passes `intake.version` and not the
 * opportunity's.
 */
export async function updateLinkedIntake(
  opportunityId: string,
  patch: Record<string, unknown>,
  expectedIntakeVersion: number,
  options: { drivers?: unknown[] | null; vehicles?: unknown[] | null } = {},
): Promise<{ version: number; fields: string[] }> {
  const { data, error } = await getSupabase().rpc('specialty_update_intake', {
    p_opportunity_id: opportunityId,
    p_patch: patch,
    p_drivers: options.drivers ?? null,
    p_vehicles: options.vehicles ?? null,
    p_expected_intake_version: expectedIntakeVersion,
  });
  throwIfError(error);
  return data as { version: number; fields: string[] };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Notes, checklists, information
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Adds a note to any of the team's quotes, whoever is assigned.
 *
 * `specialty_notes` has no update and no delete policy, so a note cannot be
 * rewritten afterwards — including by a manager.
 */
export async function addNote(
  opportunityId: string,
  content: string,
  options: { carrierMarketId?: string | null; csVisible?: boolean } = {},
): Promise<string> {
  const { data, error } = await getSupabase().rpc('specialty_add_note', {
    p_opportunity_id: opportunityId,
    p_content: content,
    p_carrier_market_id: options.carrierMarketId ?? null,
    p_cs_visible: options.csVisible ?? false,
  });
  throwIfError(error);
  return data as string;
}

export async function addChecklistItem(
  opportunityId: string,
  category: string,
  label: string,
): Promise<string> {
  const { data, error } = await getSupabase().rpc('specialty_add_checklist_item', {
    p_opportunity_id: opportunityId,
    p_category: category,
    p_label: label,
  });
  throwIfError(error);
  return data as string;
}

export async function toggleChecklistItem(itemId: string, checked: boolean): Promise<void> {
  const { error } = await getSupabase().rpc('specialty_toggle_checklist_item', {
    p_item_id: itemId,
    p_checked: checked,
  });
  throwIfError(error);
}

/**
 * Records something the quote is waiting on.
 *
 * Adding the first outstanding item moves the quote to Information Needed on the
 * server, and clearing the last one moves it back to Ready to Market, so the stage
 * follows the facts rather than waiting for someone to remember.
 */
export async function addInformationRequest(
  opportunityId: string,
  label: string,
  options: { note?: string; visibleToCs?: boolean } = {},
): Promise<string> {
  const { data, error } = await getSupabase().rpc('specialty_add_information_request', {
    p_opportunity_id: opportunityId,
    p_label: label,
    p_note: options.note?.trim() || null,
    p_visible_to_cs: options.visibleToCs ?? true,
  });
  throwIfError(error);
  return data as string;
}

export async function resolveInformationRequest(
  requestId: string,
  status: 'needed' | 'requested' | 'received' | 'waived',
  note?: string,
): Promise<void> {
  const { error } = await getSupabase().rpc('specialty_resolve_information_request', {
    p_request_id: requestId,
    p_status: status,
    p_note: note?.trim() || null,
  });
  throwIfError(error);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Carrier markets
// ═══════════════════════════════════════════════════════════════════════════════

export async function addCarrierMarket(
  opportunityId: string,
  carrierId: string,
  status: CarrierMarketStatus = 'not_started',
  handledBy?: string | null,
): Promise<string> {
  const { data, error } = await getSupabase().rpc('specialty_add_carrier_market', {
    p_opportunity_id: opportunityId,
    p_carrier_id: carrierId,
    p_status: status,
    p_handled_by: handledBy ?? null,
  });
  throwIfError(error);
  return data as string;
}

export interface CarrierMarketPatch {
  status?: CarrierMarketStatus;
  handled_by?: string | null;
  follow_up_date?: string | null;
  premium?: number | string | null;
  down_payment?: number | string | null;
  payment_terms?: string | null;
  deductible?: string | null;
  coverage_notes?: string | null;
  decline_reason?: string | null;
  info_requested?: string | null;
  notes?: string | null;
  installment_count?: number | null;
  installment_amount?: number | null;
  quote_number?: string | null;
}

export async function updateCarrierMarket(
  marketId: string,
  patch: CarrierMarketPatch,
  expectedVersion: number,
): Promise<{ version: number; status: CarrierMarketStatus }> {
  const { data, error } = await getSupabase().rpc('specialty_update_carrier_market', {
    p_market_id: marketId,
    p_patch: patch,
    p_expected_version: expectedVersion,
  });
  throwIfError(error);
  return data as { version: number; status: CarrierMarketStatus };
}

/** Only possible before submission. A submitted market is withdrawn, not erased. */
export async function removeCarrierMarket(marketId: string): Promise<void> {
  const { error } = await getSupabase().rpc('specialty_remove_carrier_market', {
    p_market_id: marketId,
  });
  throwIfError(error);
}

/** Adds a carrier nobody has recorded before, mid-call. */
export async function createCarrier(
  name: string,
  linesOfBusiness: SpecialtyLine[],
  profileId: string,
): Promise<{ id: string; name: string }> {
  const { data, error } = await getSupabase()
    .from('specialty_carriers')
    .insert({ name: name.trim(), lines_of_business: linesOfBusiness, created_by: profileId })
    .select('id,name')
    .single();
  throwIfError(error);
  return data as { id: string; name: string };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing and outcome
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Records that specific options actually went to the customer.
 *
 * A carrier quote arriving is a different event and does not set this. The server
 * freezes a snapshot of the carriers and amounts presented, so correcting a premium
 * later cannot rewrite what the customer was told.
 */
export async function recordPriceSent(
  opportunityId: string,
  marketIds: string[],
  expectedVersion: number,
  options: { method?: PriceMethod | null; note?: string } = {},
): Promise<string> {
  const { data, error } = await getSupabase().rpc('specialty_record_price_sent', {
    p_opportunity_id: opportunityId,
    p_market_ids: marketIds,
    p_method: options.method ?? null,
    p_note: options.note?.trim() || null,
    p_expected_version: expectedVersion,
  });
  throwIfError(error);
  return data as string;
}

export interface RecordResultInput {
  result: 'sold' | 'not_sold';
  boundMarketId?: string | null;
  soldPremium?: number | null;
  lostReason?: SpecialtyLostReason | null;
  lostReasonNote?: string | null;
}

/** Sold needs a carrier and a premium; Not Sold needs a reason. Both server-checked. */
export async function recordResult(
  opportunityId: string,
  input: RecordResultInput,
  expectedVersion: number,
): Promise<void> {
  const { error } = await getSupabase().rpc('specialty_record_result', {
    p_opportunity_id: opportunityId,
    p_result: input.result,
    p_bound_market_id: input.boundMarketId ?? null,
    p_sold_premium: input.soldPremium ?? null,
    p_lost_reason: input.lostReason ?? null,
    p_lost_reason_note: input.lostReasonNote?.trim() || null,
    p_expected_version: expectedVersion,
  });
  throwIfError(error);
}

export async function clearResult(
  opportunityId: string,
  stage: SpecialtyStage = 'follow_up',
  reason?: string,
): Promise<void> {
  const { error } = await getSupabase().rpc('specialty_clear_result', {
    p_opportunity_id: opportunityId,
    p_stage: stage,
    p_reason: reason?.trim() || null,
  });
  throwIfError(error);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Documents
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Uploads a document and registers it.
 *
 * The object key is `<opportunity_id>/<uuid>.<ext>`: the first segment is what the
 * storage policy authorises against, and `specialty_register_document` refuses a
 * metadata row whose path sits under a different quote. If the metadata insert fails
 * the uploaded object is removed, so a half-written document cannot linger.
 */
export async function uploadDocument(
  opportunityId: string,
  file: File,
  options: { category?: DocumentCategory; carrierMarketId?: string | null } = {},
): Promise<string> {
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new Error('That file is larger than 100 MB. Upload a smaller copy.');
  }
  if (file.size === 0) {
    throw new Error('That file is empty.');
  }

  const supabase = getSupabase();
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'bin';
  const storagePath = `${opportunityId}/${crypto.randomUUID()}.${extension.replace(/[^a-z0-9]/g, '') || 'bin'}`;

  const { error: uploadError } = await supabase.storage.from(SPECIALTY_BUCKET).upload(storagePath, file, {
    upsert: false,
    cacheControl: '3600',
    contentType: file.type || 'application/octet-stream',
  });
  throwIfError(uploadError);

  try {
    const { data, error } = await supabase.rpc('specialty_register_document', {
      p_opportunity_id: opportunityId,
      p_file_name: file.name,
      p_file_size: file.size,
      p_mime_type: file.type || 'application/octet-stream',
      p_storage_path: storagePath,
      p_category: options.category ?? 'other',
      p_carrier_market_id: options.carrierMarketId ?? null,
    });
    throwIfError(error);
    return data as string;
  } catch (caught) {
    await supabase.storage.from(SPECIALTY_BUCKET).remove([storagePath]);
    throw caught;
  }
}

/**
 * A short-lived link to a document.
 *
 * Reads the bucket from the row rather than assuming one: an adopted legacy document
 * still lives in `commercial-quote-attachments` and was never copied.
 */
export async function getDocumentUrl(document: {
  storage_bucket: string;
  storage_path: string;
}): Promise<string> {
  const { data, error } = await getSupabase()
    .storage.from(document.storage_bucket)
    .createSignedUrl(document.storage_path, 3600);
  throwIfError(error);
  const url = (data as { signedUrl?: string } | null)?.signedUrl;
  if (!url) throw new Error('That document could not be opened.');
  return url;
}

/** Removes a document this user uploaded. Legacy references are history and stay. */
export async function deleteDocument(document: {
  id: string;
  storage_bucket: string;
  storage_path: string;
  is_legacy: boolean;
}): Promise<void> {
  if (document.is_legacy) {
    throw new Error('Documents migrated from the Commercial Board are kept as history.');
  }
  const supabase = getSupabase();
  const { error } = await supabase.from('specialty_documents').delete().eq('id', document.id);
  throwIfError(error);
  await supabase.storage.from(document.storage_bucket).remove([document.storage_path]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Reporting
// ═══════════════════════════════════════════════════════════════════════════════

export interface ReportRange {
  from?: string | null;
  to?: string | null;
  lineOfBusiness?: SpecialtyLine | 'all';
}

export async function getPipelineReport(range: ReportRange = {}): Promise<PipelineRow[]> {
  const { data, error } = await getSupabase().rpc('specialty_report_pipeline', {
    p_from: range.from ?? null,
    p_to: range.to ?? null,
    p_line_of_business: range.lineOfBusiness ?? 'all',
  });
  throwIfError(error);
  return (data as PipelineRow[]) ?? [];
}

export async function getWorkloadReport(
  lineOfBusiness: SpecialtyLine | 'all' = 'all',
): Promise<WorkloadRow[]> {
  const { data, error } = await getSupabase().rpc('specialty_report_workload', {
    p_line_of_business: lineOfBusiness,
  });
  throwIfError(error);
  return (data as WorkloadRow[]) ?? [];
}

export async function getContributionReport(range: ReportRange = {}): Promise<ContributionRow[]> {
  const { data, error } = await getSupabase().rpc('specialty_report_contributions', {
    p_from: range.from ?? null,
    p_to: range.to ?? null,
    p_line_of_business: range.lineOfBusiness ?? 'all',
  });
  throwIfError(error);
  return (data as ContributionRow[]) ?? [];
}

export async function getTimingReport(range: ReportRange = {}): Promise<TimingRow[]> {
  const { data, error } = await getSupabase().rpc('specialty_report_timing', {
    p_from: range.from ?? null,
    p_to: range.to ?? null,
    p_line_of_business: range.lineOfBusiness ?? 'all',
  });
  throwIfError(error);
  return (data as TimingRow[]) ?? [];
}

export async function getCarrierPerformanceReport(
  range: ReportRange = {},
): Promise<CarrierPerformanceRow[]> {
  const { data, error } = await getSupabase().rpc('specialty_report_carrier_performance', {
    p_from: range.from ?? null,
    p_to: range.to ?? null,
    p_line_of_business: range.lineOfBusiness ?? 'all',
  });
  throwIfError(error);
  return (data as CarrierPerformanceRow[]) ?? [];
}

export async function getLostBusinessReport(range: ReportRange = {}): Promise<LostBusinessRow[]> {
  const { data, error } = await getSupabase().rpc('specialty_report_lost_business', {
    p_from: range.from ?? null,
    p_to: range.to ?? null,
    p_line_of_business: range.lineOfBusiness ?? 'all',
  });
  throwIfError(error);
  return (data as LostBusinessRow[]) ?? [];
}

export async function getAttentionReport(
  lineOfBusiness: SpecialtyLine | 'all' = 'all',
): Promise<AttentionRow[]> {
  const { data, error } = await getSupabase().rpc('specialty_report_attention', {
    p_line_of_business: lineOfBusiness,
    p_limit_per_bucket: 25,
  });
  throwIfError(error);
  return (data as AttentionRow[]) ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Team administration
// ═══════════════════════════════════════════════════════════════════════════════

export async function getTeamsAdmin(): Promise<TeamsAdminPayload> {
  const { data, error } = await getSupabase().rpc('specialty_teams_admin');
  throwIfError(error);
  return data as TeamsAdminPayload;
}

export interface SaveTeamInput {
  teamId?: string | null;
  name: string;
  description?: string | null;
  assignmentMethod?: string;
  collaborativeEditing?: boolean;
  teamVisibility?: 'team' | 'agency';
  isActive?: boolean;
}

export async function saveTeam(input: SaveTeamInput): Promise<string> {
  const { data, error } = await getSupabase().rpc('specialty_team_save', {
    p_team_id: input.teamId ?? null,
    p_name: input.name,
    p_description: input.description ?? null,
    p_assignment_method: input.assignmentMethod ?? 'shared_claim',
    p_collaborative_editing: input.collaborativeEditing ?? true,
    p_team_visibility: input.teamVisibility ?? 'team',
    p_is_active: input.isActive ?? true,
  });
  throwIfError(error);
  return data as string;
}

export interface SaveMemberInput {
  teamId: string;
  profileId: string;
  canView?: boolean;
  canClaim?: boolean;
  canEdit?: boolean;
  canBeAssigned?: boolean;
  canReassign?: boolean;
  canViewReports?: boolean;
}

export async function saveTeamMember(input: SaveMemberInput): Promise<void> {
  const { error } = await getSupabase().rpc('specialty_team_save_member', {
    p_team_id: input.teamId,
    p_profile_id: input.profileId,
    p_can_view: input.canView ?? true,
    p_can_claim: input.canClaim ?? true,
    p_can_edit: input.canEdit ?? true,
    p_can_be_assigned: input.canBeAssigned ?? true,
    p_can_reassign: input.canReassign ?? true,
    p_can_view_reports: input.canViewReports ?? true,
  });
  throwIfError(error);
}

/**
 * Retires a member.
 *
 * Their membership row and all of their history survive. If they still hold active
 * assignments the server refuses unless `reassignTo` is supplied, and then transfers
 * each one with a full audit trail — nothing is ever silently stranded.
 */
export async function removeTeamMember(
  teamId: string,
  profileId: string,
  options: { reason?: string; reassignTo?: string | null } = {},
): Promise<{ removed: boolean; reassigned_count: number }> {
  const { data, error } = await getSupabase().rpc('specialty_team_remove_member', {
    p_team_id: teamId,
    p_profile_id: profileId,
    p_reason: options.reason?.trim() || null,
    p_reassign_to: options.reassignTo ?? null,
  });
  throwIfError(error);
  return data as { removed: boolean; reassigned_count: number };
}

export async function setLineRoute(
  lineOfBusiness: SpecialtyLine,
  teamId: string,
  workflowTemplateId?: string | null,
): Promise<void> {
  const { error } = await getSupabase().rpc('specialty_team_set_route', {
    p_line_of_business: lineOfBusiness,
    p_team_id: teamId,
    p_workflow_template_id: workflowTemplateId ?? null,
  });
  throwIfError(error);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Quote Center bridge
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The Customer Service view of a specialty journey.
 *
 * Returns null when the customer is not with a specialty team. Carrier markets,
 * premiums and internal strategy are absent by construction — the function only
 * selects shared information items and shared notes.
 */
export async function getCsSpecialtyStatus(intakeId: string): Promise<CsSpecialtyStatus | null> {
  const { data, error } = await getSupabase().rpc('specialty_cs_status', {
    p_intake_id: intakeId,
  });
  throwIfError(error);
  return (data as CsSpecialtyStatus | null) ?? null;
}

/** Customer Service supplies what the team asked for, without a new intake. */
export async function provideInformationFromCs(requestId: string, note: string): Promise<void> {
  const { error } = await getSupabase().rpc('specialty_cs_provide_information', {
    p_request_id: requestId,
    p_note: note,
  });
  throwIfError(error);
}

/** Customer Service documents a customer conversation against the specialty quote. */
export async function addCsNote(intakeId: string, note: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('specialty_cs_add_note', {
    p_intake_id: intakeId,
    p_note: note,
  });
  throwIfError(error);
  return data as string;
}

/** Submits a Trucking or Homeowners intake into Specialty Quotes. */
export async function submitIntakeToSpecialty(intakeId: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('cs_intake_submit_specialty', {
    p_submission_id: intakeId,
  });
  throwIfError(error);
  return data as string;
}

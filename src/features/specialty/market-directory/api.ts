'use client';

/**
 * Market Directory data access.
 *
 * Master market configuration (directory, aliases, contacts, requirements,
 * questions, templates) is managed by managers through direct table access with
 * RLS. Quote-level data (answers, satisfaction, underwriting results, generated
 * applications) inherits access from the existing specialty opportunity.
 *
 * v1.17.0
 */

import { getSupabase } from '../../nhwd-shared/client';
import type {
  GeneratedApplication,
  MarketAlias,
  MarketContact,
  MarketDirectoryEntry,
  MarketPdfTemplate,
  MarketQuestion,
  MarketQuestionAnswer,
  MarketRequirement,
  ReadinessInfo,
  ReadinessMissingItem,
  ReadinessState,
  RequirementSatisfaction,
  RequirementType,
  UnderwritingResult,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// Market Directory CRUD
// ═══════════════════════════════════════════════════════════════════════════════

/** List all markets, optionally filtered by LOB or active status. */
export async function listMarkets(options: {
  lineOfBusiness?: string | null;
  activeOnly?: boolean;
} = {}): Promise<MarketDirectoryEntry[]> {
  const sb = getSupabase();
  let query = sb
    .from('market_directory')
    .select('*, market_directory_aliases(*), market_directory_contacts(*)')
    .order('name');

  if (options.activeOnly !== false) {
    query = query.eq('is_active', true);
  }
  if (options.lineOfBusiness) {
    query = query.contains('lines_of_business', [options.lineOfBusiness]);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    ...row,
    aliases: (row.market_directory_aliases ?? []) as MarketAlias[],
    contacts: (row.market_directory_contacts ?? []) as MarketContact[],
  }));
}

/** Get a single market with all related data. */
export async function getMarket(id: string): Promise<MarketDirectoryEntry | null> {
  const { data, error } = await getSupabase()
    .from('market_directory')
    .select('*, market_directory_aliases(*), market_directory_contacts(*)')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(error.message);
  }

  return {
    ...data,
    aliases: (data.market_directory_aliases ?? []) as MarketAlias[],
    contacts: (data.market_directory_contacts ?? []) as MarketContact[],
  };
}

export interface MarketDirectoryPatch {
  name?: string;
  market_type?: string;
  lines_of_business?: string[];
  is_active?: boolean;
  website_url?: string | null;
  portal_url?: string | null;
  submission_email?: string | null;
  phone?: string | null;
  submission_instructions?: string | null;
  territory_notes?: string | null;
  equipment_notes?: string | null;
  new_venture_notes?: string | null;
  coverage_appetite?: string | null;
  underwriting_notes?: string | null;
}

/** Create a new Market Directory entry. */
export async function createMarket(
  patch: MarketDirectoryPatch & { name: string },
  profileId: string,
): Promise<MarketDirectoryEntry> {
  const { data, error } = await getSupabase()
    .from('market_directory')
    .insert({ ...patch, created_by: profileId })
    .select('*, market_directory_aliases(*), market_directory_contacts(*)')
    .single();

  if (error) throw new Error(error.message);
  return {
    ...data,
    aliases: [] as MarketAlias[],
    contacts: [] as MarketContact[],
  };
}

/** Update a Market Directory entry. */
export async function updateMarket(
  id: string,
  patch: MarketDirectoryPatch,
): Promise<void> {
  const { error } = await getSupabase()
    .from('market_directory')
    .update(patch)
    .eq('id', id);

  if (error) throw new Error(error.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Aliases
// ═══════════════════════════════════════════════════════════════════════════════

export async function addAlias(marketId: string, alias: string): Promise<string> {
  const { data, error } = await getSupabase()
    .from('market_directory_aliases')
    .insert({ market_id: marketId, alias: alias.trim() })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  return data.id;
}

export async function removeAlias(aliasId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('market_directory_aliases')
    .delete()
    .eq('id', aliasId);

  if (error) throw new Error(error.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Contacts
// ═══════════════════════════════════════════════════════════════════════════════

export interface MarketContactPatch {
  name?: string;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  is_primary?: boolean;
  is_active?: boolean;
}

export async function addContact(
  marketId: string,
  contact: MarketContactPatch & { name: string },
): Promise<string> {
  const { data, error } = await getSupabase()
    .from('market_directory_contacts')
    .insert({ ...contact, market_id: marketId })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  return data.id;
}

export async function updateContact(
  contactId: string,
  patch: MarketContactPatch,
): Promise<void> {
  const { error } = await getSupabase()
    .from('market_directory_contacts')
    .update(patch)
    .eq('id', contactId);

  if (error) throw new Error(error.message);
}

export async function removeContact(contactId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('market_directory_contacts')
    .delete()
    .eq('id', contactId);

  if (error) throw new Error(error.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Requirements
// ═══════════════════════════════════════════════════════════════════════════════

export async function listRequirements(
  marketId: string,
  lineOfBusiness: string,
): Promise<MarketRequirement[]> {
  const { data, error } = await getSupabase()
    .from('market_requirements')
    .select('*')
    .eq('market_id', marketId)
    .eq('line_of_business', lineOfBusiness)
    .eq('is_active', true)
    .order('sort_order');

  if (error) throw new Error(error.message);
  return data ?? [];
}

export interface MarketRequirementPatch {
  requirement_type?: string;
  label?: string;
  description?: string | null;
  is_required?: boolean;
  is_active?: boolean;
  sort_order?: number;
}

export async function addRequirement(
  marketId: string,
  lineOfBusiness: string,
  req: MarketRequirementPatch & { label: string; requirement_type: string },
): Promise<string> {
  const { data, error } = await getSupabase()
    .from('market_requirements')
    .insert({ ...req, market_id: marketId, line_of_business: lineOfBusiness })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  return data.id;
}

export async function updateRequirement(
  requirementId: string,
  patch: MarketRequirementPatch,
): Promise<void> {
  const { error } = await getSupabase()
    .from('market_requirements')
    .update(patch)
    .eq('id', requirementId);

  if (error) throw new Error(error.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Questions
// ═══════════════════════════════════════════════════════════════════════════════

export async function listQuestions(
  marketId: string,
  lineOfBusiness: string,
): Promise<MarketQuestion[]> {
  const { data, error } = await getSupabase()
    .from('market_questions')
    .select('*')
    .eq('market_id', marketId)
    .eq('line_of_business', lineOfBusiness)
    .eq('is_active', true)
    .order('sort_order');

  if (error) throw new Error(error.message);
  return data ?? [];
}

export interface MarketQuestionPatch {
  question_text?: string;
  field_type?: string;
  select_options?: string[] | null;
  is_required?: boolean;
  is_active?: boolean;
  sort_order?: number;
  auto_fill_source?: string | null;
}

export async function addQuestion(
  marketId: string,
  lineOfBusiness: string,
  q: MarketQuestionPatch & { question_text: string; field_type: string },
): Promise<string> {
  const { data, error } = await getSupabase()
    .from('market_questions')
    .insert({ ...q, market_id: marketId, line_of_business: lineOfBusiness })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  return data.id;
}

export async function updateQuestion(
  questionId: string,
  patch: MarketQuestionPatch,
): Promise<void> {
  const { error } = await getSupabase()
    .from('market_questions')
    .update(patch)
    .eq('id', questionId);

  if (error) throw new Error(error.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Question Answers (per carrier_market)
// ═══════════════════════════════════════════════════════════════════════════════

export async function getAnswersForCarrierMarket(
  carrierMarketId: string,
): Promise<MarketQuestionAnswer[]> {
  const { data, error } = await getSupabase()
    .from('market_question_answers')
    .select('*')
    .eq('carrier_market_id', carrierMarketId);

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function saveAnswer(
  carrierMarketId: string,
  questionId: string,
  value: string | null,
  profileId: string,
): Promise<void> {
  const { error } = await getSupabase()
    .from('market_question_answers')
    .upsert(
      {
        carrier_market_id: carrierMarketId,
        question_id: questionId,
        answer_value: value,
        answered_by: profileId,
        answered_at: new Date().toISOString(),
      },
      { onConflict: 'carrier_market_id,question_id' },
    );

  if (error) throw new Error(error.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Requirement Satisfaction (per carrier_market)
// ═══════════════════════════════════════════════════════════════════════════════

export async function getSatisfactionForCarrierMarket(
  carrierMarketId: string,
): Promise<RequirementSatisfaction[]> {
  const { data, error } = await getSupabase()
    .from('market_requirement_satisfaction')
    .select('*')
    .eq('carrier_market_id', carrierMarketId);

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function markRequirementSatisfied(
  carrierMarketId: string,
  requirementId: string,
  options: {
    documentId?: string | null;
    dataValue?: string | null;
    notes?: string | null;
    profileId: string;
  },
): Promise<void> {
  const { error } = await getSupabase()
    .from('market_requirement_satisfaction')
    .upsert(
      {
        carrier_market_id: carrierMarketId,
        requirement_id: requirementId,
        is_satisfied: true,
        satisfied_by: options.profileId,
        satisfied_at: new Date().toISOString(),
        document_id: options.documentId ?? null,
        data_value: options.dataValue ?? null,
        notes: options.notes ?? null,
      },
      { onConflict: 'carrier_market_id,requirement_id' },
    );

  if (error) throw new Error(error.message);
}

export async function markRequirementUnsatisfied(
  carrierMarketId: string,
  requirementId: string,
): Promise<void> {
  const { error } = await getSupabase()
    .from('market_requirement_satisfaction')
    .upsert(
      {
        carrier_market_id: carrierMarketId,
        requirement_id: requirementId,
        is_satisfied: false,
        satisfied_by: null,
        satisfied_at: null,
        document_id: null,
        data_value: null,
        notes: null,
      },
      { onConflict: 'carrier_market_id,requirement_id' },
    );

  if (error) throw new Error(error.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Readiness Calculation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculates readiness for a carrier market by evaluating its requirements
 * against satisfaction records.
 */
export async function calculateReadiness(
  carrierMarketId: string,
  marketDirectoryId: string,
  lineOfBusiness: string,
): Promise<ReadinessInfo> {
  const [requirements, satisfactions] = await Promise.all([
    listRequirements(marketDirectoryId, lineOfBusiness),
    getSatisfactionForCarrierMarket(carrierMarketId),
  ]);

  if (requirements.length === 0) {
    return { state: 'ready', total_requirements: 0, satisfied_requirements: 0, missing_items: [] };
  }

  const satisfiedSet = new Set(
    satisfactions.filter((s) => s.is_satisfied).map((s) => s.requirement_id),
  );

  const missing: ReadinessMissingItem[] = [];
  for (const req of requirements) {
    if (!satisfiedSet.has(req.id)) {
      missing.push({
        requirement_id: req.id,
        label: req.label,
        requirement_type: req.requirement_type as RequirementType,
        is_required: req.is_required,
      });
    }
  }

  let state: ReadinessState = 'ready';
  if (missing.length > 0) {
    const hasDocMissing = missing.some((m) => m.requirement_type === 'document');
    const hasDataMissing = missing.some((m) => m.requirement_type === 'data');
    const hasAppMissing = missing.some((m) => m.requirement_type === 'application');

    if (hasDocMissing) state = 'missing_documents';
    else if (hasDataMissing) state = 'missing_information';
    else if (hasAppMissing) state = 'review_required';
    else state = 'missing_information';
  }

  return {
    state,
    total_requirements: requirements.length,
    satisfied_requirements: requirements.length - missing.length,
    missing_items: missing,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Underwriting Results
// ═══════════════════════════════════════════════════════════════════════════════

export async function getUnderwritingResults(
  carrierMarketId: string,
): Promise<UnderwritingResult[]> {
  const { data, error } = await getSupabase()
    .from('specialty_underwriting_results')
    .select('*')
    .eq('carrier_market_id', carrierMarketId)
    .order('created_at');

  if (error) throw new Error(error.message);
  return data ?? [];
}

export interface UnderwritingResultPatch {
  underwriting_carrier?: string;
  coverage_type?: string;
  premium?: number | null;
  fees?: number | null;
  down_payment?: number | null;
  installment_count?: number | null;
  installment_amount?: number | null;
  limits?: string | null;
  deductible?: string | null;
  quote_reference_number?: string | null;
  notes?: string | null;
  proposal_document_id?: string | null;
}

export async function addUnderwritingResult(
  carrierMarketId: string,
  result: UnderwritingResultPatch & { underwriting_carrier: string; coverage_type: string },
  profileId: string,
): Promise<string> {
  const { data, error } = await getSupabase()
    .from('specialty_underwriting_results')
    .insert({ ...result, carrier_market_id: carrierMarketId, recorded_by: profileId })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  return data.id;
}

export async function updateUnderwritingResult(
  resultId: string,
  patch: UnderwritingResultPatch,
): Promise<void> {
  const { error } = await getSupabase()
    .from('specialty_underwriting_results')
    .update(patch)
    .eq('id', resultId);

  if (error) throw new Error(error.message);
}

export async function removeUnderwritingResult(resultId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('specialty_underwriting_results')
    .delete()
    .eq('id', resultId);

  if (error) throw new Error(error.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PDF Templates
// ═══════════════════════════════════════════════════════════════════════════════

export async function listTemplates(
  marketId: string,
  lineOfBusiness?: string,
): Promise<MarketPdfTemplate[]> {
  let query = getSupabase()
    .from('market_pdf_templates')
    .select('*')
    .eq('market_id', marketId)
    .eq('is_active', true)
    .order('template_name');

  if (lineOfBusiness) {
    query = query.eq('line_of_business', lineOfBusiness);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getTemplate(templateId: string): Promise<MarketPdfTemplate | null> {
  const { data, error } = await getSupabase()
    .from('market_pdf_templates')
    .select('*')
    .eq('id', templateId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(error.message);
  }
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Generated Applications
// ═══════════════════════════════════════════════════════════════════════════════

export async function getGeneratedApplications(
  carrierMarketId: string,
): Promise<GeneratedApplication[]> {
  const { data, error } = await getSupabase()
    .from('market_generated_applications')
    .select('*, market_pdf_templates(template_name)')
    .eq('carrier_market_id', carrierMarketId)
    .order('generated_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    ...row,
    template_name: (row.market_pdf_templates as { template_name: string } | null)?.template_name,
  }));
}

export async function markApplicationSubmitted(
  applicationId: string,
  profileId: string,
): Promise<void> {
  const { error } = await getSupabase()
    .from('market_generated_applications')
    .update({
      is_submitted: true,
      submitted_by: profileId,
      submitted_at: new Date().toISOString(),
      status: 'submitted',
    })
    .eq('id', applicationId);

  if (error) throw new Error(error.message);
}

/**
 * POST /api/specialty/generate-application
 *
 * Generates a PDF application for a carrier market using existing Work Desk data
 * and the configured template mapping.
 *
 * Request body:
 *   carrier_market_id: string
 *   template_id: string
 *   opportunity_id: string
 *
 * Returns: { application_id, file_name, storage_path, warnings }
 *
 * v1.17.0
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

import { buildTruckingDataPacket, computeDataHash } from '@/features/specialty/market-directory/trucking-data-adapter';
import type { LinkedIntake } from '@/features/specialty/types';

import { generatePdfFromTemplate } from './pdf-engine';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured.' }, { status: 503 });
  }

  // Verify the user is authenticated
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const body = await request.json();
  const { carrier_market_id, template_id, opportunity_id } = body;

  if (!carrier_market_id || !template_id || !opportunity_id) {
    return NextResponse.json(
      { error: 'carrier_market_id, template_id, and opportunity_id are required' },
      { status: 400 },
    );
  }

  // 1. Load the template configuration with market name
  const { data: template, error: templateError } = await supabase
    .from('market_pdf_templates')
    .select('*, market_directory(name)')
    .eq('id', template_id)
    .single();

  if (templateError || !template) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  }

  // 2. Load the opportunity (RLS enforces team access)
  const { data: opportunity, error: oppError } = await supabase
    .from('specialty_opportunities')
    .select('id, line_of_business, source_intake_id, display_name')
    .eq('id', opportunity_id)
    .single();

  if (oppError || !opportunity) {
    return NextResponse.json({ error: 'Opportunity not found or access denied' }, { status: 404 });
  }

  // 3. Load the linked intake data
  if (!opportunity.source_intake_id) {
    return NextResponse.json(
      { error: 'No linked intake found for this opportunity' },
      { status: 400 },
    );
  }

  const { data: intake, error: intakeError } = await supabase
    .from('cs_intake_submissions')
    .select('*, cs_intake_drivers(*), cs_intake_vehicles(*), cs_intake_owners(*), cs_intake_commodities(*), cs_intake_trailers(*)')
    .eq('id', opportunity.source_intake_id)
    .single();

  if (intakeError || !intake) {
    return NextResponse.json(
      { error: 'Linked intake not found' },
      { status: 400 },
    );
  }

  // 4. Load market-specific question answers
  const { data: answers } = await supabase
    .from('market_question_answers')
    .select('*, market_questions(question_text, auto_fill_source)')
    .eq('carrier_market_id', carrier_market_id);

  // 5. Build the trucking data packet from the intake
  // Map the raw query result to the LinkedIntake shape the adapter expects
  const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;
  const intakeForAdapter = {
    ...intake,
    drivers: (intake.cs_intake_drivers ?? []).sort(byPosition),
    vehicles: (intake.cs_intake_vehicles ?? []).sort(byPosition),
    owners: (intake.cs_intake_owners ?? []).slice().sort(byPosition),
    trailers: (intake.cs_intake_trailers ?? []).sort(byPosition),
    // Commodities have no position column; the primary one leads, as it does in
    // the intake UI and in specialty_opportunity_detail.
    commodities: (intake.cs_intake_commodities ?? []).slice().sort(
      (a: { is_primary: boolean; category: string }, b: { is_primary: boolean; category: string }) =>
        Number(b.is_primary) - Number(a.is_primary) || a.category.localeCompare(b.category),
    ),
  };
  const dataPacket = buildTruckingDataPacket(intakeForAdapter as unknown as LinkedIntake);
  const sourceHash = computeDataHash(dataPacket);

  // 6. Build the supplemental answers map
  const supplementalAnswers: Record<string, string | null> = {};
  for (const answer of answers ?? []) {
    const question = answer.market_questions as { question_text: string; auto_fill_source: string | null } | null;
    if (question) {
      supplementalAnswers[question.question_text] = answer.answer_value;
    }
  }

  // 7. Download the blank template PDF (if one has been uploaded)
  let templatePdfBytes: Uint8Array | null = null;
  if (template.storage_path) {
    const { data: templateFileData, error: downloadError } = await supabase.storage
      .from(template.storage_bucket || 'specialty-quote-documents')
      .download(template.storage_path);

    if (!downloadError && templateFileData) {
      templatePdfBytes = new Uint8Array(await templateFileData.arrayBuffer());
    }
  }

  // 8. Generate the PDF
  const warnings: string[] = [];
  let pdfBuffer: Buffer;

  try {
    const result = await generatePdfFromTemplate({
      template,
      dataPacket,
      supplementalAnswers,
      maxDrivers: template.max_drivers ?? undefined,
      maxVehicles: template.max_vehicles ?? undefined,
      templatePdfBytes,
    });
    pdfBuffer = result.buffer;
    warnings.push(...result.warnings);
  } catch (err) {
    return NextResponse.json(
      { error: `PDF generation failed: ${err instanceof Error ? err.message : 'Unknown error'}` },
      { status: 500 },
    );
  }

  // 8. Determine the version number (count existing applications + 1)
  const { count } = await supabase
    .from('market_generated_applications')
    .select('id', { count: 'exact', head: true })
    .eq('carrier_market_id', carrier_market_id)
    .eq('template_id', template_id);

  const version = (count ?? 0) + 1;

  // 9. Upload to storage — Named: "Carrier - Company Name_v1.pdf"
  const marketName = (template.market_directory as { name: string } | null)?.name ?? template.template_name;
  const companyName = dataPacket.business.legal_name ?? opportunity.display_name ?? 'Unknown';
  const safeMarket = marketName.replace(/[/\\?%*:|"<>]/g, '').trim();
  const safeCompany = companyName.replace(/[/\\?%*:|"<>]/g, '').trim();
  const fileName = `${safeMarket} - ${safeCompany}_v${version}.pdf`;
  const storagePath = `${opportunity_id}/generated/${carrier_market_id}/${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from('specialty-quote-documents')
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json(
      { error: `Upload failed: ${uploadError.message}` },
      { status: 500 },
    );
  }

  // 10. Register it as a Quote Document FIRST.
  //
  //     Spec: .kiro/specs/carrier-email-submission, Requirement 3.3 (Task A.2).
  //
  //     This insert used to sit after step 11 and its error was discarded. When it
  //     failed, the PDF existed in storage and in `market_generated_applications` but
  //     never appeared in the Documents panel — invisible to the user, and once carrier
  //     email submission ships, impossible to attach to a submission.
  //
  //     The order matters as much as the check. `market_generated_applications` has no
  //     delete policy, so a row written there cannot be withdrawn by this session
  //     client. `specialty_documents` does have one (`uploaded_by = auth.uid()`), and so
  //     does the storage object. Writing the undoable rows first means every failure
  //     below can be fully rolled back rather than leaving the three stores disagreeing.
  const { data: documentRow, error: documentError } = await supabase
    .from('specialty_documents')
    .insert({
      opportunity_id,
      carrier_market_id,
      uploaded_by: user.id,
      file_name: fileName,
      file_size: pdfBuffer.length,
      mime_type: 'application/pdf',
      storage_bucket: 'specialty-quote-documents',
      storage_path: storagePath,
      category: 'generated_application',
    })
    .select('id')
    .single();

  if (documentError || !documentRow) {
    // Undo the upload so a retry is not blocked by `upsert: false` colliding with an
    // orphaned object at the same path.
    await supabase.storage.from('specialty-quote-documents').remove([storagePath]);
    return NextResponse.json(
      { error: `Failed to record the application as a document: ${documentError?.message ?? 'unknown error'}` },
      { status: 500 },
    );
  }

  // 11. Record the generated application in its own versioned ledger.
  const { data: application, error: insertError } = await supabase
    .from('market_generated_applications')
    .insert({
      carrier_market_id,
      template_id,
      opportunity_id,
      storage_bucket: 'specialty-quote-documents',
      storage_path: storagePath,
      file_name: fileName,
      file_size: pdfBuffer.length,
      generated_by: user.id,
      generation_version: version,
      source_data_hash: sourceHash,
      status: 'review_required',
    })
    .select('id')
    .single();

  if (insertError || !application) {
    // Both of these are within this session's rights to undo, which is why step 10 runs
    // first. Leaving either behind would surface a document the ledger does not know
    // about, or an object with no metadata at all.
    await supabase.from('specialty_documents').delete().eq('id', documentRow.id);
    await supabase.storage.from('specialty-quote-documents').remove([storagePath]);
    return NextResponse.json(
      { error: `Failed to record application: ${insertError?.message ?? 'unknown error'}` },
      { status: 500 },
    );
  }

  // 12. Record activity
  await supabase
    .from('specialty_activity')
    .insert({
      opportunity_id,
      carrier_market_id,
      actor_profile_id: user.id,
      event_type: version === 1 ? 'application_generated' : 'application_regenerated',
      detail: {
        template_name: template.template_name,
        version,
        file_name: fileName,
      },
    });

  return NextResponse.json({
    application_id: application.id,
    file_name: fileName,
    storage_path: storagePath,
    version,
    warnings,
  });
}

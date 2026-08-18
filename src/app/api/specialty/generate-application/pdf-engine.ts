/**
 * PDF Generation Engine
 *
 * Uses pdf-lib to fill the actual official carrier application PDFs with
 * Work Desk data. The blank official template is stored in Supabase storage;
 * this engine downloads it, fills form fields (AcroForm) or overlays text
 * at mapped coordinates, and returns the filled PDF buffer.
 *
 * Fallback: if no template file is stored (storage_path is null), generates
 * a structured document using pdfkit.
 *
 * v1.17.0 — Rewritten to fill official forms rather than generate new layouts.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import PDFDocumentKit from 'pdfkit';

import type { TruckingDataPacket } from '@/features/specialty/market-directory/types';

export interface PdfGenerationInput {
  template: {
    id: string;
    template_name: string;
    field_mapping: Record<string, unknown>;
    storage_path: string | null;
    max_drivers?: number | null;
    max_vehicles?: number | null;
    max_trailers?: number | null;
  };
  dataPacket: TruckingDataPacket;
  supplementalAnswers: Record<string, string | null>;
  maxDrivers?: number;
  maxVehicles?: number;
  /** The blank template PDF bytes, if available */
  templatePdfBytes?: Uint8Array | null;
}

export interface PdfGenerationResult {
  buffer: Buffer;
  warnings: string[];
}

/**
 * Generates a filled PDF. If templatePdfBytes are provided, fills the actual
 * official form. Otherwise falls back to pdfkit-generated structured output.
 */
export async function generatePdfFromTemplate(input: PdfGenerationInput): Promise<PdfGenerationResult> {
  const { templatePdfBytes } = input;

  if (templatePdfBytes && templatePdfBytes.length > 0) {
    return fillOfficialTemplate(input);
  }

  // Fallback: generate a structured document with pdfkit
  return generateFallbackPdf(input);
}

// ═══════════════════════════════════════════════════════════════════════════════
// OFFICIAL TEMPLATE FILLING (pdf-lib)
//
// Opens the actual blank PDF from JSA/TIA, finds form fields or overlays text
// at the mapped coordinates, and produces the filled version.
// ═══════════════════════════════════════════════════════════════════════════════

async function fillOfficialTemplate(input: PdfGenerationInput): Promise<PdfGenerationResult> {
  const { template, dataPacket, supplementalAnswers, templatePdfBytes } = input;
  const warnings: string[] = [];

  const pdfDoc = await PDFDocument.load(templatePdfBytes!);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 9;

  // Try AcroForm filling first
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  if (fields.length > 0) {
    // The PDF has interactive form fields — fill them by name
    fillFormFields(form, dataPacket, supplementalAnswers, template, warnings);
  } else {
    // No form fields — overlay text at mapped coordinate positions
    overlayTextOnTemplate(pdfDoc, font, fontSize, dataPacket, supplementalAnswers, template, warnings);
  }

  // Flatten form so fields appear as static text (not editable in Acrobat)
  try {
    form.flatten();
  } catch {
    // Some forms may not support flattening — that's OK
  }

  const filledBytes = await pdfDoc.save();
  return { buffer: Buffer.from(filledBytes), warnings };
}

/**
 * Fills AcroForm fields by matching field names to our data.
 */
function fillFormFields(
  form: ReturnType<typeof PDFDocument.prototype.getForm>,
  dataPacket: TruckingDataPacket,
  supplementalAnswers: Record<string, string | null>,
  template: PdfGenerationInput['template'],
  warnings: string[],
) {
  const biz = dataPacket.business;
  const ops = dataPacket.operations;
  const cov = dataPacket.coverages;
  const prior = dataPacket.prior_insurance;

  // Build a flat data map from our structured data
  const dataMap: Record<string, string> = {
    // Business / Applicant
    'applicant_name': biz.legal_name ?? '',
    'Applicant Name': biz.legal_name ?? '',
    'dba': biz.dba ?? '',
    'DBA': biz.dba ?? '',
    'mailing_address': [biz.mailing_street, biz.mailing_city, biz.mailing_state, biz.mailing_zip].filter(Boolean).join(', '),
    'Mailing Address': [biz.mailing_street, biz.mailing_city, biz.mailing_state, biz.mailing_zip].filter(Boolean).join(', '),
    'location_address': [biz.garaging_street, biz.garaging_city, biz.garaging_state, biz.garaging_zip].filter(Boolean).join(', '),
    'Location Address': [biz.garaging_street, biz.garaging_city, biz.garaging_state, biz.garaging_zip].filter(Boolean).join(', '),
    'owner_name': dataPacket.owners[0]?.name ?? '',
    "Owner's Name": dataPacket.owners[0]?.name ?? '',
    'owner_dob': dataPacket.owners[0]?.dob ?? '',
    'DOB': dataPacket.owners[0]?.dob ?? '',
    'dot_number': biz.dot_number ?? '',
    'DOT #': biz.dot_number ?? '',
    'mc_number': biz.mc_number ?? '',
    'MC #': biz.mc_number ?? '',
    'fein': biz.fein ?? '',
    'FEIN': biz.fein ?? '',
    'phone': biz.phone ?? '',
    'Phone': biz.phone ?? '',
    'email': biz.email ?? '',
    'Email': biz.email ?? '',
    'entity_type': biz.entity_type ?? '',
    'years_insured': biz.years_in_business?.toString() ?? '',
    'Years Insured Under This Name': biz.years_in_business?.toString() ?? '',
    'years_experience': biz.years_experience?.toString() ?? biz.years_in_business?.toString() ?? '',
    'Years Experience': biz.years_experience?.toString() ?? biz.years_in_business?.toString() ?? '',
    'description_operations': ops.commodities ?? '',
    'Description of Risk/Operations': ops.commodities ?? '',

    // Operations
    'radius_operations': ops.states ?? `${ops.radius ?? ''} miles`,
    'Radius of Operations': ops.states ?? `${ops.radius ?? ''} miles`,
    'commodities': ops.commodities ?? '',

    // Coverages
    'auto_liability_limits': cov.auto_liability_limit ?? '',
    'Auto Liability Limits': cov.auto_liability_limit ?? '',
    'Limits': cov.auto_liability_limit ?? '',
    'physical_damage_deductible': `Comp: ${cov.comprehensive_deductible ?? ''} Coll: ${cov.collision_deductible ?? ''}`,
    'Deductible': cov.collision_deductible ?? '',
    'cargo_limits': cov.cargo_limit ?? '',
    'Cargo Limits': cov.cargo_limit ?? '',

    // Prior insurance
    'current_carrier': prior.carrier ?? '',
    'Insurance Company': prior.carrier ?? '',
    'policy_number': prior.policy_number ?? '',
    'Policy Number': prior.policy_number ?? '',
    'current_premium': prior.premium?.toString() ?? '',

    // Agent
    'agent_name': 'Jason Toro',
    'Agent Name': 'Jason Toro',
    'agent_email': 'jtoro@newhopeins.com',
    'Agent Email': 'jtoro@newhopeins.com',
    'agency_name': 'New Hope Insurance',
    'Agency Name': 'New Hope Insurance',
  };

  // Add supplemental answers
  for (const [key, val] of Object.entries(supplementalAnswers)) {
    if (val) dataMap[key] = val;
  }

  // Try to fill each field
  const fields = form.getFields();
  let filledCount = 0;
  for (const field of fields) {
    const fieldName = field.getName();
    const value = dataMap[fieldName];
    if (value !== undefined) {
      try {
        const textField = form.getTextField(fieldName);
        textField.setText(value);
        filledCount++;
      } catch {
        // Field might be a checkbox or other type — skip
      }
    }
  }

  if (filledCount === 0 && fields.length > 0) {
    warnings.push(
      `The template has ${fields.length} form fields but none matched our data keys. ` +
      `Field names found: ${fields.slice(0, 10).map(f => f.getName()).join(', ')}`,
    );
  }

  // Fill driver rows
  for (let i = 0; i < Math.min(dataPacket.drivers.length, template.max_drivers ?? 10); i++) {
    const d = dataPacket.drivers[i];
    const name = [d.first_name, d.last_name].filter(Boolean).join(' ');
    trySetField(form, `driver_${i + 1}_name`, name);
    trySetField(form, `Driver Name_${i + 1}`, name);
    trySetField(form, `driver_${i + 1}_dob`, d.dob ?? '');
    trySetField(form, `driver_${i + 1}_state`, d.license_state ?? '');
    trySetField(form, `driver_${i + 1}_license`, d.license_number ?? '');
    trySetField(form, `driver_${i + 1}_exp`, d.years_licensed?.toString() ?? '');
  }

  // Fill vehicle rows
  for (let i = 0; i < Math.min(dataPacket.vehicles.length, template.max_vehicles ?? 15); i++) {
    const v = dataPacket.vehicles[i];
    trySetField(form, `vehicle_${i + 1}_year`, v.year?.toString() ?? '');
    trySetField(form, `vehicle_${i + 1}_make`, v.make ?? '');
    trySetField(form, `vehicle_${i + 1}_type`, v.type ?? '');
    trySetField(form, `vehicle_${i + 1}_vin`, v.vin ?? '');
    trySetField(form, `vehicle_${i + 1}_value`, v.value?.toString() ?? '');
  }

  // Check overflow
  if (dataPacket.drivers.length > (template.max_drivers ?? 10)) {
    warnings.push(`${dataPacket.drivers.length} drivers exceed the template's ${template.max_drivers} rows. Attach a continuation schedule.`);
  }
  if (dataPacket.vehicles.length > (template.max_vehicles ?? 15)) {
    warnings.push(`${dataPacket.vehicles.length} vehicles exceed the template's ${template.max_vehicles} rows. Attach a continuation schedule.`);
  }
}

function trySetField(form: ReturnType<typeof PDFDocument.prototype.getForm>, name: string, value: string) {
  try {
    const field = form.getTextField(name);
    field.setText(value);
  } catch {
    // Field doesn't exist — that's fine
  }
}

/**
 * Overlays text at mapped coordinate positions when the PDF has no AcroForm fields.
 * Uses the field_mapping from the template configuration.
 */
function overlayTextOnTemplate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfDoc: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  font: any,
  fontSize: number,
  dataPacket: TruckingDataPacket,
  supplementalAnswers: Record<string, string | null>,
  template: PdfGenerationInput['template'],
  warnings: string[],
) {
  const biz = dataPacket.business;
  const ops = dataPacket.operations;
  const cov = dataPacket.coverages;
  const prior = dataPacket.prior_insurance;
  const pages = pdfDoc.getPages();

  // Build data lookup
  const dataLookup: Record<string, string> = {
    'business.legal_name': biz.legal_name ?? '',
    'business.dba': biz.dba ?? '',
    'business.mailing_address': [biz.mailing_street, biz.mailing_city, biz.mailing_state, biz.mailing_zip].filter(Boolean).join(', '),
    'business.garaging_address': [biz.garaging_street, biz.garaging_city, biz.garaging_state, biz.garaging_zip].filter(Boolean).join(', '),
    'business.dot_number': biz.dot_number ?? '',
    'business.mc_number': biz.mc_number ?? '',
    'business.fein': biz.fein ?? '',
    'business.phone': biz.phone ?? '',
    'business.email': biz.email ?? '',
    'business.entity_type': biz.entity_type ?? '',
    'business.years_in_business': biz.years_in_business?.toString() ?? '',
    'business.years_experience': biz.years_experience?.toString() ?? '',
    'owners[0].name': dataPacket.owners[0]?.name ?? '',
    'owners[0].dob': dataPacket.owners[0]?.dob ?? '',
    'operations.commodities': ops.commodities ?? '',
    'operations.radius': ops.radius?.toString() ?? '',
    'operations.states': ops.states ?? '',
    'coverages.auto_liability_limit': cov.auto_liability_limit ?? '',
    'coverages.cargo_limit': cov.cargo_limit ?? '',
    'coverages.comprehensive_deductible': cov.comprehensive_deductible ?? '',
    'coverages.collision_deductible': cov.collision_deductible ?? '',
    'prior_insurance.carrier': prior.carrier ?? '',
    'prior_insurance.policy_number': prior.policy_number ?? '',
    'prior_insurance.premium': prior.premium?.toString() ?? '',
    'prior_insurance.expiration': prior.expiration ?? '',
  };

  // Add supplemental answers
  for (const [key, val] of Object.entries(supplementalAnswers)) {
    if (val) dataLookup[`supplemental.${key}`] = val;
  }

  // Process field_mapping: each entry has { pdf_field, page, x, y } or just { pdf_field, page }
  const mapping = template.field_mapping as Record<string, { page?: number; x?: number; y?: number; pdf_field?: string }>;
  let overlaidCount = 0;

  for (const [dataKey, config] of Object.entries(mapping)) {
    if (!config || typeof config !== 'object') continue;
    const pageNum = (config.page ?? 1) - 1;
    if (pageNum >= pages.length || pageNum < 0) continue;

    const value = dataLookup[dataKey] ?? '';
    if (!value) continue;

    if (config.x !== undefined && config.y !== undefined) {
      const page = pages[pageNum];
      page.drawText(value, {
        x: config.x,
        y: config.y,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
      overlaidCount++;
    }
  }

  if (overlaidCount === 0) {
    warnings.push(
      'No coordinate mappings found in the template field_mapping. ' +
      'The official form was returned as-is. Update the template with x/y coordinates to fill fields.',
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FALLBACK: pdfkit structured document (when no template file exists)
// ═══════════════════════════════════════════════════════════════════════════════

/** Collects a PDFKit stream into a Buffer. */
function finalizePdfKit(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function generateFallbackPdf(input: PdfGenerationInput): Promise<PdfGenerationResult> {
  const { template, dataPacket, supplementalAnswers, maxDrivers, maxVehicles } = input;
  const warnings: string[] = [];
  const biz = dataPacket.business;
  const ops = dataPacket.operations;
  const cov = dataPacket.coverages;
  const prior = dataPacket.prior_insurance;

  warnings.push(
    `No official template PDF uploaded for "${template.template_name}". ` +
    'A structured summary was generated instead. Upload the official blank form to fill it directly.',
  );

  if (maxDrivers && dataPacket.drivers.length > maxDrivers) {
    warnings.push(`Supports ${maxDrivers} drivers but ${dataPacket.drivers.length} exist. Attach a continuation schedule.`);
  }
  if (maxVehicles && dataPacket.vehicles.length > maxVehicles) {
    warnings.push(`Supports ${maxVehicles} vehicles but ${dataPacket.vehicles.length} exist. Attach a continuation schedule.`);
  }

  const doc = new PDFDocumentKit({ size: 'LETTER', margin: 50 });

  doc.fontSize(14).font('Helvetica-Bold').text(template.template_name, { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(8).font('Helvetica').text(`Generated: ${new Date().toLocaleDateString()} | New Hope Work Desk`, { align: 'center' });
  doc.fontSize(8).text('NOTE: Upload the official blank template to generate the actual carrier form.', { align: 'center' });
  doc.moveDown(1);

  // Business
  doc.fontSize(10).font('Helvetica-Bold').text('APPLICANT INFORMATION');
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica');
  doc.text(`Applicant Name: ${biz.legal_name ?? ''}`);
  doc.text(`DBA: ${biz.dba ?? ''}`);
  doc.text(`Address: ${[biz.mailing_street, biz.mailing_city, biz.mailing_state, biz.mailing_zip].filter(Boolean).join(', ')}`);
  doc.text(`DOT #: ${biz.dot_number ?? ''}     MC #: ${biz.mc_number ?? ''}`);
  doc.text(`Phone: ${biz.phone ?? ''}     Email: ${biz.email ?? ''}`);
  doc.text(`Owner: ${dataPacket.owners[0]?.name ?? ''}     DOB: ${dataPacket.owners[0]?.dob ?? ''}`);
  doc.text(`Years in Business: ${biz.years_in_business ?? ''}     Entity: ${biz.entity_type ?? ''}`);
  doc.moveDown(0.5);

  // Operations
  doc.font('Helvetica-Bold').text('OPERATIONS');
  doc.moveDown(0.2);
  doc.font('Helvetica');
  doc.text(`Commodities: ${ops.commodities ?? ''}`);
  doc.text(`Radius: ${ops.radius ?? ''} miles     States: ${ops.states ?? ''}`);
  doc.moveDown(0.5);

  // Coverages
  doc.font('Helvetica-Bold').text('COVERAGES');
  doc.moveDown(0.2);
  doc.font('Helvetica');
  doc.text(`Auto Liability: ${cov.auto_liability_limit ?? ''}     Cargo: ${cov.cargo_limit ?? ''}`);
  doc.text(`Comp Ded: ${cov.comprehensive_deductible ?? ''}     Coll Ded: ${cov.collision_deductible ?? ''}`);
  doc.moveDown(0.5);

  // Prior
  doc.font('Helvetica-Bold').text('PRIOR INSURANCE');
  doc.moveDown(0.2);
  doc.font('Helvetica');
  doc.text(`Carrier: ${prior.carrier ?? ''}     Premium: ${prior.premium ? `$${prior.premium}` : ''}`);
  doc.text(`Policy #: ${prior.policy_number ?? ''}     Expires: ${prior.expiration ?? ''}`);
  doc.moveDown(0.5);

  // Drivers
  if (dataPacket.drivers.length > 0) {
    doc.font('Helvetica-Bold').text('DRIVERS');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(8);
    const drvs = maxDrivers ? dataPacket.drivers.slice(0, maxDrivers) : dataPacket.drivers;
    for (const d of drvs) {
      const name = [d.first_name, d.last_name].filter(Boolean).join(' ');
      doc.text(`${name} | DOB: ${d.dob ?? ''} | CDL: ${d.license_number ?? ''} (${d.license_state ?? ''}) | Exp: ${d.years_licensed ?? ''} yrs`);
    }
    doc.moveDown(0.5);
  }

  // Vehicles
  if (dataPacket.vehicles.length > 0) {
    doc.fontSize(9).font('Helvetica-Bold').text('VEHICLES');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(8);
    const vehs = maxVehicles ? dataPacket.vehicles.slice(0, maxVehicles) : dataPacket.vehicles;
    for (const v of vehs) {
      doc.text(`${v.year ?? ''} ${v.make ?? ''} ${v.model ?? ''} | VIN: ${v.vin ?? ''} | Value: ${v.value ? `$${v.value}` : ''}`);
    }
    doc.moveDown(0.5);
  }

  // Supplemental
  const answered = Object.entries(supplementalAnswers).filter(([, v]) => v);
  if (answered.length > 0) {
    doc.fontSize(9).font('Helvetica-Bold').text('SUPPLEMENTAL INFORMATION');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(8);
    for (const [q, a] of answered) {
      doc.text(`${q}: ${a}`);
    }
  }

  const buffer = await finalizePdfKit(doc);
  return { buffer, warnings };
}

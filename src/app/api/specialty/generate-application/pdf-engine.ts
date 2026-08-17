/**
 * PDF Generation Engine
 *
 * Uses pdfkit to generate filled PDF applications from template field mappings
 * and structured trucking data. Designed to be reusable across JSA, TIA, and
 * any future Market templates.
 *
 * When official blank PDF templates are available, this engine can be extended
 * to fill AcroForm fields on existing PDFs. For now, it generates a structured
 * document that matches the expected carrier application layout.
 *
 * v1.17.0
 */

import PDFDocument from 'pdfkit';

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
}

export interface PdfGenerationResult {
  buffer: Buffer;
  warnings: string[];
}

/**
 * Generates a PDF from a template configuration and data packet.
 *
 * If the template has a stored blank PDF (storage_path is set), this would
 * fill form fields on that PDF. Since official templates require manual upload,
 * this generates a structured document matching the application layout.
 */
export function generatePdfFromTemplate(input: PdfGenerationInput): PdfGenerationResult {
  const { template, dataPacket, supplementalAnswers, maxDrivers, maxVehicles } = input;
  const warnings: string[] = [];

  // Check for overflow conditions
  if (maxDrivers && dataPacket.drivers.length > maxDrivers) {
    warnings.push(
      `This application supports ${maxDrivers} drivers but ${dataPacket.drivers.length} exist. ` +
      `Only the first ${maxDrivers} will be included. A continuation schedule may be needed.`,
    );
  }
  if (maxVehicles && dataPacket.vehicles.length > maxVehicles) {
    warnings.push(
      `This application supports ${maxVehicles} vehicles but ${dataPacket.vehicles.length} exist. ` +
      `Only the first ${maxVehicles} will be included. A continuation schedule may be needed.`,
    );
  }

  // Generate the PDF
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  const chunks: Buffer[] = [];

  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  // ── Header
  doc.fontSize(16).font('Helvetica-Bold')
    .text(`${template.template_name}`, { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(9).font('Helvetica')
    .text(`Generated: ${new Date().toLocaleDateString()} | Source: New Hope Work Desk`, { align: 'center' });
  doc.moveDown(1);

  // ── Applicant / Business Section
  sectionHeader(doc, 'APPLICANT INFORMATION');
  const biz = dataPacket.business;
  fieldRow(doc, 'Legal Name', biz.legal_name);
  fieldRow(doc, 'DBA', biz.dba);
  fieldRow(doc, 'Entity Type', biz.entity_type);
  fieldRow(doc, 'DOT #', biz.dot_number);
  fieldRow(doc, 'MC #', biz.mc_number);
  fieldRow(doc, 'FEIN', biz.fein);
  fieldRow(doc, 'Phone', biz.phone);
  fieldRow(doc, 'Email', biz.email);
  fieldRow(doc, 'Years in Business', biz.years_in_business?.toString() ?? null);
  fieldRow(doc, 'Years Experience', biz.years_experience?.toString() ?? null);
  doc.moveDown(0.5);

  // ── Address
  sectionHeader(doc, 'ADDRESS');
  fieldRow(doc, 'Mailing Address', formatAddress(biz.mailing_street, biz.mailing_unit, biz.mailing_city, biz.mailing_state, biz.mailing_zip));
  fieldRow(doc, 'Garaging Address', formatAddress(biz.garaging_street, null, biz.garaging_city, biz.garaging_state, biz.garaging_zip));
  doc.moveDown(0.5);

  // ── Operations
  sectionHeader(doc, 'OPERATIONS');
  const ops = dataPacket.operations;
  fieldRow(doc, 'Commodities', ops.commodities);
  fieldRow(doc, 'Radius (miles)', ops.radius?.toString() ?? null);
  fieldRow(doc, 'States', ops.states);
  fieldRow(doc, 'Revenue', ops.revenue ? `$${ops.revenue.toLocaleString()}` : null);
  fieldRow(doc, 'Annual Mileage', ops.mileage?.toString() ?? null);
  fieldRow(doc, 'Brokerage %', ops.brokerage_percentage ? `${ops.brokerage_percentage}%` : null);
  fieldRow(doc, 'Interstate', ops.interstate === null ? null : ops.interstate ? 'Yes' : 'No');
  fieldRow(doc, 'For Hire', ops.for_hire === null ? null : ops.for_hire ? 'Yes' : 'No');
  fieldRow(doc, 'Owner Operators', ops.owner_operators?.toString() ?? null);
  doc.moveDown(0.5);

  // ── Coverages
  sectionHeader(doc, 'COVERAGES REQUESTED');
  const cov = dataPacket.coverages;
  fieldRow(doc, 'Auto Liability Limit', cov.auto_liability_limit);
  fieldRow(doc, 'Cargo Limit', cov.cargo_limit);
  fieldRow(doc, 'Physical Damage', cov.physical_damage === null ? null : cov.physical_damage ? 'Yes' : 'No');
  fieldRow(doc, 'General Liability', cov.general_liability === null ? null : cov.general_liability ? 'Yes' : 'No');
  fieldRow(doc, 'Trailer Interchange', cov.trailer_interchange === null ? null : cov.trailer_interchange ? 'Yes' : 'No');
  fieldRow(doc, 'Comprehensive Deductible', cov.comprehensive_deductible);
  fieldRow(doc, 'Collision Deductible', cov.collision_deductible);
  doc.moveDown(0.5);

  // ── Prior Insurance
  sectionHeader(doc, 'PRIOR INSURANCE');
  const prior = dataPacket.prior_insurance;
  fieldRow(doc, 'Current Carrier', prior.carrier);
  fieldRow(doc, 'Policy Number', prior.policy_number);
  fieldRow(doc, 'Premium', prior.premium ? `$${prior.premium.toLocaleString()}` : null);
  fieldRow(doc, 'Expiration', prior.expiration);
  fieldRow(doc, 'Prior Lapse', prior.lapse === null ? null : prior.lapse ? 'Yes' : 'No');
  doc.moveDown(0.5);

  // ── Owners
  if (dataPacket.owners.length > 0) {
    sectionHeader(doc, 'OWNERS');
    for (const owner of dataPacket.owners) {
      fieldRow(doc, 'Name', owner.name);
      fieldRow(doc, 'DOB', owner.dob);
      fieldRow(doc, 'License', owner.license_number ? `${owner.license_number} (${owner.license_state ?? ''})` : null);
      doc.moveDown(0.3);
    }
  }

  // ── Drivers
  const driversToInclude = maxDrivers ? dataPacket.drivers.slice(0, maxDrivers) : dataPacket.drivers;
  if (driversToInclude.length > 0) {
    doc.addPage();
    sectionHeader(doc, `DRIVERS (${driversToInclude.length} of ${dataPacket.drivers.length})`);
    for (const driver of driversToInclude) {
      const name = [driver.first_name, driver.last_name].filter(Boolean).join(' ');
      fieldRow(doc, `Driver ${driver.position}`, name || null);
      fieldRow(doc, '  DOB', driver.dob);
      fieldRow(doc, '  License', driver.license_number ? `${driver.license_number} (${driver.license_state ?? ''})` : null);
      fieldRow(doc, '  Years Licensed', driver.years_licensed?.toString() ?? null);
      fieldRow(doc, '  SR-22', driver.sr22_required ? 'Yes' : 'No');
      doc.moveDown(0.3);
    }
  }

  // ── Vehicles
  const vehiclesToInclude = maxVehicles ? dataPacket.vehicles.slice(0, maxVehicles) : dataPacket.vehicles;
  if (vehiclesToInclude.length > 0) {
    doc.addPage();
    sectionHeader(doc, `VEHICLES / POWER UNITS (${vehiclesToInclude.length} of ${dataPacket.vehicles.length})`);
    for (const vehicle of vehiclesToInclude) {
      const desc = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ');
      fieldRow(doc, `Unit ${vehicle.position}`, desc || null);
      fieldRow(doc, '  VIN', vehicle.vin);
      fieldRow(doc, '  Type', vehicle.type);
      fieldRow(doc, '  Value', vehicle.value ? `$${vehicle.value.toLocaleString()}` : null);
      fieldRow(doc, '  GVW', vehicle.gvw?.toString() ?? null);
      doc.moveDown(0.3);
    }
  }

  // ── Supplemental Answers
  const answeredQuestions = Object.entries(supplementalAnswers).filter(([, v]) => v != null && v !== '');
  if (answeredQuestions.length > 0) {
    doc.addPage();
    sectionHeader(doc, 'SUPPLEMENTAL INFORMATION');
    for (const [question, answer] of answeredQuestions) {
      fieldRow(doc, question, answer);
    }
  }

  doc.end();

  // Collect the buffer
  const buffer = Buffer.concat(chunks);
  return { buffer, warnings };
}

// ── Helper functions ─────────────────────────────────────────────────────────

function sectionHeader(doc: PDFKit.PDFDocument, title: string) {
  doc.fontSize(11).font('Helvetica-Bold').text(title);
  doc.moveTo(doc.x, doc.y).lineTo(doc.x + 500, doc.y).strokeColor('#555').stroke();
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9);
}

function fieldRow(doc: PDFKit.PDFDocument, label: string, value: string | null | undefined) {
  const display = value?.trim() || '—';
  doc.text(`${label}: ${display}`);
}

function formatAddress(
  street: string | null,
  unit: string | null,
  city: string | null,
  state: string | null,
  zip: string | null,
): string | null {
  const parts = [street, unit, city, state, zip].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

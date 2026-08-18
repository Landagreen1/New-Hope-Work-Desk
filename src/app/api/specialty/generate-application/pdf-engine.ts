/**
 * PDF Generation Engine
 *
 * Uses pdfkit to generate filled PDF applications that replicate the official
 * carrier application layouts (JSA Truck Application, TIA Quick Quote Form).
 *
 * The generated PDFs mirror the exact section structure, field labels, and
 * table formats from the official forms so agents can review and submit them
 * to carriers without re-entry.
 *
 * v1.17.0 — Updated with actual form field layouts from official PDFs.
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
 * Routes to the appropriate template-specific generator.
 */
export async function generatePdfFromTemplate(input: PdfGenerationInput): Promise<PdfGenerationResult> {
  const { template } = input;
  const name = template.template_name.toLowerCase();

  if (name.includes('tia') || name.includes('quick quote')) {
    return generateTiaQuickQuote(input);
  }
  if (name.includes('jsa') || name.includes('truck application')) {
    return generateJsaTruckApplication(input);
  }

  // Fallback: generic structured output
  return generateGenericApplication(input);
}

/** Collects a PDFDocument stream into a Buffer. */
function finalizePdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIA QUICK QUOTE FORM
//
// Mirrors the official Truckers Insurance Associates Quick Quote Form:
// - Insured Information / Producer Information
// - Operation Information
// - Driver Information (table)
// - Vehicle Schedule (table, 6 rows)
// - Insurance Carrier Information (3 years)
// - Coverages & Limits
// ═══════════════════════════════════════════════════════════════════════════════

async function generateTiaQuickQuote(input: PdfGenerationInput): Promise<PdfGenerationResult> {
  const { dataPacket, supplementalAnswers, maxDrivers = 5, maxVehicles = 6 } = input;
  const warnings: string[] = [];
  const biz = dataPacket.business;
  const ops = dataPacket.operations;
  const cov = dataPacket.coverages;
  const prior = dataPacket.prior_insurance;

  if (dataPacket.drivers.length > maxDrivers) {
    warnings.push(
      `TIA Quick Quote supports ${maxDrivers} driver rows but ${dataPacket.drivers.length} exist. ` +
      `Only the first ${maxDrivers} will be included. Attach a continuation schedule.`,
    );
  }
  if (dataPacket.vehicles.length > maxVehicles) {
    warnings.push(
      `TIA Quick Quote supports ${maxVehicles} vehicle rows but ${dataPacket.vehicles.length} exist. ` +
      `Only the first ${maxVehicles} will be included. Attach a continuation schedule.`,
    );
  }

  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });

  // ── Title
  doc.fontSize(18).font('Helvetica-Bold')
    .text('QUICK QUOTE FORM', { align: 'right' });
  doc.moveDown(0.3);
  doc.fontSize(8).font('Helvetica')
    .text('Truckers Insurance Associates', { align: 'right' });
  doc.moveDown(0.5);

  // ── Effective Dates
  fieldLine(doc, 'Effective Dates', supplementalAnswers['Target effective date'] ?? '');
  doc.moveDown(0.5);

  // ── Insured Information / Producer Information
  sectionBar(doc, 'INSURED INFORMATION', 'PRODUCER INFORMATION');
  fieldLine(doc, 'Name', biz.legal_name);
  fieldLine(doc, 'DBA', biz.dba);
  fieldLine(doc, 'Garaging Address', formatAddr(biz.garaging_street, biz.garaging_city, biz.garaging_state, biz.garaging_zip) || formatAddr(biz.mailing_street, biz.mailing_city, biz.mailing_state, biz.mailing_zip));
  fieldLine(doc, 'Mailing Address', formatAddr(biz.mailing_street, biz.mailing_city, biz.mailing_state, biz.mailing_zip));
  doc.moveDown(0.3);
  fieldLine(doc, 'Agency', 'New Hope Insurance');
  fieldLine(doc, 'Producer', '');
  fieldLine(doc, 'Phone', biz.phone);
  fieldLine(doc, 'Email', biz.email);
  doc.moveDown(0.5);

  // ── Operation Information
  sectionBar(doc, 'OPERATION INFORMATION');
  fieldLine(doc, 'Destination Cities (Zone rated - 10% or more)', supplementalAnswers['Primary Destinations'] ?? ops.states);
  fieldLine(doc, 'Cities Traveled Through (Zone rated - 10% or more)', ops.states);
  twoCol(doc,
    'Percentage of Loads Through Brokers', supplementalAnswers['Percentage of Loads Brokered'] ?? ops.brokerage_percentage?.toString() ?? '',
    'Percentage of Loads to Regular Destinations', '',
  );
  twoCol(doc,
    '# of Power Units Current Year', dataPacket.vehicles.length.toString(),
    'Gross Revenue Past Year', supplementalAnswers['Annual Revenue'] ?? '',
  );
  twoCol(doc,
    'Past Year Mileage', supplementalAnswers['Annual Mileage'] ?? ops.mileage?.toString() ?? '',
    'DOT #', biz.dot_number ?? '',
  );
  twoCol(doc,
    'FEIN', biz.fein ?? '',
    'MC #', biz.mc_number ?? '',
  );
  fieldLine(doc, 'Years Insured Under this Name', biz.years_in_business?.toString());
  doc.moveDown(0.5);

  // ── Driver Information
  sectionBar(doc, 'DRIVER INFORMATION');
  // Table header
  doc.fontSize(7).font('Helvetica-Bold');
  doc.text('Name                    License           State    DOB         Hire Date    Yrs. Exp.');
  doc.font('Helvetica').fontSize(8);
  const driversToShow = dataPacket.drivers.slice(0, maxDrivers);
  for (const driver of driversToShow) {
    const name = [driver.first_name, driver.last_name].filter(Boolean).join(' ');
    doc.text(
      `${pad(name, 24)}${pad(driver.license_number ?? '', 18)}${pad(driver.license_state ?? '', 8)}${pad(driver.dob ?? '', 12)}${pad('', 12)}${driver.years_licensed ?? ''}`,
    );
  }
  doc.moveDown(0.5);

  // ── Vehicle Schedule
  sectionBar(doc, 'VEHICLE SCHEDULE (Attach schedule if desired)');
  doc.fontSize(7).font('Helvetica-Bold');
  doc.text('#    Year    Make         VIN                  TRK/TRAC    TRL Type    Value       GVW      Radius');
  doc.font('Helvetica').fontSize(8);
  const vehiclesToShow = dataPacket.vehicles.slice(0, maxVehicles);
  for (let i = 0; i < vehiclesToShow.length; i++) {
    const v = vehiclesToShow[i];
    doc.text(
      `${pad((i + 1).toString(), 5)}${pad(v.year?.toString() ?? '', 8)}${pad(v.make ?? '', 13)}${pad(v.vin ?? '', 21)}${pad(v.type ?? '', 12)}${pad('', 12)}${pad(v.value ? `$${v.value}` : '', 12)}${pad(v.gvw?.toString() ?? '', 9)}${v.radius ?? ops.radius ?? ''}`,
    );
  }
  doc.moveDown(0.5);

  // ── Insurance Carrier Information (past 3 years)
  sectionBar(doc, 'INSURANCE CARRIER INFORMATION (past three years)');
  doc.fontSize(8);
  fieldLine(doc, 'Current Carrier', prior.carrier);
  fieldLine(doc, 'Policy Number', prior.policy_number);
  fieldLine(doc, 'Premium', prior.premium ? `$${prior.premium.toLocaleString()}` : null);
  fieldLine(doc, 'Expiration', prior.expiration);
  doc.moveDown(0.5);

  // ── Coverages & Limits
  sectionBar(doc, 'COVERAGES & LIMITS');
  twoCol(doc, 'Auto Liability Limit', cov.auto_liability_limit ?? '', 'Cargo Limit', cov.cargo_limit ?? '');
  twoCol(doc, 'Comp. Deductible', cov.comprehensive_deductible ?? '', 'Coll. Deductible', cov.collision_deductible ?? '');
  fieldLine(doc, 'Physical Damage', cov.physical_damage === null ? '' : cov.physical_damage ? 'Yes' : 'No');
  fieldLine(doc, 'General Liability', cov.general_liability === null ? '' : cov.general_liability ? 'Yes' : 'No');
  fieldLine(doc, 'Trailer Interchange', cov.trailer_interchange === null ? '' : cov.trailer_interchange ? 'Yes' : 'No');
  doc.moveDown(0.5);

  // ── Supplemental answers not already used
  const usedKeys = new Set(['Target effective date', 'Primary Destinations', 'Percentage of Loads Brokered', 'Annual Revenue', 'Annual Mileage']);
  const remaining = Object.entries(supplementalAnswers).filter(([k, v]) => v && !usedKeys.has(k));
  if (remaining.length > 0) {
    sectionBar(doc, 'ADDITIONAL INFORMATION');
    for (const [q, a] of remaining) {
      fieldLine(doc, q, a);
    }
  }

  // ── Footer
  doc.moveDown(1);
  doc.fontSize(7).font('Helvetica')
    .text('Completed forms can be submitted via email to newsubmissions@truckers-insurance.com or online at www.truckers-insurance.com/quote.', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(7).text(`Generated by New Hope Work Desk — ${new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })}`, { align: 'center' });

  const buffer = await finalizePdf(doc);
  return { buffer, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSA TRUCK APPLICATION
//
// Mirrors the official Jackson Sumner & Associates Truck Application:
// Page 1: General Information Section (applicant, owner, entity, DOT/MC,
//         underwriting questions 1-12, radius of operations, agent info)
// Page 2: Coverages and Limits, Power Unit Information (table),
//         Trailer Information (table), Driver Information (table),
//         Commodity Information (table)
// Page 3: Prior Carrier Information (3 years), Additional Remarks,
//         Fraud Warning, Signatures
// ═══════════════════════════════════════════════════════════════════════════════

async function generateJsaTruckApplication(input: PdfGenerationInput): Promise<PdfGenerationResult> {
  const { dataPacket, supplementalAnswers, maxDrivers = 10, maxVehicles = 15 } = input;
  const warnings: string[] = [];
  const biz = dataPacket.business;
  const ops = dataPacket.operations;
  const cov = dataPacket.coverages;
  const prior = dataPacket.prior_insurance;

  if (dataPacket.drivers.length > maxDrivers) {
    warnings.push(
      `JSA application supports ${maxDrivers} driver rows but ${dataPacket.drivers.length} exist. ` +
      `Only the first ${maxDrivers} will be included. Attach a continuation schedule.`,
    );
  }
  if (dataPacket.vehicles.length > maxVehicles) {
    warnings.push(
      `JSA application supports ${maxVehicles} vehicle rows but ${dataPacket.vehicles.length} exist. ` +
      `Only the first ${maxVehicles} will be included. Attach a continuation schedule.`,
    );
  }

  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });

  // ══════════════════════════════════════════════════════════════════════════
  // PAGE 1 — General Information Section
  // ══════════════════════════════════════════════════════════════════════════

  // Agent box (top-right)
  doc.fontSize(9).font('Helvetica');
  doc.text('Agent Name: Jason Toro', 350, 40);
  doc.text('Agent Email: jtoro@newhopeins.com', 350, 52);
  doc.text('Agency Name: New Hope Insurance', 350, 64);
  doc.text('Agent #:', 350, 76);

  // Title
  doc.fontSize(8).font('Helvetica').text('Jackson Sumner & Associates', 40, 40);
  doc.text('Excess & Surplus Lines Broker', 40, 50);
  doc.text('www.jsausa.com', 40, 60);

  doc.y = 95;
  doc.fontSize(16).font('Helvetica-Bold').text('Truck Application', { align: 'center' });
  doc.moveDown(0.8);

  // General Information Section
  doc.fontSize(11).font('Helvetica-Bold').text('General Information Section');
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica');
  fieldLine(doc, 'Applicant Name', biz.legal_name);
  twoCol(doc,
    'Mailing Address', formatAddr(biz.mailing_street, biz.mailing_city, biz.mailing_state, biz.mailing_zip) ?? '',
    'Location Address', formatAddr(biz.garaging_street, biz.garaging_city, biz.garaging_state, biz.garaging_zip) ?? '',
  );
  doc.moveDown(0.3);

  // Owner
  const ownerName = dataPacket.owners.length > 0 ? dataPacket.owners[0].name : null;
  const ownerDob = dataPacket.owners.length > 0 ? dataPacket.owners[0].dob : null;
  fieldLine(doc, "Owner's Name", `${ownerName ?? ''}     DOB: ${ownerDob ?? ''}     CDL: Yes`);
  fieldLine(doc, 'Applicant is', biz.entity_type ?? 'LLC');
  twoCol(doc, 'DOT #', biz.dot_number ?? '', 'MC #', biz.mc_number ?? '');
  const yrsInsured = biz.years_in_business?.toString() ?? '';
  const yrsExp = biz.years_experience?.toString() ?? yrsInsured;
  doc.text(`Years Insured Under This Name: ${yrsInsured}     Years Experience: ${yrsExp}     Renewal Date: ${supplementalAnswers['Desired effective date'] ?? ''}`);
  fieldLine(doc, 'Description of Risk/Operations', ops.commodities);
  doc.moveDown(0.3);
  fieldLine(doc, 'Narrative (Target premium/How JSA can help)', supplementalAnswers['Target Premium'] ?? '');
  doc.moveDown(0.5);

  // Underwriting Questions 1-12
  doc.font('Helvetica').fontSize(8);
  const q = (num: number, text: string, answer: string) => {
    doc.text(`${num}. ${text}  ${answer}`);
  };
  const cancelAnswer = supplementalAnswers['Has the applicant been cancelled or non-renewed in the last three years?'] ?? 'No';
  q(1, 'Has the applicant been cancelled or non-renewed in the last three years?', cancelAnswer);
  q(2, 'Any lapse in coverage in the past three years?', prior.lapse ? 'Yes' : 'No');
  q(3, 'Any indictments or convictions of fraud, bribery or arson in the last five years?', 'No');
  q(4, 'Any bankruptcies, tax or credit liens against the applicant in the past five years?', 'No');
  q(5, 'Any auto liability losses over $250,000 in the past 5 years?', 'No');
  q(6, 'Does the applicant transport hazardous materials?', supplementalAnswers['Hazmat hauling?'] ?? 'No');
  q(7, 'Does the applicant cross state lines?', ops.interstate === null ? 'Yes' : ops.interstate ? 'Yes' : 'No');
  q(8, 'Does the applicant haul for hire?', ops.for_hire === null ? 'Yes' : ops.for_hire ? 'Yes' : 'No');
  q(9, 'Are all vehicles listed on this application?', 'Yes');
  q(10, 'Does the applicant use owner/operators?', supplementalAnswers['Any Owner Operators?'] ?? 'No');
  q(11, 'Does the insured rent any units on a short term basis?', 'No');
  q(12, 'Does the applicant use team drivers or slip seating?', 'No');
  doc.moveDown(0.3);

  // Radius of Operations
  fieldLine(doc, 'Radius of Operations', ops.states ?? `${ops.radius ?? ''} miles`);
  doc.moveDown(0.3);

  // ══════════════════════════════════════════════════════════════════════════
  // PAGE 2 — Coverages, Units, Drivers, Commodities
  // ══════════════════════════════════════════════════════════════════════════
  doc.addPage();
  doc.fontSize(8).font('Helvetica')
    .text('North Carolina · South Carolina · Virginia · Georgia · Tennessee · Maryland', { align: 'center' });
  doc.text('PO Box 2540 Boone, NC 28607 | 800-342-5572 | jsausa.com', { align: 'center' });
  doc.moveDown(0.5);

  // Coverages and Limits
  doc.fontSize(11).font('Helvetica-Bold').text('Coverages and Limits');
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica');
  twoCol(doc, 'Auto Liability Limits', cov.auto_liability_limit ?? '', 'UM/UIM Limits', '');
  fieldLine(doc, 'Physical Damage Deductible', `Comp: ${cov.comprehensive_deductible ?? ''}  Coll: ${cov.collision_deductible ?? ''}`);
  twoCol(doc, 'Cargo Limits', cov.cargo_limit ?? '', 'Cargo Deductible', '');
  twoCol(doc, 'Trailer Interchange Limits', cov.trailer_interchange ? 'Requested' : '', 'General Liability Limits', cov.general_liability ? 'Requested' : '');
  doc.moveDown(0.5);

  // Power Unit Information
  doc.fontSize(10).font('Helvetica-Bold').text('Power Unit Information');
  doc.moveDown(0.2);
  doc.fontSize(7).font('Helvetica-Bold');
  doc.text('Year    Make         Body Type              VIN                      Value       Owned/Leased');
  doc.font('Helvetica').fontSize(8);
  const vehToShow = dataPacket.vehicles.slice(0, maxVehicles);
  for (const v of vehToShow) {
    doc.text(
      `${pad(v.year?.toString() ?? '', 8)}${pad(v.make ?? '', 13)}${pad(v.type ?? '', 23)}${pad(v.vin ?? '', 25)}${pad(v.value ? `$${v.value}` : '', 12)}Owned`,
    );
  }
  doc.moveDown(0.5);

  // Driver Information
  doc.fontSize(10).font('Helvetica-Bold').text('Driver Information');
  doc.moveDown(0.2);
  doc.fontSize(7).font('Helvetica-Bold');
  doc.text('Driver Name              DOB         State  License #            # Yrs CDL   Owner/Op');
  doc.font('Helvetica').fontSize(8);
  const drvToShow = dataPacket.drivers.slice(0, maxDrivers);
  for (const d of drvToShow) {
    const name = [d.first_name, d.last_name].filter(Boolean).join(' ');
    doc.text(
      `${pad(name, 25)}${pad(d.dob ?? '', 12)}${pad(d.license_state ?? '', 7)}${pad(d.license_number ?? '', 21)}${pad(d.years_licensed?.toString() ?? '', 10)}No`,
    );
  }
  doc.moveDown(0.5);

  // Commodity Information
  doc.fontSize(10).font('Helvetica-Bold').text('Commodity Information');
  doc.moveDown(0.2);
  doc.fontSize(7).font('Helvetica-Bold');
  doc.text('Commodities                              Percent Hauled    Average Value    Maximum Value');
  doc.font('Helvetica').fontSize(8);
  if (ops.commodities) {
    doc.text(`${pad(ops.commodities, 41)}100%`);
  }
  doc.moveDown(0.5);

  // ══════════════════════════════════════════════════════════════════════════
  // PAGE 3 — Prior Carrier, Additional Remarks, Signatures
  // ══════════════════════════════════════════════════════════════════════════
  doc.addPage();
  doc.fontSize(8).font('Helvetica')
    .text('North Carolina · South Carolina · Virginia · Georgia · Tennessee · Maryland', { align: 'center' });
  doc.text('PO Box 2540 Boone, NC 28607 | 800-342-5572 | jsausa.com', { align: 'center' });
  doc.moveDown(0.5);

  // Prior Carrier Information
  doc.fontSize(10).font('Helvetica-Bold').text('Prior Carrier Information (prior 3 years)');
  doc.moveDown(0.2);
  doc.fontSize(7).font('Helvetica-Bold');
  doc.text('Policy Period     12mo term?    Insurance Company       Line of Business    Policy #         # Units    # Claims    Losses');
  doc.font('Helvetica').fontSize(8);
  if (prior.carrier) {
    doc.text(`${pad(prior.expiration ?? '', 18)}Yes           ${pad(prior.carrier, 24)}AL, PD              ${pad(prior.policy_number ?? '', 17)}${dataPacket.vehicles.length}`);
  }
  doc.moveDown(0.8);

  // Additional Remarks
  doc.fontSize(10).font('Helvetica-Bold').text('Additional Remarks:');
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica');
  // Include any supplemental answers not already used
  const jsaUsedKeys = new Set(['Target Premium', 'Desired effective date', 'Any Owner Operators?', 'Hazmat hauling?', 'Has the applicant been cancelled or non-renewed in the last three years?']);
  const jsaRemaining = Object.entries(supplementalAnswers).filter(([k, v]) => v && !jsaUsedKeys.has(k));
  for (const [qText, a] of jsaRemaining) {
    doc.text(`${qText}: ${a}`);
  }
  doc.moveDown(1);

  // Fraud Warning
  doc.fontSize(8).font('Helvetica-Bold').text('Fraud Warning:');
  doc.font('Helvetica').fontSize(7);
  doc.text('Any person who knowingly and with intent to defraud any insurance company or other person files an application for insurance or statement of claim containing any materially false information or conceals for the purpose of misleading, information concerning any fact material thereto commits a fraudulent insurance act, which is a crime and subjects such person to criminal and civil penalties.');
  doc.moveDown(0.5);

  // Signatures
  doc.fontSize(9).font('Helvetica');
  doc.text("Applicant's Name & Title (Please Print): ___________________________________");
  doc.moveDown(0.5);
  doc.text(`Applicant's Signature: ___________________________________     Date: ${new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })}`);
  doc.moveDown(0.5);
  doc.text("Agent's Signature: ___________________________________     Date: ___________");
  doc.moveDown(0.5);
  doc.text('Agency Address: New Hope Insurance');
  doc.text("Agent's Phone #: _______________     Agent's Fax #: _______________");

  // Footer
  doc.moveDown(1);
  doc.fontSize(7).text(`Generated by New Hope Work Desk — ${new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })}`, { align: 'center' });

  const buffer = await finalizePdf(doc);
  return { buffer, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC APPLICATION (fallback)
// ═══════════════════════════════════════════════════════════════════════════════

async function generateGenericApplication(input: PdfGenerationInput): Promise<PdfGenerationResult> {
  const { template, dataPacket, supplementalAnswers, maxDrivers, maxVehicles } = input;
  const warnings: string[] = [];
  const biz = dataPacket.business;
  const ops = dataPacket.operations;
  const cov = dataPacket.coverages;
  const prior = dataPacket.prior_insurance;

  if (maxDrivers && dataPacket.drivers.length > maxDrivers) {
    warnings.push(`Supports ${maxDrivers} drivers but ${dataPacket.drivers.length} exist. Attach a continuation schedule.`);
  }
  if (maxVehicles && dataPacket.vehicles.length > maxVehicles) {
    warnings.push(`Supports ${maxVehicles} vehicles but ${dataPacket.vehicles.length} exist. Attach a continuation schedule.`);
  }

  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });

  doc.fontSize(16).font('Helvetica-Bold').text(template.template_name, { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(9).font('Helvetica').text(`Generated: ${new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })} | Source: New Hope Work Desk`, { align: 'center' });
  doc.moveDown(1);

  // Business
  sectionBar(doc, 'APPLICANT INFORMATION');
  fieldLine(doc, 'Legal Name', biz.legal_name);
  fieldLine(doc, 'DBA', biz.dba);
  fieldLine(doc, 'DOT #', biz.dot_number);
  fieldLine(doc, 'MC #', biz.mc_number);
  fieldLine(doc, 'FEIN', biz.fein);
  fieldLine(doc, 'Phone', biz.phone);
  fieldLine(doc, 'Email', biz.email);
  fieldLine(doc, 'Address', formatAddr(biz.mailing_street, biz.mailing_city, biz.mailing_state, biz.mailing_zip));
  doc.moveDown(0.5);

  // Operations
  sectionBar(doc, 'OPERATIONS');
  fieldLine(doc, 'Commodities', ops.commodities);
  fieldLine(doc, 'Radius', ops.radius?.toString());
  fieldLine(doc, 'States', ops.states);
  doc.moveDown(0.5);

  // Coverages
  sectionBar(doc, 'COVERAGES');
  fieldLine(doc, 'Auto Liability', cov.auto_liability_limit);
  fieldLine(doc, 'Cargo', cov.cargo_limit);
  fieldLine(doc, 'Comp Ded', cov.comprehensive_deductible);
  fieldLine(doc, 'Coll Ded', cov.collision_deductible);
  doc.moveDown(0.5);

  // Prior
  sectionBar(doc, 'PRIOR INSURANCE');
  fieldLine(doc, 'Carrier', prior.carrier);
  fieldLine(doc, 'Premium', prior.premium ? `$${prior.premium}` : null);
  fieldLine(doc, 'Expiration', prior.expiration);
  doc.moveDown(0.5);

  // Drivers
  if (dataPacket.drivers.length > 0) {
    sectionBar(doc, 'DRIVERS');
    const drvs = maxDrivers ? dataPacket.drivers.slice(0, maxDrivers) : dataPacket.drivers;
    for (const d of drvs) {
      const name = [d.first_name, d.last_name].filter(Boolean).join(' ');
      doc.text(`${name} | DOB: ${d.dob ?? ''} | Lic: ${d.license_number ?? ''} (${d.license_state ?? ''}) | Yrs: ${d.years_licensed ?? ''}`);
    }
    doc.moveDown(0.5);
  }

  // Vehicles
  if (dataPacket.vehicles.length > 0) {
    sectionBar(doc, 'VEHICLES');
    const vehs = maxVehicles ? dataPacket.vehicles.slice(0, maxVehicles) : dataPacket.vehicles;
    for (const v of vehs) {
      doc.text(`${v.year ?? ''} ${v.make ?? ''} ${v.model ?? ''} | VIN: ${v.vin ?? ''} | Value: ${v.value ? `$${v.value}` : ''}`);
    }
    doc.moveDown(0.5);
  }

  // Supplemental
  const answered = Object.entries(supplementalAnswers).filter(([, v]) => v);
  if (answered.length > 0) {
    sectionBar(doc, 'SUPPLEMENTAL INFORMATION');
    for (const [q2, a] of answered) {
      fieldLine(doc, q2, a);
    }
  }

  const buffer = await finalizePdf(doc);
  return { buffer, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function sectionBar(doc: PDFKit.PDFDocument, title: string, rightTitle?: string) {
  doc.fontSize(9).font('Helvetica-Bold');
  if (rightTitle) {
    doc.text(`${title}                                    ${rightTitle}`);
  } else {
    doc.text(title);
  }
  doc.moveTo(doc.x, doc.y).lineTo(doc.x + 520, doc.y).strokeColor('#333').lineWidth(0.5).stroke();
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(9);
}

function fieldLine(doc: PDFKit.PDFDocument, label: string, value: string | null | undefined) {
  doc.text(`${label}: ${value?.trim() || '_______________'}`);
}

function twoCol(doc: PDFKit.PDFDocument, l1: string, v1: string, l2: string, v2: string) {
  doc.text(`${l1}: ${v1 || '________'}          ${l2}: ${v2 || '________'}`);
}

function formatAddr(street: string | null, city: string | null, state: string | null, zip: string | null): string | null {
  const parts = [street, city, state, zip].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function pad(str: string, len: number): string {
  return str.padEnd(len).substring(0, len);
}

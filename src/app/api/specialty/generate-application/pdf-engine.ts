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

  // Keep form fields editable so agents can modify after download
  // (Do NOT flatten — the filled PDF should remain an interactive form)

  const filledBytes = await pdfDoc.save();
  return { buffer: Buffer.from(filledBytes), warnings };
}

/**
 * Fills AcroForm fields by matching field names to our data.
 * Detects JSA vs TIA form by checking for template-specific field names.
 */
function fillFormFields(
  form: ReturnType<typeof PDFDocument.prototype.getForm>,
  dataPacket: TruckingDataPacket,
  supplementalAnswers: Record<string, string | null>,
  template: PdfGenerationInput['template'],
  warnings: string[],
) {
  const fields = form.getFields();
  const fieldNames = new Set(fields.map(f => f.getName()));

  // Detect TIA form by checking for TIA-specific fields
  if (fieldNames.has('Agency') && fieldNames.has('Producer') && fieldNames.has('Garaging Address')) {
    fillTiaForm(form, dataPacket, supplementalAnswers, template, warnings);
  } else {
    fillJsaForm(form, dataPacket, supplementalAnswers, template, warnings);
  }
}

function fillJsaForm(
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
  const uw = dataPacket.underwriting;
  const owner = dataPacket.owners[0];
  const primaryDriver = dataPacket.drivers[0];

  /** A market-specific answer always wins over the intake, when one was given. */
  const sup = (key: string): string | null => supplementalAnswers[key]?.trim() || null;

  // ── Page 1: General Information ──────────────────────────────────────────
  trySet(form, 'Agent Name', 'Jason Toro');
  trySet(form, 'Agent Email', 'jtoro@newhopeins.com');
  trySet(form, 'Agency Name', 'New Hope Insurance');
  trySet(form, 'Agent', '');

  trySet(form, 'Applicant Name 1', biz.legal_name ?? '');
  trySet(form, 'Applicant Name 2', biz.dba ?? '');
  trySet(form, 'Mailing Address', [biz.mailing_street, biz.mailing_city, biz.mailing_state, biz.mailing_zip].filter(Boolean).join(', '));
  trySet(form, 'Location Address 1', [biz.garaging_street ?? biz.mailing_street, biz.garaging_city ?? biz.mailing_city].filter(Boolean).join(', '));
  trySet(form, 'Location Address 2', [biz.garaging_state ?? biz.mailing_state, biz.garaging_zip ?? biz.mailing_zip].filter(Boolean).join(' '));

  // Owner block. The named insured is the owner on almost every trucking risk,
  // so the adapter falls back to them and borrows their licence off driver 1.
  trySet(form, 'Owners Name', owner?.name ?? '');
  trySet(form, 'DOB 1', owner?.dob ?? '');
  trySet(form, 'DOB 2', dataPacket.owners[1]?.dob ?? '');

  // Does the owner hold a CDL? Answered from the driver record rather than
  // assumed — but still defaults to Yes when the intake never asked, since a
  // trucking applicant almost always holds one.
  selectRadio(form, 'CDL', primaryDriver?.cdl ?? true);

  // Entity type checkboxes
  const entity = (biz.entity_type ?? '').toLowerCase();
  tryCheck(form, 'Individual', entity.includes('individual') || entity.includes('sole'));
  tryCheck(form, 'Partnership', entity.includes('partnership'));
  tryCheck(form, 'Corporation', entity.includes('corp'));
  tryCheck(form, 'Joint Venture', entity.includes('joint'));
  tryCheck(form, 'LLC', entity.includes('llc'));
  tryCheck(form, 'Nonprofit', entity.includes('nonprofit') || entity.includes('non-profit'));

  trySet(form, 'DOT', biz.dot_number ?? '');
  trySet(form, 'MC', biz.mc_number ?? '');
  trySet(form, 'Years Insured Under This Name', biz.years_in_business?.toString() ?? '');
  // Years of experience: the most experienced driver is the best proxy the
  // intake has, falling back to how long the business has operated.
  const topExperience = dataPacket.drivers.reduce<number | null>(
    (best, driver) => (driver.experience !== null && (best === null || driver.experience > best) ? driver.experience : best),
    null,
  );
  trySet(form, 'Years Experience', biz.years_experience?.toString() ?? topExperience?.toString() ?? biz.years_in_business?.toString() ?? '');
  trySet(form, 'Renewal Date', sup('Desired effective date') ?? ops.desired_effective_date ?? '');

  // Description of operations: what they do, then what they haul.
  trySet(form, 'Description of RiskOperations 1', ops.operation_types ?? ops.commodities ?? '');
  trySet(form, 'Description of RiskOperations 2', ops.operation_description ?? ops.commodities ?? '');

  const narrativeLines = [
    sup('Target Premium') ? `Target Premium: ${sup('Target Premium')}` : '',
    cov.additional_coverages_other ? `Also requested: ${cov.additional_coverages_other}` : '',
    ops.pulls_non_owned_trailers === true
      ? `Pulls non-owned trailers${cov.trailer_interchange_agreement === true ? ' under a written interchange agreement.' : '.'}`
      : '',
  ].filter(Boolean);
  fillLines(form, [
    'Narrative Target premiumHow JSA can help you write the account 1',
    'Narrative Target premiumHow JSA can help you write the account 2',
    'Narrative Target premiumHow JSA can help you write the account 3',
  ], narrativeLines);
  // The Generic variant of this form names the same box differently.
  fillLines(form, [
    'Narrative Underwriting Notes 1',
    'Narrative Underwriting Notes 2',
    'Narrative Underwriting Notes 3',
  ], narrativeLines);

  // ── Underwriting questions (Q1-Q12 radio groups) ─────────────────────────
  // Group names run undefined_2q … undefined_2aas in question order. Answers
  // come from the intake where it asks the question, and fall back to the
  // house defaults Byron specified: Q1-6 No, Q7-9 Yes, Q10-12 No.
  const supBool = (key: string): boolean | null => {
    const raw = sup(key);
    if (!raw) return null;
    return raw.toLowerCase().includes('yes');
  };

  const questionAnswers: (boolean | null)[] = [
    // Q1 cancelled or non-renewed in the last three years
    supBool('Has the applicant been cancelled or non-renewed in the last three years?') ?? uw.cancelled_nonrenewed ?? false,
    // Q2 lapse in coverage in the past three years
    supBool('Any lapse in coverage in the past three years?') ?? uw.coverage_lapse ?? false,
    false, // Q3 fraud — not asked on the intake
    false, // Q4 bankruptcies — not asked on the intake
    // Q5 losses over $250,000
    uw.major_al_loss ?? false,
    // Q6 hazardous materials
    supBool('Hazmat hauling?') ?? supBool('Transport hazardous materials?')
      ?? (uw.hazmat ? uw.hazmat === 'yes' : null) ?? false,
    // Q7 crosses state lines
    ops.interstate ?? true,
    // Q8 hauls for hire
    ops.for_hire ?? true,
    true,  // Q9 all vehicles listed — true by construction, we schedule them all
    // Q10 owner/operators
    supBool('Any Owner Operators?') ?? uw.owner_operators ?? false,
    false, // Q11 rents units — not asked on the intake
    false, // Q12 team drivers — not asked on the intake
  ];

  const radioNames = ['undefined_2q', 'undefined_2w', 'undefined_2e', 'undefined_2r', 'undefined_2t',
    'undefined_2y', 'undefined_2u', 'undefined_2d', 'undefined_2f', 'undefined_2s', 'undefined_2a', 'undefined_2aas'];
  for (let i = 0; i < radioNames.length && i < questionAnswers.length; i++) {
    selectRadio(form, radioNames[i], questionAnswers[i]);
  }

  // Every Yes needs a reason, or the underwriter sends it straight back.
  fillLines(form, [
    'Explain all yes answers for questions 15 1',
    'Explain all yes answers for questions 15 2',
    'Explain all yes answers for questions 15 3',
    'Explain all yes answers for questions 15 4',
  ], underwritingExplanations(dataPacket));

  // Radius of Operations
  trySet(form, 'IFTAs if available 1', ops.states ?? '');
  trySet(form, 'IFTAs if available 2', [
    ops.radius_band ?? (ops.radius ? `${ops.radius} miles` : ''),
    ops.farthest_states_cities ?? '',
  ].filter(Boolean).join(' — '));

  // ── Page 2: Coverages and Limits ─────────────────────────────────────────
  // "Limits" here is the AUTO LIABILITY limit. The General Liability box is
  // "Limits_2" further down. These are two different coverages and were being
  // conflated before.
  tryCheck(form, 'Auto Liability', !!cov.auto_liability_limit);
  trySet(form, 'Limits', cov.auto_liability_limit ?? '');
  trySet(form, 'UMUIM Limits', sup('UM/UIM Limit') ?? cov.um_uim_limit ?? '');

  // Hired and non-owned auto are their own yes/no radios on this form.
  const triState = (value: string | null): boolean | null => {
    if (!value) return null;
    if (value === 'yes') return true;
    if (value === 'no') return false;
    return null; // "not_sure" — leave blank rather than guess for the carrier
  };
  selectRadio(form, 'Hired Auto', triState(cov.hired_auto));
  selectRadio(form, 'Hired Auto2', triState(cov.non_owned_auto));

  // Physical Damage. Driven by the explicit intake answer; older intakes that
  // never answered it fall back to whether any truck carries a stated value.
  const hasPhysicalDamage = cov.physical_damage_requested
    ?? cov.physical_damage
    ?? dataPacket.vehicles.some((vehicle) => vehicle.value !== null && vehicle.value > 0);
  tryCheck(form, 'Physical Damage', hasPhysicalDamage === true);

  if (hasPhysicalDamage) {
    // One deductible box. Prefer the single requested PD deductible; only fall
    // back to labelling comp/coll separately when they actually differ.
    const comp = cov.comprehensive_deductible;
    const coll = cov.collision_deductible;
    const deductible = cov.physical_damage_deductible
      ?? (comp && coll && comp !== coll
        ? `Comp: ${comp} / Coll: ${coll}`
        : comp ?? coll ?? '');
    trySet(form, 'Deductible', deductible);

    // Causes of loss. When the intake recorded none explicitly, a requested
    // deductible implies the usual comprehensive + collision pair.
    const anyCauseAnswered = cov.pd_comprehensive !== null
      || cov.pd_collision !== null
      || cov.pd_specified_causes !== null;
    tryCheck(form, 'Comprehensive', anyCauseAnswered ? cov.pd_comprehensive === true : !!comp || !!deductible);
    tryCheck(form, 'Collision', anyCauseAnswered ? cov.pd_collision === true : !!coll || !!deductible);
    tryCheck(form, 'Specified', cov.pd_specified_causes === true);
  } else {
    trySet(form, 'Deductible', '');
    tryCheck(form, 'Comprehensive', false);
    tryCheck(form, 'Collision', false);
    tryCheck(form, 'Specified', false);
  }

  // Motor Truck Cargo
  tryCheck(form, 'Cargo', !!cov.cargo_limit);
  trySet(form, 'Limits 1', cov.cargo_limit ?? '');
  trySet(form, 'Deductible_2', cov.cargo_deductible ?? '');
  selectRadio(form, 'Refrigeration Breakdown', triState(cov.reefer_breakdown_requested));

  // Trailer Interchange
  const tiLimit = sup('Trailer Interchange Limit') ?? cov.trailer_interchange_limit ?? '';
  tryCheck(form, 'Trailer Interchange Limits', !!tiLimit || cov.trailer_interchange === true);
  trySet(form, 'Limits 2', tiLimit);
  trySet(form, 'Deductible_3', cov.trailer_interchange_deductible ?? '');
  selectRadio(form, 'Written agreement in place', cov.trailer_interchange_agreement);

  // General Liability — this is the "Limits_2" box, not "Limits".
  const glLimit = sup('General Liability Limit') ?? cov.general_liability_limit ?? '';
  tryCheck(form, 'General Liability', !!glLimit || cov.general_liability === true);
  trySet(form, 'Limits_2', glLimit);
  trySet(form, 'Payroll', '');
  trySet(form, 'Receipts', '');

  // Medical Payments
  const medPayLimit = sup('Medical Payments Limit') ?? cov.medical_payments ?? '';
  tryCheck(form, 'Medical Payments', !!medPayLimit || cov.medical_payments_requested === true);
  trySet(form, 'Limits_3', medPayLimit);

  // Anything else the customer asked for that has no dedicated box.
  tryCheck(form, 'Other', !!cov.additional_coverages_other);
  trySet(form, 'undefined_2', cov.additional_coverages_other ?? '');

  // ── Page 2: Power Unit Information (5 rows) ──────────────────────────────
  const vehicleRows = template.max_vehicles ?? 5;
  const maxVeh = Math.min(dataPacket.vehicles.length, vehicleRows);
  for (let i = 0; i < maxVeh; i++) {
    const v = dataPacket.vehicles[i];
    const row = `Row${i + 1}`;
    trySet(form, `Year${row}`, v.year?.toString() ?? '');
    trySet(form, `Make${row}`, v.make ?? '');
    trySet(form, `Body Type Tractor Box Truck Flatbed Truck Dump Truck etc${row}`, v.type ?? '');
    trySet(form, `VIN${row}`, v.vin ?? '');
    // The intake's Physical Damage Value IS the actual cash value.
    trySet(form, `Actual Cash Value${row}`, moneyText(v.value));
    // Owner/operator units are ownership = leased with the driver as lessor.
    trySet(form, `Owned Leased or Owner Operator${row}`, v.ownership ?? 'Owned');
    trySet(form, `Additional Insured  Lessor${row}`, [v.lessor_name, v.lessor_address].filter(Boolean).join(' — '));
  }

  // ── Page 2: Trailer Information (5 rows) ─────────────────────────────────
  // This table exists on the form and was never being filled, so every trailer
  // the customer owned was silently dropped from the application.
  const trailerRows = template.max_trailers ?? 5;
  const maxTrl = Math.min(dataPacket.trailers.length, trailerRows);
  for (let i = 0; i < maxTrl; i++) {
    const t = dataPacket.trailers[i];
    const row = `Row${i + 1}`;
    trySet(form, `Year${row}_2`, t.year?.toString() ?? '');
    trySet(form, `Make${row}_2`, t.make ?? '');
    trySet(form, `Body Type Dry Van Refrigerated Flatbed Equipment etc${row}`, t.type ?? '');
    trySet(form, `VIN${row}_2`, t.vin ?? '');
    trySet(form, `Actual Cash Value${row}_2`, moneyText(t.value));
    trySet(form, `Additional Insured  Lessor${row}_2`, [t.lessor_name, t.lessor_address].filter(Boolean).join(' — '));
  }

  // ── Page 2: Driver Information (5 rows) ──────────────────────────────────
  const driverRows = template.max_drivers ?? 5;
  const maxDrv = Math.min(dataPacket.drivers.length, driverRows);
  for (let i = 0; i < maxDrv; i++) {
    const d = dataPacket.drivers[i];
    const row = `Row${i + 1}`;
    trySet(form, `Driver Name${row}`, d.full_name ?? '');
    trySet(form, `DOB${row}`, d.dob ?? '');
    trySet(form, `State${row}`, d.license_state ?? '');
    trySet(form, `License ${row}`, d.license_number ?? '');
    // This column asks for CDL years specifically, not years licensed.
    trySet(form, ` of years CDL experience${row}`, d.experience?.toString() ?? '');
    trySet(form, `Owner  Operator${row}`, yesNoText(d.owner_operator));
    trySet(form, `Violationaccident history for previous 36 months${row}`, d.violation_accident_summary ?? '');
  }

  // ── Page 2: Commodity Information (5 rows) ───────────────────────────────
  // Real per-commodity rows. Falls back to a single 100% row built from the
  // summary string for intakes taken before commodities were itemised.
  const commodityRows = 5;
  if (dataPacket.commodities.length > 0) {
    const maxCom = Math.min(dataPacket.commodities.length, commodityRows);
    for (let i = 0; i < maxCom; i++) {
      const c = dataPacket.commodities[i];
      const row = `Row${i + 1}`;
      trySet(form, `Commodities${row}`, c.description ?? '');
      trySet(form, `Percent Hauled${row}`, percentText(c.percent_hauled));
      trySet(form, `Average Value${row}`, moneyText(c.average_value));
      trySet(form, `Maximum Value${row}`, moneyText(c.maximum_value));
    }
  } else if (ops.commodities) {
    trySet(form, 'CommoditiesRow1', ops.commodities);
    trySet(form, 'Percent HauledRow1', '100%');
    trySet(form, 'Average ValueRow1', moneyText(cov.typical_load_value));
    trySet(form, 'Maximum ValueRow1', moneyText(cov.max_load_value));
  }

  // ── Page 3: Prior Carrier Information ────────────────────────────────────
  if (prior.carrier) {
    trySet(form, 'Policy PeriodRow1', prior.expiration ?? '');
    // A lapse means the prior term did not run clean for 12 months.
    trySet(form, '12 month term with no cancellationRow1', prior.lapse === true ? 'No' : 'Yes');
    trySet(form, 'Insurance CompanyRow1', prior.carrier);
    trySet(form, 'Line of BusinessRow1', [
      'AL',
      hasPhysicalDamage ? 'PD' : '',
      cov.cargo_limit ? 'Cargo' : '',
    ].filter(Boolean).join(', '));
    trySet(form, 'Policy NumberRow1', prior.policy_number ?? '');
    trySet(form, 'Number of Power units  Total Insured ValueRow1', [
      (ops.power_unit_count ?? dataPacket.vehicles.length).toString(),
      moneyText(dataPacket.vehicles.reduce((total, v) => total + (v.value ?? 0), 0) || null),
    ].filter(Boolean).join(' / '));
    trySet(form, ' of ClaimsRow1', uw.losses_3yr === true ? '' : '0');
    trySet(form, 'Losses Paid Incl ReservesRow1', uw.losses_3yr === false ? '$0' : '');
  }

  // ── Page 3: Additional Remarks / Signatures ──────────────────────────────
  // Anything that did not fit a dedicated box goes here, so it reaches the
  // underwriter instead of being lost.
  const remarks: string[] = [];
  if (ops.farthest_states_cities) remarks.push(`Farthest travelled: ${ops.farthest_states_cities}`);
  if (cov.max_load_value) remarks.push(`Maximum value of any one load: ${moneyText(cov.max_load_value)}`);
  if (dataPacket.trailers.length > maxTrl) {
    remarks.push(`Additional trailers not shown above: ${dataPacket.trailers.slice(maxTrl)
      .map((t) => [t.year, t.make, t.type, t.vin].filter(Boolean).join(' '))
      .join('; ')}`);
  }
  if (prior.months_continuous_coverage) {
    remarks.push(`${prior.months_continuous_coverage} months of continuous coverage.`);
  }
  // Explanations beyond the four lines the questions box allows.
  remarks.push(...underwritingExplanations(dataPacket).slice(4));
  fillLines(form, [
    'any other helpful information 1',
    'any other helpful information 2',
    'any other helpful information 3',
    'any other helpful information 4',
    'any other helpful information 5',
    'any other helpful information 6',
    'any other helpful information 7',
  ], remarks);

  trySet(form, 'Applicants Name  Title Please Print', owner?.name ?? biz.legal_name ?? '');
  trySet(form, 'Agency Address', 'New Hope Insurance, Miami FL');
  const today = new Date().toLocaleDateString('en-US');
  trySet(form, 'Date', today);
  trySet(form, 'Date_2', today);

  // Overflow warnings
  if (dataPacket.drivers.length > driverRows) {
    warnings.push(`${dataPacket.drivers.length} drivers exceed the form's ${driverRows} rows. Attach a continuation schedule.`);
  }
  if (dataPacket.vehicles.length > vehicleRows) {
    warnings.push(`${dataPacket.vehicles.length} power units exceed the form's ${vehicleRows} rows. Attach a continuation schedule.`);
  }
  if (dataPacket.trailers.length > trailerRows) {
    warnings.push(`${dataPacket.trailers.length} trailers exceed the form's ${trailerRows} rows. The remainder is listed under additional information.`);
  }
  if (dataPacket.commodities.length > commodityRows) {
    warnings.push(`${dataPacket.commodities.length} commodities exceed the form's ${commodityRows} rows. Attach a commodity schedule.`);
  }
  if (!cov.auto_liability_limit) {
    warnings.push('No Auto Liability limit was recorded on the intake, so the Limits box is blank. Carriers will not quote without it.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIA QUICK QUOTE FORM FILLING
// ═══════════════════════════════════════════════════════════════════════════════

function fillTiaForm(
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
  const uw = dataPacket.underwriting;

  /** A market-specific answer always wins over the intake, when one was given. */
  const sup = (key: string): string | null => supplementalAnswers[key]?.trim() || null;

  // ── Producer / Insured Information ─────────────────────────────────────
  trySet(form, 'Agency', 'New Hope Insurance');
  trySet(form, 'Producer', 'Jason Toro');
  trySet(form, 'Phone', '');
  trySet(form, 'Fax', '');
  trySet(form, 'Email', 'jtoro@newhopeins.com');

  trySet(form, 'Name', biz.legal_name ?? '');
  trySet(form, 'DBA', biz.dba ?? '');
  trySet(form, 'Garaging Address', [biz.garaging_street ?? biz.mailing_street, biz.garaging_city ?? biz.mailing_city, biz.garaging_state ?? biz.mailing_state, biz.garaging_zip ?? biz.mailing_zip].filter(Boolean).join(', '));
  trySet(form, 'Mailing Address', [biz.mailing_street, biz.mailing_city, biz.mailing_state, biz.mailing_zip].filter(Boolean).join(', '));

  // Effective Dates
  trySet(form, 'EffectiveDates', sup('Target effective date') ?? ops.desired_effective_date ?? '');

  // ── Operation Information ──────────────────────────────────────────────
  trySet(form, 'Destination Cities Zone rated  10 or more of operation',
    sup('Primary Destinations') ?? ops.farthest_states_cities ?? ops.states ?? '');
  trySet(form, 'Cities Traveled Through Zone rated  10 or more of operation', ops.states ?? '');
  trySet(form, 'Percentage of Loads Through Brokers', sup('Percentage of Loads Brokered') ?? ops.brokerage_percentage?.toString() ?? '');
  trySet(form, 'Percentage of Loads to Regular Destinations', sup('Percentage of Loads to Regular Destinations') ?? '');
  trySet(form, 'CurrentYearUnits', (ops.power_unit_count ?? dataPacket.vehicles.length).toString());
  trySet(form, '1st Prior', supplementalAnswers['# of Power Units Prior Year'] ?? '');
  trySet(form, 'Gross Revenue Past Year', supplementalAnswers['Annual Revenue'] ?? '');
  trySet(form, 'Projected', supplementalAnswers['Projected Revenue'] ?? '');
  trySet(form, 'Past Year Mileage', supplementalAnswers['Annual Mileage'] ?? ops.mileage?.toString() ?? '');
  trySet(form, 'Projected_2', supplementalAnswers['Projected Mileage'] ?? '');
  trySet(form, 'DOT', biz.dot_number ?? '');
  trySet(form, 'MC', biz.mc_number ?? '');
  trySet(form, 'FEIN', biz.fein ?? '');
  trySet(form, 'ELD Manufacturer', supplementalAnswers['ELD Manufacturer'] ?? '');
  trySet(form, 'Years Insured Under this Name', biz.years_in_business?.toString() ?? '');
  trySet(form, 'Owner Social Security Number SSN', ''); // Never auto-fill SSN

  // Cancelled/Non-renewed — now answered from the intake underwriting section.
  const supBool = (key: string): boolean | null => {
    const raw = sup(key);
    if (!raw) return null;
    return raw.toLowerCase().includes('yes');
  };
  selectRadio(form, 'Canceled or NonRenewed in Past 3 Years',
    supBool('Cancelled or Non-Renewed in Past 3 Years?') ?? uw.cancelled_nonrenewed ?? false);
  trySet(form, 'If Yes Reason',
    sup('If cancelled/non-renewed, reason') ?? uw.cancelled_nonrenewed_detail ?? '');

  // ── Driver Information (6 rows) ────────────────────────────────────────
  const tiaDriverRows = 6;
  const maxDrv = Math.min(dataPacket.drivers.length, tiaDriverRows);
  for (let i = 0; i < maxDrv; i++) {
    const d = dataPacket.drivers[i];
    const row = `Row${i + 1}`;
    trySet(form, `Name${row}`, d.full_name ?? '');
    trySet(form, `License${row}`, d.license_number ?? '');
    trySet(form, `State${row}`, d.license_state ?? '');
    trySet(form, `DOB${row}`, d.dob ?? '');
    trySet(form, `Hire Date${row}`, '');
    // Experience with similar equipment — CDL years is the closest the intake has.
    trySet(form, `Yrs Exp with Similar Equip${row}`, d.experience?.toString() ?? '');
  }

  // ── Vehicle Schedule (6 rows) ──────────────────────────────────────────
  // TIA pairs a trailer type against each power-unit row, so trailer n rides
  // alongside truck n.
  const tiaVehicleRows = 6;
  const maxVeh = Math.min(dataPacket.vehicles.length, tiaVehicleRows);
  for (let i = 0; i < maxVeh; i++) {
    const v = dataPacket.vehicles[i];
    const n = (i + 1).toString();
    trySet(form, `Year${n}`, v.year?.toString() ?? '');
    trySet(form, `Make${n}`, v.make ?? '');
    trySet(form, `VIN${n}`, v.vin ?? '');
    trySet(form, `TRKTRAC${n}`, v.type ?? '');
    trySet(form, `TRL Type${n}`, dataPacket.trailers[i]?.type ?? '');
    trySet(form, `Value${n}`, moneyText(v.value));
    trySet(form, `GVW${n}`, v.gvw?.toString() ?? '');
    trySet(form, `Radius${n}`, v.radius?.toString() ?? ops.radius?.toString() ?? '');
  }

  // More trailers than power units: keep filling the trailer column so none are
  // dropped, even though those rows have no truck beside them.
  for (let i = maxVeh; i < Math.min(dataPacket.trailers.length, tiaVehicleRows); i++) {
    const t = dataPacket.trailers[i];
    const n = (i + 1).toString();
    trySet(form, `TRL Type${n}`, t.type ?? '');
    trySet(form, `Year${n}`, t.year?.toString() ?? '');
    trySet(form, `Make${n}`, t.make ?? '');
    trySet(form, `VIN${n}`, t.vin ?? '');
    trySet(form, `Value${n}`, moneyText(t.value));
  }

  // ── Insurance Carrier Information (past 3 years) ───────────────────────
  if (prior.carrier) {
    trySet(form, 'YearEff1', '');
    trySet(form, 'YearExp1', prior.expiration ?? '');
    trySet(form, 'Companyto', prior.carrier);
    trySet(form, ' Units Insuredto', dataPacket.vehicles.length.toString());
    trySet(form, ' of Claimsto', '');
    trySet(form, 'Amount Incurredto', '');
    trySet(form, 'Drive Nameto', '');
  }

  // ── Coverages & Limits ─────────────────────────────────────────────────
  // Liability type
  tryCheck(form, 'Primary', true);

  // Auto Liability
  trySet(form, 'Auto Liability Limit', cov.auto_liability_limit ?? '');
  trySet(form, 'UMUIM Limits', sup('UM/UIM Limit') ?? cov.um_uim_limit ?? '');
  trySet(form, 'LiabPersonal Injury Protection', '');
  trySet(form, 'LiabMedical Payments', sup('Medical Payments Limit') ?? cov.medical_payments ?? '');
  // Hired / non-owned auto. This form takes them as text, so record the
  // customer's answer rather than leaving it blank.
  const hiredAutoText = cov.hired_auto === 'yes'
    ? (cov.auto_liability_limit ?? 'Requested')
    : cov.hired_auto === 'not_sure' ? 'To confirm' : '';
  trySet(form, 'LiabHiredAutoLiability', hiredAutoText);
  trySet(form, 'LiabHiredCarPhysical', '');
  trySet(form, 'HCP Limit', '');
  trySet(form, 'HCPNumberofDays', '');

  // Physical Damage — driven by the explicit intake answer, falling back to
  // whether any unit carries a stated value.
  const hasPhysicalDamage = cov.physical_damage_requested
    ?? cov.physical_damage
    ?? dataPacket.vehicles.some((vehicle) => vehicle.value !== null && vehicle.value > 0);
  const pdDeductible = cov.physical_damage_deductible ?? '';
  trySet(form, 'Coll Ded', hasPhysicalDamage ? (cov.collision_deductible ?? pdDeductible) : '');
  trySet(form, 'OTC Ded', hasPhysicalDamage ? (cov.comprehensive_deductible ?? pdDeductible) : '');

  // Cargo
  trySet(form, 'Limit', cov.cargo_limit ?? '');
  trySet(form, 'Ded', cov.cargo_deductible ?? '');

  // Cargo commodities table (5 rows)
  const tiaCommodityRows = 5;
  if (dataPacket.commodities.length > 0) {
    const maxCom = Math.min(dataPacket.commodities.length, tiaCommodityRows);
    for (let i = 0; i < maxCom; i++) {
      const c = dataPacket.commodities[i];
      const n = (i + 1).toString();
      trySet(form, `Commodities${n}`, c.description ?? '');
      trySet(form, `PercentOfLoad${n}`, percentText(c.percent_hauled));
      trySet(form, `AverageTruckloadValue${n}`, moneyText(c.average_value));
      trySet(form, `MaximumTruckloadValue${n}`, moneyText(c.maximum_value));
    }
  } else if (ops.commodities) {
    trySet(form, 'Commodities1', ops.commodities);
    trySet(form, 'PercentOfLoad1', '100%');
    trySet(form, 'AverageTruckloadValue1', moneyText(cov.typical_load_value));
    trySet(form, 'MaximumTruckloadValue1', moneyText(cov.max_load_value));
  }

  // General Liability
  trySet(form, 'GLLimit', sup('General Liability Limit') ?? cov.general_liability_limit ?? '');
  trySet(form, ' of OwnersOfficers', dataPacket.owners.length ? dataPacket.owners.length.toString() : '');
  trySet(form, ' of Employees', '');
  trySet(form, 'Additional Coverages', [
    cov.additional_coverages_other ?? '',
    cov.trailer_interchange_limit ? `Trailer Interchange ${cov.trailer_interchange_limit}` : '',
    ops.owner_operators ? `${ops.owner_operators} owner/operator(s)` : '',
  ].filter(Boolean).join('; '));

  // Overflow warnings
  if (dataPacket.drivers.length > tiaDriverRows) {
    warnings.push(`${dataPacket.drivers.length} drivers exceed TIA's ${tiaDriverRows} rows. Attach a schedule.`);
  }
  if (dataPacket.vehicles.length > tiaVehicleRows) {
    warnings.push(`${dataPacket.vehicles.length} vehicles exceed TIA's ${tiaVehicleRows} rows. Attach a schedule.`);
  }
  if (dataPacket.trailers.length > tiaVehicleRows) {
    warnings.push(`${dataPacket.trailers.length} trailers exceed TIA's ${tiaVehicleRows} schedule rows. Attach a schedule.`);
  }
  if (dataPacket.commodities.length > tiaCommodityRows) {
    warnings.push(`${dataPacket.commodities.length} commodities exceed TIA's ${tiaCommodityRows} rows. Attach a commodity schedule.`);
  }
  if (!cov.auto_liability_limit) {
    warnings.push('No Auto Liability limit was recorded on the intake, so that box is blank. Carriers will not quote without it.');
  }
}

function trySet(form: ReturnType<typeof PDFDocument.prototype.getForm>, name: string, value: string) {
  try {
    const field = form.getTextField(name);
    field.setText(value);
  } catch {
    // Field doesn't exist — that's fine
  }
}

/**
 * Selects Yes or No on a radio group.
 *
 * The carrier forms name their options inconsistently — the JSA underwriting
 * questions use `Yes_7`/`No_7`, `Yes_11`/`No_11` and so on, and the last group
 * (`undefined_2aas`) has options `Yes_3` and the bare string `2`. So matching on
 * the word "no" is not enough: when no option contains it, fall back to "the
 * option that is not the Yes one", which is correct for a two-option group.
 *
 * A `null` answer leaves the group untouched rather than guessing.
 */
function selectRadio(
  form: ReturnType<typeof PDFDocument.prototype.getForm>,
  name: string,
  answer: boolean | null,
) {
  if (answer === null || answer === undefined) return;
  try {
    const group = form.getRadioGroup(name);
    const options = group.getOptions();
    if (!options.length) return;

    const yesOption = options.find((option) => option.toLowerCase().includes('yes'));
    if (answer) {
      if (yesOption) group.select(yesOption);
      return;
    }

    const noOption =
      options.find((option) => option.toLowerCase().includes('no'))
      ?? options.find((option) => option !== yesOption);
    if (noOption) group.select(noOption);
  } catch {
    // Group doesn't exist on this variant of the form — that's fine
  }
}

/** "Yes" / "No" / "" — for the text columns that ask a yes-no question. */
function yesNoText(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value ? 'Yes' : 'No';
}

/** `$20,000`, or '' for a missing amount. Never prints `$0` for unknown. */
function moneyText(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '';
  return `$${Number(amount).toLocaleString()}`;
}

/** `45%` from 45, `''` from null. */
function percentText(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return `${Number(value)}%`;
}

/**
 * Spreads a block of text across a set of single-line form fields, because the
 * carrier forms give N separate lines rather than one multiline box.
 */
function fillLines(
  form: ReturnType<typeof PDFDocument.prototype.getForm>,
  fieldNames: string[],
  lines: string[],
) {
  for (let i = 0; i < fieldNames.length; i++) {
    trySet(form, fieldNames[i], lines[i] ?? '');
  }
}

/**
 * The explanations a trucking underwriter needs for every Yes answer, one line
 * each. Byron's rule: a Yes is not a problem, an unexplained Yes is.
 */
function underwritingExplanations(dataPacket: TruckingDataPacket): string[] {
  const uw = dataPacket.underwriting;
  const lines: string[] = [];

  const add = (answered: boolean | null, label: string, detail: string | null) => {
    if (answered !== true) return;
    lines.push(`${label}: ${detail?.trim() || 'Yes — details to follow.'}`);
  };

  add(uw.cancelled_nonrenewed, 'Cancelled/non-renewed', uw.cancelled_nonrenewed_detail);
  add(uw.coverage_lapse, 'Coverage lapse', uw.coverage_lapse_detail);
  add(uw.losses_3yr, 'Claims/losses past 3 years', uw.losses_3yr_detail);
  add(uw.major_al_loss, 'Major AL loss over $250,000', uw.major_al_loss_detail);

  if (uw.hazmat === 'yes' || uw.hazmat === 'unsure' || uw.hazmat === 'not_sure') {
    const prefix = uw.hazmat === 'yes' ? 'Hazmat' : 'Hazmat (unconfirmed)';
    lines.push(`${prefix}: ${uw.hazmat_detail?.trim() || 'Customer to confirm commodities.'}`);
  }

  if (uw.owner_operators === true) {
    const count = uw.owner_operator_count ? ` (${uw.owner_operator_count})` : '';
    lines.push(`Owner/operators${count}: ${uw.owner_operators_detail?.trim() || 'Yes'}`);
  }

  return lines;
}

function tryCheck(form: ReturnType<typeof PDFDocument.prototype.getForm>, name: string, checked: boolean) {
  try {
    const field = form.getCheckBox(name);
    if (checked) field.check();
    else field.uncheck();
  } catch {
    // Field doesn't exist or isn't a checkbox — that's fine
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
    'operations.operation_types': ops.operation_types ?? '',
    'operations.radius_band': ops.radius_band ?? '',
    'operations.desired_effective_date': ops.desired_effective_date ?? '',
    'coverages.auto_liability_limit': cov.auto_liability_limit ?? '',
    'coverages.cargo_limit': cov.cargo_limit ?? '',
    'coverages.cargo_deductible': cov.cargo_deductible ?? '',
    'coverages.um_uim_limit': cov.um_uim_limit ?? '',
    'coverages.physical_damage_deductible': cov.physical_damage_deductible ?? '',
    'coverages.general_liability_limit': cov.general_liability_limit ?? '',
    'coverages.medical_payments': cov.medical_payments ?? '',
    'coverages.trailer_interchange_limit': cov.trailer_interchange_limit ?? '',
    'coverages.comprehensive_deductible': cov.comprehensive_deductible ?? '',
    'coverages.collision_deductible': cov.collision_deductible ?? '',
    'underwriting.hazmat': dataPacket.underwriting.hazmat ?? '',
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
  doc.text(`Type of Operation: ${ops.operation_types ?? ''}`);
  if (ops.operation_description) doc.text(`Description: ${ops.operation_description}`);
  doc.text(`Commodities: ${ops.commodities ?? ''}`);
  doc.text(`Radius: ${ops.radius_band ?? `${ops.radius ?? ''} miles`}     States: ${ops.states ?? ''}`);
  if (ops.farthest_states_cities) doc.text(`Farthest travelled: ${ops.farthest_states_cities}`);
  doc.text(`Interstate: ${yesNoText(ops.interstate)}     For Hire: ${yesNoText(ops.for_hire)}     Power Units: ${ops.power_unit_count ?? ''}`);
  if (ops.desired_effective_date) doc.text(`Desired Effective Date: ${ops.desired_effective_date}`);
  doc.moveDown(0.5);

  // Coverages
  doc.font('Helvetica-Bold').text('COVERAGES');
  doc.moveDown(0.2);
  doc.font('Helvetica');
  doc.text(`Auto Liability: ${cov.auto_liability_limit ?? ''}     UM/UIM: ${cov.um_uim_limit ?? ''}`);
  doc.text(`Physical Damage: ${yesNoText(cov.physical_damage_requested ?? cov.physical_damage)}     PD Deductible: ${cov.physical_damage_deductible ?? ''}`);
  doc.text(`Cargo: ${cov.cargo_limit ?? ''}     Cargo Deductible: ${cov.cargo_deductible ?? ''}`);
  doc.text(`Comp Ded: ${cov.comprehensive_deductible ?? ''}     Coll Ded: ${cov.collision_deductible ?? ''}`);
  if (cov.trailer_interchange_limit) {
    doc.text(`Trailer Interchange: ${cov.trailer_interchange_limit}     Deductible: ${cov.trailer_interchange_deductible ?? ''}     Written agreement: ${yesNoText(cov.trailer_interchange_agreement)}`);
  }
  if (cov.general_liability_limit) doc.text(`General Liability: ${cov.general_liability_limit}`);
  if (cov.medical_payments) doc.text(`Medical Payments: ${cov.medical_payments}`);
  doc.text(`Hired Auto: ${cov.hired_auto ?? ''}     Non-Owned Auto: ${cov.non_owned_auto ?? ''}`);
  if (cov.max_load_value) doc.text(`Maximum value of any one load: ${moneyText(cov.max_load_value)}`);
  if (cov.additional_coverages_other) doc.text(`Also requested: ${cov.additional_coverages_other}`);
  doc.moveDown(0.5);

  // Underwriting — the answers that decide whether the risk is placeable.
  doc.font('Helvetica-Bold').text('UNDERWRITING');
  doc.moveDown(0.2);
  doc.font('Helvetica');
  const explanations = underwritingExplanations(dataPacket);
  if (explanations.length > 0) {
    for (const line of explanations) doc.text(line);
  } else {
    doc.text('No coverage lapse, cancellation, losses, major AL loss, hazmat or owner/operators reported.');
  }
  doc.moveDown(0.5);

  // Prior
  doc.font('Helvetica-Bold').text('PRIOR INSURANCE');
  doc.moveDown(0.2);
  doc.font('Helvetica');
  doc.text(`Carrier: ${prior.carrier ?? ''}     Premium: ${prior.premium ? `$${prior.premium}` : ''}`);
  doc.text(`Policy #: ${prior.policy_number ?? ''}     Expires: ${prior.expiration ?? ''}`);
  doc.text(`Lapse: ${yesNoText(prior.lapse)}${prior.lapse_explanation ? ` — ${prior.lapse_explanation}` : ''}`);
  doc.moveDown(0.5);

  // Drivers
  if (dataPacket.drivers.length > 0) {
    doc.font('Helvetica-Bold').text('DRIVERS');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(8);
    const drvs = maxDrivers ? dataPacket.drivers.slice(0, maxDrivers) : dataPacket.drivers;
    for (const d of drvs) {
      doc.text(`${d.full_name ?? ''} | DOB: ${d.dob ?? ''} | CDL: ${d.license_number ?? ''} (${d.license_state ?? ''}) | Exp: ${d.experience ?? ''} yrs | Owner/Op: ${yesNoText(d.owner_operator)} | History: ${d.violation_accident_summary ?? ''}`);
    }
    doc.moveDown(0.5);
  }

  // Vehicles
  if (dataPacket.vehicles.length > 0) {
    doc.fontSize(9).font('Helvetica-Bold').text('POWER UNITS');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(8);
    const vehs = maxVehicles ? dataPacket.vehicles.slice(0, maxVehicles) : dataPacket.vehicles;
    for (const v of vehs) {
      doc.text(`${v.year ?? ''} ${v.make ?? ''} ${v.model ?? ''} (${v.type ?? ''}) | VIN: ${v.vin ?? ''} | ACV: ${moneyText(v.value)} | ${v.ownership ?? ''}${v.lessor_name ? ` — Lessor: ${v.lessor_name}` : ''}`);
    }
    doc.moveDown(0.5);
  }

  // Trailers
  if (dataPacket.trailers.length > 0) {
    doc.fontSize(9).font('Helvetica-Bold').text('TRAILERS');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(8);
    for (const t of dataPacket.trailers) {
      doc.text(`${t.year ?? ''} ${t.make ?? ''} (${t.type ?? ''}) | VIN: ${t.vin ?? ''} | ACV: ${moneyText(t.value)} | ${t.ownership ?? ''}${t.lessor_name ? ` — Lessor: ${t.lessor_name}` : ''}`);
    }
    doc.moveDown(0.5);
  }

  // Commodities
  if (dataPacket.commodities.length > 0) {
    doc.fontSize(9).font('Helvetica-Bold').text('COMMODITIES');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(8);
    for (const c of dataPacket.commodities) {
      doc.text(`${c.description ?? ''}${c.is_primary ? ' (primary)' : ''} | ${percentText(c.percent_hauled)} | Avg: ${moneyText(c.average_value)} | Max: ${moneyText(c.maximum_value)}`);
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

/**
 * Subject and body templates for carrier submissions, and the requested-coverage block.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirements 2.4, 5.5–5.10.
 *
 * Pure and React-free on purpose: an API route imports this to render the message
 * server-side at send time, and `src/features/specialty/market-directory/trucking-data-adapter.ts`
 * keeps the same discipline for the same reason.
 */

import type { TruckingCoverages } from '@/features/specialty/market-directory/types';

/**
 * Every placeholder a manager may use in a market's templates.
 *
 * Shown in the Market Directory admin so a manager writing a template can see what is
 * available rather than guessing. An unknown placeholder is left verbatim rather than
 * replaced with an empty string, so `findUnresolvedPlaceholders` can report it and the
 * composer can warn before the message goes to a carrier.
 */
export const SUBMISSION_PLACEHOLDERS = [
  { token: '{{company_name}}', description: 'The insured business, from the quote' },
  { token: '{{coverage_summary}}', description: 'Short form for the subject line, e.g. AL / PD / Cargo' },
  { token: '{{coverage_lines}}', description: 'The full requested-coverage block, one line each' },
  { token: '{{carrier_name}}', description: 'The market being submitted to' },
  { token: '{{sender_name}}', description: 'The person sending, from their profile' },
] as const;

export const DEFAULT_SUBJECT_TEMPLATE = '{{company_name}} - {{coverage_summary}} Submission';

export const DEFAULT_BODY_TEMPLATE = `Hello,

Please find attached the submission for {{company_name}}.

Requested Coverages:

{{coverage_lines}}

Please review and let us know if any additional information is required.

Thank you,
{{sender_name}}
New Hope Insurance Agency`;

/** One requested coverage, ready to render. */
export interface CoverageLine {
  /** Stable key, used for the short subject summary. */
  key: string;
  /** What the carrier reads, e.g. "Auto Liability". */
  label: string;
  /** Short form for the subject line, e.g. "AL". */
  abbreviation: string;
  /** The limit, deductible and any qualifiers, already formatted. */
  detail: string;
}

/**
 * Replaces `{{name}}` tokens.
 *
 * An unknown token is left exactly as written. That is deliberate: substituting an
 * empty string would produce a plausible-looking sentence with a hole in it, and the
 * sender would have no way to notice before the carrier did.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, name: string) => {
    const value = vars[name.toLowerCase()];
    return value === undefined ? whole : value;
  });
}

/** Every `{{...}}` still present after rendering. Drives the composer's warning. */
export function findUnresolvedPlaceholders(text: string): string[] {
  return Array.from(new Set(text.match(/\{\{\s*[a-z0-9_]+\s*\}\}/gi) ?? []));
}

function money(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function limitAndDeductible(limit: string | null, deductible: string | null): string {
  const parts: string[] = [];
  if (limit) parts.push(limit);
  if (deductible) parts.push(`${deductible} deductible`);
  return parts.join(' / ');
}

/**
 * The requested-coverage block.
 *
 * Only coverages actually asked for on the intake appear (Requirement 5.7). A carrier
 * reading "Physical Damage: not requested" learns nothing; a carrier reading a list of
 * six lines knows exactly what to quote. Absence is the signal.
 *
 * The `*_requested` booleans are preferred over inferring from a limit, because
 * v1.19.2 added them precisely so the intake could record an explicit answer rather
 * than have the engine guess from vehicle values.
 */
export function buildCoverageLines(coverages: TruckingCoverages): CoverageLine[] {
  const lines: CoverageLine[] = [];

  const autoLiability = money(coverages.auto_liability_limit);
  if (autoLiability) {
    lines.push({ key: 'auto_liability', label: 'Auto Liability', abbreviation: 'AL', detail: autoLiability });
  }

  const umUim = money(coverages.um_uim_limit);
  if (umUim) {
    lines.push({ key: 'um_uim', label: 'UM/UIM', abbreviation: 'UM', detail: umUim });
  }

  const pdRequested = coverages.physical_damage_requested ?? coverages.physical_damage ?? false;
  if (pdRequested) {
    const perils = [
      coverages.pd_comprehensive ? 'Comprehensive' : null,
      coverages.pd_collision ? 'Collision' : null,
      coverages.pd_specified_causes ? 'Specified Causes of Loss' : null,
    ].filter((peril): peril is string => peril !== null);
    const detail = [
      limitAndDeductible(null, money(coverages.physical_damage_deductible)),
      perils.length > 0 ? perils.join(', ') : null,
    ].filter((part): part is string => part !== null && part.length > 0).join(' — ');
    lines.push({
      key: 'physical_damage',
      label: 'Physical Damage',
      abbreviation: 'PD',
      detail: detail.length > 0 ? detail : 'Requested',
    });
  }

  const cargo = money(coverages.cargo_limit);
  if (cargo) {
    lines.push({
      key: 'cargo',
      label: 'Motor Truck Cargo',
      abbreviation: 'Cargo',
      detail: limitAndDeductible(cargo, money(coverages.cargo_deductible)),
    });
  }

  const trailerLimit = money(coverages.trailer_interchange_limit);
  if (trailerLimit || coverages.trailer_interchange) {
    const detail = limitAndDeductible(trailerLimit, money(coverages.trailer_interchange_deductible));
    const agreement = coverages.trailer_interchange_agreement ? ' (written interchange agreement in place)' : '';
    lines.push({
      key: 'trailer_interchange',
      label: 'Trailer Interchange',
      abbreviation: 'TI',
      detail: (detail.length > 0 ? detail : 'Requested') + agreement,
    });
  }

  const glLimit = money(coverages.general_liability_limit);
  if (glLimit || coverages.general_liability) {
    lines.push({
      key: 'general_liability',
      label: 'General Liability',
      abbreviation: 'GL',
      detail: glLimit ?? 'Requested',
    });
  }

  const other = money(coverages.additional_coverages_other);
  if (other) {
    lines.push({ key: 'other', label: 'Additional Coverages', abbreviation: 'Other', detail: other });
  }

  return lines;
}

/** The body block: one `Label: detail` per line. */
export function formatCoverageLines(lines: CoverageLine[]): string {
  if (lines.length === 0) return 'To be confirmed.';
  return lines.map((line) => `${line.label}: ${line.detail}`).join('\n');
}

/**
 * The subject-line summary, e.g. `AL / PD / Cargo`.
 *
 * Derived from the same lines as the body so the subject can never claim a coverage
 * the body does not list, or omit one it does.
 */
export function buildCoverageSummary(lines: CoverageLine[]): string {
  if (lines.length === 0) return 'Insurance';
  return lines.map((line) => line.abbreviation).join(' / ');
}

export interface SubmissionMessageInput {
  companyName: string;
  carrierName: string;
  senderName: string;
  coverages: TruckingCoverages | null;
  subjectTemplate?: string | null;
  bodyTemplate?: string | null;
}

/** Renders the whole message. Used by the composer to seed, and by the send route. */
export function buildSubmissionMessage(input: SubmissionMessageInput): {
  subject: string;
  body: string;
  coverageLines: CoverageLine[];
  unresolved: string[];
} {
  const coverageLines = input.coverages ? buildCoverageLines(input.coverages) : [];
  const vars: Record<string, string> = {
    company_name: input.companyName,
    carrier_name: input.carrierName,
    sender_name: input.senderName,
    coverage_summary: buildCoverageSummary(coverageLines),
    coverage_lines: formatCoverageLines(coverageLines),
  };

  const subject = renderTemplate(input.subjectTemplate?.trim() || DEFAULT_SUBJECT_TEMPLATE, vars);
  const body = renderTemplate(input.bodyTemplate?.trim() || DEFAULT_BODY_TEMPLATE, vars);

  return {
    subject,
    body,
    coverageLines,
    unresolved: [...findUnresolvedPlaceholders(subject), ...findUnresolvedPlaceholders(body)],
  };
}

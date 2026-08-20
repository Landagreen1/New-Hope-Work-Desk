/**
 * Template rendering and the requested-coverage block.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirements 2.4, 5.5–5.10.
 *
 * The assertions worth reading are the ones about absence. A carrier reading
 * "Physical Damage: not requested" learns nothing; a carrier reading six lines knows
 * exactly what to quote. So the block must omit what was not asked for, and the subject
 * summary must be derived from the same lines as the body — a subject that claims a
 * coverage the body does not list is worse than no subject at all.
 */

import { describe, expect, it } from 'vitest';

import type { TruckingCoverages } from '@/features/specialty/market-directory/types';

import {
  DEFAULT_BODY_TEMPLATE,
  DEFAULT_SUBJECT_TEMPLATE,
  buildCoverageLines,
  buildCoverageSummary,
  buildSubmissionMessage,
  findUnresolvedPlaceholders,
  formatCoverageLines,
  renderTemplate,
} from '../templates';

/** Every field null/false — nothing requested. Each test opts in to what it needs. */
function noCoverages(): TruckingCoverages {
  return {
    auto_liability_limit: null,
    cargo_limit: null,
    cargo_deductible: null,
    physical_damage: null,
    general_liability: null,
    trailer_interchange: null,
    comprehensive_deductible: null,
    collision_deductible: null,
    medical_payments: null,
    um_uim_limit: null,
    hired_auto: null,
    non_owned_auto: null,
    physical_damage_requested: null,
    physical_damage_deductible: null,
    pd_comprehensive: null,
    pd_collision: null,
    pd_specified_causes: null,
    trailer_interchange_limit: null,
    trailer_interchange_deductible: null,
    trailer_interchange_agreement: null,
    general_liability_limit: null,
    medical_payments_requested: null,
    additional_coverages_other: null,
    max_load_value: null,
    typical_load_value: null,
    reefer_breakdown_requested: null,
  };
}

describe('renderTemplate', () => {
  it('substitutes known placeholders', () => {
    expect(renderTemplate('{{company_name}} - {{carrier_name}}', {
      company_name: 'Miru Transportation LLC',
      carrier_name: 'All Star Underwriters',
    })).toBe('Miru Transportation LLC - All Star Underwriters');
  });

  it('tolerates whitespace and case inside the braces', () => {
    expect(renderTemplate('{{ Company_Name }}', { company_name: 'Miru' })).toBe('Miru');
  });

  it('leaves an unknown placeholder verbatim rather than blanking it', () => {
    // Substituting '' would produce "Please quote  for us" — a plausible sentence with
    // a hole in it that nobody notices until the carrier replies asking what for.
    const out = renderTemplate('Please quote {{unknown_thing}} for us', {});
    expect(out).toBe('Please quote {{unknown_thing}} for us');
    expect(findUnresolvedPlaceholders(out)).toEqual(['{{unknown_thing}}']);
  });

  it('reports each unresolved placeholder once', () => {
    expect(findUnresolvedPlaceholders('{{a}} {{a}} {{b}}')).toEqual(['{{a}}', '{{b}}']);
  });

  it('finds nothing in a fully rendered message', () => {
    const { unresolved } = buildSubmissionMessage({
      companyName: 'Miru Transportation LLC',
      carrierName: 'All Star Underwriters',
      senderName: 'Oscar',
      coverages: { ...noCoverages(), auto_liability_limit: '$750,000' },
    });
    expect(unresolved).toEqual([]);
  });
});

describe('buildCoverageLines', () => {
  it('emits nothing when nothing was requested', () => {
    expect(buildCoverageLines(noCoverages())).toEqual([]);
  });

  it('omits coverages that were not requested', () => {
    const lines = buildCoverageLines({ ...noCoverages(), auto_liability_limit: '$750,000' });
    expect(lines.map((line) => line.key)).toEqual(['auto_liability']);
  });

  it('states both limit and deductible for cargo', () => {
    const [line] = buildCoverageLines({
      ...noCoverages(),
      cargo_limit: '$100,000',
      cargo_deductible: '$2,500',
    });
    expect(line.label).toBe('Motor Truck Cargo');
    expect(line.detail).toBe('$100,000 / $2,500 deductible');
  });

  it('states the limit alone when there is no deductible', () => {
    const [line] = buildCoverageLines({ ...noCoverages(), cargo_limit: '$100,000' });
    expect(line.detail).toBe('$100,000');
  });

  it('lists the physical damage perils that were selected', () => {
    const [line] = buildCoverageLines({
      ...noCoverages(),
      physical_damage_requested: true,
      physical_damage_deductible: '$2,500',
      pd_comprehensive: true,
      pd_collision: true,
    });
    expect(line.detail).toBe('$2,500 deductible — Comprehensive, Collision');
  });

  it('prefers the explicit physical_damage_requested answer over the inferred flag', () => {
    // v1.19.2 added the explicit field precisely so the intake records an answer rather
    // than the engine guessing from vehicle values.
    const requested = buildCoverageLines({
      ...noCoverages(), physical_damage_requested: true, physical_damage: false,
    });
    expect(requested.map((line) => line.key)).toContain('physical_damage');
  });

  it('falls back to the legacy flag when the explicit answer is absent', () => {
    const legacy = buildCoverageLines({ ...noCoverages(), physical_damage: true });
    expect(legacy.map((line) => line.key)).toContain('physical_damage');
  });

  it('notes a written trailer interchange agreement', () => {
    const [line] = buildCoverageLines({
      ...noCoverages(),
      trailer_interchange_limit: '$50,000',
      trailer_interchange_agreement: true,
    });
    expect(line.detail).toContain('written interchange agreement in place');
  });

  it('keeps the seven coverages in a stable order', () => {
    const lines = buildCoverageLines({
      ...noCoverages(),
      additional_coverages_other: 'Reefer breakdown',
      general_liability_limit: '$1,000,000',
      trailer_interchange_limit: '$50,000',
      cargo_limit: '$100,000',
      physical_damage_requested: true,
      um_uim_limit: '$100,000',
      auto_liability_limit: '$750,000',
    });
    expect(lines.map((line) => line.key)).toEqual([
      'auto_liability', 'um_uim', 'physical_damage',
      'cargo', 'trailer_interchange', 'general_liability', 'other',
    ]);
  });

  it('treats a blank string as absent', () => {
    expect(buildCoverageLines({ ...noCoverages(), auto_liability_limit: '   ' })).toEqual([]);
  });
});

describe('the subject summary and the body cannot disagree', () => {
  it('abbreviates exactly the lines the body lists', () => {
    const coverages = {
      ...noCoverages(),
      auto_liability_limit: '$750,000',
      physical_damage_requested: true,
      cargo_limit: '$100,000',
    };
    const lines = buildCoverageLines(coverages);
    expect(buildCoverageSummary(lines)).toBe('AL / PD / Cargo');

    const body = formatCoverageLines(lines);
    for (const line of lines) {
      expect(body).toContain(line.label);
    }
    expect(body.split('\n')).toHaveLength(lines.length);
  });

  it('does not claim a coverage in the subject that the body omits', () => {
    const { subject, body, coverageLines } = buildSubmissionMessage({
      companyName: 'Miru Transportation LLC',
      carrierName: 'All Star Underwriters',
      senderName: 'Oscar',
      coverages: { ...noCoverages(), cargo_limit: '$100,000' },
    });
    expect(coverageLines).toHaveLength(1);
    expect(subject).toContain('Cargo');
    expect(subject).not.toContain('AL');
    expect(body).not.toContain('Auto Liability');
  });

  it('falls back to a neutral summary when nothing was requested', () => {
    expect(buildCoverageSummary([])).toBe('Insurance');
    expect(formatCoverageLines([])).toBe('To be confirmed.');
  });
});

describe('buildSubmissionMessage', () => {
  it('produces the documented default message', () => {
    const { subject, body } = buildSubmissionMessage({
      companyName: 'Miru Transportation LLC',
      carrierName: 'All Star Underwriters',
      senderName: 'Oscar',
      coverages: {
        ...noCoverages(),
        auto_liability_limit: '$750,000',
        physical_damage_requested: true,
        physical_damage_deductible: '$2,500',
        cargo_limit: '$100,000',
        cargo_deductible: '$2,500',
      },
    });

    expect(subject).toBe('Miru Transportation LLC - AL / PD / Cargo Submission');
    expect(body).toContain('Please find attached the submission for Miru Transportation LLC.');
    expect(body).toContain('Auto Liability: $750,000');
    expect(body).toContain('Motor Truck Cargo: $100,000 / $2,500 deductible');
    expect(body.trimEnd().endsWith('New Hope Insurance Agency')).toBe(true);
  });

  it('uses the market template when one is configured', () => {
    const { subject, body } = buildSubmissionMessage({
      companyName: 'Miru', carrierName: 'Eastern', senderName: 'Oscar',
      coverages: noCoverages(),
      subjectTemplate: 'NEW SUBMISSION — {{company_name}} to {{carrier_name}}',
      bodyTemplate: 'Hi {{carrier_name}} team,\n\n{{coverage_lines}}\n\n{{sender_name}}',
    });
    expect(subject).toBe('NEW SUBMISSION — Miru to Eastern');
    expect(body).toBe('Hi Eastern team,\n\nTo be confirmed.\n\nOscar');
  });

  it('treats a blank market template as absent and uses the default', () => {
    const { subject } = buildSubmissionMessage({
      companyName: 'Miru', carrierName: 'Eastern', senderName: 'Oscar',
      coverages: noCoverages(), subjectTemplate: '   ', bodyTemplate: '',
    });
    expect(subject).toBe(renderTemplate(DEFAULT_SUBJECT_TEMPLATE, {
      company_name: 'Miru', coverage_summary: 'Insurance',
    }));
  });

  it('renders without coverage data at all', () => {
    const { body, unresolved } = buildSubmissionMessage({
      companyName: 'Miru', carrierName: 'Eastern', senderName: 'Oscar', coverages: null,
    });
    expect(body).toContain('To be confirmed.');
    expect(unresolved).toEqual([]);
  });

  it('leaves the default templates free of stray placeholders once rendered', () => {
    expect(findUnresolvedPlaceholders(DEFAULT_SUBJECT_TEMPLATE)).toHaveLength(2);
    expect(findUnresolvedPlaceholders(DEFAULT_BODY_TEMPLATE)).toHaveLength(3);
  });
});

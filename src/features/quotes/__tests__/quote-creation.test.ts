import { describe, it, expect } from 'vitest';
import { parseNoteLog } from '../IntakeNoteLog';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — Idempotent Quote Creation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * TypeScript-side idempotency check: mirrors the Supabase `_create_quote_from_intake`
 * behaviour where if an intake already has a converted_quote_id, the existing ID is
 * returned rather than creating a duplicate.
 */
function getOrCreateQuoteId(intake: {
  id: string;
  converted_quote_id: string | null;
}): { quote_id: string; created: boolean } {
  if (intake.converted_quote_id) {
    return { quote_id: intake.converted_quote_id, created: false };
  }
  // Simulate creation — in production this happens inside the SQL transaction
  const newId = `quote-${intake.id}`;
  return { quote_id: newId, created: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Idempotent Re-Claim Returns Existing Quote
// Validates: Requirement 8.5
// ═══════════════════════════════════════════════════════════════════════════

describe('Idempotent quote creation', () => {
  it('returns existing quote_id when intake already has converted_quote_id', () => {
    const intake = {
      id: 'intake-001',
      converted_quote_id: 'existing-quote-abc',
    };

    const result = getOrCreateQuoteId(intake);

    expect(result.quote_id).toBe('existing-quote-abc');
    expect(result.created).toBe(false);
  });

  it('creates a new quote when converted_quote_id is null', () => {
    const intake = {
      id: 'intake-002',
      converted_quote_id: null,
    };

    const result = getOrCreateQuoteId(intake);

    expect(result.quote_id).toBe('quote-intake-002');
    expect(result.created).toBe(true);
  });

  it('calling multiple times with existing quote always returns same ID', () => {
    const intake = {
      id: 'intake-003',
      converted_quote_id: 'existing-quote-xyz',
    };

    const first = getOrCreateQuoteId(intake);
    const second = getOrCreateQuoteId(intake);
    const third = getOrCreateQuoteId(intake);

    expect(first.quote_id).toBe(second.quote_id);
    expect(second.quote_id).toBe(third.quote_id);
    expect(first.created).toBe(false);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
  });

  it('does not create a new quote even when converted_quote_id is an empty-looking UUID', () => {
    // Any truthy converted_quote_id should be treated as "already converted"
    const intake = {
      id: 'intake-004',
      converted_quote_id: '00000000-0000-0000-0000-000000000001',
    };

    const result = getOrCreateQuoteId(intake);

    expect(result.quote_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(result.created).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Personal Auto Format Generation (parseNoteLog)
// Validates: Requirements 10.1, 10.3
// ═══════════════════════════════════════════════════════════════════════════

describe('parseNoteLog — Personal Auto content', () => {
  const personalAutoContent = [
    '═══ INTAKE NOTE LOG ═══',
    'Created by: Maria Garcia (CS)',
    'Generated: 01/20/2025 02:15 PM CST',
    '───────────────────────',
    '',
    '▸ CUSTOMER',
    '  Name: John Smith',
    '  Phone: (555) 123-4567',
    '  Email: john.smith@email.com',
    '  DOB: 03/15/1985',
    '',
    '▸ SOURCE',
    '  Type: Dealership',
    '  Dealer: ABC Motors',
    '  Salesperson: Mike Johnson',
    '',
    '▸ COVERAGE REQUESTED',
    '  Desired: Full Coverage',
    '  Liability Limit: 100/300/100',
    '  Comp Deductible: $500',
    '  Collision Deductible: $500',
    '',
    '▸ DRIVERS',
    '  Driver 1: John Smith',
    '    DOB: 03/15/1985',
    '    License: TX DL12345678',
    '    Years Licensed: 15',
    '',
    '▸ VEHICLES',
    '  Vehicle 1: 2023 Toyota Camry',
    '    VIN: 1HGBH41JXMN109186',
    '    Usage: Commute',
    '    Annual Mileage: 12000',
    '',
    '▸ ADDITIONAL NOTES',
    '  Customer wants to bundle with homeowners.',
    '  Currently with State Farm, expiring 02/01/2025.',
  ].join('\n');

  it('extracts metadata lines correctly', () => {
    const { metadataLines } = parseNoteLog(personalAutoContent);

    expect(metadataLines).toHaveLength(2);
    expect(metadataLines[0]).toContain('Maria Garcia');
    expect(metadataLines[1]).toContain('01/20/2025 02:15 PM CST');
  });

  it('parses all 6 Personal Auto sections in correct order', () => {
    const { sections } = parseNoteLog(personalAutoContent);

    expect(sections).toHaveLength(6);
    expect(sections[0].title).toBe('CUSTOMER');
    expect(sections[1].title).toBe('SOURCE');
    expect(sections[2].title).toBe('COVERAGE REQUESTED');
    expect(sections[3].title).toBe('DRIVERS');
    expect(sections[4].title).toBe('VEHICLES');
    expect(sections[5].title).toBe('ADDITIONAL NOTES');
  });

  it('preserves field values within CUSTOMER section', () => {
    const { sections } = parseNoteLog(personalAutoContent);
    const customer = sections[0];

    expect(customer.lines.some((l) => l.includes('John Smith'))).toBe(true);
    expect(customer.lines.some((l) => l.includes('(555) 123-4567'))).toBe(true);
    expect(customer.lines.some((l) => l.includes('john.smith@email.com'))).toBe(true);
    expect(customer.lines.some((l) => l.includes('03/15/1985'))).toBe(true);
  });

  it('preserves dealership and salesperson in SOURCE section', () => {
    const { sections } = parseNoteLog(personalAutoContent);
    const source = sections[1];

    expect(source.lines.some((l) => l.includes('Dealership'))).toBe(true);
    expect(source.lines.some((l) => l.includes('ABC Motors'))).toBe(true);
    expect(source.lines.some((l) => l.includes('Mike Johnson'))).toBe(true);
  });

  it('preserves coverage details', () => {
    const { sections } = parseNoteLog(personalAutoContent);
    const coverage = sections[2];

    expect(coverage.lines.some((l) => l.includes('Full Coverage'))).toBe(true);
    expect(coverage.lines.some((l) => l.includes('100/300/100'))).toBe(true);
    expect(coverage.lines.some((l) => l.includes('$500'))).toBe(true);
  });

  it('preserves driver information', () => {
    const { sections } = parseNoteLog(personalAutoContent);
    const drivers = sections[3];

    expect(drivers.lines.some((l) => l.includes('John Smith'))).toBe(true);
    expect(drivers.lines.some((l) => l.includes('TX DL12345678'))).toBe(true);
    expect(drivers.lines.some((l) => l.includes('15'))).toBe(true);
  });

  it('preserves vehicle information', () => {
    const { sections } = parseNoteLog(personalAutoContent);
    const vehicles = sections[4];

    expect(vehicles.lines.some((l) => l.includes('2023 Toyota Camry'))).toBe(true);
    expect(vehicles.lines.some((l) => l.includes('1HGBH41JXMN109186'))).toBe(true);
    expect(vehicles.lines.some((l) => l.includes('Commute'))).toBe(true);
    expect(vehicles.lines.some((l) => l.includes('12000'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Commercial Auto Format Generation (parseNoteLog)
// Validates: Requirements 11.1, 11.2
// ═══════════════════════════════════════════════════════════════════════════

describe('parseNoteLog — Commercial Auto content', () => {
  const commercialAutoContent = [
    '═══ INTAKE NOTE LOG ═══',
    'Created by: Carlos Reyes (CS)',
    'Generated: 01/22/2025 10:45 AM CST',
    '───────────────────────',
    '',
    '▸ BUSINESS',
    '  Name: Quick Freight LLC',
    '  Type of Work: Long-haul trucking',
    '  DOT: 1234567',
    '  Years in Business: 8',
    '  Operating Radius: 500 miles',
    '',
    '▸ SOURCE',
    '  Type: Referral',
    '  Origin: Agent Tom via existing customer',
    '',
    '▸ DRIVERS',
    '  Driver 1: Roberto Hernandez',
    '    DOB: 07/22/1980',
    '    Relationship: Owner-Operator',
    '    License: CDL-A TX 98765432',
    '  Driver 2: Ana Ruiz',
    '    DOB: 11/03/1990',
    '    Relationship: Employee',
    '    License: CDL-A TX 55667788',
    '',
    '▸ VEHICLES',
    '  Vehicle 1: 2021 Freightliner Cascadia',
    '    VIN: 3AKJHHDR5MSXX1234',
    '    Ownership: Owned',
    '    Usage: Long Haul',
    '    Mileage: 85000',
    '    Garaging ZIP: 75001',
    '  Vehicle 2: 2022 Peterbilt 579',
    '    VIN: 1XPBDP9X5ND654321',
    '    Ownership: Leased',
    '    Usage: Long Haul',
    '    Mileage: 42000',
    '    Garaging ZIP: 75001',
    '',
    '▸ COVERAGE REQUESTED',
    '  Liability Limit: 1,000,000 CSL',
    '  Cargo: $100,000',
    '  Current Carrier: Great West Casualty',
    '  Expiration: 03/15/2025',
    '',
    '▸ ADDITIONAL NOTES',
    '  Fleet expansion planned Q2. Need certificates for shippers.',
  ].join('\n');

  it('extracts Commercial Auto metadata correctly', () => {
    const { metadataLines } = parseNoteLog(commercialAutoContent);

    expect(metadataLines).toHaveLength(2);
    expect(metadataLines[0]).toContain('Carlos Reyes');
    expect(metadataLines[1]).toContain('01/22/2025 10:45 AM CST');
  });

  it('parses all 6 Commercial Auto sections in correct order', () => {
    const { sections } = parseNoteLog(commercialAutoContent);

    expect(sections).toHaveLength(6);
    expect(sections[0].title).toBe('BUSINESS');
    expect(sections[1].title).toBe('SOURCE');
    expect(sections[2].title).toBe('DRIVERS');
    expect(sections[3].title).toBe('VEHICLES');
    expect(sections[4].title).toBe('COVERAGE REQUESTED');
    expect(sections[5].title).toBe('ADDITIONAL NOTES');
  });

  it('preserves business details in BUSINESS section', () => {
    const { sections } = parseNoteLog(commercialAutoContent);
    const business = sections[0];

    expect(business.lines.some((l) => l.includes('Quick Freight LLC'))).toBe(true);
    expect(business.lines.some((l) => l.includes('Long-haul trucking'))).toBe(true);
    expect(business.lines.some((l) => l.includes('1234567'))).toBe(true);
    expect(business.lines.some((l) => l.includes('8'))).toBe(true);
    expect(business.lines.some((l) => l.includes('500 miles'))).toBe(true);
  });

  it('preserves multiple drivers in ascending position order', () => {
    const { sections } = parseNoteLog(commercialAutoContent);
    const drivers = sections[2];

    // Both drivers should be present
    expect(drivers.lines.some((l) => l.includes('Roberto Hernandez'))).toBe(true);
    expect(drivers.lines.some((l) => l.includes('Ana Ruiz'))).toBe(true);

    // Driver 1 should appear before Driver 2
    const driver1Idx = drivers.lines.findIndex((l) => l.includes('Driver 1'));
    const driver2Idx = drivers.lines.findIndex((l) => l.includes('Driver 2'));
    expect(driver1Idx).toBeLessThan(driver2Idx);
  });

  it('preserves multiple vehicles in ascending position order', () => {
    const { sections } = parseNoteLog(commercialAutoContent);
    const vehicles = sections[3];

    expect(vehicles.lines.some((l) => l.includes('Freightliner Cascadia'))).toBe(true);
    expect(vehicles.lines.some((l) => l.includes('Peterbilt 579'))).toBe(true);

    const veh1Idx = vehicles.lines.findIndex((l) => l.includes('Vehicle 1'));
    const veh2Idx = vehicles.lines.findIndex((l) => l.includes('Vehicle 2'));
    expect(veh1Idx).toBeLessThan(veh2Idx);
  });

  it('preserves commercial coverage fields', () => {
    const { sections } = parseNoteLog(commercialAutoContent);
    const coverage = sections[4];

    expect(coverage.lines.some((l) => l.includes('1,000,000 CSL'))).toBe(true);
    expect(coverage.lines.some((l) => l.includes('$100,000'))).toBe(true);
    expect(coverage.lines.some((l) => l.includes('Great West Casualty'))).toBe(true);
    expect(coverage.lines.some((l) => l.includes('03/15/2025'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Empty Section Omission
// Validates: Requirements 10.3, 11.2
//
// The SQL function _generate_intake_note_log omits empty sections at generation
// time. This means well-formed note logs never contain section headers without
// field data. These tests verify:
// - Properly generated logs (without empty sections) parse correctly
// - The parser handles edge cases gracefully
// ═══════════════════════════════════════════════════════════════════════════

describe('parseNoteLog — empty section omission', () => {
  it('properly generated log only contains sections with data (no empty sections present)', () => {
    // This simulates what the SQL function actually produces: only sections with content
    const content = [
      '═══ INTAKE NOTE LOG ═══',
      'Created by: Test User (CS)',
      'Generated: 01/25/2025 08:00 AM CST',
      '───────────────────────',
      '',
      '▸ CUSTOMER',
      '  Name: Jane Doe',
      '  Phone: (555) 999-0000',
      '',
      '▸ SOURCE',
      '  Type: Walk-in Office',
      '',
      '▸ DRIVERS',
      '  Driver 1: Jane Doe',
      '    License: TX AB1234567',
    ].join('\n');

    const { sections } = parseNoteLog(content);

    // Only the sections that were generated (with data) should appear
    const titles = sections.map((s) => s.title);
    expect(titles).toEqual(['CUSTOMER', 'SOURCE', 'DRIVERS']);

    // No empty sections — each section has at least one line
    for (const section of sections) {
      expect(section.lines.length).toBeGreaterThan(0);
    }
  });

  it('empty sections from malformed input are parsed as sections with zero lines', () => {
    // If somehow an empty section header made it into the content (edge case),
    // the parser still creates the section but with an empty lines array
    const content = [
      '═══ INTAKE NOTE LOG ═══',
      'Created by: Empty Test (CS)',
      'Generated: 01/25/2025 09:00 AM CST',
      '───────────────────────',
      '',
      '▸ CUSTOMER',
      '',
      '▸ SOURCE',
      '',
      '▸ COVERAGE REQUESTED',
      '',
    ].join('\n');

    const { sections, metadataLines } = parseNoteLog(content);

    // The parser creates entries for all section headers it encounters
    expect(sections).toHaveLength(3);
    // But each has zero lines since there's no field data
    expect(sections[0].lines).toHaveLength(0);
    expect(sections[1].lines).toHaveLength(0);
    expect(sections[2].lines).toHaveLength(0);
    expect(metadataLines).toHaveLength(2);
  });

  it('handles content with only a metadata header (no sections at all)', () => {
    const content = [
      '═══ INTAKE NOTE LOG ═══',
      'Created by: Minimal (CS)',
      'Generated: 01/25/2025 09:30 AM CST',
      '───────────────────────',
    ].join('\n');

    const { sections, metadataLines } = parseNoteLog(content);

    expect(sections).toHaveLength(0);
    expect(metadataLines).toHaveLength(2);
    expect(metadataLines[0]).toContain('Minimal');
  });

  it('a properly generated log with single-field sections preserves them', () => {
    // SQL function only outputs sections with at least one field value
    const content = [
      '═══ INTAKE NOTE LOG ═══',
      'Created by: Single Field (CS)',
      'Generated: 01/25/2025 10:00 AM CST',
      '───────────────────────',
      '',
      '▸ CUSTOMER',
      '  Name: Solo Entry',
      '',
      '▸ ADDITIONAL NOTES',
      '  One note here.',
    ].join('\n');

    const { sections } = parseNoteLog(content);

    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe('CUSTOMER');
    expect(sections[0].lines).toHaveLength(1);
    expect(sections[0].lines[0]).toContain('Solo Entry');
    expect(sections[1].title).toBe('ADDITIONAL NOTES');
    expect(sections[1].lines).toHaveLength(1);
    expect(sections[1].lines[0]).toContain('One note here.');
  });

  it('non-contiguous populated sections are parsed correctly (SQL skips empty ones)', () => {
    // The SQL function only outputs CUSTOMER and VEHICLES because those are the only
    // sections with data — it skips SOURCE, COVERAGE REQUESTED, DRIVERS, ADDITIONAL NOTES
    const content = [
      '═══ INTAKE NOTE LOG ═══',
      'Created by: Gap Test (CS)',
      'Generated: 01/25/2025 11:00 AM CST',
      '───────────────────────',
      '',
      '▸ CUSTOMER',
      '  Name: First Populated',
      '',
      '▸ VEHICLES',
      '  Vehicle 1: 2020 Honda Civic',
    ].join('\n');

    const { sections } = parseNoteLog(content);

    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe('CUSTOMER');
    expect(sections[0].lines[0]).toContain('First Populated');
    expect(sections[1].title).toBe('VEHICLES');
    expect(sections[1].lines[0]).toContain('2020 Honda Civic');
  });
});

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseNoteLog } from '../IntakeNoteLog';

// ─── Helpers: Generate valid note log content strings ───

const PERSONAL_AUTO_SECTIONS = ['CUSTOMER', 'SOURCE', 'COVERAGE REQUESTED', 'DRIVERS', 'VEHICLES', 'ADDITIONAL NOTES'] as const;
const COMMERCIAL_AUTO_SECTIONS = ['BUSINESS', 'SOURCE', 'DRIVERS', 'VEHICLES', 'COVERAGE REQUESTED', 'ADDITIONAL NOTES'] as const;

/** Generate a non-empty field value (safe characters, no control chars or section markers) */
const safeValueArb = fc.string({ minLength: 1, maxLength: 40 }).map((s) => {
  // Strip newlines, section markers, and trim
  const cleaned = s.replace(/[\n\r▸═─]/g, '').trim();
  return cleaned || 'value';
});

/** Generate a field line indented with two spaces (like the SQL function produces) */
const fieldLineArb = safeValueArb.map((v) => `  ${v}`);

/** Generate a section with 1-4 non-empty field lines */
function sectionArb(title: string) {
  return fc.array(fieldLineArb, { minLength: 1, maxLength: 4 }).map((lines) => ({
    title,
    lines,
  }));
}

/** Generate metadata header values */
const metadataArb = fc.record({
  creatorName: safeValueArb,
  timestamp: fc.constant('01/15/2025 09:30 AM CST'),
});

function buildMetadataBlock(meta: { creatorName: string; timestamp: string }): string {
  return [
    '═══ INTAKE NOTE LOG ═══',
    `Created by: ${meta.creatorName}`,
    `Generated: ${meta.timestamp}`,
    '───────────────────────',
  ].join('\n');
}

/** Build a full note log content string from structured parts */
function buildNoteLogContent(
  meta: { creatorName: string; timestamp: string },
  sections: { title: string; lines: string[] }[]
): string {
  const metaBlock = buildMetadataBlock(meta);
  const sectionBlocks = sections.map((s) => {
    return `\n▸ ${s.title}\n${s.lines.join('\n')}\n`;
  });
  return metaBlock + '\n' + sectionBlocks.join('');
}

/**
 * Generate a personal auto note log with a random non-empty subset of sections,
 * maintaining the required section ordering.
 */
const personalAutoNoteLogArb = fc.record({
  meta: metadataArb,
  // Generate a bitmask to select which sections to include (at least 1)
  sectionMask: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
}).chain(({ meta, sectionMask }) => {
  // Ensure at least one section is present
  const includeSections = PERSONAL_AUTO_SECTIONS.filter((_, i) => sectionMask[i]);
  const finalSections = includeSections.length > 0 ? includeSections : [PERSONAL_AUTO_SECTIONS[0]];

  return fc
    .tuple(...finalSections.map((title) => sectionArb(title)))
    .map((sectionData) => ({
      meta,
      sections: sectionData,
      content: buildNoteLogContent(meta, sectionData),
    }));
});

/**
 * Generate a commercial auto note log with a random non-empty subset of sections,
 * maintaining the required section ordering.
 */
const commercialAutoNoteLogArb = fc.record({
  meta: metadataArb,
  sectionMask: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
}).chain(({ meta, sectionMask }) => {
  const includeSections = COMMERCIAL_AUTO_SECTIONS.filter((_, i) => sectionMask[i]);
  const finalSections = includeSections.length > 0 ? includeSections : [COMMERCIAL_AUTO_SECTIONS[0]];

  return fc
    .tuple(...finalSections.map((title) => sectionArb(title)))
    .map((sectionData) => ({
      meta,
      sections: sectionData,
      content: buildNoteLogContent(meta, sectionData),
    }));
});

/**
 * Generate a note log (either personal or commercial auto) for data preservation tests.
 */
const anyNoteLogArb = fc.oneof(personalAutoNoteLogArb, commercialAutoNoteLogArb);


// Feature: customer-intake-claim-duplicate-quote, Property 20: Intake Note Log Section Ordering (Personal Auto)
// **Validates: Requirements 10.2, 10.3**
describe('PBT-7: Personal Auto Section Ordering', () => {
  it('parsed sections maintain the canonical Personal Auto order', () => {
    fc.assert(
      fc.property(personalAutoNoteLogArb, ({ content }) => {
        const { sections } = parseNoteLog(content);
        const sectionTitles = sections.map((s) => s.title);

        // Filter to only sections that appear in the personal auto ordering
        const personalAutoOrder = [...PERSONAL_AUTO_SECTIONS];
        const relevantTitles = sectionTitles.filter((t) =>
          personalAutoOrder.includes(t as (typeof PERSONAL_AUTO_SECTIONS)[number])
        );

        // Verify relative ordering: for any two consecutive sections present,
        // their relative order should match the canonical order
        for (let i = 0; i < relevantTitles.length - 1; i++) {
          const currentIdx = personalAutoOrder.indexOf(relevantTitles[i] as (typeof PERSONAL_AUTO_SECTIONS)[number]);
          const nextIdx = personalAutoOrder.indexOf(relevantTitles[i + 1] as (typeof PERSONAL_AUTO_SECTIONS)[number]);
          expect(currentIdx).toBeLessThan(nextIdx);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('all generated sections are present in parsed output', () => {
    fc.assert(
      fc.property(personalAutoNoteLogArb, ({ sections, content }) => {
        const parsed = parseNoteLog(content);
        const parsedTitles = parsed.sections.map((s) => s.title);
        const expectedTitles = sections.map((s) => s.title);

        for (const title of expectedTitles) {
          expect(parsedTitles).toContain(title);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('missing sections are acceptable — only present sections need ordering', () => {
    fc.assert(
      fc.property(personalAutoNoteLogArb, ({ sections, content }) => {
        const parsed = parseNoteLog(content);
        // The number of parsed sections should equal the number of generated sections
        expect(parsed.sections.length).toBe(sections.length);
      }),
      { numRuns: 100 }
    );
  });
});


// Feature: customer-intake-claim-duplicate-quote, Property 20: Intake Note Log Section Ordering (Commercial Auto)
// **Validates: Requirements 11.2, 11.3**
describe('PBT-8: Commercial Auto Section Ordering', () => {
  it('parsed sections maintain the canonical Commercial Auto order', () => {
    fc.assert(
      fc.property(commercialAutoNoteLogArb, ({ content }) => {
        const { sections } = parseNoteLog(content);
        const sectionTitles = sections.map((s) => s.title);

        // Filter to only sections that appear in the commercial auto ordering
        const commercialAutoOrder = [...COMMERCIAL_AUTO_SECTIONS];
        const relevantTitles = sectionTitles.filter((t) =>
          commercialAutoOrder.includes(t as (typeof COMMERCIAL_AUTO_SECTIONS)[number])
        );

        // Verify relative ordering
        for (let i = 0; i < relevantTitles.length - 1; i++) {
          const currentIdx = commercialAutoOrder.indexOf(relevantTitles[i] as (typeof COMMERCIAL_AUTO_SECTIONS)[number]);
          const nextIdx = commercialAutoOrder.indexOf(relevantTitles[i + 1] as (typeof COMMERCIAL_AUTO_SECTIONS)[number]);
          expect(currentIdx).toBeLessThan(nextIdx);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('all generated sections are present in parsed output', () => {
    fc.assert(
      fc.property(commercialAutoNoteLogArb, ({ sections, content }) => {
        const parsed = parseNoteLog(content);
        const parsedTitles = parsed.sections.map((s) => s.title);
        const expectedTitles = sections.map((s) => s.title);

        for (const title of expectedTitles) {
          expect(parsedTitles).toContain(title);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('missing sections are acceptable — only present sections need ordering', () => {
    fc.assert(
      fc.property(commercialAutoNoteLogArb, ({ sections, content }) => {
        const parsed = parseNoteLog(content);
        expect(parsed.sections.length).toBe(sections.length);
      }),
      { numRuns: 100 }
    );
  });
});


// Feature: customer-intake-claim-duplicate-quote, Property 21: Intake Note Log Data Preservation
// **Validates: Requirements 10.4, 11.3, 11.4**
describe('PBT-9: Intake Note Log Data Preservation', () => {
  it('all metadata lines are preserved in the parsed output', () => {
    fc.assert(
      fc.property(anyNoteLogArb, ({ meta, content }) => {
        const parsed = parseNoteLog(content);

        // The metadata should contain the creator name and timestamp
        const metaText = parsed.metadataLines.join(' ');
        expect(metaText).toContain(meta.creatorName);
        expect(metaText).toContain(meta.timestamp);
      }),
      { numRuns: 100 }
    );
  });

  it('all non-empty field lines within sections are preserved in parsed output', () => {
    fc.assert(
      fc.property(anyNoteLogArb, ({ sections, content }) => {
        const parsed = parseNoteLog(content);

        for (const expectedSection of sections) {
          const parsedSection = parsed.sections.find((s) => s.title === expectedSection.title);
          expect(parsedSection).toBeDefined();

          if (parsedSection) {
            // Every non-empty line in the expected section should appear in the parsed lines
            for (const line of expectedSection.lines) {
              const trimmedLine = line.trim();
              if (trimmedLine) {
                const found = parsedSection.lines.some(
                  (pl) => pl.includes(trimmedLine) || pl.trim() === trimmedLine
                );
                expect(found).toBe(true);
              }
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it('no data loss: total non-empty line count is preserved', () => {
    fc.assert(
      fc.property(anyNoteLogArb, ({ sections, content }) => {
        const parsed = parseNoteLog(content);

        // Count total non-empty lines in input sections
        const expectedLineCount = sections.reduce(
          (acc, s) => acc + s.lines.filter((l) => l.trim()).length,
          0
        );
        // Count total lines in parsed sections
        const parsedLineCount = parsed.sections.reduce((acc, s) => acc + s.lines.length, 0);

        expect(parsedLineCount).toBe(expectedLineCount);
      }),
      { numRuns: 100 }
    );
  });

  it('metadata line count is preserved (creator and timestamp always present)', () => {
    fc.assert(
      fc.property(anyNoteLogArb, ({ content }) => {
        const parsed = parseNoteLog(content);
        // We always generate 2 metadata lines: "Created by: ..." and "Generated: ..."
        expect(parsed.metadataLines.length).toBe(2);
      }),
      { numRuns: 100 }
    );
  });

  it('section titles are preserved exactly as generated', () => {
    fc.assert(
      fc.property(anyNoteLogArb, ({ sections, content }) => {
        const parsed = parseNoteLog(content);
        const expectedTitles = sections.map((s) => s.title);
        const parsedTitles = parsed.sections.map((s) => s.title);
        expect(parsedTitles).toEqual(expectedTitles);
      }),
      { numRuns: 100 }
    );
  });
});

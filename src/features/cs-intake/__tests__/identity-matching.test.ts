import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { identityMatches } from '../validation';
import type { SourceType } from '../../quotes/types';

// Feature: customer-intake-claim-duplicate-quote, Property 2: Case-Insensitive Identity Matching
// **Validates: Requirements 1.3**
describe('PBT-2: Case-Insensitive Identity Matching', () => {
  const allSourceTypes: SourceType[] = [
    'dealership',
    'walk_in_office',
    'whatsapp',
    'ringcentral',
    'customer_service',
    'renewal_requote',
    'existing_customer',
    'referral',
    'other',
  ];

  const sourceTypeArb = fc.constantFrom(...allSourceTypes);
  const lineOfBusinessArb = fc.constantFrom('personal_auto', 'commercial_auto');

  // Generates a non-empty string suitable for customer names
  const customerNameArb = fc.string({ minLength: 1, maxLength: 100 }).filter(
    (s) => s.trim().length > 0
  );

  // Helper to randomize case of a string
  const randomizeCase = (s: string): fc.Arbitrary<string> =>
    fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length }).map((bools) =>
      s
        .split('')
        .map((ch, i) => (bools[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join('')
    );

  it('same values in different cases should match', () => {
    fc.assert(
      fc.property(
        customerNameArb,
        sourceTypeArb,
        lineOfBusinessArb,
        (name, source, lob) => {
          const a = {
            customer_name: name.toLowerCase(),
            source_type: source.toLowerCase(),
            line_of_business: lob.toLowerCase(),
          };
          const b = {
            customer_name: name.toUpperCase(),
            source_type: source.toUpperCase(),
            line_of_business: lob.toUpperCase(),
          };
          expect(identityMatches(a, b)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('randomly mixed case still matches for identical underlying values', () => {
    fc.assert(
      fc.property(
        customerNameArb,
        sourceTypeArb,
        lineOfBusinessArb,
        fc.array(fc.boolean(), { minLength: 150, maxLength: 150 }),
        fc.array(fc.boolean(), { minLength: 150, maxLength: 150 }),
        (name, source, lob, boolsA, boolsB) => {
          const mixCase = (s: string, bools: boolean[]) =>
            s
              .split('')
              .map((ch, i) => (bools[i % bools.length] ? ch.toUpperCase() : ch.toLowerCase()))
              .join('');

          const a = {
            customer_name: mixCase(name, boolsA),
            source_type: mixCase(source, boolsA),
            line_of_business: mixCase(lob, boolsA),
          };
          const b = {
            customer_name: mixCase(name, boolsB),
            source_type: mixCase(source, boolsB),
            line_of_business: mixCase(lob, boolsB),
          };
          expect(identityMatches(a, b)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('different customer_name values should not match', () => {
    fc.assert(
      fc.property(
        customerNameArb,
        customerNameArb,
        sourceTypeArb,
        lineOfBusinessArb,
        (nameA, nameB, source, lob) => {
          // Ensure names are actually different after case normalization and trim
          fc.pre(nameA.trim().toLowerCase() !== nameB.trim().toLowerCase());

          const a = {
            customer_name: nameA,
            source_type: source,
            line_of_business: lob,
          };
          const b = {
            customer_name: nameB,
            source_type: source,
            line_of_business: lob,
          };
          expect(identityMatches(a, b)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('different source_type values should not match', () => {
    fc.assert(
      fc.property(
        customerNameArb,
        sourceTypeArb,
        sourceTypeArb,
        lineOfBusinessArb,
        (name, sourceA, sourceB, lob) => {
          fc.pre(sourceA !== sourceB);

          const a = {
            customer_name: name,
            source_type: sourceA,
            line_of_business: lob,
          };
          const b = {
            customer_name: name,
            source_type: sourceB,
            line_of_business: lob,
          };
          expect(identityMatches(a, b)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('different line_of_business values should not match', () => {
    fc.assert(
      fc.property(
        customerNameArb,
        sourceTypeArb,
        (name, source) => {
          const a = {
            customer_name: name,
            source_type: source,
            line_of_business: 'personal_auto',
          };
          const b = {
            customer_name: name,
            source_type: source,
            line_of_business: 'commercial_auto',
          };
          expect(identityMatches(a, b)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('whitespace trimming should be applied — leading/trailing spaces ignored', () => {
    fc.assert(
      fc.property(
        customerNameArb,
        sourceTypeArb,
        lineOfBusinessArb,
        fc.nat({ max: 5 }),
        fc.nat({ max: 5 }),
        (name, source, lob, leadSpaces, trailSpaces) => {
          const pad = (s: string) =>
            ' '.repeat(leadSpaces) + s + ' '.repeat(trailSpaces);

          const a = {
            customer_name: name.trim(),
            source_type: source,
            line_of_business: lob,
          };
          const b = {
            customer_name: pad(name.trim()),
            source_type: pad(source),
            line_of_business: pad(lob),
          };
          expect(identityMatches(a, b)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('exact match is required — substring or prefix should NOT match', () => {
    fc.assert(
      fc.property(
        customerNameArb.filter((s) => s.trim().length >= 2),
        sourceTypeArb,
        lineOfBusinessArb,
        fc.string({ minLength: 1, maxLength: 5 }).filter((s) => s.trim().length > 0),
        (name, source, lob, suffix) => {
          // "John" should not match "Johnny" — appending extra chars breaks match
          const extended = name.trim() + suffix;
          fc.pre(name.trim().toLowerCase() !== extended.toLowerCase());

          const a = {
            customer_name: name.trim(),
            source_type: source,
            line_of_business: lob,
          };
          const b = {
            customer_name: extended,
            source_type: source,
            line_of_business: lob,
          };
          expect(identityMatches(a, b)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

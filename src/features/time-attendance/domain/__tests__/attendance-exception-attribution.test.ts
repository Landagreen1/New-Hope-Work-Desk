// src/features/time-attendance/domain/__tests__/attendance-exception-attribution.test.ts
// Property test for what an exception on a record claims about itself.
//
// Requirement 3, criterion 13 makes an exception accountable: it has to name the
// rule that produced it and describe that rule in language a person reviewing
// the day can read. So this property checks the two halves of that claim
// against the context the record was derived from — the named rule exists, its
// predicate actually holds, and the description carried on the exception is the
// rule's own and is a sentence rather than an identifier.
//
// Feature: time-attendance-ui-redesign, Property 2: Exception rule attribution
// **Validates: Requirements 3.13**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { EXCEPTION_RULES, buildEvaluationContext, recordFromContext } from '../attendance';
import { attendanceInputsArb } from './arbitraries';

describe('PBT-2: Exception rule attribution', () => {
  it('names a rule that holds for the record and carries the plain-language description of that rule', () => {
    let attributedExceptions = 0;

    fc.assert(
      fc.property(attendanceInputsArb, (inputs) => {
        const ctx = buildEvaluationContext(inputs);
        const record = recordFromContext(ctx);

        for (const exception of record.exceptions) {
          const rule = EXCEPTION_RULES.find((candidate) => candidate.id === exception.ruleId);

          expect(rule).toBeDefined();
          if (rule === undefined) return;

          // The named rule's predicate holds against this record's context.
          expect(rule.holds(ctx)).toBe(true);
          expect(exception.code).toBe(rule.code);

          // A plain-language description, carried from the rule, not a code.
          expect(exception.ruleDescription).toBe(rule.description);
          const words = exception.ruleDescription.trim().split(/\s+/);
          expect(words.length).toBeGreaterThan(3);
          expect(exception.ruleDescription.trim()).not.toBe(exception.ruleId);
        }

        attributedExceptions += record.exceptions.length;
      }),
      { numRuns: 100 },
    );

    // Guard against a vacuous pass: a run in which no record carried an
    // exception would satisfy every clause above without checking anything.
    expect(attributedExceptions).toBeGreaterThan(0);
  });
});

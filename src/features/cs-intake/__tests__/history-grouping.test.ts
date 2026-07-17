import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildGroupedHistoryEvent,
  FieldChange,
  BuildGroupedHistoryEventParams,
} from '../history-helpers';

// Feature: customer-intake-claim-duplicate-quote, Property 4: Edit Produces Grouped History Event
// **Validates: Requirements 2.3, 4.3**
describe('PBT-4: Edit Produces Grouped History Event', () => {
  // Arbitraries for generating realistic field changes
  const fieldNameArb = fc.constantFrom(
    'customer_name',
    'phone',
    'email',
    'source_type',
    'line_of_business',
    'insured_first_name',
    'insured_last_name',
    'addr_street',
    'addr_city',
    'addr_state',
    'addr_zip',
    'business_name',
    'dot_number',
    'desired_coverage',
    'liability_limit',
    'csr_notes',
    'preferred_language',
    'current_carrier'
  );

  const fieldValueArb = fc.oneof(
    fc.string({ minLength: 1, maxLength: 100 }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null)
  );

  const fieldChangeArb: fc.Arbitrary<FieldChange> = fc.record({
    field: fieldNameArb,
    old_value: fieldValueArb,
    new_value: fieldValueArb,
  });

  // Generate 1 to 10 field changes with unique field names
  const uniqueFieldChangesArb = fc
    .uniqueArray(fieldChangeArb, {
      minLength: 1,
      maxLength: 10,
      selector: (c) => c.field,
    });

  const uuidArb = fc.uuid();
  const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 50 }).filter(
    (s) => s.trim().length > 0
  );
  const reasonArb = fc.option(
    fc.string({ minLength: 5, maxLength: 200 }).filter((s) => s.trim().length >= 5),
    { nil: null }
  );

  it('produces exactly ONE history event for N simultaneous field changes', () => {
    fc.assert(
      fc.property(
        uuidArb,
        fc.option(uuidArb, { nil: null }),
        uuidArb,
        nonEmptyStringArb,
        reasonArb,
        uniqueFieldChangesArb,
        (intakeId, linkedQuoteId, actorId, actorDisplayName, reason, changes) => {
          const params: BuildGroupedHistoryEventParams = {
            intakeId,
            linkedQuoteId,
            actorId,
            actorDisplayName,
            reason,
            changes,
          };

          const event = buildGroupedHistoryEvent(params);

          // Exactly one event is produced (the function returns a single event)
          expect(event).toBeDefined();
          expect(event.event_type).toBe('updated');
          // The event is singular — it's one object, not an array
          expect(typeof event.id).toBe('string');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('contains all N changed fields in the changed_fields array', () => {
    fc.assert(
      fc.property(
        uuidArb,
        fc.option(uuidArb, { nil: null }),
        uuidArb,
        nonEmptyStringArb,
        reasonArb,
        uniqueFieldChangesArb,
        (intakeId, linkedQuoteId, actorId, actorDisplayName, reason, changes) => {
          const params: BuildGroupedHistoryEventParams = {
            intakeId,
            linkedQuoteId,
            actorId,
            actorDisplayName,
            reason,
            changes,
          };

          const event = buildGroupedHistoryEvent(params);

          // changed_fields must contain exactly N entries
          expect(event.changed_fields).not.toBeNull();
          expect(event.changed_fields!.length).toBe(changes.length);

          // Every input field change must appear in the output
          const outputFieldNames = event.changed_fields!.map((cf) => cf.field);
          for (const change of changes) {
            expect(outputFieldNames).toContain(change.field);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('each changed field entry has field name, old_value, and new_value', () => {
    fc.assert(
      fc.property(
        uuidArb,
        fc.option(uuidArb, { nil: null }),
        uuidArb,
        nonEmptyStringArb,
        reasonArb,
        uniqueFieldChangesArb,
        (intakeId, linkedQuoteId, actorId, actorDisplayName, reason, changes) => {
          const params: BuildGroupedHistoryEventParams = {
            intakeId,
            linkedQuoteId,
            actorId,
            actorDisplayName,
            reason,
            changes,
          };

          const event = buildGroupedHistoryEvent(params);

          // Each entry must have field, old_value, and new_value keys
          for (const entry of event.changed_fields!) {
            expect(entry).toHaveProperty('field');
            expect(entry).toHaveProperty('old_value');
            expect(entry).toHaveProperty('new_value');
            expect(typeof entry.field).toBe('string');
            expect(entry.field.length).toBeGreaterThan(0);
          }

          // Verify values match the input changes
          for (const change of changes) {
            const match = event.changed_fields!.find((cf) => cf.field === change.field);
            expect(match).toBeDefined();
            expect(match!.old_value).toEqual(change.old_value);
            expect(match!.new_value).toEqual(change.new_value);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('records editor identity (actor_id and actor_display_name)', () => {
    fc.assert(
      fc.property(
        uuidArb,
        fc.option(uuidArb, { nil: null }),
        uuidArb,
        nonEmptyStringArb,
        reasonArb,
        uniqueFieldChangesArb,
        (intakeId, linkedQuoteId, actorId, actorDisplayName, reason, changes) => {
          const params: BuildGroupedHistoryEventParams = {
            intakeId,
            linkedQuoteId,
            actorId,
            actorDisplayName,
            reason,
            changes,
          };

          const event = buildGroupedHistoryEvent(params);

          expect(event.actor_id).toBe(actorId);
          expect(event.actor_display_name).toBe(actorDisplayName);
          expect(event.intake_id).toBe(intakeId);
          expect(event.linked_quote_id).toBe(linkedQuoteId);
          expect(event.reason).toBe(reason);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('includes a timestamp (created_at) as ISO string', () => {
    fc.assert(
      fc.property(
        uuidArb,
        fc.option(uuidArb, { nil: null }),
        uuidArb,
        nonEmptyStringArb,
        reasonArb,
        uniqueFieldChangesArb,
        (intakeId, linkedQuoteId, actorId, actorDisplayName, reason, changes) => {
          const params: BuildGroupedHistoryEventParams = {
            intakeId,
            linkedQuoteId,
            actorId,
            actorDisplayName,
            reason,
            changes,
          };

          const event = buildGroupedHistoryEvent(params);

          expect(event.created_at).toBeDefined();
          // Must be a valid ISO date string
          const parsed = new Date(event.created_at);
          expect(parsed.getTime()).not.toBeNaN();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('throws when changes array is empty', () => {
    fc.assert(
      fc.property(
        uuidArb,
        fc.option(uuidArb, { nil: null }),
        uuidArb,
        nonEmptyStringArb,
        reasonArb,
        (intakeId, linkedQuoteId, actorId, actorDisplayName, reason) => {
          const params: BuildGroupedHistoryEventParams = {
            intakeId,
            linkedQuoteId,
            actorId,
            actorDisplayName,
            reason,
            changes: [],
          };

          expect(() => buildGroupedHistoryEvent(params)).toThrow(
            'Cannot create a history event with no field changes'
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});

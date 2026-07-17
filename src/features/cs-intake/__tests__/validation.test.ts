import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  validateIntakeIdentity,
  canCsUserEdit,
  IntakeIdentityInput,
} from '../validation';
import type { SourceType } from '../../quotes/types';

// Feature: customer-intake-claim-duplicate-quote, Property 1: Intake Validation Rejects Incomplete Identity
// **Validates: Requirements 1.2, 1.5, 1.6**
describe('PBT-1: Intake Validation Rejects Incomplete Identity', () => {
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

  const nonDealershipNonOtherSources: SourceType[] = allSourceTypes.filter(
    (s) => s !== 'dealership' && s !== 'other'
  );

  const sourceTypeArb = fc.constantFrom(...allSourceTypes);
  const nonSpecialSourceArb = fc.constantFrom(...nonDealershipNonOtherSources);
  const lineOfBusinessArb = fc.constantFrom('personal_auto', 'commercial_auto');
  const uuidArb = fc.uuid();
  const nonEmptyStringArb = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);
  const phoneArb = fc.string({ minLength: 3, maxLength: 20 }).filter((s) => s.trim().length > 0);
  const emailArb = fc.string({ minLength: 5, maxLength: 254 }).filter((s) => s.trim().length > 0);

  // Helper: generate a complete valid intake (for non-dealership, non-other sources)
  const completeIntakeArb = fc.record({
    customer_name: nonEmptyStringArb,
    source_type: nonSpecialSourceArb,
    line_of_business: lineOfBusinessArb,
    phone: phoneArb,
    email: emailArb,
    created_by: uuidArb,
  });

  it('rejects when customer_name is missing or whitespace-only', () => {
    const whitespaceOrEmpty = fc.constantFrom('', '   ', '\t', '\n', null, undefined);

    fc.assert(
      fc.property(
        whitespaceOrEmpty,
        nonSpecialSourceArb,
        lineOfBusinessArb,
        phoneArb,
        uuidArb,
        (customerName, sourceType, lob, phone, createdBy) => {
          const intake: IntakeIdentityInput = {
            customer_name: customerName as string | null,
            source_type: sourceType,
            line_of_business: lob,
            phone,
            email: null,
            created_by: createdBy,
          };
          const result = validateIntakeIdentity(intake);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.includes('customer_name'))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects when source_type is missing', () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        lineOfBusinessArb,
        phoneArb,
        uuidArb,
        (customerName, lob, phone, createdBy) => {
          const intake: IntakeIdentityInput = {
            customer_name: customerName,
            source_type: null,
            line_of_business: lob,
            phone,
            email: null,
            created_by: createdBy,
          };
          const result = validateIntakeIdentity(intake);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.includes('source_type'))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects when line_of_business is missing', () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        nonSpecialSourceArb,
        phoneArb,
        uuidArb,
        (customerName, sourceType, phone, createdBy) => {
          const intake: IntakeIdentityInput = {
            customer_name: customerName,
            source_type: sourceType,
            line_of_business: null,
            phone,
            email: null,
            created_by: createdBy,
          };
          const result = validateIntakeIdentity(intake);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.includes('line_of_business'))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects when both phone and email are missing', () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        nonSpecialSourceArb,
        lineOfBusinessArb,
        uuidArb,
        (customerName, sourceType, lob, createdBy) => {
          const intake: IntakeIdentityInput = {
            customer_name: customerName,
            source_type: sourceType,
            line_of_business: lob,
            phone: null,
            email: null,
            created_by: createdBy,
          };
          const result = validateIntakeIdentity(intake);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.includes('phone or email'))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects when created_by (intake creator) is missing', () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        nonSpecialSourceArb,
        lineOfBusinessArb,
        phoneArb,
        (customerName, sourceType, lob, phone) => {
          const intake: IntakeIdentityInput = {
            customer_name: customerName,
            source_type: sourceType,
            line_of_business: lob,
            phone,
            email: null,
            created_by: null,
          };
          const result = validateIntakeIdentity(intake);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.includes('created_by'))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects dealership source without dealer_id or dealer_salesperson_id', () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        lineOfBusinessArb,
        phoneArb,
        uuidArb,
        fc.constantFrom<[string | null, string | null]>(
          [null, null],
          [null, 'some-sp-id'],
          ['some-dealer-id', null]
        ),
        (customerName, lob, phone, createdBy, [dealerId, dealerSpId]) => {
          const intake: IntakeIdentityInput = {
            customer_name: customerName,
            source_type: 'dealership',
            line_of_business: lob,
            phone,
            email: null,
            created_by: createdBy,
            dealer_id: dealerId,
            dealer_salesperson_id: dealerSpId,
          };
          const result = validateIntakeIdentity(intake);
          expect(result.valid).toBe(false);
          expect(
            result.errors.some((e) => e.includes('dealer_id') || e.includes('dealer_salesperson_id'))
          ).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects other source without source_description', () => {
    const emptyDescriptions = fc.constantFrom(null, undefined, '', '   ', '\t');

    fc.assert(
      fc.property(
        nonEmptyStringArb,
        lineOfBusinessArb,
        phoneArb,
        uuidArb,
        emptyDescriptions,
        (customerName, lob, phone, createdBy, desc) => {
          const intake: IntakeIdentityInput = {
            customer_name: customerName,
            source_type: 'other',
            line_of_business: lob,
            phone,
            email: null,
            created_by: createdBy,
            source_description: desc as string | null,
          };
          const result = validateIntakeIdentity(intake);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.includes('source_description'))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('accepts a complete valid intake (non-special source)', () => {
    fc.assert(
      fc.property(completeIntakeArb, (intake) => {
        const result = validateIntakeIdentity(intake);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 }
    );
  });

  it('accepts a valid dealership intake with both dealer fields', () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        lineOfBusinessArb,
        phoneArb,
        uuidArb,
        uuidArb,
        uuidArb,
        (customerName, lob, phone, createdBy, dealerId, dealerSpId) => {
          const intake: IntakeIdentityInput = {
            customer_name: customerName,
            source_type: 'dealership',
            line_of_business: lob,
            phone,
            email: null,
            created_by: createdBy,
            dealer_id: dealerId,
            dealer_salesperson_id: dealerSpId,
          };
          const result = validateIntakeIdentity(intake);
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('accepts a valid other-source intake with source_description', () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        lineOfBusinessArb,
        phoneArb,
        uuidArb,
        nonEmptyStringArb,
        (customerName, lob, phone, createdBy, desc) => {
          const intake: IntakeIdentityInput = {
            customer_name: customerName,
            source_type: 'other',
            line_of_business: lob,
            phone,
            email: null,
            created_by: createdBy,
            source_description: desc,
          };
          const result = validateIntakeIdentity(intake);
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('accepts intake with only email (no phone)', () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        nonSpecialSourceArb,
        lineOfBusinessArb,
        emailArb,
        uuidArb,
        (customerName, sourceType, lob, email, createdBy) => {
          const intake: IntakeIdentityInput = {
            customer_name: customerName,
            source_type: sourceType,
            line_of_business: lob,
            phone: null,
            email,
            created_by: createdBy,
          };
          const result = validateIntakeIdentity(intake);
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: customer-intake-claim-duplicate-quote, Property 3: CS_User Edit Access Control
// **Validates: Requirements 2.1, 2.2, 2.5**
describe('PBT-3: CS_User Edit Access Control', () => {
  const uuidArb = fc.uuid();

  const editableStatuses = [
    'draft',
    'submitted',
    'waiting_for_claim',
    'waiting_for_assignment',
    'claimed',
    'assigned',
    'converted',
  ] as const;

  const nonEditableStatuses = ['deleted'] as const;

  const editableStatusArb = fc.constantFrom(...editableStatuses);
  const nonEditableStatusArb = fc.constantFrom(...nonEditableStatuses);

  it('allows CS_User to edit intakes they created in any editable status', () => {
    fc.assert(
      fc.property(uuidArb, editableStatusArb, (userId, status) => {
        const intake = { created_by: userId, status };
        expect(canCsUserEdit(intake, userId)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('rejects CS_User editing intakes created by another user', () => {
    fc.assert(
      fc.property(
        uuidArb,
        uuidArb.filter((id) => id.length > 0),
        editableStatusArb,
        (userId, otherUserId, status) => {
          // Ensure they are different users
          fc.pre(userId !== otherUserId);
          const intake = { created_by: otherUserId, status };
          expect(canCsUserEdit(intake, userId)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects CS_User editing deleted intakes even if they are the creator', () => {
    fc.assert(
      fc.property(uuidArb, nonEditableStatusArb, (userId, status) => {
        const intake = { created_by: userId, status };
        expect(canCsUserEdit(intake, userId)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('rejects non-creator for all statuses including editable ones', () => {
    const allStatuses = [...editableStatuses, ...nonEditableStatuses];
    const allStatusArb = fc.constantFrom(...allStatuses);

    fc.assert(
      fc.property(uuidArb, uuidArb, allStatusArb, (userId, creatorId, status) => {
        fc.pre(userId !== creatorId);
        const intake = { created_by: creatorId, status };
        expect(canCsUserEdit(intake, userId)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('CS_User cannot permanently delete (canCsUserEdit returns false for deleted status)', () => {
    fc.assert(
      fc.property(uuidArb, (userId) => {
        const intake = { created_by: userId, status: 'deleted' };
        expect(canCsUserEdit(intake, userId)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

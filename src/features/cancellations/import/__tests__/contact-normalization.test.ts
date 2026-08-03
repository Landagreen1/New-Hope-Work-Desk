// src/features/cancellations/import/__tests__/contact-normalization.test.ts
//
// Feature: policy-follow-up-renewals-cancellations, task 10.2 — contact normalization tests
// over the pure module `src/features/cancellations/import/contacts.ts`.
//
// **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.11,
// 10.12, 10.13, 25.2**
//
// The module is pure — no clock, no client, no I/O — so every case here is a direct call.
// No mock is used and none is needed; Requirement 25.3 has nothing to hold against this file.
//
// Beyond the coverage list of task 10.2, these cases pin five decisions that a later change
// could silently reverse while every other test still passed:
//
//  1. a `nan` segment yields **one invalid row**, not zero contacts. Requirement 8.15 scopes
//     the absent-value tokens to `MontoDebido`; Requirement 10 defines no such token for a
//     contact cell, so `nan` carries non-whitespace characters, earns a row (10.1, 10.2),
//     fails matching (10.11 / 10.12), and is retained and counted (10.8);
//  2. dedup **includes invalid rows**, because the database's
//     `unique (case_id, channel, normalized_value)` does not read `validation_status`;
//  3. the cap and the dedup are **per case, not per cell**, composed across source rows
//     through `existingValues`, and on that update path no new row is primary because
//     Requirement 9.8 preserves the primary chosen by the import that created the channel;
//  4. a discarded duplicate **consumes no cap slot**, so the 21st *distinct* segment is the
//     first overflow;
//  5. `segment_index` is the 0-based split position, not the row ordinal, so a skipped
//     whitespace-only segment leaves a gap.

import { describe, expect, it } from 'vitest';

import {
  CONTACT_SEGMENT_SEPARATOR,
  EMAIL_COLUMN,
  IMPORTED_AUTHORIZATION_STATUS,
  MAX_CONTACTS_PER_CASE_PER_CHANNEL,
  MAX_EMAIL_LENGTH,
  MIN_EMAIL_LENGTH,
  PHONE_COLUMN,
  buildCaseContacts,
  buildCaseContactsFromRow,
  buildChannelContacts,
  contactCellsFromRow,
  emailValidationFailures,
  hasNonWhitespace,
  isValidEmailValue,
  isValidPhoneValue,
  normalizeEmailSegment,
  normalizePhoneSegment,
  reducePhoneSegment,
  splitContactCell,
  trimContactSegment,
} from '../contacts';
import type { EmailValidationFailureCode, ImportedContactRow, PhoneForm } from '../contacts';
import {
  AVISOS_COLUMNS,
  EFICACIA_COLUMNS,
  confirmMapping,
  proposeMapping,
  type CancellationColumnSet,
  type ConfirmedMapping,
} from '../mapping';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Joins segments into one cell exactly as a source report writes them. */
function cell(...segments: string[]): string {
  return segments.join(CONTACT_SEGMENT_SEPARATOR);
}

/** The failure codes of a stored email value, in the order the module returned them. */
function codes(value: string): EmailValidationFailureCode[] {
  return emailValidationFailures(value).map((failure) => failure.code);
}

/** `n` distinct ten-digit phone segments. */
function distinctPhones(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_unused, index) => `305555${1000 + offset + index}`);
}

/** The stored E.164 value of `distinctPhones` entry `index`. */
function distinctPhoneValue(index: number, offset = 0): string {
  return `+1305555${1000 + offset + index}`;
}

function confirmedMapping(columnSet: CancellationColumnSet, header: readonly string[]): ConfirmedMapping {
  const result = confirmMapping(proposeMapping(columnSet, header));
  if (!result.confirmed) {
    throw new Error(`mapping not confirmable: ${result.blockReasons.map((reason) => reason.code).join(', ')}`);
  }
  return result.mapping;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('contact constants', () => {
  it('holds the separator, the cap, the imported authorization status, and the email bounds', () => {
    expect(CONTACT_SEGMENT_SEPARATOR).toBe(';');
    expect(MAX_CONTACTS_PER_CASE_PER_CHANNEL).toBe(20);
    expect(IMPORTED_AUTHORIZATION_STATUS).toBe('Unknown');
    expect(PHONE_COLUMN).toBe('Phone');
    expect(EMAIL_COLUMN).toBe('Email');
    expect(MIN_EMAIL_LENGTH).toBe(6);
    expect(MAX_EMAIL_LENGTH).toBe(254);
  });
});

// ---------------------------------------------------------------------------
// Trimming (Req 10.3)
// ---------------------------------------------------------------------------

describe('trimContactSegment (Req 10.3)', () => {
  it('removes leading and trailing space, tab, carriage return, and line feed', () => {
    expect(trimContactSegment(' \t\r\nana@example.com \t\r\n')).toBe('ana@example.com');
    expect(trimContactSegment('   ')).toBe('');
    expect(trimContactSegment('')).toBe('');
  });

  it('leaves interior whitespace untouched', () => {
    expect(trimContactSegment('  (305) 555 0134  ')).toBe('(305) 555 0134');
  });

  const OTHER_WHITESPACE: ReadonlyArray<readonly [string, string]> = [
    ['no-break space', '\u00a0'],
    ['vertical tab', '\u000b'],
    ['form feed', '\f'],
    ['line separator', '\u2028'],
    ['ideographic space', '\u3000'],
  ];

  // Requirement 10.3 names four characters. Anything else is part of the value, so the
  // stored value keeps it and validation judges it — which is the honest outcome for a
  // dirty cell, and the reason this is not `String.prototype.trim`.
  it.each(OTHER_WHITESPACE)('retains a leading and trailing %s that String.trim would remove', (_name, character) => {
    const segment = `${character}ana@example.com${character}`;

    expect(trimContactSegment(segment)).toBe(segment);
    expect(segment.trim()).not.toBe(segment);
  });
});

describe('hasNonWhitespace (Req 10.1, 10.2)', () => {
  it('is false for an empty cell and for whitespace of every kind', () => {
    expect(hasNonWhitespace('')).toBe(false);
    expect(hasNonWhitespace(' \t\r\n')).toBe(false);
    expect(hasNonWhitespace('\u00a0')).toBe(false);
  });

  it('is true as soon as one non-whitespace character is present', () => {
    expect(hasNonWhitespace(' a ')).toBe(true);
    expect(hasNonWhitespace('0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Splitting (Req 10.1, 10.2, 10.3)
// ---------------------------------------------------------------------------

describe('splitContactCell (Req 10.1, 10.2, 10.3)', () => {
  it('yields nothing for an absent, empty, or separator-only cell', () => {
    expect(splitContactCell(null)).toEqual([]);
    expect(splitContactCell(undefined)).toEqual([]);
    expect(splitContactCell('')).toEqual([]);
    expect(splitContactCell(';;')).toEqual([]);
    expect(splitContactCell(' ; \t ; \r\n ')).toEqual([]);
  });

  it('keeps one entry per non-whitespace segment, carrying both the raw and the trimmed text', () => {
    expect(splitContactCell(' (305) 555-0134 ;\tana@example.com\r\n')).toEqual([
      { segmentIndex: 0, rawSegment: ' (305) 555-0134 ', trimmedSegment: '(305) 555-0134' },
      { segmentIndex: 1, rawSegment: '\tana@example.com\r\n', trimmedSegment: 'ana@example.com' },
    ]);
  });

  // `segmentIndex` reports where the segment sat in the imported cell, which is the order
  // Requirement 10.13 reads for primary status and Requirement 10.6 for the dedup winner.
  it('leaves index gaps where whitespace-only segments were skipped', () => {
    expect(splitContactCell('a; ;;b').map((segment) => segment.segmentIndex)).toEqual([0, 3]);
  });
});

// ---------------------------------------------------------------------------
// Phone reduction and the three forms (Req 10.4, 10.11)
// ---------------------------------------------------------------------------

describe('reducePhoneSegment (Req 10.4)', () => {
  const REDUCTIONS: ReadonlyArray<readonly [string, string, string]> = [
    ['punctuation and spaces dropped', '(305) 555-0134', '3055550134'],
    ['a leading plus retained', '+1 (305) 555-0134', '+13055550134'],
    ['a leading plus retained across a following space', '+ 1 305 555 0134', '+13055550134'],
    ['a plus past the first position dropped', '305+555+0134', '3055550134'],
    ['a plus after trimmed whitespace still counts as first', '  +34 911 22 33 44 ', '+34911223344'],
    ['letters dropped', 'call 305-555-0134 x7', '30555501347'],
    ['non-ASCII digits dropped', '\u0663\u0660\u0665', ''],
    ['nothing left of a word-only segment', 'nan', ''],
  ];

  it.each(REDUCTIONS)('reduces with %s', (_name, segment, expected) => {
    expect(reducePhoneSegment(segment)).toBe(expected);
  });
});

describe('normalizePhoneSegment: the three accepted forms (Req 10.4)', () => {
  const FORMS: ReadonlyArray<readonly [string, string, PhoneForm, string]> = [
    ['ten digits and no plus', '(305) 555-0134', 'ten_digit_national', '+13055550134'],
    ['eleven digits beginning with 1 and no plus', '1-786-555-0199', 'eleven_digit_leading_one', '+17865550199'],
    ['a plus and eleven digits', '+34 911 22 33 44', 'plus_prefixed_e164', '+34911223344'],
    ['a plus and fifteen digits', '+123 456 789 012 345', 'plus_prefixed_e164', '+123456789012345'],
  ];

  it.each(FORMS)('stores %s as E.164 and marks it valid', (_name, segment, form, normalizedValue) => {
    const result = normalizePhoneSegment(segment);

    expect(result.form).toBe(form);
    expect(result.normalizedValue).toBe(normalizedValue);
    expect(result.validationStatus).toBe('valid');
    expect(isValidPhoneValue(result.normalizedValue)).toBe(true);
  });

  // The plus-prefixed clause is checked as written: eleven digits behind a plus is the
  // third form, not the second, even when they begin with 1.
  it('reads a plus-prefixed eleven-digit segment as the third form', () => {
    expect(normalizePhoneSegment('+1 305 555 0134')).toEqual({
      reduced: '+13055550134',
      form: 'plus_prefixed_e164',
      normalizedValue: '+13055550134',
      validationStatus: 'valid',
    });
  });

  it('accepts every value the three forms produce and nothing else', () => {
    expect(isValidPhoneValue('+13055550134')).toBe(true);
    expect(isValidPhoneValue('+123456789012345')).toBe(true);
    expect(isValidPhoneValue('3055550134')).toBe(false);
    expect(isValidPhoneValue('+1305555013')).toBe(false);
    expect(isValidPhoneValue('+1234567890123456')).toBe(false);
  });
});

describe('normalizePhoneSegment: no matching form (Req 10.11)', () => {
  // The stored value is the whitespace-trimmed segment unchanged, never the reduced digits,
  // so nothing about the source text is lost on the way into an invalid row.
  const NO_MATCH: ReadonlyArray<readonly [string, string, string]> = [
    ['too few digits', ' 555-0134 ', '555-0134'],
    ['eleven digits not beginning with 1', '2 305 555 0134', '2 305 555 0134'],
    ['a plus and only ten digits', '+1305555013', '+1305555013'],
    ['a plus and sixteen digits', '+1234567890123456', '+1234567890123456'],
    ['free text', '  see attached  ', 'see attached'],
    ['the token nan', 'nan', 'nan'],
    ['non-ASCII digits', '\u0663\u0660\u0665\u0665\u0665\u0665\u0660\u0661\u0663\u0664', '\u0663\u0660\u0665\u0665\u0665\u0665\u0660\u0661\u0663\u0664'],
  ];

  it.each(NO_MATCH)('stores the trimmed segment and marks it invalid: %s', (_name, segment, stored) => {
    const result = normalizePhoneSegment(segment);

    expect(result.form).toBeNull();
    expect(result.normalizedValue).toBe(stored);
    expect(result.validationStatus).toBe('invalid');
  });

  // A no-break space is not one of the four characters Requirement 10.3 removes, but it is
  // also not a digit, so Requirement 10.4 drops it with the rest of the punctuation.
  it('drops a no-break space as a non-digit rather than failing the segment', () => {
    expect(normalizePhoneSegment('\u00a0(305) 555-0134').normalizedValue).toBe('+13055550134');
  });
});

// ---------------------------------------------------------------------------
// Email normalization and the seven clauses (Req 10.5, 10.7, 10.12)
// ---------------------------------------------------------------------------

describe('normalizeEmailSegment (Req 10.3, 10.5)', () => {
  it('trims, then lower-cases every character', () => {
    expect(normalizeEmailSegment(' \tANA.Nu\u00d1ez@Example.COM\r\n')).toEqual({
      normalizedValue: 'ana.nu\u00f1ez@example.com',
      validationStatus: 'valid',
      failures: [],
    });
  });

  it('keeps a value that only interior whitespace spoils, and marks it invalid', () => {
    const result = normalizeEmailSegment(' ana nunez@example.com ');

    expect(result.normalizedValue).toBe('ana nunez@example.com');
    expect(result.validationStatus).toBe('invalid');
    expect(result.failures.map((failure) => failure.code)).toEqual(['contains_whitespace']);
  });

  // Requirement 10.3 lists four characters; a no-break space is not one of them, so it
  // survives trimming and then fails the no-whitespace clause of Requirement 10.7.
  it('retains a leading no-break space and fails the value on it', () => {
    const result = normalizeEmailSegment('\u00a0ana@example.com');

    expect(result.normalizedValue).toBe('\u00a0ana@example.com');
    expect(result.failures.map((failure) => failure.code)).toEqual(['contains_whitespace']);
  });
});

describe('emailValidationFailures: each clause of Requirement 10.7 (Req 10.7, 10.12)', () => {
  // Anchor: the value every single-clause case below is a minimal variation of. Without
  // this, a table asserting "exactly one code" could pass against a validator that had
  // stopped checking something else entirely.
  it('returns nothing for a valid value', () => {
    expect(emailValidationFailures('ana@x.com')).toEqual([]);
    expect(isValidEmailValue('ana@x.com')).toBe(true);
  });

  const SINGLE_CLAUSE: ReadonlyArray<readonly [string, string, EmailValidationFailureCode]> = [
    ['two at signs', 'a@n@x.com', 'at_sign_count_not_one'],
    ['nothing before the at sign', '@x.com', 'no_character_before_at_sign'],
    ['a dot immediately after the at sign', 'ana@.com', 'no_character_between_at_sign_and_first_dot'],
    ['one character after the last dot', 'ana@xx.c', 'fewer_than_two_characters_after_last_dot'],
    ['an interior space', 'a na@x.com', 'contains_whitespace'],
    ['255 characters', `${'a'.repeat(249)}@x.com`, 'length_outside_6_to_254'],
  ];

  it.each(SINGLE_CLAUSE)('fails only the %s clause', (_name, value, code) => {
    expect(codes(value)).toEqual([code]);
    expect(isValidEmailValue(value)).toBe(false);
  });

  // `no_dot_after_at_sign` cannot fail alone: with no dot after the at sign there is also
  // no character between the at sign and a first following dot, so the two clauses fail
  // together. The dot before the at sign keeps the last-dot clause satisfied.
  it('fails the dot-after-at-sign clause together with the character-between clause', () => {
    expect(codes('a.b@com')).toEqual([
      'no_character_between_at_sign_and_first_dot',
      'no_dot_after_at_sign',
    ]);
  });

  it('reports every unmet clause of one value, in requirement order', () => {
    expect(codes('@@ ')).toEqual([
      'at_sign_count_not_one',
      'no_character_before_at_sign',
      'no_character_between_at_sign_and_first_dot',
      'no_dot_after_at_sign',
      'fewer_than_two_characters_after_last_dot',
      'contains_whitespace',
      'length_outside_6_to_254',
    ]);
  });

  it('reports the at-sign-relative clauses for a value carrying no at sign at all', () => {
    expect(codes('ana.com')).toEqual([
      'at_sign_count_not_one',
      'no_character_before_at_sign',
      'no_character_between_at_sign_and_first_dot',
      'no_dot_after_at_sign',
    ]);
  });

  it('names the counted quantity in the message it renders', () => {
    const [atSign] = emailValidationFailures('a@n@x.com');
    const [length] = emailValidationFailures(`${'a'.repeat(249)}@x.com`);

    expect(atSign.message).toContain('2');
    expect(length.message).toContain('255');
  });

  it('accepts the shortest and the longest permitted value and rejects one character past each', () => {
    expect(codes('a@b.co')).toEqual([]);
    expect(codes(`${'a'.repeat(248)}@x.com`)).toEqual([]);
    expect(codes('a@b.c')).toEqual([
      'fewer_than_two_characters_after_last_dot',
      'length_outside_6_to_254',
    ]);
    expect(codes(`${'a'.repeat(249)}@x.com`)).toEqual(['length_outside_6_to_254']);
  });
});

// ---------------------------------------------------------------------------
// One channel of one cell (Req 10.1, 10.2, 10.6, 10.8, 10.9, 10.13)
// ---------------------------------------------------------------------------

describe('buildChannelContacts: one row per segment (Req 10.1, 10.2, 10.9, 10.13)', () => {
  it('creates the full stored row shape for a phone segment', () => {
    const result = buildChannelContacts('phone', ' (305) 555-0134 ');

    const expected: ImportedContactRow = {
      channel: 'phone',
      normalized_value: '+13055550134',
      raw_segment: ' (305) 555-0134 ',
      validation_status: 'valid',
      authorization_status: 'Unknown',
      sms_suppressed: false,
      email_suppressed: false,
      is_primary: true,
      preferred_language: null,
      preferred_channel: null,
      contact_name: null,
      contact_role: null,
      segment_index: 0,
    };
    expect(result.rows).toEqual([expected]);
    expect(result).toMatchObject({
      channel: 'phone',
      invalidCount: 0,
      overflowCount: 0,
      duplicateCount: 0,
      discarded: [],
    });
  });

  it('creates one phone row per segment with primary on the first only', () => {
    const result = buildChannelContacts(
      'phone',
      cell('(305) 555-0134', ' 1 786 555 0199 ', '+34911223344'),
    );

    expect(result.rows.map((row) => row.normalized_value)).toEqual([
      '+13055550134',
      '+17865550199',
      '+34911223344',
    ]);
    expect(result.rows.map((row) => row.is_primary)).toEqual([true, false, false]);
    expect(result.rows.map((row) => row.segment_index)).toEqual([0, 1, 2]);
    expect(result.rows.every((row) => row.validation_status === 'valid')).toBe(true);
  });

  it('creates one email row per segment with primary on the first only', () => {
    const result = buildChannelContacts(
      'email',
      cell('ANA@Example.com', ' bob@Example.COM ', 'carla@example.com'),
    );

    expect(result.rows.map((row) => row.normalized_value)).toEqual([
      'ana@example.com',
      'bob@example.com',
      'carla@example.com',
    ]);
    expect(result.rows.map((row) => row.is_primary)).toEqual([true, false, false]);
    expect(result.rows.map((row) => row.raw_segment)).toEqual([
      'ANA@Example.com',
      ' bob@Example.COM ',
      'carla@example.com',
    ]);
  });

  // `segment_index` is the split position, so the row created from the segment after a
  // whitespace-only one keeps that position rather than its ordinal among the rows.
  it('records the split position of each retained row, gaps included', () => {
    const result = buildChannelContacts('email', cell('ana@example.com', '  ', 'bob@example.com'));

    expect(result.rows.map((row) => row.segment_index)).toEqual([0, 2]);
    expect(result.discarded).toEqual([]);
  });

  it('produces nothing at all from an absent or empty cell', () => {
    for (const empty of [null, undefined, '', ' ; ']) {
      const result = buildChannelContacts('email', empty);

      expect(result.rows).toEqual([]);
      expect(result.invalidCount).toBe(0);
      expect(result.overflowCount).toBe(0);
      expect(result.duplicateCount).toBe(0);
    }
  });
});

describe('buildChannelContacts: invalid rows are retained and counted (Req 10.8, 10.11, 10.12)', () => {
  it('keeps a malformed phone between two valid ones and counts it once', () => {
    const result = buildChannelContacts('phone', cell('(305) 555-0134', ' 555-0134 ', '17865550199'));

    expect(result.rows.map((row) => row.normalized_value)).toEqual([
      '+13055550134',
      '555-0134',
      '+17865550199',
    ]);
    expect(result.rows.map((row) => row.validation_status)).toEqual(['valid', 'invalid', 'valid']);
    expect(result.invalidCount).toBe(1);
    expect(result.discarded).toEqual([]);
  });

  // Requirement 10.13 reads the first *retained* row, and Requirement 10.8 retains invalid
  // rows, so an invalid leading segment is the primary contact of its channel.
  it('gives primary to an invalid first row', () => {
    const result = buildChannelContacts('phone', cell('see attached', '(305) 555-0134'));

    expect(result.rows[0]).toMatchObject({
      normalized_value: 'see attached',
      validation_status: 'invalid',
      is_primary: true,
      authorization_status: 'Unknown',
      sms_suppressed: false,
      email_suppressed: false,
    });
    expect(result.rows[1]).toMatchObject({ normalized_value: '+13055550134', is_primary: false });
  });

  // Requirement 8.15 makes `nan` an absent value for `MontoDebido` only. Requirement 10
  // defines no absent-value token for a contact cell, so a `nan` segment is a row.
  it('treats a nan segment as one invalid row rather than as an absent value', () => {
    const phone = buildChannelContacts('phone', 'nan');
    const email = buildChannelContacts('email', 'NaN');

    expect(phone.rows).toHaveLength(1);
    expect(phone.rows[0]).toMatchObject({ normalized_value: 'nan', validation_status: 'invalid' });
    expect(phone.invalidCount).toBe(1);

    expect(email.rows).toHaveLength(1);
    expect(email.rows[0]).toMatchObject({ normalized_value: 'nan', validation_status: 'invalid' });
    expect(email.invalidCount).toBe(1);
  });
});

describe('buildChannelContacts: dedup keeps the earlier segment (Req 10.6)', () => {
  it('keeps the first of three segments that normalize to the same phone value', () => {
    const result = buildChannelContacts(
      'phone',
      cell('(305) 555-0134', '1-305-555-0134', '+13055550134'),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      normalized_value: '+13055550134',
      raw_segment: '(305) 555-0134',
      segment_index: 0,
      is_primary: true,
    });
    expect(result.duplicateCount).toBe(2);
    expect(result.discarded).toEqual([
      {
        channel: 'phone',
        segmentIndex: 1,
        rawSegment: '1-305-555-0134',
        normalizedValue: '+13055550134',
        reason: 'duplicate_value',
      },
      {
        channel: 'phone',
        segmentIndex: 2,
        rawSegment: '+13055550134',
        normalizedValue: '+13055550134',
        reason: 'duplicate_value',
      },
    ]);
  });

  it('dedups emails only after lower-casing', () => {
    const result = buildChannelContacts('email', cell('ANA@Example.com', 'ana@example.com'));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].raw_segment).toBe('ANA@Example.com');
    expect(result.duplicateCount).toBe(1);
  });

  // `unique (case_id, channel, normalized_value)` does not read `validation_status`, so the
  // dedup here cannot either: two invalid rows holding the same value would violate it.
  it('dedups invalid rows too', () => {
    const result = buildChannelContacts('phone', cell('nan', ' nan ', 'NAN'));

    expect(result.rows.map((row) => row.normalized_value)).toEqual(['nan', 'NAN']);
    expect(result.rows.every((row) => row.validation_status === 'invalid')).toBe(true);
    expect(result.invalidCount).toBe(2);
    expect(result.duplicateCount).toBe(1);
  });
});

describe('buildChannelContacts: the 20-row cap (Req 10.1, 10.2)', () => {
  it('accepts exactly 20 segments with no overflow', () => {
    const result = buildChannelContacts('phone', cell(...distinctPhones(20)));

    expect(result.rows).toHaveLength(MAX_CONTACTS_PER_CASE_PER_CHANNEL);
    expect(result.overflowCount).toBe(0);
    expect(result.duplicateCount).toBe(0);
    expect(result.discarded).toEqual([]);
    expect(result.rows[19].normalized_value).toBe(distinctPhoneValue(19));
    expect(result.rows.filter((row) => row.is_primary)).toHaveLength(1);
  });

  it('counts the 21st segment as overflow and creates no row for it', () => {
    const result = buildChannelContacts('phone', cell(...distinctPhones(21)));

    expect(result.rows).toHaveLength(MAX_CONTACTS_PER_CASE_PER_CHANNEL);
    expect(result.rows.map((row) => row.normalized_value)).not.toContain(distinctPhoneValue(20));
    expect(result.overflowCount).toBe(1);
    expect(result.discarded).toEqual([
      {
        channel: 'phone',
        segmentIndex: 20,
        rawSegment: distinctPhones(21)[20],
        normalizedValue: distinctPhoneValue(20),
        reason: 'channel_cap_reached',
      },
    ]);
  });

  it('counts every segment past the 20th', () => {
    const result = buildChannelContacts('email', cell(...Array.from({ length: 25 }, (_u, i) => `user${i}@example.com`)));

    expect(result.rows).toHaveLength(20);
    expect(result.overflowCount).toBe(5);
    expect(result.rows.every((row) => row.validation_status === 'valid')).toBe(true);
  });

  // A discarded duplicate creates no row, so it consumes no cap slot: this cell holds 21
  // segments but only 20 distinct values, and all 20 are retained.
  it('lets a duplicate consume no cap slot, so the 21st distinct segment is the first overflow', () => {
    const distinct = distinctPhones(20);
    const withEarlyDuplicate = cell(distinct[0], distinct[0], ...distinct.slice(1));

    const retained = buildChannelContacts('phone', withEarlyDuplicate);

    expect(retained.rows).toHaveLength(20);
    expect(retained.duplicateCount).toBe(1);
    expect(retained.overflowCount).toBe(0);
    expect(retained.rows[19]).toMatchObject({
      normalized_value: distinctPhoneValue(19),
      // 21 segments, so the last distinct value sits at split position 20.
      segment_index: 20,
    });

    const overflowing = buildChannelContacts('phone', `${withEarlyDuplicate};${distinctPhones(21)[20]}`);

    expect(overflowing.rows).toHaveLength(20);
    expect(overflowing.duplicateCount).toBe(1);
    expect(overflowing.overflowCount).toBe(1);
    expect(overflowing.discarded.map((segment) => segment.reason)).toEqual([
      'duplicate_value',
      'channel_cap_reached',
    ]);
    expect(overflowing.discarded[1].segmentIndex).toBe(21);
  });
});

describe('buildChannelContacts: cap and dedup are per case, not per cell (Req 9.8, 10.1, 10.2, 10.6)', () => {
  it('dedups a new segment against a value the case already holds', () => {
    const result = buildChannelContacts('phone', cell('(305) 555-0134', '7865550199'), [
      '+13055550134',
    ]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ normalized_value: '+17865550199', segment_index: 1 });
    expect(result.duplicateCount).toBe(1);
    expect(result.discarded[0]).toMatchObject({ reason: 'duplicate_value', segmentIndex: 0 });
  });

  // Requirement 9.8 preserves what the import that created the channel decided, and primary
  // status is part of that, so an update never hands primary to a newly added row.
  it('marks no new row primary when the case already holds rows of that channel', () => {
    const result = buildChannelContacts('phone', cell('7865550199', '3055550200'), ['+13055550134']);

    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.is_primary === false)).toBe(true);
  });

  it('counts a new segment as overflow when the case already holds 20 rows of that channel', () => {
    const existing = Array.from({ length: 20 }, (_unused, index) => distinctPhoneValue(index));

    const result = buildChannelContacts('phone', '3055559999', existing);

    expect(result.rows).toEqual([]);
    expect(result.overflowCount).toBe(1);
    expect(result.discarded[0]).toMatchObject({
      reason: 'channel_cap_reached',
      normalizedValue: '+13055559999',
    });
  });

  it('fills the last free slot and overflows the segment after it', () => {
    const existing = Array.from({ length: 19 }, (_unused, index) => distinctPhoneValue(index));

    const result = buildChannelContacts('phone', cell('3055559998', '3055559999'), existing);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].normalized_value).toBe('+13055559998');
    expect(result.overflowCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Both channels of one source row
// ---------------------------------------------------------------------------

describe('buildCaseContacts (Req 10.1, 10.2, 10.6, 10.8)', () => {
  it('returns the phone rows in cell order before the email rows, each channel with its own primary', () => {
    const result = buildCaseContacts({
      phoneCell: cell('(305) 555-0134', '7865550199'),
      emailCell: cell('ANA@Example.com', 'bob@example.com'),
    });

    expect(result.rows.map((row) => [row.channel, row.normalized_value, row.is_primary])).toEqual([
      ['phone', '+13055550134', true],
      ['phone', '+17865550199', false],
      ['email', 'ana@example.com', true],
      ['email', 'bob@example.com', false],
    ]);
  });

  it('sums the invalid, overflow, and duplicate counts across both channels', () => {
    const result = buildCaseContacts({
      phoneCell: cell(...distinctPhones(21), distinctPhones(1)[0], 'nan'),
      emailCell: cell('ana@example.com', 'ANA@example.com', 'not-an-email'),
    });

    expect(result.phone.rows).toHaveLength(20);
    expect(result.phone.overflowCount).toBe(2);
    expect(result.phone.duplicateCount).toBe(1);
    expect(result.email.rows).toHaveLength(2);
    expect(result.email.invalidCount).toBe(1);
    expect(result.email.duplicateCount).toBe(1);

    expect(result.invalidContactCount).toBe(1);
    expect(result.contactOverflowCount).toBe(2);
    expect(result.duplicateContactCount).toBe(2);
    expect(result.rows).toHaveLength(22);
  });

  // The two channels share no cap, no dedup set, and no primary; a full or dirty phone cell
  // must leave the email rows exactly as they would have been on their own.
  it('keeps the channels independent', () => {
    const emailOnly = buildCaseContacts({ phoneCell: null, emailCell: 'ana@example.com' });
    const withFullPhoneCell = buildCaseContacts({
      phoneCell: cell(...distinctPhones(21)),
      emailCell: 'ana@example.com',
    });

    expect(withFullPhoneCell.email).toEqual(emailOnly.email);
    expect(withFullPhoneCell.email.rows[0].is_primary).toBe(true);
  });

  it('applies existing values per channel', () => {
    const result = buildCaseContacts(
      { phoneCell: '3055550134', emailCell: 'ana@example.com' },
      { phone: ['+13055550134'], email: ['bob@example.com'] },
    );

    expect(result.phone.rows).toEqual([]);
    expect(result.phone.duplicateCount).toBe(1);
    expect(result.email.rows).toHaveLength(1);
    expect(result.email.rows[0].is_primary).toBe(false);
    expect(result.duplicateContactCount).toBe(1);
  });

  it('returns nothing for a row carrying neither cell', () => {
    const result = buildCaseContacts({ phoneCell: null, emailCell: null });

    expect(result.rows).toEqual([]);
    expect(result.invalidContactCount).toBe(0);
    expect(result.contactOverflowCount).toBe(0);
    expect(result.duplicateContactCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reading the two cells through a confirmed mapping
// ---------------------------------------------------------------------------

describe('contactCellsFromRow and buildCaseContactsFromRow', () => {
  const avisosMapping = confirmedMapping('avisos', AVISOS_COLUMNS);
  const eficaciaMapping = confirmedMapping('eficacia', EFICACIA_COLUMNS);

  const avisosRow = [
    'Ana N\u00fa\u00f1ez',
    'BWG63424074',
    'Progressive',
    '07/31/2026',
    '15',
    'Aviso 1',
    'ANA@Example.com;bob@example.com',
    '(305) 555-0134;+13055550134',
    'Asunto',
    'Mensaje',
    'SMS',
  ];

  it('reads the phone and email cells of an avisos row', () => {
    expect(contactCellsFromRow(avisosMapping, avisosRow)).toEqual({
      phoneCell: '(305) 555-0134;+13055550134',
      emailCell: 'ANA@Example.com;bob@example.com',
    });
  });

  it('builds the case contacts of that row', () => {
    const result = buildCaseContactsFromRow(avisosMapping, avisosRow);

    expect(result.rows.map((row) => [row.channel, row.normalized_value])).toEqual([
      ['phone', '+13055550134'],
      ['email', 'ana@example.com'],
      ['email', 'bob@example.com'],
    ]);
    expect(result.duplicateContactCount).toBe(1);
    expect(result.invalidContactCount).toBe(0);
  });

  it('reads an absent cell from a row shorter than the mapped column position', () => {
    expect(contactCellsFromRow(avisosMapping, avisosRow.slice(0, 6))).toEqual({
      phoneCell: null,
      emailCell: null,
    });
    expect(buildCaseContactsFromRow(avisosMapping, avisosRow.slice(0, 6)).rows).toEqual([]);
  });

  // The eficacia column set carries neither column, so every eficacia row contributes zero
  // contacts and the import still completes.
  it('reads both cells as absent under an eficacia mapping', () => {
    const eficaciaRow = EFICACIA_COLUMNS.map((_unused, index) => `value ${index}`);

    expect(contactCellsFromRow(eficaciaMapping, eficaciaRow)).toEqual({
      phoneCell: null,
      emailCell: null,
    });

    const result = buildCaseContactsFromRow(eficaciaMapping, eficaciaRow);

    expect(result.rows).toEqual([]);
    expect(result.invalidContactCount).toBe(0);
    expect(result.contactOverflowCount).toBe(0);
  });

  it('reads a present but empty cell as zero contacts', () => {
    const emptyContacts = [...avisosRow];
    emptyContacts[6] = '';
    emptyContacts[7] = '  ';

    expect(contactCellsFromRow(avisosMapping, emptyContacts)).toEqual({
      phoneCell: '  ',
      emailCell: '',
    });
    expect(buildCaseContactsFromRow(avisosMapping, emptyContacts).rows).toEqual([]);
  });

  it('carries existing case values through the row-level entry point', () => {
    const result = buildCaseContactsFromRow(avisosMapping, avisosRow, {
      email: ['ana@example.com'],
    });

    expect(result.email.rows.map((row) => row.normalized_value)).toEqual(['bob@example.com']);
    expect(result.email.rows[0].is_primary).toBe(false);
    expect(result.phone.rows[0].is_primary).toBe(true);
  });
});

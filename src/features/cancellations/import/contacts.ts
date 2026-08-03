// Cancellation import: Contact_Recipient normalization, validation, dedup, and capping.
//
// Part of step 4/5 of `parse → classify → map → preview → confirm → load`
// (design.md, "Cancellation_Importer — src/features/cancellations/import/"). Given the
// `Phone` and `Email` cells of one accepted row, this module produces the
// `cancellation_contacts` rows that row contributes to its Cancellation_Case, plus the two
// counts the import run records: `invalid_contact_count` and `contact_overflow_count`.
//
// Pure module: no React, no Supabase client, no network, no file system, no clock, no
// randomness. Every input arrives as a parameter and every function is a total transform.
//
// Requirement 10 is the whole contract:
// - 10.1 / 10.2  split the cell on `;`, one row per segment carrying a non-whitespace
//                character, at most 20 rows per case per channel, the segments beyond that
//                maximum counted for the import audit entry
// - 10.3         remove leading and trailing space, tab, CR, and LF from every segment
//                before normalization and before validation
// - 10.4         reduce a phone segment to its digits plus a `+` retained only from the
//                first character position, then the three E.164 forms
// - 10.5         lower-case every character of an email segment
// - 10.6         two rows of the same case and channel holding equal stored values keep the
//                earlier segment and discard the later one
// - 10.7 / 10.12 validation status is `valid` or `invalid`, derived only from that row's own
//                stored value, with the seven email clauses
// - 10.8         an invalid row is retained, counted, and never blocks the case from loading
// - 10.9         the stored column set, absent contact name / role / language / channel kept
//                absent
// - 10.11        a phone segment matching none of the three forms stores the trimmed segment
//                and is marked invalid
// - 10.13        `authorization_status = 'Unknown'`, both suppression flags cleared, primary
//                on the first retained row of that channel in imported cell order
//
// **Storage contract.** Row keys are snake_case and mirror `public.cancellation_contacts`
// (`v1.10.0-cancellation-core-tables.sql`), matching the repository convention for a jsonb
// row payload handed to an import RPC (`NormalizedImportRow` in `renewals/api.ts`). The
// database holds `unique (case_id, channel, normalized_value)`, so the dedup here has to
// agree with it exactly: dedup is per case and channel over the stored value of every row,
// invalid rows included, because the constraint does not read `validation_status`.
//
// **Column names and types** come from `./mapping`, which already declares
// `CancellationColumn` and owns `ConfirmedMapping` / `resolveColumnIndex`; `./classify`
// declares the same members, and nothing here adds a third copy. A caller still holding a
// `ClassifiedImportFile` rather than a confirmed mapping can read the two cells with
// `columnValue(classified, row, 'Phone' | 'Email')` from `./classify` and call
// `buildCaseContacts` directly.
//
// **`nan` and the other absent-value tokens.** Requirement 8.15 makes `nan`, `NaN`, `None`,
// `null`, and `undefined` absent values for `MontoDebido`, and Requirement 14.12 keeps them
// out of rendered output. Requirement 10 defines no such token for a contact cell: a `nan`
// segment carries non-whitespace characters, so 10.1 and 10.2 require a row for it, and it
// then fails phone form matching (10.11) or email validation (10.12) and is retained,
// marked invalid, and counted (10.8). That is what this module does — a `nan` phone or email
// cell yields one invalid contact row, visible in `invalid_contact_count`, excluded from
// every send by 10.10. Changing that needs a change to Requirement 10, not to this file.

import type { CancellationColumn, ConfirmedMapping } from './mapping';
import { resolveColumnIndex } from './mapping';

// ---------------------------------------------------------------------------
// Stored value domain
// ---------------------------------------------------------------------------

/** `cancellation_contacts.channel` (Req 10.9). */
export type ContactChannel = 'phone' | 'email';

/** `cancellation_contacts.validation_status` (Req 10.7). */
export type ContactValidationStatus = 'valid' | 'invalid';

/** `cancellation_contacts.authorization_status`; `Authorized` and `Unknown` permit contact (Req 10.9). */
export type ContactAuthorizationStatus = 'Authorized' | 'Unknown' | 'Not Authorized';

/** `cancellation_contacts.preferred_language` (Req 11.1). Absent is `null`. */
export type ContactPreferredLanguage = 'English' | 'Spanish' | 'Bilingual';

/** The separator both contact cells are split on (Req 10.1, 10.2). */
export const CONTACT_SEGMENT_SEPARATOR = ';';

/** At most this many rows per Cancellation_Case per channel; the rest is overflow (Req 10.1, 10.2). */
export const MAX_CONTACTS_PER_CASE_PER_CHANNEL = 20;

/** Authorization status of every imported row (Req 10.13). */
export const IMPORTED_AUTHORIZATION_STATUS: ContactAuthorizationStatus = 'Unknown';

/** The `avisos` column carrying the phone cell (design.md, source-to-target map). */
export const PHONE_COLUMN: CancellationColumn = 'Phone';

/** The `avisos` column carrying the email cell (design.md, source-to-target map). */
export const EMAIL_COLUMN: CancellationColumn = 'Email';

/**
 * One `cancellation_contacts` insert, minus the columns the database owns (`id`, `case_id`,
 * `created_at`, `updated_at`). Keys match the column names so the loader passes this through
 * to `cancellation_import_batch` without translation.
 *
 * `normalized_value` is the stored value: the E.164 phone, the lower-cased email, or — for a
 * phone segment matching none of the three forms — the trimmed segment unchanged (Req 10.11).
 * `raw_segment` is the segment exactly as it appeared in the cell, untrimmed, so the source
 * text survives even when normalization rewrote it.
 *
 * `contact_name`, `contact_role`, `preferred_language`, and `preferred_channel` are always
 * absent on import: neither report format carries them (Req 10.9). They are edited later.
 */
export interface ImportedContactRow {
  channel: ContactChannel;
  normalized_value: string;
  raw_segment: string;
  validation_status: ContactValidationStatus;
  authorization_status: ContactAuthorizationStatus;
  sms_suppressed: boolean;
  email_suppressed: boolean;
  is_primary: boolean;
  preferred_language: ContactPreferredLanguage | null;
  preferred_channel: ContactChannel | null;
  contact_name: string | null;
  contact_role: string | null;
  segment_index: number;
}

// ---------------------------------------------------------------------------
// Segment splitting (Req 10.1, 10.2, 10.3)
// ---------------------------------------------------------------------------

/** One kept segment of a contact cell. */
export interface ContactSegment {
  /**
   * Zero-based position of the segment in the split cell, kept as `segment_index`. Positions
   * of skipped whitespace-only segments are left as gaps, so the index always reports where
   * the segment sat in the imported cell, which is the order Requirement 10.13 reads for
   * primary status and Requirement 10.6 reads for the dedup winner.
   */
  segmentIndex: number;
  /** The segment exactly as split, untrimmed. */
  rawSegment: string;
  /** `rawSegment` with leading and trailing space, tab, CR, and LF removed (Req 10.3). */
  trimmedSegment: string;
}

const CONTACT_TRIM_CHARACTERS = new Set([' ', '\t', '\r', '\n']);

/**
 * Removes leading and trailing space, tab, carriage return, and line feed characters, and
 * nothing else (Req 10.3). Deliberately not `String.prototype.trim`, which also removes
 * other Unicode whitespace; a segment carrying such a character keeps it in the stored value
 * and fails validation, which is the honest outcome for a dirty cell.
 */
export function trimContactSegment(segment: string): string {
  let start = 0;
  let end = segment.length;
  while (start < end && CONTACT_TRIM_CHARACTERS.has(segment.charAt(start))) start += 1;
  while (end > start && CONTACT_TRIM_CHARACTERS.has(segment.charAt(end - 1))) end -= 1;
  return segment.slice(start, end);
}

/** True when `value` carries at least one non-whitespace character (Req 10.1, 10.2). */
export function hasNonWhitespace(value: string): boolean {
  return /\S/.test(value);
}

/**
 * Splits a contact cell on `;` and returns one entry per segment carrying at least one
 * non-whitespace character, in imported cell order (Req 10.1, 10.2, 10.3).
 *
 * An absent cell — an unmapped column, a row shorter than that column position, or `null` —
 * yields zero segments. So does an empty cell and a cell holding only separators.
 */
export function splitContactCell(cell: string | null | undefined): ContactSegment[] {
  if (cell === null || cell === undefined) return [];
  const segments: ContactSegment[] = [];
  const parts = cell.split(CONTACT_SEGMENT_SEPARATOR);
  for (let segmentIndex = 0; segmentIndex < parts.length; segmentIndex += 1) {
    const rawSegment = parts[segmentIndex];
    if (!hasNonWhitespace(rawSegment)) continue;
    segments.push({ segmentIndex, rawSegment, trimmedSegment: trimContactSegment(rawSegment) });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Phone normalization (Req 10.4, 10.11)
// ---------------------------------------------------------------------------

/** Which of the three forms of Requirement 10.4 a reduced phone segment matched. */
export type PhoneForm = 'ten_digit_national' | 'eleven_digit_leading_one' | 'plus_prefixed_e164';

/** The result of normalizing one phone segment. */
export interface PhoneNormalization {
  /** Digits of the trimmed segment, prefixed with `+` only when the segment began with one. */
  reduced: string;
  /** The matched form, `null` when the reduced segment matched none of the three (Req 10.11). */
  form: PhoneForm | null;
  /** The value stored in `normalized_value`. */
  normalizedValue: string;
  validationStatus: ContactValidationStatus;
}

const TEN_DIGITS = /^\d{10}$/;
const ELEVEN_DIGITS_LEADING_ONE = /^1\d{10}$/;
const PLUS_PREFIXED_E164 = /^\+\d{11,15}$/;
const NON_DIGIT = /\D/g;

/**
 * Reduces a phone segment to the digits it contains together with a plus sign retained only
 * from the first character position (Req 10.4). The segment is trimmed first (Req 10.3), so
 * "first character position" means the first character of the trimmed segment; a plus sign
 * anywhere else is dropped with every other non-digit.
 *
 * "Digits" means the ASCII digits `0`–`9`. A non-ASCII digit is dropped like any other
 * non-digit character, which leaves the reduced segment matching no form, so the row stores
 * the trimmed segment and is marked invalid rather than silently losing a character.
 */
export function reducePhoneSegment(segment: string): string {
  const trimmed = trimContactSegment(segment);
  const digits = trimmed.replace(NON_DIGIT, '');
  return trimmed.charAt(0) === '+' ? `+${digits}` : digits;
}

/**
 * True for a stored phone value that satisfies Requirement 10.4, that is `+` followed by 11
 * to 15 digits. All three accepted forms produce such a value: ten digits become `+1` plus
 * those ten, eleven digits beginning with `1` become `+` plus those eleven, and a
 * `+`-prefixed 11-to-15-digit segment is already in that shape. So a phone row's validation
 * status is derived only from its own stored value, as Requirement 10.7 demands.
 */
export function isValidPhoneValue(value: string): boolean {
  return PLUS_PREFIXED_E164.test(value);
}

/**
 * Normalizes one phone segment (Req 10.4, 10.11).
 *
 * Exactly ten digits and no plus sign becomes `+1` followed by those ten digits. Exactly
 * eleven digits beginning with `1` and no plus sign becomes `+` followed by those eleven
 * digits. A plus sign followed by 11 to 15 digits is stored unchanged. Any other reduced
 * shape — too few digits, too many, a plus sign with the wrong digit count, letters only —
 * stores the whitespace-trimmed segment unchanged and is marked invalid; the case still
 * loads (Req 10.8, 10.11).
 */
export function normalizePhoneSegment(segment: string): PhoneNormalization {
  const trimmed = trimContactSegment(segment);
  const reduced = reducePhoneSegment(trimmed);

  if (TEN_DIGITS.test(reduced)) {
    return { reduced, form: 'ten_digit_national', normalizedValue: `+1${reduced}`, validationStatus: 'valid' };
  }
  if (ELEVEN_DIGITS_LEADING_ONE.test(reduced)) {
    return { reduced, form: 'eleven_digit_leading_one', normalizedValue: `+${reduced}`, validationStatus: 'valid' };
  }
  if (PLUS_PREFIXED_E164.test(reduced)) {
    return { reduced, form: 'plus_prefixed_e164', normalizedValue: reduced, validationStatus: 'valid' };
  }
  return { reduced, form: null, normalizedValue: trimmed, validationStatus: 'invalid' };
}

// ---------------------------------------------------------------------------
// Email normalization (Req 10.5, 10.7, 10.12)
// ---------------------------------------------------------------------------

/** The seven clauses of Requirement 10.7, one code each. */
export type EmailValidationFailureCode =
  | 'at_sign_count_not_one'
  | 'no_character_before_at_sign'
  | 'no_character_between_at_sign_and_first_dot'
  | 'no_dot_after_at_sign'
  | 'fewer_than_two_characters_after_last_dot'
  | 'contains_whitespace'
  | 'length_outside_6_to_254';

/** One unmet clause of Requirement 10.7, with a sentence the import wizard can render. */
export interface EmailValidationFailure {
  code: EmailValidationFailureCode;
  message: string;
}

/** Shortest and longest accepted stored email value (Req 10.7). */
export const MIN_EMAIL_LENGTH = 6;
export const MAX_EMAIL_LENGTH = 254;

const WHITESPACE = /\s/;

const AT_SIGN = '@';
const DOT = '.';

/**
 * Every clause of Requirement 10.7 that a stored email value fails, in the order the
 * requirement lists them. An empty array means the value is valid.
 *
 * Each clause is evaluated independently against the whole stored value, so one malformed
 * value reports every clause it breaks rather than stopping at the first. A value carrying no
 * at sign fails the clauses defined relative to the at sign, and a value carrying no dot
 * fails the clauses defined relative to a dot: those conditions cannot be met without the
 * character they are measured from.
 */
export function emailValidationFailures(value: string): EmailValidationFailure[] {
  const failures: EmailValidationFailure[] = [];
  const add = (code: EmailValidationFailureCode, message: string) => failures.push({ code, message });

  const atSignCount = countOccurrences(value, AT_SIGN);
  const firstAtSign = value.indexOf(AT_SIGN);
  const firstDotAfterAtSign = firstAtSign < 0 ? -1 : value.indexOf(DOT, firstAtSign + 1);
  const lastDot = value.lastIndexOf(DOT);

  if (atSignCount !== 1) {
    add('at_sign_count_not_one', `An email address must contain exactly one "@"; this one contains ${atSignCount}.`);
  }
  if (firstAtSign < 1) {
    add('no_character_before_at_sign', 'An email address must contain at least one character before the "@".');
  }
  if (firstDotAfterAtSign < 0 || firstDotAfterAtSign - firstAtSign < 2) {
    add(
      'no_character_between_at_sign_and_first_dot',
      'An email address must contain at least one character between the "@" and the first dot after it.',
    );
  }
  if (firstDotAfterAtSign < 0) {
    add('no_dot_after_at_sign', 'An email address must contain at least one dot after the "@".');
  }
  if (lastDot < 0 || value.length - lastDot - 1 < 2) {
    add(
      'fewer_than_two_characters_after_last_dot',
      'An email address must contain at least two characters after its last dot.',
    );
  }
  if (WHITESPACE.test(value)) {
    add('contains_whitespace', 'An email address must contain no whitespace character.');
  }
  if (value.length < MIN_EMAIL_LENGTH || value.length > MAX_EMAIL_LENGTH) {
    add(
      'length_outside_6_to_254',
      `An email address must be ${MIN_EMAIL_LENGTH} to ${MAX_EMAIL_LENGTH} characters; this one is ${value.length}.`,
    );
  }

  return failures;
}

/** True only for a stored email value meeting every clause of Requirement 10.7. */
export function isValidEmailValue(value: string): boolean {
  return emailValidationFailures(value).length === 0;
}

/** The result of normalizing one email segment. */
export interface EmailNormalization {
  /** The value stored in `normalized_value`: the trimmed segment, lower-cased (Req 10.3, 10.5). */
  normalizedValue: string;
  validationStatus: ContactValidationStatus;
  /** Every unmet clause of Requirement 10.7; empty when the value is valid. */
  failures: EmailValidationFailure[];
}

/**
 * Normalizes one email segment: trim, then lower-case every character, then validate the
 * stored value against the seven clauses (Req 10.3, 10.5, 10.7, 10.12). A failing value is
 * still stored and still retained; only its validation status changes (Req 10.8).
 *
 * `toLowerCase` rather than `toLocaleLowerCase` keeps the stored value independent of the
 * runtime locale, matching the header folding in `./classify` and `./mapping`.
 */
export function normalizeEmailSegment(segment: string): EmailNormalization {
  const normalizedValue = trimContactSegment(segment).toLowerCase();
  const failures = emailValidationFailures(normalizedValue);
  return {
    normalizedValue,
    validationStatus: failures.length === 0 ? 'valid' : 'invalid',
    failures,
  };
}

// ---------------------------------------------------------------------------
// Building the rows of one case
// ---------------------------------------------------------------------------

/** Why a segment produced no row. */
export type DiscardedSegmentReason = 'duplicate_value' | 'channel_cap_reached';

/** One segment that produced no row, kept so the preview and the audit entry can name it. */
export interface DiscardedContactSegment {
  channel: ContactChannel;
  segmentIndex: number;
  rawSegment: string;
  /** The stored value the segment normalized to, before it was discarded. */
  normalizedValue: string;
  reason: DiscardedSegmentReason;
}

/** The rows and counts one channel of one row contributes. */
export interface ChannelContactBuildResult {
  channel: ContactChannel;
  /** The retained rows, in imported cell order, at most `MAX_CONTACTS_PER_CASE_PER_CHANNEL`. */
  rows: ImportedContactRow[];
  /** Retained rows whose validation status is `invalid` (Req 10.8). */
  invalidCount: number;
  /** Segments beyond the 20-row maximum for this case and channel (Req 10.1, 10.2). */
  overflowCount: number;
  /** Segments discarded because an earlier segment already held the same stored value (Req 10.6). */
  duplicateCount: number;
  /** Every discarded segment, in imported cell order. */
  discarded: DiscardedContactSegment[];
}

/**
 * Stored values the Cancellation_Case already holds, per channel, when a row updates an
 * existing case (Req 9.8). They are counted against the 20-row cap and deduped against,
 * because the cap and `unique (case_id, channel, normalized_value)` are both per case, not
 * per cell. Leave absent for a case being created.
 */
export interface ExistingContactValues {
  phone?: readonly string[];
  email?: readonly string[];
}

/** The rows and counts one accepted source row contributes to its Cancellation_Case. */
export interface CaseContactBuildResult {
  /** Every retained row: the phone rows in cell order, then the email rows in cell order. */
  rows: ImportedContactRow[];
  /** `cancellation_import_runs.invalid_contact_count` for this row (Req 10.8). */
  invalidContactCount: number;
  /** `cancellation_import_runs.contact_overflow_count` for this row (Req 10.1, 10.2). */
  contactOverflowCount: number;
  /** Segments discarded as duplicates across both channels (Req 10.6). */
  duplicateContactCount: number;
  phone: ChannelContactBuildResult;
  email: ChannelContactBuildResult;
}

/** The two contact cells of one source row. An absent column or short row gives `null`. */
export interface ContactCells {
  phoneCell: string | null;
  emailCell: string | null;
}

/**
 * Builds the rows one channel of one cell contributes (Req 10.1–10.13).
 *
 * Segments are walked in imported cell order. A segment with no non-whitespace character is
 * skipped. A segment whose stored value equals one already retained for this case and
 * channel is discarded, keeping the earlier segment (Req 10.6) — invalid rows included,
 * because `unique (case_id, channel, normalized_value)` does not read `validation_status`.
 * A segment carrying a new value once the case already holds 20 rows of this channel is
 * counted as overflow and creates nothing (Req 10.1, 10.2); a discarded duplicate consumes
 * no cap, since it creates no row.
 *
 * Every created row carries `authorization_status = 'Unknown'` and both suppression flags
 * cleared, and the first retained row of the channel is primary (Req 10.13). Where the case
 * already holds rows of this channel, no row created here is primary: that channel's primary
 * was chosen by the import that created it and Requirement 9.8 preserves it.
 */
export function buildChannelContacts(
  channel: ContactChannel,
  cell: string | null | undefined,
  existingValues: readonly string[] = [],
): ChannelContactBuildResult {
  const rows: ImportedContactRow[] = [];
  const discarded: DiscardedContactSegment[] = [];
  const heldValues = new Set<string>(existingValues);
  const hadExistingRows = heldValues.size > 0;
  let invalidCount = 0;
  let overflowCount = 0;
  let duplicateCount = 0;

  for (const segment of splitContactCell(cell)) {
    const { normalizedValue, validationStatus } =
      channel === 'phone'
        ? normalizePhoneSegment(segment.trimmedSegment)
        : normalizeEmailSegment(segment.trimmedSegment);

    if (heldValues.has(normalizedValue)) {
      duplicateCount += 1;
      discarded.push({
        channel,
        segmentIndex: segment.segmentIndex,
        rawSegment: segment.rawSegment,
        normalizedValue,
        reason: 'duplicate_value',
      });
      continue;
    }

    if (heldValues.size >= MAX_CONTACTS_PER_CASE_PER_CHANNEL) {
      overflowCount += 1;
      discarded.push({
        channel,
        segmentIndex: segment.segmentIndex,
        rawSegment: segment.rawSegment,
        normalizedValue,
        reason: 'channel_cap_reached',
      });
      continue;
    }

    heldValues.add(normalizedValue);
    if (validationStatus === 'invalid') invalidCount += 1;
    rows.push({
      channel,
      normalized_value: normalizedValue,
      raw_segment: segment.rawSegment,
      validation_status: validationStatus,
      authorization_status: IMPORTED_AUTHORIZATION_STATUS,
      sms_suppressed: false,
      email_suppressed: false,
      is_primary: !hadExistingRows && rows.length === 0,
      preferred_language: null,
      preferred_channel: null,
      contact_name: null,
      contact_role: null,
      segment_index: segment.segmentIndex,
    });
  }

  return { channel, rows, invalidCount, overflowCount, duplicateCount, discarded };
}

/**
 * Builds every Contact_Recipient row one accepted source row contributes, from its phone cell
 * and its email cell (Req 10.1–10.13). The two channels are independent: a cap, a duplicate,
 * or an invalid value on one never affects the other, and the counts are summed for the
 * import run.
 */
export function buildCaseContacts(
  cells: ContactCells,
  existingValues: ExistingContactValues = {},
): CaseContactBuildResult {
  const phone = buildChannelContacts('phone', cells.phoneCell, existingValues.phone ?? []);
  const email = buildChannelContacts('email', cells.emailCell, existingValues.email ?? []);
  return {
    rows: [...phone.rows, ...email.rows],
    invalidContactCount: phone.invalidCount + email.invalidCount,
    contactOverflowCount: phone.overflowCount + email.overflowCount,
    duplicateContactCount: phone.duplicateCount + email.duplicateCount,
    phone,
    email,
  };
}

// ---------------------------------------------------------------------------
// Reading the two cells of a mapped row
// ---------------------------------------------------------------------------

/**
 * The phone and email cells of one source row under a confirmed mapping.
 *
 * `null` means an absent cell: the column is unmapped — which is every `eficacia` file, since
 * that format carries neither column — or the row holds fewer fields than that column
 * position. An empty string is a present, empty cell; both yield zero contacts.
 */
export function contactCellsFromRow(mapping: ConfirmedMapping, row: readonly string[]): ContactCells {
  return {
    phoneCell: cellValue(mapping, row, PHONE_COLUMN),
    emailCell: cellValue(mapping, row, EMAIL_COLUMN),
  };
}

/** `buildCaseContacts` over the cells a confirmed mapping reads from one source row. */
export function buildCaseContactsFromRow(
  mapping: ConfirmedMapping,
  row: readonly string[],
  existingValues: ExistingContactValues = {},
): CaseContactBuildResult {
  return buildCaseContacts(contactCellsFromRow(mapping, row), existingValues);
}

function cellValue(mapping: ConfirmedMapping, row: readonly string[], column: CancellationColumn): string | null {
  const index = resolveColumnIndex(mapping, column);
  if (index === null || index >= row.length) return null;
  return row[index] ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Occurrences of a single character in `value`. */
function countOccurrences(value: string, character: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charAt(index) === character) count += 1;
  }
  return count;
}

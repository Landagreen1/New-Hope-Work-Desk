// Cancellation Message_Renderer: one stored template version plus one or more Cancellation_Case
// rows in, one rendered subject and one rendered body out.
//
// Requirement 11 is the contract for language, Requirement 13 for combined multi-policy messages,
// Requirement 14 for content:
// - 11.2 / 11.3   render language resolves only from the `preferred_language` of the
//                 Contact_Recipient rows included in the message, defaulting to Bilingual for an
//                 absent, empty, whitespace-only, or unrecognized value
// - 11.6 / 11.7   exactly one segment for English, exactly one for Spanish, exactly two for
//                 Bilingual with English first and exactly one separator between the two body
//                 segments; each segment carries the cancellation statement, the included
//                 cancellation effective dates, and the contact request
// - 11.8          a combined message is always Bilingual, whatever the included contacts prefer
// - 13.2 / 13.3   a combined email lists every policy number with its effective date ordered by
//                 date then policy number and states the count; a combined SMS states the count
//                 and the earliest effective date only, carries no policy number, and is at most
//                 640 characters
// - 13.7          a combined message renders from the template version of the touchpoint with the
//                 fewest days remaining among the included cases
// - 14.1 / 14.4   Agency_Name (exact literal) and Office_Phone (digit sequence, after the body has
//                 spaces, hyphens, parentheses, periods, and plus signs removed) in every body
// - 14.2 / 14.5   the stored cancellation statement and the stored contact request in every body,
//                 the contact deadline being the earliest included cancellation effective date
// - 14.3 / 14.6   every included effective date as day, month, and four-digit year, in both
//                 languages for a Bilingual body, except in a combined SMS
// - 14.11         a value absent from the case, the contact, or the assigned employee renders the
//                 stored `fallback_text` for that token, and zero characters where none is stored
// - 14.13 / 14.14 the sender name is the assigned employee display name where the employee is
//                 present, active, not marked deleted, and non-blank, otherwise Agency_Name
// - 14.15         the rendered subject is zero characters on the SMS channel
//
// **Pure module.** No React, no Supabase client, no network, no file system, no clock, no
// randomness. Every template row, case row, contact row, and settings value arrives as a
// parameter, and nothing here reads the current time: every date rendered comes off a case row, so
// two calls with the same input always produce the same characters. That is what lets Property 3
// (task 12.3) drive this function with generated worlds, and what lets a stored
// Communication_Record be re-rendered later and compared character for character.
//
// ---------------------------------------------------------------------------------------------
// TOKEN DELIMITER — THE DECISION, TAKEN HERE AND STATED ONCE
// ---------------------------------------------------------------------------------------------
// Neither the design nor Requirement 14 states the delimiter a token wears inside subject and body
// text. `{{Office_Phone}}`, `{Office_Phone}`, `[Office_Phone]`, and `%Office_Phone%` were all
// consistent with the spec as written, and `v1.10.1-cancellation-templates.sql` deliberately added
// no constraint mentioning any of them, leaving the choice to this file and to the seed of task
// 7.10.
//
//   **The delimiter is `{{` … `}}`** — `{{Office_Phone}}`, `{{Amount_Due}}`, `{{Producer_Name}}`.
//
// Why this one:
// - A doubled brace pair is the most widely recognized template delimiter, so a manager editing a
//   template body in the drawer is unlikely to be surprised by it.
// - It is the form least likely to appear by accident in English or Spanish insurance prose. A
//   single `{` occurs in pasted JSON, `[1]` occurs in citations and footnotes, and `%` occurs in
//   any sentence naming a percentage; a doubled brace pair occurs in none of those.
// - It survives the trip through an SMS body and an email body unchanged: nothing in
//   `src/lib/ringcentral-sms.ts` or `src/lib/email.ts` escapes or percent-encodes braces, whereas
//   `%Office_Phone%` collides with percent-encoding in any URL a body ever carries.
// - Opening and closing markers differ, so a body carrying one stray `{{` cannot silently swallow
//   the rest of the text the way a single `%` sentinel can.
//
// The delimiter lives in exactly one place, the exported `TOKEN_DELIMITER` constant, and the
// exported `tokenPlaceholder()` builds every placeholder from it. The v1.10.9 seed of task 7.10
// must use `tokenPlaceholder(name)` — that is, `{{Name}}` — inside `subject`, `body`,
// `cancellation_statement`, and `contact_request`, and must keep `fallback_text` keyed by BARE
// token names with no delimiter (`Office_Phone`, not `{{Office_Phone}}`), which is how
// `v1.10.1-cancellation-templates.sql` documents reading them and how this file looks them up.
//
// ---------------------------------------------------------------------------------------------
// THE CONTENT GATE SEAM (task 12.2)
// ---------------------------------------------------------------------------------------------
// Requirement 14.9 blocks a send before any provider request, and this function is the only path
// to a provider, so the gate cannot be a caller's responsibility. It is therefore a single
// unconditional step inside `renderMessage`, run after assembly and before the one and only
// `ok: true` return: see `contentGate` at the bottom of this file. That body delegates to
// `contentGateMatch` in `./gate`, which runs `prohibitedPhraseMatch` and `forbiddenTokenMatch` over
// the subject and then the body; the seam is not exported, not injectable, and not a parameter, so
// no caller can stub or forget it.
//
// What this module does own for Requirement 14.12 is the value side of the defect that motivated
// it: 15 real `avisos` `MensajeEmail` values carry the literal token `nan` where the producer name
// was absent. This renderer never scans assembled text for those sequences and never scrubs them
// out of it — a plain substring count over those 15 rows returns 16, because one body carries the
// letters inside a customer surname. Instead, a case, contact, or employee VALUE whose whole
// trimmed text is one of the absent markers is treated as absent, so it takes the Requirement
// 14.11 path (stored fallback, else zero characters) and is never rendered. A surname containing
// the letters is a different value and is rendered untouched. See `ABSENT_MARKER_TOKENS`.
//
// ---------------------------------------------------------------------------------------------
// Storage contract (migrations v1.10.1 and v1.10.4)
// ---------------------------------------------------------------------------------------------
// - `cancellation_template_versions`: `subject`, `body`, `cancellation_statement`,
//   `contact_request`, `fallback_text jsonb` (object, token name -> fallback string), `language`
//   restricted to `'English' | 'Spanish'`. Bilingual is a render language resolved per message and
//   is assembled from both rows of one version plus exactly one separator; it is never a stored
//   row. `subject` may legitimately be zero characters, because Requirement 14.15 stores zero
//   characters as the rendered subject on the SMS channel.
// - `fallback_text`: a stored empty string and an absent key both render zero characters.
// - `cancellation_settings`: `office_phone` (matched as its digit sequence), `agency_name` (matched
//   as an exact literal), `bilingual_separator` (exactly one between segments). Its check
//   constraints already guarantee at least one digit in the phone, a non-blank agency name, and a
//   separator of at least one character; this module treats a violation of any of those as a
//   caller error rather than rendering a message that cannot satisfy Requirement 14.
// - `cancellation_communications.template_version_id` is one uuid, so a Bilingual render reports
//   the English row's id as `templateVersionId` and both ids as `templateVersionIds`; the two rows
//   share `(template_id, version)`, so the Spanish row is recoverable from the stored one.

import type { ContactChannel, ContactPreferredLanguage } from '../import/contacts';
import { parseAmountDue, parseCancellationDate } from '../import/fields';
import { contentGateMatch } from './gate';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** `cancellation_template_versions.language`. Bilingual is a render language, never a stored row. */
export type TemplateLanguage = 'English' | 'Spanish';

/**
 * The applied preferred language of one rendered message: the three values Requirement 11.1 allows
 * on a Contact_Recipient, which is exactly `ContactPreferredLanguage`.
 */
export type RenderLanguage = ContactPreferredLanguage;

/**
 * `cancellation_communications.channel`, the same two values as `SuppressionChannel` in
 * `../domain/suppression`. Deliberately not `cancellation_contacts.channel`, which is
 * `'phone' | 'email'`: a phone contact is messaged on the `sms` channel.
 */
export type RenderChannel = 'sms' | 'email';

/** The four Requirement 12.1 Touchpoints, in days remaining before the effective date. */
export type Touchpoint = 15 | 10 | 5 | 1;

/** The four Touchpoints from most to fewest days remaining (Requirement 12.1). */
export const TOUCHPOINTS = [15, 10, 5, 1] as const satisfies readonly Touchpoint[];

/** The two segment languages of a Bilingual body, English first (Requirement 11.7). */
export const BILINGUAL_SEGMENT_ORDER = ['English', 'Spanish'] as const satisfies readonly TemplateLanguage[];

/** At most this many Cancellation_Case rows in one combined message (Requirement 13.5). */
export const MAX_COMBINED_CASES = 10;

/** At most this many characters in a combined SMS body (Requirement 13.3). */
export const MAX_COMBINED_SMS_BODY_LENGTH = 640;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * **The token delimiter.** The single source of truth for the decision recorded in the file header:
 * a token is its bare name wrapped in `{{` and `}}`. Task 7.10's seed and any later template editor
 * build placeholders from `tokenPlaceholder()` rather than restating these two strings.
 */
export const TOKEN_DELIMITER = { open: '{{', close: '}}' } as const;

/** `{{Name}}` — the placeholder a template writes for the token named `name`. */
export function tokenPlaceholder(name: string): string {
  return `${TOKEN_DELIMITER.open}${name}${TOKEN_DELIMITER.close}`;
}

/** Every regular-expression metacharacter, so the delimiter can be scanned for literally. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One token occurrence, built from `TOKEN_DELIMITER` so the delimiter is never restated. The name
 * capture is lazy, so `{{A}} {{B}}` reads as two tokens rather than one spanning both.
 */
const TOKEN_SCAN = new RegExp(
  `${escapeForRegExp(TOKEN_DELIMITER.open)}([\\s\\S]*?)${escapeForRegExp(TOKEN_DELIMITER.close)}`,
  'g',
);

/**
 * Every token name this renderer resolves. Keys are the names a template writes between the
 * delimiters; task 7.10 seeds bodies using these and nothing else, because an unrecognized token
 * renders zero characters rather than its own placeholder text (a customer must never receive the
 * literal text `{{Amount_Due}}`).
 */
export const TOKEN_NAMES = {
  /** Requirement 14.1: the exact literal Agency_Name from `cancellation_settings.agency_name`. */
  agencyName: 'Agency_Name',
  /** Requirement 14.4: `cancellation_settings.office_phone`, as stored, punctuation included. */
  officePhone: 'Office_Phone',
  /** Requirements 14.13, 14.14: the resolved sender name, never zero characters. */
  senderName: 'Sender_Name',
  /** Requirement 14.11: the assigned employee display name, fallback-driven when unusable. */
  producerName: 'Producer_Name',
  customerName: 'Customer_Name',
  contactName: 'Contact_Name',
  policyNumber: 'Policy_Number',
  carrier: 'Carrier',
  cancellationReason: 'Cancellation_Reason',
  amountDue: 'Amount_Due',
  /** Requirement 14.3: this case's effective date as day, month, four-digit year. */
  cancellationDate: 'Cancellation_Date',
  /** Requirement 14.5: the earliest included effective date, as the contact deadline. */
  contactDeadline: 'Contact_Deadline',
  /** The earliest included effective date, for a body that names it outside the deadline sentence. */
  earliestCancellationDate: 'Earliest_Cancellation_Date',
  /** Requirements 13.2, 13.3: the count of included policy numbers. */
  policyCount: 'Policy_Count',
  /** Requirement 13.2: every included policy number with its effective date, ordered. Email only. */
  policyList: 'Policy_List',
  /** Requirement 14.2: the stored cancellation-scheduled statement for this segment's language. */
  cancellationStatement: 'Cancellation_Statement',
  /** Requirement 14.5: the stored contact request for this segment's language. */
  contactRequest: 'Contact_Request',
  /** The days remaining of the applied Touchpoint: 15, 10, 5, or 1. */
  touchpointDays: 'Touchpoint_Days',
} as const;

/**
 * The `fallback_text` keys task 7.10 seeds, as bare token names with no delimiter, matching how
 * `v1.10.1-cancellation-templates.sql` documents reading them.
 *
 * `Office_Phone` is listed because the migration lists it, but its fallback is unreachable: the
 * value comes from `cancellation_settings.office_phone`, which is `not null` with a
 * at-least-one-digit check, so it is never absent.
 */
export const FALLBACK_TOKEN_NAMES = [
  TOKEN_NAMES.officePhone,
  TOKEN_NAMES.amountDue,
  TOKEN_NAMES.producerName,
  TOKEN_NAMES.contactName,
  TOKEN_NAMES.carrier,
  TOKEN_NAMES.cancellationReason,
] as const;

/**
 * The five sequences Requirement 14.12 keeps out of rendered output, treated here as ABSENT-VALUE
 * MARKERS: a case, contact, or employee value whose whole trimmed text equals one of them, compared
 * without case sensitivity, is treated as absent and takes the Requirement 14.11 path.
 *
 * This is a whole-value comparison, never a substring scan. `Aznanian`, `Nanette Nunez`, `Nullson`,
 * and `Undefined Holdings LLC` are ordinary values and render unchanged; only a value that is
 * nothing but the marker is dropped. The same five sequences are matched as complete tokens against
 * assembled text by the gate of task 12.2, which is the backstop for anything this rule does not
 * catch, such as a value reading `nan nan`.
 *
 * The same list is `AMOUNT_DUE_ABSENT_TOKENS` in `../import/fields`, applied there at import time
 * to `MontoDebido` under Requirement 8.15; it is restated here because this module applies it to
 * every token value, compared without case sensitivity, which is the Requirement 14.12 rule rather
 * than the Requirement 8.15 one.
 */
export const ABSENT_MARKER_TOKENS = ['nan', 'none', 'null', 'undefined'] as const;

/** True where the whole trimmed text is one absent marker, compared without case sensitivity. */
export function isAbsentMarker(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const folded = value.trim().toLowerCase();
  return (ABSENT_MARKER_TOKENS as readonly string[]).includes(folded);
}

/**
 * A rendered token value, or `null` where the value is absent for Requirement 14.11 purposes:
 * absent, empty, whitespace-only, or nothing but an absent marker.
 */
function presentValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (text.length === 0 || isAbsentMarker(text)) return null;
  return text;
}

/** Every token value of one segment; `null` means absent, which selects the fallback. */
type TokenValues = Readonly<Record<string, string | null | undefined>>;

/**
 * Replaces every token occurrence in one pass (Requirement 14.11): the present value where there is
 * one, otherwise the stored `fallback_text` for that token name, otherwise zero characters. A
 * stored fallback that is itself empty, whitespace-only, or an absent marker renders zero
 * characters, and so does a token name this renderer does not resolve.
 *
 * One pass, deliberately: a token appearing inside a value or inside a fallback is left as written
 * rather than expanded, so no stored text can drive substitution recursively and no imported
 * customer value can inject a token.
 */
export function substituteTokens(
  text: string,
  values: TokenValues,
  fallbackText?: Readonly<Record<string, string | null>> | null,
): string {
  return text.replace(TOKEN_SCAN, (_whole, rawName: string) => {
    const name = rawName.trim();
    const value = presentValue(values[name]);
    if (value !== null) return value;
    return presentValue(fallbackText?.[name]) ?? '';
  });
}

/**
 * The same substitution over a multi-line body, dropping any line whose every token rendered zero
 * characters.
 *
 * Requirement 14.11 renders zero characters for an absent value with no stored fallback, which on
 * its own leaves the words around the token behind: 11 of the 58 real `eficacia` rows carry an empty
 * `MontoDebido`, so a line reading `Amount due: {{Amount_Due}}` would reach those customers as
 * `Amount due:`. A line that carried at least one token and produced no token text at all is
 * therefore dropped whole.
 *
 * The rule is deliberately narrow. A line with no token is never touched, so the stored statement,
 * the contact request, and the signature line always survive; a line keeping at least one rendered
 * token value survives as written, dangling punctuation included, because trimming inside a line
 * would mean guessing at stored wording. Task 7.10 therefore seeds each optional value on its own
 * line, which is what makes this rule enough.
 */
function substituteBody(
  text: string,
  values: TokenValues,
  fallbackText?: Readonly<Record<string, string | null>> | null,
): string {
  return text
    .split('\n')
    .filter((line) => {
      let tokens = 0;
      let rendered = 0;
      line.replace(TOKEN_SCAN, (_whole, rawName: string) => {
        tokens += 1;
        const name = rawName.trim();
        const value = presentValue(values[name]) ?? presentValue(fallbackText?.[name]);
        if (value !== null) rendered += 1;
        return '';
      });
      return tokens === 0 || rendered > 0;
    })
    .map((line) => substituteTokens(line, values, fallbackText))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * The `cancellation_template_versions` columns a render reads. Structural, so a database row and a
 * test fixture both satisfy it without conversion.
 *
 * `touchpoint` is optional because the column lives on `cancellation_templates`, not on the version
 * row: supply it (joined through) when the caller hands over rows for more than one touchpoint, and
 * leave it absent when every row belongs to the one template being rendered.
 */
export interface TemplateVersionRow {
  id: string;
  template_id?: string | null;
  version?: number | null;
  touchpoint?: Touchpoint | null;
  language: TemplateLanguage;
  subject: string;
  body: string;
  cancellation_statement: string;
  contact_request: string;
  fallback_text?: Readonly<Record<string, string | null>> | null;
}

/**
 * The `cancellation_cases` columns a render reads. `cancellation_effective_date` is a `date`
 * column, so it arrives as `YYYY-MM-DD`; `M/D/YYYY` is accepted too, because the same parser reads
 * both at import time.
 *
 * `touchpoint` is this case's due Touchpoint in the run. It is what makes Requirement 13.7
 * enforceable inside the renderer: a combined message renders from the template version of the
 * fewest-days-remaining Touchpoint among the included cases.
 */
export interface RenderCase {
  id?: string | null;
  policy_number: string;
  cancellation_effective_date: string;
  customer_name?: string | null;
  carrier?: string | null;
  cancellation_reason?: string | null;
  /** `numeric(12,2)`, so a string from the database or a number from a fixture. */
  amount_due?: string | number | null;
  touchpoint?: Touchpoint | null;
}

/**
 * The `cancellation_contacts` columns a render reads. `preferred_language` is typed as a plain
 * string because Requirement 11.2 has to handle an unrecognized value, which the type system cannot
 * describe: an absent, empty, whitespace-only, or unknown value resolves to Bilingual.
 */
export interface RenderContact {
  id?: string | null;
  channel?: ContactChannel;
  normalized_value?: string;
  preferred_language?: string | null;
  contact_name?: string | null;
}

/**
 * The assigned employee of the message, as Requirements 14.13 and 14.14 test it. The design names
 * this input field `senderName`; it carries the facts those two criteria test rather than a
 * pre-resolved string, because resolving them is the renderer's job, not a caller's.
 *
 * `public.profiles` carries `display_name text not null` and `is_active boolean not null default
 * true` and has no deleted column, so: an absent `is_active` means the caller did not select the
 * column and is read as active, an absent `is_deleted` is read as not deleted, and the
 * `(Deleted)` producer-label suffix of Requirement 9.7 is what a caller translates into
 * `is_deleted: true`.
 */
export interface AssignedEmployee {
  display_name?: string | null;
  is_active?: boolean | null;
  is_deleted?: boolean | null;
}

/** The `cancellation_settings` render constants (Requirements 14.1, 14.4, 11.7). */
export interface RenderSettings {
  office_phone: string;
  agency_name: string;
  bilingual_separator: string;
}

/**
 * The `cancellation_prohibited_phrases` columns the gate reads. Carried on the input, not fetched,
 * because this module performs no I/O; the gate of task 12.2 compares against it.
 */
export interface ProhibitedPhraseRow {
  id?: string | null;
  phrase: string;
  language?: TemplateLanguage | null;
  claim_category?: string | null;
  is_active?: boolean | null;
}

// ---------------------------------------------------------------------------
// Input and result
// ---------------------------------------------------------------------------

/**
 * One render request. The design fixes the field names
 * `{ templateVersions, cases, contact, touchpoint, channel, settings, senderName, combined }`;
 * `prohibitedPhrases` is added because Requirements 14.8 and 14.9 put the phrase comparison inside
 * this module while purity keeps it from reading the table itself. It is required rather than
 * optional so a caller cannot omit the gate's input by accident.
 */
export interface RenderMessageInput {
  /**
   * Every candidate `cancellation_template_versions` row. At minimum the rows for the applied
   * Touchpoint in the segment languages the resolved render language needs; extra rows for other
   * touchpoints, languages, or versions are ignored, and the highest `version` wins per language.
   */
  readonly templateVersions: readonly TemplateVersionRow[];
  /** The included Cancellation_Case rows: one, or 2 to 10 for a combined message. */
  readonly cases: readonly RenderCase[];
  /**
   * The addressed Contact_Recipient. An array where one message covers several case-owned contact
   * rows sharing a normalized value, which is what Requirement 11.3 means by "the Contact_Recipient
   * rows included in that message".
   */
  readonly contact: RenderContact | readonly RenderContact[];
  /** The Touchpoint of the message; the lowest included case touchpoint wins (Requirement 13.7). */
  readonly touchpoint: Touchpoint;
  readonly channel: RenderChannel;
  readonly settings: RenderSettings;
  /** The assigned employee, or `null` where there is none (Requirement 14.14). */
  readonly senderName: AssignedEmployee | null;
  /** True for a Requirement 13.1 combined message; forced true where more than one case is included. */
  readonly combined: boolean;
  readonly prohibitedPhrases: readonly ProhibitedPhraseRow[];
}

/** Which half of the Requirement 14.9 gate matched. */
export type GateBlockedBy = 'prohibited_phrase' | 'forbidden_token';

/**
 * A blocked render (Requirements 14.9, 14.10). No provider request is made, no Communication_Record
 * is stored, and the caller writes a `cancellation_events` block entry carrying `match` and sets
 * `communication_status = 'Manual Follow-up Required'` for every included case.
 */
export interface RenderBlocked {
  ok: false;
  blockedBy: GateBlockedBy;
  /** The matched phrase or token, in the form a compliance reviewer recognizes. */
  match: string;
  /** Which rendered text the match was found in. */
  field?: 'subject' | 'body';
}

/** A rendered message, ready to be reserved and submitted to a provider verbatim (Req 14.15). */
export interface RenderRendered {
  ok: true;
  /** Zero characters on the SMS channel (Requirement 14.15). */
  subject: string;
  body: string;
  /** The stored `template_version_id`: the English row for a Bilingual render. */
  templateVersionId: string;
  /** Every template version row used, in segment order (one id, or English then Spanish). */
  templateVersionIds: readonly string[];
  /** The applied preferred language (Requirements 11.2, 11.8). */
  language: RenderLanguage;
  /** The Touchpoint whose template version was applied (Requirement 13.7). */
  touchpoint: Touchpoint;
  /** The resolved sender name, for the email from-header display name (Req 14.13, 14.14). */
  senderName: string;
  /** True only where a combined SMS body had to be cut to 640 characters (Requirement 13.3). */
  truncated: boolean;
}

export type RenderResult = RenderRendered | RenderBlocked;

/**
 * A render request that cannot produce a compliant message: no case, more than 10 cases, a missing
 * template version row for a needed segment language, an unparseable cancellation effective date,
 * or a settings row that cannot satisfy Requirement 14.1, 14.4, or 11.7.
 *
 * Thrown rather than returned, because every one of those is a caller or data defect rather than a
 * message outcome: `RenderResult` describes a message that was rendered or a message that was
 * blocked for content, and silently degrading any of these would ship a body that Requirement 14
 * forbids. The scheduler catches it per message and continues the run.
 */
export class RenderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderInputError';
  }
}

// ---------------------------------------------------------------------------
// Dates (Requirements 14.3, 14.6)
// ---------------------------------------------------------------------------

/** Month names per segment language, so no locale data or `Intl` table is involved. */
const MONTH_NAMES: Readonly<Record<TemplateLanguage, readonly string[]>> = {
  English: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
  Spanish: [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ],
};

/**
 * One cancellation effective date as a calendar date carrying the day, the month, and the
 * four-digit year (Requirement 14.3): `July 31, 2026` in English, `31 de julio de 2026` in Spanish.
 *
 * Parsing is `parseCancellationDate` from the importer, so one leap-year rule and one accepted
 * format pair (`YYYY-MM-DD`, `M/D/YYYY`) serve the whole feature. A value the parser rejects throws:
 * `cancellation_effective_date` is `date not null`, so an unparseable value means the caller passed
 * something that is not a stored case date, and omitting the date would violate Requirement 14.3.
 */
export function formatEffectiveDate(date: string, language: TemplateLanguage): string {
  const parsed = parseCancellationDate(date);
  if (!parsed.ok) {
    throw new RenderInputError(
      `cancellation effective date "${date}" cannot be rendered: ${parsed.reason}`,
    );
  }
  const monthName = MONTH_NAMES[language][parsed.month - 1];
  return language === 'English'
    ? `${monthName} ${parsed.day}, ${parsed.year}`
    : `${parsed.day} de ${monthName} de ${parsed.year}`;
}

/** The canonical `YYYY-MM-DD` form of a case date, which sorts chronologically as text. */
function canonicalDate(date: string): string {
  const parsed = parseCancellationDate(date);
  if (!parsed.ok) {
    throw new RenderInputError(
      `cancellation effective date "${date}" cannot be rendered: ${parsed.reason}`,
    );
  }
  return parsed.date;
}

// ---------------------------------------------------------------------------
// Office phone (Requirement 14.4)
// ---------------------------------------------------------------------------

/** The characters Requirement 14.4 removes from the rendered body before matching. */
const PHONE_PUNCTUATION = /[ \-().+]/g;

/** Only the digits of a phone value: the sequence Requirement 14.4 matches. */
export function officePhoneDigits(officePhone: string): string {
  return officePhone.replace(/\D/g, '');
}

/**
 * True where the body renders Office_Phone: the body has spaces, hyphens, parentheses, periods, and
 * plus signs removed, and the result is searched for the Office_Phone digit sequence
 * (Requirement 14.4). A phone value with no digits never matches.
 */
export function containsOfficePhone(body: string, officePhone: string): boolean {
  const digits = officePhoneDigits(officePhone);
  if (digits.length === 0) return false;
  return body.replace(PHONE_PUNCTUATION, '').includes(digits);
}

// ---------------------------------------------------------------------------
// Language, sender, and template selection
// ---------------------------------------------------------------------------

/**
 * The applied preferred language (Requirements 11.2, 11.3, 11.8).
 *
 * A combined message is Bilingual whatever the included contacts prefer. Otherwise the language is
 * the one value every included contact stores; an absent, empty, whitespace-only, or unrecognized
 * value is Bilingual, zero contacts is Bilingual, and two included contacts storing different
 * values is Bilingual, which is the only render that carries both of the languages they asked for.
 */
export function resolveRenderLanguage(
  contacts: readonly RenderContact[],
  combined = false,
): RenderLanguage {
  if (combined) return 'Bilingual';
  const requested = new Set<RenderLanguage>();
  for (const contact of contacts) {
    const stored = typeof contact.preferred_language === 'string'
      ? contact.preferred_language.trim()
      : '';
    requested.add(
      stored === 'English' || stored === 'Spanish' || stored === 'Bilingual' ? stored : 'Bilingual',
    );
  }
  const [only] = [...requested];
  return requested.size === 1 ? only : 'Bilingual';
}

/** The two body segments of a Bilingual render, or the one segment of a single-language render. */
export function segmentLanguages(language: RenderLanguage): readonly TemplateLanguage[] {
  if (language === 'Bilingual') return BILINGUAL_SEGMENT_ORDER;
  return [language];
}

/**
 * The assigned employee display name where Requirement 14.13 is satisfied — present, active, not
 * marked deleted, at least one non-whitespace character, and not an absent marker — otherwise
 * `null`, which is what makes `Producer_Name` take the Requirement 14.11 fallback path while
 * `Sender_Name` falls back to Agency_Name under Requirement 14.14.
 */
function employeeDisplayName(employee: AssignedEmployee | null | undefined): string | null {
  if (employee === null || employee === undefined) return null;
  if ((employee.is_active ?? true) !== true) return null;
  if ((employee.is_deleted ?? false) === true) return null;
  return presentValue(employee.display_name);
}

/**
 * The sender name: the assigned employee display name where the employee is present, active, not
 * marked deleted, and has at least one non-whitespace character (Requirement 14.13), otherwise
 * Agency_Name (Requirement 14.14). A display name that is nothing but an absent marker is treated
 * as blank, which is the direct guard on the `nan` signature block of the legacy `avisos` bodies.
 */
export function resolveSenderName(
  employee: AssignedEmployee | null | undefined,
  agencyName: string,
): string {
  return employeeDisplayName(employee) ?? agencyName;
}

/**
 * The applied Touchpoint: the fewest days remaining among the included cases, falling back to the
 * message Touchpoint where no case carries one (Requirement 13.7).
 */
export function resolveTouchpoint(
  touchpoint: Touchpoint,
  cases: readonly RenderCase[],
): Touchpoint {
  let applied: Touchpoint = touchpoint;
  for (const row of cases) {
    const candidate = row.touchpoint;
    if (candidate !== null && candidate !== undefined && candidate < applied) applied = candidate;
  }
  return applied;
}

/**
 * The template version row for one segment: the highest `version` among the rows of that language
 * whose `touchpoint` is the applied one or absent.
 *
 * A missing row throws. `v1.10.9` seeds an English row and a Spanish row for each of the four
 * touchpoints, so a missing row means the caller selected the wrong template; rendering one segment
 * of a Bilingual message would violate Requirement 11.6.
 */
export function selectTemplateVersion(
  templateVersions: readonly TemplateVersionRow[],
  touchpoint: Touchpoint,
  language: TemplateLanguage,
): TemplateVersionRow {
  let selected: TemplateVersionRow | null = null;
  for (const row of templateVersions) {
    if (row.language !== language) continue;
    if (row.touchpoint !== null && row.touchpoint !== undefined && row.touchpoint !== touchpoint) continue;
    if (selected === null || (row.version ?? 0) > (selected.version ?? 0)) selected = row;
  }
  if (selected === null) {
    throw new RenderInputError(
      `no ${language} template version row was supplied for the ${touchpoint}-day touchpoint`,
    );
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Segment labels
// ---------------------------------------------------------------------------

/**
 * The structural wording the renderer supplies itself: the policy-list heading of Requirement 13.2,
 * the count of Requirements 13.2 and 13.3, and the date labels used by the required-element
 * guarantee below.
 *
 * Deliberately structural only. Every compliance claim — that the policy is scheduled for
 * cancellation, and what the customer is asked to do — comes from the stored
 * `cancellation_statement` and `contact_request` of the template version, never from this table, so
 * no wording here can assert something Requirement 14.7 prohibits.
 */
const SEGMENT_LABELS: Readonly<Record<TemplateLanguage, {
  readonly policyOne: string;
  readonly policyMany: string;
  readonly effectiveDate: string;
  readonly earliestEffectiveDate: string;
  readonly policy: string;
}>> = {
  English: {
    policyOne: 'policy',
    policyMany: 'policies',
    effectiveDate: 'Cancellation effective date',
    earliestEffectiveDate: 'Earliest cancellation effective date',
    policy: 'Policy',
  },
  Spanish: {
    policyOne: 'póliza',
    policyMany: 'pólizas',
    effectiveDate: 'Fecha efectiva de cancelación',
    earliestEffectiveDate: 'Fecha efectiva de cancelación más próxima',
    policy: 'Póliza',
  },
};

/** `2 policies` / `2 pólizas`, the count Requirements 13.2 and 13.3 require the body to state. */
function policyCountText(count: number, language: TemplateLanguage): string {
  const labels = SEGMENT_LABELS[language];
  return `${count} ${count === 1 ? labels.policyOne : labels.policyMany}`;
}

// ---------------------------------------------------------------------------
// Case ordering (Requirement 13.2)
// ---------------------------------------------------------------------------

/** One included case with its canonical date, ordered as Requirement 13.2 lists them. */
interface OrderedCase {
  readonly row: RenderCase;
  readonly date: string;
}

/**
 * The included cases ordered by cancellation effective date ascending, then by policy number
 * ascending (Requirement 13.2). Policy numbers compare character by character without case
 * sensitivity first, so `abc-1` and `ABC-1` sit together, then with case sensitivity so the order is
 * total and stable. Comparison is by code unit rather than through `localeCompare`, so the order
 * does not depend on the locale data of the host that renders the message.
 */
export function orderCasesForRender(cases: readonly RenderCase[]): readonly RenderCase[] {
  return orderedCases(cases).map((entry) => entry.row);
}

function orderedCases(cases: readonly RenderCase[]): readonly OrderedCase[] {
  return cases
    .map((row) => ({ row, date: canonicalDate(row.cancellation_effective_date) }))
    .sort((left, right) => {
      if (left.date !== right.date) return left.date < right.date ? -1 : 1;
      const leftPolicy = left.row.policy_number ?? '';
      const rightPolicy = right.row.policy_number ?? '';
      const leftFolded = leftPolicy.toUpperCase();
      const rightFolded = rightPolicy.toUpperCase();
      if (leftFolded !== rightFolded) return leftFolded < rightFolded ? -1 : 1;
      return leftPolicy < rightPolicy ? -1 : leftPolicy > rightPolicy ? 1 : 0;
    });
}

// ---------------------------------------------------------------------------
// Segment assembly
// ---------------------------------------------------------------------------

/** Everything one segment needs that does not depend on its language. */
interface SegmentContext {
  readonly cases: readonly OrderedCase[];
  readonly contacts: readonly RenderContact[];
  readonly settings: RenderSettings;
  readonly channel: RenderChannel;
  readonly combined: boolean;
  readonly touchpoint: Touchpoint;
  readonly senderName: string;
  readonly producerName: string | null;
}

/** The text of one language segment, plus the elements Requirement 14 requires it to carry. */
interface Segment {
  readonly language: TemplateLanguage;
  readonly templateVersionId: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * The token values of one segment.
 *
 * One stored template version serves both channels and both case counts, so a token written for one
 * policy has to mean something sensible in a message covering several:
 * - `Policy_Number` is the one policy number for a single case, every included policy number in list
 *   order for a combined email, and absent for a combined SMS, which Requirement 13.3 forbids from
 *   carrying a policy number at all.
 * - `Cancellation_Date` is that case's date for a single case and the earliest included date for a
 *   combined message, where `Policy_List` is what carries each policy's own date under
 *   Requirement 13.2 and the earliest is the date the Requirement 14.5 deadline names.
 * - `Carrier`, `Cancellation_Reason`, and `Amount_Due` differ per case, so a combined message leaves
 *   them absent and they take the Requirement 14.11 fallback path.
 * - `Customer_Name` and `Contact_Name` stay resolved in a combined message: Requirement 13.1 groups
 *   only cases of one matched customer reached at one contact value.
 */
function segmentTokenValues(
  context: SegmentContext,
  language: TemplateLanguage,
  statement: string,
  contactRequest: string,
): TokenValues {
  const single = context.cases.length === 1 ? context.cases[0] : null;
  const earliest = context.cases[0];
  const contactName = context.contacts
    .map((contact) => presentValue(contact.contact_name))
    .find((name) => name !== null && name !== undefined) ?? null;
  const amount = single === null ? null : parseAmountDue(
    single.row.amount_due === null || single.row.amount_due === undefined
      ? null
      : String(single.row.amount_due),
  );
  const policyNumbers = context.channel === 'sms' && context.cases.length > 1
    ? null
    : context.cases
      .map((entry) => presentValue(entry.row.policy_number))
      .filter((value): value is string => value !== null)
      .join(', ');

  return {
    [TOKEN_NAMES.agencyName]: context.settings.agency_name,
    [TOKEN_NAMES.officePhone]: context.settings.office_phone,
    [TOKEN_NAMES.senderName]: context.senderName,
    [TOKEN_NAMES.producerName]: context.producerName,
    [TOKEN_NAMES.customerName]: presentValue(context.cases[0].row.customer_name),
    [TOKEN_NAMES.contactName]: contactName,
    [TOKEN_NAMES.policyNumber]: policyNumbers,
    [TOKEN_NAMES.carrier]: single === null ? null : presentValue(single.row.carrier),
    [TOKEN_NAMES.cancellationReason]: single === null
      ? null
      : presentValue(single.row.cancellation_reason),
    [TOKEN_NAMES.amountDue]: amount !== null && amount.present ? formatAmount(amount.amountDue) : null,
    [TOKEN_NAMES.cancellationDate]: formatEffectiveDate((single ?? earliest).date, language),
    [TOKEN_NAMES.contactDeadline]: formatEffectiveDate(earliest.date, language),
    [TOKEN_NAMES.earliestCancellationDate]: formatEffectiveDate(earliest.date, language),
    [TOKEN_NAMES.policyCount]: policyCountText(context.cases.length, language),
    [TOKEN_NAMES.policyList]: context.channel === 'email' ? policyListBlock(context, language) : null,
    [TOKEN_NAMES.cancellationStatement]: statement,
    [TOKEN_NAMES.contactRequest]: contactRequest,
    [TOKEN_NAMES.touchpointDays]: String(context.touchpoint),
  };
}

/** `$1,234.56` from the two-decimal text `parseAmountDue` returns. Locale-invariant by hand. */
function formatAmount(amountDue: string): string {
  const [whole, fraction] = amountDue.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${grouped}.${fraction}`;
}

/**
 * Every included policy number with its cancellation effective date, ordered by date then policy
 * number, headed by the count (Requirement 13.2). Email only: Requirement 13.3 keeps individual
 * policy numbers out of a combined SMS body.
 */
function policyListBlock(context: SegmentContext, language: TemplateLanguage): string {
  const labels = SEGMENT_LABELS[language];
  const lines = context.cases.map(
    (entry) => `- ${labels.policy} ${entry.row.policy_number}: ${formatEffectiveDate(entry.date, language)}`,
  );
  return [`${policyCountText(context.cases.length, language)}:`, ...lines].join('\n');
}

/**
 * The dates block appended where the substituted body does not already render every included
 * effective date (Requirement 14.3): the ordered policy list for a message covering several cases,
 * a single labeled date otherwise.
 */
function datesBlock(context: SegmentContext, language: TemplateLanguage): string {
  const labels = SEGMENT_LABELS[language];
  if (context.cases.length > 1) return policyListBlock(context, language);
  return `${labels.effectiveDate}: ${formatEffectiveDate(context.cases[0].date, language)}`;
}

/**
 * One language segment.
 *
 * The stored `body` of the template version is the segment, with its tokens substituted — except
 * for a combined SMS, which Requirement 13.3 caps at 640 characters for both languages together and
 * forbids from naming a policy number. That one case is assembled from the required elements alone:
 * the stored statement, the count and the earliest date, and the stored contact request.
 *
 * **The required-element guarantee.** Requirements 14.2, 14.3, and 14.5 require the statement, the
 * included dates, and the contact request in every rendered body, and Requirements 11.7 and 14.6
 * require all three in each segment of a Bilingual body. Rather than trusting that every stored
 * template carries the matching token, each element is checked against the assembled segment and
 * appended where it is absent. A template that writes all three the intended way appends nothing.
 *
 * The statement and the contact request are substituted first, because both may carry tokens of
 * their own — the contact deadline of Requirement 14.5 is one — and their rendered text is then what
 * the `Cancellation_Statement` and `Contact_Request` tokens of the body resolve to, and what the
 * "already present" comparison above compares against.
 */
function buildSegment(
  context: SegmentContext,
  language: TemplateLanguage,
  version: TemplateVersionRow,
): Segment {
  const fallback = version.fallback_text ?? null;
  const baseValues = segmentTokenValues(context, language, '', '');
  const statement = substituteTokens(version.cancellation_statement, baseValues, fallback);
  const contactRequest = substituteTokens(version.contact_request, baseValues, fallback);
  const values = segmentTokenValues(context, language, statement, contactRequest);

  const compactSms = context.combined && context.channel === 'sms';
  const join = context.channel === 'sms' ? ' ' : '\n\n';
  const dates = compactSms
    ? `${policyCountText(context.cases.length, language)} - ${SEGMENT_LABELS[language].earliestEffectiveDate}: ${formatEffectiveDate(context.cases[0].date, language)}`
    : datesBlock(context, language);

  const parts: string[] = compactSms
    ? [statement, dates, contactRequest]
    : [substituteBody(version.body, values, fallback)];

  if (!compactSms) {
    const assembled = parts[0];
    if (statement.length > 0 && !assembled.includes(statement)) parts.push(statement);
    if (!renderedEveryDate(assembled, context, language)) parts.push(dates);
    if (contactRequest.length > 0 && !assembled.includes(contactRequest)) parts.push(contactRequest);
  }

  return {
    language,
    templateVersionId: version.id,
    subject: substituteTokens(version.subject, values, fallback),
    body: parts.filter((part) => part.length > 0).join(join),
  };
}

/**
 * True where the text already renders every included cancellation effective date in this segment's
 * language (Requirement 14.3). A combined SMS is exempt and never asks.
 */
function renderedEveryDate(
  text: string,
  context: SegmentContext,
  language: TemplateLanguage,
): boolean {
  return context.cases.every((entry) => text.includes(formatEffectiveDate(entry.date, language)));
}

// ---------------------------------------------------------------------------
// Subject and body assembly (Requirements 11.6, 11.7, 14.15)
// ---------------------------------------------------------------------------

/**
 * The separator between the two subject segments of a Bilingual email. Requirement 11.7 fixes the
 * segment order for the subject and fixes exactly one `bilingual_separator` between the two BODY
 * segments; it states no subject separator, and `cancellation_settings.bilingual_separator`
 * defaults to a line-feed-bearing value that no email subject line may carry. So the subject uses
 * this one single-line separator, and the body uses the stored one.
 */
export const SUBJECT_SEGMENT_SEPARATOR = ' / ';

/**
 * The rendered subject: zero characters on the SMS channel (Requirement 14.15), otherwise the
 * segment subjects in language order joined by `SUBJECT_SEGMENT_SEPARATOR`. A segment whose stored
 * subject is zero characters contributes nothing and leaves no dangling separator, which keeps a
 * legitimately empty stored `subject` from producing a subject that is only punctuation.
 */
function assembleSubject(segments: readonly Segment[], channel: RenderChannel): string {
  if (channel === 'sms') return '';
  return segments
    .map((segment) => segment.subject.trim())
    .filter((subject) => subject.length > 0)
    .join(SUBJECT_SEGMENT_SEPARATOR);
}

/**
 * The rendered body: one segment, or the English segment then exactly one
 * `settings.bilingual_separator` then the Spanish segment (Requirements 11.6, 11.7). The separator
 * is written exactly once by this function and nowhere else, so a Bilingual body carries exactly one
 * of them unless a stored template body contains the separator text itself.
 *
 * Requirements 14.1, 14.4, 14.13, and 14.14 are then guaranteed over the whole body rather than per
 * segment, because each says "at least once in every rendered body": the sender name, Agency_Name,
 * and Office_Phone are appended as a closing line only where the assembled body does not already
 * render them. On a Bilingual SMS that keeps one signature instead of two, which is 640-character
 * budget that Requirement 13.3 needs.
 */
function assembleBody(
  segments: readonly Segment[],
  context: SegmentContext,
): string {
  const separator = segments.length > 1 ? context.settings.bilingual_separator : '';
  const assembled = segments.map((segment) => segment.body).join(separator);

  const signature: string[] = [];
  const alreadyRendered = (needle: string): boolean =>
    assembled.includes(needle) || signature.some((part) => part.includes(needle));

  if (!alreadyRendered(context.senderName)) signature.push(context.senderName);
  if (!alreadyRendered(context.settings.agency_name)) signature.push(context.settings.agency_name);
  if (
    !containsOfficePhone(assembled, context.settings.office_phone)
    && !containsOfficePhone(signature.join(' '), context.settings.office_phone)
  ) {
    signature.push(context.settings.office_phone);
  }

  if (signature.length === 0) return assembled;
  const join = context.channel === 'sms' ? ' ' : '\n\n';
  return `${assembled}${join}${signature.join(' ')}`;
}

// ---------------------------------------------------------------------------
// renderMessage
// ---------------------------------------------------------------------------

/** The addressed contacts as a list, whether one row or several were supplied. */
function contactList(contact: RenderContact | readonly RenderContact[]): readonly RenderContact[] {
  return Array.isArray(contact) ? (contact as readonly RenderContact[]) : [contact as RenderContact];
}

/** Requirements 14.1, 14.4, and 11.7 are unsatisfiable without these, so they are checked first. */
function validateSettings(settings: RenderSettings, bilingual: boolean): void {
  if (presentValue(settings.agency_name) === null) {
    throw new RenderInputError('cancellation_settings.agency_name is blank, so Requirement 14.1 cannot be satisfied');
  }
  if (officePhoneDigits(settings.office_phone).length === 0) {
    throw new RenderInputError('cancellation_settings.office_phone carries no digits, so Requirement 14.4 cannot be satisfied');
  }
  if (bilingual && settings.bilingual_separator.length === 0) {
    throw new RenderInputError('cancellation_settings.bilingual_separator is zero characters, so Requirement 11.7 cannot be satisfied');
  }
}

/**
 * Renders one message for one Contact_Recipient on one channel.
 *
 * Order of work, which is also the order of the requirements it satisfies:
 * 1. The included cases are ordered by effective date then policy number (Requirement 13.2), and a
 *    message covering more than one case is a combined message whatever `combined` says
 *    (Requirement 13.1).
 * 2. The render language resolves from the included contacts, or is Bilingual for a combined
 *    message (Requirements 11.2, 11.3, 11.8).
 * 3. The applied Touchpoint is the fewest days remaining among the included cases
 *    (Requirement 13.7), and one template version row is selected per segment language.
 * 4. Each segment is assembled and its required elements guaranteed (Requirements 14.2, 14.3, 14.5,
 *    11.6, 11.7, 14.6), the subject is assembled (Requirement 14.15), the body is assembled with
 *    exactly one separator and the closing signature (Requirements 11.7, 14.1, 14.4, 14.13, 14.14),
 *    and a combined SMS body is held to 640 characters (Requirement 13.3).
 * 5. The content gate runs, and only a non-match reaches the single `ok: true` return
 *    (Requirements 14.8, 14.9, 14.12).
 *
 * Throws `RenderInputError` for a request that cannot produce a compliant message; see that class.
 */
export function renderMessage(input: RenderMessageInput): RenderResult {
  if (input.cases.length === 0) {
    throw new RenderInputError('renderMessage was called with zero cancellation cases');
  }
  if (input.cases.length > MAX_COMBINED_CASES) {
    throw new RenderInputError(
      `renderMessage was called with ${input.cases.length} cancellation cases; Requirement 13.5 caps one combined message at ${MAX_COMBINED_CASES}`,
    );
  }

  const cases = orderedCases(input.cases);
  const contacts = contactList(input.contact);
  const combined = input.combined || cases.length > 1;
  const language = resolveRenderLanguage(contacts, combined);
  const languages = segmentLanguages(language);

  validateSettings(input.settings, languages.length > 1);

  const touchpoint = resolveTouchpoint(input.touchpoint, input.cases);
  const context: SegmentContext = {
    cases,
    contacts,
    settings: input.settings,
    channel: input.channel,
    combined,
    touchpoint,
    senderName: resolveSenderName(input.senderName, input.settings.agency_name),
    producerName: employeeDisplayName(input.senderName),
  };

  const segments = languages.map((segmentLanguage) => buildSegment(
    context,
    segmentLanguage,
    selectTemplateVersion(input.templateVersions, touchpoint, segmentLanguage),
  ));

  const subject = assembleSubject(segments, input.channel);
  const assembled = assembleBody(segments, context);
  const overLimit = combined
    && input.channel === 'sms'
    && assembled.length > MAX_COMBINED_SMS_BODY_LENGTH;
  const body = overLimit ? assembled.slice(0, MAX_COMBINED_SMS_BODY_LENGTH) : assembled;

  const blocked = contentGate({
    subject,
    body,
    language,
    channel: input.channel,
    prohibitedPhrases: input.prohibitedPhrases,
  });
  if (blocked !== null) return blocked;

  return {
    ok: true,
    subject,
    body,
    templateVersionId: segments[0].templateVersionId,
    templateVersionIds: segments.map((segment) => segment.templateVersionId),
    language,
    touchpoint,
    senderName: context.senderName,
    truncated: overLimit,
  };
}

// ---------------------------------------------------------------------------
// The content gate seam (task 12.2)
// ---------------------------------------------------------------------------

/** Everything the Requirement 14.8 / 14.9 / 14.12 gate compares. */
export interface ContentGateInput {
  readonly subject: string;
  readonly body: string;
  readonly language: RenderLanguage;
  readonly channel: RenderChannel;
  readonly prohibitedPhrases: readonly ProhibitedPhraseRow[];
}

/**
 * **The gate. Task 12.2 owns this body; nothing else changes when it lands.**
 *
 * It is called exactly once, from `renderMessage`, after assembly and before the one `ok: true`
 * return, and it is not reachable or replaceable from outside this module — Requirement 14.9 blocks
 * a send before any provider request, and this module is the only path to a provider, so the gate
 * must not be something a caller can pass, stub, or forget.
 *
 * The comparisons themselves live in `./gate`, which owns them alone:
 *   - `prohibitedPhraseMatch(text, phrases)` over the active phrases, both sides lower-cased with
 *     every whitespace run collapsed to one space (Requirement 14.8), returning
 *     `{ blockedBy: 'prohibited_phrase', match }`
 *   - `forbiddenTokenMatch(text)` over `nan`, `NaN`, `None`, `null`, `undefined` as complete tokens
 *     bounded by start, end, whitespace, or a non-alphanumeric character, treating those sequences
 *     inside a longer word as compliant (Requirement 14.12), returning
 *     `{ blockedBy: 'forbidden_token', match }`
 * `contentGateMatch` runs both over the subject and then the body, with `field` set to whichever
 * matched. The value side of Requirement 14.12 is enforced separately and earlier, by
 * `ABSENT_MARKER_TOKENS`, so a value that is nothing but an absent marker never reaches this gate.
 */
function contentGate(gate: ContentGateInput): RenderBlocked | null {
  return contentGateMatch(gate);
}

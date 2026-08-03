// The cancellation content gate: the two comparisons Requirement 14.9 runs over an assembled
// message before any provider request, and the one function that orders them.
//
// - 14.8  every phrase on the Prohibited_Phrase_List is excluded from every rendered subject and
//         every rendered body, compared after lower-casing both texts and collapsing each run of
//         whitespace characters to one space character
// - 14.12 the tokens `nan`, `NaN`, `None`, `null`, and `undefined` are excluded from every rendered
//         subject and every rendered body, compared without case sensitivity and matched only as a
//         complete token bounded by the start of the text, the end of the text, a whitespace
//         character, or a character that is neither a letter nor a digit; the same character
//         sequences inside a longer word are compliant
// - 14.9  a match blocks the send before any provider request, stores no Communication_Record, and
//         records the matched phrase or token in the audit timeline
// - 14.7  the list this module compares against is the seeded `cancellation_prohibited_phrases`
//         rows; only active rows are enforced, so retiring a phrase clears `is_active` rather than
//         deleting the evidence of what the gate used to block
//
// **Pure module.** No React, no Supabase client, no network, no file system, no clock, no
// randomness. The phrase rows arrive as a parameter, exactly as they do in `renderMessage`, so the
// same subject and body always produce the same verdict.
//
// ---------------------------------------------------------------------------------------------
// WHY THE TOKEN RULE IS A BOUNDARY RULE AND NOT A SUBSTRING SCAN
// ---------------------------------------------------------------------------------------------
// The legacy `avisos` export is the reason Requirement 14.12 exists: 15 `MensajeEmail` values carry
// the literal token `nan` where the producer name was absent. A plain substring count over those
// same rows returns 16 — one body carries the letters inside a customer surname. Blocking on a
// substring would therefore hold a compliant message for manual follow-up because of the customer's
// name, so `Nanette Nunez`, `Nullson`, and `Aznanian` all pass this gate, while a body carrying a
// bare `nan` is blocked. Property 3 (task 12.3) drives exactly that distinction over generated
// worlds.
//
// "Letter" and "digit" are read as the Unicode letter and number properties rather than as ASCII,
// because Spanish is a first-class render language here: `null` inside `nulló` has to stay inside a
// word, which it would not if `ó` counted as a boundary. A character that is neither — punctuation,
// a symbol, a separator, whitespace — is a boundary, so `nan.`, `(nan)`, `nan_`, and a bare `nan`
// all block.
//
// A whitespace boundary is a boundary whatever follows it, so a customer named
// `Undefined Holdings LLC` DOES block: `Undefined` there is a complete token bounded by the start of
// the text and a space, not a sequence inside a longer word, and Requirement 14.12 names both of
// those as boundaries. No text-level rule can tell that company name from a leaked `str(None)`, and
// the criterion resolves the ambiguity toward exclusion, so such a message takes the Requirement
// 14.10 path — zero Communication_Record rows, `Manual Follow-up Required`, the run continues, and a
// human sends it by hand. That is the recoverable direction; a shipped `undefined` is not.
//
// ---------------------------------------------------------------------------------------------
// RELATIONSHIP TO `ABSENT_MARKER_TOKENS` IN `./renderMessage`
// ---------------------------------------------------------------------------------------------
// The renderer already applies the same four sequences to token VALUES: a case, contact, or employee
// value whose whole trimmed text is one of them is treated as absent and takes the Requirement 14.11
// fallback path, so it never reaches assembled text. This gate is the backstop for what that rule
// cannot catch — a value reading `nan nan`, or a stored template body that itself contains a marker.
// `FORBIDDEN_TOKENS` below is checked against that list at compile time through a type-only import,
// so the two can never drift apart, and no runtime import cycle exists between the two files.

import type {
  ContentGateInput,
  ProhibitedPhraseRow,
  RenderBlocked,
} from './renderMessage';
import type * as RenderMessageModule from './renderMessage';

// ---------------------------------------------------------------------------
// Forbidden tokens (Requirement 14.12)
// ---------------------------------------------------------------------------

/**
 * The absent-marker list of `./renderMessage`, imported as a TYPE only so this module carries no
 * runtime dependency back on the renderer that imports it. `satisfies` below turns any future edit
 * to that list into a compile error here rather than a silent divergence between the value rule
 * (Requirement 14.11) and the assembled-text rule (Requirement 14.12).
 */
type AbsentMarkerTokens = typeof RenderMessageModule.ABSENT_MARKER_TOKENS;

/**
 * The five sequences Requirement 14.12 names, as the four distinct sequences they reduce to once
 * the comparison is case-insensitive: `nan` covers `nan` and `NaN`, `none` covers `None`.
 */
export const FORBIDDEN_TOKENS = ['nan', 'none', 'null', 'undefined'] as const satisfies AbsentMarkerTokens;

/** Unicode letters and numbers: the characters Requirement 14.12 does NOT treat as a boundary. */
const ALPHANUMERIC_CLASS = '\\p{L}\\p{N}';

/**
 * One forbidden token as a complete token. The leading group is the boundary before it — the start
 * of the text or one non-alphanumeric character — and the trailing lookahead is the boundary after
 * it, which stays a lookahead so the token itself is what capture group 1 reports.
 *
 * Built through `new RegExp` rather than written as a literal so the `u`-flag property escapes are
 * independent of the `ES2017` compile target, and deliberately not global: only the first match is
 * ever needed, and a non-global expression carries no `lastIndex` state between calls.
 */
const FORBIDDEN_TOKEN_SCAN = new RegExp(
  `(?:^|[^${ALPHANUMERIC_CLASS}])(${FORBIDDEN_TOKENS.join('|')})(?![${ALPHANUMERIC_CLASS}])`,
  'iu',
);

/** A forbidden-token match, carrying the token as it appears in the text (`NaN`, not `nan`). */
export interface ForbiddenTokenMatch {
  readonly blockedBy: 'forbidden_token';
  /** The matched token exactly as the text spells it, which is what the audit timeline records. */
  readonly match: string;
}

/**
 * The first forbidden token in `text`, or `null` where the text carries none (Requirement 14.12).
 *
 * `null` is the compliant answer, which is what lets Property 3 assert
 * `forbiddenTokenMatch(subject) === null && forbiddenTokenMatch(body) === null` for every rendered
 * message. An occurrence inside a longer word is not a match: `Nanette`, `Aznanian`, `Nullson`, and
 * `Undefined Holdings LLC` all return `null`, while `nan`, `NaN`, ` none `, `null.`, and
 * `(undefined)` all return a match.
 */
export function forbiddenTokenMatch(text: string): ForbiddenTokenMatch | null {
  const found = FORBIDDEN_TOKEN_SCAN.exec(text);
  if (found === null) return null;
  return { blockedBy: 'forbidden_token', match: found[1] };
}

// ---------------------------------------------------------------------------
// Prohibited phrases (Requirement 14.8)
// ---------------------------------------------------------------------------

/** Every run of whitespace, which Requirement 14.8 collapses to one space character. */
const WHITESPACE_RUN = /\s+/gu;

/**
 * The Requirement 14.8 comparison form: lower case, every whitespace run one space character.
 *
 * Applied to both sides at compare time rather than stored, so the phrase this module reports back
 * stays in the form a compliance reviewer recognizes. The trim is the one addition to the letter of
 * the criterion: `cancellation_prohibited_phrases.phrase` only has to be non-blank, so a stored
 * value padded at either end would otherwise fail to match the same phrase sitting at the start of
 * a body. Trimming the searched text cannot change any interior match.
 *
 * `\s` covers the ASCII whitespace characters, the Unicode separators, and the non-breaking space,
 * so a body pasted with `\u00a0` between two words still matches a phrase typed with plain spaces.
 */
export function normalizeForPhraseComparison(text: string): string {
  return text.replace(WHITESPACE_RUN, ' ').toLowerCase().trim();
}

/** A prohibited-phrase match, carrying the stored phrase rather than its comparison form. */
export interface ProhibitedPhraseMatch {
  readonly blockedBy: 'prohibited_phrase';
  /** The phrase as `cancellation_prohibited_phrases` stores it (Requirement 14.9). */
  readonly match: string;
}

/**
 * The first active prohibited phrase contained in `text`, or `null` where none is (Req 14.8).
 *
 * Only active rows are enforced: `is_active` is `not null default true` in the table, so a row that
 * does not carry the column at all is read as active rather than silently skipped. A phrase whose
 * comparison form is zero characters is skipped — it would match every text and block every send,
 * which is also why the table refuses a blank phrase.
 *
 * Language is deliberately not a filter. Requirement 14.8 excludes every phrase on the list from
 * every rendered subject and body, and a Spanish claim reaching an English body is exactly as
 * non-compliant as it is in a Spanish one.
 *
 * Where several phrases match, the first in input order is reported; Requirement 14.9 records a
 * matched phrase, not every matched phrase, and the result is deterministic for a given list order.
 */
export function prohibitedPhraseMatch(
  text: string,
  phrases: readonly ProhibitedPhraseRow[],
): ProhibitedPhraseMatch | null {
  const haystack = normalizeForPhraseComparison(text);
  if (haystack.length === 0) return null;

  for (const row of phrases) {
    if ((row.is_active ?? true) !== true) continue;
    const stored = typeof row.phrase === 'string' ? row.phrase : '';
    const needle = normalizeForPhraseComparison(stored);
    if (needle.length === 0) continue;
    if (haystack.includes(needle)) return { blockedBy: 'prohibited_phrase', match: stored };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The gate (Requirement 14.9)
// ---------------------------------------------------------------------------

/** Subject first, then body: the order Requirement 14.9 names the two rendered texts in. */
const GATE_FIELDS = ['subject', 'body'] as const;

/**
 * The whole gate: both comparisons over the rendered subject, then both over the rendered body,
 * with `field` set to whichever text matched (Requirements 14.8, 14.9, 14.12).
 *
 * `null` means the message is clear to send. A match is the `RenderBlocked` value `renderMessage`
 * returns instead of `ok: true`, so no caller can reach a provider on a match; the caller then
 * writes a `cancellation_events` block entry carrying `match`, sets `communication_status` to
 * `Manual Follow-up Required` for every included case, stores zero Communication_Record rows, and
 * continues the run (Requirement 14.10).
 *
 * Phrases are compared before tokens within each text because a prohibited claim is the more
 * serious finding for a reviewer reading the timeline entry; where a text carries both, the phrase
 * is the one recorded.
 *
 * `language` and `channel` ride along on the input without being read: phrase enforcement is not
 * language-filtered (see `prohibitedPhraseMatch`), and the SMS subject is zero characters under
 * Requirement 14.15, which makes the subject pass a no-op on that channel rather than a special
 * case to branch on.
 */
export function contentGateMatch(gate: ContentGateInput): RenderBlocked | null {
  for (const field of GATE_FIELDS) {
    const text = gate[field];

    const phrase = prohibitedPhraseMatch(text, gate.prohibitedPhrases);
    if (phrase !== null) return { ok: false, ...phrase, field };

    const token = forbiddenTokenMatch(text);
    if (token !== null) return { ok: false, ...token, field };
  }
  return null;
}

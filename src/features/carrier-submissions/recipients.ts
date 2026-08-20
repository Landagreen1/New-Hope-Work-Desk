/**
 * Recipient parsing and validation.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirements 2.6, 5.4, 10.1.
 *
 * Shared deliberately between the Market Directory admin (where a manager types a CC
 * list) and the send route (which must not trust it). Validating in one place means the
 * screen cannot accept an address the sender will later reject.
 *
 * The address check is intentionally shallow. RFC 5322 admits addresses no carrier will
 * ever use, and a regex that implements it rejects nothing useful while being impossible
 * to read. This catches the mistakes people actually make — a missing @, a trailing
 * comma, a stray space, a domain with no dot — and leaves the provider to be the final
 * authority.
 */

/** Characters that would let a crafted address inject extra mail headers. */
const HEADER_INJECTION = /[\r\n<>,;:"\\]/;

const SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isValidEmailAddress(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return false;
  if (HEADER_INJECTION.test(trimmed)) return false;
  return SHAPE.test(trimmed);
}

export interface RecipientParseResult {
  /** Valid, de-duplicated, lower-cased, in the order first seen. */
  valid: string[];
  /** Everything rejected, verbatim, so the UI can show what to fix. */
  invalid: string[];
}

/**
 * Splits a human-typed list on commas, semicolons or whitespace.
 *
 * People paste addresses out of Outlook, which separates with semicolons, and out of
 * spreadsheets, which separate with commas or newlines. Accepting all three costs one
 * character in the regex and removes a class of support question.
 */
export function parseRecipientList(input: string): RecipientParseResult {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of input.split(/[,;\s]+/)) {
    const candidate = raw.trim();
    if (candidate.length === 0) continue;

    if (!isValidEmailAddress(candidate)) {
      invalid.push(candidate);
      continue;
    }
    const normalised = candidate.toLowerCase();
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    valid.push(normalised);
  }

  return { valid, invalid };
}

/** Renders a stored list back into the single-line form the admin screen edits. */
export function formatRecipientList(addresses: readonly string[] | null | undefined): string {
  return (addresses ?? []).join(', ');
}

// Import header matching: the one place a source column name becomes a comparison key.
//
// Every importer in the Work Desk reads files the agency's own collector programs and the
// carriers produce, and those files are Spanish. The same column arrives spelled five ways
// across a year of exports:
//
//   FechaCancelacion   Fecha Cancelacion   Fecha de Cancelación   FECHA_CANCELACION   fechaCancelacion
//
// Comparing those with `trim().toLowerCase()` — which is what the cancellation importer and
// the renewals importer each did on their own — matches exactly one of the five, so a manager
// re-assigns almost every column by hand on every upload. That is the problem this module
// removes.
//
// Two functions, one idea:
//
//   * `headerMatchKey` collapses the differences that never carry identity in a column name:
//     a byte order mark, surrounding and inner whitespace, letter case, accents, punctuation,
//     CamelCase versus spaced words, and the Spanish and English filler words `de`, `del`,
//     `la`, `el`, `los`, `las`, `of`, `the`. Nothing else. A difference in the actual words,
//     their order, or their digits survives, so `FechaCancelacion` and `FechaRenovacion` stay
//     distinct and so do `Poliza` and `PolizaNormalizada`.
//
//   * `matchHeaderAliases` resolves a list of accepted source names per target column, in
//     preference order, and never lets two targets read the same source column.
//
// The key is *not* a replacement for the header. Callers keep the header text exactly as the
// file spelled it — the cancellation importer persists it as `raw_header`, the renewals
// importer persists it inside `raw` — and use the key only to decide what a column means.
//
// Pure module: no React, no Supabase, no network, no file system, no clock, no randomness.

// ---------------------------------------------------------------------------
// The comparison key
// ---------------------------------------------------------------------------

const LEADING_BOM = /^\uFEFF/;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Words dropped from a column name before it becomes a key.
 *
 * Deliberately tiny, and deliberately limited to grammatical filler: a Spanish export writes
 * `Fecha de Cancelación` where the collector writes `FechaCancelacion`, and the `de` is the
 * only difference. Nothing that could name a column is listed — `no`, `sin`, `total`, `neto`
 * and every other word that changes what a column holds is kept, because dropping one would
 * silently merge two different columns into one key.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'of', 'the']);

/**
 * The words of a column name, in order, folded for comparison.
 *
 * `CamelCase`, `ALLCAPSWord`, and letter/digit boundaries all split, so `FechaCancelacion`,
 * `Fecha Cancelacion`, and `FECHA_CANCELACION` yield the same three-to-two word sequence, and
 * `MensajeSMS` yields `['mensaje', 'sms']` rather than one unsplittable run.
 *
 * When every word is filler — a column literally named `De` — the unfiltered words are
 * returned instead, so a key is never empty for a non-empty name.
 */
export function headerWords(value: string | null | undefined): string[] {
  const folded = (value ?? '')
    .replace(LEADING_BOM, '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '');

  const split = folded
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2');

  const all = split
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);

  const meaningful = all.filter((word) => !FILLER_WORDS.has(word));
  return meaningful.length > 0 ? meaningful : all;
}

/**
 * The comparison key of a column name. Two names mean the same column when, and only when,
 * their keys are equal strings.
 *
 * The words are joined with no separator on purpose: it is the one join under which
 * `FechaCancelacion` and `Fecha Cancelacion` are equal without also making `Fecha` plus
 * `Cancelacion` in two separate columns look like one.
 */
export function headerMatchKey(value: string | null | undefined): string {
  return headerWords(value).join('');
}

/** True when two column names name the same column under `headerMatchKey`. */
export function headersMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const key = headerMatchKey(left);
  return key.length > 0 && key === headerMatchKey(right);
}

/**
 * The lowest position of `header` naming `columnName`, or `null`.
 *
 * A file whose header row repeats a name keeps its first position, which is the rule the
 * cancellation importer's `buildColumnIndex` already applies downstream.
 */
export function findHeaderPosition(header: readonly string[], columnName: string): number | null {
  const target = headerMatchKey(columnName);
  if (target.length === 0) return null;
  for (let index = 0; index < header.length; index += 1) {
    if (headerMatchKey(header[index] ?? '') === target) return index;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Alias resolution
// ---------------------------------------------------------------------------

/** One target column and the source names accepted for it, in preference order. */
export interface HeaderAliasTarget<TTarget extends string = string> {
  readonly target: TTarget;
  /**
   * Accepted source names, best first. The first alias present in the header row wins, so
   * `Poliza` listed ahead of `PolizaNormalizada` means a file carrying both maps the raw
   * policy number rather than the normalized one.
   */
  readonly aliases: readonly string[];
}

/**
 * Resolves each target to the source column position it should read, under these rules:
 *
 *  1. Targets are resolved in list order, so an earlier target wins a source column that two
 *     targets accept. Order the list by how much the import depends on the target.
 *  2. Within a target, aliases are tried in order and the first one present wins.
 *  3. A source column is claimed by at most one target. A repeated header *name* is claimed
 *     as a whole, matching the renewals importer's long-standing behavior of resolving a
 *     mapping by header text rather than by position.
 *  4. A target no alias reaches is absent from the result rather than mapped to a guess.
 *
 * `isAvailable` lets a caller reserve positions an earlier pass already assigned; positions it
 * rejects are treated as though they were not in the file.
 */
export function matchHeaderAliases<TTarget extends string>(
  header: readonly string[],
  targets: readonly HeaderAliasTarget<TTarget>[],
  isAvailable?: (headerIndex: number) => boolean,
): Map<TTarget, number> {
  const keys = header.map((value) => headerMatchKey(value ?? ''));
  const claimedKeys = new Set<string>();
  const resolved = new Map<TTarget, number>();

  const available = (index: number): boolean =>
    keys[index].length > 0 && !claimedKeys.has(keys[index]) && (isAvailable === undefined || isAvailable(index));

  for (const { target, aliases } of targets) {
    for (const alias of aliases) {
      const aliasKey = headerMatchKey(alias);
      if (aliasKey.length === 0) continue;
      const index = keys.findIndex((key, position) => key === aliasKey && available(position));
      if (index === -1) continue;
      resolved.set(target, index);
      claimedKeys.add(keys[index]);
      break;
    }
  }

  return resolved;
}

/**
 * Every alias key that more than one target accepts.
 *
 * Used by tests to prove an alias table cannot make two columns collide. An overlap is not
 * automatically wrong — `matchHeaderAliases` resolves it by target order — but an unintended
 * one silently sends a column to the wrong field, so the set is asserted rather than assumed.
 */
export function overlappingAliasKeys(targets: readonly HeaderAliasTarget[]): string[] {
  const owners = new Map<string, Set<string>>();
  for (const { target, aliases } of targets) {
    for (const alias of aliases) {
      const key = headerMatchKey(alias);
      if (key.length === 0) continue;
      const set = owners.get(key) ?? new Set<string>();
      set.add(target);
      owners.set(key, set);
    }
  }
  return Array.from(owners)
    .filter(([, set]) => set.size > 1)
    .map(([key]) => key)
    .sort();
}

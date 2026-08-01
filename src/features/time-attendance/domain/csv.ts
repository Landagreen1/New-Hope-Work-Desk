// src/features/time-attendance/domain/csv.ts
// How a set of rows becomes a CSV file, and how that file is named.
//
// Serialisation is a rule, not a formatting detail. Requirement 15, criterion 4
// states that every exported field is enclosed in double quotation marks and
// that an embedded quotation mark is doubled; criterion 5 states that a header
// row names each column; criterion 3 states that the exported order is the
// order the requesting view displays; criterion 8 states that a filter set
// matching nothing still produces the header row. Those four are one function,
// so they live here as one function rather than as four conventions six view
// shapes would each have to remember.
//
// The inherited export is what the rule is written against. `PayrollProcessor`
// builds its file as `[headers.join(','), ...rows.map(r => r.join(','))]
// .join('\n')`, which quotes nothing: an employee name carrying a comma splits
// into two columns, a note carrying a newline splits into two rows, and a value
// carrying a quotation mark corrupts every field after it. The redesign's six
// exports all go through `toCsv`, so there is one answer to the delimiter rather
// than one per screen. (The payroll screen keeps its own export unchanged —
// Requirement 2, criterion 2 preserves that behaviour — so this module replaces
// nothing until that export is separately migrated.)
//
// Quoting is unconditional. Quoting only the fields that need it would be
// smaller output and a second rule — "needs it" being the delimiter, the quote
// character, both line endings, and leading or trailing whitespace — and a rule
// with five conditions is a rule with five ways to be wrong. Every field is
// quoted, so the writer has no branch a value can fall through.
//
// ## What this module does not do
//
// - **No authorisation.** The pay-rate and pay-amount columns of Requirement 15,
//   criterion 9 are removed from the column list before `toCsv` is called;
//   `withoutPayColumns` is the one place that removal happens, and it reads a
//   flag on the column rather than a role. The writer never sees an actor.
// - **No byte-order mark.** Excel needs a UTF-8 BOM to read non-ASCII correctly,
//   and prepending one here would put `\ufeff` inside the first header field.
//   The BOM belongs to the HTTP response, where the encoding is declared.
// - **No "no records matched" line inside the file.** Requirement 15, criterion 8
//   asks for that statement, and a comment line would break both the header-alone
//   rule and the round trip. `noRecordsNotice` produces the sentence; it travels
//   beside the file, in the response the route returns.
//
// Pure: no React, no I/O, no `Date.now()`. A column's value accessor is supplied
// by the caller and runs over rows the caller already holds, so the file is a
// function of its arguments alone.
//
// Requirements: 15.3 (the given row order is preserved), 15.4 (every field
// quoted, embedded quotes doubled), 15.5 (a header row naming each column),
// 15.6 (the file name carries the active range dates and every active filter
// value), 15.8 (an empty row set still produces the header row, and the
// statement that no records matched), 15.9 (pay columns are removable before
// serialisation).

import type { DateRange } from './types';

// ─── The wire format ─────────────────────────────────────────────────────────

/**
 * The field delimiter: a comma, as RFC 4180 section 2 defines it.
 *
 * Exported because a reader has to agree with the writer about it, and because
 * the round-trip test reads it from here rather than repeating the literal.
 */
export const CSV_DELIMITER = ',';

/**
 * The record separator: CRLF, as RFC 4180 section 2 requires.
 *
 * A bare LF is what the inherited export emits and what most readers also
 * accept, but CRLF is the one the specification names and the one Excel writes,
 * so it is the one that cannot be argued with. It matters here more than it
 * usually would: a field may itself contain a bare LF, a bare CR, or a CRLF —
 * `csvFieldArb` generates all three — and those are preserved inside the quoted
 * field exactly as given rather than normalised, so the separator has to be
 * something a reader distinguishes from field content by position rather than by
 * character.
 */
export const CSV_RECORD_SEPARATOR = '\r\n';

/** The quote character every field is enclosed in. */
const QUOTE = '"';

// ─── Columns ─────────────────────────────────────────────────────────────────

/**
 * A value a column accessor may return.
 *
 * Deliberately narrow. A `Date` is absent because the domain layer speaks in ISO
 * strings, and an object is absent because a column that wants a rendered
 * object should render it: a value arriving here as `[object Object]` would be a
 * silent data loss in a file somebody is about to send to a third party.
 */
export type CsvValue = string | number | boolean | null | undefined;

/**
 * One exported column: the name it is given in the header, and where its value
 * comes from.
 *
 * A label plus an accessor rather than a field name, so a column can carry a
 * derived value — a formatted hour count, a status label, a joined exception
 * list — without the row type having to hold a field for it. The six view
 * shapes of Requirement 15, criterion 1 each declare their own list, and the
 * export service drives `toCsv` from the list rather than from the row shape.
 *
 * Order is the list's order, in the header and in every row alike.
 */
export interface CsvColumn<T> {
  /** The header cell for this column. */
  label: string;
  /** This column's value for one row. */
  value: (row: T) => CsvValue;
  /**
   * True when the column carries a pay rate or a pay amount.
   *
   * Read by `withoutPayColumns` and by nothing else. Requirement 15, criterion 9
   * restricts these columns to Attendance_Administrator requests, and marking
   * them on the definition is what lets the restriction be applied once, in the
   * service, rather than in six column lists.
   */
  pay?: boolean;
}

/**
 * The columns with the pay-rate and pay-amount columns removed.
 *
 * The one implementation of Requirement 15, criterion 9's column restriction.
 * The export service calls it for a request that does not administer attendance
 * and passes the full list otherwise, so the decision is a single expression at
 * a single call site and the writer stays free of authorisation.
 *
 * Order among the remaining columns is unchanged, so a restricted export is the
 * unrestricted one with columns missing rather than a different file.
 */
export function withoutPayColumns<T>(
  columns: readonly CsvColumn<T>[],
): CsvColumn<T>[] {
  return columns.filter((column) => column.pay !== true);
}

// ─── Fields ──────────────────────────────────────────────────────────────────

/**
 * The text a value contributes to the file, before quoting.
 *
 * The normalisation a reader recovers: this is the string a round trip has to
 * return. Four cases, and nothing else reaches the file:
 *
 * - A string is used exactly as given. Every character in it survives — commas,
 *   quotation marks, both line endings, and non-ASCII text alike — because
 *   quoting carries them rather than escaping or stripping them.
 * - A finite number is rendered by `String`, so an integer keeps no decimal part
 *   and a fraction keeps the digits it has. Rounding is the caller's decision
 *   and belongs to the column, not to the writer.
 * - A non-finite number — `NaN`, `Infinity` — renders as the empty field. A
 *   spreadsheet reads `NaN` as text and quietly poisons a column of numbers,
 *   whereas an empty cell is the absence it actually represents.
 * - `null` and `undefined` render as the empty field, which is how an absent
 *   value is stated in CSV. There is no other way to say it, so the two are not
 *   distinguished, and a column that needs them distinguished renders its own
 *   marker.
 */
export function csvFieldText(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value;
}

/**
 * One field, enclosed in double quotation marks with embedded quotation marks
 * doubled.
 *
 * Requirement 15, criterion 4 in one expression, applied to every field of every
 * row and to every header cell. Doubling is the whole escape — RFC 4180 defines
 * no other — so a backslash carries no meaning here and is written through
 * unchanged.
 *
 * Requirements: 15.4
 */
export function csvField(value: CsvValue): string {
  return `${QUOTE}${csvFieldText(value).split(QUOTE).join(`${QUOTE}${QUOTE}`)}${QUOTE}`;
}

// ─── The file ────────────────────────────────────────────────────────────────

/**
 * The rows as a CSV file: a header row naming each column, then one record per
 * row, in the order given.
 *
 * Four rules, held by construction:
 *
 * - **Every field is quoted and embedded quotes are doubled** (criterion 4).
 *   Header cells included: a column labelled `Worked hours, adjusted` must not
 *   split into two columns.
 * - **The first line is the header** (criterion 5), taken from the column labels
 *   rather than from the row shape, so a column with no matching field still
 *   names itself.
 * - **The row order is the caller's** (criterion 3). Nothing is sorted here.
 *   The export service reads through the same service call the screen uses with
 *   paging removed, so the order it hands over is the order the screen renders
 *   (Correctness Property 33).
 * - **An empty row set produces the header alone** (criterion 8). No trailing
 *   separator follows it, so the file is exactly one line. The statement that no
 *   records matched is `noRecordsNotice`, returned beside the file.
 *
 * No trailing record separator is written in any case. RFC 4180 makes the final
 * break optional, and omitting it keeps the count of lines equal to the count of
 * records plus one — which is what makes the round trip unambiguous when the last
 * field itself ends in a newline.
 *
 * @throws RangeError if `columns` is empty. A file with no columns has no header
 *   to name anything and no fields to carry anything: every row would serialise
 *   to a blank line, and the caller would receive a plausible-looking file that
 *   had lost all of its data. Refused rather than produced.
 */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  if (columns.length === 0) {
    throw new RangeError('toCsv: at least one column is required');
  }

  const lines: string[] = [
    columns.map((column) => csvField(column.label)).join(CSV_DELIMITER),
  ];

  for (const row of rows) {
    lines.push(columns.map((column) => csvField(column.value(row))).join(CSV_DELIMITER));
  }

  return lines.join(CSV_RECORD_SEPARATOR);
}

// ─── The six view shapes ─────────────────────────────────────────────────────

/**
 * The six exports of Requirement 15, criterion 1, in the order the criterion
 * names them.
 *
 * One vocabulary, read by the route that validates the requested view, by the
 * export service that maps a view onto a service read and a column list, and by
 * the Exports view that renders one trigger per entry. A seventh export cannot
 * be added to a screen without appearing here first.
 *
 * Requirements: 15.1
 */
export const EXPORT_VIEWS = [
  'attendance_records',
  'exception_queue',
  'payroll_ready',
  'time_off_activity',
  'coverage_history',
  'employee_trends',
] as const;

/** One of the six exports. */
export type ExportView = (typeof EXPORT_VIEWS)[number];

/**
 * True when a string names one of the six exports.
 *
 * A view identifier arriving from a query string can be any string, and an
 * unrecognised one is refused rather than defaulted: answering a request for an
 * unknown view with the attendance records export would hand somebody a file
 * that does not contain what they asked for.
 */
export function isExportView(value: string): value is ExportView {
  return (EXPORT_VIEWS as readonly string[]).includes(value);
}

// ─── The file name ───────────────────────────────────────────────────────────

/**
 * A filter value as it appears in a file name.
 *
 * The three scalar kinds a filter carries: a code or identifier, a count, and a
 * flag. `payrollBlocking: true` is as much an active filter as
 * `department: 'sales'`, and Requirement 15, criterion 6 asks for the value of
 * each.
 */
export type FilterValue = string | number | boolean;

/**
 * The filters active in the requesting view, as field name to value.
 *
 * Keyed by the filter's own name so the name travels into the file name beside
 * its value: `department-sales` says what `sales` was filtering. A list-valued
 * filter carries its values in the order the view applied them.
 *
 * A field is inactive — and contributes nothing to the file name — when its
 * value is `undefined`, `null`, the empty string, or an empty array. The first
 * three are how an unset control reports itself. The empty array is the empty
 * intersection, which matches no record and which the module's readers refuse to
 * issue at all (`shared/record-query.ts` reports it as unsatisfiable), so it has
 * no value to name.
 *
 * Requirements: 15.6
 */
export type FilterSummary = Readonly<
  Record<string, FilterValue | readonly FilterValue[] | null | undefined>
>;

/**
 * Every character a file name may not carry, replaced by a single hyphen.
 *
 * An allow-list rather than a deny-list, because the union of what Windows,
 * macOS, and Linux each refuse is wider than it looks: `< > : " / \ | ? *` and
 * every control character on Windows, `/` and NUL on POSIX, and `:` in the
 * classic Mac path convention. Letters and digits are what remains once all
 * three are satisfied, and a run of anything else becomes one hyphen — so
 * `Sales & Service` is `Sales-Service` rather than `Sales---Service`.
 *
 * The underscore is excluded too, though it is legal, because the file name uses
 * it to separate groups. A value carrying one would otherwise read as two
 * groups.
 *
 * Non-ASCII text is replaced rather than transliterated. Transliteration is a
 * locale decision — `ö` to `o` or to `oe` — and a file name is not the place to
 * make it.
 */
const ILLEGAL_RUN = /[^A-Za-z0-9]+/g;

/** A hyphen run left at either end of a token by the replacement above. */
const EDGE_HYPHENS = /^-+|-+$/g;

/**
 * The MS-DOS device names Windows still refuses as a file name, whatever
 * extension follows.
 *
 * `CON.csv` cannot be created on Windows, so a base name that lands on one of
 * these is prefixed rather than offered.
 */
const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * One value as a file-name token: letters, digits, and interior hyphens only.
 *
 * Exported because it is the only description of what a value looks like once it
 * is in a file name. Requirement 15, criterion 6 asks for the value to be
 * included and Correctness Property 32 asks for the name to carry no illegal
 * character, and those two can only both hold of the sanitised form — so a
 * caller asking "is this value in the name?" asks it of `fileNameToken(value)`.
 *
 * A value made entirely of illegal characters — `🙂`, `///` — tokenises to the
 * empty string and contributes no group, which is the honest outcome: there is
 * nothing of it a file name can carry.
 */
export function fileNameToken(value: FilterValue): string {
  return String(value).replace(ILLEGAL_RUN, '-').replace(EDGE_HYPHENS, '');
}

/** The tokens of one filter field, or none when the field is inactive. */
function filterGroup(field: string, value: FilterSummary[string]): string | null {
  if (value === null || value === undefined) return null;

  const values = Array.isArray(value) ? value : [value as FilterValue];
  const tokens = values.map(fileNameToken).filter((token) => token !== '');
  if (tokens.length === 0) return null;

  const name = fileNameToken(field);
  return name === '' ? tokens.join('-') : `${name}-${tokens.join('-')}`;
}

/**
 * The file name for one export: the view, the active range dates, and every
 * active filter value, as a `.csv` name that is legal on Windows and POSIX
 * alike.
 *
 * Requirement 15, criterion 6 asks for the range and the filters in the name so
 * that a file, once downloaded, still says what it contains — the inherited
 * payroll export names its period and nothing else, so two exports of the same
 * fortnight under different filters arrive as `payroll-…(1).csv`. Here the
 * filters are in the name, so the two files are told apart by reading them.
 *
 * The shape is groups joined by underscores, with hyphens inside a group:
 *
 * ```text
 * exception-queue_2026-01-01_to_2026-01-31_department-sales_status-late-absent.csv
 * ```
 *
 * Legality is by construction rather than by inspection. Every group is built
 * from `fileNameToken`, which admits letters, digits, and interior hyphens and
 * nothing else, so the name carries no `< > : " / \ | ? *`, no path separator,
 * no control character, no leading or trailing space, and no dot but the one
 * before the extension — which also means it cannot end in a dot or a space. The
 * assembled base name is checked against the MS-DOS device names, which Windows
 * refuses whatever extension follows; the view group makes that unreachable
 * today, and the check is what keeps it unreachable if a view is ever named
 * `aux`.
 *
 * The name is not truncated. Criterion 6 asks for every active filter value, and
 * a name that dropped the last of them to fit a length budget would be a name
 * that does not say what the file contains. A view's active filter set is a
 * handful of codes and identifiers, so the result sits well inside the 255-byte
 * component limit in practice.
 *
 * @param view Which of the six exports this is.
 * @param range The active date range, inclusive at both ends. Both bounds appear.
 * @param filters The filters active in the requesting view. Inactive fields are
 *   omitted, so an unfiltered export is named by its view and range alone.
 *
 * Requirements: 15.6
 */
export function exportFileName(
  view: ExportView,
  range: DateRange,
  filters: FilterSummary = {},
): string {
  const from = fileNameToken(range.from);
  const to = fileNameToken(range.to);

  const groups: string[] = [fileNameToken(view)];

  // Both bounds, joined so the name reads as a range. A bound that tokenises to
  // nothing is dropped rather than left as a dangling `_to_`: a range control
  // mid-edit can hold one date, and the file it exports is still named.
  if (from !== '' && to !== '') groups.push(`${from}_to_${to}`);
  else if (from !== '') groups.push(from);
  else if (to !== '') groups.push(to);

  for (const [field, value] of Object.entries(filters)) {
    const group = filterGroup(field, value);
    if (group !== null) groups.push(group);
  }

  const base = groups.filter((group) => group !== '').join('_');
  const safeBase =
    base === '' || RESERVED_DEVICE_NAMES.has(base.toUpperCase()) ? `export-${base}` : base;

  return `${safeBase}.csv`;
}

// ─── The empty export ────────────────────────────────────────────────────────

/**
 * The sentence an export states when its filters matched no record.
 *
 * Requirement 15, criterion 8 has two halves: the file still carries the header
 * row, which `toCsv` does for an empty row set, and the export states that no
 * records matched, which is this. It is a sentence rather than a line in the
 * file because a file whose first line is prose is not the file criterion 5
 * describes, and because a reader parsing the export would take the sentence for
 * data.
 *
 * The range and the filters are named in it for the same reason they are named
 * in the file name: "no records matched" is not an answer without them, and an
 * administrator seeing an empty export needs to know which question was asked.
 * Values are shown as given rather than as file-name tokens — this is prose, and
 * it has no illegal characters to avoid.
 *
 * Requirements: 15.8
 */
export function noRecordsNotice(range: DateRange, filters: FilterSummary = {}): string {
  const stated: string[] = [];
  for (const [field, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    const values = (Array.isArray(value) ? value : [value as FilterValue])
      .map((entry) => String(entry))
      .filter((entry) => entry !== '');
    if (values.length === 0) continue;
    stated.push(`${field}: ${values.join(', ')}`);
  }

  const scope = `${range.from} to ${range.to}`;
  return stated.length === 0
    ? `No records matched ${scope}.`
    : `No records matched ${scope} with ${stated.join('; ')}.`;
}

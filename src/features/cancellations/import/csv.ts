/**
 * RFC 4180 reader and writer for cancellation report imports.
 *
 * This module exists because Requirement 24 demands that an imported row survive
 * the round trip character for character. It is deliberately separate from
 * `parseCsv` in `src/features/renewals/api.ts`, which trims every header and
 * field, drops rows it considers empty (shifting every later data row number),
 * and discards every carriage return (destroying an embedded CRLF). None of
 * those behaviors can satisfy Requirement 24, so nothing here reuses it.
 *
 * Everything in this file is pure and synchronous: no React, no Supabase, no
 * I/O, no clock, no randomness.
 *
 * Decoding follows Requirement 24 criterion 1. A decoded field value is the
 * character sequence obtained after removing the enclosing quotation marks of a
 * quoted value and replacing each doubled quotation mark inside a quoted value
 * with one quotation mark. Nothing else happens to it: no whitespace trimming,
 * no case folding, no Unicode normalization, no numeric conversion, no date
 * conversion, no truncation.
 */

const BOM = '\uFEFF';
const QUOTE = '"';
const COMMA = ',';
const CR = '\r';
const LF = '\n';

/** Result of reading a cancellation report file. */
export interface ParsedCsv {
  /**
   * Decoded field values of the header record, in source column order. A single
   * leading byte order mark is removed from the first field (Requirement 24.6);
   * no header is trimmed, case folded, or otherwise altered.
   */
  header: string[];
  /**
   * Decoded field values of every data record, in source row order and source
   * column order. Records are kept verbatim, including a record whose field
   * count differs from the header's and a record produced by a blank line, so
   * that data row numbering matches the source file. Arity and content
   * validation belong to later import stages.
   */
  rows: string[][];
  /**
   * Data row number of the record at the same index of `rows`, counted from 1
   * for the first record after the header (Requirement 8.6). Carried explicitly
   * so a later stage that filters rows can still report source row numbers.
   */
  rowNumbers: number[];
}

/**
 * Splits CSV text into records of decoded field values.
 *
 * Reader rules:
 * - A quotation mark opens a quoted field only as the first character of a
 *   field. Anywhere else it is literal data, so `Ann "Annie" Diaz` keeps both
 *   quotation marks in the same count and position (Requirement 24.4).
 * - Inside a quoted field, `""` decodes to one quotation mark, a single
 *   quotation mark closes the field, and every other character, carriage return
 *   and line feed included, is data. A quoted `MensajeEmail` value with
 *   embedded line breaks is therefore one field of one record, with CRLF kept
 *   as CRLF and LF kept as LF (Requirement 24.7).
 * - After a quoted field closes, any characters before the next delimiter are
 *   appended as literal data rather than discarded.
 * - Outside a quoted field, LF and CRLF end a record. These are the only two
 *   record separators Requirement 24.6 recognizes, so a lone carriage return is
 *   read as field data instead of as a separator.
 * - A record separator at the very end of the input terminates the last record
 *   instead of starting an empty one. A blank line anywhere else is a record
 *   holding one empty field and is kept.
 */
function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  let recordPending = false;
  let index = 0;

  const endField = () => {
    record.push(field);
    field = '';
    atFieldStart = true;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    recordPending = false;
  };

  while (index < text.length) {
    const character = text[index];

    if (inQuotes) {
      if (character === QUOTE) {
        if (text[index + 1] === QUOTE) {
          field += QUOTE;
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }

    if (character === QUOTE && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      recordPending = true;
      index += 1;
      continue;
    }

    if (character === COMMA) {
      recordPending = true;
      endField();
      index += 1;
      continue;
    }

    if (character === LF) {
      endRecord();
      index += 1;
      continue;
    }

    if (character === CR && text[index + 1] === LF) {
      endRecord();
      index += 2;
      continue;
    }

    field += character;
    atFieldStart = false;
    recordPending = true;
    index += 1;
  }

  if (recordPending) {
    endField();
    records.push(record);
  }

  return records;
}

/** True when serializing `value` requires quoting it. */
function needsQuoting(value: string): boolean {
  return (
    value.indexOf(COMMA) !== -1 ||
    value.indexOf(QUOTE) !== -1 ||
    value.indexOf(CR) !== -1 ||
    value.indexOf(LF) !== -1
  );
}

/** Removes one leading byte order mark, if present, from the start of `text`. */
function stripLeadingBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * Reads a cancellation report file into its header record and its data records.
 *
 * The first record is the header; every later record is a data row. A single
 * leading byte order mark is removed from the start of the file, which is the
 * start of the first header field; a byte order mark anywhere else in the file
 * is field data and is kept.
 *
 * Requirements: 24.1, 24.2, 24.4, 24.7, 8.6.
 */
export function parseCsv(text: string): ParsedCsv {
  const records = parseRecords(stripLeadingBom(text));
  if (records.length === 0) return { header: [], rows: [], rowNumbers: [] };

  const [header, ...rows] = records;
  return { header, rows, rowNumbers: rows.map((_, offset) => offset + 1) };
}

/**
 * Reads one CSV record into its decoded field values.
 *
 * An empty string is one empty field, because a record always holds at least
 * one field. Where `row` holds more than one record, only the first is
 * returned; `normalizeAcceptable` reads every record, so a caller comparing the
 * two cannot lose the extra records silently.
 *
 * Requirements: 24.1, 24.4, 24.7.
 */
export function parseRow(row: string): string[] {
  const records = parseRecords(row);
  return records.length === 0 ? [''] : records[0];
}

/**
 * Writes decoded field values back to one CSV record, with no trailing record
 * separator.
 *
 * A field is quoted only when it contains a comma, a quotation mark, a carriage
 * return, or a line feed; inner quotation marks are doubled; fields are joined
 * with a comma. Field count, field order, and every character of every field
 * value are preserved.
 *
 * Requirements: 24.2, 24.4, 24.7.
 */
export function serializeRawRow(values: string[]): string {
  return values
    .map((value) => (needsQuoting(value) ? `${QUOTE}${value.split(QUOTE).join(QUOTE + QUOTE)}${QUOTE}` : value))
    .join(COMMA);
}

/**
 * Rewrites a CSV row into the canonical form that collapses exactly the
 * acceptable differences of Requirement 24 criterion 6, so two rows are equal
 * under that criterion when, and only when, their normalized forms are equal
 * strings.
 *
 * It decodes the row and writes it back with canonical quoting, which collapses
 * these four differences and no others:
 * 1. quoting characters present or absent around a field that contains no
 *    comma, no quotation mark, and no line break;
 * 2. an empty field written as zero characters or as two quotation marks;
 * 3. the record separator ending the row written as LF or as CRLF, including
 *    when it is absent because the row ends the file;
 * 4. a byte order mark present or absent at the start of the row, which is the
 *    start of the file for the first row.
 *
 * Every difference criterion 6 calls unacceptable survives normalization,
 * because canonical writing is injective over decoded field values: a
 * difference in field count, field order, character content, whitespace, letter
 * case, or an embedded line break inside a field produces a different string.
 * In particular an embedded CRLF does not normalize to an embedded LF, `a` does
 * not normalize to `a `, and `A` does not normalize to `a`.
 *
 * The one difference it collapses beyond the four listed is the quoting form of
 * a field that does contain a comma, quotation mark, or line break, since both
 * forms decode to the same characters. That form only reaches this function
 * from a malformed source row: `serializeRawRow` always quotes such a field.
 * Criterion 6 defines its unacceptable differences over decoded field values,
 * all of which remain distinguished.
 *
 * Requirements: 24.2, 24.6, 24.7.
 */
export function normalizeAcceptable(row: string): string {
  return parseRecords(stripLeadingBom(row)).map(serializeRawRow).join(LF);
}

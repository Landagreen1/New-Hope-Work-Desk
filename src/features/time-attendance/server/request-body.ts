// src/features/time-attendance/server/request-body.ts
// JSON request bodies turned into the inputs the services accept, without
// trusting anything in them.
//
// `request-query.ts` is the same idea for query strings, and the two share their
// judgements rather than repeating them: a calendar date is checked by
// `assertCalendarDate` and an identifier by `RECORD_ID_PATTERN` whichever half of
// the request it arrived in, so a malformed value reads the same either way.
//
// A body differs from a query string in one way that matters. A query string is
// always a bag of strings, and every value has to be parsed. A body carries real
// JSON types, so `{"page": "2"}` and `{"page": 2}` are different values, and a
// reader that accepted both by coercion would also accept `{"acknowledged":
// "false"}` as true. Nothing here coerces: a field of the wrong type is reported
// as the invalid parameter it is, naming the field so a screen can attach the
// message to the control that produced it.
//
// The same rule as the query parser applies to unrecognised values: reported,
// never dropped. A decision whose `decision` field is misspelt must not be
// answered as though it were something else, and a coverage assignment whose
// `date` cannot be read must not be silently skipped — an administrator who
// assigned four dates and got three would have no way to tell.
//
// Nothing arithmetical is read here at all. The working-day count, the balance
// movement, and the coverage projection are all computed by the service from
// stored rows, which is the point of `pto-service.ts`. These readers carry
// identifiers, dates, enumerated choices, and free text.
//
// Requirements: 21.15 (a body naming data outside the permitted set cannot widen
// a write), 22.16 (a refused write states its reason and the field it came from).

import type { DateRange } from '../domain/types';
import { ApiRequestError } from './api-response';
import { RECORD_ID_PATTERN, assertCalendarDate } from './request-query';

/** A JSON object body, as it arrives. */
export type JsonBody = Record<string, unknown>;

/** Stated when the request carried no readable JSON object. */
export const BODY_REQUIRED_MESSAGE = 'This request needs a JSON object body.';

function invalidField(field: string, message: string): ApiRequestError {
  return new ApiRequestError('invalid_parameter', message, field);
}

function unacceptedValue(
  field: string,
  value: unknown,
  accepted: readonly string[],
): ApiRequestError {
  return invalidField(
    field,
    `${field}: "${String(value)}" is not accepted. Accepted values are ${accepted.join(', ')}.`,
  );
}

/**
 * The request's body as a JSON object.
 *
 * A body that is absent, malformed, or not an object is reported as one invalid
 * parameter rather than as several missing fields. An array is refused too: the
 * mutation endpoints in this module each carry one action, and `/api/schedules`
 * is the only route that accepts an array body.
 */
export async function readJsonBody(request: Request): Promise<JsonBody> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ApiRequestError('invalid_parameter', BODY_REQUIRED_MESSAGE, 'body');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiRequestError('invalid_parameter', BODY_REQUIRED_MESSAGE, 'body');
  }
  return parsed as JsonBody;
}

/**
 * A string field with at least one non-whitespace character, or undefined when
 * the field is absent or null.
 *
 * An explicit `null` reads as absent, because that is what a cleared text control
 * sends. A whitespace-only string also reads as absent: `reasonWithContent` in
 * the domain layer treats it as no reason, and accepting it here would let a
 * space satisfy a field that requires a reason.
 *
 * `label` is what a refusal names, and defaults to the field. A reader inside a
 * list entry reads `date` and reports `coverage_assignments[0].date`, so the
 * message names the control the caller can see while the lookup stays the key the
 * entry actually carries.
 */
export function optionalText(
  body: JsonBody,
  field: string,
  label: string = field,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'string') {
    throw invalidField(label, `${label} must be text`);
  }
  return value.trim() === '' ? undefined : value;
}

/** A string field the write cannot proceed without. */
export function requiredText(body: JsonBody, field: string, label: string = field): string {
  const value = optionalText(body, field, label);
  if (value === undefined) {
    throw invalidField(label, `${label} is required as text with at least one character`);
  }
  return value;
}

/** A value from a closed set, or undefined when the field is absent. */
export function optionalChoice<T extends string>(
  body: JsonBody,
  field: string,
  accepted: readonly T[],
): T | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'string' || !accepted.includes(value as T)) {
    throw unacceptedValue(field, value, accepted);
  }
  return value as T;
}

/**
 * A list of values from a closed set, or undefined when the field is absent.
 *
 * Every entry is checked and an unaccepted one is reported by its position rather
 * than dropped, for the reason `optionalRanges` reports one: a configuration list
 * stored with four of the five values an administrator submitted has changed
 * something nobody asked to change, and nothing on screen would say so.
 *
 * An explicit empty array is an empty list, not an absent field. For the one list
 * this reads — the unpaid break types — those are different statements: no unpaid
 * types means every break is paid, and an absent field means leave the stored ones
 * alone.
 *
 * Duplicates are carried through as sent. Whether a repeated value matters belongs
 * to whoever stores the list.
 */
export function optionalChoiceList<T extends string>(
  body: JsonBody,
  field: string,
  accepted: readonly T[],
): readonly T[] | undefined {
  const entries = optionalArray(body, field);
  if (entries === undefined) return undefined;

  return entries.map((entry, index) => {
    if (typeof entry !== 'string' || !accepted.includes(entry as T)) {
      throw unacceptedValue(`${field}[${index}]`, entry, accepted);
    }
    return entry as T;
  });
}

/** A value from a closed set that the write cannot proceed without. */
export function requiredChoice<T extends string>(
  body: JsonBody,
  field: string,
  accepted: readonly T[],
): T {
  const value = optionalChoice(body, field, accepted);
  if (value === undefined) {
    throw invalidField(field, `${field} is required, as one of ${accepted.join(', ')}`);
  }
  return value;
}

/**
 * A boolean field, or undefined when it is absent.
 *
 * Only a real boolean. `"true"` is refused rather than read, because the fields
 * this reads are the guard's escapes: acknowledging a coverage shortfall is a
 * deliberate act, and inferring it from a truthy string is how a typo comes to
 * mean yes.
 */
export function optionalFlag(body: JsonBody, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'boolean') {
    throw unacceptedValue(field, value, ['true', 'false']);
  }
  return value;
}

/**
 * A whole-number field, or undefined when it is absent.
 *
 * Only a real number, and only an integer. `"45"` is refused rather than read,
 * for the reason `optionalFlag` gives: the figures this reads are corrections to
 * stored minute counts, and a value the caller did not mean to send is worse than
 * a refusal they can see. `Number.isInteger` also refuses `NaN` and the
 * infinities, which JSON cannot carry but a computed body can.
 *
 * The acceptable range belongs to whoever stores the figure —
 * `attendance_apply_correction` refuses anything outside 0 to 1440 minutes — so
 * it is not judged a second time here.
 */
export function optionalWholeNumber(
  body: JsonBody,
  field: string,
  label: string = field,
): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidField(label, `${label} must be a whole number`);
  }
  return value;
}

/** A whole number the write cannot proceed without. */
export function requiredWholeNumber(
  body: JsonBody,
  field: string,
  label: string = field,
): number {
  const value = optionalWholeNumber(body, field, label);
  if (value === undefined) {
    throw invalidField(label, `${label} is required as a whole number`);
  }
  return value;
}

/** A `YYYY-MM-DD` field that names a real date, or undefined when absent. */
export function optionalBodyDate(
  body: JsonBody,
  field: string,
  label: string = field,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'string') {
    throw new ApiRequestError(
      'invalid_range',
      `${label} must be a calendar date as YYYY-MM-DD`,
      label,
    );
  }
  return assertCalendarDate(value, label);
}

/** A calendar date the write cannot proceed without. */
export function requiredBodyDate(
  body: JsonBody,
  field: string,
  label: string = field,
): string {
  const value = optionalBodyDate(body, field, label);
  if (value === undefined) {
    throw new ApiRequestError('invalid_range', `${label} is required as YYYY-MM-DD`, label);
  }
  return value;
}

/**
 * An identifier field that addresses one stored row, or undefined when absent.
 *
 * Shape-checked for the reason `requiredRecordId` gives: an unparseable value
 * reaches Postgres, returns an invalid-uuid-syntax error, and the failure
 * contract can then only report it as a retryable 500 — the wrong answer for an
 * input no amount of retrying will fix.
 */
export function optionalBodyRecordId(
  body: JsonBody,
  field: string,
  label: string = field,
): string | undefined {
  const value = optionalText(body, field, label);
  if (value === undefined) return undefined;

  if (!RECORD_ID_PATTERN.test(value)) {
    throw invalidField(label, `${label} must be a record identifier, received "${value}"`);
  }
  return value;
}

/** An identifier the write cannot proceed without. */
export function requiredBodyRecordId(
  body: JsonBody,
  field: string,
  label: string = field,
): string {
  const value = optionalBodyRecordId(body, field, label);
  if (value === undefined) {
    throw invalidField(label, `${label} is required as a record identifier`);
  }
  return value;
}

/**
 * An array field, or undefined when it is absent.
 *
 * An explicit empty array is kept as an empty array rather than read as absent.
 * The two say different things to the service: absent means the decision carries
 * no ranges, and empty means the caller sent a list with nothing in it, which
 * `assertDecisionPayload` refuses for the decisions that require one.
 */
function optionalArray(body: JsonBody, field: string): unknown[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;

  if (!Array.isArray(value)) {
    throw invalidField(field, `${field} must be a list`);
  }
  return value;
}

/**
 * A list of `{ from, to }` date ranges, or undefined when the field is absent.
 *
 * Every entry is read, and an entry that cannot be read is reported rather than
 * dropped. A partial approval whose declined range was silently discarded would
 * be committed as a different decision than the one the administrator submitted.
 *
 * Range order and width are the service's to judge, in `assertRange`, so there is
 * one place a range is judged rather than two that can disagree.
 */
export function optionalRanges(body: JsonBody, field: string): DateRange[] | undefined {
  const entries = optionalArray(body, field);
  if (entries === undefined) return undefined;

  return entries.map((entry, index) => {
    const label = `${field}[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalidField(label, `${label} must be an object with from and to dates`);
    }

    const source = entry as JsonBody;
    return {
      from: requiredBodyDate(source, 'from', `${label}.from`),
      to: requiredBodyDate(source, 'to', `${label}.to`),
    };
  });
}

/**
 * The entries of a list field as JSON objects, or undefined when it is absent.
 *
 * Used for the coverage assignments, whose fields the calling route reads: the
 * shape belongs to that endpoint, the "every entry is an object" rule belongs
 * here.
 */
export function optionalObjectList(body: JsonBody, field: string): JsonBody[] | undefined {
  const entries = optionalArray(body, field);
  if (entries === undefined) return undefined;

  return entries.map((entry, index) => {
    const label = `${field}[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalidField(label, `${label} must be an object`);
    }
    return entry as JsonBody;
  });
}

/**
 * A nested object the write cannot proceed without.
 *
 * `readJsonBody` one level down: a correction that adds a whole clock session
 * carries its instants and its break minutes in one object, and the readers above
 * then read that object's fields with a label naming the path the caller sent. An
 * array is refused here for the same reason it is at the top level.
 */
export function requiredBodyObject(
  body: JsonBody,
  field: string,
  label: string = field,
): JsonBody {
  const value = body[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidField(label, `${label} must be an object`);
  }
  return value as JsonBody;
}

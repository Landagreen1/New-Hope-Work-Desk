// src/features/cancellations/render/__tests__/render.test.ts
//
// Feature: policy-follow-up-renewals-cancellations, task 12.4 — renderer unit tests over the pure
// module `src/features/cancellations/render/renderMessage.ts`.
//
// **Validates: Requirements 11.2, 11.6, 11.7, 13.2, 13.3, 14.1, 14.4, 14.5, 14.8, 14.9, 14.15, 25.2**
//
// The module is pure — no React, no Supabase client, no provider, no clock, no randomness — so
// every case here drives the real `renderMessage` with real template rows, real case rows, and the
// real content gate. No mock is used and none is needed, which is also why Requirement 25.3 has
// nothing to hold against this file.
//
// The forbidden-token rule of Requirement 14.12 is deliberately absent: the design assigns it to
// Property 3 in `forbidden-token.property.test.ts` (task 12.3), which drives it over generated
// worlds. This file is the example and boundary half — the two together are the renderer's
// coverage.
//
// Beyond the coverage list of task 12.4, these cases pin the decisions the implementation took
// where the requirements left room, because each is a place a later change could regress in
// silence:
//
//  1. **Bilingual is a render language, never a stored row.** Template rows are English or Spanish
//     only; a Bilingual body is both segments plus exactly one `bilingual_separator`. Differing
//     `preferred_language` values resolve to Bilingual, so does zero contacts, and a combined
//     message is always Bilingual (Requirement 11.8).
//  2. **The subject separator is `' / '`, not the body separator** — Requirement 11.7 names no
//     subject separator and `bilingual_separator` defaults to a line-feed-bearing value no subject
//     line may carry. A zero-character stored subject contributes nothing and leaves no dangling
//     separator, and the SMS subject is always zero characters (Requirement 14.15).
//  3. **The required-element guarantee.** The statement, the included dates, and the contact
//     request are checked against each assembled segment and appended when absent, so
//     Requirements 14.2/14.3/14.5 and 11.7/14.6 hold for any stored template. Sender name,
//     Agency_Name, and Office_Phone are guaranteed once over the WHOLE body, appended as a closing
//     line only when missing, so a bilingual SMS carries one signature rather than two.
//  4. **A combined SMS is the one body assembled without the stored `body`** — Requirement 13.3's
//     640-character cap plus "no policy numbers" cannot be met from a shared email-shaped body — so
//     it is built from the stored statement, the count and earliest date, and the stored contact
//     request, with a last-resort truncation setting `truncated: true`.
//  5. **Group-aware tokens.** In a combined message `Policy_Number` becomes the ordered list on
//     email and absent on SMS, `Cancellation_Date` becomes the earliest date, and `Carrier`,
//     `Cancellation_Reason`, and `Amount_Due` go absent to the Requirement 14.11 fallback path
//     because they differ per case.
//  6. **The empty-token line drop.** A line carrying at least one token that rendered no token text
//     at all is dropped whole; a line with no token is never touched. 11 of the 58 real `eficacia`
//     rows carry an empty `MontoDebido`, so `Amount due: {{Amount_Due}}` would otherwise ship as
//     `Amount due:`.
//  7. **Ordering is by code unit, not `localeCompare`,** so it does not depend on the locale data of
//     the host that renders the message; month names are explicit tables and amounts are grouped by
//     hand.
//  8. **`fallback_text` keys are bare token names with no delimiter,** and a stored empty string and
//     an absent key both render zero characters (Requirement 14.11).

import { describe, expect, it } from 'vitest';

import {
  BILINGUAL_SEGMENT_ORDER,
  FALLBACK_TOKEN_NAMES,
  MAX_COMBINED_CASES,
  MAX_COMBINED_SMS_BODY_LENGTH,
  RenderInputError,
  SUBJECT_SEGMENT_SEPARATOR,
  TOKEN_DELIMITER,
  TOKEN_NAMES,
  TOUCHPOINTS,
  containsOfficePhone,
  formatEffectiveDate,
  isAbsentMarker,
  officePhoneDigits,
  orderCasesForRender,
  renderMessage,
  resolveRenderLanguage,
  resolveSenderName,
  resolveTouchpoint,
  segmentLanguages,
  selectTemplateVersion,
  substituteTokens,
  tokenPlaceholder,
} from '../renderMessage';
import type {
  ProhibitedPhraseRow,
  RenderBlocked,
  RenderCase,
  RenderMessageInput,
  RenderRendered,
  RenderResult,
  RenderSettings,
  TemplateVersionRow,
  Touchpoint,
} from '../renderMessage';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The `cancellation_settings` defaults of migration v1.10.4, seeded office phone included. */
const SETTINGS: RenderSettings = {
  office_phone: '(704) 824-3130',
  agency_name: 'New Hope Insurance Agency',
  bilingual_separator: '\n---\n',
};

const OFFICE_PHONE_DIGITS = '7048243130';

const EN_STATEMENT = 'According to our records, this policy is scheduled for cancellation.';
const ES_STATEMENT = 'Según nuestros registros, esta póliza está programada para cancelación.';
const EN_REQUEST = `Please contact us on or before ${tokenPlaceholder(TOKEN_NAMES.contactDeadline)} to review your options.`;
const ES_REQUEST = `Comuníquese con nosotros a más tardar el ${tokenPlaceholder(TOKEN_NAMES.contactDeadline)} para revisar sus opciones.`;

/** The two stored statements as a customer reads them, once the deadline token is substituted. */
const EN_REQUEST_JULY = 'Please contact us on or before July 31, 2026 to review your options.';
const ES_REQUEST_JULY = 'Comuníquese con nosotros a más tardar el 31 de julio de 2026 para revisar sus opciones.';

/**
 * `fallback_text` as task 7.10 seeds it: BARE token names, no delimiter. `Amount_Due` is stored as
 * an empty string deliberately, which is the Requirement 14.11 "zero characters" case and the input
 * to the empty-token line drop.
 */
const EN_FALLBACK: Readonly<Record<string, string | null>> = {
  [TOKEN_NAMES.carrier]: 'your carrier',
  [TOKEN_NAMES.cancellationReason]: 'a change on the policy',
  [TOKEN_NAMES.producerName]: 'our team',
  [TOKEN_NAMES.amountDue]: '',
};

const ES_FALLBACK: Readonly<Record<string, string | null>> = {
  [TOKEN_NAMES.carrier]: 'su aseguradora',
  [TOKEN_NAMES.cancellationReason]: 'un cambio en la póliza',
  [TOKEN_NAMES.producerName]: 'nuestro equipo',
  [TOKEN_NAMES.amountDue]: '',
};

/**
 * A seeded `cancellation_prohibited_phrases` list that matches nothing this file renders, so every
 * `ok: true` case proves the gate ran and passed rather than that it was never given anything.
 */
const BASE_PHRASES: readonly ProhibitedPhraseRow[] = [
  { id: 'pp-1', phrase: 'your policy will be reinstated', language: 'English', is_active: true },
  { id: 'pp-2', phrase: 'payment guarantees continued coverage', language: 'English', is_active: true },
  { id: 'pp-3', phrase: 'send your card number', language: 'English', is_active: true },
  { id: 'pp-4', phrase: 'su póliza será reactivada', language: 'Spanish', is_active: true },
];

/** The email-shaped stored body, one optional value per line, as task 7.10 seeds it. */
function englishBody(touchpoint: Touchpoint): string {
  return [
    `Hello ${tokenPlaceholder(TOKEN_NAMES.customerName)},`,
    '',
    tokenPlaceholder(TOKEN_NAMES.cancellationStatement),
    '',
    `Reminder tier ${touchpoint}.`,
    `Policy: ${tokenPlaceholder(TOKEN_NAMES.policyNumber)}`,
    `Cancellation effective date: ${tokenPlaceholder(TOKEN_NAMES.cancellationDate)}`,
    `Carrier: ${tokenPlaceholder(TOKEN_NAMES.carrier)}`,
    `Reason: ${tokenPlaceholder(TOKEN_NAMES.cancellationReason)}`,
    `Amount due: ${tokenPlaceholder(TOKEN_NAMES.amountDue)}`,
    `Your agent: ${tokenPlaceholder(TOKEN_NAMES.producerName)}`,
    '',
    tokenPlaceholder(TOKEN_NAMES.contactRequest),
    '',
    tokenPlaceholder(TOKEN_NAMES.senderName),
    `${tokenPlaceholder(TOKEN_NAMES.agencyName)} - ${tokenPlaceholder(TOKEN_NAMES.officePhone)}`,
  ].join('\n');
}

function spanishBody(touchpoint: Touchpoint): string {
  return [
    `Hola ${tokenPlaceholder(TOKEN_NAMES.customerName)},`,
    '',
    tokenPlaceholder(TOKEN_NAMES.cancellationStatement),
    '',
    `Nivel de recordatorio ${touchpoint}.`,
    `Póliza: ${tokenPlaceholder(TOKEN_NAMES.policyNumber)}`,
    `Fecha efectiva de cancelación: ${tokenPlaceholder(TOKEN_NAMES.cancellationDate)}`,
    `Aseguradora: ${tokenPlaceholder(TOKEN_NAMES.carrier)}`,
    `Motivo: ${tokenPlaceholder(TOKEN_NAMES.cancellationReason)}`,
    `Monto debido: ${tokenPlaceholder(TOKEN_NAMES.amountDue)}`,
    `Su agente: ${tokenPlaceholder(TOKEN_NAMES.producerName)}`,
    '',
    tokenPlaceholder(TOKEN_NAMES.contactRequest),
    '',
    tokenPlaceholder(TOKEN_NAMES.senderName),
    `${tokenPlaceholder(TOKEN_NAMES.agencyName)} - ${tokenPlaceholder(TOKEN_NAMES.officePhone)}`,
  ].join('\n');
}

interface TemplateOverrides {
  readonly englishSubject?: string;
  readonly spanishSubject?: string;
  readonly englishBody?: string;
  readonly spanishBody?: string;
  readonly englishStatement?: string;
  readonly spanishStatement?: string;
  readonly englishRequest?: string;
  readonly spanishRequest?: string;
  readonly englishFallback?: Readonly<Record<string, string | null>> | null;
  readonly spanishFallback?: Readonly<Record<string, string | null>> | null;
}

/** One English row and one Spanish row for each of the four touchpoints, as v1.10.9 seeds them. */
function templateVersions(overrides: TemplateOverrides = {}): TemplateVersionRow[] {
  return TOUCHPOINTS.flatMap((touchpoint): TemplateVersionRow[] => [
    {
      id: `tv-en-${touchpoint}`,
      template_id: `tpl-${touchpoint}`,
      version: 2,
      touchpoint,
      language: 'English',
      subject: overrides.englishSubject ?? `Cancellation notice - tier ${touchpoint}`,
      body: overrides.englishBody ?? englishBody(touchpoint),
      cancellation_statement: overrides.englishStatement ?? EN_STATEMENT,
      contact_request: overrides.englishRequest ?? EN_REQUEST,
      fallback_text: overrides.englishFallback === undefined ? EN_FALLBACK : overrides.englishFallback,
    },
    {
      id: `tv-es-${touchpoint}`,
      template_id: `tpl-${touchpoint}`,
      version: 2,
      touchpoint,
      language: 'Spanish',
      subject: overrides.spanishSubject ?? `Aviso de cancelación - tier ${touchpoint}`,
      body: overrides.spanishBody ?? spanishBody(touchpoint),
      cancellation_statement: overrides.spanishStatement ?? ES_STATEMENT,
      contact_request: overrides.spanishRequest ?? ES_REQUEST,
      fallback_text: overrides.spanishFallback === undefined ? ES_FALLBACK : overrides.spanishFallback,
    },
  ]);
}

function singleCase(overrides: Partial<RenderCase> = {}): RenderCase {
  return {
    id: 'case-1',
    policy_number: 'POL-10001',
    cancellation_effective_date: '2026-07-31',
    customer_name: 'Rosa Martinez',
    carrier: 'Progressive',
    cancellation_reason: 'Non-payment',
    amount_due: '1234.5',
    touchpoint: 15,
    ...overrides,
  };
}

/** The three cases of the combined tests: two sharing a date, one later, deliberately unsorted. */
const COMBINED_CASES: readonly RenderCase[] = [
  { id: 'case-c', policy_number: 'POL-30002', cancellation_effective_date: '2026-08-15', customer_name: 'Rosa Martinez', touchpoint: 15 },
  { id: 'case-a', policy_number: 'POL-10001', cancellation_effective_date: '2026-07-31', customer_name: 'Rosa Martinez', touchpoint: 15 },
  { id: 'case-b', policy_number: 'POL-20003', cancellation_effective_date: '7/31/2026', customer_name: 'Rosa Martinez', touchpoint: 15 },
];

function baseInput(overrides: Partial<RenderMessageInput> = {}): RenderMessageInput {
  return {
    templateVersions: templateVersions(),
    cases: [singleCase()],
    contact: {
      id: 'contact-1',
      channel: 'email',
      normalized_value: 'rosa@example.com',
      preferred_language: 'Bilingual',
      contact_name: 'Rosa Martinez',
    },
    touchpoint: 15,
    channel: 'email',
    settings: SETTINGS,
    senderName: { display_name: 'Maria Gomez', is_active: true, is_deleted: false },
    combined: false,
    prohibitedPhrases: BASE_PHRASES,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function rendered(result: RenderResult): RenderRendered {
  if (!result.ok) {
    throw new Error(`expected a rendered message, got blocked by ${result.blockedBy} on "${result.match}"`);
  }
  return result;
}

function blocked(result: RenderResult): RenderBlocked {
  if (result.ok) {
    throw new Error(`expected a blocked render, got a message of ${result.body.length} characters`);
  }
  return result;
}

function renderOk(overrides: Partial<RenderMessageInput> = {}): RenderRendered {
  return rendered(renderMessage(baseInput(overrides)));
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** The two body segments of a Bilingual render, split on the one stored separator. */
function bodySegments(body: string): readonly string[] {
  return body.split(SETTINGS.bilingual_separator);
}

// ---------------------------------------------------------------------------
// Requirement 11.2 / 11.3 / 11.8 — render language resolution
// ---------------------------------------------------------------------------

describe('resolveRenderLanguage (Requirements 11.2, 11.3, 11.8)', () => {
  it.each<[string, string | null | undefined]>([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['unrecognized', 'Klingon'],
    ['recognized but differently cased', 'english'],
  ])('falls back to Bilingual for a %s preferred language', (_label, stored) => {
    expect(resolveRenderLanguage([{ preferred_language: stored }])).toBe('Bilingual');
  });

  it('resolves each of the three stored values exactly', () => {
    expect(resolveRenderLanguage([{ preferred_language: 'English' }])).toBe('English');
    expect(resolveRenderLanguage([{ preferred_language: 'Spanish' }])).toBe('Spanish');
    expect(resolveRenderLanguage([{ preferred_language: 'Bilingual' }])).toBe('Bilingual');
  });

  it('trims a stored value before comparing it', () => {
    expect(resolveRenderLanguage([{ preferred_language: '  Spanish  ' }])).toBe('Spanish');
  });

  it('resolves Bilingual where the included contacts disagree, and keeps the one value where they agree', () => {
    expect(resolveRenderLanguage([
      { preferred_language: 'English' },
      { preferred_language: 'Spanish' },
    ])).toBe('Bilingual');
    expect(resolveRenderLanguage([
      { preferred_language: 'Spanish' },
      { preferred_language: 'Spanish' },
    ])).toBe('Spanish');
  });

  it('resolves Bilingual for zero contacts', () => {
    expect(resolveRenderLanguage([])).toBe('Bilingual');
  });

  it('resolves Bilingual for a combined message whatever the contacts prefer (Requirement 11.8)', () => {
    expect(resolveRenderLanguage([{ preferred_language: 'English' }], true)).toBe('Bilingual');
    expect(resolveRenderLanguage([], true)).toBe('Bilingual');
  });
});

describe('renderMessage language resolution (Requirement 11.2)', () => {
  it.each<[string, string | null | undefined]>([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace-only', '  \t '],
    ['unrecognized', 'Portuguese'],
  ])('renders Bilingual for a %s stored preferred language', (_label, stored) => {
    const result = renderOk({ contact: { preferred_language: stored } });

    expect(result.language).toBe('Bilingual');
    expect(bodySegments(result.body)).toHaveLength(2);
  });

  it('renders exactly one segment for English and one for Spanish (Requirement 11.6)', () => {
    const english = renderOk({ contact: { preferred_language: 'English' } });
    expect(english.language).toBe('English');
    expect(english.templateVersionIds).toEqual(['tv-en-15']);
    expect(english.body).toContain(EN_STATEMENT);
    expect(english.body).not.toContain(ES_STATEMENT);
    expect(countOccurrences(english.body, SETTINGS.bilingual_separator)).toBe(0);

    const spanish = renderOk({ contact: { preferred_language: 'Spanish' } });
    expect(spanish.language).toBe('Spanish');
    expect(spanish.templateVersionIds).toEqual(['tv-es-15']);
    expect(spanish.body).toContain(ES_STATEMENT);
    expect(spanish.body).not.toContain(EN_STATEMENT);
  });

  it('resolves the language from the contact rows only, not from the customer name or the employee', () => {
    const result = renderOk({
      cases: [singleCase({ customer_name: 'Rosa Martinez' })],
      contact: [{ preferred_language: 'Spanish' }, { preferred_language: 'Spanish' }],
      senderName: { display_name: 'Maria Gomez' },
    });

    expect(result.language).toBe('Spanish');
  });
});

// ---------------------------------------------------------------------------
// Requirements 11.6, 11.7, 14.1 to 14.6 — bilingual assembly and required elements
// ---------------------------------------------------------------------------

describe('bilingual assembly (Requirements 11.6, 11.7, 14.6)', () => {
  it('renders the English segment, exactly one separator, then the Spanish segment', () => {
    const result = renderOk();
    const segments = bodySegments(result.body);

    expect(countOccurrences(result.body, SETTINGS.bilingual_separator)).toBe(1);
    expect(segments).toHaveLength(2);
    expect(BILINGUAL_SEGMENT_ORDER).toEqual(['English', 'Spanish']);
    expect(segments[0]).toContain(EN_STATEMENT);
    expect(segments[0]).not.toContain(ES_STATEMENT);
    expect(segments[1]).toContain(ES_STATEMENT);
    expect(segments[1]).not.toContain(EN_STATEMENT);
    expect(result.body.indexOf(EN_STATEMENT)).toBeLessThan(result.body.indexOf(ES_STATEMENT));
  });

  it('carries the statement, the dates, and the contact request in each segment', () => {
    const segments = bodySegments(renderOk().body);

    expect(segments[0]).toContain(EN_STATEMENT);
    expect(segments[0]).toContain('July 31, 2026');
    expect(segments[0]).toContain(EN_REQUEST_JULY);

    expect(segments[1]).toContain(ES_STATEMENT);
    expect(segments[1]).toContain('31 de julio de 2026');
    expect(segments[1]).toContain(ES_REQUEST_JULY);
  });

  it('appends every required element a token-free stored template omits, and one signature for the whole body', () => {
    // The required-element guarantee, end to end: a stored body carrying no token at all still
    // reaches the customer with the statement, the effective date, and the contact request in both
    // languages (Requirements 14.2, 14.3, 14.5, 14.6), and with one closing signature carrying the
    // sender name, Agency_Name, and Office_Phone once over the whole body (14.1, 14.4, 14.13).
    const result = renderOk({
      templateVersions: templateVersions({ englishBody: 'Hello.', spanishBody: 'Hola.' }),
    });

    expect(result.body).toBe([
      'Hello.',
      '',
      EN_STATEMENT,
      '',
      'Cancellation effective date: July 31, 2026',
      '',
      EN_REQUEST_JULY,
      '---',
      'Hola.',
      '',
      ES_STATEMENT,
      '',
      'Fecha efectiva de cancelación: 31 de julio de 2026',
      '',
      ES_REQUEST_JULY,
      '',
      'Maria Gomez New Hope Insurance Agency (704) 824-3130',
    ].join('\n'));
  });

  it('appends nothing where the stored template already renders all three elements', () => {
    const result = renderOk();

    expect(countOccurrences(result.body, EN_STATEMENT)).toBe(1);
    expect(countOccurrences(result.body, ES_STATEMENT)).toBe(1);
    expect(countOccurrences(result.body, EN_REQUEST_JULY)).toBe(1);
    expect(countOccurrences(result.body, ES_REQUEST_JULY)).toBe(1);
  });

  it('throws where the Spanish row of a Bilingual render is missing (Requirement 11.6)', () => {
    const englishOnly = templateVersions().filter((row) => row.language === 'English');

    expect(() => renderMessage(baseInput({ templateVersions: englishOnly })))
      .toThrow(RenderInputError);
    expect(() => renderMessage(baseInput({ templateVersions: englishOnly })))
      .toThrow(/Spanish template version row/);
  });

  it('throws where a Bilingual render has a zero-character separator, and renders without one for a single language', () => {
    const settings: RenderSettings = { ...SETTINGS, bilingual_separator: '' };

    expect(() => renderMessage(baseInput({ settings }))).toThrow(RenderInputError);
    expect(rendered(renderMessage(baseInput({
      settings,
      contact: { preferred_language: 'English' },
    }))).language).toBe('English');
  });
});

// ---------------------------------------------------------------------------
// Requirements 14.1, 14.4 — Agency_Name and Office_Phone in every body
// ---------------------------------------------------------------------------

describe('Agency_Name and Office_Phone (Requirements 14.1, 14.4)', () => {
  it('renders both from the stored template when the template writes them', () => {
    const result = renderOk();

    expect(result.body).toContain(SETTINGS.agency_name);
    expect(containsOfficePhone(result.body, SETTINGS.office_phone)).toBe(true);
  });

  it('appends both where the stored template writes neither', () => {
    const result = renderOk({
      templateVersions: templateVersions({ englishBody: 'Hello.', spanishBody: 'Hola.' }),
    });

    expect(countOccurrences(result.body, SETTINGS.agency_name)).toBe(1);
    expect(containsOfficePhone(result.body, SETTINGS.office_phone)).toBe(true);
  });

  it('matches Office_Phone after removing spaces, hyphens, parentheses, periods, and plus signs', () => {
    const result = renderOk({
      settings: { ...SETTINGS, office_phone: '+1 (704) 824-3130' },
      templateVersions: templateVersions({
        englishBody: 'Call 704.824.3130 for help.',
        spanishBody: 'Llame al +1-704-824-3130 para ayuda.',
      }),
    });

    expect(containsOfficePhone(result.body, '+1 (704) 824-3130')).toBe(true);
    // Nothing was appended: the punctuation-stripped body already carries the digit sequence.
    expect(countOccurrences(result.body, '+1 (704) 824-3130')).toBe(0);
  });

  it('appends the phone where the body writes the digits behind punctuation the rule does not remove', () => {
    // `/` is not one of the five characters Requirement 14.4 strips, so `704/824/3130` is not a
    // rendered Office_Phone and the closing line has to supply one.
    const result = renderOk({
      templateVersions: templateVersions({
        englishBody: 'Call 704/824/3130.',
        spanishBody: 'Llame al 704/824/3130.',
      }),
    });

    expect(result.body).toContain(SETTINGS.office_phone);
    expect(containsOfficePhone(result.body, SETTINGS.office_phone)).toBe(true);
  });

  it('matches Agency_Name as an exact literal, so a differently cased body still gets one appended', () => {
    const result = renderOk({
      templateVersions: templateVersions({
        englishBody: 'From new hope insurance agency.',
        spanishBody: 'De new hope insurance agency.',
      }),
    });

    expect(result.body).toContain(SETTINGS.agency_name);
    expect(countOccurrences(result.body, SETTINGS.agency_name)).toBe(1);
  });

  it('throws for settings that cannot satisfy Requirement 14.1 or 14.4', () => {
    expect(() => renderMessage(baseInput({ settings: { ...SETTINGS, agency_name: '   ' } })))
      .toThrow(RenderInputError);
    expect(() => renderMessage(baseInput({ settings: { ...SETTINGS, office_phone: 'call the office' } })))
      .toThrow(RenderInputError);
  });
});

describe('officePhoneDigits and containsOfficePhone (Requirement 14.4)', () => {
  it('reduces a stored phone to its digit sequence', () => {
    expect(officePhoneDigits('(704) 824-3130')).toBe(OFFICE_PHONE_DIGITS);
    expect(officePhoneDigits('+1 704.824.3130')).toBe(`1${OFFICE_PHONE_DIGITS}`);
    expect(officePhoneDigits('call the office')).toBe('');
  });

  it('matches only across the five stripped characters, and never for a phone with no digits', () => {
    expect(containsOfficePhone('Call (704) 824-3130 today.', '7048243130')).toBe(true);
    expect(containsOfficePhone('Call +1 704 824 3130 today.', '(704) 824-3130')).toBe(true);
    expect(containsOfficePhone('Call 704/824/3130 today.', '(704) 824-3130')).toBe(false);
    expect(containsOfficePhone('Call 704x8243130 today.', '(704) 824-3130')).toBe(false);
    expect(containsOfficePhone('Call (704) 824-3130 today.', 'call the office')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requirements 14.3, 14.6 — effective dates as day, month, four-digit year
// ---------------------------------------------------------------------------

describe('formatEffectiveDate (Requirements 14.3, 14.6)', () => {
  it.each<[string, string, string]>([
    ['2026-07-31', 'July 31, 2026', '31 de julio de 2026'],
    ['7/31/2026', 'July 31, 2026', '31 de julio de 2026'],
    ['2026-01-05', 'January 5, 2026', '5 de enero de 2026'],
    ['2028-02-29', 'February 29, 2028', '29 de febrero de 2028'],
    ['2026-12-01', 'December 1, 2026', '1 de diciembre de 2026'],
  ])('renders %s with the day, the month, and the four-digit year in both languages', (stored, english, spanish) => {
    expect(formatEffectiveDate(stored, 'English')).toBe(english);
    expect(formatEffectiveDate(stored, 'Spanish')).toBe(spanish);
  });

  it('throws for a value that is not a stored case date', () => {
    expect(() => formatEffectiveDate('July 31, 2026', 'English')).toThrow(RenderInputError);
    expect(() => formatEffectiveDate('2026-02-30', 'English')).toThrow(RenderInputError);
    expect(() => formatEffectiveDate('', 'English')).toThrow(RenderInputError);
  });

  it('is what renderMessage renders, and an unparseable case date throws instead', () => {
    const result = renderOk({ cases: [singleCase({ cancellation_effective_date: '2028-02-29' })] });

    expect(result.body).toContain('February 29, 2028');
    expect(result.body).toContain('29 de febrero de 2028');

    expect(() => renderMessage(baseInput({
      cases: [singleCase({ cancellation_effective_date: '29/02/2028' })],
    }))).toThrow(RenderInputError);
  });

  it('renders every included effective date of a combined email in both languages', () => {
    const result = renderOk({ cases: COMBINED_CASES, combined: true });

    for (const english of ['July 31, 2026', 'August 15, 2026']) {
      expect(result.body).toContain(english);
    }
    for (const spanish of ['31 de julio de 2026', '15 de agosto de 2026']) {
      expect(result.body).toContain(spanish);
    }
  });
});

// ---------------------------------------------------------------------------
// Requirement 14.5 — the contact request and the earliest included deadline
// ---------------------------------------------------------------------------

describe('contact request and deadline (Requirement 14.5)', () => {
  it('renders the stored contact request with the earliest included date as the deadline', () => {
    const result = renderOk({ cases: COMBINED_CASES, combined: true });

    expect(result.body).toContain(EN_REQUEST_JULY);
    expect(result.body).toContain(ES_REQUEST_JULY);
    expect(result.body).not.toContain('Please contact us on or before August 15, 2026');
  });

  it('renders the deadline through Contact_Deadline and Earliest_Cancellation_Date alike', () => {
    const result = renderOk({
      cases: COMBINED_CASES,
      combined: true,
      templateVersions: templateVersions({
        englishBody: [
          `Deadline: ${tokenPlaceholder(TOKEN_NAMES.contactDeadline)}`,
          `Earliest: ${tokenPlaceholder(TOKEN_NAMES.earliestCancellationDate)}`,
        ].join('\n'),
        spanishBody: `Plazo: ${tokenPlaceholder(TOKEN_NAMES.contactDeadline)}`,
      }),
    });

    expect(result.body).toContain('Deadline: July 31, 2026');
    expect(result.body).toContain('Earliest: July 31, 2026');
    expect(result.body).toContain('Plazo: 31 de julio de 2026');
  });
});

// ---------------------------------------------------------------------------
// Requirement 13.2 — combined email ordering, listing, and count
// ---------------------------------------------------------------------------

describe('combined email (Requirement 13.2)', () => {
  it('lists every policy number with its date, ordered by date then policy number, and states the count', () => {
    const result = renderOk({ cases: COMBINED_CASES, combined: true });

    expect(result.language).toBe('Bilingual');
    expect(result.body).toContain([
      '3 policies:',
      '- Policy POL-10001: July 31, 2026',
      '- Policy POL-20003: July 31, 2026',
      '- Policy POL-30002: August 15, 2026',
    ].join('\n'));
    expect(result.body).toContain([
      '3 pólizas:',
      '- Póliza POL-10001: 31 de julio de 2026',
      '- Póliza POL-20003: 31 de julio de 2026',
      '- Póliza POL-30002: 15 de agosto de 2026',
    ].join('\n'));
  });

  it('renders Policy_Number as the ordered list and Cancellation_Date as the earliest date', () => {
    const result = renderOk({ cases: COMBINED_CASES, combined: true });

    expect(result.body).toContain('Policy: POL-10001, POL-20003, POL-30002');
    expect(result.body).toContain('Cancellation effective date: July 31, 2026');
  });

  it('sends Carrier, Cancellation_Reason, and Amount_Due to the fallback path because they differ per case', () => {
    const result = renderOk({ cases: COMBINED_CASES, combined: true });

    expect(result.body).toContain('Carrier: your carrier');
    expect(result.body).toContain('Reason: a change on the policy');
    expect(result.body).toContain('Aseguradora: su aseguradora');
    // `Amount_Due` stores an empty fallback, so its line is dropped rather than shipped bare.
    expect(result.body).not.toContain('Amount due:');
    expect(result.body).not.toContain('Monto debido:');
  });

  it('renders the stored Policy_List token once and appends no second dates block', () => {
    const result = renderOk({
      cases: COMBINED_CASES,
      combined: true,
      templateVersions: templateVersions({
        englishBody: `${EN_STATEMENT}\n${tokenPlaceholder(TOKEN_NAMES.policyList)}\n${tokenPlaceholder(TOKEN_NAMES.contactRequest)}`,
        spanishBody: `${ES_STATEMENT}\n${tokenPlaceholder(TOKEN_NAMES.policyList)}\n${tokenPlaceholder(TOKEN_NAMES.contactRequest)}`,
      }),
    });

    expect(countOccurrences(result.body, '3 policies:')).toBe(1);
    expect(countOccurrences(result.body, '- Policy POL-10001: July 31, 2026')).toBe(1);
    expect(countOccurrences(result.body, '3 pólizas:')).toBe(1);
  });

  it('is Bilingual even where every included contact stores one language (Requirement 11.8)', () => {
    const result = renderOk({
      cases: COMBINED_CASES,
      combined: true,
      contact: [{ preferred_language: 'English' }, { preferred_language: 'English' }],
    });

    expect(result.language).toBe('Bilingual');
    expect(bodySegments(result.body)).toHaveLength(2);
  });

  it('treats more than one included case as combined whatever the flag says', () => {
    const result = renderOk({ cases: COMBINED_CASES, combined: false });

    expect(result.language).toBe('Bilingual');
    expect(result.body).toContain('3 policies:');
  });
});

describe('orderCasesForRender (Requirement 13.2)', () => {
  function policyOrder(cases: readonly RenderCase[]): readonly string[] {
    return orderCasesForRender(cases).map((row) => row.policy_number);
  }

  it('orders by cancellation effective date ascending, then by policy number ascending', () => {
    expect(policyOrder(COMBINED_CASES)).toEqual(['POL-10001', 'POL-20003', 'POL-30002']);
  });

  it('compares dates across both stored formats', () => {
    expect(policyOrder([
      { policy_number: 'B', cancellation_effective_date: '12/31/2026' },
      { policy_number: 'A', cancellation_effective_date: '2027-01-01' },
    ])).toEqual(['B', 'A']);
  });

  it('compares policy numbers by code unit rather than through localeCompare', () => {
    // `Ñ` is code unit 0x00D1, after `Z` at 0x5A, while locale collation places it next to `N`.
    // The rendered order must not depend on the host's locale data, so code units decide.
    expect(policyOrder([
      { policy_number: 'ÑA-1', cancellation_effective_date: '2026-07-31' },
      { policy_number: 'ZZ-1', cancellation_effective_date: '2026-07-31' },
      { policy_number: 'AA-1', cancellation_effective_date: '2026-07-31' },
    ])).toEqual(['AA-1', 'ZZ-1', 'ÑA-1']);
  });

  it('groups policy numbers differing only in case together, then breaks the tie by code unit', () => {
    expect(policyOrder([
      { policy_number: 'abc-1', cancellation_effective_date: '2026-07-31' },
      { policy_number: 'ABD-1', cancellation_effective_date: '2026-07-31' },
      { policy_number: 'ABC-1', cancellation_effective_date: '2026-07-31' },
    ])).toEqual(['ABC-1', 'abc-1', 'ABD-1']);
  });

  it('is stable for one case and throws on an unparseable date', () => {
    expect(policyOrder([{ policy_number: 'A', cancellation_effective_date: '2026-07-31' }])).toEqual(['A']);
    expect(() => orderCasesForRender([{ policy_number: 'A', cancellation_effective_date: 'soon' }]))
      .toThrow(RenderInputError);
  });
});

// ---------------------------------------------------------------------------
// Requirement 13.3 — the combined SMS body
// ---------------------------------------------------------------------------

describe('combined SMS (Requirement 13.3)', () => {
  function combinedSms(overrides: Partial<RenderMessageInput> = {}): RenderRendered {
    return renderOk({ cases: COMBINED_CASES, combined: true, channel: 'sms', ...overrides });
  }

  it('states the count and the earliest date, in both languages, and carries no policy number', () => {
    const result = combinedSms();

    expect(result.body).toContain('3 policies - Earliest cancellation effective date: July 31, 2026');
    expect(result.body).toContain('3 pólizas - Fecha efectiva de cancelación más próxima: 31 de julio de 2026');
    for (const row of COMBINED_CASES) {
      expect(result.body).not.toContain(row.policy_number);
    }
  });

  it('renders a body of at most 640 characters and reports it untruncated', () => {
    const result = combinedSms();

    expect(MAX_COMBINED_SMS_BODY_LENGTH).toBe(640);
    expect(result.body.length).toBeLessThanOrEqual(MAX_COMBINED_SMS_BODY_LENGTH);
    expect(result.truncated).toBe(false);
  });

  it('still carries the statement, the contact request, and one signature', () => {
    const result = combinedSms();

    expect(result.body).toContain(EN_STATEMENT);
    expect(result.body).toContain(ES_STATEMENT);
    expect(result.body).toContain(EN_REQUEST_JULY);
    expect(result.body).toContain(ES_REQUEST_JULY);
    expect(countOccurrences(result.body, SETTINGS.agency_name)).toBe(1);
    expect(countOccurrences(result.body, 'Maria Gomez')).toBe(1);
    expect(containsOfficePhone(result.body, SETTINGS.office_phone)).toBe(true);
  });

  it('cuts an over-long body to exactly 640 characters and reports it truncated', () => {
    const padding = 'aviso '.repeat(120).trim();
    const result = combinedSms({
      templateVersions: templateVersions({
        englishStatement: `${EN_STATEMENT} ${padding}`,
        spanishStatement: `${ES_STATEMENT} ${padding}`,
      }),
    });

    expect(result.body).toHaveLength(MAX_COMBINED_SMS_BODY_LENGTH);
    expect(result.truncated).toBe(true);
  });

  it('is the only body assembled without the stored template body', () => {
    // A single-case SMS renders the stored body; the combined SMS does not, which is what lets it
    // hold 640 characters and exclude policy numbers.
    const single = renderOk({ channel: 'sms' });
    expect(single.body).toContain('Reminder tier 15.');
    expect(single.truncated).toBe(false);

    expect(combinedSms().body).not.toContain('Reminder tier 15.');
  });
});

// ---------------------------------------------------------------------------
// Requirement 14.15 — the rendered subject
// ---------------------------------------------------------------------------

describe('rendered subject (Requirements 14.15, 11.7)', () => {
  it('renders zero characters on the SMS channel', () => {
    expect(renderOk({ channel: 'sms' }).subject).toBe('');
    expect(renderOk({ cases: COMBINED_CASES, combined: true, channel: 'sms' }).subject).toBe('');
    expect(renderOk({ channel: 'sms', contact: { preferred_language: 'English' } }).subject).toBe('');
  });

  it('joins the two email subject segments with the subject separator, English first', () => {
    const result = renderOk();

    expect(SUBJECT_SEGMENT_SEPARATOR).toBe(' / ');
    expect(result.subject).toBe('Cancellation notice - tier 15 / Aviso de cancelación - tier 15');
    expect(result.subject).not.toContain(SETTINGS.bilingual_separator);
  });

  it('leaves no dangling separator where a stored segment subject is zero characters', () => {
    expect(renderOk({ templateVersions: templateVersions({ spanishSubject: '' }) }).subject)
      .toBe('Cancellation notice - tier 15');
    expect(renderOk({ templateVersions: templateVersions({ englishSubject: '   ' }) }).subject)
      .toBe('Aviso de cancelación - tier 15');
    expect(renderOk({ templateVersions: templateVersions({ englishSubject: '', spanishSubject: '' }) }).subject)
      .toBe('');
  });

  it('substitutes tokens in the subject', () => {
    const result = renderOk({
      templateVersions: templateVersions({
        englishSubject: `${tokenPlaceholder(TOKEN_NAMES.policyCount)} scheduled for cancellation`,
        spanishSubject: `${tokenPlaceholder(TOKEN_NAMES.policyCount)} programadas para cancelación`,
      }),
      cases: COMBINED_CASES,
      combined: true,
    });

    expect(result.subject).toBe('3 policies scheduled for cancellation / 3 pólizas programadas para cancelación');
  });
});

// ---------------------------------------------------------------------------
// Requirement 13.5 / 13.7 — the case cap and the applied touchpoint
// ---------------------------------------------------------------------------

describe('included case count (Requirement 13.5)', () => {
  function manyCases(count: number): RenderCase[] {
    return Array.from({ length: count }, (_unused, index): RenderCase => ({
      id: `case-${index}`,
      policy_number: `POL-9${String(index).padStart(4, '0')}`,
      cancellation_effective_date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      customer_name: 'Rosa Martinez',
      touchpoint: 15,
    }));
  }

  it('renders 10 included cases', () => {
    expect(MAX_COMBINED_CASES).toBe(10);
    const result = renderOk({ cases: manyCases(MAX_COMBINED_CASES), combined: true });

    expect(result.body).toContain('10 policies:');
    expect(result.body).toContain('- Policy POL-90000: September 1, 2026');
    expect(result.body).toContain('- Policy POL-90009: September 10, 2026');
  });

  it('throws for 11 included cases', () => {
    expect(() => renderMessage(baseInput({ cases: manyCases(11), combined: true })))
      .toThrow(RenderInputError);
    expect(() => renderMessage(baseInput({ cases: manyCases(11), combined: true })))
      .toThrow(/11 cancellation cases/);
  });

  it('throws for zero included cases', () => {
    expect(() => renderMessage(baseInput({ cases: [] }))).toThrow(RenderInputError);
    expect(() => renderMessage(baseInput({ cases: [] }))).toThrow(/zero cancellation cases/);
  });
});

describe('applied touchpoint (Requirement 13.7)', () => {
  it.each(TOUCHPOINTS)('selects the %s-day template version for a message of that touchpoint', (touchpoint) => {
    const result = renderOk({
      touchpoint,
      cases: [singleCase({ touchpoint })],
    });

    expect(result.touchpoint).toBe(touchpoint);
    expect(result.templateVersionId).toBe(`tv-en-${touchpoint}`);
    expect(result.templateVersionIds).toEqual([`tv-en-${touchpoint}`, `tv-es-${touchpoint}`]);
    expect(result.body).toContain(`Reminder tier ${touchpoint}.`);
    expect(result.body).toContain(`Nivel de recordatorio ${touchpoint}.`);
    expect(result.subject).toContain(`tier ${touchpoint}`);
  });

  it('renders a combined message from the template version of the fewest days remaining', () => {
    const result = renderOk({
      touchpoint: 15,
      combined: true,
      cases: [
        { policy_number: 'POL-1', cancellation_effective_date: '2026-08-15', touchpoint: 15 },
        { policy_number: 'POL-2', cancellation_effective_date: '2026-08-05', touchpoint: 10 },
        { policy_number: 'POL-3', cancellation_effective_date: '2026-07-31', touchpoint: 5 },
      ],
    });

    expect(result.touchpoint).toBe(5);
    expect(result.templateVersionId).toBe('tv-en-5');
    expect(result.body).toContain('Reminder tier 5.');
    expect(result.body).not.toContain('Reminder tier 15.');
  });

  it('resolveTouchpoint keeps the message touchpoint where no case lowers it', () => {
    expect(resolveTouchpoint(10, [{ policy_number: 'A', cancellation_effective_date: '2026-07-31' }])).toBe(10);
    expect(resolveTouchpoint(10, [{ policy_number: 'A', cancellation_effective_date: '2026-07-31', touchpoint: null }])).toBe(10);
    expect(resolveTouchpoint(1, [{ policy_number: 'A', cancellation_effective_date: '2026-07-31', touchpoint: 15 }])).toBe(1);
    expect(resolveTouchpoint(15, [
      { policy_number: 'A', cancellation_effective_date: '2026-07-31', touchpoint: 10 },
      { policy_number: 'B', cancellation_effective_date: '2026-08-01', touchpoint: 1 },
    ])).toBe(1);
  });
});

describe('selectTemplateVersion', () => {
  const rows: readonly TemplateVersionRow[] = [
    { id: 'v1', version: 1, touchpoint: 5, language: 'English', subject: 's1', body: 'b1', cancellation_statement: 'c', contact_request: 'r' },
    { id: 'v3', version: 3, touchpoint: 5, language: 'English', subject: 's3', body: 'b3', cancellation_statement: 'c', contact_request: 'r' },
    { id: 'v2', version: 2, touchpoint: 5, language: 'English', subject: 's2', body: 'b2', cancellation_statement: 'c', contact_request: 'r' },
    { id: 'other-touchpoint', version: 9, touchpoint: 1, language: 'English', subject: 's9', body: 'b9', cancellation_statement: 'c', contact_request: 'r' },
    { id: 'spanish', version: 1, touchpoint: 5, language: 'Spanish', subject: 'ss', body: 'bs', cancellation_statement: 'c', contact_request: 'r' },
  ];

  it('selects the highest version of the requested language and touchpoint', () => {
    expect(selectTemplateVersion(rows, 5, 'English').id).toBe('v3');
    expect(selectTemplateVersion(rows, 5, 'Spanish').id).toBe('spanish');
    expect(selectTemplateVersion(rows, 1, 'English').id).toBe('other-touchpoint');
  });

  it('accepts a row carrying no touchpoint for any touchpoint', () => {
    const untargeted: TemplateVersionRow = {
      id: 'any-touchpoint', version: 4, language: 'English', subject: 's', body: 'b',
      cancellation_statement: 'c', contact_request: 'r',
    };

    expect(selectTemplateVersion([...rows, untargeted], 10, 'English').id).toBe('any-touchpoint');
    expect(selectTemplateVersion([...rows, untargeted], 5, 'English').id).toBe('any-touchpoint');
  });

  it('throws where no row of that language and touchpoint was supplied', () => {
    expect(() => selectTemplateVersion(rows, 10, 'English')).toThrow(RenderInputError);
    expect(() => selectTemplateVersion(rows, 1, 'Spanish')).toThrow(/Spanish template version row/);
    expect(() => selectTemplateVersion([], 5, 'English')).toThrow(RenderInputError);
  });
});

// ---------------------------------------------------------------------------
// Requirement 14.11 — fallback text and the empty-token line drop
// ---------------------------------------------------------------------------

describe('token substitution and fallback text (Requirement 14.11)', () => {
  it('renders the present value, then the stored fallback, then zero characters', () => {
    const values = { [TOKEN_NAMES.carrier]: 'Progressive' };
    const fallback = { [TOKEN_NAMES.carrier]: 'your carrier', [TOKEN_NAMES.producerName]: 'our team' };

    expect(substituteTokens(tokenPlaceholder(TOKEN_NAMES.carrier), values, fallback)).toBe('Progressive');
    expect(substituteTokens(tokenPlaceholder(TOKEN_NAMES.carrier), {}, fallback)).toBe('your carrier');
    expect(substituteTokens(tokenPlaceholder(TOKEN_NAMES.producerName), {}, fallback)).toBe('our team');
    expect(substituteTokens(tokenPlaceholder(TOKEN_NAMES.amountDue), {}, fallback)).toBe('');
    expect(substituteTokens(tokenPlaceholder(TOKEN_NAMES.amountDue), {}, null)).toBe('');
  });

  it('renders zero characters for a stored fallback that is empty, whitespace-only, or an absent marker', () => {
    const placeholder = tokenPlaceholder(TOKEN_NAMES.amountDue);

    expect(substituteTokens(placeholder, {}, { [TOKEN_NAMES.amountDue]: '' })).toBe('');
    expect(substituteTokens(placeholder, {}, { [TOKEN_NAMES.amountDue]: '   ' })).toBe('');
    expect(substituteTokens(placeholder, {}, { [TOKEN_NAMES.amountDue]: 'nan' })).toBe('');
    expect(substituteTokens(placeholder, {}, { [TOKEN_NAMES.amountDue]: null })).toBe('');
  });

  it('renders zero characters for a token name it does not resolve', () => {
    expect(substituteTokens(`x${tokenPlaceholder('Not_A_Token')}y`, {}, null)).toBe('xy');
  });

  it('trims the token name and reads each token independently', () => {
    const values = { [TOKEN_NAMES.agencyName]: 'ACME', [TOKEN_NAMES.senderName]: 'Maria' };

    expect(substituteTokens('{{ Agency_Name }}', values, null)).toBe('ACME');
    expect(substituteTokens('{{Agency_Name}} {{Sender_Name}}', values, null)).toBe('ACME Maria');
  });

  it('substitutes in one pass, so no value or fallback can drive substitution recursively', () => {
    const values = {
      [TOKEN_NAMES.customerName]: `a ${tokenPlaceholder(TOKEN_NAMES.agencyName)} b`,
      [TOKEN_NAMES.agencyName]: 'ACME',
    };

    expect(substituteTokens(tokenPlaceholder(TOKEN_NAMES.customerName), values, null))
      .toBe(`a ${tokenPlaceholder(TOKEN_NAMES.agencyName)} b`);
  });

  it('treats a value that is nothing but an absent marker as absent', () => {
    const fallback = { [TOKEN_NAMES.producerName]: 'our team' };

    expect(substituteTokens(tokenPlaceholder(TOKEN_NAMES.producerName), { [TOKEN_NAMES.producerName]: 'nan' }, fallback))
      .toBe('our team');
    expect(substituteTokens(tokenPlaceholder(TOKEN_NAMES.producerName), { [TOKEN_NAMES.producerName]: 'Nanette Nunez' }, fallback))
      .toBe('Nanette Nunez');
  });

  it('drops a body line whose every token rendered zero characters, and keeps a line with no token', () => {
    const result = renderOk({ cases: [singleCase({ amount_due: null, carrier: null })] });

    expect(result.body).not.toContain('Amount due:');
    expect(result.body).not.toContain('Monto debido:');
    // A stored fallback keeps the same line, and a token-free line is never touched.
    expect(result.body).toContain('Carrier: your carrier');
    expect(result.body).toContain('Reminder tier 15.');
  });

  it('keeps the line where a stored fallback renders characters', () => {
    const result = renderOk({
      cases: [singleCase({ amount_due: null })],
      templateVersions: templateVersions({
        englishFallback: { ...EN_FALLBACK, [TOKEN_NAMES.amountDue]: 'contact us for the balance' },
      }),
    });

    expect(result.body).toContain('Amount due: contact us for the balance');
  });

  it('formats a present amount with grouped thousands and two decimals', () => {
    expect(renderOk().body).toContain('Amount due: $1,234.50');
    expect(renderOk({ cases: [singleCase({ amount_due: 1234567.89 })] }).body)
      .toContain('Amount due: $1,234,567.89');
    expect(renderOk({ cases: [singleCase({ amount_due: '$0.75' })] }).body)
      .toContain('Amount due: $0.75');
  });
});

describe('isAbsentMarker (Requirement 14.12, value side)', () => {
  it.each(['nan', 'NaN', 'NAN', 'None', 'none', 'null', 'NULL', 'undefined', '  nan  '])(
    'treats "%s" as an absent value',
    (value) => {
      expect(isAbsentMarker(value)).toBe(true);
    },
  );

  it.each(['Nanette Nunez', 'Nullson', 'Undefined Holdings LLC', 'Aznanian', 'nan nan', '', '   '])(
    'leaves "%s" as an ordinary value',
    (value) => {
      expect(isAbsentMarker(value)).toBe(false);
    },
  );

  it('reads an absent value as not a marker', () => {
    expect(isAbsentMarker(null)).toBe(false);
    expect(isAbsentMarker(undefined)).toBe(false);
  });
});

describe('the token vocabulary', () => {
  it('wraps a bare token name in the one delimiter', () => {
    expect(TOKEN_DELIMITER.open).toBe('{{');
    expect(TOKEN_DELIMITER.close).toBe('}}');
    expect(tokenPlaceholder(TOKEN_NAMES.officePhone)).toBe('{{Office_Phone}}');
  });

  it('keeps every fallback_text key a bare token name with no delimiter', () => {
    const resolved = new Set<string>(Object.values(TOKEN_NAMES));

    for (const name of FALLBACK_TOKEN_NAMES) {
      expect(name).not.toContain(TOKEN_DELIMITER.open);
      expect(name).not.toContain(TOKEN_DELIMITER.close);
      expect(resolved.has(name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Requirements 14.13, 14.14 — the sender name
// ---------------------------------------------------------------------------

describe('resolveSenderName (Requirements 14.13, 14.14)', () => {
  it('renders the assigned employee display name where the employee is usable', () => {
    expect(resolveSenderName({ display_name: 'Maria Gomez', is_active: true, is_deleted: false }, SETTINGS.agency_name))
      .toBe('Maria Gomez');
    // An absent `is_active` means the caller did not select the column; `profiles.is_active`
    // defaults to true, so the employee is read as active.
    expect(resolveSenderName({ display_name: 'Maria Gomez' }, SETTINGS.agency_name)).toBe('Maria Gomez');
    expect(resolveSenderName({ display_name: '  Maria Gomez  ' }, SETTINGS.agency_name)).toBe('Maria Gomez');
  });

  it.each<[string, Parameters<typeof resolveSenderName>[0]]>([
    ['absent', null],
    ['undefined', undefined],
    ['inactive', { display_name: 'Maria Gomez', is_active: false }],
    ['marked deleted', { display_name: 'Maria Gomez', is_deleted: true }],
    ['blank-named', { display_name: '' }],
    ['whitespace-named', { display_name: '   ' }],
    ['named with an absent marker', { display_name: 'nan' }],
    ['null-named', { display_name: null }],
  ])('renders Agency_Name for a %s employee', (_label, employee) => {
    expect(resolveSenderName(employee, SETTINGS.agency_name)).toBe(SETTINGS.agency_name);
  });

  it('is what renderMessage reports and renders, with Producer_Name taking the fallback path', () => {
    const withEmployee = renderOk();
    expect(withEmployee.senderName).toBe('Maria Gomez');
    expect(withEmployee.body).toContain('Your agent: Maria Gomez');

    const withoutEmployee = renderOk({ senderName: null });
    expect(withoutEmployee.senderName).toBe(SETTINGS.agency_name);
    expect(withoutEmployee.body).toContain('Your agent: our team');
    expect(withoutEmployee.body).toContain('Su agente: nuestro equipo');
  });

  it('carries one signature where the sender name is Agency_Name', () => {
    const result = renderOk({
      senderName: null,
      cases: COMBINED_CASES,
      combined: true,
      channel: 'sms',
    });

    expect(countOccurrences(result.body, SETTINGS.agency_name)).toBe(1);
  });
});

describe('segmentLanguages', () => {
  it('returns one segment per single language and both in order for Bilingual', () => {
    expect(segmentLanguages('English')).toEqual(['English']);
    expect(segmentLanguages('Spanish')).toEqual(['Spanish']);
    expect(segmentLanguages('Bilingual')).toEqual(['English', 'Spanish']);
    expect(segmentLanguages('Bilingual')).toEqual(BILINGUAL_SEGMENT_ORDER);
  });
});

// ---------------------------------------------------------------------------
// Requirements 14.8, 14.9 — the content gate
// ---------------------------------------------------------------------------

describe('prohibited phrase gate (Requirements 14.8, 14.9)', () => {
  /**
   * A stored phrase padded and broken across lines, so the Requirement 14.8 comparison has work to
   * do, and deliberately absent from `BASE_PHRASES` so the reported match can only be this row.
   */
  const STORED_PHRASE = 'We   WILL restore your\ncoverage';

  /** The stored statement that carries the phrase in the form a template would write it. */
  const OFFENDING_STATEMENT = 'According to our records, we will restore your coverage once payment posts.';

  const phrases: readonly ProhibitedPhraseRow[] = [
    ...BASE_PHRASES,
    { id: 'pp-blocking', phrase: STORED_PHRASE, language: 'English', is_active: true },
  ];

  function withPhraseInBody(): RenderResult {
    return renderMessage(baseInput({
      prohibitedPhrases: phrases,
      templateVersions: templateVersions({ englishStatement: OFFENDING_STATEMENT }),
    }));
  }

  it('blocks the body and returns the matched phrase as stored, with no rendered text to store', () => {
    const result = blocked(withPhraseInBody());

    expect(result.blockedBy).toBe('prohibited_phrase');
    expect(result.match).toBe(STORED_PHRASE);
    expect(result.field).toBe('body');
    // Nothing to store: a blocked render carries no subject and no body, which is what makes
    // Requirement 14.9's "no Communication_Record for that Idempotency_Key" reachable.
    expect('body' in result).toBe(false);
    expect('subject' in result).toBe(false);
    expect('templateVersionId' in result).toBe(false);
  });

  it('blocks the subject before the body', () => {
    const result = blocked(renderMessage(baseInput({
      prohibitedPhrases: phrases,
      templateVersions: templateVersions({
        englishSubject: 'Notice: we will restore your coverage',
        englishStatement: OFFENDING_STATEMENT,
      }),
    })));

    expect(result.field).toBe('subject');
    expect(result.match).toBe(STORED_PHRASE);
  });

  it('matches a Spanish phrase in a Spanish segment', () => {
    const result = blocked(renderMessage(baseInput({
      templateVersions: templateVersions({
        spanishStatement: 'Según nuestros registros, su póliza será reactivada al recibir el pago.',
      }),
    })));

    expect(result.blockedBy).toBe('prohibited_phrase');
    expect(result.match).toBe('su póliza será reactivada');
  });

  it('enforces only active rows', () => {
    const inactive = phrases.map((row) => (
      row.id === 'pp-blocking' ? { ...row, is_active: false } : row
    ));
    const result = rendered(renderMessage(baseInput({
      prohibitedPhrases: inactive,
      templateVersions: templateVersions({ englishStatement: OFFENDING_STATEMENT }),
    })));

    expect(result.body).toContain('we will restore your coverage');
  });

  it('lets a clean message through with the phrase list supplied', () => {
    const result = renderOk({ prohibitedPhrases: phrases });

    expect(result.ok).toBe(true);
    expect(result.body).toContain(EN_STATEMENT);
  });

  it('does not block on a zero-character stored phrase', () => {
    const result = rendered(renderMessage(baseInput({
      prohibitedPhrases: [{ id: 'pp-blank', phrase: '   ' }],
    })));

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism and the reported result shape
// ---------------------------------------------------------------------------

describe('the rendered result', () => {
  it('reports the English row as the stored template version and both rows in segment order', () => {
    const bilingual = renderOk();
    expect(bilingual.templateVersionIds).toEqual(['tv-en-15', 'tv-es-15']);
    expect(bilingual.templateVersionId).toBe(bilingual.templateVersionIds[0]);

    const spanish = renderOk({ contact: { preferred_language: 'Spanish' } });
    expect(spanish.templateVersionIds).toEqual(['tv-es-15']);
    expect(spanish.templateVersionId).toBe('tv-es-15');
  });

  it('renders the same characters twice for the same input, so a stored record can be re-rendered', () => {
    const first = renderOk({ cases: COMBINED_CASES, combined: true });
    const second = renderOk({ cases: COMBINED_CASES, combined: true });

    expect(second.subject).toBe(first.subject);
    expect(second.body).toBe(first.body);
  });

  it('accepts one contact row or several covering the same normalized value', () => {
    const one = renderOk({ contact: { preferred_language: 'Spanish', contact_name: 'Rosa' } });
    const many = renderOk({
      contact: [
        { preferred_language: 'Spanish', contact_name: null },
        { preferred_language: 'Spanish', contact_name: 'Rosa' },
      ],
    });

    expect(many.language).toBe(one.language);
    expect(many.body).toBe(one.body);
  });

  it('renders Contact_Name from the first contact row that stores one', () => {
    const result = renderOk({
      contact: [{ preferred_language: 'English', contact_name: '  ' }, { preferred_language: 'English', contact_name: 'Rosa Ruiz' }],
      templateVersions: templateVersions({ englishBody: `Attn: ${tokenPlaceholder(TOKEN_NAMES.contactName)}` }),
    });

    expect(result.body).toContain('Attn: Rosa Ruiz');
  });
});

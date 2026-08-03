// src/features/cancellations/render/__tests__/forbidden-token.property.test.ts
//
// Feature: policy-follow-up-renewals-cancellations, Property 3: For any cancellation case, contact, touchpoint, channel, and render language — including cases where the producer name, amount due, assigned employee, contact name, carrier, or cancellation reason is absent — the rendered subject and the rendered body contain none of the tokens nan, NaN, None, null, undefined as a complete token bounded by the start of the text, the end of the text, a whitespace character, or a character that is neither a letter nor a digit.
//
// **Validates: Requirements 14.11, 14.12, 25.6**
//
// The invariant is `forbiddenTokenMatch(subject) === null && forbiddenTokenMatch(body) === null`,
// asserted for every `ok: true` render. It is conditional on `ok: true` on purpose: a blocked render
// is the Requirement 14.9 gate doing its job, not a violation, and Requirement 14.10 makes that the
// recoverable path (zero Communication_Record rows, `Manual Follow-up Required`, the run continues).
//
// ---------------------------------------------------------------------------------------------
// THE VACUITY RISK, AND THE FOUR THINGS THIS FILE ASSERTS BECAUSE OF IT
// ---------------------------------------------------------------------------------------------
// The gate is the last step inside `renderMessage`, so the property is close to true by
// construction: anything the renderer would have leaked is blocked instead. Two failure modes
// therefore survive a green property run, and both are ways of passing while testing nothing:
//
//   (a) **A generator that never feeds a marker.** The renderer already handles the VALUE side of
//       Requirement 14.12: a case, contact, or employee value whose whole trimmed text is one of
//       the absent markers is treated as absent and takes the Requirement 14.11 fallback path. Feed
//       only clean values and the property holds without exercising any of that. So the generator
//       feeds the markers in as real values — `customer_name: 'nan'`, `carrier: 'None'`, an employee
//       `display_name: 'null'`, an `amount_due` of `'undefined'` — and as values that merely
//       *contain* those letters, so the boundary rule is driven in both directions.
//
//   (b) **A renderer that blocks everything.** Returning `ok: false` unconditionally satisfies the
//       property perfectly. Three assertions close that off:
//         1. the `ok: true` density and the shape counters below, all asserted after the run;
//         2. `wholeMarkerLive` — a render whose body demonstrably CHANGES when the marker-valued
//            fields are swapped for clean ones, which proves the marker slot reached the output and
//            that substitution, not blocking, is what kept the body compliant;
//         3. the strict direction: a world carrying no bare marker token anywhere MUST render
//            `ok: true`. Over-blocking fails this immediately.
//
// On top of the property, the two discrimination assertions the property cannot make on its own:
//
//   1. **A sequence inside a longer word is compliant and must render.** `Nanette Nunez`,
//      `Nullson`, `Aznanian`, `Nonemergency`, `nulló`, `Hernandez` each produce `ok: true` with the
//      name intact in the body. Without this, a gate that matched substrings would pass Property 3.
//   2. **A bare marker token blocks or is substituted away**, and never appears in a rendered body:
//      the whole-value form is substituted away (`ok: true`, no marker in the body), while a marker
//      sitting inside longer text — `nan nan`, `str(None)`, a stored template body carrying a bare
//      `nan` — is blocked.
//
// One correction carried from task 12.2: `Undefined Holdings LLC` **does** block, and per
// Requirement 14.12 it must. `Undefined` there is a complete token bounded by the start of the text
// and a whitespace character, and the criterion names both as boundaries. It is generator input
// here, never a must-render example.
//
// ---------------------------------------------------------------------------------------------
// THE REAL-DATA ANCHOR
// ---------------------------------------------------------------------------------------------
// Requirement 14.12 exists because of one observed defect and one observed near-miss in the legacy
// `avisos` export: 15 of its 51 `MensajeEmail` values carry the literal token `nan` in the signature
// block where the producer name was absent, but a plain substring count returns 16 — the 16th body
// carries the letters inside the surname `Hernandez`. That one row is the entire reason the rule is
// a boundary rule rather than a substring scan, and it is asserted at the bottom of this file, both
// against a synthetic reconstruction that always runs and against the real report when reachable.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseCsv } from '../../import/csv';
import { FORBIDDEN_TOKENS, forbiddenTokenMatch, prohibitedPhraseMatch } from '../gate';
import {
  ABSENT_MARKER_TOKENS,
  FALLBACK_TOKEN_NAMES,
  MAX_COMBINED_CASES,
  MAX_COMBINED_SMS_BODY_LENGTH,
  TOKEN_NAMES,
  TOUCHPOINTS,
  renderMessage,
  tokenPlaceholder,
  type ProhibitedPhraseRow,
  type RenderCase,
  type RenderChannel,
  type RenderContact,
  type RenderMessageInput,
  type RenderResult,
  type RenderSettings,
  type TemplateLanguage,
  type TemplateVersionRow,
  type Touchpoint,
} from '../renderMessage';

/** Runs of the property. Requirement 25.6 and task 12.3 set the floor at 100. */
const NUM_RUNS = 500;

// ---------------------------------------------------------------------------
// Value pools
// ---------------------------------------------------------------------------

/**
 * How a generated string value relates to Requirement 14.12. The tag is bookkeeping only — the
 * renderer never sees it — and it is what lets the strict direction below distinguish "this world
 * carries a bare token, so blocking is correct" from "this world carries none, so blocking is a
 * defect".
 */
type ValueKind =
  /** Absent: `null`, which is the Requirement 14.11 fallback path with nothing to substitute. */
  | 'absent'
  /** Carries none of the four sequences in any form. */
  | 'clean'
  /** Carries a sequence INSIDE a longer word, which Requirement 14.12 calls compliant. */
  | 'embedded'
  /** The whole trimmed value IS a marker, so the renderer treats it as absent (Req 14.11/14.12). */
  | 'wholeMarker'
  /** Carries a marker as a complete token inside longer text, so the gate must block it. */
  | 'bareToken';

interface TaggedValue {
  readonly kind: ValueKind;
  readonly text: string | null;
}

/** Values with no forbidden sequence at all, and no prefix that could form one by adjacency. */
const CLEAN_NAMES = [
  'Yailen Olazaba',
  'José Martínez',
  'PAINT & DRYWALL SOLUCIÓN LLC',
  'Glass Innovation Systems LLC',
  'Ann Diaz',
] as const;

/**
 * Values that legitimately carry one of the four sequences inside a longer word. Requirement 14.12
 * calls every one of these compliant, so each must render rather than block.
 *
 * `Hernandez` is the real 16th `avisos` row. `nulló` is why the gate reads "letter" as the Unicode
 * letter property rather than as ASCII: `null` followed by `ó` is still inside a word.
 * `Undefinedable Systems` is synthetic — the `undefined` sequence does not embed in real customer
 * names — and is here so the compliant direction covers all four sequences, not three.
 */
const EMBEDDED_NAMES = [
  'Nanette Nunez',
  'Hernandez',
  'Aznanian',
  'Nullson',
  'Nullarbor Freight',
  'nulló',
  'Nonemergency Services',
  'Nonesuch Realty',
  'Undefinedable Systems',
] as const;

/**
 * Values whose whole trimmed text is one absent marker. Every one of these must be treated as
 * absent and take the Requirement 14.11 path, so none of them may reach a rendered body.
 * Case variants and whitespace padding are included because Requirement 14.12 compares without case
 * sensitivity and the renderer trims before comparing.
 */
const WHOLE_MARKERS = [
  'nan',
  'NaN',
  'NAN',
  'None',
  'none',
  'null',
  'NULL',
  'undefined',
  'Undefined',
  '  nan  ',
  '\tNone\n',
] as const;

/**
 * Values carrying a marker as a complete token inside longer text. The whole-value rule cannot catch
 * any of these, so the gate is what must, which is exactly why Requirement 14.9 puts the gate after
 * assembly. `Atentamente,\nnan` is the shape of the real legacy signature block;
 * `Undefined Holdings LLC` is the 12.2 correction — a complete token bounded by the start of the
 * text and a space, so it blocks.
 */
const BARE_TOKEN_VALUES = [
  'nan nan',
  'Producer: nan',
  'str(None)',
  'value = null',
  'undefined - pending',
  'Undefined Holdings LLC',
  'Atentamente,\nnan',
] as const;

/** The clean value a marker is swapped for when a world is neutralized. */
const NEUTRAL_NAME = 'Yailen Olazaba';
const NEUTRAL_AMOUNT = '1250.00';

const CLEAN_PROSE = [
  'Our records show the premium payment was not received.',
  'Nuestros registros indican que no recibimos el pago de la prima.',
  'Please review the details below.',
] as const;

const CLEAN_AMOUNTS: readonly (string | number)[] = ['1250.00', '$1,250.00', '0.01', '999999999.99', '75', 1250.5];

/** Amount cells that are not currency amounts. Both routes end absent, so neither can leak. */
const UNPARSEABLE_AMOUNTS = ['pendiente', '-25.00', '1,23,456'] as const;

const POLICY_NUMBERS = ['BWG63424074', '007-ABC-991', 'AAA1234567', 'PLP0000123', 'ZZ-9'] as const;

const AGENCY_NAMES = [
  { kind: 'clean', text: 'New Hope Insurance Agency' },
  { kind: 'clean', text: 'New Hope Insurance Agency, LLC' },
  // Embeds `nan` inside `Nanette` and reaches EVERY rendered body through Requirement 14.1, so the
  // compliant direction of the boundary rule is exercised on almost every run.
  { kind: 'embedded', text: 'Nanette & Nunez Insurance Agency' },
] as const satisfies readonly TaggedValue[];

const OFFICE_PHONES = ['(704) 824-3130', '+1 704-824-3130', '7048243130'] as const;

const BILINGUAL_SEPARATORS = ['\n---\n', ' | ', '\n\n***\n\n'] as const;

/**
 * The Requirement 14.7 list, one English and one Spanish phrase for each of the five prohibited
 * claims, plus one retired row to confirm `is_active = false` is not enforced.
 *
 * Deliberately disjoint from every text pool above: this file is about the token half of the gate,
 * so a phrase block would only reduce the `ok: true` density it depends on. The disjointness is
 * asserted rather than assumed — see "the phrase list stays disjoint" below — so a later edit to a
 * pool cannot start blocking on phrases and quietly hollow out this property.
 */
const PROHIBITED_PHRASES: readonly ProhibitedPhraseRow[] = [
  { id: 'p1', phrase: 'your policy will be reinstated', language: 'English', claim_category: 'reinstatement_promise' },
  { id: 'p2', phrase: 'su póliza será reactivada', language: 'Spanish', claim_category: 'reinstatement_promise' },
  { id: 'p3', phrase: 'payment guarantees continued coverage', language: 'English', claim_category: 'coverage_guarantee' },
  { id: 'p4', phrase: 'el pago garantiza la continuidad de su cobertura', language: 'Spanish', claim_category: 'coverage_guarantee' },
  { id: 'p5', phrase: 'send us your credit card number', language: 'English', claim_category: 'payment_card_request' },
  { id: 'p6', phrase: 'envíenos el número de su tarjeta de crédito', language: 'Spanish', claim_category: 'payment_card_request' },
  { id: 'p7', phrase: 'reply with your bank account number', language: 'English', claim_category: 'bank_account_request' },
  { id: 'p8', phrase: 'responda con el número de su cuenta bancaria', language: 'Spanish', claim_category: 'bank_account_request' },
  { id: 'p9', phrase: 'this is the official legal notice from your carrier', language: 'English', claim_category: 'official_legal_notice' },
  { id: 'p10', phrase: 'este es el aviso legal oficial de su compañía', language: 'Spanish', claim_category: 'official_legal_notice' },
  { id: 'p11', phrase: 'retired wording kept for evidence', language: 'English', claim_category: 'official_legal_notice', is_active: false },
];

// ---------------------------------------------------------------------------
// Stored template text
// ---------------------------------------------------------------------------

/** `{{Name}}`, built from the renderer's own delimiter so this file never restates it. */
const t = (name: string): string => tokenPlaceholder(name);

const STATEMENTS: Readonly<Record<TemplateLanguage, string>> = {
  English: 'According to our records, your policy is scheduled for cancellation.',
  Spanish: 'Según nuestros registros, su póliza está programada para cancelación.',
};

const CONTACT_REQUESTS: Readonly<Record<TemplateLanguage, string>> = {
  English: `Please call our office before ${t(TOKEN_NAMES.contactDeadline)} so we can review your options.`,
  Spanish: `Comuníquese con nuestra oficina antes del ${t(TOKEN_NAMES.contactDeadline)} para revisar sus opciones.`,
};

const BODY_LABELS: Readonly<Record<TemplateLanguage, Readonly<Record<string, string>>>> = {
  English: {
    customer: 'Customer',
    policy: 'Policy',
    carrier: 'Carrier',
    reason: 'Reason for cancellation',
    amount: 'Amount due',
    producer: 'Your agent',
    contact: 'Attention',
    date: 'Cancellation effective date',
    covers: 'This notice covers',
  },
  Spanish: {
    customer: 'Cliente',
    policy: 'Póliza',
    carrier: 'Compañía',
    reason: 'Motivo de cancelación',
    amount: 'Monto debido',
    producer: 'Su agente',
    contact: 'Atención',
    date: 'Fecha efectiva de cancelación',
    covers: 'Este aviso cubre',
  },
};

/** Which optional lines a generated template body carries. */
interface BodyShape {
  readonly optionalLines: boolean;
  readonly dateLine: boolean;
  readonly policyList: boolean;
  readonly countLine: boolean;
}

type SubjectShape = 'tokens' | 'plain' | 'empty';

/**
 * One stored body, laid out the way task 7.10 has to seed it: each optional value on its own line,
 * which is what makes the renderer's drop-the-line rule enough for Requirement 14.11.
 */
function storedBody(language: TemplateLanguage, shape: BodyShape): string {
  const label = BODY_LABELS[language];
  const lines: string[] = [
    t(TOKEN_NAMES.cancellationStatement),
    `${label.customer}: ${t(TOKEN_NAMES.customerName)}`,
    `${label.policy}: ${t(TOKEN_NAMES.policyNumber)}`,
  ];
  if (shape.optionalLines) {
    lines.push(
      `${label.carrier}: ${t(TOKEN_NAMES.carrier)}`,
      `${label.reason}: ${t(TOKEN_NAMES.cancellationReason)}`,
      `${label.amount}: ${t(TOKEN_NAMES.amountDue)}`,
      `${label.producer}: ${t(TOKEN_NAMES.producerName)}`,
      `${label.contact}: ${t(TOKEN_NAMES.contactName)}`,
    );
  }
  if (shape.dateLine) lines.push(`${label.date}: ${t(TOKEN_NAMES.cancellationDate)}`);
  if (shape.policyList) lines.push(t(TOKEN_NAMES.policyList));
  if (shape.countLine) lines.push(`${label.covers} ${t(TOKEN_NAMES.policyCount)}.`);
  lines.push(
    t(TOKEN_NAMES.contactRequest),
    `${t(TOKEN_NAMES.senderName)} - ${t(TOKEN_NAMES.agencyName)} - ${t(TOKEN_NAMES.officePhone)}`,
  );
  return lines.join('\n');
}

function storedSubject(language: TemplateLanguage, shape: SubjectShape): string {
  if (shape === 'empty') return '';
  if (shape === 'plain') {
    return language === 'English'
      ? `Cancellation notice from ${t(TOKEN_NAMES.agencyName)}`
      : `Aviso de cancelación de ${t(TOKEN_NAMES.agencyName)}`;
  }
  return language === 'English'
    ? `Cancellation notice for ${t(TOKEN_NAMES.customerName)} - policy ${t(TOKEN_NAMES.policyNumber)}`
    : `Aviso de cancelación para ${t(TOKEN_NAMES.customerName)} - póliza ${t(TOKEN_NAMES.policyNumber)}`;
}

// ---------------------------------------------------------------------------
// The generated world
// ---------------------------------------------------------------------------

interface GeneratedTemplate {
  readonly body: BodyShape;
  readonly subject: SubjectShape;
  /** Extra prose appended to the stored statement: the template-text side of the token rule. */
  readonly prose: TaggedValue;
  /** `fallback_text`, keyed by BARE token name exactly as v1.10.1 documents reading it. */
  readonly fallback: Readonly<Record<string, TaggedValue>>;
}

interface GeneratedAmount {
  readonly kind: 'absent' | 'clean' | 'wholeMarker' | 'unparseable';
  readonly value: string | number | null;
}

interface GeneratedCase {
  readonly policyNumber: string;
  readonly effectiveDate: string;
  readonly customerName: TaggedValue;
  readonly carrier: TaggedValue;
  readonly reason: TaggedValue;
  readonly amountDue: GeneratedAmount;
  readonly touchpoint: Touchpoint | null;
}

interface GeneratedContact {
  readonly preferredLanguage: string | null | undefined;
  readonly contactName: TaggedValue;
  readonly value: string;
  /**
   * True where this contact stores the world's shared preferred language rather than its own.
   *
   * Requirement 11.3 resolves a single-language render only where every included contact stores the
   * same recognized value, so drawing each contact's language independently makes an English-only or
   * Spanish-only render vanishingly rare: a first run at fully independent draws produced zero of
   * either in 300 worlds. Most contacts therefore share one language, and the rest dissent, which is
   * what exercises the mixed-language path back to Bilingual.
   */
  readonly usesSharedLanguage: boolean;
}

interface GeneratedEmployee {
  readonly displayName: TaggedValue;
  readonly isActive: boolean;
  readonly isDeleted: boolean;
}

interface World {
  readonly template: GeneratedTemplate;
  readonly cases: readonly GeneratedCase[];
  readonly contacts: readonly GeneratedContact[];
  readonly employee: GeneratedEmployee | null;
  readonly touchpoint: Touchpoint;
  readonly channel: RenderChannel;
  readonly combined: boolean;
  readonly settings: RenderSettings;
  readonly agencyNameKind: ValueKind;
  /**
   * False for a world drawn entirely from the compliant pools. Roughly three worlds in four, which
   * is what keeps the `ok: true` density — and therefore the property itself — non-vacuous, and what
   * makes the strict direction assertable.
   */
  readonly allowBareTokens: boolean;
}

const taggedValueArb: fc.Arbitrary<TaggedValue> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...CLEAN_NAMES).map((text): TaggedValue => ({ kind: 'clean', text })) },
  { weight: 4, arbitrary: fc.constantFrom(...EMBEDDED_NAMES).map((text): TaggedValue => ({ kind: 'embedded', text })) },
  { weight: 4, arbitrary: fc.constantFrom(...WHOLE_MARKERS).map((text): TaggedValue => ({ kind: 'wholeMarker', text })) },
  { weight: 2, arbitrary: fc.constantFrom(...BARE_TOKEN_VALUES).map((text): TaggedValue => ({ kind: 'bareToken', text })) },
  { weight: 2, arbitrary: fc.constant<TaggedValue>({ kind: 'absent', text: null }) },
  { weight: 1, arbitrary: fc.constantFrom('', '   ').map((text): TaggedValue => ({ kind: 'absent', text })) },
);

const proseArb: fc.Arbitrary<TaggedValue> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...CLEAN_PROSE).map((text): TaggedValue => ({ kind: 'clean', text })) },
  { weight: 3, arbitrary: fc.constantFrom(...EMBEDDED_NAMES).map((text): TaggedValue => ({ kind: 'embedded', text: `Handled by ${text}.` })) },
  { weight: 2, arbitrary: fc.constantFrom(...BARE_TOKEN_VALUES).map((text): TaggedValue => ({ kind: 'bareToken', text })) },
  { weight: 4, arbitrary: fc.constant<TaggedValue>({ kind: 'absent', text: null }) },
);

/**
 * An amount cell. No route through `parseAmountDue` can put a marker in a body — an accepted value
 * is reformatted to digits and every rejected value renders as absent — so no amount is ever tagged
 * `bareToken`, and `'nan nan'` is generated here as an unparseable value rather than as a hazard.
 */
const amountArb: fc.Arbitrary<GeneratedAmount> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...CLEAN_AMOUNTS).map((value): GeneratedAmount => ({ kind: 'clean', value })) },
  { weight: 4, arbitrary: fc.constantFrom(...WHOLE_MARKERS).map((value): GeneratedAmount => ({ kind: 'wholeMarker', value })) },
  { weight: 2, arbitrary: fc.constantFrom(...UNPARSEABLE_AMOUNTS, 'nan nan').map((value): GeneratedAmount => ({ kind: 'unparseable', value })) },
  { weight: 2, arbitrary: fc.constant<GeneratedAmount>({ kind: 'absent', value: null }) },
);

/**
 * A cancellation effective date in one of the two forms `parseCancellationDate` accepts. Built from
 * integers with the day capped at 28 so no generated date is a non-existent calendar date, which
 * would be a `RenderInputError` rather than a render.
 *
 * `fc.date()` is deliberately not used: on fast-check v4 it emits `Invalid Date` unless
 * `noInvalidDate: true` is passed, and a sibling spec's test broke on exactly that.
 */
const effectiveDateArb: fc.Arbitrary<string> = fc
  .record({
    year: fc.integer({ min: 2024, max: 2030 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
    usForm: fc.boolean(),
  })
  .map(({ year, month, day, usForm }) =>
    usForm
      ? `${month}/${day}/${year}`
      : `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );

const caseArb: fc.Arbitrary<GeneratedCase> = fc.record({
  policyNumber: fc.constantFrom(...POLICY_NUMBERS),
  effectiveDate: effectiveDateArb,
  customerName: taggedValueArb,
  carrier: taggedValueArb,
  reason: taggedValueArb,
  amountDue: amountArb,
  touchpoint: fc.option(fc.constantFrom(...TOUCHPOINTS), { nil: null, freq: 4 }),
});

/**
 * Requirement 11.2: the three stored values plus every shape that has to fall back to Bilingual —
 * absent, `null`, empty, whitespace-only, and unrecognized. The two single-language values carry
 * extra weight so a single-language render is reached often enough to be asserted.
 */
const preferredLanguageArb: fc.Arbitrary<string | null | undefined> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<string | null | undefined>('English') },
  { weight: 3, arbitrary: fc.constant<string | null | undefined>('Spanish') },
  { weight: 2, arbitrary: fc.constant<string | null | undefined>('Bilingual') },
  { weight: 1, arbitrary: fc.constant<string | null | undefined>(undefined) },
  { weight: 1, arbitrary: fc.constant<string | null | undefined>(null) },
  { weight: 1, arbitrary: fc.constant<string | null | undefined>('') },
  { weight: 1, arbitrary: fc.constant<string | null | undefined>('  ') },
  { weight: 1, arbitrary: fc.constant<string | null | undefined>('Klingon') },
);

const contactArb: fc.Arbitrary<GeneratedContact> = fc.record({
  preferredLanguage: preferredLanguageArb,
  contactName: taggedValueArb,
  value: fc.constantFrom('+17048243130', '7048243130', 'yailen@example.com', 'jose.martinez@example.com'),
  usesSharedLanguage: fc.oneof(
    { weight: 4, arbitrary: fc.constant(true) },
    { weight: 1, arbitrary: fc.constant(false) },
  ),
});

const employeeArb: fc.Arbitrary<GeneratedEmployee | null> = fc.option(
  fc.record({
    displayName: taggedValueArb,
    isActive: fc.oneof(
      { weight: 4, arbitrary: fc.constant(true) },
      { weight: 1, arbitrary: fc.constant(false) },
    ),
    isDeleted: fc.oneof(
      { weight: 4, arbitrary: fc.constant(false) },
      { weight: 1, arbitrary: fc.constant(true) },
    ),
  }),
  { nil: null, freq: 4 },
);

const templateArb: fc.Arbitrary<GeneratedTemplate> = fc.record({
  body: fc.record({
    optionalLines: fc.boolean(),
    dateLine: fc.boolean(),
    policyList: fc.boolean(),
    countLine: fc.boolean(),
  }),
  subject: fc.constantFrom<SubjectShape>('tokens', 'plain', 'empty'),
  prose: proseArb,
  fallback: fc.record(
    Object.fromEntries(
      FALLBACK_TOKEN_NAMES.map((name) => [
        name,
        fc.oneof(
          { weight: 4, arbitrary: fc.constantFrom(...CLEAN_NAMES).map((text): TaggedValue => ({ kind: 'clean', text })) },
          { weight: 2, arbitrary: fc.constantFrom(...EMBEDDED_NAMES).map((text): TaggedValue => ({ kind: 'embedded', text })) },
          { weight: 2, arbitrary: fc.constantFrom(...WHOLE_MARKERS).map((text): TaggedValue => ({ kind: 'wholeMarker', text })) },
          { weight: 1, arbitrary: fc.constantFrom(...BARE_TOKEN_VALUES).map((text): TaggedValue => ({ kind: 'bareToken', text })) },
          { weight: 3, arbitrary: fc.constant<TaggedValue>({ kind: 'absent', text: null }) },
        ),
      ]),
    ) as Record<string, fc.Arbitrary<TaggedValue>>,
  ),
});

/**
 * One case, or 2 to 10 for a combined message (Requirement 13.5). Weighted toward one case rather
 * than left to the array-size bias: a combined message is always Bilingual under Requirement 11.8,
 * so single-case worlds are the only ones that can reach an English-only or Spanish-only render, and
 * they are also the only ones where the carrier, the cancellation reason, and the amount due resolve
 * to a value at all.
 */
const casesArb: fc.Arbitrary<readonly GeneratedCase[]> = fc.oneof(
  { weight: 5, arbitrary: fc.array(caseArb, { minLength: 1, maxLength: 1 }) },
  { weight: 2, arbitrary: fc.array(caseArb, { minLength: 2, maxLength: MAX_COMBINED_CASES }) },
);

const rawWorldArb = fc.record({
  template: templateArb,
  cases: casesArb,
  contacts: fc.array(contactArb, { minLength: 1, maxLength: 3 }),
  /** The language most contacts of the world store; see `GeneratedContact.usesSharedLanguage`. */
  sharedLanguage: preferredLanguageArb,
  employee: employeeArb,
  touchpoint: fc.constantFrom(...TOUCHPOINTS),
  channel: fc.constantFrom<RenderChannel>('sms', 'email'),
  combined: fc.boolean(),
  agencyName: fc.constantFrom(...AGENCY_NAMES),
  officePhone: fc.constantFrom(...OFFICE_PHONES),
  bilingualSeparator: fc.constantFrom(...BILINGUAL_SEPARATORS),
  allowBareTokens: fc.oneof(
    { weight: 3, arbitrary: fc.constant(false) },
    { weight: 1, arbitrary: fc.constant(true) },
  ),
});

/** Swaps one tagged value for a clean one, keeping everything else about the world identical. */
function swap(value: TaggedValue, from: ValueKind, replacement: string): TaggedValue {
  return value.kind === from ? { kind: 'clean', text: replacement } : value;
}

function mapWorldValues(
  world: World,
  mapValue: (value: TaggedValue) => TaggedValue,
  mapAmount: (amount: GeneratedAmount) => GeneratedAmount,
): World {
  return {
    ...world,
    template: {
      ...world.template,
      prose: mapValue(world.template.prose),
      fallback: Object.fromEntries(
        Object.entries(world.template.fallback).map(([name, value]) => [name, mapValue(value)]),
      ),
    },
    cases: world.cases.map((row) => ({
      ...row,
      customerName: mapValue(row.customerName),
      carrier: mapValue(row.carrier),
      reason: mapValue(row.reason),
      amountDue: mapAmount(row.amountDue),
    })),
    contacts: world.contacts.map((contact) => ({ ...contact, contactName: mapValue(contact.contactName) })),
    employee:
      world.employee === null
        ? null
        : { ...world.employee, displayName: mapValue(world.employee.displayName) },
  };
}

/**
 * The generated world, with bare-token values removed where `allowBareTokens` is false. Doing it as
 * a post-map rather than by threading the flag through every arbitrary keeps shrinking well behaved
 * and keeps one flag in charge of the whole world's hazard level.
 */
const worldArb: fc.Arbitrary<World> = rawWorldArb.map((raw): World => {
  const world: World = {
    template: raw.template,
    cases: raw.cases,
    contacts: raw.contacts.map((contact) => ({
      ...contact,
      preferredLanguage: contact.usesSharedLanguage ? raw.sharedLanguage : contact.preferredLanguage,
    })),
    employee: raw.employee,
    touchpoint: raw.touchpoint,
    channel: raw.channel,
    combined: raw.combined,
    settings: {
      agency_name: raw.agencyName.text ?? 'New Hope Insurance Agency',
      office_phone: raw.officePhone,
      bilingual_separator: raw.bilingualSeparator,
    },
    agencyNameKind: raw.agencyName.kind,
    allowBareTokens: raw.allowBareTokens,
  };
  if (raw.allowBareTokens) return world;
  return mapWorldValues(
    world,
    (value) => swap(value, 'bareToken', NEUTRAL_NAME),
    (amount) => amount,
  );
});

/** The same world with every whole-value marker swapped for a clean value. */
function neutralizeWholeMarkers(world: World): World {
  return mapWorldValues(
    world,
    (value) => swap(value, 'wholeMarker', NEUTRAL_NAME),
    (amount) => (amount.kind === 'wholeMarker' ? { kind: 'clean', value: NEUTRAL_AMOUNT } : amount),
  );
}

// ---------------------------------------------------------------------------
// World -> render input
// ---------------------------------------------------------------------------

function taggedValuesOf(world: World): readonly TaggedValue[] {
  return [
    world.template.prose,
    ...Object.values(world.template.fallback),
    ...world.cases.flatMap((row) => [row.customerName, row.carrier, row.reason]),
    ...world.contacts.map((contact) => contact.contactName),
    ...(world.employee === null ? [] : [world.employee.displayName]),
  ];
}

const carriesKind = (world: World, kind: ValueKind): boolean =>
  taggedValuesOf(world).some((value) => value.kind === kind);

/**
 * True where any generated text of the world carries a marker as a complete token. Deliberately
 * conservative — it does not try to work out whether that value reaches the rendered output, which
 * would mean reimplementing the renderer — so it can only ever make the strict direction weaker,
 * never produce a false failure.
 */
const carriesBareToken = (world: World): boolean => carriesKind(world, 'bareToken');

function buildTemplateVersions(template: GeneratedTemplate): readonly TemplateVersionRow[] {
  const fallbackText = Object.fromEntries(
    Object.entries(template.fallback).map(([name, value]) => [name, value.text]),
  );
  return TOUCHPOINTS.flatMap((touchpoint) =>
    (['English', 'Spanish'] as const).map((language): TemplateVersionRow => ({
      id: `tv-${touchpoint}-${language}`,
      template_id: `tmpl-${touchpoint}`,
      version: 1,
      touchpoint,
      language,
      subject: storedSubject(language, template.subject),
      body: storedBody(language, template.body),
      cancellation_statement:
        template.prose.text === null
          ? STATEMENTS[language]
          : `${STATEMENTS[language]} ${template.prose.text}`,
      contact_request: CONTACT_REQUESTS[language],
      fallback_text: fallbackText,
    })),
  );
}

function buildInput(world: World): RenderMessageInput {
  const cases: readonly RenderCase[] = world.cases.map((row, index) => ({
    id: `case-${index}`,
    policy_number: row.policyNumber,
    cancellation_effective_date: row.effectiveDate,
    customer_name: row.customerName.text,
    carrier: row.carrier.text,
    cancellation_reason: row.reason.text,
    amount_due: row.amountDue.value,
    touchpoint: row.touchpoint,
  }));
  const contacts: readonly RenderContact[] = world.contacts.map((contact, index) => ({
    id: `contact-${index}`,
    channel: world.channel === 'sms' ? 'phone' : 'email',
    normalized_value: contact.value,
    preferred_language: contact.preferredLanguage ?? null,
    contact_name: contact.contactName.text,
  }));
  return {
    templateVersions: buildTemplateVersions(world.template),
    cases,
    contact: contacts,
    touchpoint: world.touchpoint,
    channel: world.channel,
    settings: world.settings,
    senderName:
      world.employee === null
        ? null
        : {
            display_name: world.employee.displayName.text,
            is_active: world.employee.isActive,
            is_deleted: world.employee.isDeleted,
          },
    combined: world.combined,
    prohibitedPhrases: PROHIBITED_PHRASES,
  };
}

// ---------------------------------------------------------------------------
// Property 3
// ---------------------------------------------------------------------------

describe('PBT-3: no forbidden token in any rendered output', () => {
  it('renders no marker as a complete token in any subject or body', () => {
    // Shape counters. Every one of these is asserted after the run: a property whose generator never
    // reached a shape has not tested that shape, and a property whose renders all blocked has not
    // tested anything at all.
    const seen = {
      rendered: 0,
      blockedForbiddenToken: 0,
      /** A render whose body CHANGES when the marker-valued fields are swapped for clean ones. */
      wholeMarkerLive: 0,
      /** A compliant render whose body carries a sequence inside a longer word. */
      embeddedInBody: 0,
      renderedWithMarkerFed: 0,
      emailSubjectRendered: 0,
      smsSubjectEmpty: 0,
      englishRendered: 0,
      spanishRendered: 0,
      bilingualRendered: 0,
      unrecognizedLanguageRendered: 0,
      singleCaseRendered: 0,
      combinedRendered: 0,
      absentEmployeeRendered: 0,
      unusableEmployeeRendered: 0,
      touchpoint15: 0,
      touchpoint10: 0,
      touchpoint5: 0,
      touchpoint1: 0,
      fallbackRendered: 0,
    };
    // Observed, not asserted: a combined SMS cut to 640 characters can split a compliant word into a
    // bare token, and the gate — which runs on the truncated body — then blocks it. Recorded so the
    // exclusion below is an observation rather than a blind spot.
    let blockedWithoutBareToken = 0;

    fc.assert(
      fc.property(worldArb, (world) => {
        const result: RenderResult = renderMessage(buildInput(world));
        const effectivelyCombined = world.combined || world.cases.length > 1;
        const combinedSms = effectivelyCombined && world.channel === 'sms';

        if (!result.ok) {
          // A block is the Requirement 14.9 gate working, so it is not a violation of the property.
          // It still has to be a real, attributable block.
          expect(result.blockedBy).toBe('forbidden_token');
          expect(FORBIDDEN_TOKENS as readonly string[]).toContain(result.match.toLowerCase());
          expect(result.field === 'subject' || result.field === 'body').toBe(true);
          seen.blockedForbiddenToken += 1;

          // The strict direction: over-blocking is a defect. A world drawn entirely from the
          // compliant pools must render. Combined SMS is exempt for the truncation reason above.
          if (!combinedSms) {
            expect(
              carriesBareToken(world),
              'a world carrying no bare marker token was blocked, so the boundary rule is over-blocking',
            ).toBe(true);
          } else if (!carriesBareToken(world)) {
            blockedWithoutBareToken += 1;
          }
          return;
        }

        // ---- THE PROPERTY ------------------------------------------------------------------
        expect(forbiddenTokenMatch(result.subject)).toBeNull();
        expect(forbiddenTokenMatch(result.body)).toBeNull();

        // ---- Bookkeeping and the anti-vacuity levers ---------------------------------------
        seen.rendered += 1;
        if (result.truncated) expect(result.body.length).toBe(MAX_COMBINED_SMS_BODY_LENGTH);

        if (world.channel === 'sms') {
          // Requirement 14.15: zero characters as the rendered subject on the SMS channel.
          expect(result.subject).toBe('');
          seen.smsSubjectEmpty += 1;
        } else if (result.subject.length > 0) {
          seen.emailSubjectRendered += 1;
        }

        if (result.language === 'English') seen.englishRendered += 1;
        if (result.language === 'Spanish') seen.spanishRendered += 1;
        if (result.language === 'Bilingual') seen.bilingualRendered += 1;
        if (
          world.contacts.some((contact) => {
            const stored = typeof contact.preferredLanguage === 'string' ? contact.preferredLanguage.trim() : '';
            return stored !== 'English' && stored !== 'Spanish' && stored !== 'Bilingual';
          })
        ) {
          seen.unrecognizedLanguageRendered += 1;
        }
        if (world.cases.length === 1) seen.singleCaseRendered += 1;
        if (effectivelyCombined) seen.combinedRendered += 1;
        if (world.employee === null) seen.absentEmployeeRendered += 1;
        else if (!world.employee.isActive || world.employee.isDeleted) seen.unusableEmployeeRendered += 1;
        if (result.touchpoint === 15) seen.touchpoint15 += 1;
        if (result.touchpoint === 10) seen.touchpoint10 += 1;
        if (result.touchpoint === 5) seen.touchpoint5 += 1;
        if (result.touchpoint === 1) seen.touchpoint1 += 1;

        if (
          EMBEDDED_NAMES.some((name) => result.body.includes(name))
          || (world.agencyNameKind === 'embedded' && result.body.includes(world.settings.agency_name))
        ) {
          seen.embeddedInBody += 1;
        }
        if (
          Object.values(world.template.fallback).some(
            (value) => value.kind !== 'absent' && value.kind !== 'wholeMarker' && value.text !== null && result.body.includes(value.text),
          )
        ) {
          seen.fallbackRendered += 1;
        }

        // The strongest lever against a vacuous pass: swap every whole-value marker for a clean
        // value and re-render. A body that changes proves the marker slot reached the output, so the
        // compliant body above is the product of Requirement 14.11 substitution rather than of the
        // marker never having been there.
        const markerFed =
          carriesKind(world, 'wholeMarker')
          || world.cases.some((row) => row.amountDue.kind === 'wholeMarker');
        if (markerFed) {
          seen.renderedWithMarkerFed += 1;
          if (!carriesBareToken(world)) {
            const cleaned = renderMessage(buildInput(neutralizeWholeMarkers(world)));
            if (cleaned.ok) {
              expect(forbiddenTokenMatch(cleaned.body)).toBeNull();
              if (cleaned.body !== result.body) seen.wholeMarkerLive += 1;
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );

    // Vacuity guards. The property is close to true by construction — the gate is the last step
    // inside the renderer — so these are what make a green run mean something.
    for (const [shape, count] of Object.entries(seen)) {
      expect(count, `the run never reached: ${shape}`).toBeGreaterThan(0);
    }
    expect(
      seen.rendered / NUM_RUNS,
      'too few worlds rendered, so the property held mostly by blocking',
    ).toBeGreaterThan(0.5);

    // Recorded for the task report; deliberately not asserted, since it depends on whether a
    // generated combined SMS crossed 640 characters at a word boundary.
    expect(blockedWithoutBareToken).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Discrimination assertion 1: a sequence inside a longer word must render
// ---------------------------------------------------------------------------

/**
 * One deliberately plain world, so a discrimination assertion reads as a statement about the value
 * under test rather than about generated noise: one case, one English contact, the email channel,
 * every optional line present, no stored fallback text.
 */
function baselineInput(overrides: {
  readonly customerName?: string | null;
  readonly carrier?: string | null;
  readonly amountDue?: string | number | null;
  readonly employeeName?: string | null;
  readonly contactName?: string | null;
  readonly channel?: RenderChannel;
  readonly statementSuffix?: string;
  readonly fallback?: Readonly<Record<string, string | null>>;
}): RenderMessageInput {
  const bodyShape: BodyShape = { optionalLines: true, dateLine: true, policyList: false, countLine: true };
  const templateVersions: readonly TemplateVersionRow[] = TOUCHPOINTS.flatMap((touchpoint) =>
    (['English', 'Spanish'] as const).map((language): TemplateVersionRow => ({
      id: `tv-${touchpoint}-${language}`,
      template_id: `tmpl-${touchpoint}`,
      version: 1,
      touchpoint,
      language,
      subject: storedSubject(language, 'tokens'),
      body: storedBody(language, bodyShape),
      cancellation_statement:
        overrides.statementSuffix === undefined
          ? STATEMENTS[language]
          : `${STATEMENTS[language]} ${overrides.statementSuffix}`,
      contact_request: CONTACT_REQUESTS[language],
      fallback_text: overrides.fallback ?? null,
    })),
  );

  return {
    templateVersions,
    cases: [
      {
        id: 'case-0',
        policy_number: 'BWG63424074',
        cancellation_effective_date: '2026-07-31',
        customer_name: overrides.customerName === undefined ? 'Yailen Olazaba' : overrides.customerName,
        carrier: overrides.carrier === undefined ? 'Liberty Mutual' : overrides.carrier,
        cancellation_reason: 'Non-payment of premium',
        amount_due: overrides.amountDue === undefined ? '1250.00' : overrides.amountDue,
        touchpoint: 5,
      },
    ],
    contact: {
      id: 'contact-0',
      channel: (overrides.channel ?? 'email') === 'sms' ? 'phone' : 'email',
      normalized_value: 'yailen@example.com',
      preferred_language: 'English',
      contact_name: overrides.contactName === undefined ? 'Yailen Olazaba' : overrides.contactName,
    },
    touchpoint: 5,
    channel: overrides.channel ?? 'email',
    settings: {
      office_phone: '(704) 824-3130',
      agency_name: 'New Hope Insurance Agency',
      bilingual_separator: '\n---\n',
    },
    senderName:
      overrides.employeeName === undefined
        ? { display_name: 'Lisandro Figueroa', is_active: true, is_deleted: false }
        : { display_name: overrides.employeeName, is_active: true, is_deleted: false },
    combined: false,
    prohibitedPhrases: PROHIBITED_PHRASES,
  };
}

describe('a forbidden sequence inside a longer word is compliant and must render', () => {
  // Every one of these carries `nan`, `none`, `null`, or `undefined` inside a longer word, which
  // Requirement 14.12 calls compliant. A gate that matched substrings would hold each of them for
  // manual follow-up because of the customer's own name — the defect the boundary rule exists to
  // avoid — and would still satisfy Property 3.
  it.each([
    ['Nanette Nunez', 'nan inside a given name'],
    ['Hernandez', 'nan inside the surname of the real 16th avisos row'],
    ['Aznanian', 'nan with a letter on both sides'],
    ['Nullson', 'null inside a surname'],
    ['Nullarbor Freight', 'null inside a company name'],
    ['nulló', 'null followed by a non-ASCII letter'],
    ['Nonemergency Services', 'none inside a compound word'],
    ['Nonesuch Realty', 'none inside a company name'],
    ['Undefinedable Systems', 'undefined inside a longer word'],
  ])('renders %s (%s) with the value intact', (customerName) => {
    const result = renderMessage(baselineInput({ customerName }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain(customerName);
    expect(result.subject).toContain(customerName);
    expect(forbiddenTokenMatch(result.body)).toBeNull();
    expect(forbiddenTokenMatch(result.subject)).toBeNull();
  });

  it('renders an embedded sequence carried by an employee display name, a contact name, and template prose', () => {
    const result = renderMessage(
      baselineInput({
        customerName: 'Nanette Nunez',
        employeeName: 'Hernandez',
        contactName: 'Nullson',
        statementSuffix: 'Handled by Nonesuch Realty.',
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const value of ['Nanette Nunez', 'Hernandez', 'Nullson', 'Nonesuch Realty']) {
      expect(result.body).toContain(value);
    }
    expect(forbiddenTokenMatch(result.body)).toBeNull();
    expect(result.senderName).toBe('Hernandez');
  });
});

// ---------------------------------------------------------------------------
// Discrimination assertion 2: a bare marker never reaches a rendered body
// ---------------------------------------------------------------------------

describe('a bare marker token is substituted away or blocks, and never reaches a rendered body', () => {
  // The value side of Requirement 14.12: a value that is nothing but a marker is absent, so it takes
  // the Requirement 14.11 path and renders as the stored fallback or as zero characters.
  it.each([...WHOLE_MARKERS])('substitutes away a customer name of %j', (customerName) => {
    const result = renderMessage(baselineInput({ customerName }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(forbiddenTokenMatch(result.body)).toBeNull();
    expect(forbiddenTokenMatch(result.subject)).toBeNull();
    // No fallback is stored for Customer_Name, so the line carrying it renders zero characters and
    // drops rather than reaching the customer as `Customer:`.
    expect(result.body).not.toContain('Customer:');
  });

  it('substitutes away markers arriving as a carrier, an amount due, and an employee display name', () => {
    const result = renderMessage(
      baselineInput({ carrier: 'None', amountDue: 'undefined', employeeName: 'null', contactName: 'nan' }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(forbiddenTokenMatch(result.body)).toBeNull();
    // Requirement 14.14: an unusable display name renders Agency_Name as the sender name.
    expect(result.senderName).toBe('New Hope Insurance Agency');
    for (const label of ['Carrier:', 'Amount due:', 'Your agent:', 'Attention:']) {
      expect(result.body).not.toContain(label);
    }
  });

  it('renders the stored fallback text in place of a marker-valued field (Requirement 14.11)', () => {
    const result = renderMessage(
      baselineInput({
        carrier: 'nan',
        amountDue: 'None',
        employeeName: 'undefined',
        fallback: { [TOKEN_NAMES.carrier]: 'your insurance carrier', [TOKEN_NAMES.producerName]: 'our service team' },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain('Carrier: your insurance carrier');
    expect(result.body).toContain('Your agent: our service team');
    // No fallback is stored for Amount_Due, so that line renders zero characters and drops.
    expect(result.body).not.toContain('Amount due:');
    expect(forbiddenTokenMatch(result.body)).toBeNull();
  });

  it('renders zero characters where the stored fallback is itself a marker', () => {
    const result = renderMessage(
      baselineInput({ carrier: 'nan', fallback: { [TOKEN_NAMES.carrier]: 'None' } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).not.toContain('Carrier:');
    expect(forbiddenTokenMatch(result.body)).toBeNull();
  });

  // The text side: a marker that the whole-value rule cannot catch is what the gate is for.
  it.each([
    ['nan nan', 'nan'],
    ['Producer: nan', 'nan'],
    ['str(None)', 'None'],
    ['value = null', 'null'],
    ['undefined - pending', 'undefined'],
    // The 12.2 correction: a complete token bounded by the start of the text and a whitespace
    // character. Requirement 14.12 names both as boundaries, so this blocks, and Requirement 14.10
    // makes that the recoverable outcome.
    ['Undefined Holdings LLC', 'Undefined'],
  ])('blocks a customer name of %j on the token %j', (customerName, expectedMatch) => {
    const result = renderMessage(baselineInput({ customerName }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockedBy).toBe('forbidden_token');
    expect(result.match.toLowerCase()).toBe(expectedMatch.toLowerCase());
  });

  it('blocks a stored template body that itself carries a bare marker', () => {
    const result = renderMessage(baselineInput({ statementSuffix: 'Amount due: nan' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockedBy).toBe('forbidden_token');
    expect(result.match.toLowerCase()).toBe('nan');
    expect(result.field).toBe('body');
  });

  it('blocks the legacy signature-block shape the requirement was written from', () => {
    const result = renderMessage({
      ...baselineInput({}),
      templateVersions: TOUCHPOINTS.flatMap((touchpoint) =>
        (['English', 'Spanish'] as const).map((language): TemplateVersionRow => ({
          id: `tv-${touchpoint}-${language}`,
          version: 1,
          touchpoint,
          language,
          subject: '',
          body: `${t(TOKEN_NAMES.cancellationStatement)}\n${t(TOKEN_NAMES.contactRequest)}\nAtentamente,\nnan\n${t(TOKEN_NAMES.agencyName)} · ${t(TOKEN_NAMES.officePhone)}`,
          cancellation_statement: STATEMENTS[language],
          contact_request: CONTACT_REQUESTS[language],
          fallback_text: null,
        })),
      ),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockedBy).toBe('forbidden_token');
    expect(result.match.toLowerCase()).toBe('nan');
  });
});

// ---------------------------------------------------------------------------
// Guards on this file's own inputs
// ---------------------------------------------------------------------------

describe('the generator pools stay honest', () => {
  it('keeps the forbidden-token list and the absent-marker list identical', () => {
    // The two halves of Requirement 14.12 — the value rule in the renderer and the assembled-text
    // rule in the gate — have to name the same sequences.
    expect([...FORBIDDEN_TOKENS]).toEqual([...ABSENT_MARKER_TOKENS]);
  });

  it('draws every whole-marker value from the absent-marker list', () => {
    for (const marker of WHOLE_MARKERS) {
      expect(ABSENT_MARKER_TOKENS as readonly string[]).toContain(marker.trim().toLowerCase());
    }
  });

  it('keeps every embedded value clear of the boundary rule', () => {
    for (const name of EMBEDDED_NAMES) {
      expect(forbiddenTokenMatch(name), `${name} should be compliant`).toBeNull();
    }
  });

  it('keeps every bare-token value matched by the boundary rule', () => {
    for (const value of BARE_TOKEN_VALUES) {
      expect(forbiddenTokenMatch(value), `${value} should block`).not.toBeNull();
    }
  });

  it('keeps the phrase list disjoint from every text pool', () => {
    // If a pool string ever starts matching a prohibited phrase, the property would begin passing by
    // blocking on phrases instead of exercising the token rule, and the density guard above would be
    // the only thing left to notice.
    const pools: readonly string[] = [
      ...CLEAN_NAMES,
      ...EMBEDDED_NAMES,
      ...WHOLE_MARKERS,
      ...BARE_TOKEN_VALUES,
      ...CLEAN_PROSE,
      ...AGENCY_NAMES.map((entry) => entry.text),
      ...Object.values(STATEMENTS),
      ...Object.values(CONTACT_REQUESTS),
      ...Object.values(BODY_LABELS).flatMap((labels) => Object.values(labels)),
      ...(['English', 'Spanish'] as const).flatMap((language) => [
        storedBody(language, { optionalLines: true, dateLine: true, policyList: true, countLine: true }),
        storedSubject(language, 'tokens'),
        storedSubject(language, 'plain'),
      ]),
    ];

    for (const text of pools) {
      expect(prohibitedPhraseMatch(text, PROHIBITED_PHRASES), `pool string matched a phrase: ${text}`).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The real-data anchor
// ---------------------------------------------------------------------------

/**
 * The legacy `avisos` bodies, reconstructed. Fifteen carry a bare `nan` where the producer name was
 * absent; the sixteenth carries the letters inside the surname `Hernandez`. A substring scan sees
 * sixteen, the Requirement 14.12 boundary rule sees fifteen, and that one row of difference is a
 * compliant message that a substring scan would have held for manual follow-up.
 */
const LEGACY_SIGNATURE_BODY = [
  'Su póliza BWG69416489 de Liberty Mutual será cancelada el 08/02/2026, en 2 días, por falta de pago.',
  '',
  'Aún está a tiempo: realice su pago hoy o llámenos de inmediato al 704-824-3130.',
  '',
  'Atentamente,',
  'nan',
  'New Hope Insurance Agency · 704-824-3130',
].join('\n');

const LEGACY_SURNAME_BODY = LEGACY_SIGNATURE_BODY.replace('\nnan\n', '\nJorge Hernandez,\n');

describe('the boundary rule reproduces the observed avisos counts', () => {
  it('separates the fifteen leaked tokens from the sixteenth surname', () => {
    const bodies = [...Array.from({ length: 15 }, () => LEGACY_SIGNATURE_BODY), LEGACY_SURNAME_BODY];

    const substringHits = bodies.filter((body) => body.toLowerCase().includes('nan')).length;
    const tokenHits = bodies.filter((body) => forbiddenTokenMatch(body) !== null).length;

    expect(substringHits).toBe(16);
    expect(tokenHits).toBe(15);
    expect(forbiddenTokenMatch(LEGACY_SIGNATURE_BODY)?.match).toBe('nan');
    expect(forbiddenTokenMatch(LEGACY_SURNAME_BODY)).toBeNull();
  });
});

const FIXTURE_DIR = process.env.CANCELLATION_CSV_FIXTURE_DIR ?? path.join(homedir(), 'Downloads');
const AVISOS = path.join(FIXTURE_DIR, 'avisos_20260731_1535.csv');

// The report the requirement was written from carries live customer contact data, so it is not
// committed. It is asserted when reachable; set CANCELLATION_CSV_FIXTURE_DIR to point at it.
describe.skipIf(!existsSync(AVISOS))('the same counts hold against the real avisos report', () => {
  it('finds fifteen bare tokens and sixteen substring hits in MensajeEmail', () => {
    const parsed = parseCsv(readFileSync(AVISOS, 'utf-8'));
    const emailColumn = parsed.header.indexOf('MensajeEmail');
    const smsColumn = parsed.header.indexOf('MensajeSMS');
    expect(emailColumn).toBeGreaterThanOrEqual(0);

    const bodies = parsed.rows.map((row) => row[emailColumn]);
    expect(bodies.length).toBe(51);

    const substringHits = bodies.filter((body) => body.toLowerCase().includes('nan'));
    const tokenHits = bodies.filter((body) => forbiddenTokenMatch(body) !== null);
    expect(substringHits.length).toBe(16);
    expect(tokenHits.length).toBe(15);

    // The one row of difference: the letters sit inside the surname `Hernandez`.
    const substringOnly = substringHits.filter((body) => forbiddenTokenMatch(body) === null);
    expect(substringOnly.length).toBe(1);
    expect(substringOnly[0]).toMatch(/Hernandez/);

    // The SMS bodies carry the letters twice and a bare token never.
    const smsBodies = parsed.rows.map((row) => row[smsColumn]);
    expect(smsBodies.filter((body) => body.toLowerCase().includes('nan')).length).toBe(2);
    expect(smsBodies.filter((body) => forbiddenTokenMatch(body) !== null).length).toBe(0);
  });
});

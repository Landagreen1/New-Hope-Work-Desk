// The rendered SMS must fit what RingCentral accepts, and must carry the sender and the opt-out.
//
// RingCentral rejects the SMS `text` parameter above 1000 UTF-16 characters with "Parameter [text]
// value is invalid", and it rejects the whole request rather than truncating. Before v1.13.8 the
// cancellation templates were one set of rows shared by both channels, so an SMS was rendered from
// ~400 characters of email prose per language and a Bilingual body measured 1076-1157 characters.
// Every bilingual cancellation text failed, which per Requirement 11.2 means every contact whose
// `preferred_language` was absent, blank, whitespace-only, or unrecognized, plus every case whose
// included contacts disagreed.
//
// Nothing caught it. `MAX_COMBINED_SMS_BODY_LENGTH` bounds only a *combined* SMS, at the 640
// characters Requirement 13.3 names, and no test rendered a single-case SMS and measured it. This
// file is that test.
//
// It renders through the real `renderMessage`, so it measures the assembled body — token
// substitution, the per-segment required elements, the separator, and the appended signature — and
// not the stored template text. A stored-length check would pass while the assembled message
// overflowed.
//
// The template text below is asserted to be the text the migrations actually seeded, by matching
// the migration files, so this cannot pass against wording the database does not have. v1.13.8
// owns the schema and the first wording; v1.13.9 owns the live version-2 wording, which puts the
// agency name first and adds the opt-out line.

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { OPT_OUT_KEYWORDS } from '../domain/suppression';
import {
  MAX_COMBINED_SMS_BODY_LENGTH,
  renderMessage,
  type RenderChannel,
  type TemplateLanguage,
  type TemplateVersionRow,
  type Touchpoint,
} from '../render/renderMessage';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
/** v1.13.8: the channel column, and the first SMS wording. */
const SCHEMA_MIGRATION = path.join(MIGRATIONS, 'v1.13.8-cancellation-sms-templates.sql');
/** v1.13.9: the live version-2 wording. */
const WORDING_MIGRATION = path.join(MIGRATIONS, 'v1.13.9-cancellation-sms-optout-and-sender-first.sql');

/** RingCentral's hard ceiling on `text`, in UTF-16 characters. Above it the request is refused. */
const RINGCENTRAL_TEXT_LIMIT = 1000;

// ---------------------------------------------------------------------------
// The seeded SMS wording (v1.13.9, version 2)
// ---------------------------------------------------------------------------

const STATEMENT: Record<TemplateLanguage, string> = {
  English: 'Your {{Carrier}} policy {{Policy_Number}} is scheduled to cancel on {{Cancellation_Date}}.',
  Spanish: 'Su póliza {{Policy_Number}} de {{Carrier}} está programada para cancelarse el {{Cancellation_Date}}.',
};

const CONTACT_REQUEST: Record<TemplateLanguage, string> = {
  English: 'Call {{Office_Phone}} by {{Contact_Deadline}} to review your options.',
  Spanish: 'Llame al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.',
};

/**
 * The opt-out sentence, per language.
 *
 * Both name the literal `STOP`, which is asserted below to be a member of `OPT_OUT_KEYWORDS`.
 * That list carries no Spanish word, so a translated keyword would be an instruction the inbound
 * handler does not recognize — worse than none, because the customer believes they opted out.
 */
const OPT_OUT: Record<TemplateLanguage, string> = {
  English: 'Reply STOP to opt out.',
  Spanish: 'Responda STOP para no recibir más mensajes.',
};

/** The keyword both sentences instruct the customer to send. */
const OPT_OUT_KEYWORD = 'STOP';

const LEAD: Record<TemplateLanguage, Record<Touchpoint, string>> = {
  English: { 15: 'Courtesy reminder', 10: 'Reminder', 5: 'Important', 1: 'Final reminder' },
  Spanish: {
    15: 'Recordatorio de cortesía',
    10: 'Recordatorio',
    5: 'Importante',
    1: 'Último recordatorio',
  },
};

const AMOUNT_LABEL: Record<TemplateLanguage, string> = {
  English: 'Amount due',
  Spanish: 'Monto pendiente',
};

function smsBody(language: TemplateLanguage, touchpoint: Touchpoint): string {
  return [
    '{{Agency_Name}}',
    '{{Contact_Name}}',
    `${LEAD[language][touchpoint]}: {{Cancellation_Statement}}`,
    `${AMOUNT_LABEL[language]}: {{Amount_Due}}`,
    '{{Contact_Request}}',
    OPT_OUT[language],
  ].join('\n');
}

function smsVersion(language: TemplateLanguage, touchpoint: Touchpoint): TemplateVersionRow {
  return {
    id: `sms-${touchpoint}-${language}`,
    template_id: `sms-${touchpoint}`,
    version: 2,
    touchpoint,
    channel: 'sms',
    language,
    subject: '',
    body: smsBody(language, touchpoint),
    cancellation_statement: STATEMENT[language],
    contact_request: CONTACT_REQUEST[language],
    fallback_text: null,
  };
}

/** The email rows, long on purpose, used to prove the renderer will not reach for them on SMS. */
function emailVersion(language: TemplateLanguage, touchpoint: Touchpoint): TemplateVersionRow {
  return {
    ...smsVersion(language, touchpoint),
    id: `email-${touchpoint}-${language}`,
    template_id: `email-${touchpoint}`,
    channel: 'email',
    body: `${'Filler prose that stands in for the 400-character email body. '.repeat(7)}`
      + '{{Cancellation_Statement}} {{Contact_Request}}',
  };
}

const TOUCHPOINTS: readonly Touchpoint[] = [15, 10, 5, 1];
const LANGUAGES: readonly TemplateLanguage[] = ['English', 'Spanish'];

/**
 * The live `cancellation_settings` values. The agency name and the office phone land in every
 * rendered body, so the measurement below is only as good as these; a longer agency name shortens
 * the remaining budget. Keep them in step with the settings row.
 */
const SETTINGS = {
  office_phone: '(704) 824-3130',
  agency_name: 'New Hope Insurance Agency',
  bilingual_separator: '\n---\n',
};

/** An assigned employee, whose display name is appended as the closing signature (Req 14.13). */
const ASSIGNED_EMPLOYEE = { display_name: 'Maria Gomez', is_active: true };

function caseRow(amountDue: number | null) {
  return {
    id: 'case-1',
    policy_number: 'ZZTEST-C-003',
    cancellation_effective_date: '2026-08-19',
    customer_name: 'Maria Garcia',
    carrier: 'United Auto',
    amount_due: amountDue,
  };
}

function render(options: {
  touchpoint: Touchpoint;
  language: string | null;
  amountDue: number | null;
  contactName: string | null;
  channel?: RenderChannel;
  senderName?: typeof ASSIGNED_EMPLOYEE | null;
  templateVersions?: readonly TemplateVersionRow[];
}) {
  return renderMessage({
    templateVersions:
      options.templateVersions
      ?? LANGUAGES.map((language) => smsVersion(language, options.touchpoint)),
    cases: [caseRow(options.amountDue)],
    contact: {
      id: 'contact-1',
      channel: 'phone',
      normalized_value: '+19158083304',
      preferred_language: options.language,
      contact_name: options.contactName,
    },
    touchpoint: options.touchpoint,
    channel: options.channel ?? 'sms',
    settings: SETTINGS,
    senderName: options.senderName ?? null,
    combined: false,
    prohibitedPhrases: [],
  });
}

// ---------------------------------------------------------------------------
// The wording is the wording the migrations seeded
// ---------------------------------------------------------------------------

describe('the SMS template text matches the migrations', () => {
  const schemaSql = fs.readFileSync(SCHEMA_MIGRATION, 'utf8');
  const wordingSql = fs.readFileSync(WORDING_MIGRATION, 'utf8');

  it('gives the SMS channel its own templates and leaves the email templates alone', () => {
    expect(schemaSql).toContain("check (channel in ('email', 'sms'))");
    expect(schemaSql).toContain('unique (touchpoint, channel)');
  });

  it('seeds every statement and contact request this test measures', () => {
    for (const language of LANGUAGES) {
      expect(wordingSql, `${language} statement`).toContain(STATEMENT[language]);
      expect(wordingSql, `${language} contact request`).toContain(CONTACT_REQUEST[language]);
    }
  });

  it('seeds every version-2 body this test measures', () => {
    for (const language of LANGUAGES) {
      for (const touchpoint of TOUCHPOINTS) {
        // The migration writes bodies as E'...' with escaped newlines.
        const escaped = smsBody(language, touchpoint).split('\n').join('\\n');
        expect(wordingSql, `${language} ${touchpoint}-day body`).toContain(escaped);
      }
    }
  });

  it('inserts a new version rather than rewriting the stored one', () => {
    // Requirement 14.17: a Communication_Record already sent must keep pointing at its own words.
    expect(wordingSql).toMatch(/insert into public\.cancellation_template_versions/);
    expect(wordingSql).not.toMatch(/update\s+public\.cancellation_template_versions/i);
  });
});

// ---------------------------------------------------------------------------
// The opt-out instruction has to be one the inbound handler acts on
// ---------------------------------------------------------------------------

describe('the opt-out instruction', () => {
  it('names a keyword the inbound handler recognizes', () => {
    expect(OPT_OUT_KEYWORDS as readonly string[]).toContain(OPT_OUT_KEYWORD);
  });

  it('tells the customer that keyword in both languages, untranslated', () => {
    // OPT_OUT_KEYWORDS carries no Spanish word, so the Spanish sentence must still say STOP.
    for (const language of LANGUAGES) {
      expect(OPT_OUT[language], language).toContain(OPT_OUT_KEYWORD);
    }
  });

  it('reaches a Spanish-only recipient, not just a bilingual one', () => {
    for (const language of ['Spanish', 'English', null] as const) {
      const result = render({ touchpoint: 15, language, amountDue: 275.4, contactName: 'Maria Garcia' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body, `${language ?? 'absent'} language`).toContain(OPT_OUT_KEYWORD);
    }
  });

  it('gives each language segment of a bilingual body its own sentence', () => {
    const result = render({ touchpoint: 15, language: null, amountDue: 275.4, contactName: 'Maria Garcia' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain(OPT_OUT.English);
    expect(result.body).toContain(OPT_OUT.Spanish);
  });
});

// ---------------------------------------------------------------------------
// The agency name leads the message
// ---------------------------------------------------------------------------

describe('sender identification', () => {
  for (const language of [null, 'English', 'Spanish'] as const) {
    it(`opens with the agency name for ${language ?? 'an absent language'}`, () => {
      const result = render({ touchpoint: 15, language, amountDue: 275.4, contactName: 'Maria Garcia' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.startsWith(SETTINGS.agency_name)).toBe(true);
    });
  }

  it('heads each segment of a bilingual body, so neither half is anonymous', () => {
    const result = render({ touchpoint: 15, language: null, amountDue: 275.4, contactName: 'Maria Garcia' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.split(SETTINGS.agency_name).length - 1).toBe(2);
  });

  it('still closes with the assigned employee, so it opens agency and closes agent', () => {
    const result = render({
      touchpoint: 15,
      language: null,
      amountDue: 275.4,
      contactName: 'Maria Garcia',
      senderName: ASSIGNED_EMPLOYEE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.startsWith(SETTINGS.agency_name)).toBe(true);
    expect(result.body.trimEnd().endsWith(ASSIGNED_EMPLOYEE.display_name)).toBe(true);
  });

  it('does not append a second agency name now that the body carries one', () => {
    const result = render({ touchpoint: 15, language: 'English', amountDue: 275.4, contactName: 'Maria Garcia' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.split(SETTINGS.agency_name).length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

describe('a single-case cancellation SMS fits the provider limit', () => {
  const scenarios = [
    { amountDue: 275.4, contactName: 'Maria Garcia' },
    { amountDue: null, contactName: 'Maria Garcia' },
    { amountDue: 275.4, contactName: null },
    { amountDue: null, contactName: null },
  ] as const;

  for (const language of [null, 'Bilingual', 'English', 'Spanish', 'not a language'] as const) {
    for (const touchpoint of TOUCHPOINTS) {
      it(`stays inside both budgets for ${language ?? 'an absent language'} at ${touchpoint} days`, () => {
        for (const scenario of scenarios) {
          for (const senderName of [null, ASSIGNED_EMPLOYEE]) {
            const result = render({ touchpoint, language, senderName, ...scenario });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const detail =
              `${language ?? 'absent'} / ${touchpoint}d / amount ${scenario.amountDue ?? 'absent'}`
              + ` / name ${scenario.contactName ?? 'absent'} / sender ${senderName ? 'assigned' : 'none'}`;
            expect(result.body.length, `${detail} vs RingCentral`).toBeLessThanOrEqual(RINGCENTRAL_TEXT_LIMIT);
            expect(result.body.length, `${detail} vs Req 13.3`).toBeLessThanOrEqual(MAX_COMBINED_SMS_BODY_LENGTH);
          }
        }
      });
    }
  }

  it('renders the required elements in both segments of a bilingual body', () => {
    const result = render({ touchpoint: 15, language: null, amountDue: 275.4, contactName: 'Maria Garcia' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Statement, effective date, and contact request, once per language (Req 11.7, 14.2, 14.3, 14.5).
    expect(result.body).toContain('is scheduled to cancel on August 19, 2026');
    expect(result.body).toContain('programada para cancelarse el 19 de agosto de 2026');
    expect(result.body).toContain('Call (704) 824-3130 by August 19, 2026');
    expect(result.body).toContain('Llame al (704) 824-3130 antes del 19 de agosto de 2026');
  });

  it('drops the greeting line rather than leaving a dangling name line', () => {
    const result = render({ touchpoint: 15, language: 'English', amountDue: 275.4, contactName: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe(
      `${SETTINGS.agency_name}\n`
      + 'Courtesy reminder: Your United Auto policy ZZTEST-C-003 is scheduled to cancel on August 19, 2026.\n'
      + 'Amount due: $275.40\n'
      + 'Call (704) 824-3130 by August 19, 2026 to review your options.\n'
      + 'Reply STOP to opt out.',
    );
  });

  it('drops the amount line when the case carries no amount', () => {
    const result = render({ touchpoint: 15, language: 'English', amountDue: null, contactName: 'Maria Garcia' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).not.toContain('Amount due');
  });
});

// ---------------------------------------------------------------------------
// The channel rule
// ---------------------------------------------------------------------------

describe('selection never substitutes the other channel', () => {
  const bothChannels = TOUCHPOINTS.flatMap((touchpoint) =>
    LANGUAGES.flatMap((language) => [smsVersion(language, touchpoint), emailVersion(language, touchpoint)]),
  );

  it('picks the SMS rows when both channels are supplied', () => {
    const result = render({
      touchpoint: 15,
      language: null,
      amountDue: 275.4,
      contactName: 'Maria Garcia',
      templateVersions: bothChannels,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).not.toContain('Filler prose');
    expect(result.body.length).toBeLessThanOrEqual(MAX_COMBINED_SMS_BODY_LENGTH);
  });

  it('picks the email rows for an email send', () => {
    const result = render({
      touchpoint: 15,
      language: 'English',
      amountDue: 275.4,
      contactName: 'Maria Garcia',
      channel: 'email',
      templateVersions: bothChannels,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain('Filler prose');
  });

  it('throws rather than sending an email body as a text', () => {
    const emailOnly = LANGUAGES.map((language) => emailVersion(language, 15));
    expect(() =>
      render({
        touchpoint: 15,
        language: null,
        amountDue: 275.4,
        contactName: 'Maria Garcia',
        templateVersions: emailOnly,
      }),
    ).toThrow(/no sms template version row/i);
  });

  it('ignores the channel where no supplied row carries one', () => {
    // Every fixture predating v1.13.8 looks like this, and must keep working.
    const channelless = LANGUAGES.map((language) => {
      const row = { ...smsVersion(language, 15) };
      delete row.channel;
      return row;
    });
    const result = render({
      touchpoint: 15,
      language: 'English',
      amountDue: 275.4,
      contactName: 'Maria Garcia',
      templateVersions: channelless,
    });
    expect(result.ok).toBe(true);
  });
});

// The rendered SMS must fit what RingCentral accepts.
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
// The template text below is asserted to be the text v1.13.8 actually seeded, by matching the
// migration file, so this cannot pass against wording the database does not have.

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_COMBINED_SMS_BODY_LENGTH,
  renderMessage,
  type RenderChannel,
  type TemplateLanguage,
  type TemplateVersionRow,
  type Touchpoint,
} from '../render/renderMessage';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', 'v1.13.8-cancellation-sms-templates.sql');

/** RingCentral's hard ceiling on `text`, in UTF-16 characters. Above it the request is refused. */
const RINGCENTRAL_TEXT_LIMIT = 1000;

// ---------------------------------------------------------------------------
// The seeded SMS wording (v1.13.8)
// ---------------------------------------------------------------------------

const STATEMENT: Record<TemplateLanguage, string> = {
  English: 'Your {{Carrier}} policy {{Policy_Number}} is scheduled to cancel on {{Cancellation_Date}}.',
  Spanish: 'Su póliza {{Policy_Number}} de {{Carrier}} está programada para cancelarse el {{Cancellation_Date}}.',
};

const CONTACT_REQUEST: Record<TemplateLanguage, string> = {
  English: 'Call {{Office_Phone}} by {{Contact_Deadline}} to review your options.',
  Spanish: 'Llame al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.',
};

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
    '{{Contact_Name}}',
    `${LEAD[language][touchpoint]}: {{Cancellation_Statement}}`,
    `${AMOUNT_LABEL[language]}: {{Amount_Due}}`,
    '{{Contact_Request}}',
  ].join('\n');
}

function smsVersion(language: TemplateLanguage, touchpoint: Touchpoint): TemplateVersionRow {
  return {
    id: `sms-${touchpoint}-${language}`,
    template_id: `sms-${touchpoint}`,
    version: 1,
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
 * the remaining budget. They are asserted against the live row by
 * `sms-length.integration.test.ts`-style checks nowhere, so keep them in step with the settings row.
 */
const SETTINGS = {
  office_phone: '(704) 824-3130',
  agency_name: 'New Hope Insurance Agency',
  bilingual_separator: '\n---\n',
};

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
    senderName: null,
    combined: false,
    prohibitedPhrases: [],
  });
}

// ---------------------------------------------------------------------------
// The wording is the wording the migration seeded
// ---------------------------------------------------------------------------

describe('the SMS template text matches v1.13.8', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');

  it('seeds every statement and contact request this test measures', () => {
    for (const language of LANGUAGES) {
      expect(sql, `${language} statement`).toContain(STATEMENT[language]);
      expect(sql, `${language} contact request`).toContain(CONTACT_REQUEST[language]);
    }
  });

  it('seeds every body this test measures', () => {
    for (const language of LANGUAGES) {
      for (const touchpoint of TOUCHPOINTS) {
        // The migration writes bodies as E'...' with escaped newlines.
        const escaped = smsBody(language, touchpoint).split('\n').join('\\n');
        expect(sql, `${language} ${touchpoint}-day body`).toContain(escaped);
      }
    }
  });

  it('gives the SMS channel its own templates and leaves the email templates alone', () => {
    expect(sql).toContain("check (channel in ('email', 'sms'))");
    expect(sql).toContain('unique (touchpoint, channel)');
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
          const result = render({ touchpoint, language, ...scenario });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const detail =
            `${language ?? 'absent'} / ${touchpoint}d / amount ${scenario.amountDue ?? 'absent'}`
            + ` / name ${scenario.contactName ?? 'absent'}`;
          expect(result.body.length, `${detail} vs RingCentral`).toBeLessThanOrEqual(RINGCENTRAL_TEXT_LIMIT);
          expect(result.body.length, `${detail} vs Req 13.3`).toBeLessThanOrEqual(MAX_COMBINED_SMS_BODY_LENGTH);
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
    // Agency name once per body (Req 14.1), not once per segment.
    expect(result.body.split(SETTINGS.agency_name).length - 1).toBe(1);
  });

  it('drops the greeting line rather than opening with a bare comma', () => {
    const result = render({ touchpoint: 15, language: 'English', amountDue: 275.4, contactName: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.startsWith(',')).toBe(false);
    expect(result.body.startsWith('Courtesy reminder:')).toBe(true);
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

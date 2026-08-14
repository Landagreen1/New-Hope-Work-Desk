-- New Hope Work Desk v1.13.8 — Channel-specific cancellation templates, and short SMS wording
--
-- Fixes: RingCentral rejecting every bilingual cancellation SMS with
--        "Parameter [text] value is invalid."
--
-- Forward-only. Does not modify historical migrations. Adds one column, swaps one unique
-- constraint, and inserts new rows. Changes no existing row's text: the four templates seeded by
-- v1.10.9 keep every character they have and become the email templates.
--
-- ── WHAT WAS WRONG
--
-- RingCentral caps the SMS `text` parameter at 1000 UTF-16 characters and rejects the request
-- outright above it. Rendered against the v1.10.9 templates, a single-case cancellation SMS
-- measured:
--
--     English    502 - 538 characters    sent
--     Spanish    569 - 614 characters    sent
--     Bilingual  1076 - 1157 characters  rejected, every touchpoint
--
-- A Bilingual body is the English segment, one separator, and the Spanish segment, and each
-- language's stored body is ~400 characters of labelled prose, so the pair always cleared the
-- ceiling.
--
-- The reach of that is wider than it first looks. Requirement 11.2 resolves Bilingual as the
-- *default*: a contact whose `preferred_language` is absent, empty, whitespace-only, or
-- unrecognized renders Bilingual, and so does a case whose included contacts disagree. Any
-- customer whose language was never captured could not be sent a cancellation text at all.
--
-- Two things let it through. `MAX_COMBINED_SMS_BODY_LENGTH` in `render/renderMessage.ts` caps only
-- a *combined* SMS, at the 640 characters Requirement 13.3 names; a single-case SMS has no cap
-- anywhere. And `cancellation_templates` carried no channel, so one set of rows served both
-- channels — ~400 characters of prose is reasonable in an email and far too long in a bilingual
-- text.
--
-- ── WHY A CHANNEL COLUMN RATHER THAN SHORTER SHARED TEXT
--
-- Shortening the existing rows would shorten the emails too. Email has no length pressure and no
-- defect, so that would be a regression bought for nothing. Splitting by channel lets the SMS rows
-- be as short as the provider requires while the email rows keep the fuller wording, which is also
-- what the manager-facing template editor already shows per touchpoint.
--
-- The new SMS wording carries every element Requirement 14 requires in each segment — the
-- cancellation statement, the effective date, and the contact request — plus Agency_Name,
-- Office_Phone, and the sender name once per body, the last three appended by `assembleBody` where
-- the text does not already render them. It drops only what Requirement 14 does not require:
-- `Cancellation_Reason`, `Producer_Name`, and the labelled Policy/Carrier lines, which are folded
-- into the statement sentence. Email keeps all of them.
--
-- Each optional value sits on its own line, because `substituteBody` drops a line whose every token
-- rendered zero characters. That is deliberate and load-bearing: with the name on the greeting line
-- a contact with no stored name renders a bare leading comma, and 11 of the 58 real eficacia rows
-- carry an empty `MontoDebido`.
--
-- Measured with the live settings, the new rows render a Bilingual SMS at 412-465 characters across
-- every touchpoint and every present/absent combination of name and amount — inside the 1000
-- provider ceiling and inside the 640 Requirement 13.3 budget.
--
-- ── NOT INCLUDED, ON PURPOSE
--
-- No opt-out sentence. The cancellation texts carry none today and this migration does not add one,
-- so it changes no compliance posture in either direction. It was raised for a decision and is a
-- one-line change to the English body when that decision is made.
--
-- ── ROLLBACK
--   begin;
--     delete from public.cancellation_template_versions
--      where template_id in (select id from public.cancellation_templates where channel = 'sms');
--     delete from public.cancellation_templates where channel = 'sms';
--     alter table public.cancellation_templates
--       drop constraint if exists cancellation_templates_touchpoint_channel_key;
--     alter table public.cancellation_templates
--       add constraint cancellation_templates_touchpoint_key unique (touchpoint);
--     alter table public.cancellation_templates drop column if exists channel;
--   commit;
--   -- Safe only while no cancellation_communications row references an SMS template version.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. The channel column. Existing rows become the email templates.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cancellation_templates
  add column if not exists channel text;

update public.cancellation_templates set channel = 'email' where channel is null;

alter table public.cancellation_templates
  alter column channel set not null;

alter table public.cancellation_templates
  alter column channel set default 'email';

alter table public.cancellation_templates
  drop constraint if exists cancellation_templates_channel_values;
alter table public.cancellation_templates
  add constraint cancellation_templates_channel_values
  check (channel in ('email', 'sms'));

comment on column public.cancellation_templates.channel is
  'Which delivery channel this template is written for, v1.13.8. An SMS body must stay short enough that a Bilingual render fits the RingCentral 1000-character text limit; an email body has no such bound. selectTemplateVersion in src/features/cancellations/render/renderMessage.ts picks by this column and raises rather than falling back across channels.';

-- One template per touchpoint *per channel* now, so the touchpoint-only unique key has to go.
alter table public.cancellation_templates
  drop constraint if exists cancellation_templates_touchpoint_key;
alter table public.cancellation_templates
  drop constraint if exists cancellation_templates_touchpoint_channel_key;
alter table public.cancellation_templates
  add constraint cancellation_templates_touchpoint_channel_key unique (touchpoint, channel);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. The four SMS templates and their eight version rows
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.cancellation_templates (touchpoint, channel, name)
values
  (15, 'sms', 'Cancellation reminder SMS - 15 days'),
  (10, 'sms', 'Cancellation reminder SMS - 10 days'),
  ( 5, 'sms', 'Cancellation reminder SMS - 5 days'),
  ( 1, 'sms', 'Cancellation reminder SMS - final day')
on conflict (touchpoint, channel) do nothing;

-- `subject` is stored as zero characters: Requirement 14.15 renders no subject on the SMS channel.
-- `fallback_text` stays the `'{}'` default, so an absent token renders zero characters and its whole
-- line drops, which is what keeps the name and amount lines optional.
insert into public.cancellation_template_versions (
  template_id, version, language, subject, body, cancellation_statement, contact_request)
select
  t.id,
  1,
  w.language,
  '',
  w.body,
  w.statement,
  w.contact_request
from (values
  -- ── English
  (15, 'English',
   E'{{Contact_Name}}\nCourtesy reminder: {{Cancellation_Statement}}\nAmount due: {{Amount_Due}}\n{{Contact_Request}}',
   'Your {{Carrier}} policy {{Policy_Number}} is scheduled to cancel on {{Cancellation_Date}}.',
   'Call {{Office_Phone}} by {{Contact_Deadline}} to review your options.'),
  (10, 'English',
   E'{{Contact_Name}}\nReminder: {{Cancellation_Statement}}\nAmount due: {{Amount_Due}}\n{{Contact_Request}}',
   'Your {{Carrier}} policy {{Policy_Number}} is scheduled to cancel on {{Cancellation_Date}}.',
   'Call {{Office_Phone}} by {{Contact_Deadline}} to review your options.'),
  ( 5, 'English',
   E'{{Contact_Name}}\nImportant: {{Cancellation_Statement}}\nAmount due: {{Amount_Due}}\n{{Contact_Request}}',
   'Your {{Carrier}} policy {{Policy_Number}} is scheduled to cancel on {{Cancellation_Date}}.',
   'Call {{Office_Phone}} by {{Contact_Deadline}} to review your options.'),
  ( 1, 'English',
   E'{{Contact_Name}}\nFinal reminder: {{Cancellation_Statement}}\nAmount due: {{Amount_Due}}\n{{Contact_Request}}',
   'Your {{Carrier}} policy {{Policy_Number}} is scheduled to cancel on {{Cancellation_Date}}.',
   'Call {{Office_Phone}} by {{Contact_Deadline}} to review your options.'),
  -- ── Spanish
  (15, 'Spanish',
   E'{{Contact_Name}}\nRecordatorio de cortesía: {{Cancellation_Statement}}\nMonto pendiente: {{Amount_Due}}\n{{Contact_Request}}',
   'Su póliza {{Policy_Number}} de {{Carrier}} está programada para cancelarse el {{Cancellation_Date}}.',
   'Llame al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.'),
  (10, 'Spanish',
   E'{{Contact_Name}}\nRecordatorio: {{Cancellation_Statement}}\nMonto pendiente: {{Amount_Due}}\n{{Contact_Request}}',
   'Su póliza {{Policy_Number}} de {{Carrier}} está programada para cancelarse el {{Cancellation_Date}}.',
   'Llame al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.'),
  ( 5, 'Spanish',
   E'{{Contact_Name}}\nImportante: {{Cancellation_Statement}}\nMonto pendiente: {{Amount_Due}}\n{{Contact_Request}}',
   'Su póliza {{Policy_Number}} de {{Carrier}} está programada para cancelarse el {{Cancellation_Date}}.',
   'Llame al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.'),
  ( 1, 'Spanish',
   E'{{Contact_Name}}\nÚltimo recordatorio: {{Cancellation_Statement}}\nMonto pendiente: {{Amount_Due}}\n{{Contact_Request}}',
   'Su póliza {{Policy_Number}} de {{Carrier}} está programada para cancelarse el {{Cancellation_Date}}.',
   'Llame al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.')
) as w(touchpoint, language, body, statement, contact_request)
join public.cancellation_templates t
  on t.touchpoint = w.touchpoint and t.channel = 'sms'
on conflict on constraint cancellation_template_versions_key do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Post-conditions
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_email_templates  integer;
  v_sms_templates    integer;
  v_sms_versions     integer;
  v_email_body_bytes integer;
  v_longest_sms      integer;
  v_row              record;
begin
  select count(*) into v_email_templates
    from public.cancellation_templates where channel = 'email';
  select count(*) into v_sms_templates
    from public.cancellation_templates where channel = 'sms';
  if v_email_templates <> 4 or v_sms_templates <> 4 then
    raise exception 'v1.13.8 expected 4 email and 4 sms templates, found % and %',
                    v_email_templates, v_sms_templates
      using hint = 'Rolling back.';
  end if;

  select count(*) into v_sms_versions
    from public.cancellation_template_versions v
    join public.cancellation_templates t on t.id = v.template_id
   where t.channel = 'sms';
  if v_sms_versions <> 8 then
    raise exception 'v1.13.8 expected 8 sms template version rows, found %', v_sms_versions
      using detail = 'Requirement 11.6 needs an English row and a Spanish row per touchpoint.',
            hint   = 'Rolling back.';
  end if;

  -- Every touchpoint must have both languages, or a Bilingual render throws at send time.
  for v_row in
    select t.touchpoint, count(*) filter (where v.language = 'English') as en,
                         count(*) filter (where v.language = 'Spanish') as es
      from public.cancellation_templates t
      join public.cancellation_template_versions v on v.template_id = t.id
     where t.channel = 'sms'
     group by t.touchpoint
  loop
    if v_row.en < 1 or v_row.es < 1 then
      raise exception 'v1.13.8 left the %-day sms template with % English and % Spanish rows',
                      v_row.touchpoint, v_row.en, v_row.es
        using hint = 'Rolling back.';
    end if;
  end loop;

  -- The email wording must be untouched. v1.10.9 seeded bodies of 373-430 characters; a shortened
  -- email row here would mean the update above hit the wrong rows.
  select min(length(v.body)) into v_email_body_bytes
    from public.cancellation_template_versions v
    join public.cancellation_templates t on t.id = v.template_id
   where t.channel = 'email';
  if v_email_body_bytes < 300 then
    raise exception 'v1.13.8 changed an email template body: shortest is now % characters', v_email_body_bytes
      using detail = 'The email templates must keep the v1.10.9 wording.', hint = 'Rolling back.';
  end if;

  -- A crude ceiling on the stored SMS text. The real proof is the render measurement in
  -- src/features/cancellations/__tests__/sms-length.test.ts, which runs the actual renderer; this
  -- only catches an SMS row seeded with email-length prose by mistake.
  select max(length(v.body) + length(v.cancellation_statement) + length(v.contact_request))
    into v_longest_sms
    from public.cancellation_template_versions v
    join public.cancellation_templates t on t.id = v.template_id
   where t.channel = 'sms';
  if v_longest_sms > 320 then
    raise exception 'v1.13.8 seeded an sms template of % stored characters, which will not fit a Bilingual send', v_longest_sms
      using hint = 'Rolling back.';
  end if;

  raise notice 'v1.13.8: 4 email templates preserved, 4 sms templates seeded with 8 version rows.';
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Verification — run after commit.
-- ═══════════════════════════════════════════════════════════════════════════════

select t.channel, t.touchpoint, v.language, length(v.body) as body_len,
       length(v.cancellation_statement) as stmt_len, length(v.contact_request) as req_len
  from public.cancellation_templates t
  join public.cancellation_template_versions v on v.template_id = t.id
 order by t.channel, t.touchpoint desc, v.language;

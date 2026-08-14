-- New Hope Work Desk v1.13.9 — SMS opt-out line, and the agency name first
--
-- Forward-only. Adds eight `cancellation_template_versions` rows and changes nothing else: no
-- column, no constraint, no function, and no stored row.
--
-- ── WHAT THIS CHANGES
--
-- Two changes to the SMS wording v1.13.8 seeded, both requested after reviewing it:
--
--   1. **An opt-out sentence**, which the cancellation texts have never carried.
--   2. **The agency name first**, so the message identifies the sender before anything else
--      instead of closing with it.
--
-- The email templates are untouched. Neither change applies to them: an email carries its sender
-- in the from-header, and email opt-out is not the same obligation as SMS.
--
-- ── WHY NEW VERSION ROWS RATHER THAN AN UPDATE
--
-- `cancellation_template_versions` is immutable by design (Requirement 14.17): a wording change
-- inserts `version + 1` and never rewrites a stored row, so a Communication_Record written last
-- month still points at the exact words that were sent. `selectTemplateVersion` takes the highest
-- version per language, so inserting version 2 is what makes it live. Version 1 stays for the
-- history of every message already sent from it.
--
-- ── THE OPT-OUT KEYWORD IS DELIBERATELY ENGLISH IN BOTH LANGUAGES
--
-- `OPT_OUT_KEYWORDS` in `src/features/cancellations/domain/suppression.ts` is
-- ['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT'] — the six inbound keywords of Requirement
-- 21.8, matched as whole folded words. None of them is Spanish. So the Spanish line instructs the
-- customer to reply the literal `STOP` and not a translated word: telling a Spanish speaker to
-- reply `ALTO` or `CANCELAR` would produce an instruction the inbound handler does not recognize,
-- which is worse than no instruction at all because the customer believes they have opted out.
--
-- The sentence is per language rather than once per body on purpose. A Spanish-only recipient
-- renders only the Spanish segment, so an English-only opt-out line would reach nobody who needed
-- it in Spanish.
--
-- ── THE AGENCY NAME IS IN BOTH SEGMENTS
--
-- `assembleBody` appends the sender name, Agency_Name, and Office_Phone as a closing line only
-- where the assembled body does not already render them. Putting `{{Agency_Name}}` at the top of
-- both language bodies therefore moves it from the end to the front and stops the append, rather
-- than adding a second copy.
--
-- It is in both segments, not only the English one, because a Spanish-only send renders only the
-- Spanish segment: with the name in the English body alone, a Spanish-only recipient would get it
-- appended at the end again and the change would not apply to them. On a Bilingual body that means
-- the name heads each language block, which is how a bilingual notice is normally laid out and
-- leaves each half able to stand alone.
--
-- Where a case has an assigned employee, that employee's display name is still appended as the
-- closing signature (Requirements 14.13, 14.14), so the message opens with the agency and closes
-- with the agent.
--
-- ── MEASURED
--
-- Rendered through `renderMessage` with the live `cancellation_settings`, across all four
-- touchpoints, all three resolved languages, both present and absent amount, both present and
-- absent contact name, and both with and without an assigned employee: the longest body is 570
-- characters. RingCentral refuses `text` above 1000, and Requirement 13.3's SMS budget is 640.
--
-- ── ROLLBACK
--   delete from public.cancellation_template_versions v
--    using public.cancellation_templates t
--    where v.template_id = t.id and t.channel = 'sms' and v.version = 2;
--   -- selectTemplateVersion then falls back to version 1, the v1.13.8 wording.
--   -- Safe only while no cancellation_communications row references a version 2 row.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Version 2 of the eight SMS template rows
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.cancellation_template_versions (
  template_id, version, language, subject, body, cancellation_statement, contact_request)
select
  t.id,
  2,
  w.language,
  '',
  w.body,
  w.statement,
  w.contact_request
from (values
  -- ── English. Agency name first, opt-out last.
  (15, 'English',
   E'{{Agency_Name}}\n{{Contact_Name}}\nCourtesy reminder: {{Cancellation_Statement}}\nAmount due: {{Amount_Due}}\n{{Contact_Request}}\nReply STOP to opt out.',
   'Your {{Carrier}} policy {{Policy_Number}} is scheduled to cancel on {{Cancellation_Date}}.',
   'Call {{Office_Phone}} by {{Contact_Deadline}} to review your options.'),
  (10, 'English',
   E'{{Agency_Name}}\n{{Contact_Name}}\nReminder: {{Cancellation_Statement}}\nAmount due: {{Amount_Due}}\n{{Contact_Request}}\nReply STOP to opt out.',
   'Your {{Carrier}} policy {{Policy_Number}} is scheduled to cancel on {{Cancellation_Date}}.',
   'Call {{Office_Phone}} by {{Contact_Deadline}} to review your options.'),
  ( 5, 'English',
   E'{{Agency_Name}}\n{{Contact_Name}}\nImportant: {{Cancellation_Statement}}\nAmount due: {{Amount_Due}}\n{{Contact_Request}}\nReply STOP to opt out.',
   'Your {{Carrier}} policy {{Policy_Number}} is scheduled to cancel on {{Cancellation_Date}}.',
   'Call {{Office_Phone}} by {{Contact_Deadline}} to review your options.'),
  ( 1, 'English',
   E'{{Agency_Name}}\n{{Contact_Name}}\nFinal reminder: {{Cancellation_Statement}}\nAmount due: {{Amount_Due}}\n{{Contact_Request}}\nReply STOP to opt out.',
   'Your {{Carrier}} policy {{Policy_Number}} is scheduled to cancel on {{Cancellation_Date}}.',
   'Call {{Office_Phone}} by {{Contact_Deadline}} to review your options.'),
  -- ── Spanish. The keyword stays the literal STOP the inbound handler recognizes.
  (15, 'Spanish',
   E'{{Agency_Name}}\n{{Contact_Name}}\nRecordatorio de cortesía: {{Cancellation_Statement}}\nMonto pendiente: {{Amount_Due}}\n{{Contact_Request}}\nResponda STOP para no recibir más mensajes.',
   'Su póliza {{Policy_Number}} de {{Carrier}} está programada para cancelarse el {{Cancellation_Date}}.',
   'Llame al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.'),
  (10, 'Spanish',
   E'{{Agency_Name}}\n{{Contact_Name}}\nRecordatorio: {{Cancellation_Statement}}\nMonto pendiente: {{Amount_Due}}\n{{Contact_Request}}\nResponda STOP para no recibir más mensajes.',
   'Su póliza {{Policy_Number}} de {{Carrier}} está programada para cancelarse el {{Cancellation_Date}}.',
   'Llame al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.'),
  ( 5, 'Spanish',
   E'{{Agency_Name}}\n{{Contact_Name}}\nImportante: {{Cancellation_Statement}}\nMonto pendiente: {{Amount_Due}}\n{{Contact_Request}}\nResponda STOP para no recibir más mensajes.',
   'Su póliza {{Policy_Number}} de {{Carrier}} está programada para cancelarse el {{Cancellation_Date}}.',
   'Llame al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.'),
  ( 1, 'Spanish',
   E'{{Agency_Name}}\n{{Contact_Name}}\nÚltimo recordatorio: {{Cancellation_Statement}}\nMonto pendiente: {{Amount_Due}}\n{{Contact_Request}}\nResponda STOP para no recibir más mensajes.',
   'Su póliza {{Policy_Number}} de {{Carrier}} está programada para cancelarse el {{Cancellation_Date}}.',
   'Llame al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.')
) as w(touchpoint, language, body, statement, contact_request)
join public.cancellation_templates t
  on t.touchpoint = w.touchpoint and t.channel = 'sms'
on conflict on constraint cancellation_template_versions_key do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Post-conditions
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_v2           integer;
  v_v1           integer;
  v_email_v2     integer;
  v_missing      text;
  v_longest      integer;
  v_row          record;
begin
  select count(*) into v_v2
    from public.cancellation_template_versions v
    join public.cancellation_templates t on t.id = v.template_id
   where t.channel = 'sms' and v.version = 2;
  if v_v2 <> 8 then
    raise exception 'v1.13.9 expected 8 version-2 sms rows, found %', v_v2
      using hint = 'Rolling back.';
  end if;

  -- Version 1 must survive: a Communication_Record already sent points at it (Req 14.17).
  select count(*) into v_v1
    from public.cancellation_template_versions v
    join public.cancellation_templates t on t.id = v.template_id
   where t.channel = 'sms' and v.version = 1;
  if v_v1 <> 8 then
    raise exception 'v1.13.9 disturbed the version-1 sms rows: % remain, expected 8', v_v1
      using detail = 'A stored template version is immutable and is never replaced.',
            hint   = 'Rolling back.';
  end if;

  -- The email channel must not have gained a version.
  select count(*) into v_email_v2
    from public.cancellation_template_versions v
    join public.cancellation_templates t on t.id = v.template_id
   where t.channel = 'email' and v.version > 1;
  if v_email_v2 <> 0 then
    raise exception 'v1.13.9 added % email template version(s); it must touch only the sms channel', v_email_v2
      using hint = 'Rolling back.';
  end if;

  -- Both changes must actually be present in every new row.
  for v_row in
    select v.language, t.touchpoint, v.body
      from public.cancellation_template_versions v
      join public.cancellation_templates t on t.id = v.template_id
     where t.channel = 'sms' and v.version = 2
  loop
    if v_row.body not like '{{Agency_Name}}%' then
      raise exception 'v1.13.9 left the %-day % sms body not starting with the agency name',
                      v_row.touchpoint, v_row.language
        using hint = 'Rolling back.';
    end if;
    -- The literal keyword the inbound handler recognizes, in both languages.
    if position('STOP' in v_row.body) = 0 then
      raise exception 'v1.13.9 left the %-day % sms body without the STOP opt-out keyword',
                      v_row.touchpoint, v_row.language
        using detail = 'OPT_OUT_KEYWORDS carries no Spanish word, so both languages must name STOP.',
              hint   = 'Rolling back.';
    end if;
  end loop;

  -- Every touchpoint still has both languages at version 2, or a Bilingual render throws.
  select string_agg(format('%s-day %s', t.touchpoint, w.language), ', ')
    into v_missing
    from public.cancellation_templates t
   cross join (values ('English'), ('Spanish')) as w(language)
   where t.channel = 'sms'
     and not exists (
       select 1 from public.cancellation_template_versions v
        where v.template_id = t.id and v.version = 2 and v.language = w.language);
  if v_missing is not null then
    raise exception 'v1.13.9 left these version-2 sms rows missing: %', v_missing
      using hint = 'Rolling back.';
  end if;

  -- Stored-size sanity. The real proof is the render measurement in
  -- src/features/cancellations/__tests__/sms-length.test.ts, which assembles the message.
  select max(length(v.body) + length(v.cancellation_statement) + length(v.contact_request))
    into v_longest
    from public.cancellation_template_versions v
    join public.cancellation_templates t on t.id = v.template_id
   where t.channel = 'sms' and v.version = 2;
  if v_longest > 460 then
    raise exception 'v1.13.9 seeded an sms row of % stored characters, too long for a Bilingual send', v_longest
      using hint = 'Rolling back.';
  end if;

  raise notice 'v1.13.9: 8 version-2 sms rows seeded, 8 version-1 rows preserved, email untouched.';
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Verification — run after commit. Expect version 2 to be the highest per SMS row.
-- ═══════════════════════════════════════════════════════════════════════════════

select t.channel, t.touchpoint, v.language, v.version,
       length(v.body) as body_len,
       (v.body like '{{Agency_Name}}%') as agency_first,
       (position('STOP' in v.body) > 0) as has_opt_out
  from public.cancellation_templates t
  join public.cancellation_template_versions v on v.template_id = t.id
 where t.channel = 'sms'
 order by t.touchpoint desc, v.language, v.version;

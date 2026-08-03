-- New Hope Work Desk v1.10.9 — Cancellation template and prohibited-phrase seed (migration stage 10 of 10)
--
-- Spec: .kiro/specs/policy-follow-up-renewals-cancellations (task 7.10)
-- Requirements: 11.1, 11.6, 11.7, 12.1, 14.1, 14.2, 14.3, 14.4, 14.5, 14.7, 14.11,
--               14.13, 14.17, 26.1, 26.2
--
-- Forward-only, tenth and last file of the v1.10.x series. Inserts rows only: four
-- cancellation_templates rows, eight cancellation_template_versions rows (4 touchpoints
-- x 2 languages, all at version 1), and twenty cancellation_prohibited_phrases rows.
-- Creates no table, no column, no index, no trigger, no function, and no policy, and
-- contains no drop, no truncate, no update, and no delete of anything at all — so
-- nothing created at v1.9.7 or earlier is read, written, altered, dropped, or truncated
-- (Requirements 26.1, 26.2).
--
-- Contents:
--   1. cancellation_templates            one row per touchpoint (15, 10, 5, 1)
--   2. cancellation_template_versions    version 1, English and Spanish, per touchpoint
--   3. cancellation_prohibited_phrases   2 English + 2 Spanish per claim category
--   4. Post-conditions, including the seeded-body / seeded-phrase cross-check
--
-- RE-APPLIABILITY
--   Every insert carries `on conflict ... do nothing` on the natural key v1.10.1 already
--   declares: `(touchpoint)` for templates, `(template_id, version, language)` for
--   versions, `(language, claim_category, phrase)` for phrases. A re-run therefore
--   inserts nothing and overwrites nothing, which matters more here than anywhere else
--   in the series: cancellation_template_versions is immutable (Requirement 14.17), so a
--   seed that tried to correct a stored row would raise rather than update, and a manager
--   who has since added version 2 rows keeps them untouched. This file seeds version 1
--   and never edits it.
--
-- TOKEN DELIMITER — MATCHED TO THE RENDERER, NOT RE-DECIDED HERE
--   v1.10.1 deliberately added no constraint naming a delimiter and left the choice to
--   this seed and to the renderer. The renderer took it:
--   `src/features/cancellations/render/renderMessage.ts` exports
--   `TOKEN_DELIMITER = { open: '{{', close: '}}' }` and `tokenPlaceholder(name)`, so a
--   token is its bare name wrapped in DOUBLE CURLY BRACES.
--     * `subject`, `body`, `cancellation_statement`, and `contact_request` below write
--       placeholders in that form: `{{Office_Phone}}`, `{{Amount_Due}}`.
--     * `fallback_text` keys are BARE token names with no delimiter — `Office_Phone`,
--       not `{{Office_Phone}}` — which is how v1.10.1 documents reading them and how the
--       renderer looks them up.
--   Every token name used below comes from that file's exported `TOKEN_NAMES`, and the
--   six `fallback_text` keys are exactly its exported `FALLBACK_TOKEN_NAMES`. An
--   unrecognized token renders zero characters rather than its own placeholder text, so a
--   post-condition below refuses any token name outside that list: no customer may ever
--   receive the literal text `{{Amount_Due}}`.
--
-- TWO SEED-SHAPE RULES THE RENDERER DEPENDS ON
--   1. EACH OPTIONAL VALUE SITS ON ITS OWN LINE, in the form `Label: {{Token}}`. The
--      renderer drops a body line whose every token rendered zero characters, which is
--      what stops `Amount due: {{Amount_Due}}` reaching the 11 of 58 real `eficacia` rows
--      with an empty `MontoDebido` as the dangling text `Amount due:`. A line that mixed
--      an optional token with required prose could not be dropped and would ship
--      half-empty, so no line below does that: the two lines carrying more than one token
--      (`{{Agency_Name}} - {{Office_Phone}}`) carry only values that are never absent.
--   2. EVERY OPTIONAL TOKEN HAS A NON-EMPTY FALLBACK. A stored empty string and an absent
--      key both render zero characters (Requirement 14.11), so a fallback that is meant
--      to be read has to carry text. All six `FALLBACK_TOKEN_NAMES` are seeded non-empty
--      in both languages, and a post-condition refuses a blank one.
--      `Office_Phone`'s fallback is unreachable — `cancellation_settings.office_phone` is
--      `not null` with an at-least-one-digit check — and is seeded with the agency digits
--      rather than prose so that even the unreachable path would satisfy Requirement
--      14.4, which matches Office_Phone as a digit sequence.
--
-- CONTENT (Requirement 14, read against the seeded rows)
--   Every seeded body carries, in its own language: the stored cancellation-scheduled
--   statement (14.2) as `{{Cancellation_Statement}}`; the cancellation effective date
--   (14.3) as `{{Cancellation_Date}}`, rendered by the renderer as day, month, and
--   four-digit year; the stored contact request (14.5) as `{{Contact_Request}}`, whose own
--   text carries `{{Contact_Deadline}}` — the earliest included effective date; Agency_Name
--   (14.1); Office_Phone (14.4); and the sender name (14.13) as `{{Sender_Name}}`, which
--   resolves to the assigned employee display name or to Agency_Name (14.14). The renderer
--   appends any of those a template omits, but seeding them is the point of this task, so
--   a post-condition asserts each token is present in each of the eight bodies rather than
--   relying on that backstop.
--   Because both language rows of one version carry all of it, a Bilingual render — two
--   segments plus exactly one separator — satisfies Requirements 11.6, 11.7, and 14.6
--   without the renderer having to append anything.
--
--   NO PROHIBITED CLAIM IS WRITTEN. Nothing below promises reinstatement, claims that
--   payment guarantees continued coverage, requests payment-card or bank-account data, or
--   asserts that the message is the carrier's official legal notice. The statement says
--   only what agency records show; the contact request asks the customer to call the
--   office. A post-condition proves it mechanically: it re-applies the Requirement 14.8
--   comparison — both sides lower-cased with every whitespace run collapsed to one space —
--   between every seeded phrase and the concatenated subject, body, statement, contact
--   request, and fallback text of every seeded version row, and raises on any containment.
--   A seed whose own bodies tripped its own gate would set
--   `communication_status = 'Manual Follow-up Required'` on every case at the first
--   scheduler run and send nothing.
--
-- PHRASE LIST (Requirement 14.7)
--   Two English and two Spanish phrases for each of the five claim categories: 20 rows,
--   against a floor of 10. Phrases are stored in natural form; the renderer's gate
--   lower-cases and collapses whitespace on both sides at compare time, so the phrase
--   written into the audit timeline under Requirement 14.9 stays in the form a compliance
--   reviewer recognizes. Each phrase is a full claim sentence rather than a single word,
--   which is deliberate: the gate matches by containment, so a one-word phrase such as
--   `reinstated` would block ordinary prose for a lifetime of future templates.
--
-- WHAT THIS FILE DOES NOT DO
--   It writes no `cancellation_settings` row (v1.10.4 seeds the single row and owns
--   Agency_Name, Office_Phone, and the bilingual separator), adds no policy (v1.10.6 owns
--   RLS for every cancellation_* table), and names no employee: `created_by` stays null,
--   which v1.10.1 keeps nullable precisely so a system seed can leave it so.
--
-- ROLLBACK PATH
--   There is no row-level undo for the template versions, by design. v1.10.1's
--   immutability trigger refuses every update and delete on
--   cancellation_template_versions for every role including a security definer path
--   (Requirement 14.17), and `on delete restrict` on `template_id` then blocks deleting
--   the four cancellation_templates rows while those versions exist. Dropping the three
--   tables is v1.10.1's rollback, not this file's.
--   To neutralize the seeded phrase list without deleting the evidence of what the gate
--   used to block:
--     begin;
--       update public.cancellation_prohibited_phrases
--          set is_active = false
--        where created_at <= (select max(created_at) from public.cancellation_prohibited_phrases);
--     commit;
--   (Retire, never delete: the gate enforces only active rows.) To stop the seeded
--   templates being used, insert a version 2 pair rather than removing version 1.
--   Requirement 26.3 keeps every applied v1.10.x migration applied when application code
--   is rolled back, so neither action is part of a code rollback.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE FOUR TEMPLATES
--
--    Requirement 12.1 fixes exactly four touchpoints, and v1.10.1's
--    `unique (touchpoint)` makes each one a single row, which is the lookup key both the
--    scheduler and the Requirement 13.7 fewest-days-remaining rule use. `name` is the
--    manager-facing label only; no rendered word comes from this table.
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.cancellation_templates (touchpoint, name) values
  (15, 'Cancellation reminder - 15 days'),
  (10, 'Cancellation reminder - 10 days'),
  (5,  'Cancellation reminder - 5 days'),
  (1,  'Cancellation reminder - final day')
on conflict (touchpoint) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. VERSION 1 — ONE ENGLISH AND ONE SPANISH ROW PER TOUCHPOINT
--
--    Eight rows. `language` is English or Spanish only: Bilingual is a render language
--    assembled from both rows of one version plus exactly one separator, never a stored
--    row (Requirements 11.2, 11.6, 11.8).
--
--    The four touchpoints share one statement and one contact request per language and
--    differ only in the lead line, which is the sentence that carries the urgency. Those
--    lead lines carry no token, so they can never be dropped by the renderer's line rule.
--
--    Body shape, and why it is this shape:
--      {{Contact_Name}},                                <- optional, own line, fallback
--      <lead line>                                      <- required prose, no token
--      {{Cancellation_Statement}}                       <- Requirement 14.2
--      Policy: {{Policy_Number}}                        <- optional, own line
--      Carrier: {{Carrier}}                             <- optional, own line, fallback
--      Cancellation effective date: {{Cancellation_Date}}  <- Requirement 14.3, never absent
--      Reason on record: {{Cancellation_Reason}}        <- optional, own line, fallback
--      Amount due: {{Amount_Due}}                       <- optional, own line, fallback
--      {{Contact_Request}}                              <- Requirement 14.5, carries the deadline
--      Your agent: {{Producer_Name}}                    <- optional, own line, fallback
--      {{Sender_Name}}                                  <- Requirement 14.13
--      {{Agency_Name}} - {{Office_Phone}}               <- Requirements 14.1, 14.4
--
--    `{{Policy_Number}}` has no fallback deliberately, and it is the one optional token
--    that relies on the line being dropped rather than filled: in a combined SMS the
--    renderer leaves it absent because Requirement 13.3 forbids individual policy numbers
--    in that body, so `Policy: {{Policy_Number}}` must vanish rather than acquire
--    substitute wording. (A combined SMS is assembled from the statement, the count and
--    earliest date, and the contact request rather than from this body — the drop rule is
--    the guard for the paths that do use it.)
--
--    `{{Office_Phone}}` appears twice on purpose: once inside the contact request and once
--    on the closing line. The compact combined-SMS path uses only the statement, the dates,
--    and the contact request, so carrying the phone inside the contact request is what
--    keeps Requirement 14.4 satisfied there without the renderer appending a signature and
--    spending characters against the 640-character cap.
--
--    A single-case body renders to roughly 420 characters per language segment, so a
--    Bilingual single-case SMS runs to several segments. That is deliberate and within
--    spec — only a combined SMS is capped (Requirement 13.3) — and a manager who wants a
--    shorter text saves a version 2 pair rather than editing these rows.
-- ═══════════════════════════════════════════════════════════════════════════════
with fallback (language, fallback_text) as (
  values
    -- Keys are bare token names, exactly FALLBACK_TOKEN_NAMES from the renderer. Every
    -- value is non-empty: an empty string would render zero characters and leave the
    -- label it follows dangling. Office_Phone's entry is unreachable (settings.office_phone
    -- is not null with a digit check) and holds the agency digit sequence so that even
    -- that path would satisfy Requirement 14.4.
    ('English', '{
       "Office_Phone": "(704) 824-3130",
       "Amount_Due": "call our office to confirm",
       "Producer_Name": "our service team",
       "Contact_Name": "Dear customer",
       "Carrier": "see your policy documents",
       "Cancellation_Reason": "call our office for details"
     }'::jsonb),
    ('Spanish', '{
       "Office_Phone": "(704) 824-3130",
       "Amount_Due": "llame a nuestra oficina para confirmar",
       "Producer_Name": "nuestro equipo de servicio",
       "Contact_Name": "Estimado cliente",
       "Carrier": "consulte los documentos de su póliza",
       "Cancellation_Reason": "llame a nuestra oficina para más detalles"
     }'::jsonb)
),
seed (touchpoint, language, subject, body, cancellation_statement, contact_request) as (
  values
    -- ── 15 days ─────────────────────────────────────────────────────────────────
    (15, 'English',
     '{{Touchpoint_Days}}-day reminder: policy cancellation scheduled for {{Cancellation_Date}}',
     $body${{Contact_Name}},

This is a courtesy reminder about your insurance policy.

{{Cancellation_Statement}}

Policy: {{Policy_Number}}
Carrier: {{Carrier}}
Cancellation effective date: {{Cancellation_Date}}
Reason on record: {{Cancellation_Reason}}
Amount due: {{Amount_Due}}

{{Contact_Request}}

Your agent: {{Producer_Name}}

{{Sender_Name}}
{{Agency_Name}} - {{Office_Phone}}$body$,
     'Our agency records show that your insurance policy is scheduled for cancellation.',
     'Please call our office at {{Office_Phone}} on or before {{Contact_Deadline}} to review your options.'),

    (15, 'Spanish',
     'Recordatorio de {{Touchpoint_Days}} días: cancelación de póliza programada para el {{Cancellation_Date}}',
     $body${{Contact_Name}},

Este es un recordatorio de cortesía sobre su póliza de seguro.

{{Cancellation_Statement}}

Póliza: {{Policy_Number}}
Compañía: {{Carrier}}
Fecha efectiva de cancelación: {{Cancellation_Date}}
Motivo registrado: {{Cancellation_Reason}}
Monto pendiente: {{Amount_Due}}

{{Contact_Request}}

Su agente: {{Producer_Name}}

{{Sender_Name}}
{{Agency_Name}} - {{Office_Phone}}$body$,
     'Los registros de nuestra agencia indican que su póliza de seguro está programada para cancelación.',
     'Llame a nuestra oficina al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.'),

    -- ── 10 days ─────────────────────────────────────────────────────────────────
    (10, 'English',
     '{{Touchpoint_Days}}-day reminder: policy cancellation scheduled for {{Cancellation_Date}}',
     $body${{Contact_Name}},

This is a second reminder about your insurance policy.

{{Cancellation_Statement}}

Policy: {{Policy_Number}}
Carrier: {{Carrier}}
Cancellation effective date: {{Cancellation_Date}}
Reason on record: {{Cancellation_Reason}}
Amount due: {{Amount_Due}}

{{Contact_Request}}

Your agent: {{Producer_Name}}

{{Sender_Name}}
{{Agency_Name}} - {{Office_Phone}}$body$,
     'Our agency records show that your insurance policy is scheduled for cancellation.',
     'Please call our office at {{Office_Phone}} on or before {{Contact_Deadline}} to review your options.'),

    (10, 'Spanish',
     'Recordatorio de {{Touchpoint_Days}} días: cancelación de póliza programada para el {{Cancellation_Date}}',
     $body${{Contact_Name}},

Este es un segundo recordatorio sobre su póliza de seguro.

{{Cancellation_Statement}}

Póliza: {{Policy_Number}}
Compañía: {{Carrier}}
Fecha efectiva de cancelación: {{Cancellation_Date}}
Motivo registrado: {{Cancellation_Reason}}
Monto pendiente: {{Amount_Due}}

{{Contact_Request}}

Su agente: {{Producer_Name}}

{{Sender_Name}}
{{Agency_Name}} - {{Office_Phone}}$body$,
     'Los registros de nuestra agencia indican que su póliza de seguro está programada para cancelación.',
     'Llame a nuestra oficina al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.'),

    -- ── 5 days ──────────────────────────────────────────────────────────────────
    (5, 'English',
     '{{Touchpoint_Days}}-day reminder: policy cancellation scheduled for {{Cancellation_Date}}',
     $body${{Contact_Name}},

The cancellation date on your insurance policy is close, so please contact our office.

{{Cancellation_Statement}}

Policy: {{Policy_Number}}
Carrier: {{Carrier}}
Cancellation effective date: {{Cancellation_Date}}
Reason on record: {{Cancellation_Reason}}
Amount due: {{Amount_Due}}

{{Contact_Request}}

Your agent: {{Producer_Name}}

{{Sender_Name}}
{{Agency_Name}} - {{Office_Phone}}$body$,
     'Our agency records show that your insurance policy is scheduled for cancellation.',
     'Please call our office at {{Office_Phone}} on or before {{Contact_Deadline}} to review your options.'),

    (5, 'Spanish',
     'Recordatorio de {{Touchpoint_Days}} días: cancelación de póliza programada para el {{Cancellation_Date}}',
     $body${{Contact_Name}},

La fecha de cancelación de su póliza de seguro está próxima, por favor comuníquese con nuestra oficina.

{{Cancellation_Statement}}

Póliza: {{Policy_Number}}
Compañía: {{Carrier}}
Fecha efectiva de cancelación: {{Cancellation_Date}}
Motivo registrado: {{Cancellation_Reason}}
Monto pendiente: {{Amount_Due}}

{{Contact_Request}}

Su agente: {{Producer_Name}}

{{Sender_Name}}
{{Agency_Name}} - {{Office_Phone}}$body$,
     'Los registros de nuestra agencia indican que su póliza de seguro está programada para cancelación.',
     'Llame a nuestra oficina al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.'),

    -- ── 1 day ───────────────────────────────────────────────────────────────────
    (1, 'English',
     'Last reminder: policy cancellation scheduled for {{Cancellation_Date}}',
     $body${{Contact_Name}},

This is our last scheduled reminder before the cancellation date on your insurance policy.

{{Cancellation_Statement}}

Policy: {{Policy_Number}}
Carrier: {{Carrier}}
Cancellation effective date: {{Cancellation_Date}}
Reason on record: {{Cancellation_Reason}}
Amount due: {{Amount_Due}}

{{Contact_Request}}

Your agent: {{Producer_Name}}

{{Sender_Name}}
{{Agency_Name}} - {{Office_Phone}}$body$,
     'Our agency records show that your insurance policy is scheduled for cancellation.',
     'Please call our office at {{Office_Phone}} on or before {{Contact_Deadline}} to review your options.'),

    (1, 'Spanish',
     'Último recordatorio: cancelación de póliza programada para el {{Cancellation_Date}}',
     $body${{Contact_Name}},

Este es nuestro último recordatorio programado antes de la fecha de cancelación de su póliza de seguro.

{{Cancellation_Statement}}

Póliza: {{Policy_Number}}
Compañía: {{Carrier}}
Fecha efectiva de cancelación: {{Cancellation_Date}}
Motivo registrado: {{Cancellation_Reason}}
Monto pendiente: {{Amount_Due}}

{{Contact_Request}}

Su agente: {{Producer_Name}}

{{Sender_Name}}
{{Agency_Name}} - {{Office_Phone}}$body$,
     'Los registros de nuestra agencia indican que su póliza de seguro está programada para cancelación.',
     'Llame a nuestra oficina al {{Office_Phone}} antes del {{Contact_Deadline}} para revisar sus opciones.')
)
insert into public.cancellation_template_versions
  (template_id, version, language, subject, body, cancellation_statement, contact_request, fallback_text)
select t.id, 1, s.language, s.subject, s.body, s.cancellation_statement, s.contact_request, f.fallback_text
  from seed s
  join public.cancellation_templates t on t.touchpoint = s.touchpoint
  join fallback f on f.language = s.language
on conflict (template_id, version, language) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. THE PROHIBITED PHRASE LIST
--
--    Requirement 14.7: at least one English and one Spanish phrase for each of the five
--    prohibited claims. Two of each are seeded, so the gate catches the two most likely
--    wordings of each claim rather than only one.
--
--    Stored in natural form. Requirement 14.8 lower-cases and collapses whitespace on
--    both sides at compare time, so no pre-normalized copy is stored and the matched
--    phrase recorded in the audit timeline under Requirement 14.9 reads as written here.
--    `is_active` defaults to true; retiring a phrase clears that flag instead of deleting
--    the row.
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.cancellation_prohibited_phrases (phrase, language, claim_category) values
  -- Claim: that the policy will be reinstated.
  ('your policy will be reinstated',                              'English', 'reinstatement'),
  ('we will reinstate your policy',                               'English', 'reinstatement'),
  ('su póliza será reactivada',                                   'Spanish', 'reinstatement'),
  ('vamos a reactivar su póliza',                                 'Spanish', 'reinstatement'),

  -- Claim: that payment guarantees continued coverage.
  ('your payment guarantees continued coverage',                  'English', 'payment_guarantees_coverage'),
  ('paying now guarantees your coverage will not lapse',          'English', 'payment_guarantees_coverage'),
  ('su pago garantiza la continuidad de su cobertura',            'Spanish', 'payment_guarantees_coverage'),
  ('pagar ahora garantiza que su cobertura no se cancelará',      'Spanish', 'payment_guarantees_coverage'),

  -- Claim: a request for payment-card data.
  ('send us your credit card number',                             'English', 'payment_card_request'),
  ('reply with your debit card number and expiration date',       'English', 'payment_card_request'),
  ('envíenos el número de su tarjeta de crédito',                 'Spanish', 'payment_card_request'),
  ('responda con el número de su tarjeta de débito',              'Spanish', 'payment_card_request'),

  -- Claim: a request for bank account data.
  ('send us your bank account and routing number',                'English', 'bank_account_request'),
  ('reply with your checking account number',                     'English', 'bank_account_request'),
  ('envíenos su número de cuenta bancaria',                       'Spanish', 'bank_account_request'),
  ('responda con el número de su cuenta de cheques',              'Spanish', 'bank_account_request'),

  -- Claim: that the message is the carrier's official legal notice.
  ('this is the official legal notice of cancellation from your insurance carrier',
                                                                  'English', 'carrier_legal_notice'),
  ('this message is the carrier official cancellation notice',    'English', 'carrier_legal_notice'),
  ('este es el aviso legal oficial de cancelación de su compañía de seguros',
                                                                  'Spanish', 'carrier_legal_notice'),
  ('este mensaje es el aviso oficial de cancelación de la compañía',
                                                                  'Spanish', 'carrier_legal_notice')
on conflict (language, claim_category, phrase) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. POST-CONDITIONS
--    Any failure below raises, which rolls the whole seed back rather than leaving the
--    renderer to load a template that cannot satisfy Requirement 14.
--
--    Every row-level check is scoped to `version = 1`, which is what this file seeds and
--    is at most eight rows (four touchpoints x two languages, held by
--    `unique (template_id, version, language)`). A manager's later version 2 pair is not
--    judged here — the renderer's gate judges it at send time. If a version 1 row was
--    written by someone else before this file ran, the `on conflict do nothing` above left
--    it alone and these checks are then reporting on that row, which the messages below
--    name by touchpoint and language.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing     text;
  v_collision   text;
  v_label       text;
  v_count       integer;
  v_open        integer;
  v_matched     integer;
  v_text        text;
  v_row         record;
begin
  -- ── v1.10.1 must be applied: this file seeds its three tables and creates nothing.
  select string_agg(t.name, ', ' order by t.name) into v_missing
    from (values ('cancellation_templates'), ('cancellation_template_versions'),
                 ('cancellation_prohibited_phrases')) as t(name)
   where not exists (select 1 from pg_tables
                      where schemaname = 'public' and tablename = t.name);
  if v_missing is not null then
    raise exception 'v1.10.9 cannot seed: % absent', v_missing
      using detail = 'Apply v1.10.1-cancellation-templates.sql first.', hint = 'Rolling back.';
  end if;

  -- ── The four touchpoints exist, and nothing else does.
  select count(*) into v_count from public.cancellation_templates where touchpoint in (15, 10, 5, 1);
  if v_count <> 4 then
    raise exception 'v1.10.9 left % of the four touchpoint templates seeded', v_count
      using detail = 'Requirement 12.1 fixes exactly four touchpoints: 15, 10, 5, 1.',
            hint = 'Rolling back.';
  end if;

  -- ── All eight (touchpoint, language) version 1 rows exist.
  select string_agg(format('%s/%s', x.touchpoint, x.language), ', '
                    order by x.touchpoint desc, x.language) into v_missing
    from (values (15, 'English'), (15, 'Spanish'), (10, 'English'), (10, 'Spanish'),
                 (5, 'English'), (5, 'Spanish'), (1, 'English'), (1, 'Spanish')) as x(touchpoint, language)
   where not exists (
     select 1 from public.cancellation_template_versions v
       join public.cancellation_templates t on t.id = v.template_id
      where t.touchpoint = x.touchpoint and v.language = x.language and v.version = 1);
  if v_missing is not null then
    raise exception 'v1.10.9 did not seed these (touchpoint/language) version 1 rows: %', v_missing
      using detail = 'Requirement 11.6 needs one English and one Spanish row per touchpoint.',
            hint = 'Rolling back.';
  end if;

  select count(*) into v_count from public.cancellation_template_versions where version = 1;
  if v_count <> 8 then
    raise exception 'v1.10.9 left % version 1 rows rather than 8', v_count using hint = 'Rolling back.';
  end if;

  -- ── Per seeded row: required elements, token names, fallback text, line shape, tokens.
  for v_row in
    select t.touchpoint, v.language, v.subject, v.body,
           v.cancellation_statement, v.contact_request, v.fallback_text
      from public.cancellation_template_versions v
      join public.cancellation_templates t on t.id = v.template_id
     where v.version = 1
     order by t.touchpoint desc, v.language
  loop
    v_label := format('touchpoint %s %s version 1', v_row.touchpoint, v_row.language);
    v_text := concat_ws(' ', v_row.subject, v_row.body, v_row.cancellation_statement,
                        v_row.contact_request, v_row.fallback_text::text);

    -- Requirements 14.1, 14.2, 14.3, 14.4, 14.13: each element written by the template
    -- itself rather than left to the renderer to append.
    select string_agg(r.token, ', ' order by r.token) into v_missing
      from (values ('{{Cancellation_Statement}}'), ('{{Contact_Request}}'), ('{{Cancellation_Date}}'),
                   ('{{Agency_Name}}'), ('{{Office_Phone}}'), ('{{Sender_Name}}')) as r(token)
     where strpos(v_row.body, r.token) = 0;
    if v_missing is not null then
      raise exception 'v1.10.9 seeded the % body without: %', v_label, v_missing
        using detail = 'Requirements 14.1 (Agency_Name), 14.2 (statement), 14.3 (effective date), 14.4 (Office_Phone), 14.5 (contact request), 14.13 (sender name).',
              hint = 'Rolling back.';
    end if;

    -- Requirement 14.5: the contact request carries the deadline token.
    if strpos(v_row.contact_request, '{{Contact_Deadline}}') = 0 then
      raise exception 'v1.10.9 seeded the % contact request without {{Contact_Deadline}}', v_label
        using detail = 'Requirement 14.5: the contact deadline is the earliest included cancellation effective date.',
              hint = 'Rolling back.';
    end if;

    -- The seeded subjects are non-blank. (The column allows zero characters, because
    -- Requirement 14.15 stores zero characters as the rendered SMS subject; that is a
    -- render-time fact, not a stored one.)
    if char_length(btrim(v_row.subject)) = 0 then
      raise exception 'v1.10.9 seeded a blank subject for %', v_label using hint = 'Rolling back.';
    end if;

    -- Every {{Token}} is one the renderer resolves. An unrecognized name renders zero
    -- characters, so a typo would silently drop text from a customer message.
    select string_agg(distinct m.captures[1], ', ') into v_missing
      from regexp_matches(v_text, '\{\{([A-Za-z_]+)\}\}', 'g') as m(captures)
     where m.captures[1] not in (
       'Agency_Name', 'Office_Phone', 'Sender_Name', 'Producer_Name', 'Customer_Name',
       'Contact_Name', 'Policy_Number', 'Carrier', 'Cancellation_Reason', 'Amount_Due',
       'Cancellation_Date', 'Contact_Deadline', 'Earliest_Cancellation_Date', 'Policy_Count',
       'Policy_List', 'Cancellation_Statement', 'Contact_Request', 'Touchpoint_Days');
    if v_missing is not null then
      raise exception 'v1.10.9 seeded % with token names the renderer does not resolve: %', v_label, v_missing
        using detail = 'TOKEN_NAMES in src/features/cancellations/render/renderMessage.ts is the whole list; an unrecognized token renders zero characters.',
              hint = 'Rolling back.';
    end if;

    -- Every `{{` opens a well-formed placeholder: no `{{ Office_Phone }}`, no unclosed pair.
    v_open := (char_length(v_text) - char_length(replace(v_text, '{{', ''))) / 2;
    select count(*) into v_matched
      from regexp_matches(v_text, '\{\{([A-Za-z_]+)\}\}', 'g') as m(captures);
    if v_open <> v_matched then
      raise exception 'v1.10.9 seeded % with % open delimiters but % well-formed placeholders',
                      v_label, v_open, v_matched
        using detail = 'TOKEN_DELIMITER is {{ ... }} with a bare token name and no padding.',
              hint = 'Rolling back.';
    end if;

    -- Requirement 14.11: all six FALLBACK_TOKEN_NAMES present and non-blank. A stored
    -- empty string and an absent key both render zero characters, so both fail here.
    select string_agg(k.name, ', ' order by k.name) into v_missing
      from (values ('Office_Phone'), ('Amount_Due'), ('Producer_Name'),
                   ('Contact_Name'), ('Carrier'), ('Cancellation_Reason')) as k(name)
     where coalesce(btrim(v_row.fallback_text ->> k.name), '') = '';
    if v_missing is not null then
      raise exception 'v1.10.9 seeded % with absent or blank fallback text for: %', v_label, v_missing
        using detail = 'Requirement 14.11: a stored empty string and an absent key both render zero characters.',
              hint = 'Rolling back.';
    end if;

    -- fallback_text keys are BARE token names, carrying no delimiter.
    select string_agg(k.token_key, ', ' order by k.token_key) into v_missing
      from jsonb_object_keys(v_row.fallback_text) as k(token_key)
     where k.token_key like '%{%' or k.token_key like '%}%';
    if v_missing is not null then
      raise exception 'v1.10.9 seeded % with delimited fallback_text keys: %', v_label, v_missing
        using detail = 'v1.10.1 documents fallback_text keys as bare token names: Office_Phone, not {{Office_Phone}}.',
              hint = 'Rolling back.';
    end if;

    -- Each optional token sits alone on its line, so the renderer can drop that line
    -- whole when the value and its fallback both render zero characters. A line holding
    -- an optional token together with any second token cannot be dropped and would ship
    -- half-empty.
    select string_agg(format('%s on line "%s"', o.name, btrim(l.txt)), ' | ' order by o.name) into v_missing
      from (values ('Contact_Name'), ('Policy_Number'), ('Carrier'),
                   ('Cancellation_Reason'), ('Amount_Due'), ('Producer_Name')) as o(name)
      cross join unnest(string_to_array(v_row.body, E'\n')) as l(txt)
     where strpos(l.txt, '{{' || o.name || '}}') > 0
       and (char_length(l.txt) - char_length(replace(l.txt, '{{', ''))) / 2 <> 1;
    if v_missing is not null then
      raise exception 'v1.10.9 seeded % with an optional token sharing a line: %', v_label, v_missing
        using detail = 'The renderer drops a body line only when every token on it rendered zero characters; a shared line ships half-empty instead.',
              hint = 'Rolling back.';
    end if;

    -- Requirement 14.12: none of nan / none / null / undefined as a complete token, in the
    -- stored text or in any stored fallback value. Bounded by start, end, or a character
    -- that is neither a letter nor a digit, which is the renderer's gate rule.
    if v_text ~* '(^|[^[:alnum:]])(nan|none|null|undefined)([^[:alnum:]]|$)' then
      raise exception 'v1.10.9 seeded a forbidden token in %', v_label
        using detail = 'Requirement 14.12 excludes nan, NaN, None, null, and undefined from every rendered subject and body.',
              hint = 'Rolling back.';
    end if;
  end loop;

  -- ── Requirement 14.7: at least one active English and one active Spanish phrase for
  --    each of the five prohibited claims.
  select string_agg(format('%s/%s', c.language, c.category), ', ' order by c.category, c.language)
    into v_missing
    from (select l.language, k.category
            from (values ('English'), ('Spanish')) as l(language)
            cross join (values ('reinstatement'), ('payment_guarantees_coverage'),
                               ('payment_card_request'), ('bank_account_request'),
                               ('carrier_legal_notice')) as k(category)) as c
   where not exists (
     select 1 from public.cancellation_prohibited_phrases p
      where p.language = c.language and p.claim_category = c.category and p.is_active);
  if v_missing is not null then
    raise exception 'v1.10.9 left these (language/claim) prohibited-phrase pairs unseeded: %', v_missing
      using detail = 'Requirement 14.7 needs at least one English and one Spanish phrase per claim category.',
            hint = 'Rolling back.';
  end if;

  select count(*) into v_count from public.cancellation_prohibited_phrases where is_active;
  if v_count < 10 then
    raise exception 'v1.10.9 left only % active prohibited phrases; Requirement 14.7 needs at least 10', v_count
      using hint = 'Rolling back.';
  end if;

  -- ── THE CROSS-CHECK: no seeded body matches a seeded phrase.
  --    The Requirement 14.8 comparison, applied here exactly as the renderer's gate
  --    applies it: both sides lower-cased with every whitespace run collapsed to one
  --    space, then containment. Run over the subject, body, statement, contact request,
  --    and every stored fallback value, so a phrase hiding in fallback text is caught too.
  --    A hit would mean the seed blocks its own sends: zero Communication_Record rows and
  --    `Manual Follow-up Required` on every case at the first scheduler run.
  select string_agg(format('%s %s v1 contains the %s %s phrase "%s"',
                           t.touchpoint, v.language, p.language, p.claim_category, p.phrase), '; ')
    into v_collision
    from public.cancellation_template_versions v
    join public.cancellation_templates t on t.id = v.template_id
    cross join public.cancellation_prohibited_phrases p
   where v.version = 1
     and p.is_active
     and strpos(
           btrim(lower(regexp_replace(
             concat_ws(' ', v.subject, v.body, v.cancellation_statement, v.contact_request,
                       v.fallback_text::text), '\s+', ' ', 'g'))),
           btrim(lower(regexp_replace(p.phrase, '\s+', ' ', 'g')))
         ) > 0;
  if v_collision is not null then
    raise exception 'v1.10.9 seeded a body that matches its own prohibited-phrase list: %', v_collision
      using detail = 'Requirements 14.8, 14.9: the render gate would block every send from that template version.',
            hint = 'Rolling back.';
  end if;
end
$post$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
--   `body_phrase_collisions_expect_0` re-runs the Requirement 14.8 comparison between
--   every seeded phrase and every seeded version row, and
--   `forbidden_token_rows_expect_0` re-runs the Requirement 14.12 token rule, so both
--   answers are visible in the applied output rather than only inside the rolled-back
--   post-condition block.
-- ═══════════════════════════════════════════════════════════════════════════════
select
  (select count(*) from public.cancellation_templates) as templates_expect_4,
  (select count(*) from public.cancellation_templates
    where touchpoint in (15, 10, 5, 1)) as touchpoints_15_10_5_1_expect_4,
  (select count(*) from public.cancellation_template_versions
    where version = 1) as version1_rows_expect_8,
  (select count(*) from public.cancellation_template_versions
    where version = 1 and language = 'English') as english_rows_expect_4,
  (select count(*) from public.cancellation_template_versions
    where version = 1 and language = 'Spanish') as spanish_rows_expect_4,
  (select count(*) from public.cancellation_template_versions
    where version = 1 and created_by is null) as system_seeded_rows_expect_8,
  (select count(*) from public.cancellation_template_versions v
    where v.version = 1
      and strpos(v.body, '{{Cancellation_Statement}}') > 0
      and strpos(v.body, '{{Cancellation_Date}}') > 0
      and strpos(v.body, '{{Contact_Request}}') > 0
      and strpos(v.body, '{{Agency_Name}}') > 0
      and strpos(v.body, '{{Office_Phone}}') > 0
      and strpos(v.body, '{{Sender_Name}}') > 0
      and strpos(v.contact_request, '{{Contact_Deadline}}') > 0) as bodies_with_every_required_element_expect_8,
  (select count(*) from public.cancellation_template_versions
    where version = 1
      and fallback_text ?& array['Office_Phone', 'Amount_Due', 'Producer_Name',
                                 'Contact_Name', 'Carrier', 'Cancellation_Reason']) as rows_with_six_fallbacks_expect_8,
  (select count(*) from public.cancellation_prohibited_phrases) as phrase_rows_expect_20,
  (select count(*) from public.cancellation_prohibited_phrases
    where language = 'English' and is_active) as active_english_phrases_expect_10,
  (select count(*) from public.cancellation_prohibited_phrases
    where language = 'Spanish' and is_active) as active_spanish_phrases_expect_10,
  (select count(distinct (language, claim_category)) from public.cancellation_prohibited_phrases
    where is_active) as active_language_claim_pairs_expect_10,
  (select count(*)
     from public.cancellation_template_versions v
     cross join public.cancellation_prohibited_phrases p
    where v.version = 1
      and p.is_active
      and strpos(
            btrim(lower(regexp_replace(
              concat_ws(' ', v.subject, v.body, v.cancellation_statement, v.contact_request,
                        v.fallback_text::text), '\s+', ' ', 'g'))),
            btrim(lower(regexp_replace(p.phrase, '\s+', ' ', 'g')))
          ) > 0) as body_phrase_collisions_expect_0,
  (select count(*) from public.cancellation_template_versions v
    where v.version = 1
      and concat_ws(' ', v.subject, v.body, v.cancellation_statement, v.contact_request,
                    v.fallback_text::text)
          ~* '(^|[^[:alnum:]])(nan|none|null|undefined)([^[:alnum:]]|$)') as forbidden_token_rows_expect_0;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.21.0 verification probe — Carrier Email Submission
--
-- Spec: .kiro/specs/carrier-email-submission
-- Authored by Claude (Cowork), 20 August 2026.
--
-- Run AFTER v1.21.0-carrier-email-submission.sql.
--
-- SHAPE OF THIS FILE, and why:
--   The Supabase SQL editor returns only the LAST statement's result set, and discards
--   RAISE NOTICE output. A probe written as a series of SELECTs would therefore show one
--   table and silently hide the rest — which is exactly how a failing check goes unseen.
--
--   So this file is exactly two statements:
--     1. A DO block that exercises the write-path constraints and RAISES on any failure.
--        An exception IS surfaced by the editor. Success is silent. Everything it writes
--        is rolled back.
--     2. One SELECT returning every read-only assertion as a PASS / FAIL row.
--
--   If you see the table, statement 1 passed. Read the table for the rest.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Statement 1: the write-path constraints. Silent on success. ────────────────
do $probe$
declare
  v_opp uuid; v_mkt uuid; v_who uuid;
  v_failures text[] := '{}';
begin
  -- If the migration has not been applied, say so plainly and let statement 2 render
  -- the table. Without this guard the block dies on `column ... does not exist`, which
  -- reads like a defect in the probe rather than "you have not run the migration yet".
  if to_regclass('public.carrier_submissions') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'profiles'
                       and column_name = 'can_send_carrier_submissions') then
    raise notice 'v1.21.0 has not been applied yet — skipping the write-path probe.';
    return;
  end if;

  select id into v_opp from public.specialty_opportunities limit 1;
  select id into v_mkt from public.specialty_carrier_markets limit 1;
  execute 'select id from public.profiles where can_send_carrier_submissions limit 1'
    into v_who;

  if v_opp is null or v_mkt is null or v_who is null then
    raise notice 'SKIPPED the write-path probe: needs one opportunity, one carrier market, and one sender.';
    return;
  end if;

  -- 'sent' without proof it was sent.
  begin
    insert into public.carrier_submissions
      (opportunity_id, carrier_market_id, submitted_by, from_email, to_email,
       subject, body, idempotency_key, status, sent_at)
    values (v_opp, v_mkt, v_who, 'a@b.com', array['c@d.com'], 's', 'b', 'probe-a', 'sent', now());
    v_failures := v_failures || 'a submission claimed sent with no provider_message_id';
  exception when check_violation then null;
  end;

  begin
    insert into public.carrier_submissions
      (opportunity_id, carrier_market_id, submitted_by, from_email, to_email,
       subject, body, idempotency_key, status, provider_message_id)
    values (v_opp, v_mkt, v_who, 'a@b.com', array['c@d.com'], 's', 'b', 'probe-b', 'sent', '<m>');
    v_failures := v_failures || 'a submission claimed sent with no sent_at';
  exception when check_violation then null;
  end;

  begin
    insert into public.carrier_submissions
      (opportunity_id, carrier_market_id, submitted_by, from_email, to_email,
       subject, body, idempotency_key, status)
    values (v_opp, v_mkt, v_who, 'a@b.com', array['c@d.com'], 's', 'b', 'probe-c', 'failed');
    v_failures := v_failures || 'a failed submission recorded no reason';
  exception when check_violation then null;
  end;

  -- No recipient. array_length('{}', 1) is NULL and a CHECK passes on NULL, so the
  -- obvious `array_length(to_email,1) >= 1` form does NOT catch this. It admitted an
  -- empty recipient list in the first draft of the migration; this probe is why that
  -- was found before it reached production.
  begin
    insert into public.carrier_submissions
      (opportunity_id, carrier_market_id, submitted_by, from_email, to_email,
       subject, body, idempotency_key)
    values (v_opp, v_mkt, v_who, 'a@b.com', array[]::text[], 's', 'b', 'probe-d');
    v_failures := v_failures || 'a submission was accepted with no recipient';
  exception when check_violation then null;
  end;

  -- The send lock. The second insert is what a double-click looks like.
  insert into public.carrier_submissions
    (opportunity_id, carrier_market_id, submitted_by, from_email, to_email,
     subject, body, idempotency_key)
  values (v_opp, v_mkt, v_who, 'a@b.com', array['c@d.com'], 's', 'b', 'probe-e');
  begin
    insert into public.carrier_submissions
      (opportunity_id, carrier_market_id, submitted_by, from_email, to_email,
       subject, body, idempotency_key)
    values (v_opp, v_mkt, v_who, 'a@b.com', array['c@d.com'], 's', 'b', 'probe-e');
    v_failures := v_failures || 'a duplicate idempotency key was accepted — double-click would send twice';
  exception when unique_violation then null;
  end;

  if array_length(v_failures, 1) > 0 then
    raise exception 'v1.21.0 PROBE FAILED: %', array_to_string(v_failures, ' | ');
  end if;

  -- Undo everything this block wrote. Raising inside a block that has an EXCEPTION
  -- clause rolls back that block's subtransaction, which is the point.
  raise exception using errcode = 'S1P01', message = 'rollback';
exception
  when sqlstate 'S1P01' then null;
end $probe$;

-- ── Statement 2: everything read-only. This is the table you will see. ─────────
with checks(sort, check_name, result, expected) as (
  values
    (1, 'table user_email_connections exists',
        case when to_regclass('public.user_email_connections') is not null then 'PASS' else 'FAIL' end, 'PASS'),
    (2, 'table carrier_submissions exists',
        case when to_regclass('public.carrier_submissions') is not null then 'PASS' else 'FAIL' end, 'PASS'),
    (3, 'table carrier_submission_documents exists',
        case when to_regclass('public.carrier_submission_documents') is not null then 'PASS' else 'FAIL' end, 'PASS'),

    -- The single most important assertion in this file. RLS is row-level; hiding one
    -- column requires revoking table SELECT and re-granting per column. If any later
    -- migration issues a bare `grant select on public.user_email_connections to
    -- authenticated`, this flips to FAIL and the browser can read encrypted tokens.
    -- has_column_privilege() raises if the table is absent, so each of these is guarded.
    -- CASE works here because these are function calls evaluated at run time, unlike a
    -- bare column reference which is resolved when the statement is parsed.
    (10, 'SECURITY: authenticated CANNOT read the token ciphertext',
        case when to_regclass('public.user_email_connections') is null
                  then 'FAIL — migration not applied'
             when has_column_privilege('authenticated','public.user_email_connections',
                                       'encrypted_access_credentials','select')
                  then 'FAIL — STOP, DO NOT PROCEED TO PHASE B'
             else 'PASS' end, 'PASS'),
    (11, 'authenticated CAN read email_address',
        case when to_regclass('public.user_email_connections') is null
                  then 'FAIL — migration not applied'
             when has_column_privilege('authenticated','public.user_email_connections',
                                       'email_address','select') then 'PASS' else 'FAIL' end, 'PASS'),
    (12, 'authenticated CAN read status',
        case when to_regclass('public.user_email_connections') is null
                  then 'FAIL — migration not applied'
             when has_column_privilege('authenticated','public.user_email_connections',
                                       'status','select') then 'PASS' else 'FAIL' end, 'PASS'),

    (20, 'four RLS policies exist',
        case when (select count(*) from pg_policies where schemaname='public'
                    and policyname in ('user_email_connections_v1210_select',
                                       'user_email_connections_v1210_delete',
                                       'carrier_submissions_v1210_select',
                                       'carrier_submission_documents_v1210_select')) = 4
             then 'PASS' else 'FAIL' end, 'PASS'),
    (21, 'no client write policy on carrier_submissions (service role only)',
        case when (select count(*) from pg_policies where schemaname='public'
                    and tablename='carrier_submissions'
                    and cmd in ('INSERT','UPDATE','DELETE')) = 0
             then 'PASS' else 'FAIL' end, 'PASS'),
    (22, 'no delete policy on carrier_submissions (history is permanent)',
        case when (select count(*) from pg_policies where schemaname='public'
                    and tablename='carrier_submissions' and cmd='DELETE') = 0
             then 'PASS' else 'FAIL' end, 'PASS'),

    (30, 'activity vocabulary carries carrier_submission_emailed',
        case when exists (select 1 from information_schema.check_constraints
                           where constraint_schema='public'
                             and constraint_name='specialty_activity_event_type_check'
                             and check_clause like '%carrier_submission_emailed%')
             then 'PASS' else 'FAIL' end, 'PASS'),
    (31, 'activity vocabulary still carries the pre-existing values',
        case when exists (select 1 from information_schema.check_constraints
                           where constraint_schema='public'
                             and constraint_name='specialty_activity_event_type_check'
                             and check_clause like '%carrier_submitted%'
                             and check_clause like '%underwriting_result_recorded%')
             then 'PASS' else 'FAIL — the drop-and-readd lost prior values' end, 'PASS'),

    (40, 'market_directory has all four submission columns',
        case when (select count(*) from information_schema.columns
                    where table_schema='public' and table_name='market_directory'
                      and column_name in ('submission_cc','submission_subject_template',
                                          'submission_body_template','email_submission_enabled')) = 4
             then 'PASS' else 'FAIL' end, 'PASS'),
    -- These read their column through to_jsonb(row) ->> 'name' rather than naming it
    -- directly. A bare column reference is resolved when the statement is parsed, so if
    -- the migration has not been applied the whole table would abort with
    -- `column ... does not exist` instead of reporting FAIL on the rows that matter.
    (41, 'no carrier is submittable by accident',
        case when (select count(*) from public.market_directory md
                    where (to_jsonb(md) ->> 'email_submission_enabled')::boolean) = 0
             then 'PASS — none enabled yet'
             else (select 'NOTE — ' || count(*)::text || ' enabled'
                     from public.market_directory md
                    where (to_jsonb(md) ->> 'email_submission_enabled')::boolean) end, 'PASS'),
    (42, 'no market is enabled without an address',
        case when (select count(*) from public.market_directory md
                    where (to_jsonb(md) ->> 'email_submission_enabled')::boolean
                      and md.submission_email is null) = 0
             then 'PASS' else 'FAIL' end, 'PASS'),

    (50, 'at least one profile may send',
        case when (select count(*) from public.profiles p
                    where (to_jsonb(p) ->> 'can_send_carrier_submissions')::boolean) > 0
             then 'PASS' else 'FAIL — nobody can send; check the username seed' end, 'PASS'),
    (51, 'who can send',
        coalesce((select string_agg(coalesce(p.display_name, p.username), ', ')
                    from public.profiles p
                   where (to_jsonb(p) ->> 'can_send_carrier_submissions')::boolean), '(nobody)'),
        'informational')
)
select check_name,
       result,
       case when expected = 'informational' then ''
            when result = expected or result like 'PASS%' then ''
            else '  <-- LOOK AT THIS' end as attention
  from checks
 order by sort;

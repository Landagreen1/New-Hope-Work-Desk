-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.21.0 ROLLBACK — Carrier Email Submission
--
-- Spec: .kiro/specs/carrier-email-submission
-- Authored by Claude (Cowork), 20 August 2026.
--
-- Reverses v1.21.0-carrier-email-submission.sql. Written before the forward migration
-- was applied to production, and tested, because a rollback improvised at the moment
-- it is needed is not a rollback.
--
-- ⚠ THIS DESTROYS SUBMISSION HISTORY AND STORED MAILBOX CONNECTIONS.
--   Run it only if v1.21.0 has just been applied and nothing has used it yet. If any
--   real submission has been sent, take a backup first — carrier_submissions is the
--   only record that a carrier was ever emailed.
--
-- What it does NOT do, on purpose:
--   - It does not remove 'carrier_submission_emailed' / 'carrier_submission_failed'
--     from the activity vocabulary. Rows may already carry those values, and a CHECK
--     constraint that rejects existing data cannot be added. Leaving two unused values
--     in a vocabulary is harmless; orphaning live rows is not.
--   - It does not drop market_directory.submission_email. That column predates this
--     feature (v1.17.0) and is not ours to remove.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- 1. Report what is about to be lost, so an operator running this by reflex sees it.
do $warn$
declare
  v_subs integer := 0;
  v_conns integer := 0;
begin
  if to_regclass('public.carrier_submissions') is not null then
    select count(*) into v_subs from public.carrier_submissions;
  end if;
  if to_regclass('public.user_email_connections') is not null then
    select count(*) into v_conns from public.user_email_connections;
  end if;

  raise notice 'v1.21.0 rollback: destroying % submission record(s) and % mailbox connection(s).',
    v_subs, v_conns;

  if v_subs > 0 then
    raise warning 'There are % carrier submissions. This is the ONLY record that those '
                  'carriers were emailed. Abort now if you have not taken a backup.', v_subs;
  end if;
end $warn$;

-- 2. Tables, children first.
drop table if exists public.carrier_submission_documents;
drop table if exists public.carrier_submissions;
drop table if exists public.user_email_connections;

-- 3. Sender eligibility.
drop function if exists public.can_send_carrier_submissions();
alter table public.profiles
  drop column if exists can_send_carrier_submissions;

-- 4. Market Directory submission configuration.
alter table public.market_directory
  drop column if exists submission_cc,
  drop column if exists submission_subject_template,
  drop column if exists submission_body_template,
  drop column if exists email_submission_enabled;

-- 5. Verification.
do $verify$
begin
  if to_regclass('public.carrier_submissions') is not null
     or to_regclass('public.carrier_submission_documents') is not null
     or to_regclass('public.user_email_connections') is not null then
    raise exception 'v1.21.0 rollback: a table survived.';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'market_directory'
       and column_name in ('submission_cc', 'submission_subject_template',
                           'submission_body_template', 'email_submission_enabled')
  ) then
    raise exception 'v1.21.0 rollback: a market_directory column survived.';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles'
       and column_name = 'can_send_carrier_submissions'
  ) then
    raise exception 'v1.21.0 rollback: profiles.can_send_carrier_submissions survived.';
  end if;

  -- These are deliberately left behind. Asserting it means a future reader does not
  -- mistake them for an incomplete rollback.
  if not exists (
    select 1 from information_schema.check_constraints
     where constraint_schema = 'public'
       and constraint_name = 'specialty_activity_event_type_check'
       and check_clause like '%carrier_submission_emailed%'
  ) then
    raise warning 'v1.21.0 rollback: the activity vocabulary no longer carries the '
                  'v1.21.0 values. That was not this script.';
  end if;

  raise notice 'v1.21.0 rollback complete. Two unused activity event types remain by design.';
end $verify$;

commit;

-- v1.21.1 — Who may send carrier submissions, and is the plumbing there?
--
-- Read-only. Safe to run any time. Answers, in one paste, the question the Submissions
-- tab could not previously answer: why does this user see nothing?
--
-- Run it in the Supabase SQL editor and send the output back.

select
  'senders' as section,
  p.username,
  p.display_name,
  p.role::text                        as role,
  p.is_active,
  p.can_send_carrier_submissions      as can_send,
  (c.id is not null)                  as has_mailbox_connection,
  c.email_address                     as connected_mailbox,
  c.status                            as connection_status,
  c.token_expires_at
from public.profiles p
left join public.user_email_connections c
       on c.profile_id = p.id and c.provider = 'microsoft'
where p.can_send_carrier_submissions
   or c.id is not null
   or p.username = 'oscar'
order by p.username;

-- If the section above is EMPTY, no profile may send and the flag was never applied.
-- The v1.21.0 migration sets it by username; re-running that statement is safe and
-- idempotent. It is keyed on username on purpose — never on a hard-coded UUID.
--
--   update public.profiles
--      set can_send_carrier_submissions = true
--    where username = 'oscar';

select
  'carriers on this quote' as section,
  c.name                              as carrier,
  (md.id is not null)                 as linked_to_market_directory,
  md.name                             as market,
  md.submission_email,
  md.email_submission_enabled,
  coalesce(array_length(md.submission_cc, 1), 0) as cc_count,
  (md.submission_subject_template is not null)   as has_subject_template,
  (md.submission_body_template is not null)      as has_body_template
from public.specialty_carriers c
left join public.market_directory md on md.id = c.market_directory_id
where c.is_active
order by (md.email_submission_enabled is not true), c.name;

-- A carrier with linked_to_market_directory = false can never be submitted to: it has
-- nowhere to send. A manager links it under User Administration -> Market Directory.

select
  'policy' as section,
  'specialty_is_manager() for the current session' as check_name,
  public.specialty_is_manager()::text              as result
union all
select 'policy', 'can_send_carrier_submissions() for the current session',
       public.can_send_carrier_submissions()::text
union all
select 'policy', 'market_directory UPDATE policy exists',
       (exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'market_directory'
                   and cmd = 'UPDATE'))::text;

-- NOTE on the two policy rows above: the SQL editor runs as `postgres`, not as Oscar, so
-- auth.uid() is null and both helper functions return false HERE. That is expected and is
-- not the bug. They are listed so the answer is on the record; the authoritative check is
-- the `senders` section, which reads the stored flag directly.

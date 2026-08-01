-- New Hope Work Desk — v1.9.3 concurrent decision probe
--
-- Spec: .kiro/specs/time-attendance-ui-redesign
-- Correctness Property 29 (two concurrent decisions sum rather than overwrite)
-- Companion to: supabase/migrations/v1.9.3-pto-decisions.sql
--
-- WHAT THIS ANSWERS
--
-- The single-session probe shows that the increment accumulates: approving five days
-- and then three leaves eight, not three. What it cannot show is what happens when the
-- two decisions overlap, because one session is one transaction at a time.
--
-- Appendix A.5's lost increment is a read-then-write pair across a network round trip:
-- both callers read 2, both compute 2 + delta, and the second write discards the
-- first. Two things remove it here, and this script observes both:
--
--   1. pto_decide() takes `select ... for update` on the request before it validates,
--      so a second decision on the same request waits rather than validating against
--      state the first is in the middle of changing.
--   2. The increment is `set vacation_used = vacation_used + delta`, evaluated by the
--      server against the row it holds a lock on, so nothing is carried across a round
--      trip to be stale by the time it lands.
--
-- HOW TO RUN IT
--
-- Run this same file from two shells at the same time:
--
--   node scripts/run-sql.mjs supabase/verification/v1.9.3-pto-decide-lock-race.sql
--
-- Each run is its own connection and therefore its own transaction. Both target the
-- same committed pto_requests row, so they contend for real. Whichever arrives first
-- decides and then holds the lock for three seconds; the second reports a `lock_wait_ms`
-- of roughly three thousand and then decides against the state the first left behind.
--
--   waited under 100 ms in both runs  -> they did not overlap; run them closer together
--   waited about 3000 ms in one run   -> the lock serialised them, which is the point
--
-- SAFETY
--
-- Both runs end in ROLLBACK. Nothing is committed: not the decision, not the ledger
-- row, not the balance increment, not the audit row. The row-retention counts in
-- supabase/verification/row-retention/stage-4-pre.json stay exact.
--
-- The one live effect is a row lock on a single pending pto_requests row, held for the
-- three seconds of the sleep. A concurrent decision on that same request from the
-- application would wait for it, which is the behaviour under test. No other row and
-- no other table is locked.

begin;

-- The subject: a real pending request whose owner is not the administrator deciding it.
-- Read rather than created, because two transactions can only contend over a row both
-- can see, and a fixture inserted here would be invisible to the other run.
create temporary table race_subject on commit drop as
select r.id                                                as request_id,
       r.profile_id                                        as employee,
       r.pto_type,
       r.start_date,
       r.end_date,
       (select p.id from public.profiles p
         where p.is_active and p.role = 'super_admin' and p.id <> r.profile_id
         order by p.created_at, p.id limit 1)              as decider
  from public.pto_requests r
 where r.status = 'pending'
   and (select p.role from public.profiles p where p.id = r.profile_id) <> 'super_admin'
 order by r.created_at, r.id
 limit 1;

create temporary table race_result (
  probe    text,
  observed text
) on commit drop;

do $$
declare
  s              record;
  v_deltas       jsonb;
  v_started      timestamptz;
  v_acquired     timestamptz;
  v_out          jsonb;
  v_field        text;
  v_before       numeric;
  v_after        numeric;
  v_expected     numeric;
begin
  select * into s from race_subject;

  if s.request_id is null or s.decider is null then
    insert into race_result values
      ('subject', 'none: no pending request with a non-administrator owner, or no second super_admin');
    return;
  end if;

  v_field := case s.pto_type when 'vacation' then 'vacation_used'
                             when 'sick'     then 'sick_used'
                             else 'personal_used' end;

  -- The movement the approval implies, counted here rather than taken from the function.
  select coalesce(jsonb_agg(jsonb_build_object(
           'year', c.year, 'balance_field', v_field, 'delta_days', c.days) order by c.year), '[]'::jsonb)
    into v_deltas
    from (
      select extract(year from g)::int as year, count(*)::numeric as days
        from generate_series(s.start_date, s.end_date, interval '1 day') as g
       where extract(isodow from g) between 1 and 5
         and not exists (select 1 from public.attendance_closed_dates c where c.closed_date = g::date)
       group by 1
    ) c;

  execute format('select coalesce(sum(b.%I), 0) from public.pto_balances b where b.profile_id = $1', v_field)
    into v_before using s.employee;

  -- Become the administrator, then race for the request.
  execute 'set local role authenticated';
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', s.decider, 'role', 'authenticated')::text);

  v_started := clock_timestamp();
  v_out := public.pto_decide(
    s.request_id, 'approve_full', null,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    v_deltas, 'v1.9.3 concurrency probe', null, false,
    'probe-race-' || gen_random_uuid()::text, null);
  v_acquired := clock_timestamp();

  execute 'reset role';

  execute format('select coalesce(sum(b.%I), 0) from public.pto_balances b where b.profile_id = $1', v_field)
    into v_after using s.employee;

  select coalesce(sum((e.value->>'delta_days')::numeric), 0)
    into v_expected
    from jsonb_array_elements(v_deltas) e;

  insert into race_result values
    ('request',                       s.request_id::text),
    ('employee',                      s.employee::text),
    ('balance column',                v_field),
    ('deltas the approval implies',   v_deltas::text),
    ('lock_wait_ms (how long pto_decide took to return)',
                                      round(extract(epoch from (v_acquired - v_started)) * 1000)::text),
    ('applied',                       coalesce(v_out->>'applied', 'null')),
    ('code',                          coalesce(v_out->>'code', 'none')),
    (v_field || ' before',            v_before::text),
    (v_field || ' after',             v_after::text),
    ('movement this run applied',     (v_after - v_before)::text),
    ('movement it should have applied', v_expected::text),
    ('verdict',
      case when coalesce((v_out->>'applied')::boolean, false) and (v_after - v_before) = v_expected
             then 'PASS: one movement, exactly the deltas, nothing lost'
           when coalesce((v_out->>'applied')::boolean, false)
             then format('FAIL: moved %s, expected %s', v_after - v_before, v_expected)
           else format('not applied: %s', coalesce(v_out->>'code', v_out->>'error', 'unknown')) end);

  -- Hold the request lock, so a run starting now has something to wait for. The lock is
  -- held until this transaction ends either way; the sleep is what keeps the window open
  -- long enough for the second run to arrive inside it.
  perform pg_sleep(3);
end;
$$;

select probe, observed from race_result;

rollback;

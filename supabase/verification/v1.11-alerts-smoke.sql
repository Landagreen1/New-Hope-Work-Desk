-- Smoke test for v1.11.0 / v1.11.1. Read-only. Safe to re-run.
--
-- 1. manager_sla_alerts() refuses a Sales Agent and answers a Manager.
-- 2. The two alert kinds return the shape the UI expects.
-- 3. profile_can_claim_walk_in() answers correctly for both sides of the rule.

begin;

do $$
declare
  v_manager  uuid;
  v_agent    uuid;
  v_juliana  uuid;
  v_other    uuid;
  v_total    integer;
  v_fast     integer;
  v_unclaim  integer;
  v_refused  boolean := false;
  v_sample   text;
begin
  select id into v_manager from public.profiles where username = 'danielp';
  select id into v_juliana from public.profiles where username = 'julianaa';
  select id into v_agent   from public.profiles where username = 'galo';
  select id into v_other   from public.profiles where username = 'pablo';

  -- ── Walk-in eligibility ──────────────────────────────────────────────────
  if not public.profile_can_claim_walk_in(v_juliana) then
    raise exception 'FAIL: Juliana Abrego is not walk-in eligible';
  end if;
  if public.profile_can_claim_walk_in(v_other) then
    raise exception 'FAIL: an unauthorized agent is walk-in eligible';
  end if;
  if public.profile_can_claim_walk_in(null) then
    raise exception 'FAIL: a null profile is walk-in eligible';
  end if;
  raise notice 'PASS walk-in eligibility. Authorized: %', public.walk_in_claimer_names();

  -- ── Alert visibility: a Sales Agent must be refused ──────────────────────
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_agent, 'role', 'authenticated')::text,
                     true);
  if public.can_view_manager_alerts() then
    raise exception 'FAIL: a Sales Agent can view manager alerts';
  end if;
  begin
    perform * from public.manager_sla_alerts();
  exception when others then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAIL: manager_sla_alerts() did not refuse a Sales Agent';
  end if;
  raise notice 'PASS manager_sla_alerts() refuses a Sales Agent';

  -- ── Alert visibility: a Manager must be allowed ──────────────────────────
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_manager, 'role', 'authenticated')::text,
                     true);
  if not public.can_view_manager_alerts() then
    raise exception 'FAIL: a Manager cannot view manager alerts';
  end if;

  select count(*),
         count(*) filter (where alert_kind = 'fast_price_sent'),
         count(*) filter (where alert_kind = 'unclaimed_personal_intake')
    into v_total, v_fast, v_unclaim
    from public.manager_sla_alerts();

  raise notice 'PASS manager_sla_alerts() for Manager: % total (% fast price, % unclaimed intake)',
               v_total, v_fast, v_unclaim;

  -- Every row must be red, keyed, and carry a non-negative elapsed value.
  if exists (select 1 from public.manager_sla_alerts() a where a.severity <> 'red') then
    raise exception 'FAIL: a non-red row came back from manager_sla_alerts()';
  end if;
  if exists (select 1 from public.manager_sla_alerts() a where a.alert_key is null or a.customer_name is null) then
    raise exception 'FAIL: a row is missing alert_key or customer_name';
  end if;
  if exists (
    select a.alert_key from public.manager_sla_alerts() a
    group by a.alert_key having count(*) > 1
  ) then
    raise exception 'FAIL: duplicate alert_key values';
  end if;
  if exists (
    select 1 from public.manager_sla_alerts() a
    where a.alert_kind = 'fast_price_sent' and a.elapsed_minutes >= 7
  ) then
    raise exception 'FAIL: a fast_price_sent row is not actually under 7 minutes';
  end if;
  if exists (
    select 1 from public.manager_sla_alerts() a
    where a.alert_kind = 'unclaimed_personal_intake' and a.elapsed_minutes < 15
  ) then
    raise exception 'FAIL: an unclaimed_personal_intake row is not actually past 15 minutes';
  end if;
  raise notice 'PASS row-level invariants (all red, unique keys, thresholds respected)';

  select string_agg(
           format('%s | %s | %s min | %s', a.alert_kind, a.customer_name, a.elapsed_minutes, coalesce(a.agent_name, '-')),
           E'\n  ')
    into v_sample
    from (select * from public.manager_sla_alerts() order by occurred_at desc limit 5) a;
  raise notice 'Sample:%', coalesce(E'\n  ' || v_sample, ' (no alerts right now)');

  -- ── Threshold parameters must be honoured ────────────────────────────────
  if (select count(*) from public.manager_sla_alerts(15, 0, 24) where alert_kind = 'fast_price_sent') <> 0 then
    raise exception 'FAIL: a 0-minute price window still returned fast_price_sent rows';
  end if;
  raise notice 'PASS threshold parameters are honoured';

  raise notice 'ALL CHECKS PASSED';
end
$$;

rollback;

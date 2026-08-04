-- New Hope Work Desk v1.11.1 — Manager / Supervisor red SLA alerts
--
-- Two new red (critical) alerts for the Manager alerts panel:
--
--   1. unclaimed_personal_intake
--      A personal-lines Customer Service intake that has been sitting in the
--      Sales Intake Queue for 15 minutes or more without being claimed.
--
--   2. fast_price_sent
--      A quote whose price was sent less than 7 minutes after the quote was
--      created. That is too fast to be a real quote and needs a manager look.
--
-- Both are visible to managers, super admins, and the three scoped supervisor
-- roles only. The role check lives inside the function, so the restriction holds
-- regardless of what the client does.
--
-- Forward-only. Creates three functions and two indexes. Alters no table, drops
-- nothing, and writes no row.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHERE THE TIMESTAMPS COME FROM
-- ─────────────────────────────────────────────────────────────────────────────
--   Alert 1 reads public.cs_intake_submissions:
--     coalesce(submitted_at, created_at)  — when it entered the queue
--     status = 'submitted' and claimed_by is null  — still nobody's
--   `submitted_at` is preferred because a draft can sit unsubmitted for days
--   without being anybody's SLA problem; the clock starts when CS submits.
--
--   Alert 2 reads the two tables that carry BOTH timestamps on the same row:
--     public.pending_pricing_quotes (quote_created_at, price_sent_at)
--       — a quote that has been priced and is awaiting a sold/not-sold decision
--     public.quote_outcomes        (quote_created_at, price_sent_at)
--       — a quote that has already been finalized
--   A quote leaves pending_pricing_quotes when it is finalized, so the two sets
--   are disjoint in practice; the union is de-duplicated on source_work_item_id
--   anyway, preferring the pending row, so a quote can never raise two alerts.
--   public.work_items is not consulted: an active quote has no price_sent_at, so
--   it cannot satisfy this rule.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LOOKBACK
-- ─────────────────────────────────────────────────────────────────────────────
--   Alert 2 is scoped to the last `p_lookback_hours` (default 24) of
--   price_sent_at. Without a window it would return every fast-priced quote ever
--   recorded, which is a report, not an alert. Alert 1 is deliberately NOT
--   windowed: an intake unclaimed for two days is a worse problem than one
--   unclaimed for twenty minutes, not a staler one.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
--   begin;
--     drop function if exists public.manager_sla_alerts(integer, integer, integer);
--     drop function if exists public.is_personal_lines_lob(public.cs_intake_lob);
--     drop function if exists public.can_view_manager_alerts();
--     drop index if exists public.cs_intake_unclaimed_sla_idx;
--     drop index if exists public.quote_outcomes_price_sent_idx;
--   commit;
--   Nothing else reads them, and no data is involved.

begin;

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Who may see these alerts
--
--    Managers and super admins (broad management) plus the three scoped
--    supervisor roles. Sales agents and Customer Service reps must not see them:
--    the alerts are about agent behaviour and queue neglect.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.can_view_manager_alerts()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active
      and role in (
        'manager',
        'super_admin',
        'sales_supervisor',
        'customer_service_supervisor',
        'commercial_supervisor'
      )
  );
$$;

comment on function public.can_view_manager_alerts() is
  'True for managers, super admins, and scoped supervisors. Gates manager_sla_alerts().';

revoke all on function public.can_view_manager_alerts() from public;
grant execute on function public.can_view_manager_alerts() to authenticated;
grant execute on function public.can_view_manager_alerts() to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. What counts as "personal"
--
--    The set is the personal-queue lines accepted by cs_intake_submit MINUS
--    commercial_auto, which the Sales Intake Queue labels "Commercial".
--    homeowners, trucking, and commercial_gl route through
--    cs_intake_submit_commercial and never reach this queue at all.
--    'home', 'general_liability', and 'other' are legacy enum values that
--    cs_intake_submit refuses, so they cannot be submitted and are excluded.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.is_personal_lines_lob(p_lob public.cs_intake_lob)
returns boolean
language sql
immutable
as $$
  select p_lob::text in (
    'auto',
    'personal_auto',
    'non_owners',
    'motorcycle',
    'boat',
    'trailer',
    'renters'
  );
$$;

comment on function public.is_personal_lines_lob(public.cs_intake_lob) is
  'True for the personal-lines Sales Intake Queue lines of business (excludes commercial_auto and the commercial-routed lines).';

grant execute on function public.is_personal_lines_lob(public.cs_intake_lob) to authenticated;
grant execute on function public.is_personal_lines_lob(public.cs_intake_lob) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Supporting indexes
-- ═══════════════════════════════════════════════════════════════════════════════
create index if not exists cs_intake_unclaimed_sla_idx
  on public.cs_intake_submissions (submitted_at)
  where status = 'submitted'::public.cs_intake_status
    and claimed_by is null;

create index if not exists quote_outcomes_price_sent_idx
  on public.quote_outcomes (price_sent_at desc)
  where price_sent_at is not null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. The alert feed
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.manager_sla_alerts(
  p_intake_claim_minutes integer default 15,
  p_fast_price_minutes integer default 7,
  p_lookback_hours integer default 24
)
returns table (
  alert_key text,
  alert_kind text,
  severity text,
  entity_type text,
  entity_id uuid,
  source_work_item_id uuid,
  customer_name text,
  agent_name text,
  detail text,
  elapsed_minutes integer,
  occurred_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
-- The RETURNS TABLE column names (customer_name, detail, occurred_at, ...) are also
-- plpgsql variables in this scope. Without this directive the unqualified
-- `order by occurred_at` below would be rejected as ambiguous under the default
-- plpgsql.variable_conflict = error. Nothing in this body reads an output
-- parameter as a variable, so letting columns win is safe and keeps the query
-- readable.
#variable_conflict use_column
declare
  v_intake_window interval := make_interval(mins => greatest(coalesce(p_intake_claim_minutes, 15), 0));
  v_price_window  interval := make_interval(mins => greatest(coalesce(p_fast_price_minutes, 7), 0));
  v_lookback      interval := make_interval(hours => greatest(coalesce(p_lookback_hours, 24), 1));
begin
  if not public.can_view_manager_alerts() then
    raise exception 'Manager or Supervisor access required to read operational alerts.';
  end if;

  return query
  -- ── Alert 1: personal-lines intake unclaimed past the SLA ──────────────────
  with unclaimed as (
    select
      s.id,
      s.line_of_business,
      s.intake_channel,
      s.is_walk_in,
      s.priority,
      coalesce(s.submitted_at, s.created_at) as queued_at,
      coalesce(
        nullif(btrim(coalesce(s.insured_first_name, '') || ' ' || coalesce(s.insured_last_name, '')), ''),
        nullif(btrim(coalesce(s.business_name, '')), ''),
        'Unnamed customer'
      ) as customer_name
    from public.cs_intake_submissions s
    where s.status = 'submitted'::public.cs_intake_status
      and s.claimed_by is null
      and public.is_personal_lines_lob(s.line_of_business)
      and coalesce(s.submitted_at, s.created_at) <= now() - v_intake_window
  ),
  rc_holder as (
    select p.display_name
    from public.rotation_state r
    join public.profiles p on p.id = r.current_profile_id
    where r.kind = 'ringcentral'::public.rotation_kind
  )
  select
    'unclaimed_personal_intake:' || u.id::text                        as alert_key,
    'unclaimed_personal_intake'                                        as alert_kind,
    'red'                                                              as severity,
    'cs_intake'                                                        as entity_type,
    u.id                                                               as entity_id,
    null::uuid                                                         as source_work_item_id,
    u.customer_name                                                    as customer_name,
    case
      when u.intake_channel = 'ringcentral' then (select display_name from rc_holder)
      else null
    end                                                                as agent_name,
    concat_ws(
      ' · ',
      'Personal ' || replace(u.line_of_business::text, '_', ' '),
      case when u.intake_channel = 'ringcentral' then 'RingCentral queue' else 'Manual' end,
      case when u.is_walk_in then 'WALK-IN' else null end,
      case when u.priority::text <> 'normal' then upper(u.priority::text) else null end
    )                                                                  as detail,
    floor(extract(epoch from (now() - u.queued_at)) / 60)::integer      as elapsed_minutes,
    u.queued_at                                                        as occurred_at
  from unclaimed u

  union all

  -- ── Alert 2: price sent too soon after the quote was created ───────────────
  select
    'fast_price_sent:' || f.source_work_item_id::text                  as alert_key,
    'fast_price_sent'                                                   as alert_kind,
    'red'                                                               as severity,
    'quote'                                                             as entity_type,
    f.id                                                                as entity_id,
    f.source_work_item_id                                               as source_work_item_id,
    f.customer_name                                                     as customer_name,
    coalesce(p.display_name, 'Unknown agent')                           as agent_name,
    concat_ws(
      ' · ',
      case f.stage when 'pending' then 'Price Sent' else 'Finalized' end,
      replace(f.work_type::text, '_', ' '),
      coalesce(nullif(f.received_through, ''), 'Source not recorded')
    )                                                                   as detail,
    floor(extract(epoch from (f.price_sent_at - f.quote_created_at)) / 60)::integer as elapsed_minutes,
    f.price_sent_at                                                     as occurred_at
  from (
    select distinct on (q.source_work_item_id)
      q.id,
      q.source_work_item_id,
      q.customer_name,
      q.assigned_profile_id,
      q.work_type,
      q.received_through,
      q.quote_created_at,
      q.price_sent_at,
      q.stage
    from (
      select
        pp.id,
        pp.source_work_item_id,
        pp.customer_name,
        pp.assigned_profile_id,
        pp.work_type,
        pp.received_through,
        pp.quote_created_at,
        pp.price_sent_at,
        'pending'::text as stage,
        1 as stage_rank
      from public.pending_pricing_quotes pp
      where pp.price_sent_at >= now() - v_lookback
        and pp.price_sent_at - pp.quote_created_at < v_price_window

      union all

      select
        qo.id,
        qo.source_work_item_id,
        qo.customer_name,
        qo.assigned_profile_id,
        qo.work_type,
        qo.received_through,
        qo.quote_created_at,
        qo.price_sent_at,
        'finalized'::text as stage,
        2 as stage_rank
      from public.quote_outcomes qo
      where qo.price_sent_at is not null
        and qo.price_sent_at >= now() - v_lookback
        and qo.price_sent_at - qo.quote_created_at < v_price_window
    ) q
    order by q.source_work_item_id, q.stage_rank
  ) f
  left join public.profiles p on p.id = f.assigned_profile_id

  order by occurred_at desc;
end;
$$;

comment on function public.manager_sla_alerts(integer, integer, integer) is
  'Red operational alerts for managers and supervisors: personal-lines intakes unclaimed past the SLA window (default 15 minutes) and quotes whose price was sent less than the minimum window (default 7 minutes) after creation, within the lookback (default 24 hours).';

revoke all on function public.manager_sla_alerts(integer, integer, integer) from public;
grant execute on function public.manager_sla_alerts(integer, integer, integer) to authenticated;
grant execute on function public.manager_sla_alerts(integer, integer, integer) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Post-conditions
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing text;
begin
  select string_agg(want.name, ', ')
    into v_missing
    from (values
      ('can_view_manager_alerts'),
      ('is_personal_lines_lob'),
      ('manager_sla_alerts')
    ) as want(name)
   where not exists (
     select 1
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = want.name
   );

  if v_missing is not null then
    raise exception 'v1.11.1 is missing function(s): %', v_missing
      using hint = 'Rolling back.';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'cs_intake_unclaimed_sla_idx'
  ) then
    raise exception 'v1.11.1 did not create cs_intake_unclaimed_sla_idx'
      using hint = 'Rolling back.';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'quote_outcomes_price_sent_idx'
  ) then
    raise exception 'v1.11.1 did not create quote_outcomes_price_sent_idx'
      using hint = 'Rolling back.';
  end if;

  -- The gate must be inside the function body, not merely granted around it.
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'manager_sla_alerts'
      and pg_get_functiondef(p.oid) like '%can_view_manager_alerts%'
  ) then
    raise exception 'v1.11.1 installed manager_sla_alerts without its role gate'
      using hint = 'Rolling back.';
  end if;

  raise notice 'v1.11.1 applied. manager_sla_alerts() is available to managers and supervisors.';
end
$post$;

commit;

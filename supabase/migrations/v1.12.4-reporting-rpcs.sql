-- New Hope Work Desk v1.12.4 — reporting read functions
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 3.2, 3.3, 4.1-4.12, 9.1-9.5, 10.7, 11.1-11.7, 12.1, 12.2, 12.7,
--               13.1-13.3, 17.1, 17.4, 17.5, 19.1, 19.3, 19.5, 19.6, 19.8
--
-- Reports become RPCs rather than table reads for one reason: today they have no
-- server-side authorization at all. supabase/schema.sql lines 1027-1055 grant
-- `select ... using (true)` on profiles, dealers, work_items, pending_pricing_quotes,
-- quote_outcomes, and turn_events to every authenticated user, so the only thing
-- stopping an agent reading the whole agency's sales history is the absence of a
-- navigation entry. Authorization has to be added, not relocated.
--
-- Every function checks the caller and returns zero rows rather than raising when the
-- caller is not entitled (Requirement 19.6). A caller who is an active profile but not
-- can_manage_sales() is a Self_Scoped_Reader and sees only quotes in which they hold
-- one of the six credit roles (Requirement 19.3).
--
-- public.can_manage_sales() already exists live and already matches canManageSales in
-- src/lib/permissions.ts: manager, sales_supervisor, super_admin. It is reused here,
-- not recreated.
--
-- ── One filter argument, applied in one place ─────────────────────────────────
--
-- p_filters is jsonb normalized by report_normalize_filters. A composite type would
-- need a migration for every new filter and would change every signature; jsonb lets
-- a filter be added without touching any of them.
--
-- reporting_filtered_quotes applies the DIMENSION filters and the exclusion, and
-- deliberately applies NO date filter. That is what keeps Operational Activity
-- honest: Quotes Received counts by creation date, Pricing Sent by first pricing
-- date, and Sold by finalization date. A single pre-filtered date window would force
-- all three onto one timestamp, which is the mistake the current reportData memo
-- makes and the reason its Efficiency metric mixes denominators.
--
-- ROLLBACK: drop each function created below by name.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. HELPERS
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.reporting_timezone()
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select business_timezone from public.attendance_policy where singleton_key limit 1),
    'America/New_York'
  );
$$;

-- Midnight at the start of a business-timezone calendar day.
-- A window is [reporting_day_start(start), reporting_day_start(end + 1)): the end date
-- is inclusive as a calendar day, and the upper bound is exclusive as an instant. That
-- upper bound is also the Report_End_Instant every as-of-date metric is evaluated at.
create or replace function public.reporting_day_start(p_day date)
returns timestamptz
language sql stable security definer set search_path = public
as $$
  select (p_day::timestamp) at time zone public.reporting_timezone();
$$;

create or replace function public.reporting_uuid_array(p_value jsonb)
returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_agg(v), '[]'::jsonb)
  from jsonb_array_elements_text(
    case when jsonb_typeof(p_value) = 'array' then p_value else '[]'::jsonb end
  ) v
  where v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

create or replace function public.reporting_text_array(p_value jsonb)
returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_agg(btrim(v)), '[]'::jsonb)
  from jsonb_array_elements_text(
    case when jsonb_typeof(p_value) = 'array' then p_value else '[]'::jsonb end
  ) v
  where length(btrim(v)) between 1 and 200;
$$;

create or replace function public.reporting_enum_array(p_value jsonb, p_allowed text[])
returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_agg(v), '[]'::jsonb)
  from jsonb_array_elements_text(
    case when jsonb_typeof(p_value) = 'array' then p_value else '[]'::jsonb end
  ) v
  where v = any(p_allowed);
$$;

-- The caller's profile id when they may read only their own records, else null.
create or replace function public.reporting_self_scope()
returns uuid
language sql stable security definer set search_path = public
as $$
  select case
    when public.can_manage_sales() then null
    else (select p.id from public.profiles p where p.id = auth.uid() and p.is_active)
  end;
$$;

create or replace function public.reporting_can_read()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.can_manage_sales()
     or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active);
$$;

comment on function public.reporting_self_scope() is
  'Null for a Report_Reader_Role, meaning no restriction. Otherwise the caller''s own profile id, which restricts every reporting read to quotes in which that caller holds one of the six credit roles (Requirement 19.3).';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. FILTER NORMALIZATION
--
-- Drops unknown keys, defaults absent values, and validates every closed value set
-- against the same lists src/features/reporting/definitions.ts declares. An
-- unrecognised value is dropped rather than rejected, so a stale shared link degrades
-- to a default instead of erroring (Requirement 9.10).
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.report_normalize_filters(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare
  f         jsonb := case when jsonb_typeof(p_filters) = 'object' then p_filters else '{}'::jsonb end;
  v_mode    text;
  v_segment text;
  v_start   date;
  v_end     date;
  v_swap    date;
  v_dims    jsonb;
  v_today   date := (now() at time zone public.reporting_timezone())::date;
begin
  v_mode := lower(coalesce(f ->> 'mode', 'activity'));
  if v_mode not in ('activity', 'cohort') then v_mode := 'activity'; end if;

  v_segment := lower(coalesce(f ->> 'hours_segment', 'all'));
  if v_segment not in ('all', 'business', 'after', 'sunday') then v_segment := 'all'; end if;

  begin v_start := (f ->> 'start_date')::date; exception when others then v_start := null; end;
  begin v_end   := (f ->> 'end_date')::date;   exception when others then v_end   := null; end;
  v_start := coalesce(v_start, v_today - 6);
  v_end   := coalesce(v_end, v_today);
  if v_end < v_start then
    v_swap := v_start; v_start := v_end; v_end := v_swap;
  end if;

  select coalesce(jsonb_agg(d), '[]'::jsonb) into v_dims
  from jsonb_array_elements_text(
    case when jsonb_typeof(f -> 'after_hours_dimensions') = 'array'
         then f -> 'after_hours_dimensions' else '[]'::jsonb end
  ) d
  where d in ('received', 'worked', 'finalized', 'manual_entry');

  return jsonb_build_object(
    'mode', v_mode,
    'start_date', to_char(v_start, 'YYYY-MM-DD'),
    'end_date', to_char(v_end, 'YYYY-MM-DD'),
    'compare', coalesce(nullif(f ->> 'compare', '')::boolean, false),
    'hours_segment', v_segment,
    'after_hours_dimensions', v_dims,
    'agent_profile_ids',  public.reporting_uuid_array(f -> 'agent_profile_ids'),
    'dealer_ids',         public.reporting_uuid_array(f -> 'dealer_ids'),
    'salesperson_ids',    public.reporting_uuid_array(f -> 'salesperson_ids'),
    'channels',           public.reporting_text_array(f -> 'channels'),
    'quote_kinds',        public.reporting_enum_array(f -> 'quote_kinds',
                            array['new_quote', 'requote']),
    'assignment_methods', public.reporting_enum_array(f -> 'assignment_methods',
                            array['whatsapp_turn','ringcentral_turn','workload_turn','owner',
                                  'update_log','manager_manual','manual_quote','payment_log',
                                  'customer_service','manual_workload']),
    'statuses',           public.reporting_enum_array(f -> 'statuses',
                            array['active','pending_pricing','finalized']),
    'outcomes',           public.reporting_enum_array(f -> 'outcomes',
                            array['sold','not_sold'])
  );
end;
$$;

comment on function public.report_normalize_filters(jsonb) is
  'The one place a reporting filter set is validated. Every read function normalizes before doing anything else, so the drawer and the KPI it was opened from cannot be looking at different filters. Unknown values are dropped, not rejected: a shared link naming a filter this build no longer offers degrades to the default (Requirement 9.10). A reversed date range is swapped rather than returning an empty report.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. FILTERED FACT SETS — dimension filters only, no date filter
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.reporting_filtered_quotes(p_filters jsonb)
returns setof public.reporting_quote_facts
language sql stable security definer set search_path = public
as $$
  with f as (select public.report_normalize_filters(p_filters) as v),
  scope as (select public.reporting_self_scope() as me)
  select q.*
  from public.reporting_quote_facts q, f, scope
  where public.reporting_can_read()
    and not q.is_excluded
    -- Self scope: any of the six credit roles.
    and (scope.me is null
         or scope.me in (q.assigned_profile_id, q.created_by_profile_id,
                         q.claimed_by_profile_id, q.pricing_profile_id,
                         q.outcome_profile_id, q.sales_credit_profile_id))
    and (jsonb_array_length(f.v -> 'agent_profile_ids') = 0
         or q.assigned_profile_id::text in
            (select jsonb_array_elements_text(f.v -> 'agent_profile_ids')))
    and (jsonb_array_length(f.v -> 'dealer_ids') = 0
         or q.dealer_id::text in
            (select jsonb_array_elements_text(f.v -> 'dealer_ids')))
    and (jsonb_array_length(f.v -> 'salesperson_ids') = 0
         or q.salesperson_id::text in
            (select jsonb_array_elements_text(f.v -> 'salesperson_ids')))
    and (jsonb_array_length(f.v -> 'channels') = 0
         or coalesce(q.channel, 'Unknown') in
            (select jsonb_array_elements_text(f.v -> 'channels')))
    and (jsonb_array_length(f.v -> 'quote_kinds') = 0
         or (case when q.is_requote then 'requote' else 'new_quote' end) in
            (select jsonb_array_elements_text(f.v -> 'quote_kinds')))
    and (jsonb_array_length(f.v -> 'assignment_methods') = 0
         or q.assignment_method in
            (select jsonb_array_elements_text(f.v -> 'assignment_methods')))
    and (jsonb_array_length(f.v -> 'statuses') = 0
         or q.lifecycle_stage in
            (select jsonb_array_elements_text(f.v -> 'statuses')))
    and (jsonb_array_length(f.v -> 'outcomes') = 0
         or coalesce(q.final_outcome, '') in
            (select jsonb_array_elements_text(f.v -> 'outcomes')))
    -- Hours segment filters on the creation instant; the four dimensions below give
    -- the finer control.
    and (case f.v ->> 'hours_segment'
           when 'business' then not q.received_after_hours
           when 'after'    then q.received_after_hours
           when 'sunday'   then extract(dow from q.created_at at time zone
                                        public.reporting_timezone()) = 0
           else true
         end)
    -- Any selected dimension satisfies the filter.
    and (jsonb_array_length(f.v -> 'after_hours_dimensions') = 0
         or (
           (f.v -> 'after_hours_dimensions' ? 'received'     and q.received_after_hours)
        or (f.v -> 'after_hours_dimensions' ? 'worked'       and q.worked_after_hours)
        or (f.v -> 'after_hours_dimensions' ? 'finalized'    and q.finalized_after_hours)
        or (f.v -> 'after_hours_dimensions' ? 'manual_entry' and q.manual_entry_after_hours)
         ));
$$;

create or replace function public.reporting_filtered_workloads(p_filters jsonb)
returns setof public.reporting_workload_facts
language sql stable security definer set search_path = public
as $$
  with f as (select public.report_normalize_filters(p_filters) as v),
  scope as (select public.reporting_self_scope() as me)
  select w.*
  from public.reporting_workload_facts w, f, scope
  where public.reporting_can_read()
    and not w.is_excluded
    and (scope.me is null
         or scope.me in (w.agent_profile_id, w.created_by_profile_id))
    and (jsonb_array_length(f.v -> 'agent_profile_ids') = 0
         or w.agent_profile_id::text in
            (select jsonb_array_elements_text(f.v -> 'agent_profile_ids')))
    and (jsonb_array_length(f.v -> 'dealer_ids') = 0
         or w.dealer_id::text in
            (select jsonb_array_elements_text(f.v -> 'dealer_ids')))
    and (jsonb_array_length(f.v -> 'assignment_methods') = 0
         or w.assignment_method in
            (select jsonb_array_elements_text(f.v -> 'assignment_methods')))
    and (case f.v ->> 'hours_segment'
           when 'business' then not w.created_after_hours
           when 'after'    then w.created_after_hours
           when 'sunday'   then extract(dow from w.created_at at time zone
                                        public.reporting_timezone()) = 0
           else true
         end);
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. SUMMARY — the eight KPIs, plus the same eight over the comparison period
--
-- Each metric counts by its own timestamp in activity mode. In cohort mode the whole
-- set is restricted to quotes created in the window and every state is evaluated at
-- the Report_End_Instant. Requirement 3.6: no displayed ratio may take its numerator
-- from one mode and its denominator from the other, which is why the two branches are
-- computed separately rather than sharing a filtered set.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.report_summary(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  f          jsonb;
  v_start    date;
  v_end      date;
  v_days     integer;
  v_current  jsonb;
  v_previous jsonb;
begin
  if not public.reporting_can_read() then
    return jsonb_build_object('authorized', false);
  end if;

  f := public.report_normalize_filters(p_filters);
  v_start := (f ->> 'start_date')::date;
  v_end   := (f ->> 'end_date')::date;
  v_days  := (v_end - v_start) + 1;

  v_current := public.reporting_summary_for_window(f, v_start, v_end);

  if coalesce((f ->> 'compare')::boolean, false) then
    v_previous := public.reporting_summary_for_window(
      f, v_start - v_days, v_start - 1
    );
  end if;

  return jsonb_build_object(
    'authorized', true,
    'mode', f ->> 'mode',
    'start_date', f ->> 'start_date',
    'end_date', f ->> 'end_date',
    'timezone', public.reporting_timezone(),
    'current', v_current,
    'previous', v_previous,
    'compare', coalesce((f ->> 'compare')::boolean, false)
  );
end;
$$;

create or replace function public.reporting_summary_for_window(
  p_filters jsonb, p_start date, p_end date
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_mode        text := p_filters ->> 'mode';
  v_from        timestamptz := public.reporting_day_start(p_start);
  v_to          timestamptz := public.reporting_day_start(p_end + 1);
  v_received    bigint;
  v_pricing     bigint;
  v_pending     bigint;
  v_sold        bigint;
  v_not_sold    bigint;
  v_median      numeric;
begin
  if v_mode = 'cohort' then
    -- Every metric restricted to the cohort, evaluated as of the end instant.
    select
      count(*),
      count(*) filter (where q.first_pricing_sent_at is not null
                         and q.first_pricing_sent_at < v_to),
      count(*) filter (where not (q.final_outcome is not null and q.finalized_at < v_to)
                         and not (q.first_pricing_sent_at is not null
                                  and q.first_pricing_sent_at < v_to)),
      count(*) filter (where q.final_outcome = 'sold'     and q.finalized_at < v_to),
      count(*) filter (where q.final_outcome = 'not_sold' and q.finalized_at < v_to),
      percentile_cont(0.5) within group (
        order by extract(epoch from (q.first_pricing_sent_at - q.created_at)) / 60.0
      ) filter (where q.first_pricing_sent_at is not null and q.first_pricing_sent_at < v_to)
    into v_received, v_pricing, v_pending, v_sold, v_not_sold, v_median
    from public.reporting_filtered_quotes(p_filters) q
    where q.created_at >= v_from and q.created_at < v_to;
  else
    -- Each metric by its own timestamp.
    select
      count(*) filter (where q.created_at >= v_from and q.created_at < v_to),
      count(*) filter (where q.first_pricing_sent_at >= v_from
                         and q.first_pricing_sent_at < v_to),
      count(*) filter (where not (q.final_outcome is not null and q.finalized_at < v_to)
                         and not (q.first_pricing_sent_at is not null
                                  and q.first_pricing_sent_at < v_to)
                         and q.created_at < v_to),
      count(*) filter (where q.final_outcome = 'sold'
                         and q.finalized_at >= v_from and q.finalized_at < v_to),
      count(*) filter (where q.final_outcome = 'not_sold'
                         and q.finalized_at >= v_from and q.finalized_at < v_to),
      percentile_cont(0.5) within group (
        order by extract(epoch from (q.first_pricing_sent_at - q.created_at)) / 60.0
      ) filter (where q.first_pricing_sent_at >= v_from and q.first_pricing_sent_at < v_to)
    into v_received, v_pricing, v_pending, v_sold, v_not_sold, v_median
    from public.reporting_filtered_quotes(p_filters) q;
  end if;

  return jsonb_build_object(
    'quotes_received', v_received,
    'pricing_sent', v_pricing,
    'pending_pricing', v_pending,
    'sold', v_sold,
    'not_sold', v_not_sold,
    'finalized', v_sold + v_not_sold,
    -- Null, not zero. An undefined rate is not a zero rate (Requirement 4.7).
    'conversion_rate', case when (v_sold + v_not_sold) = 0 then null
                            else round((v_sold::numeric / (v_sold + v_not_sold)) * 100, 1) end,
    'quote_to_sale_rate', case when v_received = 0 then null
                               else round((v_sold::numeric / v_received) * 100, 1) end,
    'median_time_to_pricing_minutes', case when v_median is null then null
                                           else round(v_median, 1) end
  );
end;
$$;

comment on function public.reporting_summary_for_window(jsonb, date, date) is
  'The eight KPIs over one window. Called twice by report_summary when comparison is enabled, so the current and previous periods cannot be computed by different code. conversion_rate and quote_to_sale_rate return null rather than zero when their denominators are zero: an undefined rate is not a zero rate.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. LIFECYCLE — the cohort funnel. Cohort mode only, by Requirement 3.4.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.report_lifecycle(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  f        jsonb;
  v_from   timestamptz;
  v_to     timestamptz;
  v_row    record;
begin
  if not public.reporting_can_read() then
    return jsonb_build_object('authorized', false);
  end if;

  f := public.report_normalize_filters(p_filters);
  v_from := public.reporting_day_start((f ->> 'start_date')::date);
  v_to   := public.reporting_day_start(((f ->> 'end_date')::date) + 1);

  select
    count(*)                                                           as received,
    count(*) filter (where q.accepted_at is not null and q.accepted_at < v_to)
                                                                       as accepted,
    count(*) filter (where q.first_pricing_sent_at is not null
                       and q.first_pricing_sent_at < v_to)             as priced,
    count(*) filter (where q.final_outcome is not null and q.finalized_at < v_to)
                                                                       as finalized,
    count(*) filter (where q.final_outcome = 'sold' and q.finalized_at < v_to)
                                                                       as sold,
    count(*) filter (where q.final_outcome = 'not_sold' and q.finalized_at < v_to)
                                                                       as not_sold,
    -- The five states below are mutually exclusive and sum to received.
    count(*) filter (where not (q.final_outcome is not null and q.finalized_at < v_to)
                       and q.first_pricing_sent_at is not null
                       and q.first_pricing_sent_at < v_to)             as awaiting_customer_decision,
    count(*) filter (where not (q.final_outcome is not null and q.finalized_at < v_to)
                       and not (q.first_pricing_sent_at is not null
                                and q.first_pricing_sent_at < v_to)
                       and q.accepted_at is not null and q.accepted_at < v_to)
                                                                       as still_pending_pricing,
    count(*) filter (where not (q.final_outcome is not null and q.finalized_at < v_to)
                       and not (q.first_pricing_sent_at is not null
                                and q.first_pricing_sent_at < v_to)
                       and not (q.accepted_at is not null and q.accepted_at < v_to))
                                                                       as still_active
  into v_row
  from public.reporting_filtered_quotes(f) q
  where q.created_at >= v_from and q.created_at < v_to;

  return jsonb_build_object(
    'authorized', true,
    'mode', 'cohort',
    'received', v_row.received,
    'accepted', v_row.accepted,
    'priced', v_row.priced,
    'finalized', v_row.finalized,
    'sold', v_row.sold,
    'not_sold', v_row.not_sold,
    'awaiting_customer_decision', v_row.awaiting_customer_decision,
    'still_pending_pricing', v_row.still_pending_pricing,
    'still_active', v_row.still_active,
    'states_sum_to_received',
      (v_row.sold + v_row.not_sold + v_row.awaiting_customer_decision
       + v_row.still_pending_pricing + v_row.still_active) = v_row.received
  );
end;
$$;

comment on function public.report_lifecycle(jsonb) is
  'The Quote Cohort funnel. Received, Accepted, Priced and Finalized are cumulative progression counts; sold, not_sold, awaiting_customer_decision, still_pending_pricing and still_active are mutually exclusive states that sum to received. states_sum_to_received is returned so the caller can assert that invariant rather than trust it.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. FILTER OPTIONS — cached by the client, so this is called once per session
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.report_filter_options()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.reporting_can_read() then
    return jsonb_build_object('authorized', false);
  end if;

  return jsonb_build_object(
    'authorized', true,
    'can_manage_sales', public.can_manage_sales(),
    'self_profile_id', public.reporting_self_scope(),
    'agents', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.display_name, 'username', p.username,
               'role', p.role, 'is_active', p.is_active
             ) order by p.display_name), '[]'::jsonb)
      from public.profiles p
      where p.role in ('agent', 'customer_service', 'sales_supervisor', 'manager', 'super_admin')
    ),
    'dealers', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', d.id, 'name', d.name, 'is_active', d.is_active
             ) order by d.name), '[]'::jsonb)
      from public.dealers d
    ),
    -- Salespeople carry their dealer so the client can link the two filters without
    -- a second query (Requirement 9.5).
    'salespeople', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id, 'dealer_id', s.dealer_id, 'name', s.name,
               'is_active', s.is_active
             ) order by s.name), '[]'::jsonb)
      from public.dealer_salespeople s
    ),
    'channels', (
      select coalesce(jsonb_agg(distinct c order by c), '[]'::jsonb)
      from (
        select coalesce(q.channel, 'Unknown') as c from public.reporting_quote_facts q
      ) s
    ),
    'assignment_methods', to_jsonb(array[
      'whatsapp_turn','ringcentral_turn','workload_turn','owner','update_log',
      'manager_manual','manual_quote','payment_log','customer_service','manual_workload']),
    'statuses', to_jsonb(array['active','pending_pricing','finalized']),
    'outcomes', to_jsonb(array['sold','not_sold'])
  );
end;
$$;

commit;

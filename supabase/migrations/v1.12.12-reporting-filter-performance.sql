-- New Hope Work Desk v1.12.12 — fix: the filter function re-parsed its jsonb per row
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 17.1, 17.4, 17.5
-- Fixes: v1.12.4-reporting-rpcs.sql (forward-only; that file is not edited)
--
-- ── The defect ────────────────────────────────────────────────────────────────
--
-- Measured on live data, 4 August 2026, over a seven-day window:
--
--   report_filter_options          70 ms
--   report_summary                6,677 ms
--   report_summary with compare  12,899 ms
--   report_lifecycle              6,467 ms
--   report_needs_attention        7,105 ms
--   report_agent_rows             6,046 ms
--   report_source_rows            5,183 ms
--   report_after_hours_summary   15,582 ms
--
-- The Overview fires six of these at once, so the page took about sixteen seconds.
--
-- The fact views are not the problem. Timed separately:
--
--   reporting_quote_base            10 ms
--   reporting_quote_event_rollup     4 ms
--   reporting_quote_facts           32 ms
--   reporting_is_business_hours   0.045 ms per call
--
-- The cost was entirely in reporting_filtered_quotes. Its WHERE clause held nine
-- predicates shaped like:
--
--     and (jsonb_array_length(f.v -> 'agent_profile_ids') = 0
--          or q.assigned_profile_id::text in
--             (select jsonb_array_elements_text(f.v -> 'agent_profile_ids')))
--
-- Both halves re-parse the jsonb for every candidate row. Nine filters across 1,276
-- quotes is over eleven thousand jsonb expansions per call, and report_after_hours_summary
-- calls the function four times.
--
-- ── The fix ───────────────────────────────────────────────────────────────────
--
-- Expand each filter list into a local array once, before the scan, and compare with
-- `= any(array)`. array_agg over an empty set yields NULL, so `array is null` is the
-- natural "no filter selected" test and no separate length check is needed.
--
-- The timezone is also resolved once rather than per row for the Sunday segment.
--
-- Semantics are unchanged. The verification files assert the same totals afterwards, and
-- the hours segments must still partition the quote set exactly.
--
-- ROLLBACK: re-apply reporting_filtered_quotes and reporting_filtered_workloads from
-- v1.12.4. Correct, and roughly a hundred times slower.

begin;

create or replace function public.reporting_filtered_quotes(p_filters jsonb)
returns setof public.reporting_quote_facts
language plpgsql stable security definer set search_path = public
as $$
declare
  f          jsonb;
  v_me       uuid;
  v_tz       text;
  v_segment  text;
  v_agents   uuid[];
  v_dealers  uuid[];
  v_sales    uuid[];
  v_channels text[];
  v_kinds    text[];
  v_methods  text[];
  v_statuses text[];
  v_outcomes text[];
  v_dim_received  boolean;
  v_dim_worked    boolean;
  v_dim_finalized boolean;
  v_dim_manual    boolean;
  v_any_dim       boolean;
begin
  if not public.reporting_can_read() then
    return;
  end if;

  f         := public.report_normalize_filters(p_filters);
  v_me      := public.reporting_self_scope();
  v_tz      := public.reporting_timezone();
  v_segment := f ->> 'hours_segment';

  -- Each list expanded exactly once. NULL means "no filter on this dimension".
  select array_agg(x::uuid) into v_agents
    from jsonb_array_elements_text(f -> 'agent_profile_ids') x;
  select array_agg(x::uuid) into v_dealers
    from jsonb_array_elements_text(f -> 'dealer_ids') x;
  select array_agg(x::uuid) into v_sales
    from jsonb_array_elements_text(f -> 'salesperson_ids') x;
  select array_agg(x) into v_channels
    from jsonb_array_elements_text(f -> 'channels') x;
  select array_agg(x) into v_kinds
    from jsonb_array_elements_text(f -> 'quote_kinds') x;
  select array_agg(x) into v_methods
    from jsonb_array_elements_text(f -> 'assignment_methods') x;
  select array_agg(x) into v_statuses
    from jsonb_array_elements_text(f -> 'statuses') x;
  select array_agg(x) into v_outcomes
    from jsonb_array_elements_text(f -> 'outcomes') x;

  v_dim_received  := f -> 'after_hours_dimensions' ? 'received';
  v_dim_worked    := f -> 'after_hours_dimensions' ? 'worked';
  v_dim_finalized := f -> 'after_hours_dimensions' ? 'finalized';
  v_dim_manual    := f -> 'after_hours_dimensions' ? 'manual_entry';
  v_any_dim := v_dim_received or v_dim_worked or v_dim_finalized or v_dim_manual;

  return query
  select q.*
  from public.reporting_quote_facts q
  where not q.is_excluded
    -- Self scope: any of the six credit roles.
    and (v_me is null
         or v_me in (q.assigned_profile_id, q.created_by_profile_id,
                     q.claimed_by_profile_id, q.pricing_profile_id,
                     q.outcome_profile_id, q.sales_credit_profile_id))
    and (v_agents   is null or q.assigned_profile_id = any(v_agents))
    and (v_dealers  is null or q.dealer_id           = any(v_dealers))
    and (v_sales    is null or q.salesperson_id      = any(v_sales))
    and (v_channels is null or coalesce(q.channel, 'Unknown') = any(v_channels))
    and (v_kinds    is null
         or (case when q.is_requote then 'requote' else 'new_quote' end) = any(v_kinds))
    and (v_methods  is null or q.assignment_method = any(v_methods))
    and (v_statuses is null or q.lifecycle_stage   = any(v_statuses))
    and (v_outcomes is null or coalesce(q.final_outcome, '') = any(v_outcomes))
    -- The hours segment filters on the creation instant; the four dimensions below give
    -- the finer control.
    and (case v_segment
           when 'business' then not q.received_after_hours
           when 'after'    then q.received_after_hours
           when 'sunday'   then extract(dow from q.created_at at time zone v_tz) = 0
           else true
         end)
    -- Any selected dimension satisfies the filter.
    and (not v_any_dim
         or ((v_dim_received  and q.received_after_hours)
          or (v_dim_worked    and q.worked_after_hours)
          or (v_dim_finalized and q.finalized_after_hours)
          or (v_dim_manual    and q.manual_entry_after_hours)));
end;
$$;

comment on function public.reporting_filtered_quotes(jsonb) is
  'Every dimension filter applied in one place, with no date filter. Each filter list is expanded into a local array once rather than re-parsed from jsonb per row: the previous version cost about 4 seconds per call because nine predicates each re-expanded their jsonb array for every candidate quote. No date filter here on purpose — Quotes Received counts by creation, Pricing Sent by first pricing, Sold by finalization, and a single pre-filtered window would force all three onto one timestamp.';

create or replace function public.reporting_filtered_workloads(p_filters jsonb)
returns setof public.reporting_workload_facts
language plpgsql stable security definer set search_path = public
as $$
declare
  f         jsonb;
  v_me      uuid;
  v_tz      text;
  v_segment text;
  v_agents  uuid[];
  v_dealers uuid[];
  v_methods text[];
begin
  if not public.reporting_can_read() then
    return;
  end if;

  f         := public.report_normalize_filters(p_filters);
  v_me      := public.reporting_self_scope();
  v_tz      := public.reporting_timezone();
  v_segment := f ->> 'hours_segment';

  select array_agg(x::uuid) into v_agents
    from jsonb_array_elements_text(f -> 'agent_profile_ids') x;
  select array_agg(x::uuid) into v_dealers
    from jsonb_array_elements_text(f -> 'dealer_ids') x;
  select array_agg(x) into v_methods
    from jsonb_array_elements_text(f -> 'assignment_methods') x;

  return query
  select w.*
  from public.reporting_workload_facts w
  where not w.is_excluded
    and (v_me is null or v_me in (w.agent_profile_id, w.created_by_profile_id))
    and (v_agents  is null or w.agent_profile_id  = any(v_agents))
    and (v_dealers is null or w.dealer_id         = any(v_dealers))
    and (v_methods is null or w.assignment_method = any(v_methods))
    and (case v_segment
           when 'business' then not w.created_after_hours
           when 'after'    then w.created_after_hours
           when 'sunday'   then extract(dow from w.created_at at time zone v_tz) = 0
           else true
         end);
end;
$$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.16.8 — Specialty Quotes: the Work screen could not load
--
-- Requires v1.16.7. Forward-only.
--
-- WHAT THIS FIXES
--
--   `specialty_search_opportunities` raised 42804, "structure of query does not
--   match function result type", on every call — so the Work and Quotes screens
--   showed an error instead of a list.
--
--   The cause: `specialty_opportunity_rows` exposes `mc_number` as
--   `character varying(20)`, inherited straight from
--   `cs_intake_submissions.mc_number`, while the function declares `mc_number text`
--   in its RETURNS TABLE. Postgres compares the tuple descriptor by type OID, and
--   varchar (1043) is not text (25), so `return query` refuses the whole result set.
--   Nothing about the row's contents was wrong; the declaration and the view simply
--   disagreed about a type.
--
--   `sold_premium` is numeric(12,2) against a declared `numeric`, which is fine —
--   the type modifier differs but the OID does not. `mc_number` was the only genuine
--   mismatch, and it is now cast to text in the view so the two agree at the source
--   rather than in each caller.
--
--   The view has to be dropped and recreated because `create or replace view` cannot
--   change a column's type. No catalog dependency is lost: the specialty functions
--   reference the view from inside their bodies, which Postgres resolves at execution.
--
-- WHY THIS WAS NOT CAUGHT EARLIER
--
--   v1.16.3 created these read functions and its post-conditions only checked that
--   they *existed* and were `security definer`. A function whose body never runs can
--   be catalogued perfectly and still be unable to return a row. This migration
--   therefore ends by EXECUTING every specialty read and report function as a real
--   team member, which is the check that should have been there from the start.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
--   The view's column list and order, and every function signature. `mc_number` is
--   still `mc_number`, still in the same position, and is still typed `string | null`
--   in TypeScript — text and varchar are indistinguishable over PostgREST.
--
-- ROLLBACK
--   Re-apply the view definition from v1.16.3 section 1. It is broken, so there is no
--   reason to.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

drop view if exists public.specialty_opportunity_rows;

create view public.specialty_opportunity_rows as
select
  o.id,
  o.reference,
  o.line_of_business,
  o.team_id,
  t.name                                              as team_name,
  o.workflow_template_id,
  o.stage,
  coalesce(ws.label, initcap(replace(o.stage, '_', ' '))) as stage_label,
  ws.position                                         as stage_position,
  o.priority,
  o.display_name,
  o.primary_assignee_id,
  assignee.display_name                               as assignee_name,
  assignee.initials                                   as assignee_initials,
  o.next_action,
  o.next_action_due,
  o.result,
  o.lost_reason,
  o.lost_reason_note,
  o.sold_premium,
  o.bound_carrier_id,
  bound.name                                          as bound_carrier_name,
  o.source,
  o.source_intake_id,
  o.legacy_commercial_quote_id,
  o.created_at,
  o.claimed_at,
  o.ready_to_market_at,
  o.first_submission_at,
  o.first_quote_at,
  o.price_sent_at,
  o.finalized_at,
  o.last_activity_at,
  o.created_by,
  creator.display_name                                as created_by_name,
  o.version,

  -- Customer and risk facts, READ from the intake rather than stored again
  -- (spec section 20). A legacy-adopted opportunity has no intake, so these are
  -- null and the card falls back to display_name.
  s.status::text                                      as intake_status,
  s.insured_phone_primary                             as customer_phone,
  s.insured_email                                     as customer_email,
  s.addr_city                                         as customer_city,
  s.addr_state                                        as customer_state,
  nullif(btrim(s.business_name), '')                  as business_name,
  s.dot_number,
  -- Cast to text. The underlying column is varchar(20), and every read function
  -- declares this as text; a RETURNS TABLE mismatch on the type OID is what broke the
  -- Work screen in v1.16.3.
  s.mc_number::text                                   as mc_number,
  nullif(btrim(concat_ws(', ',
    s.property_address_street, s.property_address_city,
    concat_ws(' ', s.property_address_state, s.property_address_zip))), '') as property_address,
  s.created_by                                        as intake_created_by,
  intaker.display_name                                as intake_created_by_name,
  s.submitted_at                                      as intake_submitted_at,
  s.version                                           as intake_version,

  -- Carrier progress, as the summary a card shows: "3/5 submitted, 2 quotes".
  coalesce(cm.markets_total, 0)                       as markets_total,
  coalesce(cm.markets_submitted, 0)                   as markets_submitted,
  coalesce(cm.markets_quoted, 0)                      as markets_quoted,
  coalesce(cm.markets_declined, 0)                    as markets_declined,
  coalesce(cm.markets_waiting, 0)                     as markets_waiting,
  coalesce(cm.markets_info_needed, 0)                 as markets_info_needed,
  cm.best_premium,
  cm.next_carrier_follow_up,

  coalesce(ir.open_information_count, 0)              as open_information_count,
  ir.open_information_labels,
  coalesce(ck.checklist_total, 0)                     as checklist_total,
  coalesce(ck.checklist_done, 0)                      as checklist_done,
  coalesce(nc.notes_count, 0)                         as notes_count,
  coalesce(dc.documents_count, 0)                     as documents_count,

  -- Prioritisation. Terminal stages are never overdue: a sold quote does not need
  -- chasing (spec section 65).
  (o.stage not in ('sold', 'not_sold')
     and o.next_action_due is not null
     and o.next_action_due < now())                   as is_overdue,
  (o.stage not in ('sold', 'not_sold')
     and o.next_action_due is not null
     and o.next_action_due >= date_trunc('day', now())
     and o.next_action_due < date_trunc('day', now()) + interval '1 day') as is_due_today,
  (o.primary_assignee_id is null
     and o.stage not in ('sold', 'not_sold'))         as is_unclaimed,
  (o.stage not in ('sold', 'not_sold')
     and o.last_activity_at < now() - interval '7 days') as is_stale,

  lower(concat_ws(' ',
    o.display_name, o.reference,
    s.insured_first_name, s.insured_middle_name, s.insured_last_name,
    s.business_name, s.insured_email,
    s.dot_number, s.mc_number,
    s.addr_street, s.addr_city, s.addr_state, s.addr_zip,
    s.property_address_street, s.property_address_city,
    s.property_address_state, s.property_address_zip,
    o.id::text, s.id::text, cm.carrier_names
  ))                                                  as search_blob,
  public.nhwd_digits(s.insured_phone_primary)         as phone_digits,
  public.nhwd_digits(s.insured_phone_alt)             as phone_alt_digits,
  cm.carrier_names

from public.specialty_opportunities o
join public.quoting_teams t on t.id = o.team_id
left join public.specialty_workflow_stages ws
       on ws.template_id = o.workflow_template_id and ws.stage_key = o.stage
left join public.cs_intake_submissions s on s.id = o.source_intake_id
left join public.profiles assignee on assignee.id = o.primary_assignee_id
left join public.profiles creator on creator.id = o.created_by
left join public.profiles intaker on intaker.id = s.created_by
left join public.specialty_carriers bound on bound.id = o.bound_carrier_id
left join lateral (
  select
    count(*)                                                             as markets_total,
    count(*) filter (where m.submitted_at is not null)                   as markets_submitted,
    count(*) filter (where m.status = 'quote_received')                   as markets_quoted,
    count(*) filter (where m.status in ('declined', 'not_competitive'))   as markets_declined,
    count(*) filter (where m.status in ('submitted', 'waiting'))          as markets_waiting,
    count(*) filter (where m.status = 'more_info_needed')                 as markets_info_needed,
    min(m.premium) filter (where m.status = 'quote_received')             as best_premium,
    min(m.follow_up_date) filter (
      where m.status in ('submitted', 'waiting', 'more_info_needed'))     as next_carrier_follow_up,
    string_agg(distinct c.name, ' ')                                      as carrier_names
  from public.specialty_carrier_markets m
  join public.specialty_carriers c on c.id = m.carrier_id
  where m.opportunity_id = o.id
) cm on true
left join lateral (
  select count(*) as open_information_count,
         string_agg(r.label, ', ' order by r.created_at) as open_information_labels
  from public.specialty_information_requests r
  where r.opportunity_id = o.id and r.status in ('needed', 'requested')
) ir on true
left join lateral (
  select count(*) as checklist_total,
         count(*) filter (where i.is_checked) as checklist_done
  from public.specialty_checklist_items i
  where i.opportunity_id = o.id
) ck on true
left join lateral (
  select count(*) as notes_count from public.specialty_notes n where n.opportunity_id = o.id
) nc on true
left join lateral (
  select count(*) as documents_count from public.specialty_documents dd where dd.opportunity_id = o.id
) dc on true;

comment on view public.specialty_opportunity_rows is
  'One row per specialty opportunity with its carrier roll-up, outstanding information, checklist progress and prioritisation flags. Customer and risk facts are joined from the linked CS intake rather than duplicated. Read only through the security definer functions, which apply the team boundary. Every column''s type must match the RETURNS TABLE declarations of those functions by type OID, not merely by shape — see v1.16.8.';

revoke all on public.specialty_opportunity_rows from authenticated, anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- POST-CONDITIONS — every read and report function is EXECUTED, not merely checked
-- for existence. A catalogued function whose body has never run can still be unable
-- to return a row, which is exactly what shipped in v1.16.3.
-- ═══════════════════════════════════════════════════════════════════════════════

do $post$
declare
  v_member uuid;
  v_opportunity uuid;
  v_count integer;
begin
  if has_table_privilege('authenticated', 'public.specialty_opportunity_rows', 'select') then
    raise exception 'v1.16.8 left specialty_opportunity_rows readable by authenticated'
      using hint = 'Rolling back.';
  end if;

  -- The column the whole migration is about.
  if (select format_type(a.atttypid, a.atttypmod)
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'specialty_opportunity_rows'
         and a.attname = 'mc_number') <> 'text' then
    raise exception 'v1.16.8 did not make specialty_opportunity_rows.mc_number text'
      using hint = 'Rolling back.';
  end if;

  -- Nothing else on the view may be a varchar either, for the same reason.
  if exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'specialty_opportunity_rows'
      and a.attnum > 0 and not a.attisdropped
      and format_type(a.atttypid, a.atttypmod) like 'character varying%'
  ) then
    raise exception 'v1.16.8 left a varchar column on specialty_opportunity_rows; every read function declares text'
      using hint = 'Rolling back.';
  end if;

  select o.id, (
      select m.profile_id
      from public.quoting_team_members m
      join public.profiles p on p.id = m.profile_id
      where m.team_id = o.team_id and m.is_active and m.can_view and p.is_active
      order by m.added_at limit 1)
    into v_opportunity, v_member
  from public.specialty_opportunities o
  order by o.created_at limit 1;

  if v_member is null then
    -- Impersonating a manager still exercises every body.
    select p.id into v_member from public.profiles p
     where p.is_active and p.role::text in ('manager', 'super_admin')
     order by p.display_name limit 1;
  end if;

  if v_member is null then
    raise exception 'v1.16.8 found nobody to execute the read functions as'
      using hint = 'Rolling back.';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_member::text, 'role', 'authenticated')::text, true);

  -- The one that was broken.
  select count(*) into v_count from public.specialty_search_opportunities();
  raise notice 'v1.16.8: search returned % row(s).', v_count;

  select count(*) into v_count from public.specialty_stage_counts();
  raise notice 'v1.16.8: stage counts returned % bucket(s).', v_count;

  perform public.specialty_workspace_context();

  if v_opportunity is not null then
    perform public.specialty_opportunity_detail(v_opportunity);
    select count(*) into v_count from public.specialty_activity_timeline(v_opportunity);
    raise notice 'v1.16.8: timeline returned % entry(ies).', v_count;
  end if;

  -- Every report, executed. Any RETURNS TABLE mismatch raises 42804 here.
  select count(*) into v_count from public.specialty_report_pipeline();
  select count(*) into v_count from public.specialty_report_workload();
  select count(*) into v_count from public.specialty_report_contributions();
  select count(*) into v_count from public.specialty_report_timing();
  select count(*) into v_count from public.specialty_report_carrier_performance();
  select count(*) into v_count from public.specialty_report_lost_business();
  select count(*) into v_count from public.specialty_report_attention();
  raise notice 'v1.16.8: all seven reports executed.';

  -- Quote Center still reads, with the specialty overlay intact.
  select count(*) into v_count from public.quote_center_search();
  raise notice 'v1.16.8: quote_center_search returned % row(s).', v_count;

  perform set_config('request.jwt.claims', '', true);
end
$post$;

commit;

select
  (select format_type(a.atttypid, a.atttypmod)
     from pg_attribute a join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'specialty_opportunity_rows'
      and a.attname = 'mc_number') as mc_number_expect_text,
  (select count(*) from public.specialty_opportunity_rows) as rows_readable;

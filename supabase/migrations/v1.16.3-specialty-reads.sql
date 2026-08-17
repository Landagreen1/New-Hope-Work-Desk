-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.16.3 — Specialty Quotes: reads, search and the detail payload
--
-- Spec: sections 53-66, 92.
-- Requires v1.16.2.
--
-- WHAT THIS CHANGES
--   One row-shaping view and the security definer read functions over it. Search,
--   filtering, paging, stage counts and carrier roll-ups all happen in SQL, so the
--   browser never holds more than a page (spec section 92) and the counts on the
--   filter chips cannot disagree with the rows in the list.
--
--   The view is revoked from `authenticated`: every read goes through a function
--   that applies the team boundary, so crafting a different query from the browser
--   does not get past it.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
--   Nothing outside the specialty namespace. No commercial view, function or report.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE ROW SHAPE
--
--    Everything a summary card must make obvious (spec section 59) plus the
--    prioritisation signals (65), computed once. Carrier progress is a roll-up here
--    rather than five rows in the browser, which is what keeps a list of many
--    quotes from becoming an N+1 (92).
-- ═══════════════════════════════════════════════════════════════════════════════

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
  s.mc_number,
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
  'One row per specialty opportunity with its carrier roll-up, outstanding information, checklist progress and prioritisation flags. Customer and risk facts are joined from the linked CS intake rather than duplicated. Read only through the security definer functions below, which apply the team boundary.';

revoke all on public.specialty_opportunity_rows from authenticated, anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. SEARCH  (spec sections 54, 56-59, 65, 66, 92)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_search_opportunities(
  p_query text default null,
  p_line_of_business text default 'all',
  p_stage text default 'all',
  p_assignee uuid default null,
  -- 'team' is the default on purpose: the team works together, so a member lands on
  -- all of the team's work and narrows to their own by choice (spec section 54).
  p_view text default 'team',
  p_carrier_id uuid default null,
  p_result text default 'all',
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  reference text,
  line_of_business text,
  team_id uuid,
  team_name text,
  stage text,
  stage_label text,
  priority text,
  display_name text,
  business_name text,
  primary_assignee_id uuid,
  assignee_name text,
  assignee_initials text,
  next_action text,
  next_action_due timestamptz,
  result text,
  lost_reason text,
  sold_premium numeric,
  bound_carrier_name text,
  source text,
  source_intake_id uuid,
  legacy_commercial_quote_id uuid,
  customer_phone text,
  customer_city text,
  customer_state text,
  dot_number text,
  mc_number text,
  property_address text,
  created_at timestamptz,
  claimed_at timestamptz,
  price_sent_at timestamptz,
  finalized_at timestamptz,
  last_activity_at timestamptz,
  markets_total bigint,
  markets_submitted bigint,
  markets_quoted bigint,
  markets_declined bigint,
  markets_waiting bigint,
  markets_info_needed bigint,
  best_premium numeric,
  next_carrier_follow_up date,
  open_information_count bigint,
  open_information_labels text,
  checklist_total bigint,
  checklist_done bigint,
  notes_count bigint,
  documents_count bigint,
  is_overdue boolean,
  is_due_today boolean,
  is_unclaimed boolean,
  is_stale boolean,
  version integer,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_text   text    := nullif(btrim(coalesce(p_query, '')), '');
  v_like   text;
  v_digits text;
  v_lob    text    := lower(coalesce(nullif(btrim(p_line_of_business), ''), 'all'));
  v_stage  text    := lower(coalesce(nullif(btrim(p_stage), ''), 'all'));
  v_view   text    := lower(coalesce(nullif(btrim(p_view), ''), 'team'));
  v_result text    := lower(coalesce(nullif(btrim(p_result), ''), 'all'));
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not public.specialty_can_access() then
    raise exception 'Specialty Quotes is not available for your account.' using errcode = '42501';
  end if;

  if v_view not in ('team', 'mine', 'unclaimed', 'due_today', 'overdue', 'stale', 'closed') then
    v_view := 'team';
  end if;

  v_like   := public.nhwd_like_pattern(lower(v_text));
  v_digits := public.nhwd_digits(v_text);
  if length(v_digits) < 7 then v_digits := null; end if;

  return query
  with visible as (
    select r.*
    from public.specialty_opportunity_rows r
    -- The team boundary. A Homeowners-only member sees no trucking row here, so
    -- there is nothing for a crafted filter to reveal (spec sections 55, 86).
    where public.specialty_can_view_opportunity(r.id)
      and (v_lob = 'all' or r.line_of_business = v_lob)
      and (v_stage = 'all' or r.stage = v_stage)
      and (p_assignee is null or r.primary_assignee_id = p_assignee)
      and (p_carrier_id is null or exists (
            select 1 from public.specialty_carrier_markets m
            where m.opportunity_id = r.id and m.carrier_id = p_carrier_id))
      and (v_result = 'all' or coalesce(r.result, 'open') = v_result)
      and (
        case v_view
          when 'mine'      then r.primary_assignee_id = auth.uid()
          when 'unclaimed' then r.is_unclaimed
          when 'due_today' then r.is_due_today
          when 'overdue'   then r.is_overdue
          when 'stale'     then r.is_stale
          when 'closed'    then r.result is not null
          -- 'team': everything the team is working, closed work excluded unless the
          -- reader asked for a stage or result that includes it.
          else (r.result is null or v_stage <> 'all' or v_result <> 'all')
        end
      )
      and (
        v_text is null
        or r.search_blob like v_like escape '\'
        or (v_digits is not null and (
              r.phone_digits like '%' || v_digits || '%'
              or r.phone_alt_digits like '%' || v_digits || '%'))
        or exists (
              select 1 from public.cs_intake_vehicles v
              where v.submission_id = r.source_intake_id
                and upper(v.vin) like upper(public.nhwd_like_pattern(v_text)) escape '\')
      )
  ),
  counted as (select v.*, count(*) over () as total_count from visible v)
  select
    c.id, c.reference, c.line_of_business, c.team_id, c.team_name,
    c.stage, c.stage_label, c.priority, c.display_name, c.business_name,
    c.primary_assignee_id, c.assignee_name, c.assignee_initials,
    c.next_action, c.next_action_due,
    c.result, c.lost_reason, c.sold_premium, c.bound_carrier_name,
    c.source, c.source_intake_id, c.legacy_commercial_quote_id,
    c.customer_phone, c.customer_city, c.customer_state,
    c.dot_number, c.mc_number, c.property_address,
    c.created_at, c.claimed_at, c.price_sent_at, c.finalized_at, c.last_activity_at,
    c.markets_total, c.markets_submitted, c.markets_quoted, c.markets_declined,
    c.markets_waiting, c.markets_info_needed, c.best_premium, c.next_carrier_follow_up,
    c.open_information_count, c.open_information_labels,
    c.checklist_total, c.checklist_done, c.notes_count, c.documents_count,
    c.is_overdue, c.is_due_today, c.is_unclaimed, c.is_stale,
    c.version, c.total_count
  from counted c
  -- Urgent work first, then whatever moved most recently.
  order by
    c.is_overdue desc,
    c.is_unclaimed desc,
    case c.priority when 'urgent' then 0 when 'high' then 1 else 2 end,
    c.next_action_due asc nulls last,
    c.last_activity_at desc
  limit v_limit
  offset v_offset;
end;
$fn$;

revoke execute on function public.specialty_search_opportunities(text, text, text, uuid, text, uuid, text, integer, integer) from public, anon;
grant execute on function public.specialty_search_opportunities(text, text, text, uuid, text, uuid, text, integer, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. COUNTS — stage chips and the work-prioritisation strip
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_stage_counts(
  p_query text default null,
  p_line_of_business text default 'all',
  p_assignee uuid default null
)
returns table (bucket text, kind text, count bigint)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_text   text := nullif(btrim(coalesce(p_query, '')), '');
  v_like   text;
  v_digits text;
  v_lob    text := lower(coalesce(nullif(btrim(p_line_of_business), ''), 'all'));
begin
  if not public.specialty_can_access() then
    raise exception 'Specialty Quotes is not available for your account.' using errcode = '42501';
  end if;

  v_like   := public.nhwd_like_pattern(lower(v_text));
  v_digits := public.nhwd_digits(v_text);
  if length(v_digits) < 7 then v_digits := null; end if;

  return query
  with visible as (
    select r.*
    from public.specialty_opportunity_rows r
    where public.specialty_can_view_opportunity(r.id)
      and (v_lob = 'all' or r.line_of_business = v_lob)
      and (p_assignee is null or r.primary_assignee_id = p_assignee)
      and (
        v_text is null
        or r.search_blob like v_like escape '\'
        or (v_digits is not null and (
              r.phone_digits like '%' || v_digits || '%'
              or r.phone_alt_digits like '%' || v_digits || '%'))
      )
  )
  select v.stage, 'stage'::text, count(*)::bigint from visible v group by v.stage
  union all
  select v.line_of_business, 'lob'::text, count(*)::bigint from visible v group by v.line_of_business
  union all
  select b.bucket, 'attention'::text, b.count
  from (
    select 'unclaimed'::text as bucket, count(*) filter (where v.is_unclaimed)::bigint as count from visible v
    union all select 'overdue',   count(*) filter (where v.is_overdue)::bigint   from visible v
    union all select 'due_today', count(*) filter (where v.is_due_today)::bigint from visible v
    union all select 'stale',     count(*) filter (where v.is_stale)::bigint     from visible v
    union all select 'mine',      count(*) filter (where v.primary_assignee_id = auth.uid()
                                                     and v.result is null)::bigint from visible v
    union all select 'active',    count(*) filter (where v.result is null)::bigint from visible v
    union all select 'waiting_on_carrier',
                                 count(*) filter (where v.markets_waiting > 0
                                                     and v.result is null)::bigint from visible v
    union all select 'options_not_sent',
                                 count(*) filter (where v.markets_quoted > 0
                                                     and v.price_sent_at is null
                                                     and v.result is null)::bigint from visible v
  ) b;
end;
$fn$;

revoke execute on function public.specialty_stage_counts(text, text, uuid) from public, anon;
grant execute on function public.specialty_stage_counts(text, text, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. DETAIL — one payload for the whole drawer
--
--    One round trip rather than seven, because the drawer is opened while a
--    customer is on the phone. Returned as jsonb so a new child collection does not
--    need a new RETURNS TABLE signature.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_opportunity_detail(p_opportunity_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_row public.specialty_opportunity_rows;
  v_result jsonb;
begin
  if not public.specialty_can_view_opportunity(p_opportunity_id) then
    raise exception 'That specialty quote is not available for your account.' using errcode = '42501';
  end if;

  select * into v_row from public.specialty_opportunity_rows where id = p_opportunity_id;
  if not found then raise exception 'That specialty quote could not be found.'; end if;

  select jsonb_build_object(
    'opportunity', to_jsonb(v_row) - 'search_blob' - 'phone_digits' - 'phone_alt_digits' - 'carrier_names',
    'can_edit', public.specialty_can_edit_opportunity(p_opportunity_id),
    'can_reassign', public.specialty_can_reassign_opportunity(p_opportunity_id),
    'is_manager', public.specialty_is_manager(),

    'carrier_markets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'carrier_id', m.carrier_id, 'carrier_name', c.name,
        'status', m.status,
        'handled_by', m.handled_by, 'handled_by_name', handler.display_name,
        'submitted_at', m.submitted_at, 'submitted_by', m.submitted_by,
        'submitted_by_name', submitter.display_name,
        'last_action_at', m.last_action_at, 'last_action_by_name', actor.display_name,
        'follow_up_date', m.follow_up_date,
        'premium', m.premium, 'down_payment', m.down_payment,
        'payment_terms', m.payment_terms, 'deductible', m.deductible,
        'coverage_notes', m.coverage_notes,
        'quote_received_at', m.quote_received_at,
        'quote_received_by_name', receiver.display_name,
        'decline_reason', m.decline_reason, 'info_requested', m.info_requested,
        'notes', m.notes, 'presented_at', m.presented_at,
        'document_count', (select count(*) from public.specialty_documents d
                            where d.carrier_market_id = m.id),
        'version', m.version
      ) order by
        case m.status when 'quote_received' then 0 when 'more_info_needed' then 1
                      when 'waiting' then 2 when 'submitted' then 3 when 'preparing' then 4
                      when 'not_started' then 5 when 'not_competitive' then 6
                      when 'declined' then 7 else 8 end,
        m.premium nulls last, c.name)
      from public.specialty_carrier_markets m
      join public.specialty_carriers c on c.id = m.carrier_id
      left join public.profiles handler on handler.id = m.handled_by
      left join public.profiles submitter on submitter.id = m.submitted_by
      left join public.profiles receiver on receiver.id = m.quote_received_by
      left join public.profiles actor on actor.id = m.last_action_by
      where m.opportunity_id = p_opportunity_id
    ), '[]'::jsonb),

    'checklist', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'category', i.category, 'label', i.label, 'position', i.position,
        'is_required', i.is_required, 'is_custom', i.is_custom,
        'is_checked', i.is_checked, 'checked_at', i.checked_at,
        'checked_by_name', checker.display_name
      ) order by i.position, i.label)
      from public.specialty_checklist_items i
      left join public.profiles checker on checker.id = i.checked_by
      where i.opportunity_id = p_opportunity_id
    ), '[]'::jsonb),

    'information_requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'label', r.label, 'status', r.status, 'note', r.note,
        'visible_to_cs', r.visible_to_cs,
        'requested_at', r.requested_at, 'requested_by_name', requester.display_name,
        'resolved_at', r.resolved_at, 'resolved_by_name', resolver.display_name
      ) order by
        case r.status when 'needed' then 0 when 'requested' then 1 else 2 end,
        r.created_at)
      from public.specialty_information_requests r
      left join public.profiles requester on requester.id = r.requested_by
      left join public.profiles resolver on resolver.id = r.resolved_by
      where r.opportunity_id = p_opportunity_id
    ), '[]'::jsonb),

    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'content', n.content, 'created_at', n.created_at,
        'author_id', n.author_id, 'author_name', author.display_name,
        'author_initials', author.initials,
        'carrier_market_id', n.carrier_market_id, 'is_cs_visible', n.is_cs_visible
      ) order by n.created_at desc)
      from public.specialty_notes n
      left join public.profiles author on author.id = n.author_id
      where n.opportunity_id = p_opportunity_id
    ), '[]'::jsonb),

    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'file_name', d.file_name, 'file_size', d.file_size,
        'mime_type', d.mime_type, 'category', d.category,
        'storage_bucket', d.storage_bucket, 'storage_path', d.storage_path,
        'carrier_market_id', d.carrier_market_id,
        'uploaded_by', d.uploaded_by, 'uploaded_by_name', uploader.display_name,
        'created_at', d.created_at,
        'is_legacy', d.storage_bucket <> 'specialty-quote-documents'
      ) order by d.created_at desc)
      from public.specialty_documents d
      left join public.profiles uploader on uploader.id = d.uploaded_by
      where d.opportunity_id = p_opportunity_id
    ), '[]'::jsonb),

    'price_presentations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pp.id, 'presented_at', pp.presented_at, 'method', pp.method,
        'note', pp.note, 'options', pp.options,
        'presented_by', pp.presented_by, 'presented_by_name', presenter.display_name
      ) order by pp.presented_at desc)
      from public.specialty_price_presentations pp
      left join public.profiles presenter on presenter.id = pp.presented_by
      where pp.opportunity_id = p_opportunity_id
    ), '[]'::jsonb),

    -- Contributors, derived from what people actually did rather than from who is
    -- assigned (spec section 12). The primary assignee appears here only if they
    -- have in fact done something.
    'contributors', coalesce((
      select jsonb_agg(x order by x ->> 'display_name')
      from (
        select jsonb_build_object(
          'profile_id', a.actor_profile_id,
          'display_name', p.display_name,
          'initials', p.initials,
          'action_count', count(*),
          'last_action_at', max(a.created_at),
          'is_primary_assignee', a.actor_profile_id = v_row.primary_assignee_id
        ) as x
        from public.specialty_activity a
        join public.profiles p on p.id = a.actor_profile_id
        where a.opportunity_id = p_opportunity_id
          and a.actor_profile_id is not null
        group by a.actor_profile_id, p.display_name, p.initials
      ) contributors
    ), '[]'::jsonb),

    -- The linked intake, read live. The specialty side keeps no second copy.
    'intake', (
      select jsonb_build_object(
        'id', s.id, 'status', s.status::text, 'line_of_business', s.line_of_business::text,
        'version', s.version,
        'insured_first_name', s.insured_first_name,
        'insured_middle_name', s.insured_middle_name,
        'insured_last_name', s.insured_last_name,
        'insured_dob', s.insured_dob,
        'insured_email', s.insured_email,
        'insured_phone_primary', s.insured_phone_primary,
        'insured_phone_alt', s.insured_phone_alt,
        'preferred_language', s.preferred_language,
        'preferred_contact', s.preferred_contact,
        'addr_street', s.addr_street, 'addr_unit', s.addr_unit,
        'addr_city', s.addr_city, 'addr_state', s.addr_state, 'addr_zip', s.addr_zip,
        'current_carrier', s.current_carrier,
        'current_policy_number', s.current_policy_number,
        'current_premium', s.current_premium,
        'current_expiration', s.current_expiration,
        'prior_insurance', s.prior_insurance, 'prior_lapse', s.prior_lapse,
        'csr_notes', s.csr_notes,
        'business_name', s.business_name, 'business_type', s.business_type,
        'years_in_business', s.years_in_business,
        'dot_number', s.dot_number, 'mc_number', s.mc_number,
        'mcs150_date', s.mcs150_date, 'cargo_type', s.cargo_type,
        'power_unit_count', s.power_unit_count,
        'operating_radius_miles', s.operating_radius_miles,
        'states_of_operation', s.states_of_operation,
        'property_address_street', s.property_address_street,
        'property_address_city', s.property_address_city,
        'property_address_state', s.property_address_state,
        'property_address_zip', s.property_address_zip,
        'dwelling_type', s.dwelling_type, 'year_built', s.year_built,
        'square_footage', s.square_footage, 'roof_type', s.roof_type,
        'roof_age', s.roof_age, 'coverage_amount', s.coverage_amount,
        'prior_claims', s.prior_claims, 'prior_claims_detail', s.prior_claims_detail,
        'desired_coverage', s.desired_coverage, 'liability_limit', s.liability_limit,
        'comprehensive_deductible', s.comprehensive_deductible,
        'collision_deductible', s.collision_deductible,
        'created_by_name', ic.display_name,
        'submitted_at', s.submitted_at,
        'drivers', coalesce((
          select jsonb_agg(to_jsonb(dr) order by dr.position)
          from public.cs_intake_drivers dr where dr.submission_id = s.id), '[]'::jsonb),
        'vehicles', coalesce((
          select jsonb_agg(to_jsonb(ve) order by ve.position)
          from public.cs_intake_vehicles ve where ve.submission_id = s.id), '[]'::jsonb),
        'owners', coalesce((
          select jsonb_agg(to_jsonb(ow) order by ow.position)
          from public.cs_intake_owners ow where ow.submission_id = s.id), '[]'::jsonb)
      )
      from public.cs_intake_submissions s
      left join public.profiles ic on ic.id = s.created_by
      where s.id = v_row.source_intake_id
    ),

    'workflow_stages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'stage_key', w.stage_key, 'label', w.label, 'position', w.position,
        'requires_next_action', w.requires_next_action, 'is_terminal', w.is_terminal
      ) order by w.position)
      from public.specialty_workflow_stages w
      where w.template_id = v_row.workflow_template_id
    ), '[]'::jsonb),

    'assignable_members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id', p.id, 'display_name', p.display_name, 'initials', p.initials
      ) order by p.display_name)
      from public.quoting_team_members m
      join public.profiles p on p.id = m.profile_id
      where m.team_id = v_row.team_id and m.is_active and m.can_be_assigned and p.is_active
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$fn$;

revoke execute on function public.specialty_opportunity_detail(uuid) from public, anon;
grant execute on function public.specialty_opportunity_detail(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. ACTIVITY TIMELINE  (spec section 49)
--
--    Lazy: the list never pays for it. Merges the specialty timeline with the linked
--    intake's own event log, so "intake received" and "CS added the loss runs" show
--    up in the same chronology as the carrier work.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_activity_timeline(
  p_opportunity_id uuid,
  p_limit integer default 200
)
returns table (
  occurred_at timestamptz,
  origin text,
  event_type text,
  actor_name text,
  actor_initials text,
  carrier_market_id uuid,
  detail jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_intake uuid;
begin
  if not public.specialty_can_view_opportunity(p_opportunity_id) then
    raise exception 'That specialty quote is not available for your account.' using errcode = '42501';
  end if;

  select source_intake_id into v_intake
  from public.specialty_opportunities where id = p_opportunity_id;

  return query
  select a.created_at, 'specialty'::text, a.event_type,
         coalesce(p.display_name, 'System')::text, coalesce(p.initials, '—')::text,
         a.carrier_market_id, a.detail
  from public.specialty_activity a
  left join public.profiles p on p.id = a.actor_profile_id
  where a.opportunity_id = p_opportunity_id

  union all

  select e.created_at, 'intake'::text, e.event_type,
         coalesce(p.display_name, 'System')::text, coalesce(p.initials, '—')::text,
         null::uuid, e.detail
  from public.cs_intake_events e
  left join public.profiles p on p.id = e.actor_id
  where v_intake is not null and e.submission_id = v_intake

  union all

  select n.created_at, 'note'::text, 'note_added'::text,
         coalesce(p.display_name, 'System')::text, coalesce(p.initials, '—')::text,
         n.carrier_market_id, jsonb_build_object('note', n.content, 'cs_visible', n.is_cs_visible)
  from public.specialty_notes n
  left join public.profiles p on p.id = n.author_id
  where n.opportunity_id = p_opportunity_id

  order by 1 desc
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end;
$fn$;

revoke execute on function public.specialty_activity_timeline(uuid, integer) from public, anon;
grant execute on function public.specialty_activity_timeline(uuid, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. WORKSPACE BOOTSTRAP — what the module needs before its first search
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_workspace_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not public.specialty_can_access() then
    raise exception 'Specialty Quotes is not available for your account.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'is_manager', public.specialty_is_manager(),
    'can_view_reports', public.specialty_can_view_reports(),
    -- Only the lines this user may actually work. A filter is never offered for a
    -- line the reader has no access to (spec section 56).
    'lines_of_business', coalesce((
      select jsonb_agg(distinct jsonb_build_object(
        'line_of_business', r.line_of_business,
        'team_id', r.team_id,
        'team_name', t.name
      ))
      from public.quoting_team_lob_routes r
      join public.quoting_teams t on t.id = r.team_id
      where r.is_active and t.is_active
        and public.specialty_can_view_lob(r.line_of_business)
    ), '[]'::jsonb),
    'my_teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'team_id', t.id, 'team_name', t.name,
        'assignment_method', t.assignment_method,
        'collaborative_editing', t.collaborative_editing,
        'can_view', m.can_view, 'can_claim', m.can_claim, 'can_edit', m.can_edit,
        'can_be_assigned', m.can_be_assigned, 'can_reassign', m.can_reassign,
        'can_view_reports', m.can_view_reports
      ) order by t.name)
      from public.quoting_team_members m
      join public.quoting_teams t on t.id = m.team_id
      where m.profile_id = auth.uid() and m.is_active and t.is_active
    ), '[]'::jsonb),
    'teammates', coalesce((
      select jsonb_agg(distinct jsonb_build_object(
        'profile_id', p.id, 'display_name', p.display_name, 'initials', p.initials))
      from public.quoting_team_members m
      join public.profiles p on p.id = m.profile_id
      where m.is_active and p.is_active
        and (public.specialty_is_manager() or m.team_id in (
              select m2.team_id from public.quoting_team_members m2
              where m2.profile_id = auth.uid() and m2.is_active))
    ), '[]'::jsonb),
    'carriers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'lines_of_business', c.lines_of_business) order by c.name)
      from public.specialty_carriers c where c.is_active
    ), '[]'::jsonb)
  );
end;
$fn$;

revoke execute on function public.specialty_workspace_context() from public, anon;
grant execute on function public.specialty_workspace_context() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. TEAM ADMINISTRATION READ  (spec section 67)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_teams_admin()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not public.specialty_is_manager() then
    raise exception 'Only a manager can configure quoting teams.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'description', t.description,
        'is_active', t.is_active, 'assignment_method', t.assignment_method,
        'collaborative_editing', t.collaborative_editing,
        'team_visibility', t.team_visibility,
        'created_at', t.created_at,
        'lines_of_business', coalesce((
          select jsonb_agg(r.line_of_business order by r.line_of_business)
          from public.quoting_team_lob_routes r
          where r.team_id = t.id and r.is_active), '[]'::jsonb),
        'active_opportunity_count', (
          select count(*) from public.specialty_opportunities o
          where o.team_id = t.id and o.stage not in ('sold', 'not_sold')),
        'members', coalesce((
          select jsonb_agg(jsonb_build_object(
            'profile_id', p.id, 'display_name', p.display_name,
            'initials', p.initials, 'role', p.role::text,
            'can_view', m.can_view, 'can_claim', m.can_claim, 'can_edit', m.can_edit,
            'can_be_assigned', m.can_be_assigned, 'can_reassign', m.can_reassign,
            'can_view_reports', m.can_view_reports,
            'is_active', m.is_active, 'added_at', m.added_at,
            'removed_at', m.removed_at, 'removed_reason', m.removed_reason,
            'active_assignment_count', (
              select count(*) from public.specialty_opportunities o
              where o.team_id = t.id and o.primary_assignee_id = p.id
                and o.stage not in ('sold', 'not_sold'))
          ) order by m.is_active desc, p.display_name)
          from public.quoting_team_members m
          join public.profiles p on p.id = m.profile_id
          where m.team_id = t.id), '[]'::jsonb)
      ) order by t.is_active desc, t.name)
      from public.quoting_teams t
    ), '[]'::jsonb),
    'routes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'line_of_business', r.line_of_business, 'team_id', r.team_id,
        'team_name', t.name, 'workflow_template_id', r.workflow_template_id,
        'is_active', r.is_active) order by r.line_of_business)
      from public.quoting_team_lob_routes r
      join public.quoting_teams t on t.id = r.team_id
      where r.is_active
    ), '[]'::jsonb),
    'templates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', w.id, 'template_key', w.template_key, 'name', w.name,
        'line_of_business', w.line_of_business, 'is_active', w.is_active) order by w.name)
      from public.specialty_workflow_templates w
    ), '[]'::jsonb),
    'assignable_profiles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id', p.id, 'display_name', p.display_name,
        'initials', p.initials, 'role', p.role::text) order by p.display_name)
      from public.profiles p where p.is_active
    ), '[]'::jsonb)
  );
end;
$fn$;

revoke execute on function public.specialty_teams_admin() from public, anon;
grant execute on function public.specialty_teams_admin() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════

do $post$
declare
  v_missing text;
begin
  if not exists (select 1 from pg_views where schemaname = 'public'
                  and viewname = 'specialty_opportunity_rows') then
    raise exception 'v1.16.3 did not create specialty_opportunity_rows' using hint = 'Rolling back.';
  end if;

  -- The view must not be directly readable, or the team boundary could be skipped.
  if has_table_privilege('authenticated', 'public.specialty_opportunity_rows', 'select') then
    raise exception 'v1.16.3 left specialty_opportunity_rows readable by authenticated'
      using hint = 'Rolling back.';
  end if;

  select string_agg(f.name, ', ' order by f.name) into v_missing
    from (values ('specialty_search_opportunities'), ('specialty_stage_counts'),
                 ('specialty_opportunity_detail'), ('specialty_activity_timeline'),
                 ('specialty_workspace_context'), ('specialty_teams_admin')) as f(name)
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = f.name and p.prosecdef);
  if v_missing is not null then
    raise exception 'v1.16.3 missing read function(s): %', v_missing using hint = 'Rolling back.';
  end if;
end
$post$;

commit;

select
  (select count(*) from pg_views where schemaname = 'public' and viewname = 'specialty_opportunity_rows') as view_expect_1,
  (select count(*) from public.specialty_opportunity_rows) as rows_expect_0;

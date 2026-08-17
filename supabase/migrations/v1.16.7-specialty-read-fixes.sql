-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.16.7 — Specialty Quotes: two read functions that could not run
--
-- Requires v1.16.4. Forward-only: v1.16.3 and v1.16.4 are already deployed and are
-- not edited.
--
-- WHAT THIS FIXES
--
--   1. `specialty_opportunity_detail` raised 54023, "cannot pass more than 100
--      arguments to a function", for any opportunity with a linked CS intake. The
--      intake payload was one `jsonb_build_object` with 56 key/value pairs — 112
--      arguments — and Postgres caps a function call at 100. Every specialty quote
--      created from an intake is in that case, so the detail drawer failed to open
--      for all of them. The payload is now built in three chunks and concatenated,
--      which produces a byte-identical object.
--
--   2. `specialty_report_contributions` raised 42702, "column reference
--      profile_id is ambiguous". A `RETURNS TABLE` column is also a PL/pgSQL
--      variable, and the CTE exposed a column of the same name, so
--      `select distinct profile_id from acted` could not be resolved. The whole
--      Contribution report failed. Every CTE column is now named so that it cannot
--      collide with an output parameter.
--
--   Both were found by src/features/specialty/__tests__/specialty-workflow.integration.test.ts
--   on its first run against the project. Neither is reachable by a unit test: the
--   argument cap and the variable/column collision are both properties of the
--   database, not of the SQL text.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
--   The returned shape of either function. The detail payload has the same keys in
--   the same order, and the report has the same columns in the same order, so no
--   TypeScript type changes.
--
-- ROLLBACK
--   Re-apply the definitions from v1.16.3 section 4 and v1.16.4 section 3. Both are
--   broken, so there is no reason to.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. specialty_opportunity_detail
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
    --
    -- Built in three chunks and concatenated because `jsonb_build_object` is a
    -- function call and Postgres caps a call at 100 arguments; 56 key/value pairs is
    -- 112. Concatenation produces the same object, and grouping the chunks by subject
    -- — customer, business and risk, trucking and property — also makes the payload
    -- readable.
    'intake', (
      select
        jsonb_build_object(
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
          'created_by_name', ic.display_name,
          'submitted_at', s.submitted_at
        )
        || jsonb_build_object(
          'current_carrier', s.current_carrier,
          'current_policy_number', s.current_policy_number,
          'current_premium', s.current_premium,
          'current_expiration', s.current_expiration,
          'prior_insurance', s.prior_insurance, 'prior_lapse', s.prior_lapse,
          'csr_notes', s.csr_notes,
          'desired_coverage', s.desired_coverage, 'liability_limit', s.liability_limit,
          'comprehensive_deductible', s.comprehensive_deductible,
          'collision_deductible', s.collision_deductible,
          'business_name', s.business_name, 'business_type', s.business_type,
          'years_in_business', s.years_in_business,
          'dot_number', s.dot_number, 'mc_number', s.mc_number,
          'mcs150_date', s.mcs150_date, 'cargo_type', s.cargo_type,
          'power_unit_count', s.power_unit_count,
          'operating_radius_miles', s.operating_radius_miles,
          'states_of_operation', s.states_of_operation
        )
        || jsonb_build_object(
          'property_address_street', s.property_address_street,
          'property_address_city', s.property_address_city,
          'property_address_state', s.property_address_state,
          'property_address_zip', s.property_address_zip,
          'dwelling_type', s.dwelling_type, 'year_built', s.year_built,
          'square_footage', s.square_footage, 'roof_type', s.roof_type,
          'roof_age', s.roof_age, 'coverage_amount', s.coverage_amount,
          'prior_claims', s.prior_claims, 'prior_claims_detail', s.prior_claims_detail,
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

comment on function public.specialty_opportunity_detail(uuid) is
  'Everything the specialty detail drawer needs, in one round trip. The intake payload is assembled from three concatenated jsonb objects because a single jsonb_build_object would exceed Postgres''s 100-argument call limit (fixed in v1.16.7).';

revoke execute on function public.specialty_opportunity_detail(uuid) from public, anon;
grant execute on function public.specialty_opportunity_detail(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. specialty_report_contributions
--
--    Every CTE column is renamed away from the output-parameter names. A RETURNS
--    TABLE column is a PL/pgSQL variable inside the body, so a CTE column of the
--    same name is genuinely ambiguous and Postgres refuses rather than guessing.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_report_contributions(
  p_from date default null,
  p_to date default null,
  p_line_of_business text default 'all'
)
returns table (
  profile_id uuid,
  display_name text,
  initials text,
  primary_count bigint,
  contributed_count bigint,
  carrier_submissions bigint,
  carrier_quotes_recorded bigint,
  price_sent_actions bigint,
  notes_added bigint,
  information_requests bigint,
  results_recorded bigint,
  total_actions bigint,
  last_action_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_lob text := lower(coalesce(nullif(btrim(p_line_of_business), ''), 'all'));
begin
  if not public.specialty_can_view_reports() then
    raise exception 'Specialty reporting is not available for your account.' using errcode = '42501';
  end if;

  return query
  with visible as (
    select o.id as opp_id, o.primary_assignee_id as assignee_id
    from public.specialty_opportunities o
    where public.specialty_can_view_opportunity(o.id)
      and (v_lob = 'all' or o.line_of_business = v_lob)
  ),
  acted as (
    select a.actor_profile_id as actor_id,
           a.opportunity_id   as opp_id,
           a.event_type       as evt,
           a.created_at       as acted_at
    from public.specialty_activity a
    join visible v on v.opp_id = a.opportunity_id
    where a.actor_profile_id is not null
      and (p_from is null or a.created_at >= p_from::timestamptz)
      and (p_to is null or a.created_at < (p_to + 1)::timestamptz)
  ),
  -- Everyone who did something, plus everyone who holds an assignment. Somebody who
  -- has been handed a quote and not yet touched it belongs in the report with zeros
  -- rather than being absent from it.
  people as (
    select ac.actor_id as person_id from acted ac
    union
    select vi.assignee_id from visible vi where vi.assignee_id is not null
  ),
  tallied as (
    select
      pp.person_id,
      (select count(*) from visible vi
        where vi.assignee_id = pp.person_id)::bigint                       as primary_ct,
      (select count(distinct ac.opp_id) from acted ac
        where ac.actor_id = pp.person_id)::bigint                          as contributed_ct,
      (select count(*) from acted ac
        where ac.actor_id = pp.person_id and ac.evt = 'carrier_submitted')::bigint      as submissions_ct,
      (select count(*) from acted ac
        where ac.actor_id = pp.person_id and ac.evt = 'carrier_quote_received')::bigint as quotes_ct,
      (select count(*) from acted ac
        where ac.actor_id = pp.person_id and ac.evt = 'price_sent')::bigint             as price_ct,
      (select count(*) from acted ac
        where ac.actor_id = pp.person_id and ac.evt = 'note_added')::bigint             as notes_ct,
      (select count(*) from acted ac
        where ac.actor_id = pp.person_id
          and ac.evt in ('information_requested', 'information_received',
                         'information_waived'))::bigint                                as info_ct,
      (select count(*) from acted ac
        where ac.actor_id = pp.person_id and ac.evt = 'result_recorded')::bigint        as results_ct,
      (select count(*) from acted ac
        where ac.actor_id = pp.person_id)::bigint                                      as total_ct,
      (select max(ac.acted_at) from acted ac where ac.actor_id = pp.person_id)         as last_at
    from people pp
  )
  select
    t.person_id,
    pr.display_name,
    pr.initials,
    t.primary_ct,
    t.contributed_ct,
    t.submissions_ct,
    t.quotes_ct,
    t.price_ct,
    t.notes_ct,
    t.info_ct,
    t.results_ct,
    t.total_ct,
    t.last_at
  from tallied t
  join public.profiles pr on pr.id = t.person_id
  order by t.total_ct desc, pr.display_name;
end;
$fn$;

comment on function public.specialty_report_contributions(date, date, text) is
  'Who actually did the work, counted from public.specialty_activity rather than inferred from the assignment: a carrier submission made on a teammate''s quote is credited to whoever made it. primary_count and contributed_count are separate columns because they answer different questions. Spec sections 12, 73.';

revoke execute on function public.specialty_report_contributions(date, date, text) from public, anon;
grant execute on function public.specialty_report_contributions(date, date, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. POST-CONDITIONS
--    Both functions are executed, not merely redefined, because a syntactically valid
--    body was exactly the problem last time.
-- ═══════════════════════════════════════════════════════════════════════════════

do $post$
declare
  v_payload jsonb;
  v_opportunity uuid;
  v_member uuid;
  v_rows integer;
begin
  -- Any opportunity with a linked intake exercises the argument-count path.
  select o.id, (
      select m.profile_id
      from public.quoting_team_members m
      join public.profiles p on p.id = m.profile_id
      where m.team_id = o.team_id and m.is_active and m.can_view and p.is_active
      order by m.added_at
      limit 1)
    into v_opportunity, v_member
  from public.specialty_opportunities o
  where o.source_intake_id is not null
  order by o.created_at
  limit 1;

  if v_opportunity is null or v_member is null then
    raise notice 'v1.16.7: no intake-linked opportunity with a member to probe as; both fixes are covered by the integration suite instead.';
  else
    -- Both functions gate on auth.uid(), and a migration has none. Impersonating a real
    -- member is what lets the post-condition reach the SQL that was broken: the
    -- 100-argument error and the ambiguous column were both raised while planning the
    -- body, which happens after the gate.
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_member::text, 'role', 'authenticated')::text, true);

    v_payload := public.specialty_opportunity_detail(v_opportunity);
    if v_payload is null or v_payload -> 'intake' is null then
      raise exception 'v1.16.7 specialty_opportunity_detail returned no intake payload'
        using hint = 'Rolling back.';
    end if;
    -- One key from each of the three chunks, so a dropped chunk is caught.
    if not (v_payload -> 'intake' ? 'insured_first_name'
            and v_payload -> 'intake' ? 'dot_number'
            and v_payload -> 'intake' ? 'roof_age'
            and v_payload -> 'intake' ? 'vehicles') then
      raise exception 'v1.16.7 specialty_opportunity_detail lost intake keys while chunking'
        using hint = 'Rolling back.';
    end if;
    if jsonb_typeof(v_payload -> 'contributors') <> 'array' then
      raise exception 'v1.16.7 specialty_opportunity_detail returned no contributors array'
        using hint = 'Rolling back.';
    end if;

    begin
      select count(*) into v_rows from public.specialty_report_contributions();
      raise notice 'v1.16.7: contribution report ran and returned % row(s).', v_rows;
    exception
      when sqlstate '42702' then
        raise exception 'v1.16.7 did not fix the ambiguous column in specialty_report_contributions'
          using hint = 'Rolling back.';
    end;

    perform set_config('request.jwt.claims', '', true);
  end if;
end
$post$;

commit;

select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'specialty_opportunity_detail') as detail_expect_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'specialty_report_contributions') as contributions_expect_1;

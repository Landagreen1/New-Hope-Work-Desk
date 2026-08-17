-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.16.5 — Specialty Quotes: intake routing and Quote Center integration
--
-- Spec: sections 8, 9, 21, 22, 23, 80, 81, 82.
-- Requires v1.16.4.
--
-- WHAT THIS CHANGES
--   1. `cs_intake_submit_specialty` — a submitted Trucking or Homeowners intake now
--      becomes a Specialty Quote Opportunity owned by the routed team, with its
--      template checklist seeded, nobody assigned, and every eligible member
--      notified. Customer Service does not pick a person.
--   2. Trucking and Homeowners can no longer reach the Commercial Board. Two
--      independent guards, because one path is not enough: the RPC's line-of-
--      business whitelist is narrowed to commercial_gl, and a trigger on
--      commercial_quotes refuses a trucking or homeowners card outright while an
--      active specialty route exists. That is what makes "no duplicate live
--      destinations" (spec section 80) true regardless of which code path is used.
--   3. The stale one-argument `cs_intake_submit_commercial(uuid)` overload is
--      dropped. It ignored the assignee and silently picked the first manager.
--   4. `quote_center_journeys` learns about specialty work, so a customer handed to
--      the Specialty Team keeps a truthful status in Quote Center instead of
--      reading "On Commercial Board" or "Quote Removed" (spec section 81).
--   5. Two Customer Service callback actions: see what information is outstanding
--      and supply it, without recreating the intake (spec section 82).
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
--   * `commercial_gl` routing. It still goes to the Commercial Board through the
--     same RPC, with the same card, checklist, activity log and column history.
--   * No rotation is read or written. Specialty intakes have never consumed a turn
--     and still do not; `cs_intake_submit_commercial` stays in the non-consuming
--     family and `cs_intake_submit_specialty` joins it.
--   * `cs_intake_submit` (the personal-queue path) is untouched.
--
-- ROLLBACK
--   Restore cs_intake_submit_commercial from v1.8.3, drop
--   specialty_block_legacy_specialty_cards trigger, drop the specialty CS
--   functions, and re-apply the v1.15.2 definition of quote_center_journeys.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE SPECIALTY SUBMIT PATH  (spec sections 8, 21)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.cs_intake_submit_specialty(p_submission_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cs_intake_submissions%rowtype;
  v_route public.quoting_team_lob_routes;
  v_existing uuid;
  v_opportunity uuid;
  v_display text;
  v_caller_role text;
  v_seeded integer;
  v_member record;
begin
  select * into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then raise exception 'Intake not found.'; end if;

  -- Idempotent. A double-submitted form, or a retried request, returns the
  -- opportunity that already exists rather than creating a second one.
  select id into v_existing
  from public.specialty_opportunities
  where source_intake_id = p_submission_id;
  if v_existing is not null then
    return v_existing;
  end if;

  v_caller_role := public.nhwd_role();
  if v_row.created_by <> auth.uid() and v_caller_role not in ('manager', 'super_admin') then
    raise exception 'You cannot submit this intake.';
  end if;

  if v_row.status::text not in ('draft', 'returned') then
    raise exception 'Only Draft or Returned intakes can be submitted.';
  end if;

  -- Routing is configuration: the line of business decides the team, and if nobody
  -- has been configured to receive this line the submission is refused with a
  -- useful message rather than creating orphaned work.
  select r.* into v_route
  from public.quoting_team_lob_routes r
  join public.quoting_teams t on t.id = r.team_id
  where r.line_of_business = v_row.line_of_business::text
    and r.is_active and r.is_default and t.is_active
  limit 1;

  if not found then
    raise exception 'No active quoting team is configured to receive % intakes. A manager sets this under Quoting Teams.',
      replace(v_row.line_of_business::text, '_', ' ');
  end if;

  -- The same validation Customer Service already knows, so switching the
  -- destination does not change what the form asks for.
  if nullif(btrim(v_row.insured_first_name), '') is null
     or nullif(btrim(v_row.insured_last_name), '') is null
     or nullif(btrim(v_row.insured_phone_primary), '') is null then
    raise exception 'Insured name and phone are required.';
  end if;

  if v_row.line_of_business::text = 'trucking' then
    if nullif(btrim(v_row.business_name), '') is null then
      raise exception 'Business name is required for Trucking.';
    end if;
    if nullif(btrim(v_row.dot_number), '') is null then
      raise exception 'DOT number is required for Trucking.';
    end if;
  end if;

  if v_row.line_of_business::text = 'homeowners' then
    if nullif(btrim(v_row.property_address_street), '') is null then
      raise exception 'Property address is required for Homeowners.';
    end if;
  end if;

  v_display := coalesce(
    nullif(btrim(v_row.business_name), ''),
    nullif(btrim(concat_ws(' ', v_row.insured_first_name, v_row.insured_last_name)), ''),
    'Unnamed'
  );

  insert into public.specialty_opportunities (
    line_of_business, workflow_template_id, team_id,
    source_intake_id, source, display_name,
    -- Unclaimed on purpose. Every eligible member sees it and one of them claims it
    -- (spec sections 8, 15). Customer Service never names a person.
    primary_assignee_id, stage, priority, created_by
  ) values (
    v_row.line_of_business::text, v_route.workflow_template_id, v_route.team_id,
    p_submission_id, 'cs_intake', v_display,
    null, 'new',
    case v_row.priority::text when 'urgent' then 'urgent' when 'high' then 'high' else 'normal' end,
    auth.uid()
  ) returning id into v_opportunity;

  -- The standard checklist arrives with the work, so nobody rebuilds it by hand
  -- (spec section 36).
  insert into public.specialty_checklist_items
    (opportunity_id, category, label, position, is_required, is_custom, created_by)
  select v_opportunity, ct.category, ct.label, ct.position, ct.is_required, false, auth.uid()
  from public.specialty_checklist_templates ct
  where ct.template_id = v_route.workflow_template_id
  order by ct.position;

  select count(*) into v_seeded
  from public.specialty_checklist_items where opportunity_id = v_opportunity;

  perform public.specialty_log(v_opportunity, 'opportunity_created', jsonb_build_object(
    'source', 'cs_intake',
    'intake_id', p_submission_id,
    'line_of_business', v_row.line_of_business::text,
    'team_id', v_route.team_id,
    'display_name', v_display,
    'checklist_items_seeded', v_seeded
  ));

  perform public.specialty_log(v_opportunity, 'intake_received', jsonb_build_object(
    'intake_id', p_submission_id,
    'submitted_by', auth.uid(),
    'intake_channel', v_row.intake_channel,
    'is_walk_in', v_row.is_walk_in,
    'priority', v_row.priority::text
  ));

  -- The intake is finished and its journey continues on the specialty side. Note
  -- source_commercial_quote_id is deliberately NOT set: there is no commercial card.
  update public.cs_intake_submissions
     set status = 'converted',
         submitted_at = coalesce(submitted_at, now()),
         converted_at = now(),
         completed_by = auth.uid(),
         updated_at = now()
   where id = p_submission_id;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (p_submission_id, auth.uid(), 'converted_specialty', jsonb_build_object(
    'specialty_opportunity_id', v_opportunity,
    'line_of_business', v_row.line_of_business::text,
    'team_id', v_route.team_id,
    'display_name', v_display
  ));

  -- Tell the team there is work waiting. Everyone eligible to claim, not one person.
  for v_member in
    select m.profile_id
    from public.quoting_team_members m
    join public.profiles p on p.id = m.profile_id
    where m.team_id = v_route.team_id and m.is_active and m.can_claim and p.is_active
  loop
    insert into public.user_notifications
      (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
    values (
      v_member.profile_id, 'assignment',
      'New ' || initcap(replace(v_row.line_of_business::text, '_', ' ')) || ' quote to claim',
      v_display || ' was submitted by Customer Service and is waiting for someone to claim it.',
      'specialty_opportunity', v_opportunity
    );
  end loop;

  return v_opportunity;
end;
$$;

comment on function public.cs_intake_submit_specialty(uuid) is
  'Submits a Trucking or Homeowners intake into Specialty Quotes. Creates one opportunity owned by the routed team, seeds the template checklist, leaves it unclaimed, notifies every eligible member and marks the intake converted. Idempotent per intake. Consumes no rotation turn. Spec sections 8, 21, 36.';

grant execute on function public.cs_intake_submit_specialty(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. GUARD ONE — narrow the commercial submit path to commercial_gl
--
--    Rewritten in place from the live definition rather than restated, so the
--    twelve-thousand-character description builder, checklist seeding and activity
--    logging that commercial_gl depends on are provably unchanged. Only the
--    line-of-business whitelist and its message move.
-- ═══════════════════════════════════════════════════════════════════════════════

-- The one-argument overload is stale: it predates p_assigned_to and resolves the
-- assignee by picking the first active manager, which is not what any caller wants.
drop function if exists public.cs_intake_submit_commercial(uuid);

do $narrow$
declare
  v_src text;
  v_out text;
begin
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'cs_intake_submit_commercial'
    and p.pronargs = 2;

  if v_src is null then
    raise exception 'cs_intake_submit_commercial(uuid, uuid) was not found' using hint = 'Rolling back.';
  end if;

  v_out := replace(
    v_src,
    'NOT IN (''homeowners'', ''trucking'', ''commercial_gl'')',
    'NOT IN (''commercial_gl'')');
  v_out := replace(
    v_out,
    'This function only handles homeowners, trucking, and commercial GL intakes.',
    'Trucking and Homeowners intakes go to Specialty Quotes. Use cs_intake_submit_specialty for those lines; this path handles Commercial GL only.');

  if v_out = v_src then
    raise exception 'Could not narrow cs_intake_submit_commercial: the live definition did not contain the expected line-of-business whitelist. Inspect it before retrying.'
      using hint = 'Rolling back.';
  end if;

  execute v_out;
end
$narrow$;

grant execute on function public.cs_intake_submit_commercial(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. GUARD TWO — the destination refuses the card
--
--    Independent of which function version is live and of any future caller. While a
--    line of business has an active specialty route, a commercial card for that line
--    cannot be created at all. commercial_gl has no route, so nothing about it
--    changes.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_block_legacy_specialty_cards()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_line text;
begin
  if new.coverage_type is null then return new; end if;

  -- coverage_type on the commercial board is the only column that identifies a
  -- trucking or homeowners card; the two values happen to match the specialty line
  -- names exactly.
  v_line := new.coverage_type;
  if v_line not in ('trucking', 'homeowners') then return new; end if;

  if exists (
    select 1
    from public.quoting_team_lob_routes r
    join public.quoting_teams t on t.id = r.team_id
    where r.line_of_business = v_line and r.is_active and t.is_active
  ) then
    raise exception '% quoting moved to Specialty Quotes. A commercial card cannot be created for it, so the same live quote never appears in two places.',
      initcap(v_line)
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.specialty_block_legacy_specialty_cards() is
  'Refuses a new commercial_quotes card whose coverage_type names a line of business that Specialty Quotes now owns. The second, path-independent half of the no-duplicate-destinations guarantee. Spec sections 78, 80.';

drop trigger if exists commercial_quotes_block_specialty on public.commercial_quotes;
create trigger commercial_quotes_block_specialty
  before insert on public.commercial_quotes
  for each row execute function public.specialty_block_legacy_specialty_cards();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. QUOTE CENTER  (spec section 81)
--
--    `create or replace view` rather than drop-and-create, because
--    quote_center_journey() returns `setof public.quote_center_journeys` and dropping
--    the view would take the function with it. Replace keeps the existing 63 columns
--    in place and appends three, which is all a replace is allowed to do — so a
--    mistake here fails loudly at migration time instead of silently reshaping the
--    drawer.
--
--    Only the lifecycle expressions change. The specialty branch is tested BEFORE the
--    commercial branch so a legacy-adopted intake, which still carries its
--    source_commercial_quote_id, reports where the work actually is now.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace view public.quote_center_journeys as
select
  ('intake:' || s.id::text)                           as journey_key,
  s.id                                                as intake_id,
  coalesce(s.source_work_item_id, s.work_item_id, st.source_work_item_id) as work_item_id,
  coalesce(
    nullif(btrim(s.business_name), ''),
    nullif(btrim(concat_ws(' ', s.insured_first_name, s.insured_last_name)), ''),
    nullif(btrim(st.customer_name), ''),
    'Unnamed'
  )                                                   as customer_name,
  nullif(btrim(s.business_name), '')                  as business_name,
  s.insured_first_name,
  s.insured_last_name,
  s.insured_dob,
  s.insured_phone_primary                             as phone_primary,
  s.insured_phone_alt                                 as phone_alt,
  public.nhwd_digits(s.insured_phone_primary)         as phone_digits,
  public.nhwd_digits(s.insured_phone_alt)             as phone_alt_digits,
  s.insured_email                                     as email,
  s.addr_street,
  s.addr_unit,
  s.addr_city,
  s.addr_state,
  s.addr_zip,
  s.renters_property_address,
  s.renters_city,
  s.renters_state,
  s.line_of_business::text                            as line_of_business,
  s.quote_kind::text                                  as quote_kind,
  coalesce(st.work_type, case when s.quote_kind = 'requote' then 'requote' else 'new_quote' end) as work_type,
  s.dot_number,
  s.is_walk_in,
  s.intake_channel::text                              as intake_channel,
  s.source_type,
  s.dealer_id,
  d.name                                              as dealer_name,
  s.salesperson_id,
  dsp.name                                            as salesperson_name,
  coalesce(
    nullif(btrim(d.name), ''),
    case when s.is_walk_in then 'Walk-In' end,
    nullif(btrim(st.received_through), ''),
    case s.intake_channel::text
      when 'ringcentral' then 'RingCentral'
      when 'manual' then 'Manual'
    end,
    'Not recorded'
  )                                                   as source_label,
  st.assignment_method,
  s.created_by                                        as started_by_id,
  starter.display_name                                as started_by_name,
  s.completed_by                                      as completed_by_id,
  completer.display_name                              as completed_by_name,
  s.last_edited_by                                    as last_edited_by_id,
  editor.display_name                                 as last_edited_by_name,
  -- A specialty opportunity's primary assignee is the person accountable for this
  -- customer now, so Quote Center names them rather than the intake's claimer.
  coalesce(st.assigned_profile_id, sp.primary_assignee_id, s.claimed_by) as assigned_profile_id,
  coalesce(assignee.display_name, sp_assignee.display_name, claimer.display_name) as assigned_agent_name,
  (case
     when st.stage is not null then st.stage
     when sp.id is not null then sp.stage_bucket
     when s.source_commercial_quote_id is not null then 'working'
     when s.status::text in ('claimed', 'converted') then 'working'
     else 'intake'
   end)::text                                         as stage,
  (case
     when st.stage_label is not null then st.stage_label
     when sp.id is not null then sp.stage_label
     when s.source_commercial_quote_id is not null then 'On Commercial Board'
     when s.status::text = 'draft' then 'Draft — Needs Information'
     when s.status::text = 'returned' then 'Returned'
     when s.status::text = 'submitted' then 'Waiting to Be Taken'
     when s.status::text = 'claimed' then 'Claimed'
     when s.status::text = 'rejected' then 'Rejected'
     when s.status::text = 'converted' then 'Quote Removed'
     else initcap(s.status::text)
   end)::text                                         as stage_label,
  s.status::text                                      as intake_status,
  coalesce(st.decision, sp.result)                    as decision,
  coalesce(st.not_sold_reason, sp.lost_reason)        as not_sold_reason,
  s.created_at                                        as started_at,
  s.submitted_at,
  s.claimed_at,
  s.converted_at,
  st.quote_created_at,
  coalesce(st.price_sent_at, sp.price_sent_at)        as price_sent_at,
  coalesce(st.finalized_at, sp.finalized_at)          as finalized_at,
  greatest(
    s.updated_at,
    coalesce(st.last_activity_at, s.updated_at),
    coalesce(s.last_edited_at, s.updated_at),
    coalesce(sp.last_activity_at, s.updated_at)
  )                                                   as last_activity_at,
  coalesce(st.is_voided, false)                       as is_voided,
  s.source_commercial_quote_id,
  s.version                                           as intake_version,
  s.renters_addr_verified,
  s.addr_verified,
  true                                                as has_intake,
  (st.source_work_item_id is not null)                as has_quote,
  lower(concat_ws(' ',
    s.insured_first_name, s.insured_middle_name, s.insured_last_name,
    s.business_name, s.insured_email,
    s.addr_street, s.addr_unit, s.addr_city, s.addr_state, s.addr_zip,
    s.renters_property_address, s.renters_city,
    s.dot_number, d.name, dsp.name, st.received_through, st.customer_name,
    s.id::text, st.source_work_item_id::text,
    sp.reference
  ))                                                  as search_blob,
  -- Appended by v1.16.5. Present so the drawer can offer the specialty panel and the
  -- Customer Service callback without a second lookup.
  sp.id                                               as specialty_opportunity_id,
  sp.reference                                        as specialty_reference,
  coalesce(sp.information_needed, 0)::integer         as specialty_information_needed
from public.cs_intake_submissions s
left join public.quote_center_quote_stage st
       on st.source_work_item_id = coalesce(s.source_work_item_id, s.work_item_id)
left join public.dealers d on d.id = s.dealer_id
left join public.dealer_salespeople dsp on dsp.id = s.salesperson_id
left join public.profiles starter on starter.id = s.created_by
left join public.profiles completer on completer.id = s.completed_by
left join public.profiles editor on editor.id = s.last_edited_by
left join public.profiles assignee on assignee.id = st.assigned_profile_id
left join public.profiles claimer on claimer.id = s.claimed_by
left join (
  select
    o.id,
    o.source_intake_id,
    o.reference,
    o.result,
    o.lost_reason,
    o.price_sent_at,
    o.finalized_at,
    o.last_activity_at,
    o.primary_assignee_id,
    -- Specialty's nine stages, mapped onto Quote Center's four lifecycle buckets so
    -- the stage filters and counts keep one meaning across every kind of quote.
    (case
       when o.stage in ('new', 'information_needed', 'ready_to_market',
                        'marketing', 'options_ready') then 'working'
       when o.stage in ('price_sent', 'follow_up') then 'price_sent'
       else 'closed'
     end)                                             as stage_bucket,
    -- The normalized, employee-facing lifecycle label spec section 81 asks for.
    (case o.stage
       when 'new'                then 'Submitted to Specialty Team'
       when 'information_needed' then 'Information Needed'
       when 'ready_to_market'    then 'Being Quoted'
       when 'marketing'          then 'Being Quoted'
       when 'options_ready'      then 'Options Ready'
       when 'price_sent'         then 'Price Sent'
       when 'follow_up'          then 'Customer Follow-Up'
       when 'sold'               then 'Sold'
       when 'not_sold'           then 'Not Sold'
       else initcap(replace(o.stage, '_', ' '))
     end)                                             as stage_label,
    (select count(*) from public.specialty_information_requests r
      where r.opportunity_id = o.id and r.status in ('needed', 'requested')) as information_needed
  from public.specialty_opportunities o
  where o.source_intake_id is not null
) sp on sp.source_intake_id = s.id
left join public.profiles sp_assignee on sp_assignee.id = sp.primary_assignee_id

union all

select
  ('quote:' || st.source_work_item_id::text)          as journey_key,
  null::uuid                                          as intake_id,
  st.source_work_item_id                              as work_item_id,
  coalesce(nullif(btrim(st.customer_name), ''), 'Unnamed') as customer_name,
  null::text                                          as business_name,
  null::text                                          as insured_first_name,
  null::text                                          as insured_last_name,
  null::date                                          as insured_dob,
  null::text                                          as phone_primary,
  null::text                                          as phone_alt,
  ''::text                                            as phone_digits,
  ''::text                                            as phone_alt_digits,
  null::text                                          as email,
  null::text                                          as addr_street,
  null::text                                          as addr_unit,
  null::text                                          as addr_city,
  null::text                                          as addr_state,
  null::text                                          as addr_zip,
  null::text                                          as renters_property_address,
  null::text                                          as renters_city,
  null::text                                          as renters_state,
  null::text                                          as line_of_business,
  (case when st.work_type = 'requote' then 'requote' else 'new_quote' end)::text as quote_kind,
  st.work_type,
  null::text                                          as dot_number,
  false                                               as is_walk_in,
  null::text                                          as intake_channel,
  null::text                                          as source_type,
  st.dealer_id,
  d.name                                              as dealer_name,
  st.salesperson_id,
  dsp.name                                            as salesperson_name,
  coalesce(nullif(btrim(d.name), ''), nullif(btrim(st.received_through), ''), 'Not recorded') as source_label,
  st.assignment_method,
  st.original_owner_profile_id                        as started_by_id,
  owner_p.display_name                                as started_by_name,
  null::uuid                                          as completed_by_id,
  null::text                                          as completed_by_name,
  null::uuid                                          as last_edited_by_id,
  null::text                                          as last_edited_by_name,
  st.assigned_profile_id,
  assignee.display_name                               as assigned_agent_name,
  st.stage,
  st.stage_label,
  null::text                                          as intake_status,
  st.decision,
  st.not_sold_reason,
  st.quote_created_at                                 as started_at,
  null::timestamptz                                   as submitted_at,
  null::timestamptz                                   as claimed_at,
  null::timestamptz                                   as converted_at,
  st.quote_created_at,
  st.price_sent_at,
  st.finalized_at,
  st.last_activity_at,
  st.is_voided,
  null::uuid                                          as source_commercial_quote_id,
  null::integer                                       as intake_version,
  false                                               as renters_addr_verified,
  false                                               as addr_verified,
  false                                               as has_intake,
  true                                                as has_quote,
  lower(concat_ws(' ',
    st.customer_name, d.name, dsp.name, st.received_through, st.source_work_item_id::text
  ))                                                  as search_blob,
  null::uuid                                          as specialty_opportunity_id,
  null::text                                          as specialty_reference,
  0::integer                                          as specialty_information_needed
from public.quote_center_quote_stage st
left join public.dealers d on d.id = st.dealer_id
left join public.dealer_salespeople dsp on dsp.id = st.salesperson_id
left join public.profiles assignee on assignee.id = st.assigned_profile_id
left join public.profiles owner_p on owner_p.id = st.original_owner_profile_id
where not exists (
  select 1
  from public.cs_intake_submissions s2
  where coalesce(s2.source_work_item_id, s2.work_item_id) = st.source_work_item_id
);

comment on view public.quote_center_journeys is
  'One row per customer quote journey. A converted intake and the quote it became collapse into a single row: the intake side anchors it and the quote side supplies the current stage. Since v1.16.5 a Specialty Quotes opportunity also supplies stage, label, assignee, pricing and closing dates, so a customer handed to the Trucking or Homeowners team keeps a truthful status here. A quote with no intake, and an intake with no quote, each anchor their own row. Nothing is merged or deleted in the underlying tables to achieve this.';

revoke all on public.quote_center_journeys from authenticated, anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. CUSTOMER SERVICE CALLBACK  (spec sections 22, 82)
--
--    Customer Service does not get the specialty workspace. What they get is the
--    answer to "what is happening with my customer, and does anyone need anything
--    from me?" — and a way to supply it. Carrier strategy is not included: the
--    outstanding-information list is filtered to visible_to_cs, and notes to
--    is_cs_visible.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_cs_status(p_intake_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_result jsonb;
begin
  -- Quote Center's own gate. A specialty member reaching this sees the same summary;
  -- their detail comes from specialty_opportunity_detail.
  if not (public.can_view_quote_center() or public.specialty_can_access()) then
    raise exception 'That record is not available for your account.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'opportunity_id', o.id,
    'reference', o.reference,
    'line_of_business', o.line_of_business,
    'team_name', t.name,
    'display_name', o.display_name,
    -- The normalized lifecycle status, matching what Quote Center's chip shows.
    'status', case o.stage
      when 'new'                then 'Submitted to Specialty Team'
      when 'information_needed' then 'Information Needed'
      when 'ready_to_market'    then 'Being Quoted'
      when 'marketing'          then 'Being Quoted'
      when 'options_ready'      then 'Options Ready'
      when 'price_sent'         then 'Price Sent'
      when 'follow_up'          then 'Customer Follow-Up'
      when 'sold'               then 'Sold'
      when 'not_sold'           then 'Not Sold'
      else initcap(replace(o.stage, '_', ' ')) end,
    'stage', o.stage,
    'result', o.result,
    'assignee_name', p.display_name,
    'created_at', o.created_at,
    'claimed_at', o.claimed_at,
    'price_sent_at', o.price_sent_at,
    'finalized_at', o.finalized_at,
    'last_activity_at', o.last_activity_at,
    -- Only what Customer Service is allowed to see and act on.
    'information_needed', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'label', r.label, 'status', r.status, 'note', r.note,
        'requested_at', r.requested_at, 'requested_by_name', rp.display_name)
        order by r.created_at)
      from public.specialty_information_requests r
      left join public.profiles rp on rp.id = r.requested_by
      where r.opportunity_id = o.id
        and r.visible_to_cs
        and r.status in ('needed', 'requested')
    ), '[]'::jsonb),
    'shared_notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'content', n.content, 'created_at', n.created_at,
        'author_name', np.display_name) order by n.created_at desc)
      from public.specialty_notes n
      left join public.profiles np on np.id = n.author_id
      where n.opportunity_id = o.id and n.is_cs_visible
    ), '[]'::jsonb)
  ) into v_result
  from public.specialty_opportunities o
  join public.quoting_teams t on t.id = o.team_id
  left join public.profiles p on p.id = o.primary_assignee_id
  where o.source_intake_id = p_intake_id;

  return v_result;
end;
$fn$;

comment on function public.specialty_cs_status(uuid) is
  'The specialty status of a customer''s journey, for Quote Center. Returns the normalized lifecycle label, who is accountable, and the outstanding information items and notes that Customer Service is permitted to see. Carrier markets, premiums and internal strategy are deliberately absent. Spec sections 22, 81, 82.';

revoke execute on function public.specialty_cs_status(uuid) from public, anon;
grant execute on function public.specialty_cs_status(uuid) to authenticated;

-- Customer Service supplies the information the specialty team asked for. This is
-- the callback: the customer rings CS, CS sees "Loss Runs" outstanding, and marks it
-- provided with a note. No new intake, no lost context.
create or replace function public.specialty_cs_provide_information(
  p_request_id uuid,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_req public.specialty_information_requests;
  v_open integer;
begin
  select * into v_req from public.specialty_information_requests where id = p_request_id;
  if not found then raise exception 'That information item could not be found.'; end if;

  -- A specialty member uses their own action. This one exists for everyone else who
  -- legitimately handles the customer, and only for items the team chose to share.
  if not v_req.visible_to_cs then
    raise exception 'That item is not shared with Customer Service.' using errcode = '42501';
  end if;
  if not (public.can_view_quote_center() or public.specialty_can_edit_opportunity(v_req.opportunity_id)) then
    raise exception 'You cannot update that item.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Describe what was provided, so the specialty team knows what they have.';
  end if;

  update public.specialty_information_requests
     set status = 'received',
         note = btrim(p_note),
         resolved_at = now(),
         resolved_by = auth.uid()
   where id = p_request_id;

  perform public.specialty_log(v_req.opportunity_id, 'information_received', jsonb_build_object(
    'request_id', p_request_id,
    'label', v_req.label,
    'from_status', v_req.status,
    'to_status', 'received',
    'note', btrim(p_note),
    'via', 'customer_service'
  ));

  -- The specialty team sees it as a note too, because that is where they look.
  insert into public.specialty_notes (opportunity_id, author_id, content, is_cs_visible)
  values (v_req.opportunity_id, auth.uid(),
          'Customer Service provided: ' || v_req.label || ' — ' || btrim(p_note), true);

  select count(*) into v_open
  from public.specialty_information_requests
  where opportunity_id = v_req.opportunity_id and status in ('needed', 'requested');

  if v_open = 0 then
    perform public.specialty_advance_stage(v_req.opportunity_id, 'ready_to_market',
      array['information_needed']);
  end if;
end;
$fn$;

comment on function public.specialty_cs_provide_information(uuid, text) is
  'Customer Service marks a shared information item as provided and says what it was. Writes the specialty timeline and a shared note so the team sees it without a handoff. Spec section 82.';

revoke execute on function public.specialty_cs_provide_information(uuid, text) from public, anon;
grant execute on function public.specialty_cs_provide_information(uuid, text) to authenticated;

create or replace function public.specialty_cs_add_note(p_intake_id uuid, p_note text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_opportunity uuid;
  v_id uuid;
begin
  if not (public.can_view_quote_center() or public.specialty_can_access()) then
    raise exception 'That record is not available for your account.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'A note cannot be empty.';
  end if;

  select id into v_opportunity
  from public.specialty_opportunities where source_intake_id = p_intake_id;
  if v_opportunity is null then
    raise exception 'That customer is not with a specialty team.';
  end if;

  insert into public.specialty_notes (opportunity_id, author_id, content, is_cs_visible)
  values (v_opportunity, auth.uid(), btrim(p_note), true)
  returning id into v_id;

  perform public.specialty_log(v_opportunity, 'note_added',
    jsonb_build_object('note_id', v_id, 'cs_visible', true, 'via', 'customer_service'));

  return v_id;
end;
$fn$;

comment on function public.specialty_cs_add_note(uuid, text) is
  'Lets Customer Service document a customer conversation against the specialty quote. Marked shared so the note is visible on both sides. Never changes assignment. Spec section 22.';

revoke execute on function public.specialty_cs_add_note(uuid, text) from public, anon;
grant execute on function public.specialty_cs_add_note(uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════

do $post$
declare
  v_count integer;
  v_src text;
begin
  -- The specialty submit path exists and the stale overload is gone.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'cs_intake_submit_specialty') then
    raise exception 'v1.16.5 did not create cs_intake_submit_specialty' using hint = 'Rolling back.';
  end if;

  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cs_intake_submit_commercial';
  if v_count <> 1 then
    raise exception 'v1.16.5 expected exactly one cs_intake_submit_commercial overload, found %', v_count
      using hint = 'Rolling back.';
  end if;

  -- Guard one landed, and commercial_gl is still handled.
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'cs_intake_submit_commercial';
  -- The whitelist itself must be narrowed. Other mentions of the two words survive
  -- further down the body (the coverage_type CASE, the homeowners property section of
  -- the description builder) and are now unreachable; leaving them keeps the diff to
  -- the commercial path as small as possible, which is the point.
  if v_src not like '%NOT IN (''commercial_gl'')%' then
    raise exception 'v1.16.5 did not narrow the commercial submit whitelist'
      using hint = 'Rolling back.';
  end if;
  if v_src like '%NOT IN (''homeowners'', ''trucking'', ''commercial_gl'')%' then
    raise exception 'v1.16.5 left trucking and homeowners accepted by the commercial submit path'
      using hint = 'Rolling back.';
  end if;
  if v_src not like '%commercial_gl%' then
    raise exception 'v1.16.5 broke commercial_gl handling in cs_intake_submit_commercial'
      using hint = 'Rolling back.';
  end if;
  -- The parts commercial_gl depends on must be untouched.
  if v_src not like '%commercial_quote_column_history%'
     or v_src not like '%commercial_quote_activity_log%'
     or v_src not like '%commercial_quote_checklist_items%' then
    raise exception 'v1.16.5 damaged the commercial card creation path' using hint = 'Rolling back.';
  end if;

  -- Guard two landed.
  if not exists (select 1 from pg_trigger
                 where tgname = 'commercial_quotes_block_specialty' and not tgisinternal) then
    raise exception 'v1.16.5 did not install the commercial card guard' using hint = 'Rolling back.';
  end if;

  -- Quote Center learned the three new columns and kept the old ones.
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'quote_center_journeys';
  if v_count <> 66 then
    raise exception 'v1.16.5 expected 66 columns on quote_center_journeys, found %', v_count
      using hint = 'Rolling back.';
  end if;

  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'quote_center_journeys'
                   and column_name = 'specialty_opportunity_id') then
    raise exception 'v1.16.5 did not add the specialty overlay to quote_center_journeys'
      using hint = 'Rolling back.';
  end if;

  if has_table_privilege('authenticated', 'public.quote_center_journeys', 'select') then
    raise exception 'v1.16.5 left quote_center_journeys readable by authenticated'
      using hint = 'Rolling back.';
  end if;

  -- Nothing in this migration may touch a rotation.
  if pg_get_functiondef(
       (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'cs_intake_submit_specialty')
     ) like any (array['%rotation_state%', '%turn_events%']) then
    raise exception 'v1.16.5 gave the specialty submit path a rotation side effect'
      using hint = 'Rolling back.';
  end if;
end
$post$;

commit;

select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cs_intake_submit_commercial') as commercial_overloads_expect_1,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'quote_center_journeys') as journey_columns_expect_66,
  (select count(*) from pg_trigger where tgname = 'commercial_quotes_block_specialty') as guard_trigger_expect_1;

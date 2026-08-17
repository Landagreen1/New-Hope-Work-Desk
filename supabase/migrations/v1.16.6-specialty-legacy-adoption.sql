-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.16.6 — Specialty Quotes: adopting the legacy Trucking and Homeowners cards
--
-- Spec: sections 78, 79, 96, 11 (Phase 11).
-- Requires v1.16.5.
--
-- THE CHOSEN APPROACH — spec section 79, Option C with a permanent adapter
--
--   Trucking and Homeowners intakes have been creating rows in
--   `public.commercial_quotes` since v1.6.0, identified by `coverage_type`. Rather
--   than move that data (Option A, which risks the originals) or generalise the
--   commercial model underneath a shared engine (Option B, which would touch every
--   commercial policy and RPC for the sake of two rows), this migration ADOPTS each
--   live legacy card:
--
--     * The commercial row and every one of its children stay exactly where they
--       are. Nothing is deleted, nothing is rewritten, no timestamp is lost.
--     * A specialty opportunity is created that points back at the card, carries the
--       card's original created_at, assignee and stage, and — when the card came from
--       a CS intake — points at that intake too, so the customer's Quote Center
--       journey stays continuous.
--     * Comments, attachments, checklist items, column history and the activity log
--       are copied forward with their original authors and timestamps, so the
--       specialty timeline starts with the real history rather than at zero.
--     * Attachments are NOT copied between buckets. The specialty document row keeps
--       pointing at `commercial-quote-attachments`, and a storage policy added below
--       lets the owning specialty team read those objects. Moving a hundred megabytes
--       of files to gain nothing is a risk with no upside.
--     * The card is stamped `migrated_to_specialty_at`, and the commercial list
--       endpoint filters on it, so the same live quote is not visible in two places.
--       The row is still there for anyone who needs the history.
--
--   Soft-deleted legacy cards (`is_deleted = true`) are deliberately NOT adopted.
--   They were already removed from the board; adopting one would resurrect deleted
--   work into a live queue. They stay in the commercial database exactly as they are.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
--   * Commercial GL. No commercial_gl card is touched, stamped, or adopted.
--   * Commercial policies, RPCs, reports, comments, attachments and checklists all
--     keep working on every remaining card.
--   * The two new commercial_quotes columns are nullable and additive, so every
--     existing query keeps its meaning.
--
-- ROLLBACK
--   begin;
--     update public.commercial_quotes
--        set migrated_to_specialty_at = null, migrated_to_specialty_id = null
--      where migrated_to_specialty_at is not null;
--     delete from public.specialty_opportunities where source = 'legacy_commercial';
--   commit;
--   (Children cascade. The commercial originals were never modified.)
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE ADAPTER COLUMNS
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.commercial_quotes
  add column if not exists migrated_to_specialty_at timestamptz;
alter table public.commercial_quotes
  add column if not exists migrated_to_specialty_id uuid references public.specialty_opportunities(id);

comment on column public.commercial_quotes.migrated_to_specialty_at is
  'Set when this card''s live work moved to Specialty Quotes. The row and all its children are kept; the commercial list endpoint filters these out so one quote is never live in two places. Spec sections 78, 79.';

create index if not exists idx_commercial_quotes_not_migrated
  on public.commercial_quotes (board_column, column_position)
  where migrated_to_specialty_at is null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ADOPTION
-- ═══════════════════════════════════════════════════════════════════════════════

do $adopt$
declare
  v_card record;
  v_route public.quoting_team_lob_routes;
  v_opportunity uuid;
  v_stage text;
  v_result text;
  v_assignee uuid;
  v_intake uuid;
  v_adopted integer := 0;
  v_skipped integer := 0;
  v_notes integer := 0;
  v_docs integer := 0;
  v_items integer := 0;
  v_events integer := 0;
begin
  for v_card in
    select q.*
    from public.commercial_quotes q
    where q.coverage_type in ('trucking', 'homeowners')
      and coalesce(q.is_deleted, false) = false
      and q.migrated_to_specialty_at is null
      and not exists (select 1 from public.specialty_opportunities o
                      where o.legacy_commercial_quote_id = q.id)
    order by q.created_at
  loop
    select r.* into v_route
    from public.quoting_team_lob_routes r
    join public.quoting_teams t on t.id = r.team_id
    where r.line_of_business = v_card.coverage_type
      and r.is_active and r.is_default and t.is_active
    limit 1;

    if not found then
      -- No configured destination means the safe action is to leave the card alone.
      raise notice 'v1.16.6: no active % route; leaving commercial card % on the board.',
        v_card.coverage_type, v_card.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Board column carries the only stage information a legacy card has.
    v_stage := case v_card.board_column
      when 'quote_intake' then 'new'
      when 'quoting' then 'marketing'
      when 'price_sent' then 'price_sent'
      when 'sold' then 'sold'
      when 'commission_approved' then 'sold'
      when 'commission_not_approved' then 'sold'
      when 'not_sold' then 'not_sold'
      when 'archive' then 'not_sold'
      else 'new'
    end;
    v_result := case when v_stage in ('sold', 'not_sold') then v_stage else null end;

    -- The card's assignee keeps accountability only if they are actually an eligible
    -- member of the receiving team. Otherwise the work arrives unclaimed and visible,
    -- which is recoverable, rather than assigned to somebody who cannot open it.
    v_assignee := null;
    if v_card.assigned_to is not null and exists (
      select 1 from public.quoting_team_members m
      join public.profiles p on p.id = m.profile_id
      where m.team_id = v_route.team_id and m.profile_id = v_card.assigned_to
        and m.is_active and m.can_be_assigned and p.is_active
    ) then
      v_assignee := v_card.assigned_to;
    end if;

    -- Keep the customer's journey continuous when this card came from an intake.
    select s.id into v_intake
    from public.cs_intake_submissions s
    where s.source_commercial_quote_id = v_card.id
      and not exists (select 1 from public.specialty_opportunities o2
                      where o2.source_intake_id = s.id)
    order by s.created_at
    limit 1;

    insert into public.specialty_opportunities (
      line_of_business, workflow_template_id, team_id,
      source_intake_id, legacy_commercial_quote_id, source,
      display_name, primary_assignee_id, stage, priority,
      result,
      lost_reason,
      lost_reason_note,
      sold_premium,
      created_at, claimed_at, price_sent_at, finalized_at, last_activity_at,
      created_by
    ) values (
      v_card.coverage_type, v_route.workflow_template_id, v_route.team_id,
      v_intake, v_card.id, 'legacy_commercial',
      v_card.business_name, v_assignee, v_stage,
      case v_card.risk_level when 'high' then 'high' else 'normal' end,
      v_result,
      -- A legacy card has no structured reason. 'other' plus an explicit note is the
      -- honest record; inventing a specific reason would corrupt the lost-business
      -- report.
      case when v_result = 'not_sold' then 'other' end,
      case when v_result = 'not_sold'
        then 'Migrated from the Commercial Board (' || v_card.board_column ||
             '); no structured reason was recorded there.' end,
      case when v_result = 'sold' then coalesce(v_card.sold_premium, v_card.total_premium) end,
      -- Original timestamps, so aging and timing reports do not restart the clock.
      v_card.created_at,
      case when v_assignee is not null then v_card.created_at end,
      case when v_stage in ('price_sent', 'sold', 'not_sold') then v_card.column_entered_at end,
      case when v_result is not null then coalesce(v_card.sold_at, v_card.column_entered_at) end,
      greatest(v_card.updated_at, v_card.created_at),
      coalesce(v_card.created_by, v_card.assigned_to)
    ) returning id into v_opportunity;

    v_adopted := v_adopted + 1;

    -- ── Checklist. Marked custom so a team member can remove an item that no longer
    --    applies; the template checklist is added alongside it below.
    insert into public.specialty_checklist_items
      (opportunity_id, category, label, position, is_required, is_custom,
       is_checked, created_by, created_at)
    select v_opportunity,
           coalesce(nullif(btrim(cl.title), ''), 'Migrated'),
           ci.label,
           ci.position,
           false, true,
           ci.is_checked,
           v_card.assigned_to,
           ci.created_at
    from public.commercial_quote_checklists cl
    join public.commercial_quote_checklist_items ci on ci.checklist_id = cl.id
    where cl.quote_id = v_card.id;

    -- ── The workflow template's own checklist, so the standard process is present
    --    from now on. Anything the legacy card already listed is skipped by label.
    insert into public.specialty_checklist_items
      (opportunity_id, category, label, position, is_required, is_custom, created_by)
    select v_opportunity, ct.category, ct.label, 100 + ct.position, ct.is_required, false,
           coalesce(v_card.created_by, v_card.assigned_to)
    from public.specialty_checklist_templates ct
    where ct.template_id = v_route.workflow_template_id
      and not exists (
        select 1 from public.specialty_checklist_items existing
        where existing.opportunity_id = v_opportunity
          and lower(btrim(existing.label)) = lower(btrim(ct.label))
      );

    select count(*) into v_items
    from public.specialty_checklist_items where opportunity_id = v_opportunity;

    -- ── Comments become notes, with their original authors and times.
    insert into public.specialty_notes (opportunity_id, author_id, content, is_cs_visible, created_at)
    select v_opportunity, cc.author_id, cc.content, false, cc.created_at
    from public.commercial_quote_comments cc
    where cc.quote_id = v_card.id;

    -- ── The card's flattened description is the only place the original intake
    --    detail reached the commercial side, so it is preserved as the first note
    --    rather than discarded.
    if nullif(btrim(coalesce(v_card.description, '')), '') is not null then
      insert into public.specialty_notes (opportunity_id, author_id, content, is_cs_visible, created_at)
      values (v_opportunity, coalesce(v_card.created_by, v_card.assigned_to),
              'Migrated from the Commercial Board card description:' || chr(10) || chr(10) || v_card.description,
              false, v_card.created_at);
    end if;

    select count(*) into v_notes
    from public.specialty_notes where opportunity_id = v_opportunity;

    -- ── Attachments are referenced, not copied. storage_bucket records where the
    --    bytes actually are.
    insert into public.specialty_documents
      (opportunity_id, uploaded_by, file_name, file_size, mime_type,
       storage_bucket, storage_path, category, created_at)
    select v_opportunity, ca.uploaded_by, ca.file_name, ca.file_size, ca.mime_type,
           'commercial-quote-attachments', ca.storage_path, 'other', ca.created_at
    from public.commercial_quote_attachments ca
    where ca.quote_id = v_card.id
      and not exists (
        select 1 from public.specialty_documents sd
        where sd.storage_bucket = 'commercial-quote-attachments'
          and sd.storage_path = ca.storage_path
      );

    select count(*) into v_docs
    from public.specialty_documents where opportunity_id = v_opportunity;

    -- ── History. The adoption itself, then the card's own past, each attributed to
    --    whoever actually did it.
    insert into public.specialty_activity
      (opportunity_id, actor_profile_id, event_type, detail, created_at)
    values (v_opportunity, coalesce(v_card.created_by, v_card.assigned_to), 'legacy_adopted',
            jsonb_build_object(
              'commercial_quote_id', v_card.id,
              'board_column', v_card.board_column,
              'card_status', v_card.card_status,
              'coverage_type', v_card.coverage_type,
              'original_assigned_to', v_card.assigned_to,
              'assignee_kept', v_assignee is not null,
              'source_intake_id', v_intake,
              'notes_migrated', v_notes,
              'documents_referenced', v_docs,
              'checklist_items', v_items,
              'migrated_at', now()
            ), v_card.created_at);

    insert into public.specialty_activity
      (opportunity_id, actor_profile_id, event_type, detail, created_at)
    select v_opportunity, ch.moved_by, 'stage_changed',
           jsonb_build_object('legacy', true,
                              'from_column', ch.from_column, 'to_column', ch.to_column),
           ch.moved_at
    from public.commercial_quote_column_history ch
    where ch.quote_id = v_card.id;

    insert into public.specialty_activity
      (opportunity_id, actor_profile_id, event_type, detail, created_at)
    select v_opportunity, al.actor_id,
           case al.event_type
             when 'created' then 'opportunity_created'
             when 'comment_added' then 'note_added'
             when 'attachment_uploaded' then 'document_uploaded'
             when 'attachment_deleted' then 'document_deleted'
             when 'checklist_item_added' then 'checklist_item_added'
             when 'checklist_item_toggled' then 'checklist_item_toggled'
             when 'assigned_changed' then 'reassigned'
             when 'column_moved' then 'stage_changed'
             else 'field_updated'
           end,
           coalesce(al.details, '{}'::jsonb)
             || jsonb_build_object('legacy', true, 'legacy_event_type', al.event_type),
           al.created_at
    from public.commercial_quote_activity_log al
    where al.quote_id = v_card.id
      -- 'created' is already represented by the legacy_adopted row above.
      and al.event_type <> 'created';

    select count(*) into v_events
    from public.specialty_activity where opportunity_id = v_opportunity;

    -- ── Stamp the card. Its live visibility ends here; its history does not.
    update public.commercial_quotes
       set migrated_to_specialty_at = now(),
           migrated_to_specialty_id = v_opportunity
     where id = v_card.id;

    -- ── And tell the intake's own log, so Customer Service sees the handoff.
    if v_intake is not null then
      insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
      values (v_intake, coalesce(v_card.created_by, v_card.assigned_to), 'converted_specialty',
              jsonb_build_object(
                'specialty_opportunity_id', v_opportunity,
                'migrated_from_commercial_quote_id', v_card.id,
                'line_of_business', v_card.coverage_type,
                'team_id', v_route.team_id));
    end if;

    raise notice 'v1.16.6: adopted % card % as opportunity % (% notes, % documents, % checklist items, % events).',
      v_card.coverage_type, v_card.id, v_opportunity, v_notes, v_docs, v_items, v_events;
  end loop;

  raise notice 'v1.16.6: adopted % legacy card(s), skipped % for want of a route.', v_adopted, v_skipped;
end
$adopt$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. STORAGE — reading the referenced legacy attachments
--
--    Additive. The existing commercial storage policies are left exactly as they
--    are; this is a further permissive policy, so it can only widen access, and only
--    to objects under an adopted card whose specialty opportunity the reader may
--    already view.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_can_access_legacy_attachment(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_head text;
begin
  if auth.uid() is null then return false; end if;
  -- Commercial attachment keys are '<quote_id>/<timestamp>_<name>'. The uuid shape is
  -- validated as text before the cast so a crafted name denies rather than raises.
  v_head := split_part(coalesce(p_object_name, ''), '/', 1);
  if v_head !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;

  return exists (
    select 1
    from public.specialty_opportunities o
    where o.legacy_commercial_quote_id = v_head::uuid
      and public.specialty_can_view_opportunity(o.id)
  );
end;
$$;

comment on function public.specialty_can_access_legacy_attachment(text) is
  'Read gate for a legacy commercial attachment that a specialty opportunity now references. Only objects under an adopted card, and only for someone who can already view the opportunity. Spec section 79.';

grant execute on function public.specialty_can_access_legacy_attachment(text) to authenticated;

drop policy if exists specialty_legacy_attachment_v1166_select on storage.objects;
create policy specialty_legacy_attachment_v1166_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'commercial-quote-attachments'
    and public.specialty_can_access_legacy_attachment(name)
  );

-- No insert, update or delete: a legacy attachment is history. New documents go to
-- the specialty bucket.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════

do $post$
declare
  v_unadopted integer;
  v_double integer;
  v_orphan integer;
  v_gl_touched integer;
begin
  -- Every live legacy specialty card is either adopted or has no route.
  select count(*) into v_unadopted
  from public.commercial_quotes q
  where q.coverage_type in ('trucking', 'homeowners')
    and coalesce(q.is_deleted, false) = false
    and q.migrated_to_specialty_at is null
    and exists (
      select 1 from public.quoting_team_lob_routes r
      join public.quoting_teams t on t.id = r.team_id
      where r.line_of_business = q.coverage_type and r.is_active and t.is_active);
  if v_unadopted > 0 then
    raise exception 'v1.16.6 left % routable legacy card(s) unadopted', v_unadopted
      using hint = 'Rolling back.';
  end if;

  -- Nothing is live in two places.
  select count(*) into v_double
  from public.commercial_quotes q
  join public.specialty_opportunities o on o.legacy_commercial_quote_id = q.id
  where q.migrated_to_specialty_at is null;
  if v_double > 0 then
    raise exception 'v1.16.6 left % adopted card(s) still live on the board', v_double
      using hint = 'Rolling back.';
  end if;

  -- Every adopted opportunity still points at a real card, and the card still exists
  -- with all of its own children. Nothing was deleted.
  select count(*) into v_orphan
  from public.specialty_opportunities o
  where o.source = 'legacy_commercial'
    and not exists (select 1 from public.commercial_quotes q where q.id = o.legacy_commercial_quote_id);
  if v_orphan > 0 then
    raise exception 'v1.16.6 produced % orphaned adoption(s)', v_orphan using hint = 'Rolling back.';
  end if;

  -- Commercial GL was not touched.
  select count(*) into v_gl_touched
  from public.commercial_quotes
  where migrated_to_specialty_at is not null
    and coverage_type not in ('trucking', 'homeowners');
  if v_gl_touched > 0 then
    raise exception 'v1.16.6 stamped % non-specialty commercial card(s)', v_gl_touched
      using hint = 'Rolling back.';
  end if;

  -- Every note, attachment and checklist item on an adopted card is represented.
  if exists (
    select 1
    from public.commercial_quotes q
    join public.specialty_opportunities o on o.legacy_commercial_quote_id = q.id
    where (select count(*) from public.commercial_quote_comments c where c.quote_id = q.id)
        > (select count(*) from public.specialty_notes n where n.opportunity_id = o.id)
  ) then
    raise exception 'v1.16.6 lost comments during adoption' using hint = 'Rolling back.';
  end if;

  if exists (
    select 1
    from public.commercial_quotes q
    join public.specialty_opportunities o on o.legacy_commercial_quote_id = q.id
    where (select count(*) from public.commercial_quote_attachments a where a.quote_id = q.id)
        > (select count(*) from public.specialty_documents d
            where d.opportunity_id = o.id and d.storage_bucket = 'commercial-quote-attachments')
  ) then
    raise exception 'v1.16.6 lost attachments during adoption' using hint = 'Rolling back.';
  end if;

  if exists (
    select 1
    from public.commercial_quotes q
    join public.specialty_opportunities o on o.legacy_commercial_quote_id = q.id
    where (select count(*) from public.commercial_quote_checklists cl
            join public.commercial_quote_checklist_items ci on ci.checklist_id = cl.id
            where cl.quote_id = q.id)
        > (select count(*) from public.specialty_checklist_items i where i.opportunity_id = o.id)
  ) then
    raise exception 'v1.16.6 lost checklist items during adoption' using hint = 'Rolling back.';
  end if;
end
$post$;

commit;

select
  (select count(*) from public.specialty_opportunities where source = 'legacy_commercial') as adopted,
  (select count(*) from public.commercial_quotes where migrated_to_specialty_at is not null) as stamped,
  (select count(*) from public.commercial_quotes
    where coverage_type in ('trucking','homeowners') and coalesce(is_deleted,false) = false
      and migrated_to_specialty_at is null) as still_live_legacy_expect_0,
  (select count(*) from public.commercial_quotes
    where coverage_type = 'gl' and migrated_to_specialty_at is not null) as gl_touched_expect_0;

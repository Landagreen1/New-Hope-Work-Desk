-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.16.1 — Specialty Quotes: the opportunity core and its child records
--
-- Spec: sections 10-14, 19-23, 27, 35, 39-49, 88-92.
-- Requires v1.16.0.
--
-- WHAT THIS CHANGES
--   Adds the generic Specialty Quote Opportunity and its children: carrier
--   markets, notes, documents, checklist items, information requests, price
--   presentations and one activity timeline. Adds the private storage bucket for
--   specialty documents, and the team-scoped RLS that protects the opportunity AND
--   every child table (spec section 90).
--
--   Two architectural commitments are enforced structurally rather than by
--   convention:
--
--   1. Assignment is accountability, not ownership (spec section 10). Not one
--      policy anywhere in this file tests `primary_assignee_id = auth.uid()`.
--      Editing is decided by team membership. The only place the assignee is
--      consulted is a team that has switched collaborative_editing off.
--
--   2. The intake is not copied (spec section 20). An opportunity stores workflow,
--      assignment, marketing, pricing, tasks and results. Customer name, phone,
--      DOT, MC, property address, drivers and vehicles stay on
--      cs_intake_submissions and are read through source_intake_id. The one
--      denormalised field is display_name, because a card needs a title and a
--      legacy-adopted opportunity has no intake to read one from.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
--   No commercial table, policy or storage policy is modified. No intake routing.
--
-- ROLLBACK
--   begin;
--     drop table if exists public.specialty_activity, public.specialty_price_presentations,
--       public.specialty_documents, public.specialty_notes, public.specialty_information_requests,
--       public.specialty_checklist_items, public.specialty_carrier_markets,
--       public.specialty_opportunities cascade;
--     delete from storage.buckets where id = 'specialty-quote-documents';
--   commit;
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE OPPORTUNITY
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.specialty_opportunities (
  id uuid primary key default gen_random_uuid(),

  -- The identifier employees read aloud. Derived, so it can never drift from the
  -- row it names and there is no sequence to reset.
  reference text generated always as
    ('SQ-' || upper(substr(replace(id::text, '-', ''), 1, 8))) stored,

  line_of_business text not null
    check (line_of_business in ('trucking', 'homeowners', 'commercial_gl')),
  workflow_template_id uuid not null references public.specialty_workflow_templates(id),
  team_id uuid not null references public.quoting_teams(id),

  -- Where the work came from. Exactly one of these is set for real work; a
  -- manually created opportunity has neither.
  source_intake_id uuid references public.cs_intake_submissions(id),
  legacy_commercial_quote_id uuid references public.commercial_quotes(id),
  source text not null default 'cs_intake'
    check (source in ('cs_intake', 'legacy_commercial', 'manual')),

  -- The card title. See the header note: this is the only customer field stored
  -- here, and it is stored because a legacy-adopted opportunity has no intake.
  display_name text not null check (char_length(btrim(display_name)) > 0),

  -- Accountability. NULL means unclaimed and visible to the whole eligible team.
  primary_assignee_id uuid references public.profiles(id),

  stage text not null default 'new' check (stage in (
    'new', 'information_needed', 'ready_to_market', 'marketing',
    'options_ready', 'price_sent', 'follow_up', 'sold', 'not_sold'
  )),
  priority text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),

  -- "What needs to happen next?" — spec section 35.
  next_action text,
  next_action_due timestamptz,
  next_action_set_by uuid references public.profiles(id),
  next_action_set_at timestamptz,

  -- Outcome. A blank Not Sold reason is refused by the check below and again by
  -- specialty_record_result (spec section 34).
  result text check (result in ('sold', 'not_sold')),
  lost_reason text check (lost_reason in (
    'price_too_high', 'stayed_with_current_carrier', 'customer_stopped_responding',
    'competitor', 'ineligible', 'unable_to_place', 'customer_postponed',
    'duplicate', 'other'
  )),
  lost_reason_note text,
  bound_carrier_id uuid references public.specialty_carriers(id),
  sold_premium numeric(12, 2) check (sold_premium is null or sold_premium >= 0),
  result_recorded_by uuid references public.profiles(id),

  -- Pipeline timing, all server-stamped (spec section 74).
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  ready_to_market_at timestamptz,
  first_submission_at timestamptz,
  first_quote_at timestamptz,
  price_sent_at timestamptz,
  finalized_at timestamptz,
  last_activity_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  created_by uuid references public.profiles(id),

  -- Optimistic concurrency. Several team members work the same record, so a stale
  -- save is refused rather than silently overwriting (spec section 14).
  version integer not null default 1,

  constraint specialty_opportunities_not_sold_needs_reason
    check (result is distinct from 'not_sold' or lost_reason is not null),
  constraint specialty_opportunities_result_matches_stage
    check (
      (result is null and stage not in ('sold', 'not_sold'))
      or (result = 'sold' and stage = 'sold')
      or (result = 'not_sold' and stage = 'not_sold')
    )
  -- Both origin links may be set at once, and for one case they must be: a legacy
  -- commercial card that itself came from a CS intake is adopted with a pointer to
  -- the card it replaces AND to the intake that started it, which is what keeps that
  -- customer's Quote Center journey continuous. Each link is separately unique, so
  -- neither origin can be adopted twice.
);

comment on table public.specialty_opportunities is
  'One customer quoting opportunity, whatever its line of business. Carrier markets hang off it as children, so a five-carrier trucking quote is one record and not five. Holds workflow, assignment, pricing and results only — customer and risk detail stays on the linked CS intake. Spec sections 19-21, 39.';

comment on column public.specialty_opportunities.primary_assignee_id is
  'Primary accountability, NOT an access boundary. Any eligible team member may open and work this opportunity regardless of this column. Spec sections 10, 11, 66, 89.';

comment on column public.specialty_opportunities.display_name is
  'The card title only. Every other customer fact is read from source_intake_id; a second copy is forbidden by spec section 20. Present as a column because a legacy-adopted opportunity has no intake to read a title from.';

-- One opportunity per intake, one per legacy card. This is what makes the intake
-- routing and the legacy adoption idempotent, and what prevents the same live
-- quote existing twice (spec sections 78, 79).
create unique index if not exists specialty_opportunities_intake_unique
  on public.specialty_opportunities (source_intake_id) where source_intake_id is not null;
create unique index if not exists specialty_opportunities_legacy_unique
  on public.specialty_opportunities (legacy_commercial_quote_id) where legacy_commercial_quote_id is not null;

create index if not exists specialty_opportunities_team_stage_idx
  on public.specialty_opportunities (team_id, stage, last_activity_at desc);
create index if not exists specialty_opportunities_lob_stage_idx
  on public.specialty_opportunities (line_of_business, stage);
create index if not exists specialty_opportunities_assignee_idx
  on public.specialty_opportunities (primary_assignee_id, stage);
create index if not exists specialty_opportunities_unclaimed_idx
  on public.specialty_opportunities (team_id, created_at) where primary_assignee_id is null;
create index if not exists specialty_opportunities_due_idx
  on public.specialty_opportunities (next_action_due)
  where next_action_due is not null and stage not in ('sold', 'not_sold');
create index if not exists specialty_opportunities_activity_idx
  on public.specialty_opportunities (last_activity_at desc);
create index if not exists specialty_opportunities_reference_idx
  on public.specialty_opportunities (reference);

drop trigger if exists specialty_opportunities_touch on public.specialty_opportunities;
create trigger specialty_opportunities_touch
  before update on public.specialty_opportunities
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. AUTHORIZATION HELPERS THAT NEED THE OPPORTUNITY TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_can_view_opportunity(p_opportunity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.specialty_is_manager()
     or exists (
       select 1
       from public.specialty_opportunities o
       where o.id = p_opportunity_id
         and (
           public.specialty_member_capability(o.team_id, 'view')
           -- An 'agency' visibility team is readable by any Specialty member.
           -- Unused by the initial two teams, which are both 'team'.
           or (o.team_id in (select t.id from public.quoting_teams t
                              where t.team_visibility = 'agency' and t.is_active)
               and public.specialty_can_access())
         )
     );
$$;

comment on function public.specialty_can_view_opportunity(uuid) is
  'Read access to one opportunity. Team membership or management — deliberately never primary_assignee_id = auth.uid(), which is incompatible with collaborative team quoting. Spec section 89.';

create or replace function public.specialty_can_edit_opportunity(p_opportunity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.specialty_is_manager()
     or exists (
       select 1
       from public.specialty_opportunities o
       join public.quoting_teams t on t.id = o.team_id
       where o.id = p_opportunity_id
         and public.specialty_member_capability(o.team_id, 'edit')
         and (
           -- The collaboration rule. When a team is collaborative (the default and
           -- the setting both initial teams use), every editing member may work
           -- every one of the team's opportunities: Oscar edits Jason's trucking
           -- quote, Jason edits Brenda's homeowners quote. A team that turns the
           -- setting off falls back to assignee-only editing.
           t.collaborative_editing
           or o.primary_assignee_id = auth.uid()
         )
     );
$$;

comment on function public.specialty_can_edit_opportunity(uuid) is
  'Write access to one opportunity and its children. Collaborative by default: assignment does not restrict editing. Spec sections 10, 44, 47, 48, 90.';

create or replace function public.specialty_can_claim_opportunity(p_opportunity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.specialty_opportunities o
    where o.id = p_opportunity_id
      and (
        public.specialty_member_capability(o.team_id, 'claim')
        or public.specialty_is_manager()
      )
  );
$$;

create or replace function public.specialty_can_reassign_opportunity(p_opportunity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.specialty_opportunities o
    where o.id = p_opportunity_id
      and (
        public.specialty_member_capability(o.team_id, 'reassign')
        or public.specialty_is_manager()
      )
  );
$$;

create or replace function public.specialty_can_view_reports()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.specialty_is_manager()
     or exists (
       select 1
       from public.quoting_team_members m
       join public.quoting_teams t on t.id = m.team_id
       join public.profiles p on p.id = m.profile_id
       where m.profile_id = auth.uid()
         and m.is_active and m.can_view_reports
         and t.is_active and p.is_active
     );
$$;

grant execute on function public.specialty_can_view_opportunity(uuid) to authenticated;
grant execute on function public.specialty_can_edit_opportunity(uuid) to authenticated;
grant execute on function public.specialty_can_claim_opportunity(uuid) to authenticated;
grant execute on function public.specialty_can_reassign_opportunity(uuid) to authenticated;
grant execute on function public.specialty_can_view_reports() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. CARRIER MARKETS
--
--    The core feature (spec section 39). Each carrier the opportunity is placed
--    with has its own status, its own dates, its own premium and its own history.
--    A five-market quote is one opportunity with five children.
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.specialty_carrier_markets (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,
  carrier_id uuid not null references public.specialty_carriers(id),

  status text not null default 'not_started' check (status in (
    'not_started', 'preparing', 'submitted', 'waiting', 'more_info_needed',
    'quote_received', 'declined', 'not_competitive', 'withdrawn'
  )),

  -- Who is working this particular market. Optional: an unset value means whoever
  -- on the team picks it up, which is the normal case.
  handled_by uuid references public.profiles(id),

  submitted_at timestamptz,
  submitted_by uuid references public.profiles(id),
  last_action_at timestamptz not null default now(),
  last_action_by uuid references public.profiles(id),
  follow_up_date date,

  -- Quote result. Not required for every line of business (spec section 40).
  premium numeric(12, 2) check (premium is null or premium >= 0),
  down_payment numeric(12, 2) check (down_payment is null or down_payment >= 0),
  payment_terms text,
  deductible text,
  coverage_notes text,
  quote_received_at timestamptz,
  quote_received_by uuid references public.profiles(id),

  decline_reason text,
  info_requested text,
  notes text,

  -- Set when this market's price actually went to the customer. A quote received
  -- is NOT a price sent (spec section 46).
  presented_at timestamptz,

  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,

  -- One market per carrier per opportunity: "Progressive" is a status on this
  -- quote, not a second quote.
  unique (opportunity_id, carrier_id),

  constraint specialty_carrier_markets_declined_needs_reason
    check (status <> 'declined' or nullif(btrim(coalesce(decline_reason, '')), '') is not null),
  constraint specialty_carrier_markets_quote_needs_premium
    check (status <> 'quote_received' or premium is not null)
);

comment on table public.specialty_carrier_markets is
  'One carrier being worked for one opportunity, with its own status, submission date, premium, documents and notes. Spec sections 39-45.';

create index if not exists specialty_carrier_markets_opportunity_idx
  on public.specialty_carrier_markets (opportunity_id, status);
create index if not exists specialty_carrier_markets_carrier_idx
  on public.specialty_carrier_markets (carrier_id, status);
create index if not exists specialty_carrier_markets_followup_idx
  on public.specialty_carrier_markets (follow_up_date)
  where follow_up_date is not null and status in ('submitted', 'waiting', 'more_info_needed');

drop trigger if exists specialty_carrier_markets_touch on public.specialty_carrier_markets;
create trigger specialty_carrier_markets_touch
  before update on public.specialty_carrier_markets
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. CHECKLIST ITEMS
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.specialty_checklist_items (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,
  category text not null,
  label text not null check (char_length(btrim(label)) > 0),
  position integer not null default 0,
  is_required boolean not null default false,
  -- true for anything a team member added by hand rather than the template seeding.
  is_custom boolean not null default false,
  is_checked boolean not null default false,
  checked_by uuid references public.profiles(id),
  checked_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists specialty_checklist_items_opportunity_idx
  on public.specialty_checklist_items (opportunity_id, position);

drop trigger if exists specialty_checklist_items_touch on public.specialty_checklist_items;
create trigger specialty_checklist_items_touch
  before update on public.specialty_checklist_items
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. INFORMATION REQUESTS — the Information Needed loop
--
--    Kept separate from the checklist because it answers a different question and
--    has a different audience. A checklist item is an internal quoting step; an
--    information request is a specific thing the customer or Customer Service has
--    to supply, and it is the one specialty detail Customer Service is shown in
--    Quote Center (spec sections 22, 23, 82).
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.specialty_information_requests (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,
  label text not null check (char_length(btrim(label)) > 0),
  status text not null default 'needed'
    check (status in ('needed', 'requested', 'received', 'waived')),
  note text,
  -- Whether Customer Service sees this item on the customer's journey. Internal
  -- carrier-strategy items can be hidden; the default is to tell CS, because the
  -- whole point is that CS can answer the customer's callback (spec section 82).
  visible_to_cs boolean not null default true,
  requested_at timestamptz,
  requested_by uuid references public.profiles(id),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.specialty_information_requests is
  'Structured missing-information list. Outstanding items are what put an opportunity in Information Needed and what Customer Service sees when the customer calls back. Spec sections 23, 27, 82.';

create index if not exists specialty_information_requests_opportunity_idx
  on public.specialty_information_requests (opportunity_id, status);
create index if not exists specialty_information_requests_open_idx
  on public.specialty_information_requests (opportunity_id)
  where status in ('needed', 'requested');

drop trigger if exists specialty_information_requests_touch on public.specialty_information_requests;
create trigger specialty_information_requests_touch
  before update on public.specialty_information_requests
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. NOTES — append-only
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.specialty_notes (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,
  carrier_market_id uuid references public.specialty_carrier_markets(id) on delete set null,
  author_id uuid not null references public.profiles(id),
  content text not null check (char_length(btrim(content)) > 0),
  -- true when Customer Service may read it. CS notes and replies to CS are
  -- visible; internal carrier strategy is not.
  is_cs_visible boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.specialty_notes is
  'Notes from any eligible team member on any of the team''s opportunities, regardless of who is assigned. No update and no delete policy: history is not rewritten. Spec section 47.';

create index if not exists specialty_notes_opportunity_idx
  on public.specialty_notes (opportunity_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. DOCUMENTS
--
--    storage_bucket is a column rather than a constant because a legacy-adopted
--    opportunity's attachments already live in `commercial-quote-attachments` and
--    copying the bytes between buckets would risk the files to gain nothing.
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.specialty_documents (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,
  carrier_market_id uuid references public.specialty_carrier_markets(id) on delete set null,
  uploaded_by uuid not null references public.profiles(id),
  file_name text not null check (char_length(btrim(file_name)) > 0),
  file_size bigint not null check (file_size > 0),
  mime_type text not null,
  storage_bucket text not null default 'specialty-quote-documents'
    check (storage_bucket in ('specialty-quote-documents', 'commercial-quote-attachments')),
  storage_path text not null,
  category text not null default 'other' check (category in (
    'loss_runs', 'declarations', 'registration', 'driver_license',
    'carrier_proposal', 'quote_pdf', 'photos', 'underwriting', 'other'
  )),
  created_at timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);

comment on column public.specialty_documents.storage_bucket is
  'Which bucket holds the bytes. Adopted legacy documents keep pointing at commercial-quote-attachments rather than being copied; the download route signs whichever bucket the row names.';

create index if not exists specialty_documents_opportunity_idx
  on public.specialty_documents (opportunity_id, created_at desc);
create index if not exists specialty_documents_market_idx
  on public.specialty_documents (carrier_market_id) where carrier_market_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. PRICE PRESENTATIONS
--
--    An explicit record of what actually went to the customer. `options` is a
--    snapshot, on purpose: what was quoted at the time is a historical fact and
--    must not change when a carrier market is later updated (spec section 46).
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.specialty_price_presentations (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,
  presented_by uuid not null references public.profiles(id),
  presented_at timestamptz not null default now(),
  method text check (method in ('phone', 'whatsapp', 'sms', 'email', 'in_person', 'other')),
  note text,
  options jsonb not null default '[]',
  created_at timestamptz not null default now()
);

comment on table public.specialty_price_presentations is
  'One delivery of pricing to the customer. options is a frozen snapshot of the carriers and amounts presented, so later edits to a carrier market cannot rewrite what the customer was told. Spec sections 31, 46.';

create index if not exists specialty_price_presentations_opportunity_idx
  on public.specialty_price_presentations (opportunity_id, presented_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. ACTIVITY — one timeline per opportunity
--
--    actor_profile_id is always the user who performed the action. It is never
--    derived from the primary assignee (spec sections 12, 13, 91): that is exactly
--    the mistake that would credit Jason for Oscar's Canal submission.
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.specialty_activity (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,
  carrier_market_id uuid references public.specialty_carrier_markets(id) on delete set null,
  actor_profile_id uuid references public.profiles(id),
  event_type text not null check (event_type in (
    'opportunity_created', 'intake_received', 'legacy_adopted',
    'claimed', 'reassigned', 'unassigned',
    'stage_changed', 'field_updated', 'priority_changed', 'next_action_set',
    'note_added',
    'document_uploaded', 'document_deleted',
    'checklist_item_added', 'checklist_item_toggled',
    'information_requested', 'information_received', 'information_waived',
    'carrier_added', 'carrier_updated', 'carrier_submitted',
    'carrier_quote_received', 'carrier_declined', 'carrier_withdrawn', 'carrier_removed',
    'price_sent', 'result_recorded', 'result_cleared', 'team_changed'
  )),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

comment on table public.specialty_activity is
  'The single chronological history of an opportunity, including everything its carrier markets did. Append-only: no update and no delete policy. Every row records the user who actually acted. Spec sections 13, 49, 91.';

create index if not exists specialty_activity_opportunity_idx
  on public.specialty_activity (opportunity_id, created_at desc);
create index if not exists specialty_activity_actor_idx
  on public.specialty_activity (actor_profile_id, created_at desc);
create index if not exists specialty_activity_type_idx
  on public.specialty_activity (event_type, created_at desc);

-- Every recorded action refreshes the opportunity's last-activity clock, so the
-- aging and "no recent activity" reports (spec sections 71, 77) have one source
-- and cannot be fooled by a write that forgot to touch it.
create or replace function public.specialty_touch_last_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.specialty_opportunities
     set last_activity_at = greatest(last_activity_at, new.created_at)
   where id = new.opportunity_id;
  return new;
end;
$$;

drop trigger if exists specialty_activity_touch_parent on public.specialty_activity;
create trigger specialty_activity_touch_parent
  after insert on public.specialty_activity
  for each row execute function public.specialty_touch_last_activity();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. STORAGE
-- ═══════════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit)
values ('specialty-quote-documents', 'specialty-quote-documents', false, 104857600)
on conflict (id) do update
  set public = false,
      file_size_limit = 104857600;

-- Path convention: <opportunity_id>/<uuid>.<ext>. Only the first segment is
-- authoritative. The uuid shape is validated as text before any cast, so a crafted
-- object name is refused rather than raising.
create or replace function public.specialty_can_access_document_object(p_object_name text)
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
  v_head := split_part(coalesce(p_object_name, ''), '/', 1);
  if v_head !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.specialty_can_view_opportunity(v_head::uuid);
end;
$$;

comment on function public.specialty_can_access_document_object(text) is
  'Storage gate for specialty-quote-documents. The first path segment names the opportunity; its shape is checked as text before the cast so a malformed name denies instead of erroring. Mirrors the cancellation-evidence pattern from v1.10.8.';

grant execute on function public.specialty_can_access_document_object(text) to authenticated;

drop policy if exists specialty_documents_storage_v1161_select on storage.objects;
create policy specialty_documents_storage_v1161_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'specialty-quote-documents'
    and public.specialty_can_access_document_object(name)
  );

drop policy if exists specialty_documents_storage_v1161_insert on storage.objects;
create policy specialty_documents_storage_v1161_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'specialty-quote-documents'
    and public.specialty_can_access_document_object(name)
  );

drop policy if exists specialty_documents_storage_v1161_delete on storage.objects;
create policy specialty_documents_storage_v1161_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'specialty-quote-documents'
    and public.specialty_can_access_document_object(name)
  );

-- No update policy: a document is added or removed, never overwritten in place, so
-- an upload with upsert:true fails by design.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. ROW LEVEL SECURITY
--
--    The same team authorization protects the opportunity AND every child table.
--    Securing the parent while leaving carrier markets or notes readable would
--    defeat the whole boundary (spec section 90).
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.specialty_opportunities enable row level security;
alter table public.specialty_carrier_markets enable row level security;
alter table public.specialty_checklist_items enable row level security;
alter table public.specialty_information_requests enable row level security;
alter table public.specialty_notes enable row level security;
alter table public.specialty_documents enable row level security;
alter table public.specialty_price_presentations enable row level security;
alter table public.specialty_activity enable row level security;

-- ── Opportunity.
-- No insert policy: opportunities are born from the intake routing RPC, the legacy
-- adoption migration, or the manager RPC — all security definer. Nothing creates
-- one from the browser.
drop policy if exists specialty_opportunities_v1161_select on public.specialty_opportunities;
create policy specialty_opportunities_v1161_select
  on public.specialty_opportunities for select to authenticated
  using (public.specialty_can_view_opportunity(id));

-- Direct UPDATE is allowed for the collaborative field edits the drawer performs.
-- The stage, assignment, pricing and result columns are additionally protected by
-- a trigger below, because those transitions must be server-validated and audited
-- (spec section 88) and a raw PATCH must not be able to reach them.
drop policy if exists specialty_opportunities_v1161_update on public.specialty_opportunities;
create policy specialty_opportunities_v1161_update
  on public.specialty_opportunities for update to authenticated
  using (public.specialty_can_edit_opportunity(id))
  with check (public.specialty_can_edit_opportunity(id));

-- Deleting an opportunity would delete its history. Management removes work by
-- recording Not Sold with a reason, so there is no delete policy at all.

-- Protected columns may only change from inside a security definer RPC. The RPCs
-- set specialty.privileged for the duration of their own transaction.
create or replace function public.specialty_guard_protected_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('specialty.privileged', true), 'off') = 'on' then
    return new;
  end if;

  if new.stage is distinct from old.stage
     or new.primary_assignee_id is distinct from old.primary_assignee_id
     or new.team_id is distinct from old.team_id
     or new.result is distinct from old.result
     or new.lost_reason is distinct from old.lost_reason
     or new.sold_premium is distinct from old.sold_premium
     or new.bound_carrier_id is distinct from old.bound_carrier_id
     or new.price_sent_at is distinct from old.price_sent_at
     or new.finalized_at is distinct from old.finalized_at
     or new.claimed_at is distinct from old.claimed_at
     or new.source_intake_id is distinct from old.source_intake_id
     or new.legacy_commercial_quote_id is distinct from old.legacy_commercial_quote_id then
    raise exception 'Stage, assignment, pricing and result changes must go through the Specialty Quotes actions so they can be validated and recorded.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.specialty_guard_protected_columns() is
  'Refuses a direct UPDATE that touches a transition column. Those live in security definer RPCs which validate, stamp timestamps and write activity; a raw PATCH would skip all three. Spec section 88.';

drop trigger if exists specialty_opportunities_guard on public.specialty_opportunities;
create trigger specialty_opportunities_guard
  before update on public.specialty_opportunities
  for each row execute function public.specialty_guard_protected_columns();

-- ── Carrier markets. Full CRUD for any editing team member: any eligible member
--    may work any carrier market on the team's opportunity (spec section 44).
drop policy if exists specialty_carrier_markets_v1161_select on public.specialty_carrier_markets;
create policy specialty_carrier_markets_v1161_select
  on public.specialty_carrier_markets for select to authenticated
  using (public.specialty_can_view_opportunity(opportunity_id));

drop policy if exists specialty_carrier_markets_v1161_insert on public.specialty_carrier_markets;
create policy specialty_carrier_markets_v1161_insert
  on public.specialty_carrier_markets for insert to authenticated
  with check (public.specialty_can_edit_opportunity(opportunity_id) and created_by = auth.uid());

drop policy if exists specialty_carrier_markets_v1161_update on public.specialty_carrier_markets;
create policy specialty_carrier_markets_v1161_update
  on public.specialty_carrier_markets for update to authenticated
  using (public.specialty_can_edit_opportunity(opportunity_id))
  with check (public.specialty_can_edit_opportunity(opportunity_id));

drop policy if exists specialty_carrier_markets_v1161_delete on public.specialty_carrier_markets;
create policy specialty_carrier_markets_v1161_delete
  on public.specialty_carrier_markets for delete to authenticated
  using (
    public.specialty_can_edit_opportunity(opportunity_id)
    -- A market that was actually submitted is part of the marketing history and is
    -- withdrawn rather than erased.
    and submitted_at is null
  );

-- ── Checklist items.
drop policy if exists specialty_checklist_items_v1161_select on public.specialty_checklist_items;
create policy specialty_checklist_items_v1161_select
  on public.specialty_checklist_items for select to authenticated
  using (public.specialty_can_view_opportunity(opportunity_id));

drop policy if exists specialty_checklist_items_v1161_insert on public.specialty_checklist_items;
create policy specialty_checklist_items_v1161_insert
  on public.specialty_checklist_items for insert to authenticated
  with check (public.specialty_can_edit_opportunity(opportunity_id) and created_by = auth.uid());

drop policy if exists specialty_checklist_items_v1161_update on public.specialty_checklist_items;
create policy specialty_checklist_items_v1161_update
  on public.specialty_checklist_items for update to authenticated
  using (public.specialty_can_edit_opportunity(opportunity_id))
  with check (public.specialty_can_edit_opportunity(opportunity_id));

drop policy if exists specialty_checklist_items_v1161_delete on public.specialty_checklist_items;
create policy specialty_checklist_items_v1161_delete
  on public.specialty_checklist_items for delete to authenticated
  using (public.specialty_can_edit_opportunity(opportunity_id) and is_custom);

-- ── Information requests. Also readable by Customer Service through the
--    quote-center RPC in v1.16.5, which is security definer and filters to
--    visible_to_cs; CS has no direct read here.
drop policy if exists specialty_information_requests_v1161_select on public.specialty_information_requests;
create policy specialty_information_requests_v1161_select
  on public.specialty_information_requests for select to authenticated
  using (public.specialty_can_view_opportunity(opportunity_id));

drop policy if exists specialty_information_requests_v1161_insert on public.specialty_information_requests;
create policy specialty_information_requests_v1161_insert
  on public.specialty_information_requests for insert to authenticated
  with check (public.specialty_can_edit_opportunity(opportunity_id) and created_by = auth.uid());

drop policy if exists specialty_information_requests_v1161_update on public.specialty_information_requests;
create policy specialty_information_requests_v1161_update
  on public.specialty_information_requests for update to authenticated
  using (public.specialty_can_edit_opportunity(opportunity_id))
  with check (public.specialty_can_edit_opportunity(opportunity_id));

-- ── Notes. Insert requires authorship, so a note cannot be attributed to someone
--    else. No update, no delete: nobody rewrites another employee's history.
drop policy if exists specialty_notes_v1161_select on public.specialty_notes;
create policy specialty_notes_v1161_select
  on public.specialty_notes for select to authenticated
  using (public.specialty_can_view_opportunity(opportunity_id));

drop policy if exists specialty_notes_v1161_insert on public.specialty_notes;
create policy specialty_notes_v1161_insert
  on public.specialty_notes for insert to authenticated
  with check (public.specialty_can_edit_opportunity(opportunity_id) and author_id = auth.uid());

-- ── Documents. Metadata rows; the bytes are gated separately by the storage
--    policies above.
drop policy if exists specialty_documents_v1161_select on public.specialty_documents;
create policy specialty_documents_v1161_select
  on public.specialty_documents for select to authenticated
  using (public.specialty_can_view_opportunity(opportunity_id));

drop policy if exists specialty_documents_v1161_insert on public.specialty_documents;
create policy specialty_documents_v1161_insert
  on public.specialty_documents for insert to authenticated
  with check (
    public.specialty_can_edit_opportunity(opportunity_id)
    and uploaded_by = auth.uid()
    -- A legacy pointer is only ever created by the adoption migration.
    and storage_bucket = 'specialty-quote-documents'
  );

drop policy if exists specialty_documents_v1161_delete on public.specialty_documents;
create policy specialty_documents_v1161_delete
  on public.specialty_documents for delete to authenticated
  using (
    (uploaded_by = auth.uid() or public.specialty_is_manager())
    and public.specialty_can_edit_opportunity(opportunity_id)
    and storage_bucket = 'specialty-quote-documents'
  );

-- ── Price presentations. Append-only: what the customer was told is a fact.
drop policy if exists specialty_price_presentations_v1161_select on public.specialty_price_presentations;
create policy specialty_price_presentations_v1161_select
  on public.specialty_price_presentations for select to authenticated
  using (public.specialty_can_view_opportunity(opportunity_id));

-- ── Activity. Read for anyone who can see the opportunity. Inserts arrive only
--    from the security definer RPCs, so there is no insert policy, and no update or
--    delete policy either.
drop policy if exists specialty_activity_v1161_select on public.specialty_activity;
create policy specialty_activity_v1161_select
  on public.specialty_activity for select to authenticated
  using (public.specialty_can_view_opportunity(opportunity_id));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. REALTIME
--    Teammates should see each other's updates without reloading (spec section 93).
--    The client subscribes to change notifications and refetches; it never trusts a
--    payload as data.
-- ═══════════════════════════════════════════════════════════════════════════════

do $$ begin alter publication supabase_realtime add table public.specialty_opportunities; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.specialty_carrier_markets; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.specialty_activity; exception when duplicate_object then null; end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 13. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════

do $post$
declare
  v_missing text;
  v_unprotected text;
begin
  select string_agg(t.name, ', ' order by t.name) into v_missing
    from (values ('specialty_opportunities'), ('specialty_carrier_markets'),
                 ('specialty_checklist_items'), ('specialty_information_requests'),
                 ('specialty_notes'), ('specialty_documents'),
                 ('specialty_price_presentations'), ('specialty_activity')) as t(name)
   where not exists (select 1 from pg_tables where schemaname = 'public' and tablename = t.name);
  if v_missing is not null then
    raise exception 'v1.16.1 did not create: %', v_missing using hint = 'Rolling back.';
  end if;

  -- Every specialty table must have RLS on. A child table left open is the failure
  -- spec section 90 is about.
  select string_agg(c.relname, ', ' order by c.relname) into v_unprotected
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname like 'specialty\_%'
     and c.relkind = 'r'
     and not c.relrowsecurity;
  if v_unprotected is not null then
    raise exception 'v1.16.1 left RLS disabled on: %', v_unprotected using hint = 'Rolling back.';
  end if;

  -- Every specialty table must actually carry at least one policy.
  select string_agg(c.relname, ', ' order by c.relname) into v_unprotected
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname like 'specialty\_%'
     and c.relkind = 'r'
     and not exists (select 1 from pg_policies pp
                     where pp.schemaname = 'public' and pp.tablename = c.relname);
  if v_unprotected is not null then
    raise exception 'v1.16.1 left policy-less specialty table(s): %', v_unprotected using hint = 'Rolling back.';
  end if;

  -- The collaboration rule, asserted rather than trusted: no specialty policy may
  -- gate on the primary assignee. That model is what spec section 89 forbids.
  select string_agg(policyname, ', ' order by policyname) into v_unprotected
    from pg_policies
   where schemaname = 'public'
     and tablename like 'specialty\_%'
     and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%primary_assignee_id = auth.uid()%';
  if v_unprotected is not null then
    raise exception 'v1.16.1 wrote assignee-gated policy(ies): %. Editing must be team-scoped.', v_unprotected
      using hint = 'Rolling back.';
  end if;

  if not exists (select 1 from storage.buckets where id = 'specialty-quote-documents' and not public) then
    raise exception 'v1.16.1 did not create a private specialty-quote-documents bucket' using hint = 'Rolling back.';
  end if;
end
$post$;

commit;

select
  (select count(*) from pg_policies where schemaname = 'public' and tablename like 'specialty\_%') as specialty_policies,
  (select count(*) from pg_policies where schemaname = 'storage' and policyname like 'specialty\_documents\_storage%') as storage_policies_expect_3,
  (select count(*) from public.specialty_opportunities) as opportunities_expect_0;

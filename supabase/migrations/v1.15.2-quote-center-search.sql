-- New Hope Work Desk v1.15.2 — One search across the whole quote journey.
--
-- The problem this solves: a customer is on the phone and the employee has to
-- know where their quote is. Today that answer is spread over an intake list, a
-- shared queue, a pending-pricing list and two quote databases, and the employee
-- has to guess which one to look in. Worse, a converted intake and the quote it
-- became appear as two separate records, so the same customer looks like two
-- customers.
--
-- The model here is a READ model. Nothing is migrated into a new table, no record
-- is merged or deleted, and every existing lifecycle table stays authoritative:
--
--   quote_center_quote_stage  one row per quote identity, at its furthest stage
--   quote_center_journeys     one row per JOURNEY (intake + its quote collapsed)
--   quote_center_search       role-gated, paginated, server-side search
--   quote_center_duplicate_check  the same journeys, matched on identity signals
--   quote_center_journey      one journey, for the detail drawer
--   quote_center_timeline     intake events + quote events + notes, merged
--
-- ── Why a journey is not a table row ─────────────────────────────────────────
--
-- A quote's identity is stable (`source_work_item_id`) but its ROW moves between
-- three tables as it advances, and is deleted from the previous one each time:
-- work_items → pending_pricing_quotes → quote_outcomes. So "the current stage of
-- quote X" means "the furthest of the three tables X currently appears in", which
-- is what quote_center_quote_stage computes with `distinct on ... order by
-- stage_rank desc`. This is also why the journey cannot be double counted: the
-- collapse happens before anything is counted.
--
-- ── Performance, stated honestly ─────────────────────────────────────────────
--
-- The journey view is scanned rather than index-seeked, because a view over a
-- UNION with DISTINCT ON cannot be indexed. At the live volume — 353 intakes and
-- roughly 2,600 quote rows across the three tables — that scan is far cheaper
-- than the current alternative, which ships 5,000 work_items, 10,000 outcomes,
-- 20,000 notes and 30,000 events to the browser on every page load and filters
-- them in JavaScript.
--
-- The trigram and expression indexes added below are what keep the *direct*
-- lookups (duplicate check on phone, e-mail, VIN) index-seeked, and they are what
-- the journey view will need when it is promoted to a materialized view. That
-- promotion is the documented growth path and is deliberately not done now: a
-- materialized view needs a refresh strategy, and a stale Quote Center during a
-- live call is worse than a scan of three thousand rows.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Search helpers and indexes
-- ═══════════════════════════════════════════════════════════════════════════════

create extension if not exists pg_trgm;

-- Immutable, so it can be used in an expression index. Searching 7045551212 has
-- to find a number stored as (704) 555-1212, which means both sides must be
-- reduced to digits by the same function.
create or replace function public.nhwd_digits(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $fn$
  select regexp_replace(coalesce(p_text, ''), '[^0-9]', '', 'g');
$fn$;

comment on function public.nhwd_digits(text) is
  'Reduces a phone number to digits so a search for 7045551212 finds (704) 555-1212. Immutable so expression indexes can use it.';

grant execute on function public.nhwd_digits(text) to authenticated;

-- Escapes a user query for use as an ILIKE pattern, so a customer whose name
-- contains % or _ is searched literally instead of turning into a wildcard.
create or replace function public.nhwd_like_pattern(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $fn$
  select '%' || replace(replace(replace(coalesce(p_text, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
$fn$;

grant execute on function public.nhwd_like_pattern(text) to authenticated;

-- ── Intake search indexes ────────────────────────────────────────────────────
create index if not exists cs_intake_phone_digits_idx
  on public.cs_intake_submissions (public.nhwd_digits(insured_phone_primary))
  where insured_phone_primary is not null;

create index if not exists cs_intake_phone_alt_digits_idx
  on public.cs_intake_submissions (public.nhwd_digits(insured_phone_alt))
  where insured_phone_alt is not null;

create index if not exists cs_intake_email_lower_idx
  on public.cs_intake_submissions (lower(insured_email))
  where insured_email is not null;

create index if not exists cs_intake_dob_last_name_idx
  on public.cs_intake_submissions (insured_dob, lower(insured_last_name))
  where insured_dob is not null;

create index if not exists cs_intake_name_trgm_idx
  on public.cs_intake_submissions
  using gin ((coalesce(insured_first_name, '') || ' ' || coalesce(insured_last_name, '')) gin_trgm_ops);

create index if not exists cs_intake_business_trgm_idx
  on public.cs_intake_submissions using gin (coalesce(business_name, '') gin_trgm_ops);

create index if not exists cs_intake_city_trgm_idx
  on public.cs_intake_submissions using gin (coalesce(addr_city, '') gin_trgm_ops);

create index if not exists cs_intake_street_trgm_idx
  on public.cs_intake_submissions using gin (coalesce(addr_street, '') gin_trgm_ops);

create index if not exists cs_intake_dot_idx
  on public.cs_intake_submissions (dot_number)
  where dot_number is not null;

create index if not exists cs_intake_vehicles_vin_idx
  on public.cs_intake_vehicles (upper(vin))
  where vin is not null;

-- ── Quote search indexes ─────────────────────────────────────────────────────
create index if not exists work_items_customer_trgm_idx
  on public.work_items using gin (customer_name gin_trgm_ops);

create index if not exists pending_pricing_customer_trgm_idx
  on public.pending_pricing_quotes using gin (customer_name gin_trgm_ops);

create index if not exists quote_outcomes_customer_trgm_idx
  on public.quote_outcomes using gin (customer_name gin_trgm_ops);

create index if not exists quote_notes_source_created_idx
  on public.quote_notes (source_work_item_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. quote_center_quote_stage — one row per quote identity, furthest stage wins
-- ═══════════════════════════════════════════════════════════════════════════════

drop view if exists public.quote_center_journeys cascade;
drop view if exists public.quote_center_quote_stage cascade;

create view public.quote_center_quote_stage as
select distinct on (t.source_work_item_id)
  t.source_work_item_id,
  t.stage_rank,
  t.stage,
  t.stage_label,
  t.customer_name,
  t.dealer_id,
  t.salesperson_id,
  t.work_type,
  t.assigned_profile_id,
  t.original_owner_profile_id,
  t.assignment_method,
  t.received_through,
  t.quote_created_at,
  t.assigned_at,
  t.accepted_at,
  t.price_sent_at,
  t.decision,
  t.not_sold_reason,
  t.finalized_at,
  t.last_activity_at,
  t.is_voided
from (
  -- Stage 1: the quote is still active work.
  select
    w.id                                              as source_work_item_id,
    1                                                 as stage_rank,
    (case when w.status::text = 'active' then 'working' else 'closed' end)::text as stage,
    (case w.status::text
       when 'active' then (case when w.work_type::text = 'requote' then 'Requote' else 'Quoting' end)
       when 'completed' then 'Completed'
       when 'cancelled' then 'Cancelled'
       else initcap(w.status::text)
     end)::text                                       as stage_label,
    w.customer_name::text                             as customer_name,
    w.dealer_id,
    w.salesperson_id,
    w.work_type::text                                 as work_type,
    w.assigned_profile_id,
    w.original_owner_profile_id,
    w.assignment_method::text                         as assignment_method,
    w.received_through::text                          as received_through,
    w.created_at                                      as quote_created_at,
    w.assigned_at,
    w.accepted_at,
    null::timestamptz                                 as price_sent_at,
    null::text                                        as decision,
    null::text                                        as not_sold_reason,
    null::timestamptz                                 as finalized_at,
    greatest(w.created_at, coalesce(w.updated_at, w.created_at)) as last_activity_at,
    coalesce(w.is_voided, false)                      as is_voided
  from public.work_items w
  where w.work_type::text in ('new_quote', 'requote')

  union all

  -- Stage 2: pricing has been sent and the source has not decided yet.
  select
    p.source_work_item_id,
    2,
    'price_sent'::text,
    'Price Sent'::text,
    p.customer_name::text,
    p.dealer_id,
    p.salesperson_id,
    p.work_type::text,
    p.assigned_profile_id,
    p.original_owner_profile_id,
    p.assignment_method::text,
    p.received_through::text,
    p.quote_created_at,
    p.assigned_at,
    p.accepted_at,
    p.price_sent_at,
    null::text,
    null::text,
    null::timestamptz,
    greatest(p.price_sent_at, coalesce(p.updated_at, p.price_sent_at)),
    false
  from public.pending_pricing_quotes p

  union all

  -- Stage 3: decided. Sold and Not Sold are both first-class history.
  -- The decision is lowercased because public.quote_decision carries a stray
  -- 'Sold' label alongside 'sold' (recorded in v1.12.7).
  select
    o.source_work_item_id,
    3,
    'closed'::text,
    (case when lower(o.decision::text) = 'sold' then 'Sold' else 'Not Sold' end)::text,
    o.customer_name::text,
    o.dealer_id,
    o.salesperson_id,
    o.work_type::text,
    o.assigned_profile_id,
    o.original_owner_profile_id,
    o.assignment_method::text,
    o.received_through::text,
    o.quote_created_at,
    o.assigned_at,
    o.accepted_at,
    o.price_sent_at,
    lower(o.decision::text),
    o.not_sold_reason::text,
    o.finalized_at,
    o.finalized_at,
    false
  from public.quote_outcomes o
) t
order by t.source_work_item_id, t.stage_rank desc, t.last_activity_at desc;

comment on view public.quote_center_quote_stage is
  'One row per stable quote identity, reporting the furthest lifecycle stage that identity currently occupies. A quote row is deleted from work_items when it is priced and from pending_pricing_quotes when it is decided, so "current stage" means "furthest table it still appears in". The DISTINCT ON is what prevents a journey being counted twice when rows briefly coexist.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. quote_center_journeys — one row per journey
-- ═══════════════════════════════════════════════════════════════════════════════
-- An intake and the quote it became are ONE journey and produce ONE row. A quote
-- created without an intake produces its own row. A draft with no quote yet
-- produces its own row. Nothing is merged or deleted to achieve this.

create view public.quote_center_journeys as
-- Intake-anchored journeys: every intake, with its quote's stage attached when
-- there is one.
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
  -- Responsibility, as three distinct facts.
  s.created_by                                        as started_by_id,
  starter.display_name                                as started_by_name,
  s.completed_by                                      as completed_by_id,
  completer.display_name                              as completed_by_name,
  s.last_edited_by                                    as last_edited_by_id,
  editor.display_name                                 as last_edited_by_name,
  coalesce(st.assigned_profile_id, s.claimed_by)      as assigned_profile_id,
  coalesce(assignee.display_name, claimer.display_name) as assigned_agent_name,
  -- Lifecycle. The quote's stage wins when a quote exists, because it is always
  -- further along than the intake that produced it.
  (case
     when st.stage is not null then st.stage
     when s.source_commercial_quote_id is not null then 'working'
     when s.status::text in ('claimed', 'converted') then 'working'
     else 'intake'
   end)::text                                         as stage,
  (case
     when st.stage_label is not null then st.stage_label
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
  st.decision,
  st.not_sold_reason,
  s.created_at                                        as started_at,
  s.submitted_at,
  s.claimed_at,
  s.converted_at,
  st.quote_created_at,
  st.price_sent_at,
  st.finalized_at,
  greatest(
    s.updated_at,
    coalesce(st.last_activity_at, s.updated_at),
    coalesce(s.last_edited_at, s.updated_at)
  )                                                   as last_activity_at,
  coalesce(st.is_voided, false)                       as is_voided,
  s.source_commercial_quote_id,
  s.version                                           as intake_version,
  s.renters_addr_verified,
  s.addr_verified,
  true                                                as has_intake,
  (st.source_work_item_id is not null)                as has_quote,
  -- One text column the search matches against, so every searchable field is
  -- declared in exactly one place.
  lower(concat_ws(' ',
    s.insured_first_name, s.insured_middle_name, s.insured_last_name,
    s.business_name, s.insured_email,
    s.addr_street, s.addr_unit, s.addr_city, s.addr_state, s.addr_zip,
    s.renters_property_address, s.renters_city,
    s.dot_number, d.name, dsp.name, st.received_through, st.customer_name,
    s.id::text, st.source_work_item_id::text
  ))                                                  as search_blob
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

union all

-- Quote-anchored journeys: quotes that were created directly, with no intake.
-- The NOT EXISTS is the other half of the collapse — it is what stops a
-- converted intake's quote appearing a second time as its own result.
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
  ))                                                  as search_blob
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
  'One row per customer quote journey. A converted intake and the quote it became collapse into a single row: the intake side anchors it and the quote side supplies the current stage. A quote with no intake, and an intake with no quote, each anchor their own row. Nothing is merged or deleted in the underlying tables to achieve this.';

-- These views are read only through the security-definer functions below, which
-- apply the role gate. Direct client access would bypass that gate.
revoke all on public.quote_center_quote_stage from authenticated, anon;
revoke all on public.quote_center_journeys from authenticated, anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Role gate
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.can_view_quote_center()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_active
      -- Commercial roles are deliberately absent: commercial quotes have their
      -- own board and database, and this consolidation must not change
      -- commercial routing.
      and p.role::text in (
        'agent',
        'manager',
        'customer_service',
        'super_admin',
        'sales_supervisor',
        'customer_service_supervisor'
      )
  );
$fn$;

grant execute on function public.can_view_quote_center() to authenticated;

comment on function public.can_view_quote_center() is
  'Mirrors viewQuoteCenter in src/features/quote-center/permissions.ts. This function is the enforcing check; the client helper only decides whether to render the screen.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. quote_center_search
-- ═══════════════════════════════════════════════════════════════════════════════
-- Server-side, paginated, and returning only what a result card shows. The
-- detail drawer and the timeline load separately, so opening one journey never
-- costs anything on the search itself.

create or replace function public.quote_center_search(
  p_query text default null,
  p_stage text default 'all',
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  journey_key text,
  intake_id uuid,
  work_item_id uuid,
  customer_name text,
  business_name text,
  phone_primary text,
  email text,
  addr_city text,
  addr_state text,
  line_of_business text,
  work_type text,
  source_label text,
  dealer_name text,
  salesperson_name text,
  started_by_name text,
  completed_by_name text,
  assigned_agent_name text,
  stage text,
  stage_label text,
  intake_status text,
  decision text,
  started_at timestamptz,
  submitted_at timestamptz,
  price_sent_at timestamptz,
  finalized_at timestamptz,
  last_activity_at timestamptz,
  has_intake boolean,
  has_quote boolean,
  is_voided boolean,
  possible_duplicate boolean,
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
  v_stage  text    := lower(coalesce(nullif(btrim(p_stage), ''), 'all'));
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not public.can_view_quote_center() then
    raise exception 'Quote Center is not available for your role.';
  end if;

  if v_stage not in ('all', 'intake', 'working', 'price_sent', 'closed') then
    v_stage := 'all';
  end if;

  v_like   := public.nhwd_like_pattern(lower(v_text));
  v_digits := public.nhwd_digits(v_text);
  -- Fewer than seven digits is an address or a policy fragment, not a phone
  -- number, and matching on it would return most of the agency.
  if length(v_digits) < 7 then
    v_digits := null;
  end if;

  return query
  with filtered as (
    select j.*
    from public.quote_center_journeys j
    where (v_stage = 'all' or j.stage = v_stage)
      and (
        v_text is null
        or j.search_blob like v_like escape '\'
        or (v_digits is not null and (
              j.phone_digits like '%' || v_digits || '%'
              or j.phone_alt_digits like '%' || v_digits || '%'
           ))
        or (j.intake_id is not null and exists (
              select 1
              from public.cs_intake_vehicles v
              where v.submission_id = j.intake_id
                and upper(v.vin) like upper(public.nhwd_like_pattern(v_text)) escape '\'
           ))
      )
  ),
  counted as (
    select f.*, count(*) over () as total_count
    from filtered f
  )
  select
    c.journey_key,
    c.intake_id,
    c.work_item_id,
    c.customer_name,
    c.business_name,
    c.phone_primary,
    c.email,
    c.addr_city,
    c.addr_state,
    c.line_of_business,
    c.work_type,
    c.source_label,
    c.dealer_name,
    c.salesperson_name,
    c.started_by_name,
    c.completed_by_name,
    c.assigned_agent_name,
    c.stage,
    c.stage_label,
    c.intake_status,
    c.decision,
    c.started_at,
    c.submitted_at,
    c.price_sent_at,
    c.finalized_at,
    c.last_activity_at,
    c.has_intake,
    c.has_quote,
    c.is_voided,
    -- A journey is flagged as a possible duplicate when another journey shares
    -- its phone number. It is a prompt for a human to look, never an instruction
    -- to merge: two people can share a phone, and one person can legitimately
    -- have several quote journeys.
    (
      length(c.phone_digits) >= 10
      and exists (
        select 1
        from public.quote_center_journeys o
        where o.journey_key <> c.journey_key
          and o.phone_digits = c.phone_digits
      )
    ) as possible_duplicate,
    c.total_count
  from counted c
  order by c.last_activity_at desc nulls last, c.journey_key
  limit v_limit
  offset v_offset;
end;
$fn$;

revoke execute on function public.quote_center_search(text, text, integer, integer) from public, anon;
grant execute on function public.quote_center_search(text, text, integer, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. quote_center_stage_counts — the filter chips
-- ═══════════════════════════════════════════════════════════════════════════════
-- Counted over journeys, so a converted intake and its quote contribute one, not
-- two.

create or replace function public.quote_center_stage_counts(
  p_query text default null
)
returns table (stage text, journey_count bigint)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_text   text := nullif(btrim(coalesce(p_query, '')), '');
  v_like   text;
  v_digits text;
begin
  if not public.can_view_quote_center() then
    raise exception 'Quote Center is not available for your role.';
  end if;

  v_like   := public.nhwd_like_pattern(lower(v_text));
  v_digits := public.nhwd_digits(v_text);
  if length(v_digits) < 7 then
    v_digits := null;
  end if;

  return query
  select j.stage, count(*)::bigint
  from public.quote_center_journeys j
  where (
      v_text is null
      or j.search_blob like v_like escape '\'
      or (v_digits is not null and (
            j.phone_digits like '%' || v_digits || '%'
            or j.phone_alt_digits like '%' || v_digits || '%'
         ))
    )
  group by j.stage;
end;
$fn$;

revoke execute on function public.quote_center_stage_counts(text) from public, anon;
grant execute on function public.quote_center_stage_counts(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. quote_center_journey — the detail drawer
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.quote_center_journey(
  p_journey_key text
)
returns setof public.quote_center_journeys
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not public.can_view_quote_center() then
    raise exception 'Quote Center is not available for your role.';
  end if;

  return query
  select j.*
  from public.quote_center_journeys j
  where j.journey_key = p_journey_key;
end;
$fn$;

revoke execute on function public.quote_center_journey(text) from public, anon;
grant execute on function public.quote_center_journey(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. quote_center_timeline — one chronological journey
-- ═══════════════════════════════════════════════════════════════════════════════
-- Merges the three append-only logs the journey already writes to, rather than
-- introducing a fourth. An intake note written before conversion and a quote note
-- written after it appear in the same list, in order.

create or replace function public.quote_center_timeline(
  p_intake_id uuid default null,
  p_work_item_id uuid default null
)
returns table (
  occurred_at timestamptz,
  origin text,
  event_type text,
  actor_name text,
  note text,
  detail jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not public.can_view_quote_center() then
    raise exception 'Quote Center is not available for your role.';
  end if;

  if p_intake_id is null and p_work_item_id is null then
    raise exception 'A journey identifier is required.';
  end if;

  return query
  -- The intake half: created, draft_updated, submitted, claimed, converted,
  -- returned, note_added, and the walk-in claim variants.
  select
    e.created_at                                  as occurred_at,
    'intake'::text                                as origin,
    e.event_type::text                            as event_type,
    coalesce(p.display_name, 'System')::text      as actor_name,
    nullif(btrim(coalesce(e.detail ->> 'note', '')), '') as note,
    e.detail
  from public.cs_intake_events e
  left join public.profiles p on p.id = e.actor_id
  where p_intake_id is not null and e.submission_id = p_intake_id

  union all

  -- The quote half: created_from_cs_intake, accepted, reassigned, price_sent,
  -- sold, not_sold, outcome_change, the RingCentral claim events, and so on.
  select
    we.created_at,
    'quote'::text,
    we.event_type::text,
    coalesce(p.display_name, 'System')::text,
    null::text,
    we.details
  from public.work_item_events we
  left join public.profiles p on p.id = we.actor_profile_id
  where p_work_item_id is not null and we.source_work_item_id = p_work_item_id

  union all

  -- Notes on the quote, from anyone, owner or not.
  select
    n.created_at,
    'note'::text,
    'note_added'::text,
    coalesce(p.display_name, 'System')::text,
    n.note,
    null::jsonb
  from public.quote_notes n
  left join public.profiles p on p.id = n.author_profile_id
  where p_work_item_id is not null and n.source_work_item_id = p_work_item_id

  order by 1 asc;
end;
$fn$;

revoke execute on function public.quote_center_timeline(uuid, uuid) from public, anon;
grant execute on function public.quote_center_timeline(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. quote_center_duplicate_check — while a new intake is being started
-- ═══════════════════════════════════════════════════════════════════════════════
-- Reads the same journeys the search reads, so the warning panel can never
-- disagree with what the employee would find by searching. Matching is on
-- identity signals, never on name alone: two people share a name far more often
-- than they share a phone number, and the same person may legitimately have
-- several quote journeys.

create or replace function public.quote_center_duplicate_check(
  p_exclude_intake_id uuid default null,
  p_phone text default null,
  p_email text default null,
  p_first_name text default null,
  p_last_name text default null,
  p_business_name text default null,
  p_dob date default null,
  p_limit integer default 8
)
returns table (
  journey_key text,
  intake_id uuid,
  work_item_id uuid,
  customer_name text,
  business_name text,
  phone_primary text,
  email text,
  addr_city text,
  addr_state text,
  line_of_business text,
  source_label text,
  assigned_agent_name text,
  started_by_name text,
  stage text,
  stage_label text,
  started_at timestamptz,
  last_activity_at timestamptz,
  match_reason text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_phone_digits text := public.nhwd_digits(p_phone);
  v_email        text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_first        text := lower(nullif(btrim(coalesce(p_first_name, '')), ''));
  v_last         text := lower(nullif(btrim(coalesce(p_last_name, '')), ''));
  v_business     text := lower(nullif(btrim(coalesce(p_business_name, '')), ''));
  v_limit        integer := least(greatest(coalesce(p_limit, 8), 1), 25);
begin
  if not public.can_view_quote_center() then
    raise exception 'Quote Center is not available for your role.';
  end if;

  if length(v_phone_digits) < 10 then
    v_phone_digits := null;
  end if;

  -- Nothing identifying has been entered yet, so there is nothing to warn about.
  if v_phone_digits is null
     and v_email is null
     and v_business is null
     and p_dob is null
     and (v_first is null or v_last is null) then
    return;
  end if;

  return query
  select
    j.journey_key,
    j.intake_id,
    j.work_item_id,
    j.customer_name,
    j.business_name,
    j.phone_primary,
    j.email,
    j.addr_city,
    j.addr_state,
    j.line_of_business,
    j.source_label,
    j.assigned_agent_name,
    j.started_by_name,
    j.stage,
    j.stage_label,
    j.started_at,
    j.last_activity_at,
    (case
       when v_phone_digits is not null
            and (j.phone_digits = v_phone_digits or j.phone_alt_digits = v_phone_digits)
         then 'Same phone number'
       when v_email is not null and lower(j.email) = v_email
         then 'Same e-mail address'
       when v_business is not null and lower(j.business_name) = v_business
         then 'Same business name'
       when p_dob is not null and j.insured_dob = p_dob
         then 'Same date of birth and last name'
       else 'Same name'
     end)::text as match_reason
  from public.quote_center_journeys j
  where (p_exclude_intake_id is null or j.intake_id is distinct from p_exclude_intake_id)
    and (
         (v_phone_digits is not null
          and (j.phone_digits = v_phone_digits or j.phone_alt_digits = v_phone_digits))
      or (v_email is not null and lower(j.email) = v_email)
      or (v_business is not null and lower(j.business_name) = v_business)
      or (p_dob is not null and v_last is not null
          and j.insured_dob = p_dob and lower(j.insured_last_name) = v_last)
      or (v_first is not null and v_last is not null
          and lower(j.insured_first_name) = v_first
          and lower(j.insured_last_name) = v_last)
    )
  order by j.last_activity_at desc nulls last
  limit v_limit;
end;
$fn$;

revoke execute on function public.quote_center_duplicate_check(uuid, text, text, text, text, text, date, integer) from public, anon;
grant execute on function public.quote_center_duplicate_check(uuid, text, text, text, text, text, date, integer) to authenticated;

commit;

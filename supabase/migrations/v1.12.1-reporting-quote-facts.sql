-- New Hope Work Desk v1.12.1 — the quote fact dataset
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 4.2, 4.6, 5.1-5.7, 6.1-6.11, 8.1-8.5, 16.1-16.5, 17.1, 17.2
--
-- One reporting row per quote. Today this union is rebuilt in JavaScript on every
-- filter change (work-desk-app.tsx lines 6572-6656) with the three branches filtered
-- on two different timestamps, which is the root cause of the three-different-pending
-- defect. Here it is one view with one definition of identity.
--
-- ── What the live data actually does, and why the shape below is what it is ────
--
-- A quote moves between three tables: work_items while active, pending_pricing_quotes
-- once pricing is sent, quote_outcomes once finalized, and the earlier row is deleted
-- on each move. Measured on 2026-08-03: 4 quote-typed work_items, 60 pending, 1212
-- outcomes, and zero overlap between work_items/pending and pending/outcomes.
--
-- But 36 work_items rows DO share an id with a quote_outcomes row, and every one of
-- them has work_type = 'activation'. When a quote sells, its work_items row is
-- converted in place into an activation task: same id, new work_type. So:
--
--   * The identity set cannot be taken from work_items filtered by work_type — that
--     would lose 36 sold quotes' created_by and is_voided.
--   * The join back to work_items must therefore carry NO work_type filter.
--   * reporting_workload_facts will list those same rows as activations, correctly.
--     A quote fact and a workload fact can share an id, and that is not a duplicate.
--
-- cs_intake_submissions.work_item_id is NULL on all 80 live rows. The intake-to-quote
-- link actually lives in cs_intake_events.detail->>'work_item_id' (49 rows). The
-- duplicate-retry rule reads that, because a rule reading the column would find
-- nothing and silently report zero duplicates.
--
-- ROLLBACK
--   begin;
--     drop view if exists public.reporting_quote_facts;
--     drop view if exists public.reporting_quote_field_changes;
--     drop view if exists public.reporting_quote_event_rollup;
--     drop view if exists public.reporting_quote_base;
--     drop view if exists public.reporting_intake_quote_links;
--   commit;

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. INTAKE LINKS — one row per (intake, quote) pair, from the event detail
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace view public.reporting_intake_quote_links
with (security_invoker = true)
as
select distinct
  e.submission_id                        as intake_id,
  (e.detail ->> 'work_item_id')::uuid    as quote_id,
  min(e.created_at) over (
    partition by e.submission_id, e.detail ->> 'work_item_id'
  )                                      as linked_at
from public.cs_intake_events e
where e.detail ? 'work_item_id'
  and nullif(btrim(e.detail ->> 'work_item_id'), '') is not null;

comment on view public.reporting_intake_quote_links is
  'The intake-to-quote link, read from cs_intake_events.detail. cs_intake_submissions.work_item_id is null on every live row, so the column cannot be used: a rule reading it would find no links and silently report zero duplicate retries.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. BASE — exactly one row per Quote_Identity
--
-- Identity comes from a union of the three lifecycle tables, then each table is
-- joined back. Precedence is outcome, then pending, then active: a quote physically
-- moves, so only the furthest-along row describes its present state.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace view public.reporting_quote_base
with (security_invoker = true)
as
with identity as (
  select id as quote_id from public.work_items where work_type in ('new_quote', 'requote')
  union
  select source_work_item_id from public.pending_pricing_quotes
  union
  select source_work_item_id from public.quote_outcomes
),
outcome_ranked as (
  select
    q.*,
    row_number() over (
      partition by q.source_work_item_id
      order by q.finalized_at desc, q.id desc
    ) as rn,
    count(*) over (partition by q.source_work_item_id) as outcome_record_count
  from public.quote_outcomes q
),
outcome as (
  select * from outcome_ranked where rn = 1
)
select
  i.quote_id,
  case
    when o.id is not null then 'finalized'
    when p.id is not null then 'pending_pricing'
    else 'active'
  end                                                             as lifecycle_stage,
  coalesce(o.quote_created_at, p.quote_created_at, w.created_at)   as created_at,
  coalesce(o.assigned_at, p.assigned_at, w.assigned_at,
           o.quote_created_at, p.quote_created_at, w.created_at)   as assigned_at,
  -- v0.7.0 backfilled accepted_at from the creation timestamp, and dashboard-data.ts
  -- coalesces it again on read, which is why time-to-accept reports zero today for
  -- every backfilled row. Nulling the equal case reports it as unknown instead.
  nullif(
    coalesce(o.accepted_at, p.accepted_at, w.accepted_at),
    coalesce(o.quote_created_at, p.quote_created_at, w.created_at)
  )                                                               as accepted_at,
  coalesce(o.price_sent_at, p.price_sent_at)                       as price_sent_at_column,
  o.finalized_at,
  -- The live quote_decision enum carries a stray 'Sold' label alongside 'sold'. No
  -- row uses it today, but a = 'sold' comparison would miss it if one did.
  case lower(o.decision::text)
    when 'sold'     then 'sold'
    when 'not_sold' then 'not_sold'
    else null
  end                                                             as final_outcome,
  o.not_sold_reason::text                                          as not_sold_reason,
  o.not_sold_reason_other,
  coalesce(o.outcome_record_count, 0)                              as outcome_record_count,
  coalesce(o.customer_name, p.customer_name, w.customer_name)      as customer_name,
  coalesce(o.dealer_id, p.dealer_id, w.dealer_id)                  as dealer_id,
  coalesce(o.salesperson_id, p.salesperson_id, w.salesperson_id)   as salesperson_id,
  coalesce(o.work_type, p.work_type, w.work_type)                  as work_type,
  coalesce(o.assignment_method, p.assignment_method, w.assignment_method)
                                                                   as assignment_method,
  nullif(btrim(coalesce(o.received_through, p.received_through, w.received_through)), '')
                                                                   as received_through,
  coalesce(o.assigned_profile_id, p.assigned_profile_id, w.assigned_profile_id)
                                                                   as assigned_profile_id,
  coalesce(o.original_owner_profile_id, p.original_owner_profile_id,
           w.original_owner_profile_id)                            as original_owner_profile_id,
  -- created_by lives only on work_items. It survives for the 36 sold quotes whose
  -- row was converted to an activation, and is null for the rest; the event rollup
  -- supplies the fallback.
  w.created_by                                                     as created_by_column,
  w.status::text                                                   as work_item_status,
  coalesce(w.is_voided, false)                                     as is_voided,
  w.voided_at,
  w.voided_by,
  w.void_reason,
  w.related_quote_source_work_item_id,
  o.id                                                             as outcome_row_id,
  p.id                                                             as pending_row_id
from identity i
left join public.work_items w             on w.id = i.quote_id
left join public.pending_pricing_quotes p on p.source_work_item_id = i.quote_id
left join outcome o                       on o.source_work_item_id = i.quote_id;

comment on view public.reporting_quote_base is
  'Exactly one row per Quote_Identity, which is work_items.id carried forward as source_work_item_id. Precedence outcome -> pending -> active. The join to work_items carries no work_type filter on purpose: 36 sold quotes had their work_items row converted in place to an activation, and filtering would lose their created_by and is_voided.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. EVENT ROLLUP — everything derived from the event stream
--
-- This is where the credit roles come from. There is no priced_by and no sold_by
-- column anywhere, so pricing and outcome credit exist only as
-- work_item_events.actor_profile_id.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace view public.reporting_quote_event_rollup
with (security_invoker = true)
as
select
  e.source_work_item_id                                            as quote_id,
  min(e.created_at) filter (where e.event_type = 'price_sent')      as first_price_sent_event_at,
  (array_agg(e.actor_profile_id order by e.created_at)
     filter (where e.event_type = 'price_sent'))[1]                 as pricing_actor_profile_id,
  (array_agg(e.actor_profile_id order by e.created_at)
     filter (where e.event_type = 'created'))[1]                    as creation_actor_profile_id,
  (array_agg(e.actor_profile_id order by e.created_at)
     filter (where e.event_type = 'accepted'))[1]                   as claim_actor_profile_id,
  min(e.created_at) filter (where e.event_type = 'accepted')        as first_accepted_event_at,
  (array_agg(e.assigned_profile_id order by e.created_at)
     filter (where e.event_type = 'assigned'))[1]                   as first_assigned_profile_id,
  (array_agg(e.actor_profile_id order by e.created_at desc)
     filter (where e.event_type = 'sold'))[1]                       as sold_actor_profile_id,
  (array_agg(e.actor_profile_id order by e.created_at desc)
     filter (where e.event_type = 'not_sold'))[1]                   as not_sold_actor_profile_id,
  count(*) filter (where e.event_type in ('assigned', 'reassigned'))
                                                                    as assignment_event_count,
  count(*) filter (where e.event_type = 'reassigned')               as reassignment_event_count,
  count(*) filter (where e.event_type = 'outcome_change')           as outcome_change_event_count,
  max(e.created_at) filter (where e.event_type = 'outcome_change')  as last_outcome_change_at,
  count(*) filter (where e.event_type = 'created_from_cs_intake')   as intake_conversion_event_count,
  count(*) filter (where e.event_type = 'taken')                    as taken_event_count,
  -- Worked After Hours. The creation event is excluded on purpose: a quote that
  -- arrives at 22:00 and is worked at 09:30 the next morning is received after
  -- hours and NOT worked after hours (Requirement 8.6).
  bool_or(
    e.event_type not in ('created', 'created_from_cs_intake')
    and not public.reporting_is_business_hours(e.created_at)
  )                                                                 as worked_after_hours_events,
  min(e.created_at) filter (
    where e.event_type not in ('created', 'created_from_cs_intake')
  )                                                                 as first_work_event_at
from public.work_item_events e
group by e.source_work_item_id;

comment on view public.reporting_quote_event_rollup is
  'Per-quote aggregates over work_item_events: the first verified pricing instant, the four credit actors, the assignment and outcome-change counts, and the Worked After Hours flag. The creation event is excluded from the after-hours work flag so that a quote arriving after hours is not reported as after-hours work.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. FIELD CHANGES — historical accuracy, from audit_log
--
-- Requirement 16. There is no dedicated audit action for a source or salesperson
-- change: the change is visible only inside the old_value/new_value pair of a
-- work_item_reassigned or pending_pricing_reassigned record. A source edited by any
-- other path leaves no trace at all, which is recorded as data gap 2 and is why
-- Requirement 16.4 permits falling back to the present value while saying so.
--
-- The two audit actions key differently: work_item_reassigned.entity_id is the
-- work_items id, which IS the Quote_Identity, while pending_pricing_reassigned
-- .entity_id is the pending row id, so its quote is read out of the JSON.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace view public.reporting_quote_field_changes
with (security_invoker = true)
as
with normalized as (
  select
    a.id,
    a.actor_profile_id,
    a.created_at,
    a.reason,
    case a.action
      when 'work_item_reassigned' then a.entity_id
      else nullif(btrim(a.new_value ->> 'source_work_item_id'), '')::uuid
    end             as quote_id,
    a.old_value,
    a.new_value
  from public.audit_log a
  where a.action in ('work_item_reassigned', 'pending_pricing_reassigned')
    and a.old_value is not null
    and a.new_value is not null
)
select quote_id, actor_profile_id, created_at, reason, field, old_value, new_value
from (
  select n.quote_id, n.actor_profile_id, n.created_at, n.reason,
         'dealer_id'    as field,
         n.old_value ->> 'dealer_id'    as old_value,
         n.new_value ->> 'dealer_id'    as new_value
    from normalized n
  union all
  select n.quote_id, n.actor_profile_id, n.created_at, n.reason,
         'salesperson_id',
         n.old_value ->> 'salesperson_id',
         n.new_value ->> 'salesperson_id'
    from normalized n
  union all
  select n.quote_id, n.actor_profile_id, n.created_at, n.reason,
         'assigned_profile_id',
         n.old_value ->> 'assigned_profile_id',
         n.new_value ->> 'assigned_profile_id'
    from normalized n
  union all
  select n.quote_id, n.actor_profile_id, n.created_at, n.reason,
         'assignment_method',
         n.old_value ->> 'assignment_method',
         n.new_value ->> 'assignment_method'
    from normalized n
) changes
where quote_id is not null
  and old_value is distinct from new_value;

comment on view public.reporting_quote_field_changes is
  'One row per field actually changed by a reassignment, from audit_log. Only four fields are recoverable, and only when the change rode inside a reassignment: no dedicated source_changed or salesperson_changed audit action exists on the Work Desk quote tables (data gap 2). A count of zero therefore means "no change recorded", not "no change happened".';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. QUOTE FACTS — the reporting record
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace view public.reporting_quote_facts
with (security_invoker = true)
as
with duplicate_retry as (
  -- A quote that is not the earliest quote linked to its intake, where that intake
  -- links to two or more quotes. Derived, not read: the defect in
  -- .kiro/specs/rc-claim-duplicate-quote-fix produces two quote records with no
  -- flag on either, so a column-based rule would miss every real case.
  select l.quote_id
  from public.reporting_intake_quote_links l
  join public.reporting_quote_base b on b.quote_id = l.quote_id
  where exists (
    select 1
    from public.reporting_intake_quote_links l2
    join public.reporting_quote_base b2 on b2.quote_id = l2.quote_id
    where l2.intake_id = l.intake_id
      and l2.quote_id <> l.quote_id
      and (b2.created_at < b.created_at
           or (b2.created_at = b.created_at and b2.quote_id < b.quote_id))
  )
)
select
  b.quote_id,
  b.customer_name,

  -- ---- Attribution --------------------------------------------------------
  b.dealer_id,
  d.name                                             as dealer_name,
  b.salesperson_id,
  sp.name                                            as salesperson_name,
  b.received_through                                 as channel,
  b.work_type::text                                  as work_type,
  (b.work_type = 'requote'
    or b.related_quote_source_work_item_id is not null)  as is_requote,
  b.assignment_method::text                          as assignment_method,
  (b.assignment_method = 'manual_quote')             as is_manual_quote,
  (il.intake_id is not null)                         as is_cs_intake,
  il.intake_id,
  coalesce(csi.is_walk_in, false)                    as is_walk_in,
  csi.intake_channel,
  csi.source_type                                    as intake_source_type,

  -- ---- Credit roles, Requirement 6 ---------------------------------------
  coalesce(b.created_by_column, r.creation_actor_profile_id)  as created_by_profile_id,
  coalesce(r.claim_actor_profile_id, r.first_assigned_profile_id)
                                                     as claimed_by_profile_id,
  b.assigned_profile_id,
  r.pricing_actor_profile_id                         as pricing_profile_id,
  case b.final_outcome
    when 'sold'     then r.sold_actor_profile_id
    when 'not_sold' then r.not_sold_actor_profile_id
    else null
  end                                                as outcome_profile_id,
  -- Frozen at finalization: a later reassignment does not move the sale.
  case when b.final_outcome is not null then b.assigned_profile_id else null end
                                                     as sales_credit_profile_id,
  b.original_owner_profile_id,

  -- ---- Timestamps ---------------------------------------------------------
  b.created_at,
  b.assigned_at,
  coalesce(b.accepted_at, r.first_accepted_event_at)  as accepted_at,
  least(b.price_sent_at_column, r.first_price_sent_event_at)
                                                     as first_pricing_sent_at,
  b.finalized_at,
  r.first_work_event_at,

  -- ---- State --------------------------------------------------------------
  b.lifecycle_stage,
  b.work_item_status,
  b.final_outcome,
  b.not_sold_reason,
  b.not_sold_reason_other,
  b.outcome_record_count,

  -- ---- Counts -------------------------------------------------------------
  coalesce(n.notes_count, 0)                         as notes_count,
  coalesce(n.follow_up_count, 0)                     as follow_up_count,
  0                                                  as attachment_count,
  coalesce(fc.source_change_count, 0)                as source_change_count,
  coalesce(fc.salesperson_change_count, 0)           as salesperson_change_count,
  coalesce(fc.assignment_change_count, 0)            as assignment_change_count,
  coalesce(fc.method_change_count, 0)                as assignment_method_change_count,
  coalesce(r.assignment_event_count, 0)              as assignment_event_count,
  coalesce(r.reassignment_event_count, 0)            as reassignment_event_count,
  coalesce(r.outcome_change_event_count, 0)          as outcome_change_event_count,
  r.last_outcome_change_at,
  coalesce(r.taken_event_count, 0)                   as taken_event_count,

  -- ---- After hours, Requirement 8 ----------------------------------------
  not public.reporting_is_business_hours(b.created_at)  as received_after_hours,
  coalesce(r.worked_after_hours_events, false)          as worked_after_hours,
  case when b.finalized_at is null then false
       else not public.reporting_is_business_hours(b.finalized_at) end
                                                       as finalized_after_hours,
  (b.assignment_method = 'manual_quote'
    and not public.reporting_is_business_hours(b.created_at))
                                                       as manual_entry_after_hours,

  -- ---- Integrity indicators ----------------------------------------------
  b.is_voided,
  b.voided_at,
  b.voided_by,
  b.void_reason,
  (dr.quote_id is not null)                          as is_duplicate_retry,
  (b.is_voided
    or b.work_item_status = 'cancelled'
    or dr.quote_id is not null)                      as is_excluded,
  (b.price_sent_at_column is not null
    and r.pricing_actor_profile_id is null)          as missing_pricing_actor,
  (b.final_outcome is not null
    and b.assigned_profile_id is distinct from
        case b.final_outcome
          when 'sold'     then r.sold_actor_profile_id
          when 'not_sold' then r.not_sold_actor_profile_id
        end
    and case b.final_outcome
          when 'sold'     then r.sold_actor_profile_id
          when 'not_sold' then r.not_sold_actor_profile_id
        end is not null)                             as attribution_conflict,
  (b.final_outcome is not null
    and least(b.price_sent_at_column, r.first_price_sent_event_at) is null)
                                                     as finalized_without_pricing,
  (b.final_outcome = 'not_sold' and b.not_sold_reason is null)
                                                     as not_sold_without_reason,
  (b.outcome_record_count > 1)                       as has_multiple_outcomes,
  b.outcome_row_id,
  b.pending_row_id
from public.reporting_quote_base b
left join public.dealers d              on d.id = b.dealer_id
left join public.dealer_salespeople sp  on sp.id = b.salesperson_id
left join public.reporting_quote_event_rollup r on r.quote_id = b.quote_id
left join public.reporting_intake_quote_links il on il.quote_id = b.quote_id
left join public.cs_intake_submissions csi on csi.id = il.intake_id
left join duplicate_retry dr            on dr.quote_id = b.quote_id
left join lateral (
  select
    count(*)                                                        as notes_count,
    count(*) filter (
      where qn.created_at > coalesce(
        least(b.price_sent_at_column, r.first_price_sent_event_at),
        'infinity'::timestamptz)
    )                                                               as follow_up_count
  from public.quote_notes qn
  where qn.source_work_item_id = b.quote_id
) n on true
left join lateral (
  select
    count(*) filter (where c.field = 'dealer_id')           as source_change_count,
    count(*) filter (where c.field = 'salesperson_id')      as salesperson_change_count,
    count(*) filter (where c.field = 'assigned_profile_id') as assignment_change_count,
    count(*) filter (where c.field = 'assignment_method')   as method_change_count
  from public.reporting_quote_field_changes c
  where c.quote_id = b.quote_id
) fc on true;

comment on view public.reporting_quote_facts is
  'One reporting record per quote: attribution, the six credit roles, five lifecycle timestamps, state, counts, the four after-hours dimensions, and the integrity indicators (Requirement 17.2). first_pricing_sent_at is the earlier of the stored price_sent_at and the earliest price_sent event, so pricing is never inferred from a note, a status, or an outcome. sales_credit_profile_id is null until finalization and does not move when the quote is later reassigned. attachment_count is a constant zero: no quote attachment table exists (data gap 9).';

commit;

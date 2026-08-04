-- New Hope Work Desk v1.12.8 — fix: is_excluded was null for most quotes
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 4.1, 17.1
-- Fixes: v1.12.1-reporting-quote-facts.sql (forward-only; that file is not edited)
--
-- ── The defect ────────────────────────────────────────────────────────────────
--
-- v1.12.1 computed:
--
--   (b.is_voided or b.work_item_status = 'cancelled' or dr.quote_id is not null)
--
-- b.work_item_status is work_items.status, and a quote's work_items row is deleted
-- when the quote moves to pending pricing or to an outcome. So for 1,236 of 1,276
-- quotes the status is null, `null = 'cancelled'` is null, and
-- `false or null or false` is **null** rather than false.
--
-- Every reporting query filters `where not q.is_excluded`, and `not null` is null,
-- which is not true, so those 1,236 rows were silently dropped. Quotes Received
-- returned 40 — the 4 active quotes plus the 36 sold quotes whose work_items row was
-- converted in place into an activation and therefore still exists.
--
-- Caught by supabase/verification/v1.12-reporting-checks.sql before any UI was built
-- on it. This is exactly the failure mode the requirement about metric totals
-- matching their own drill-down exists to catch: the number was not wrong in a way
-- anyone would notice by looking at it, it was wrong by a factor of thirty.
--
-- ── The fix ───────────────────────────────────────────────────────────────────
--
-- Compare through coalesce so a missing status reads as "not cancelled" rather than
-- as unknown. is_voided is already coalesced, and is_duplicate_retry is a null-safe
-- `is not null`, so those two were never the problem.
--
-- ROLLBACK: re-apply the reporting_quote_facts definition from v1.12.1. Doing so
-- restores the defect, so there is no reason to.

begin;

create or replace view public.reporting_quote_facts
with (security_invoker = true)
as
with duplicate_retry as (
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
  case when b.final_outcome is not null then b.assigned_profile_id else null end
                                                     as sales_credit_profile_id,
  b.original_owner_profile_id,

  b.created_at,
  b.assigned_at,
  coalesce(b.accepted_at, r.first_accepted_event_at)  as accepted_at,
  least(b.price_sent_at_column, r.first_price_sent_event_at)
                                                     as first_pricing_sent_at,
  b.finalized_at,
  r.first_work_event_at,

  b.lifecycle_stage,
  b.work_item_status,
  b.final_outcome,
  b.not_sold_reason,
  b.not_sold_reason_other,
  b.outcome_record_count,

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

  not public.reporting_is_business_hours(b.created_at)  as received_after_hours,
  coalesce(r.worked_after_hours_events, false)          as worked_after_hours,
  case when b.finalized_at is null then false
       else not public.reporting_is_business_hours(b.finalized_at) end
                                                       as finalized_after_hours,
  (b.assignment_method = 'manual_quote'
    and not public.reporting_is_business_hours(b.created_at))
                                                       as manual_entry_after_hours,

  b.is_voided,
  b.voided_at,
  b.voided_by,
  b.void_reason,
  (dr.quote_id is not null)                          as is_duplicate_retry,
  -- THE FIX. coalesce so a quote that has left work_items reads as not cancelled
  -- rather than as unknown, and the whole expression stays boolean rather than null.
  (coalesce(b.is_voided, false)
    or coalesce(b.work_item_status, '') = 'cancelled'
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
  'One reporting record per quote (Requirement 17.2). first_pricing_sent_at is the earlier of the stored price_sent_at and the earliest price_sent event, so pricing is never inferred from a note, a status, or an outcome. sales_credit_profile_id is null until finalization and does not move when the quote is later reassigned. is_excluded is coalesced throughout: v1.12.1 left it null for the 1,236 quotes whose work_items row had been deleted, and `not null` silently dropped every one of them. attachment_count is a constant zero because no quote attachment table exists.';

commit;

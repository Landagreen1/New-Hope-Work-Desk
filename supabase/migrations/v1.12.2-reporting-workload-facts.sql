-- New Hope Work Desk v1.12.2 — the workload fact dataset
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 5.2, 5.3, 17.3
--
-- Manual Workload has never been reported. No metric in any of the 24 existing
-- reports counts assignment_method = 'manual_workload'; the Agent Comparison
-- "Manual" column counts manual_quote only. This view exists so the two can be
-- reported separately, which Requirement 5.3 demands.
--
-- Live spread on 2026-08-03:
--   change      workload_turn    125     activation  workload_turn    99
--   change      manual_workload   66     activation  manual_workload  45
--   payment     payment_log       42
--
-- ── Sharing an id with a quote is not a duplicate ────────────────────────────
--
-- When a quote sells, its work_items row is converted in place into an activation:
-- same id, work_type becomes 'activation'. 36 rows are in that state. Such a row is
-- genuinely a workload and belongs here, and its id is also a Quote_Identity in
-- reporting_quote_facts. related_quote_id resolves to itself in that case, which is
-- what lets the Agents view show the activation next to the sale that produced it.
--
-- ROLLBACK
--   begin;
--     drop view if exists public.reporting_workload_facts;
--   commit;

begin;

create or replace view public.reporting_workload_facts
with (security_invoker = true)
as
select
  w.id                                              as workload_id,
  w.work_type::text                                 as workload_type,
  w.change_type,
  w.customer_name,
  w.dealer_id,
  d.name                                            as dealer_name,
  w.salesperson_id,
  sp.name                                           as salesperson_name,

  -- A converted activation carries no related_quote_source_work_item_id, but its own
  -- id is the quote it came from. Resolving to itself is what links the two.
  coalesce(
    w.related_quote_source_work_item_id,
    case when exists (
      select 1 from public.quote_outcomes o where o.source_work_item_id = w.id
    ) then w.id end
  )                                                 as related_quote_id,

  w.assigned_profile_id                             as agent_profile_id,
  w.created_by                                      as created_by_profile_id,
  w.original_owner_profile_id,
  w.assignment_method::text                         as assignment_method,
  (w.assignment_method = 'manual_workload')         as is_manual_workload,
  (w.assignment_method = 'workload_turn')           as is_queue_workload,

  w.created_at,
  nullif(w.accepted_at, w.created_at)               as accepted_at,
  w.completed_at,

  w.status::text                                    as current_status,
  coalesce(w.is_voided, false)                      as is_voided,
  w.voided_at,
  w.voided_by,
  w.void_reason,
  coalesce(w.is_voided, false)                      as is_excluded,

  coalesce(n.notes_count, 0)                        as notes_count,
  -- No workload attachment or evidence table exists (data gap 9). Reported as zero
  -- rather than approximated from something it is not.
  0                                                 as evidence_count,

  not public.reporting_is_business_hours(w.created_at)  as created_after_hours,
  (w.assignment_method = 'manual_workload'
    and not public.reporting_is_business_hours(w.created_at))
                                                    as manual_entry_after_hours,
  case when w.completed_at is null then false
       else not public.reporting_is_business_hours(w.completed_at) end
                                                    as completed_after_hours,

  -- Manual workload with no notes: a documentation signal, not a manual-entry one.
  (w.assignment_method = 'manual_workload' and coalesce(n.notes_count, 0) = 0)
                                                    as manual_without_notes
from public.work_items w
left join public.dealers d             on d.id = w.dealer_id
left join public.dealer_salespeople sp on sp.id = w.salesperson_id
left join lateral (
  select count(*) as notes_count
  from public.quote_notes qn
  where qn.source_work_item_id = w.id
) n on true
where w.work_type not in ('new_quote', 'requote');

comment on view public.reporting_workload_facts is
  'One reporting record per non-quote work record (Requirement 17.3). is_manual_workload and is_queue_workload are separate flags so a Manual Workload count can never pick up a workload turn, a quote, or a Customer Service intake claim. A row may share its id with a Quote_Identity: a sold quote''s work_items row is converted in place into an activation, and related_quote_id resolves to itself in that case. evidence_count is a constant zero because no workload evidence table exists.';

commit;

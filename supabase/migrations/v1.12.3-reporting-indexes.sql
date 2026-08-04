-- New Hope Work Desk v1.12.3 — indexes supporting the reporting queries
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 17.6
--
-- Adds indexes only. No table, column, view, function, policy, or row is altered, so
-- nothing a Legacy_Report reads changes.
--
-- These already exist in schema.sql and are deliberately not recreated:
--   work_items_assigned_status_idx, work_items_status_created_idx,
--   work_items_created_at_idx, work_items_method_idx,
--   pending_pricing_assigned_sent_idx, pending_pricing_sent_idx,
--   quote_outcomes_created_idx, quote_outcomes_finalized_idx,
--   quote_outcomes_agent_idx, work_item_events_source_idx,
--   work_item_events_agent_idx, work_item_events_type_idx
--
-- ROLLBACK: drop each index created below by name.

begin;

-- Quote creation date, restricted to quotes so the index stays small.
create index if not exists work_items_quote_created_idx
  on public.work_items (created_at desc)
  where work_type in ('new_quote', 'requote');

-- Source and salesperson, the two dimensions the Sources view groups by.
create index if not exists work_items_dealer_created_idx
  on public.work_items (dealer_id, created_at desc);
create index if not exists work_items_salesperson_created_idx
  on public.work_items (salesperson_id, created_at desc);

-- Created By, the credit role no current report uses and every new one does.
create index if not exists work_items_created_by_idx
  on public.work_items (created_by, created_at desc);

-- Voided records, excluded from every metric. Partial: almost every row is false.
create index if not exists work_items_voided_idx
  on public.work_items (is_voided) where is_voided;

create index if not exists pending_pricing_created_idx
  on public.pending_pricing_quotes (quote_created_at desc);
create index if not exists pending_pricing_dealer_idx
  on public.pending_pricing_quotes (dealer_id, price_sent_at desc);
create index if not exists pending_pricing_salesperson_idx
  on public.pending_pricing_quotes (salesperson_id, price_sent_at desc);

-- The join that resolves one quote's authoritative outcome.
create index if not exists quote_outcomes_source_finalized_idx
  on public.quote_outcomes (source_work_item_id, finalized_at desc);
create index if not exists quote_outcomes_decision_finalized_idx
  on public.quote_outcomes (decision, finalized_at desc);
create index if not exists quote_outcomes_dealer_finalized_idx
  on public.quote_outcomes (dealer_id, finalized_at desc);
create index if not exists quote_outcomes_salesperson_finalized_idx
  on public.quote_outcomes (salesperson_id, finalized_at desc);
create index if not exists quote_outcomes_method_finalized_idx
  on public.quote_outcomes (assignment_method, finalized_at desc);

-- The event rollup filters by type within a quote.
create index if not exists work_item_events_source_type_idx
  on public.work_item_events (source_work_item_id, event_type, created_at);

create index if not exists quote_notes_source_created_idx
  on public.quote_notes (source_work_item_id, created_at desc);

-- The two audit actions that carry a recoverable field change.
create index if not exists audit_log_reassign_action_idx
  on public.audit_log (action, created_at desc)
  where action in ('work_item_reassigned', 'pending_pricing_reassigned');

-- The intake-to-quote link is read out of JSON, so the expression is the index.
create index if not exists cs_intake_events_work_item_idx
  on public.cs_intake_events ((detail ->> 'work_item_id'))
  where detail ? 'work_item_id';

commit;

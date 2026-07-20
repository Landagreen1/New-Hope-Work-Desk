-- New Hope Work Desk v1.1.1 — Commercial Commission Workflow & Activity Log
-- Adds commission decision tracking and a unified activity log for the commercial board.
--
-- Commission workflow:
--   When a card reaches 'sold', managers can mark it commission_approved or commission_not_approved.
--   A denial reason is required and visible to the agent.
--
-- Activity log:
--   Every significant action on a card is recorded with actor, event type, and timestamp.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Add commission fields to commercial_quotes
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.commercial_quotes
  add column if not exists commission_status text check (
    commission_status is null or commission_status in ('pending', 'approved', 'denied')
  ),
  add column if not exists commission_decision_by uuid references public.profiles(id),
  add column if not exists commission_decision_at timestamptz,
  add column if not exists commission_denial_reason text,
  add column if not exists commission_notes text,
  add column if not exists sold_premium numeric(12,2),
  add column if not exists sold_at timestamptz;

-- When a card is in 'sold' column, commission_status should default to 'pending'
-- This is enforced in the API logic, not as a DB constraint (to avoid breaking existing cards)

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Add soft-delete fields to commercial_quotes
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.commercial_quotes
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id),
  add column if not exists deleted_reason text;

-- Index for filtering out deleted cards
create index if not exists idx_commercial_quotes_not_deleted
  on public.commercial_quotes(is_deleted)
  where is_deleted = false;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. COMMERCIAL QUOTE ACTIVITY LOG — unified audit trail
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.commercial_quote_activity_log (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.commercial_quotes(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  event_type text not null check (event_type in (
    'created',
    'column_moved',
    'field_updated',
    'comment_added',
    'attachment_uploaded',
    'attachment_deleted',
    'checklist_created',
    'checklist_item_added',
    'checklist_item_toggled',
    'checklist_item_deleted',
    'checklist_deleted',
    'commission_approved',
    'commission_denied',
    'card_deleted',
    'card_restored',
    'card_archived',
    'assigned_changed'
  )),
  details jsonb,  -- flexible metadata: { from_column, to_column, field_name, old_value, new_value, reason, etc. }
  created_at timestamptz not null default now()
);

create index if not exists idx_commercial_activity_log_quote
  on public.commercial_quote_activity_log(quote_id, created_at desc);

create index if not exists idx_commercial_activity_log_actor
  on public.commercial_quote_activity_log(actor_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. RLS for activity log
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.commercial_quote_activity_log enable row level security;

create policy "commercial_activity_log_select" on public.commercial_quote_activity_log
  for select to authenticated
  using (
    exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_activity_log.quote_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

create policy "commercial_activity_log_insert" on public.commercial_quote_activity_log
  for insert to authenticated
  with check (
    actor_id = auth.uid()
    and exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_activity_log.quote_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

commit;

-- Verification
select 'commercial_quote_activity_log' as tbl, count(*) as policies
from pg_policies where tablename = 'commercial_quote_activity_log';

-- v1.4.0 — Renewal SMS Log
-- Tracks every outbound text message sent via RingCentral for renewal reminders.
-- Supports both automated (scheduler) and manual (agent-initiated) sends.
-- Additive migration: no existing tables are modified or dropped.

-- ---------------------------------------------------------------------------
-- Table: renewal_sms_log
-- ---------------------------------------------------------------------------

create table if not exists public.renewal_sms_log (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.renewal_records(id) on delete cascade,
  phone text not null,
  message_text text not null,
  trigger_type text not null check (trigger_type in ('auto_30d', 'auto_15d', 'auto_7d', 'manual')),
  rc_message_id text,
  rc_batch_id text,
  delivery_status text not null default 'queued' check (delivery_status in ('queued', 'sent', 'delivered', 'failed', 'rejected')),
  error_detail text,
  sent_by uuid references auth.users(id),
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.renewal_sms_log is 'Every outbound SMS sent for renewal reminders, both automated and agent-initiated.';
comment on column public.renewal_sms_log.trigger_type is 'auto_30d, auto_15d, auto_7d = scheduler milestones; manual = agent-initiated.';
comment on column public.renewal_sms_log.delivery_status is 'Tracks RingCentral delivery lifecycle: queued → sent → delivered, or failed/rejected.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Fast lookup: "has this renewal already received an auto text for this milestone?"
create unique index if not exists renewal_sms_log_auto_dedup_idx
  on public.renewal_sms_log (record_id, trigger_type)
  where trigger_type in ('auto_30d', 'auto_15d', 'auto_7d');

-- List all SMS for a renewal record (history view)
create index if not exists renewal_sms_log_record_idx
  on public.renewal_sms_log (record_id, sent_at desc);

-- Scheduler: find records needing status update
create index if not exists renewal_sms_log_pending_status_idx
  on public.renewal_sms_log (delivery_status)
  where delivery_status = 'queued';

-- ---------------------------------------------------------------------------
-- RLS Policies
-- ---------------------------------------------------------------------------

alter table public.renewal_sms_log enable row level security;

-- Agents and managers can view SMS logs for renewals they can access
create policy renewal_sms_log_select
  on public.renewal_sms_log
  for select to authenticated
  using (
    public.nhwd_role() = 'manager'
    or exists (
      select 1 from public.renewal_records r
      where r.id = renewal_sms_log.record_id
        and r.assigned_to = auth.uid()
    )
  );

-- Only server (service role) or managers can insert (API routes use service role)
create policy renewal_sms_log_insert
  on public.renewal_sms_log
  for insert to authenticated
  with check (
    public.nhwd_role() in ('manager', 'agent', 'customer_service')
  );

-- Only service role updates delivery status (via API route)
create policy renewal_sms_log_update
  on public.renewal_sms_log
  for update to authenticated
  using (public.nhwd_role() = 'manager')
  with check (public.nhwd_role() = 'manager');

-- ---------------------------------------------------------------------------
-- Grant access
-- ---------------------------------------------------------------------------

grant select, insert, update on public.renewal_sms_log to authenticated;

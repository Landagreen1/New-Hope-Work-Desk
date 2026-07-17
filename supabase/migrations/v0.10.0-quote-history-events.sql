-- New Hope Work Desk v0.10.0
-- Migration: Create quote_history_events table
-- Part of the Customer Intake, Claim, and Duplicate Quote feature.
-- Tracks all events in the lifecycle of an operational quote including
-- the Intake Note Log, status changes, duplicate reviews, and merges.
--
-- Requirements: 11.5, 17.1, 17.2
-- Depends on: operational_quotes, customer_intakes, profiles tables

begin;

-- Preflight: ensure dependencies exist
do $preflight$
begin
  if to_regclass('public.operational_quotes') is null then
    raise exception 'v0.10.0 requires operational_quotes table. Run the operational_quotes migration first.';
  end if;
  if to_regclass('public.customer_intakes') is null then
    raise exception 'v0.10.0 requires customer_intakes table. Run the customer_intakes migration first.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'v0.10.0 requires profiles table.';
  end if;
end
$preflight$;

-- Create quote_history_events table
create table if not exists public.quote_history_events (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.operational_quotes(id),
  linked_intake_id uuid references public.customer_intakes(id),

  actor_id uuid not null references public.profiles(id),
  actor_display_name text not null,

  event_type text not null check (event_type in (
    'quote_created',
    'intake_note_log',
    'intake_update',
    'agent_started_quoting',
    'pricing_sent',
    'follow_up_recorded',
    'activation_started',
    'activation_completed',
    'sold',
    'not_sold',
    'duplicate_review_entered',
    'duplicate_resolved',
    'merged',
    'reassigned',
    'note_added',
    'attachment_added',
    'status_changed'
  )),

  -- Intake Note Log content (for event_type='intake_note_log')
  note_log_content text,

  -- For intake_update events: grouped field changes
  changed_fields jsonb,

  -- General details and reason
  details text check (char_length(details) between 1 and 500),
  reason text,

  created_at timestamptz not null default now()
);

-- Index for efficient quote timeline queries (ascending for chronological display)
create index if not exists idx_quote_history_quote
  on public.quote_history_events(quote_id, created_at asc);

commit;

select 'quote_history_events table created successfully' as status;

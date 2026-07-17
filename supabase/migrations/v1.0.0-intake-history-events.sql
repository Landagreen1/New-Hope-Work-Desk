-- New Hope Work Desk v1.0.0 — intake_history_events
-- Immutable append-only history event log for Customer Intakes.
-- Records all lifecycle events (created, updated, submitted, claimed, etc.)
-- with attribution, timestamps, and grouped field-change tracking.
--
-- Dependencies: customer_intakes, operational_quotes, profiles tables.
-- Requirements: 4.1, 4.2, 17.5

begin;

-- ---------------------------------------------------------------------------
-- Preflight: verify required tables exist before creating the history table.
-- ---------------------------------------------------------------------------
do $preflight$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.customer_intakes') is null then
    v_missing := array_append(v_missing, 'customer_intakes');
  end if;
  if to_regclass('public.operational_quotes') is null then
    v_missing := array_append(v_missing, 'operational_quotes');
  end if;
  if to_regclass('public.profiles') is null then
    v_missing := array_append(v_missing, 'profiles');
  end if;

  if cardinality(v_missing) > 0 then
    raise exception 'intake_history_events migration requires: %. Run prerequisite migrations first.',
      array_to_string(v_missing, ', ');
  end if;
end
$preflight$;

-- ---------------------------------------------------------------------------
-- Table: intake_history_events (immutable, append-only)
-- ---------------------------------------------------------------------------
create table if not exists public.intake_history_events (
  id uuid primary key default gen_random_uuid(),

  -- Parent references
  intake_id uuid not null references public.customer_intakes(id),
  linked_quote_id uuid references public.operational_quotes(id),

  -- Actor attribution
  actor_id uuid not null references public.profiles(id),
  actor_display_name text not null,

  -- Event classification
  event_type text not null check (event_type in (
    'created','updated','source_changed','submitted','claimed',
    'assigned','converted_to_quote','deleted','restored'
  )),

  -- For 'updated' events: grouped field changes
  -- Format: [{ "field": "...", "old_value": "...", "new_value": "..." }]
  changed_fields jsonb,

  -- Human-readable details (1–500 chars when present)
  details text check (char_length(details) between 1 and 500),

  -- Optional reason (mandatory for manager edits, deletes, restores)
  reason text,

  -- Immutable timestamp
  created_at timestamptz not null default now(),

  -- At least one of details or changed_fields must be present
  constraint no_empty_event check (details is not null or changed_fields is not null)
);

-- ---------------------------------------------------------------------------
-- Index: efficient lookup by intake with newest-first ordering
-- ---------------------------------------------------------------------------
create index if not exists idx_intake_history_intake
  on public.intake_history_events(intake_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Verification: confirm table and constraint exist
-- ---------------------------------------------------------------------------
do $verify$
begin
  if to_regclass('public.intake_history_events') is null then
    raise exception 'intake_history_events table was not created.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'no_empty_event'
      and conrelid = 'public.intake_history_events'::regclass
  ) then
    raise exception 'no_empty_event CHECK constraint is missing.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where indexname = 'idx_intake_history_intake'
  ) then
    raise exception 'idx_intake_history_intake index is missing.';
  end if;
end
$verify$;

commit;

select 'intake_history_events table created successfully' as status;

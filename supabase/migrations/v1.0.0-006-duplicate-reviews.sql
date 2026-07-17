-- New Hope Work Desk v1.0.0 — duplicate_reviews
-- Tracks duplicate quote flags raised by Agents and resolved by Managers.
-- Each record links a flagged quote to the suspected original, stores the
-- reason for flagging, and records the Manager's resolution decision.
--
-- Dependencies: operational_quotes, profiles tables.
-- Requirements: 13.6, 14.1

begin;

-- ---------------------------------------------------------------------------
-- Preflight: verify required tables exist before creating duplicate_reviews.
-- ---------------------------------------------------------------------------
do $preflight$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.operational_quotes') is null then
    v_missing := array_append(v_missing, 'operational_quotes');
  end if;
  if to_regclass('public.profiles') is null then
    v_missing := array_append(v_missing, 'profiles');
  end if;

  if cardinality(v_missing) > 0 then
    raise exception 'duplicate_reviews migration requires: %. Run prerequisite migrations first.',
      array_to_string(v_missing, ', ');
  end if;
end
$preflight$;

-- ---------------------------------------------------------------------------
-- Table: duplicate_reviews
-- ---------------------------------------------------------------------------
create table if not exists public.duplicate_reviews (
  id uuid primary key default gen_random_uuid(),

  -- Quote references
  flagged_quote_id uuid not null references public.operational_quotes(id),
  original_quote_id uuid not null references public.operational_quotes(id),

  -- Flagging attribution
  flagged_by uuid not null references public.profiles(id),
  flagged_at timestamptz not null default now(),
  reason text not null check (char_length(reason) between 10 and 500),

  -- Resolution fields (populated when Manager resolves)
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  decision text check (decision in ('not_duplicate', 'merge', 'keep_both_link')),
  resolution_details jsonb,

  -- Status
  status text not null default 'pending' check (status in ('pending', 'resolved')),

  -- Constraints
  constraint not_self_duplicate check (flagged_quote_id != original_quote_id),
  constraint no_double_flag unique (flagged_quote_id)
);

-- ---------------------------------------------------------------------------
-- Index: efficiently query pending duplicate reviews
-- ---------------------------------------------------------------------------
create index if not exists idx_duplicate_reviews_pending
  on public.duplicate_reviews(id)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- Verification: confirm table, constraints, and index exist
-- ---------------------------------------------------------------------------
do $verify$
begin
  if to_regclass('public.duplicate_reviews') is null then
    raise exception 'duplicate_reviews table was not created.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'not_self_duplicate'
      and conrelid = 'public.duplicate_reviews'::regclass
  ) then
    raise exception 'not_self_duplicate CHECK constraint is missing.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'no_double_flag'
      and conrelid = 'public.duplicate_reviews'::regclass
  ) then
    raise exception 'no_double_flag UNIQUE constraint is missing.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where indexname = 'idx_duplicate_reviews_pending'
  ) then
    raise exception 'idx_duplicate_reviews_pending index is missing.';
  end if;
end
$verify$;

commit;

select 'duplicate_reviews table created successfully' as status;

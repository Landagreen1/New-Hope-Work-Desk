-- New Hope Work Desk v0.10.0 — operational_quotes table
-- Part of the Customer Intake → Claim → Duplicate Quote feature.
-- Depends on: customer_intakes table (v0.10.0-customer-intakes.sql must run first),
--             profiles, dealers, dealer_salespeople tables (baseline).
--
-- Requirements: 8.6, 9.5

begin;

-- -----------------------------------------------------------------------------
-- Preflight: verify required tables exist before proceeding.
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.customer_intakes') is null then
    raise exception 'operational_quotes migration requires the customer_intakes table. Run the customer_intakes migration first.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'operational_quotes migration requires the profiles table.';
  end if;
  if to_regclass('public.dealers') is null then
    raise exception 'operational_quotes migration requires the dealers table.';
  end if;
  if to_regclass('public.dealer_salespeople') is null then
    raise exception 'operational_quotes migration requires the dealer_salespeople table.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- 1. Create the operational_quotes table.
-- -----------------------------------------------------------------------------
create table if not exists public.operational_quotes (
  id uuid primary key default gen_random_uuid(),

  -- Link to intake (one quote per intake)
  customer_intake_id uuid not null references public.customer_intakes(id),

  -- Identity fields (copied from intake at creation time)
  customer_name varchar(150) not null,
  source_type text not null,
  dealer_id uuid references public.dealers(id),
  dealer_salesperson_id uuid references public.dealer_salespeople(id),
  line_of_business text not null,
  phone varchar(20),
  email varchar(254),
  quote_origin text,

  -- Status state machine
  status text not null default 'assigned' check (status in (
    'assigned','quoting','pricing_sent','not_sold',
    'activation_pending','activated','sold',
    'duplicate_review','merged_duplicate'
  )),
  pre_flag_status text,  -- status before duplicate_review (for restore)

  -- Assignment
  assigned_to uuid not null references public.profiles(id),
  intake_creator uuid not null references public.profiles(id),
  assignment_method text not null check (assignment_method in (
    'ringcentral_claim','manager_assignment','automatic_rotation','renewal_requote'
  )),
  assigned_at timestamptz not null default now(),
  claimed_at timestamptz,

  -- Intake Note Log (stored as first history entry reference)
  intake_note_log_id uuid,

  -- Urgency tracking
  last_progression_at timestamptz not null default now(),

  -- Duplicate linking
  linked_quote_id uuid references public.operational_quotes(id),
  merged_into_id uuid references public.operational_quotes(id),

  -- Timestamps
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,

  -- Constraints
  constraint one_quote_per_intake unique (customer_intake_id)
);

-- -----------------------------------------------------------------------------
-- 2. Indexes for common access patterns.
-- -----------------------------------------------------------------------------

-- Active quotes assigned to a specific agent (excludes terminal statuses)
create index if not exists idx_quotes_assigned_to
  on public.operational_quotes(assigned_to)
  where status not in ('not_sold','sold','merged_duplicate');

-- Lookup by status for queue filtering
create index if not exists idx_quotes_status
  on public.operational_quotes(status);

-- Quotes pending duplicate review (Manager review queue)
create index if not exists idx_quotes_duplicate_review
  on public.operational_quotes(id)
  where status = 'duplicate_review';

commit;

select 'operational_quotes table created successfully' as status;

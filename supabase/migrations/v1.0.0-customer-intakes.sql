-- New Hope Work Desk v1.0.0
-- Customer Intakes table: The new structured customer_intakes table replaces the
-- operational workflow previously handled by cs_intake_submissions.
-- This table stores complete identity components, workflow state, personal/commercial
-- auto fields, coverage details, and supports soft-delete with audit history.
--
-- Requirements: 1.1, 1.2, 1.5, 1.6, 3.4
-- Spec: customer-intake-claim-duplicate-quote

begin;

-- -----------------------------------------------------------------------------
-- 0. Preflight: Confirm baseline tables that customer_intakes references exist.
-- -----------------------------------------------------------------------------
do $preflight$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.profiles') is null then v_missing := array_append(v_missing, 'profiles'); end if;
  if to_regclass('public.dealers') is null then v_missing := array_append(v_missing, 'dealers'); end if;
  if to_regclass('public.dealer_salespeople') is null then v_missing := array_append(v_missing, 'dealer_salespeople'); end if;

  if cardinality(v_missing) > 0 then
    raise exception 'v1.0.0 baseline is incomplete. Missing: %. Install the baseline schema first.', array_to_string(v_missing, ', ');
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- 1. Create the customer_intakes table.
-- -----------------------------------------------------------------------------
create table if not exists public.customer_intakes (
  id uuid primary key default gen_random_uuid(),

  -- Identity components (Requirement 1)
  customer_name varchar(150) not null,
  source_type text not null,
  source_description varchar(100),
  dealer_id uuid references public.dealers(id),
  dealer_salesperson_id uuid references public.dealer_salespeople(id),
  line_of_business text not null,
  phone varchar(20),
  email varchar(254),
  drivers_license_ref varchar(30),
  date_of_birth date,
  quote_origin text,

  -- Status & workflow
  status text not null default 'draft',
  priority text not null default 'normal',

  -- Ownership
  created_by uuid not null references public.profiles(id),
  assigned_to uuid references public.profiles(id),
  claimed_at timestamptz,
  assignment_method text,

  -- Conversion link (FK to operational_quotes added later when that table exists)
  converted_quote_id uuid,
  converted_at timestamptz,
  converted_by uuid references public.profiles(id),

  -- Soft-delete
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id),
  deleted_reason text,
  pre_delete_status text,

  -- Personal Auto fields
  insured_first_name varchar(75),
  insured_last_name varchar(75),
  insured_dob date,
  insured_email varchar(254),
  insured_phone_primary varchar(20),
  insured_phone_alt varchar(20),
  preferred_language text,
  preferred_contact text,
  addr_street text,
  addr_unit text,
  addr_city text,
  addr_state varchar(2),
  addr_zip varchar(10),
  mailing_same_as_addr boolean default true,

  -- Commercial Auto fields
  business_name varchar(200),
  dot_number varchar(20),
  dot_not_applicable boolean default false,
  business_type text,
  years_in_business smallint,
  operating_radius_miles integer,

  -- Coverage fields
  desired_coverage text,
  liability_limit text,
  comprehensive_deductible text,
  collision_deductible text,
  current_carrier text,
  current_policy_number text,
  current_premium numeric(10,2),
  current_expiration date,
  prior_insurance boolean,
  prior_lapse boolean,
  months_continuous_coverage smallint,

  -- Notes
  csr_notes text,

  -- Timestamps
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,

  -- CHECK constraints
  CONSTRAINT customer_intakes_source_type_check CHECK (source_type IN (
    'dealership','walk_in_office','whatsapp','ringcentral',
    'customer_service','renewal_requote','existing_customer','referral','other'
  )),
  CONSTRAINT customer_intakes_status_check CHECK (status IN (
    'draft','submitted','waiting_for_claim','waiting_for_assignment',
    'claimed','assigned','converted','deleted'
  )),
  CONSTRAINT customer_intakes_priority_check CHECK (priority IN ('normal','high','urgent')),
  CONSTRAINT customer_intakes_assignment_method_check CHECK (
    assignment_method IS NULL OR assignment_method IN (
      'ringcentral_claim','manager_assignment','automatic_rotation','renewal_requote'
    )
  ),
  CONSTRAINT customer_intakes_name_not_empty CHECK (char_length(trim(customer_name)) > 0),
  CONSTRAINT customer_intakes_phone_or_email_required CHECK (phone IS NOT NULL OR email IS NOT NULL),
  CONSTRAINT customer_intakes_dealership_requires_salesperson CHECK (
    source_type != 'dealership' OR (dealer_id IS NOT NULL AND dealer_salesperson_id IS NOT NULL)
  ),
  CONSTRAINT customer_intakes_other_requires_description CHECK (
    source_type != 'other' OR char_length(trim(COALESCE(source_description, ''))) > 0
  )
);

-- -----------------------------------------------------------------------------
-- 2. Unique index: one quote per intake (only when converted_quote_id is set).
-- This will be enforced as a FK once operational_quotes is created in a later
-- migration. For now, the unique index ensures no duplicates.
-- -----------------------------------------------------------------------------
create unique index if not exists idx_customer_intakes_converted_quote
  on public.customer_intakes(converted_quote_id)
  where converted_quote_id is not null;

-- -----------------------------------------------------------------------------
-- 3. Updated_at trigger (reuses existing touch_updated_at function).
-- -----------------------------------------------------------------------------
drop trigger if exists customer_intakes_touch_updated_at on public.customer_intakes;
create trigger customer_intakes_touch_updated_at
  before update on public.customer_intakes
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 4. Verification: confirm table and constraints exist.
-- -----------------------------------------------------------------------------
do $verify$
begin
  if to_regclass('public.customer_intakes') is null then
    raise exception 'customer_intakes table was not created.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'customer_intakes_source_type_check'
      and conrelid = 'public.customer_intakes'::regclass
  ) then
    raise exception 'source_type CHECK constraint missing.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'customer_intakes_status_check'
      and conrelid = 'public.customer_intakes'::regclass
  ) then
    raise exception 'status CHECK constraint missing.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'customer_intakes_priority_check'
      and conrelid = 'public.customer_intakes'::regclass
  ) then
    raise exception 'priority CHECK constraint missing.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'customer_intakes_phone_or_email_required'
      and conrelid = 'public.customer_intakes'::regclass
  ) then
    raise exception 'phone_or_email_required CHECK constraint missing.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'customer_intakes_dealership_requires_salesperson'
      and conrelid = 'public.customer_intakes'::regclass
  ) then
    raise exception 'dealership_requires_salesperson CHECK constraint missing.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'customer_intakes_other_requires_description'
      and conrelid = 'public.customer_intakes'::regclass
  ) then
    raise exception 'other_requires_description CHECK constraint missing.';
  end if;

  if not exists (
    select 1 from pg_class
    where relname = 'idx_customer_intakes_converted_quote'
  ) then
    raise exception 'idx_customer_intakes_converted_quote unique index missing.';
  end if;
end
$verify$;

commit;

select 'New Hope Work Desk v1.0.0 customer_intakes table installed' as status;

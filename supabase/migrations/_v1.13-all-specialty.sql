-- v1.13.0 Specialty Markets — Market Directory
--
-- Creates the centrally-managed Market Directory for Specialty Quotes.
-- A Market is an organization New Hope submits accounts to (carrier, broker,
-- MGA, wholesaler, program administrator, or other). Markets are LOB-aware
-- and support configurable questions, submission methods, and templates.
--
-- Tables:
--   1. specialty_markets          — the directory itself
--   2. specialty_market_aliases   — historical/spelling variations
--   3. specialty_market_lobs      — which LOBs a market supports
--   4. specialty_market_contacts  — contacts at the market
--   5. specialty_market_questions — market-specific submission questions
--   6. specialty_market_templates — PDF template configurations
--   7. specialty_market_submission_methods — allowed submission methods

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. SPECIALTY MARKETS (the directory)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_markets (
  id uuid primary key default gen_random_uuid(),
  name varchar(200) not null,
  market_type text not null default 'carrier' check (market_type in (
    'carrier', 'broker', 'mga', 'wholesaler', 'program_administrator', 'other'
  )),
  is_active boolean not null default true,

  -- Contact/submission info
  website_url text,
  portal_url text,
  submission_email varchar(200),
  submission_instructions text,

  -- Underwriting/appetite notes
  appetite_notes text,
  states_notes text,
  equipment_notes text,
  new_venture_notes text,
  coverage_notes text,

  -- Metadata
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),

  constraint specialty_markets_name_not_empty
    check (char_length(trim(name)) > 0)
);

create unique index if not exists idx_specialty_markets_name_unique
  on public.specialty_markets(lower(trim(name)));

create index if not exists idx_specialty_markets_active
  on public.specialty_markets(is_active) where is_active = true;

drop trigger if exists specialty_markets_touch_updated_at on public.specialty_markets;
create trigger specialty_markets_touch_updated_at
  before update on public.specialty_markets
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. SPECIALTY MARKET ALIASES (name normalization)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_market_aliases (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.specialty_markets(id) on delete cascade,
  alias varchar(200) not null,
  created_at timestamptz not null default now(),

  constraint specialty_market_aliases_not_empty
    check (char_length(trim(alias)) > 0)
);

create index if not exists idx_specialty_market_aliases_market
  on public.specialty_market_aliases(market_id);

create unique index if not exists idx_specialty_market_aliases_unique
  on public.specialty_market_aliases(lower(trim(alias)));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. SPECIALTY MARKET LOBS (which lines a market supports)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_market_lobs (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.specialty_markets(id) on delete cascade,
  lob text not null check (lob in ('trucking', 'homeowners', 'commercial_gl')),
  created_at timestamptz not null default now(),

  constraint specialty_market_lobs_unique unique (market_id, lob)
);

create index if not exists idx_specialty_market_lobs_market
  on public.specialty_market_lobs(market_id);

create index if not exists idx_specialty_market_lobs_by_lob
  on public.specialty_market_lobs(lob);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. SPECIALTY MARKET CONTACTS
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_market_contacts (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.specialty_markets(id) on delete cascade,
  contact_name varchar(200) not null,
  title varchar(100),
  email varchar(200),
  phone varchar(30),
  notes text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_specialty_market_contacts_market
  on public.specialty_market_contacts(market_id);

drop trigger if exists specialty_market_contacts_touch_updated_at on public.specialty_market_contacts;
create trigger specialty_market_contacts_touch_updated_at
  before update on public.specialty_market_contacts
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. SPECIALTY MARKET QUESTIONS (carrier-specific fields)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_market_questions (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.specialty_markets(id) on delete cascade,
  lob text not null check (lob in ('trucking', 'homeowners', 'commercial_gl')),
  question_label varchar(300) not null,
  field_type text not null default 'text' check (field_type in (
    'text', 'long_text', 'number', 'currency', 'percentage', 'date', 'yes_no', 'select'
  )),
  select_options jsonb, -- array of strings for 'select' type
  is_required boolean not null default false,
  is_active boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint specialty_market_questions_label_not_empty
    check (char_length(trim(question_label)) > 0)
);

create index if not exists idx_specialty_market_questions_market_lob
  on public.specialty_market_questions(market_id, lob);

drop trigger if exists specialty_market_questions_touch_updated_at on public.specialty_market_questions;
create trigger specialty_market_questions_touch_updated_at
  before update on public.specialty_market_questions
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. SPECIALTY MARKET TEMPLATES (PDF template configuration)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_market_templates (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.specialty_markets(id) on delete cascade,
  lob text not null check (lob in ('trucking', 'homeowners', 'commercial_gl')),
  template_name varchar(200) not null,
  template_version varchar(20) not null default 'v1',
  is_active boolean not null default true,
  -- Path to blank PDF in storage (specialty-documents bucket)
  blank_template_path text,
  -- JSON field mapping: { pdfFieldName: "sourceDataPath" }
  field_mapping jsonb not null default '{}'::jsonb,
  -- Metadata
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),

  constraint specialty_market_templates_name_not_empty
    check (char_length(trim(template_name)) > 0)
);

create index if not exists idx_specialty_market_templates_market_lob
  on public.specialty_market_templates(market_id, lob);

drop trigger if exists specialty_market_templates_touch_updated_at on public.specialty_market_templates;
create trigger specialty_market_templates_touch_updated_at
  before update on public.specialty_market_templates
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. SPECIALTY MARKET SUBMISSION METHODS
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_market_submission_methods (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.specialty_markets(id) on delete cascade,
  method text not null check (method in (
    'portal', 'email', 'generated_pdf', 'generated_pdf_email', 'manual_other'
  )),
  is_default boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),

  constraint specialty_market_submission_methods_unique unique (market_id, method)
);

create index if not exists idx_specialty_market_submission_methods_market
  on public.specialty_market_submission_methods(market_id);

commit;
-- v1.13.1 Specialty Opportunities, Market Submissions, Results, Documents & Activity
--
-- Builds on v1.13.0 (Market Directory). Creates the operational tables for:
--   - Specialty Opportunities (the quote/account being worked)
--   - Specialty Teams (who can access which LOB)
--   - Market Submissions (linking a market to an opportunity)
--   - Market Submission Answers (market-specific question responses)
--   - Market Quote Results (pricing/coverage returned by a market)
--   - Opportunity Documents (shared supporting docs: loss runs, MVRs, etc.)
--   - Generated Documents (carrier applications produced by the system)
--   - Submission Tracking (when/how something was actually submitted)
--   - Specialty Activity Log (full audit trail)
--   - Supplemental Data (specialty-specific info not in CS intake)

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. SPECIALTY TEAMS (LOB-based team membership)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_teams (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  lob text not null check (lob in ('trucking', 'homeowners', 'commercial_gl')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint specialty_teams_unique unique (profile_id, lob)
);

create index if not exists idx_specialty_teams_lob
  on public.specialty_teams(lob) where is_active = true;

create index if not exists idx_specialty_teams_profile
  on public.specialty_teams(profile_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. SPECIALTY OPPORTUNITIES (the core quote/account)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_opportunities (
  id uuid primary key default gen_random_uuid(),
  lob text not null check (lob in ('trucking', 'homeowners', 'commercial_gl')),

  -- Customer/account identification
  customer_name varchar(250) not null,
  business_name varchar(250),
  dot_number varchar(20),
  mc_number varchar(20),

  -- Link to CS intake if originated there
  source_intake_id uuid references public.cs_intake_submissions(id),
  -- Link to commercial board card if applicable
  source_commercial_quote_id uuid references public.commercial_quotes(id),

  -- Opportunity workflow stage (overall, independent of market statuses)
  stage text not null default 'intake' check (stage in (
    'intake', 'gathering_info', 'marketing', 'quoting',
    'price_sent', 'negotiating', 'bound', 'lost', 'dead'
  )),

  -- Assignment
  primary_assignee_id uuid references public.profiles(id),
  claimed_by_id uuid references public.profiles(id),
  claimed_at timestamptz,

  -- Dates
  effective_date date,
  expiration_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,

  -- Metadata
  created_by uuid not null references public.profiles(id),
  priority text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
  notes text,

  constraint specialty_opportunities_customer_not_empty
    check (char_length(trim(customer_name)) > 0)
);

create index if not exists idx_specialty_opportunities_lob_stage
  on public.specialty_opportunities(lob, stage);

create index if not exists idx_specialty_opportunities_assignee
  on public.specialty_opportunities(primary_assignee_id);

create index if not exists idx_specialty_opportunities_intake
  on public.specialty_opportunities(source_intake_id) where source_intake_id is not null;

create index if not exists idx_specialty_opportunities_created
  on public.specialty_opportunities(created_at desc);

drop trigger if exists specialty_opportunities_touch_updated_at on public.specialty_opportunities;
create trigger specialty_opportunities_touch_updated_at
  before update on public.specialty_opportunities
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. SPECIALTY SUPPLEMENTAL DATA (beyond CS intake)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_supplemental_data (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,
  field_key varchar(100) not null,
  field_label varchar(300) not null,
  field_value text,
  field_type text not null default 'text' check (field_type in (
    'text', 'long_text', 'number', 'currency', 'percentage', 'date', 'yes_no', 'select'
  )),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),

  constraint specialty_supplemental_unique unique (opportunity_id, field_key)
);

create index if not exists idx_specialty_supplemental_opportunity
  on public.specialty_supplemental_data(opportunity_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. MARKET SUBMISSIONS (linking a market to an opportunity)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_market_submissions (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,
  market_id uuid not null references public.specialty_markets(id),

  -- Market-level status (independent of overall opportunity stage)
  status text not null default 'not_started' check (status in (
    'not_started', 'preparing', 'ready_to_submit', 'submitted',
    'waiting', 'more_info_needed', 'quote_received',
    'declined', 'not_competitive', 'withdrawn'
  )),

  -- Readiness
  readiness text not null default 'not_checked' check (readiness in (
    'not_checked', 'ready', 'missing_information', 'missing_documents'
  )),

  -- Submission method used
  submission_method text check (submission_method is null or submission_method in (
    'portal', 'email', 'generated_pdf', 'generated_pdf_email', 'manual_other'
  )),

  -- Tracking
  added_by uuid not null references public.profiles(id),
  added_at timestamptz not null default now(),
  submitted_by uuid references public.profiles(id),
  submitted_at timestamptz,
  external_reference varchar(100),
  submission_notes text,

  -- Soft remove vs withdraw
  is_withdrawn boolean not null default false,
  withdrawn_by uuid references public.profiles(id),
  withdrawn_at timestamptz,
  withdraw_reason text,

  -- Allow remove only if no meaningful activity
  is_removed boolean not null default false,
  removed_by uuid references public.profiles(id),
  removed_at timestamptz,

  updated_at timestamptz not null default now(),

  constraint specialty_market_submissions_unique
    unique (opportunity_id, market_id) where is_removed = false and is_withdrawn = false
);

create index if not exists idx_specialty_submissions_opportunity
  on public.specialty_market_submissions(opportunity_id);

create index if not exists idx_specialty_submissions_market
  on public.specialty_market_submissions(market_id);

create index if not exists idx_specialty_submissions_status
  on public.specialty_market_submissions(status);

drop trigger if exists specialty_market_submissions_touch_updated_at on public.specialty_market_submissions;
create trigger specialty_market_submissions_touch_updated_at
  before update on public.specialty_market_submissions
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. MARKET SUBMISSION ANSWERS (responses to market-specific questions)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_submission_answers (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.specialty_market_submissions(id) on delete cascade,
  question_id uuid not null references public.specialty_market_questions(id),
  answer_value text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),

  constraint specialty_submission_answers_unique unique (submission_id, question_id)
);

create index if not exists idx_specialty_submission_answers_submission
  on public.specialty_submission_answers(submission_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. MARKET QUOTE RESULTS (pricing/coverage returned)
--    One market submission can produce MULTIPLE results (different carriers/coverages)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_market_results (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.specialty_market_submissions(id) on delete cascade,

  -- The actual underwriting carrier (may differ from the submitting market)
  underwriting_carrier varchar(200),

  -- Coverage details
  coverage_type varchar(100),
  annual_premium numeric(12,2),
  fees numeric(10,2),
  down_payment numeric(10,2),
  num_installments integer,
  installment_amount numeric(10,2),
  limits_description text,
  deductibles_description text,
  quote_reference varchar(100),
  notes text,

  -- Proposal attachment (path in specialty-documents bucket)
  proposal_attachment_path text,
  proposal_file_name varchar(255),

  -- Tracking
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id)
);

create index if not exists idx_specialty_market_results_submission
  on public.specialty_market_results(submission_id);

drop trigger if exists specialty_market_results_touch_updated_at on public.specialty_market_results;
create trigger specialty_market_results_touch_updated_at
  before update on public.specialty_market_results
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. OPPORTUNITY DOCUMENTS (shared supporting docs)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_opportunity_documents (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,
  document_type text not null check (document_type in (
    'loss_runs', 'driver_license', 'registration', 'dec_page',
    'photo', 'mvr', 'ifta', 'safety_record', 'other'
  )),
  file_name varchar(255) not null,
  file_size bigint not null check (file_size > 0),
  mime_type varchar(100) not null,
  storage_path text not null, -- path in specialty-documents bucket
  description text,
  uploaded_by uuid not null references public.profiles(id),
  uploaded_at timestamptz not null default now()
);

create index if not exists idx_specialty_opportunity_documents_opp
  on public.specialty_opportunity_documents(opportunity_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. GENERATED DOCUMENTS (carrier applications produced by the system)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_generated_documents (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.specialty_market_submissions(id) on delete cascade,
  template_id uuid not null references public.specialty_market_templates(id),

  -- Version tracking
  version_number integer not null default 1,
  storage_path text not null, -- path in specialty-documents bucket
  file_name varchar(255) not null,

  -- Generation metadata
  generated_by uuid not null references public.profiles(id),
  generated_at timestamptz not null default now(),
  template_version varchar(20) not null,

  -- Source data snapshot hash (for stale detection)
  source_data_hash varchar(64),

  -- Submission tracking
  is_submitted boolean not null default false,
  submitted_by uuid references public.profiles(id),
  submitted_at timestamptz,

  -- Review status
  review_status text not null default 'review_required' check (review_status in (
    'review_required', 'reviewed', 'approved'
  ))
);

create index if not exists idx_specialty_generated_docs_submission
  on public.specialty_generated_documents(submission_id);

create index if not exists idx_specialty_generated_docs_version
  on public.specialty_generated_documents(submission_id, version_number desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. SUBMISSION TRACKING (explicit record of actual submission)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_submission_tracking (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.specialty_market_submissions(id) on delete cascade,
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default now(),
  submission_method text not null check (submission_method in (
    'portal', 'email', 'generated_pdf', 'generated_pdf_email', 'manual_other'
  )),
  generated_document_id uuid references public.specialty_generated_documents(id),
  external_reference varchar(100),
  notes text
);

create index if not exists idx_specialty_submission_tracking_submission
  on public.specialty_submission_tracking(submission_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. PRICE SENT TRACKING (explicit action: customer was presented pricing)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_price_sent (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,
  sent_by uuid not null references public.profiles(id),
  sent_at timestamptz not null default now(),
  -- Which results were presented
  result_ids uuid[] not null default '{}',
  notes text,
  method text check (method is null or method in ('phone', 'email', 'in_person', 'text', 'other'))
);

create index if not exists idx_specialty_price_sent_opportunity
  on public.specialty_price_sent(opportunity_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. SPECIALTY ACTIVITY LOG (full audit trail)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.specialty_activity_log (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,
  submission_id uuid references public.specialty_market_submissions(id),
  actor_id uuid not null references public.profiles(id),
  event_type text not null check (event_type in (
    'opportunity_created', 'stage_changed', 'assignee_changed', 'claimed',
    'market_added', 'market_removed', 'market_withdrawn',
    'market_status_changed', 'supplemental_changed',
    'document_uploaded', 'document_generated', 'document_regenerated',
    'marked_submitted', 'info_requested', 'quote_received',
    'decline_received', 'result_entered', 'result_updated',
    'price_sent', 'bound', 'lost',
    'answer_updated', 'readiness_changed',
    'note_added'
  )),
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_specialty_activity_opportunity
  on public.specialty_activity_log(opportunity_id, created_at desc);

create index if not exists idx_specialty_activity_submission
  on public.specialty_activity_log(submission_id) where submission_id is not null;

create index if not exists idx_specialty_activity_actor
  on public.specialty_activity_log(actor_id);

commit;
-- v1.13.2 Specialty — Row Level Security Policies
--
-- Access model:
--   - Market Directory (read): all authenticated users can read active markets
--   - Market Directory (write): managers and super_admins only
--   - Specialty Opportunities: team members for that LOB + managers/super_admins
--   - All child tables: inherit access through parent opportunity
--   - Specialty Teams: managers can manage, users can read their own membership
--
-- Uses nhwd_role() which returns 'manager' for both manager and super_admin.
-- Specialty Team membership determines who can view/edit opportunities.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPER: Check if user is on a specialty team for a given LOB
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.is_specialty_team_member(p_lob text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.specialty_teams
    where profile_id = auth.uid()
      and lob = p_lob
      and is_active = true
  )
$$;

-- Check if user can access a specific opportunity (team member or manager)
create or replace function public.can_access_specialty_opportunity(p_opportunity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
    or exists (
      select 1
      from public.specialty_opportunities o
      join public.specialty_teams t on t.lob = o.lob and t.profile_id = auth.uid() and t.is_active = true
      where o.id = p_opportunity_id
    )
$$;

grant execute on function public.is_specialty_team_member(text) to authenticated;
grant execute on function public.can_access_specialty_opportunity(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. SPECIALTY MARKETS — Read: all authenticated; Write: managers only
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_markets enable row level security;

create policy "specialty_markets_select" on public.specialty_markets
  for select to authenticated
  using (true);

create policy "specialty_markets_insert" on public.specialty_markets
  for insert to authenticated
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

create policy "specialty_markets_update" on public.specialty_markets
  for update to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- No delete policy: markets are deactivated, not deleted

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. SPECIALTY MARKET ALIASES — same as markets
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_market_aliases enable row level security;

create policy "specialty_market_aliases_select" on public.specialty_market_aliases
  for select to authenticated
  using (true);

create policy "specialty_market_aliases_write" on public.specialty_market_aliases
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. SPECIALTY MARKET LOBS — same as markets
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_market_lobs enable row level security;

create policy "specialty_market_lobs_select" on public.specialty_market_lobs
  for select to authenticated
  using (true);

create policy "specialty_market_lobs_write" on public.specialty_market_lobs
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. SPECIALTY MARKET CONTACTS — same as markets
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_market_contacts enable row level security;

create policy "specialty_market_contacts_select" on public.specialty_market_contacts
  for select to authenticated
  using (true);

create policy "specialty_market_contacts_write" on public.specialty_market_contacts
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. SPECIALTY MARKET QUESTIONS — same as markets
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_market_questions enable row level security;

create policy "specialty_market_questions_select" on public.specialty_market_questions
  for select to authenticated
  using (true);

create policy "specialty_market_questions_write" on public.specialty_market_questions
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. SPECIALTY MARKET TEMPLATES — same as markets
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_market_templates enable row level security;

create policy "specialty_market_templates_select" on public.specialty_market_templates
  for select to authenticated
  using (true);

create policy "specialty_market_templates_write" on public.specialty_market_templates
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. SPECIALTY MARKET SUBMISSION METHODS — same as markets
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_market_submission_methods enable row level security;

create policy "specialty_market_submission_methods_select" on public.specialty_market_submission_methods
  for select to authenticated
  using (true);

create policy "specialty_market_submission_methods_write" on public.specialty_market_submission_methods
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. SPECIALTY TEAMS — managers manage; users read own membership
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_teams enable row level security;

create policy "specialty_teams_select" on public.specialty_teams
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

create policy "specialty_teams_write" on public.specialty_teams
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. SPECIALTY OPPORTUNITIES — team members + managers
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_opportunities enable row level security;

create policy "specialty_opportunities_select" on public.specialty_opportunities
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
    or exists (
      select 1 from public.specialty_teams t
      where t.profile_id = auth.uid()
        and t.lob = specialty_opportunities.lob
        and t.is_active = true
    )
  );

create policy "specialty_opportunities_insert" on public.specialty_opportunities
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and (
      (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
      or exists (
        select 1 from public.specialty_teams t
        where t.profile_id = auth.uid()
          and t.lob = specialty_opportunities.lob
          and t.is_active = true
      )
    )
  );

create policy "specialty_opportunities_update" on public.specialty_opportunities
  for update to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
    or exists (
      select 1 from public.specialty_teams t
      where t.profile_id = auth.uid()
        and t.lob = specialty_opportunities.lob
        and t.is_active = true
    )
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
    or exists (
      select 1 from public.specialty_teams t
      where t.profile_id = auth.uid()
        and t.lob = specialty_opportunities.lob
        and t.is_active = true
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. SPECIALTY SUPPLEMENTAL DATA — inherits from opportunity
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_supplemental_data enable row level security;

create policy "specialty_supplemental_select" on public.specialty_supplemental_data
  for select to authenticated
  using (public.can_access_specialty_opportunity(opportunity_id));

create policy "specialty_supplemental_write" on public.specialty_supplemental_data
  for all to authenticated
  using (public.can_access_specialty_opportunity(opportunity_id))
  with check (public.can_access_specialty_opportunity(opportunity_id));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. SPECIALTY MARKET SUBMISSIONS — inherits from opportunity
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_market_submissions enable row level security;

create policy "specialty_submissions_select" on public.specialty_market_submissions
  for select to authenticated
  using (public.can_access_specialty_opportunity(opportunity_id));

create policy "specialty_submissions_insert" on public.specialty_market_submissions
  for insert to authenticated
  with check (
    added_by = auth.uid()
    and public.can_access_specialty_opportunity(opportunity_id)
  );

create policy "specialty_submissions_update" on public.specialty_market_submissions
  for update to authenticated
  using (public.can_access_specialty_opportunity(opportunity_id))
  with check (public.can_access_specialty_opportunity(opportunity_id));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. SPECIALTY SUBMISSION ANSWERS — inherits via submission → opportunity
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_submission_answers enable row level security;

create policy "specialty_answers_select" on public.specialty_submission_answers
  for select to authenticated
  using (
    exists (
      select 1 from public.specialty_market_submissions s
      where s.id = specialty_submission_answers.submission_id
        and public.can_access_specialty_opportunity(s.opportunity_id)
    )
  );

create policy "specialty_answers_write" on public.specialty_submission_answers
  for all to authenticated
  using (
    exists (
      select 1 from public.specialty_market_submissions s
      where s.id = specialty_submission_answers.submission_id
        and public.can_access_specialty_opportunity(s.opportunity_id)
    )
  )
  with check (
    exists (
      select 1 from public.specialty_market_submissions s
      where s.id = specialty_submission_answers.submission_id
        and public.can_access_specialty_opportunity(s.opportunity_id)
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 13. SPECIALTY MARKET RESULTS — inherits via submission → opportunity
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_market_results enable row level security;

create policy "specialty_results_select" on public.specialty_market_results
  for select to authenticated
  using (
    exists (
      select 1 from public.specialty_market_submissions s
      where s.id = specialty_market_results.submission_id
        and public.can_access_specialty_opportunity(s.opportunity_id)
    )
  );

create policy "specialty_results_write" on public.specialty_market_results
  for all to authenticated
  using (
    exists (
      select 1 from public.specialty_market_submissions s
      where s.id = specialty_market_results.submission_id
        and public.can_access_specialty_opportunity(s.opportunity_id)
    )
  )
  with check (
    exists (
      select 1 from public.specialty_market_submissions s
      where s.id = specialty_market_results.submission_id
        and public.can_access_specialty_opportunity(s.opportunity_id)
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 14. SPECIALTY OPPORTUNITY DOCUMENTS — inherits from opportunity
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_opportunity_documents enable row level security;

create policy "specialty_docs_select" on public.specialty_opportunity_documents
  for select to authenticated
  using (public.can_access_specialty_opportunity(opportunity_id));

create policy "specialty_docs_insert" on public.specialty_opportunity_documents
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.can_access_specialty_opportunity(opportunity_id)
  );

-- No delete: documents are kept for audit trail
-- Managers can delete if needed
create policy "specialty_docs_delete" on public.specialty_opportunity_documents
  for delete to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 15. SPECIALTY GENERATED DOCUMENTS — inherits via submission → opportunity
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_generated_documents enable row level security;

create policy "specialty_gen_docs_select" on public.specialty_generated_documents
  for select to authenticated
  using (
    exists (
      select 1 from public.specialty_market_submissions s
      where s.id = specialty_generated_documents.submission_id
        and public.can_access_specialty_opportunity(s.opportunity_id)
    )
  );

create policy "specialty_gen_docs_insert" on public.specialty_generated_documents
  for insert to authenticated
  with check (
    generated_by = auth.uid()
    and exists (
      select 1 from public.specialty_market_submissions s
      where s.id = specialty_generated_documents.submission_id
        and public.can_access_specialty_opportunity(s.opportunity_id)
    )
  );

create policy "specialty_gen_docs_update" on public.specialty_generated_documents
  for update to authenticated
  using (
    exists (
      select 1 from public.specialty_market_submissions s
      where s.id = specialty_generated_documents.submission_id
        and public.can_access_specialty_opportunity(s.opportunity_id)
    )
  )
  with check (
    exists (
      select 1 from public.specialty_market_submissions s
      where s.id = specialty_generated_documents.submission_id
        and public.can_access_specialty_opportunity(s.opportunity_id)
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 16. SPECIALTY SUBMISSION TRACKING — inherits via submission → opportunity
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_submission_tracking enable row level security;

create policy "specialty_tracking_select" on public.specialty_submission_tracking
  for select to authenticated
  using (
    exists (
      select 1 from public.specialty_market_submissions s
      where s.id = specialty_submission_tracking.submission_id
        and public.can_access_specialty_opportunity(s.opportunity_id)
    )
  );

create policy "specialty_tracking_insert" on public.specialty_submission_tracking
  for insert to authenticated
  with check (
    submitted_by = auth.uid()
    and exists (
      select 1 from public.specialty_market_submissions s
      where s.id = specialty_submission_tracking.submission_id
        and public.can_access_specialty_opportunity(s.opportunity_id)
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 17. SPECIALTY PRICE SENT — inherits from opportunity
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_price_sent enable row level security;

create policy "specialty_price_sent_select" on public.specialty_price_sent
  for select to authenticated
  using (public.can_access_specialty_opportunity(opportunity_id));

create policy "specialty_price_sent_insert" on public.specialty_price_sent
  for insert to authenticated
  with check (
    sent_by = auth.uid()
    and public.can_access_specialty_opportunity(opportunity_id)
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 18. SPECIALTY ACTIVITY LOG — inherits from opportunity (read-only for non-managers)
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.specialty_activity_log enable row level security;

create policy "specialty_activity_select" on public.specialty_activity_log
  for select to authenticated
  using (public.can_access_specialty_opportunity(opportunity_id));

-- Insert: only via the actual actor
create policy "specialty_activity_insert" on public.specialty_activity_log
  for insert to authenticated
  with check (
    actor_id = auth.uid()
    and public.can_access_specialty_opportunity(opportunity_id)
  );

commit;
-- v1.13.3 Specialty — Private Storage Bucket for Documents
--
-- Creates the `specialty-documents` bucket for:
--   - Shared opportunity documents (loss runs, driver licenses, dec pages, etc.)
--   - Generated carrier applications (JSA, TIA PDFs)
--   - Market proposal attachments
--   - Blank PDF templates
--
-- Private bucket, 100 MiB limit, no MIME restriction.
-- Access controlled via RLS policies on storage.objects that check
-- specialty team membership through the opportunity.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. CREATE BUCKET
-- ═══════════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public, file_size_limit)
values ('specialty-documents', 'specialty-documents', false, 104857600)
on conflict (id) do update
set public = false,
    file_size_limit = 104857600;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ACCESS HELPER — can user access files for a given opportunity?
--    File paths follow: {opportunity_id}/... or templates/{market_id}/...
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.specialty_can_access_document(p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_first_segment text;
  v_role text;
begin
  -- Extract first path segment
  v_first_segment := split_part(p_path, '/', 1);

  -- Get user role
  select role into v_role from public.profiles where id = auth.uid() and is_active;
  if v_role is null then return false; end if;

  -- Managers/super_admins can access everything
  if v_role in ('manager', 'super_admin') then return true; end if;

  -- Template files are accessible to all team members (path: templates/...)
  if v_first_segment = 'templates' then
    return exists (
      select 1 from public.specialty_teams
      where profile_id = auth.uid() and is_active = true
    );
  end if;

  -- Opportunity files: check team membership for that opportunity's LOB
  return exists (
    select 1
    from public.specialty_opportunities o
    join public.specialty_teams t on t.lob = o.lob and t.profile_id = auth.uid() and t.is_active = true
    where o.id = v_first_segment::uuid
  );

exception when others then
  return false;
end;
$$;

grant execute on function public.specialty_can_access_document(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. STORAGE POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════
-- Drop if re-applying
drop policy if exists specialty_documents_v1133_select on storage.objects;
drop policy if exists specialty_documents_v1133_insert on storage.objects;

-- SELECT: can download/view files the user has access to
create policy "specialty_documents_v1133_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'specialty-documents'
    and public.specialty_can_access_document(name)
  );

-- INSERT: can upload files the user has access to
create policy "specialty_documents_v1133_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'specialty-documents'
    and public.specialty_can_access_document(name)
  );

-- No UPDATE policy: files cannot be overwritten (versioning via new uploads)
-- No DELETE policy for non-managers: append-only for audit trail

-- Manager delete (for cleanup if needed)
drop policy if exists specialty_documents_v1133_delete on storage.objects;
create policy "specialty_documents_v1133_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'specialty-documents'
    and (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

commit;
-- v1.13.4 Specialty — Seed Initial Trucking Markets
--
-- Seeds the 10 canonical Trucking markets with:
--   - Normalized names
--   - Historical aliases (spelling variations from Trello)
--   - LOB assignment (trucking)
--   - Market type classification
--   - Basic submission methods
--   - Appetite/knowledge notes where available
--
-- Does NOT migrate portal credentials or passwords from Trello.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. National General
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.specialty_markets (id, name, market_type, appetite_notes)
values (
  'a0000000-0000-0000-0000-000000000001',
  'National General',
  'carrier',
  'Large national carrier offering trucking programs. Competitive on newer fleets with clean loss history. Handles local and intermediate radius well.'
) on conflict (lower(trim(name))) do nothing;

insert into public.specialty_market_aliases (market_id, alias) values
  ('a0000000-0000-0000-0000-000000000001', 'NatGen'),
  ('a0000000-0000-0000-0000-000000000001', 'Nat Gen'),
  ('a0000000-0000-0000-0000-000000000001', 'National Gen')
on conflict (lower(trim(alias))) do nothing;

insert into public.specialty_market_lobs (market_id, lob) values
  ('a0000000-0000-0000-0000-000000000001', 'trucking')
on conflict (market_id, lob) do nothing;

insert into public.specialty_market_submission_methods (market_id, method, is_default) values
  ('a0000000-0000-0000-0000-000000000001', 'portal', true)
on conflict (market_id, method) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Progressive
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.specialty_markets (id, name, market_type, appetite_notes)
values (
  'a0000000-0000-0000-0000-000000000002',
  'Progressive',
  'carrier',
  'Major national carrier with broad trucking appetite. Online portal for submissions. Competitive pricing on standard risks. Quick turnaround on quotes.'
) on conflict (lower(trim(name))) do nothing;

insert into public.specialty_market_lobs (market_id, lob) values
  ('a0000000-0000-0000-0000-000000000002', 'trucking')
on conflict (market_id, lob) do nothing;

insert into public.specialty_market_submission_methods (market_id, method, is_default) values
  ('a0000000-0000-0000-0000-000000000002', 'portal', true)
on conflict (market_id, method) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. JSA (Jackson Sumner & Associates)
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.specialty_markets (id, name, market_type, appetite_notes, submission_instructions)
values (
  'a0000000-0000-0000-0000-000000000003',
  'JSA',
  'mga',
  'MGA specializing in trucking. Handles standard and substandard risks. Good for new ventures with experienced operators. Requires completed JSA Truck Application.',
  'Submit completed JSA Truck Application PDF with all driver and vehicle schedules. Include loss runs (5 years) and any supplemental documentation.'
) on conflict (lower(trim(name))) do nothing;

insert into public.specialty_market_aliases (market_id, alias) values
  ('a0000000-0000-0000-0000-000000000003', 'Jackson Sumner'),
  ('a0000000-0000-0000-0000-000000000003', 'Jackson Sumner & Associates')
on conflict (lower(trim(alias))) do nothing;

insert into public.specialty_market_lobs (market_id, lob) values
  ('a0000000-0000-0000-0000-000000000003', 'trucking')
on conflict (market_id, lob) do nothing;

insert into public.specialty_market_submission_methods (market_id, method, is_default) values
  ('a0000000-0000-0000-0000-000000000003', 'generated_pdf_email', true),
  ('a0000000-0000-0000-0000-000000000003', 'email', false)
on conflict (market_id, method) do nothing;

-- JSA market-specific questions
insert into public.specialty_market_questions (market_id, lob, question_label, field_type, is_required, position) values
  ('a0000000-0000-0000-0000-000000000003', 'trucking', 'Target Premium', 'currency', false, 1),
  ('a0000000-0000-0000-0000-000000000003', 'trucking', 'Years CDL Experience (Owner)', 'number', true, 2),
  ('a0000000-0000-0000-0000-000000000003', 'trucking', 'Any DOT Violations in past 3 years?', 'yes_no', true, 3),
  ('a0000000-0000-0000-0000-000000000003', 'trucking', 'ELD Provider', 'text', false, 4),
  ('a0000000-0000-0000-0000-000000000003', 'trucking', 'Total Miles Last 12 Months', 'number', false, 5);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Strickland / SIB
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.specialty_markets (id, name, market_type, appetite_notes)
values (
  'a0000000-0000-0000-0000-000000000004',
  'Strickland / SIB',
  'mga',
  'MGA handling trucking risks. Also known as SIB (Strickland Insurance Brokers). Good appetite for owner-operators and small fleets.'
) on conflict (lower(trim(name))) do nothing;

insert into public.specialty_market_aliases (market_id, alias) values
  ('a0000000-0000-0000-0000-000000000004', 'Strickland'),
  ('a0000000-0000-0000-0000-000000000004', 'SIB'),
  ('a0000000-0000-0000-0000-000000000004', 'Strickland Insurance'),
  ('a0000000-0000-0000-0000-000000000004', 'Strickland Insurance Brokers')
on conflict (lower(trim(alias))) do nothing;

insert into public.specialty_market_lobs (market_id, lob) values
  ('a0000000-0000-0000-0000-000000000004', 'trucking')
on conflict (market_id, lob) do nothing;

insert into public.specialty_market_submission_methods (market_id, method, is_default) values
  ('a0000000-0000-0000-0000-000000000004', 'portal', true),
  ('a0000000-0000-0000-0000-000000000004', 'email', false)
on conflict (market_id, method) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. All Star Underwriters
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.specialty_markets (id, name, market_type, appetite_notes)
values (
  'a0000000-0000-0000-0000-000000000005',
  'All Star Underwriters',
  'mga',
  'Trucking-focused MGA. Handles difficult risks and new ventures. Competitive on non-standard trucking classes.'
) on conflict (lower(trim(name))) do nothing;

insert into public.specialty_market_aliases (market_id, alias) values
  ('a0000000-0000-0000-0000-000000000005', 'All Star Underwritters'),
  ('a0000000-0000-0000-0000-000000000005', 'AllStar Underwriters'),
  ('a0000000-0000-0000-0000-000000000005', 'All Star')
on conflict (lower(trim(alias))) do nothing;

insert into public.specialty_market_lobs (market_id, lob) values
  ('a0000000-0000-0000-0000-000000000005', 'trucking')
on conflict (market_id, lob) do nothing;

insert into public.specialty_market_submission_methods (market_id, method, is_default) values
  ('a0000000-0000-0000-0000-000000000005', 'portal', true)
on conflict (market_id, method) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. Commonwealth Underwriters
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.specialty_markets (id, name, market_type, appetite_notes)
values (
  'a0000000-0000-0000-0000-000000000006',
  'Commonwealth Underwriters',
  'wholesaler',
  'Wholesaler with multiple carrier markets for trucking. Can provide split coverage (different carriers for auto liability, cargo, physical damage). Good for package deals.'
) on conflict (lower(trim(name))) do nothing;

insert into public.specialty_market_aliases (market_id, alias) values
  ('a0000000-0000-0000-0000-000000000006', 'Common Underwritters'),
  ('a0000000-0000-0000-0000-000000000006', 'Common Wealth'),
  ('a0000000-0000-0000-0000-000000000006', 'Commonwealth'),
  ('a0000000-0000-0000-0000-000000000006', 'Commonwealth UW')
on conflict (lower(trim(alias))) do nothing;

insert into public.specialty_market_lobs (market_id, lob) values
  ('a0000000-0000-0000-0000-000000000006', 'trucking')
on conflict (market_id, lob) do nothing;

insert into public.specialty_market_submission_methods (market_id, method, is_default) values
  ('a0000000-0000-0000-0000-000000000006', 'email', true),
  ('a0000000-0000-0000-0000-000000000006', 'portal', false)
on conflict (market_id, method) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. Eastern Underwriting Managers
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.specialty_markets (id, name, market_type, appetite_notes)
values (
  'a0000000-0000-0000-0000-000000000007',
  'Eastern Underwriting Managers',
  'mga',
  'MGA focused on trucking and commercial auto. Appetite for various trucking classes including local, intermediate, and long-haul operations.'
) on conflict (lower(trim(name))) do nothing;

insert into public.specialty_market_aliases (market_id, alias) values
  ('a0000000-0000-0000-0000-000000000007', 'Easteern Underwriting managers'),
  ('a0000000-0000-0000-0000-000000000007', 'Eastern Underwriting'),
  ('a0000000-0000-0000-0000-000000000007', 'Eastern UW'),
  ('a0000000-0000-0000-0000-000000000007', 'EUM')
on conflict (lower(trim(alias))) do nothing;

insert into public.specialty_market_lobs (market_id, lob) values
  ('a0000000-0000-0000-0000-000000000007', 'trucking')
on conflict (market_id, lob) do nothing;

insert into public.specialty_market_submission_methods (market_id, method, is_default) values
  ('a0000000-0000-0000-0000-000000000007', 'email', true)
on conflict (market_id, method) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. Truckers Insurance Associates / TIA
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.specialty_markets (id, name, market_type, appetite_notes, submission_instructions)
values (
  'a0000000-0000-0000-0000-000000000008',
  'Truckers Insurance Associates / TIA',
  'mga',
  'Trucking-specialist MGA. Quick Quote form for initial pricing. Full application for binding. Good appetite for owner-operators and small fleets. Competitive on cargo.',
  'Submit completed TIA Quick Quote form for initial pricing. Full application and supporting docs required for binding.'
) on conflict (lower(trim(name))) do nothing;

insert into public.specialty_market_aliases (market_id, alias) values
  ('a0000000-0000-0000-0000-000000000008', 'TIA'),
  ('a0000000-0000-0000-0000-000000000008', 'Truckers Insurance'),
  ('a0000000-0000-0000-0000-000000000008', 'Truckers Insurance Associates')
on conflict (lower(trim(alias))) do nothing;

insert into public.specialty_market_lobs (market_id, lob) values
  ('a0000000-0000-0000-0000-000000000008', 'trucking')
on conflict (market_id, lob) do nothing;

insert into public.specialty_market_submission_methods (market_id, method, is_default) values
  ('a0000000-0000-0000-0000-000000000008', 'generated_pdf_email', true),
  ('a0000000-0000-0000-0000-000000000008', 'email', false)
on conflict (market_id, method) do nothing;

-- TIA market-specific questions
insert into public.specialty_market_questions (market_id, lob, question_label, field_type, is_required, position) values
  ('a0000000-0000-0000-0000-000000000008', 'trucking', 'Percentage of Loads Through Brokers', 'percentage', true, 1),
  ('a0000000-0000-0000-0000-000000000008', 'trucking', 'Destination Cities (Top 3)', 'text', true, 2),
  ('a0000000-0000-0000-0000-000000000008', 'trucking', 'Cities Traveled Through (Top 3)', 'text', true, 3),
  ('a0000000-0000-0000-0000-000000000008', 'trucking', 'Annual Revenue', 'currency', true, 4),
  ('a0000000-0000-0000-0000-000000000008', 'trucking', 'Annual Mileage (All Units)', 'number', true, 5),
  ('a0000000-0000-0000-0000-000000000008', 'trucking', 'FEIN', 'text', true, 6),
  ('a0000000-0000-0000-0000-000000000008', 'trucking', 'ELD Provider', 'text', false, 7),
  ('a0000000-0000-0000-0000-000000000008', 'trucking', 'Years Insured Continuously', 'number', false, 8);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. Cover Badger
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.specialty_markets (id, name, market_type, appetite_notes)
values (
  'a0000000-0000-0000-0000-000000000009',
  'Cover Badger',
  'mga',
  'Digital-first MGA for trucking. Online submission process. Good for standard trucking risks with clean history.'
) on conflict (lower(trim(name))) do nothing;

insert into public.specialty_market_lobs (market_id, lob) values
  ('a0000000-0000-0000-0000-000000000009', 'trucking')
on conflict (market_id, lob) do nothing;

insert into public.specialty_market_submission_methods (market_id, method, is_default) values
  ('a0000000-0000-0000-0000-000000000009', 'portal', true)
on conflict (market_id, method) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. Amwins
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.specialty_markets (id, name, market_type, appetite_notes)
values (
  'a0000000-0000-0000-0000-000000000010',
  'Amwins',
  'wholesaler',
  'Large national wholesaler with access to many trucking markets. Good for hard-to-place risks and specialty operations. Can often find coverage when standard markets decline.'
) on conflict (lower(trim(name))) do nothing;

insert into public.specialty_market_aliases (market_id, alias) values
  ('a0000000-0000-0000-0000-000000000010', 'Amwins Group'),
  ('a0000000-0000-0000-0000-000000000010', 'Amwins Transportation')
on conflict (lower(trim(alias))) do nothing;

insert into public.specialty_market_lobs (market_id, lob) values
  ('a0000000-0000-0000-0000-000000000010', 'trucking')
on conflict (market_id, lob) do nothing;

insert into public.specialty_market_submission_methods (market_id, method, is_default) values
  ('a0000000-0000-0000-0000-000000000010', 'email', true),
  ('a0000000-0000-0000-0000-000000000010', 'portal', false)
on conflict (market_id, method) do nothing;

commit;
-- v1.13.5 Specialty — Seed JSA and TIA PDF Templates
--
-- Inserts template records for:
--   - JSA Truck Application (v1)
--   - TIA Quick Quote (v1)
--
-- The field_mapping JSON drives PDF generation. The blank_template_path
-- is null until the official carrier PDFs are uploaded to storage.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. JSA Truck Application
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.specialty_market_templates (
  id, market_id, lob, template_name, template_version, is_active,
  blank_template_path, field_mapping
) values (
  'b0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000003', -- JSA
  'trucking',
  'JSA Truck Application',
  'v1',
  true,
  null, -- Official blank PDF to be uploaded
  '{
    "_max_drivers": "6",
    "_max_vehicles": "10",
    "Applicant_Information.Business Name": "required:business_name",
    "Applicant_Information.Insured Name": "required:insured_name",
    "Applicant_Information.Mailing Address": "addr_street",
    "Applicant_Information.City": "addr_city",
    "Applicant_Information.State": "addr_state",
    "Applicant_Information.Zip": "addr_zip",
    "Applicant_Information.DOT Number": "required:dot_number",
    "Applicant_Information.MC Number": "mc_number",
    "Applicant_Information.Effective Date": "effective_date",
    "Applicant_Information.Phone": "insured_phone_primary",
    "Applicant_Information.Email": "insured_email",
    "Applicant_Information.FEIN": "ein",
    "Business_Details.Type of Work": "business_type",
    "Business_Details.Years in Business": "years_in_business",
    "Business_Details.Years CDL Experience": "years_cdl_experience",
    "Business_Details.Cargo Type": "cargo_type",
    "Business_Details.Power Unit Count": "power_unit_count",
    "Business_Details.Operating Radius (miles)": "operating_radius_miles",
    "Business_Details.MCS-150 Date": "mcs150_date",
    "Prior_Insurance.Current Carrier": "current_carrier",
    "Prior_Insurance.Policy Number": "current_policy_number",
    "Prior_Insurance.Current Premium": "current_premium",
    "Prior_Insurance.Expiration Date": "current_expiration",
    "Prior_Insurance.Months Continuous Coverage": "months_continuous_coverage",
    "Coverage_Requested.Desired Coverage": "desired_coverage",
    "Coverage_Requested.Liability Limit": "liability_limit",
    "Coverage_Requested.Comprehensive Deductible": "comprehensive_deductible",
    "Coverage_Requested.Collision Deductible": "collision_deductible",
    "JSA_Questions.Target Premium": "target_premium",
    "JSA_Questions.DOT Violations (3 years)": "any_dot_violations_in_past_3_years_",
    "JSA_Questions.ELD Provider": "eld_provider",
    "JSA_Questions.Total Miles Last 12 Months": "total_miles_last_12_months",
    "Owner.Name": "driver_1_name",
    "Owner.Date of Birth": "driver_1_dob",
    "Owner.License Number": "driver_1_license_number",
    "Owner.License State": "driver_1_license_state"
  }'::jsonb
) on conflict (id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. TIA Quick Quote
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.specialty_market_templates (
  id, market_id, lob, template_name, template_version, is_active,
  blank_template_path, field_mapping
) values (
  'b0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000008', -- TIA
  'trucking',
  'TIA Quick Quote',
  'v1',
  true,
  null, -- Official blank PDF to be uploaded
  '{
    "_max_drivers": "5",
    "_max_vehicles": "10",
    "Applicant.Insured Name": "required:insured_name",
    "Applicant.Business Name": "business_name",
    "Applicant.Mailing Address": "addr_street",
    "Applicant.City": "addr_city",
    "Applicant.State": "addr_state",
    "Applicant.Zip": "addr_zip",
    "Applicant.Phone": "insured_phone_primary",
    "Applicant.Email": "insured_email",
    "Applicant.Effective Date": "required:effective_date",
    "Operations.DOT Number": "required:dot_number",
    "Operations.MC Number": "mc_number",
    "Operations.FEIN": "required:fein",
    "Operations.Power Unit Count": "power_unit_count",
    "Operations.Annual Revenue": "required:annual_revenue",
    "Operations.Annual Mileage (All Units)": "required:annual_mileage__all_units_",
    "Operations.Cargo Type": "cargo_type",
    "Operations.Operating Radius (miles)": "operating_radius_miles",
    "Operations.Years in Business": "years_in_business",
    "Operations.ELD Provider": "eld_provider",
    "TIA_Questions.Percentage of Loads Through Brokers": "required:percentage_of_loads_through_brokers",
    "TIA_Questions.Destination Cities (Top 3)": "required:destination_cities__top_3_",
    "TIA_Questions.Cities Traveled Through (Top 3)": "required:cities_traveled_through__top_3_",
    "TIA_Questions.Years Insured Continuously": "years_insured_continuously",
    "Prior_Insurance.Current Carrier": "current_carrier",
    "Prior_Insurance.Current Premium": "current_premium",
    "Prior_Insurance.Expiration Date": "current_expiration",
    "Prior_Insurance.Months Continuous Coverage": "months_continuous_coverage",
    "Coverage_Requested.Desired Coverage": "desired_coverage",
    "Coverage_Requested.Liability Limit": "liability_limit",
    "Coverage_Requested.Comprehensive Deductible": "comprehensive_deductible",
    "Coverage_Requested.Collision Deductible": "collision_deductible",
    "Owner.Name": "driver_1_name",
    "Owner.Date of Birth": "driver_1_dob",
    "Owner.License Number": "driver_1_license_number",
    "Owner.License State": "driver_1_license_state"
  }'::jsonb
) on conflict (id) do nothing;

commit;

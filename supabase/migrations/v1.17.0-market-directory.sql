-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.17.0 — Market Directory + Carrier Applications Extension
--
-- Extends the live Specialty Quotes Engine (v1.16.x) with:
--   1. Market Directory — reusable master records for submission targets
--   2. Market aliases — historical spelling normalization
--   3. Market contacts — named people at Markets
--   4. Market knowledge — reusable submission/appetite notes
--   5. Link from existing specialty_carriers to Market Directory
--   6. Underwriting carriers — actual writing carriers per carrier market
--   7. Market requirements — what a Market needs for submission
--   8. Market questions — configurable supplemental questions
--   9. Market question answers — per carrier-market answers
--  10. Market requirement satisfaction — which docs/data satisfy which requirement
--  11. PDF template infrastructure — template storage and field mappings
--  12. Generated applications — versioned PDF history
--
-- SAFETY:
--   - All additive. No drops, no renames of live objects.
--   - Existing specialty_carriers, specialty_carrier_markets, specialty_documents,
--     specialty_activity remain unchanged except for additive columns/FKs.
--   - Idempotent seed logic (ON CONFLICT).
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. MARKET DIRECTORY — The master record of who New Hope submits to
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.market_directory (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  market_type text not null default 'other' check (market_type in (
    'direct_carrier', 'broker', 'mga', 'wholesaler', 'program_administrator', 'other'
  )),
  lines_of_business text[] not null default '{}',
  is_active boolean not null default true,

  -- Contact / submission info
  website_url text,
  portal_url text,
  submission_email text,
  phone text,

  -- Submission / underwriting knowledge (reusable, not quote-specific)
  submission_instructions text,
  territory_notes text,
  equipment_notes text,
  new_venture_notes text,
  coverage_appetite text,
  underwriting_notes text,

  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint market_directory_name_not_empty check (char_length(btrim(name)) > 0)
);

comment on table public.market_directory is
  'Reusable master record of a submission target (carrier, broker, MGA, wholesaler). One Market Directory entry may be referenced by many quote-level specialty_carriers records across many opportunities. v1.17.0.';

drop trigger if exists market_directory_touch on public.market_directory;
create trigger market_directory_touch
  before update on public.market_directory
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. MARKET ALIASES — Historical spelling normalization
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.market_directory_aliases (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.market_directory(id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now(),
  constraint market_directory_aliases_alias_unique unique (alias),
  constraint market_directory_aliases_alias_not_empty check (char_length(btrim(alias)) > 0)
);

comment on table public.market_directory_aliases is
  'Alternative spellings and abbreviations that resolve to one canonical Market. Used for historical data reconciliation and search. v1.17.0.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. MARKET CONTACTS — Named people at Markets
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.market_directory_contacts (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.market_directory(id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  title text,
  email text,
  phone text,
  notes text,
  is_primary boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.market_directory_contacts is
  'Named contacts at a Market (underwriters, account managers, submission desk). Lightweight — not a full CRM. v1.17.0.';

drop trigger if exists market_directory_contacts_touch on public.market_directory_contacts;
create trigger market_directory_contacts_touch
  before update on public.market_directory_contacts
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. LINK EXISTING SPECIALTY_CARRIERS TO MARKET DIRECTORY
--
--    The existing specialty_carriers table is the quote-level picker. Adding a
--    nullable FK to market_directory allows linking to the master record without
--    breaking the existing carrier_id FK on specialty_carrier_markets.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.specialty_carriers
  add column if not exists market_directory_id uuid references public.market_directory(id);

comment on column public.specialty_carriers.market_directory_id is
  'Optional link to the reusable Market Directory master record. Null for carriers created before v1.17.0 until reconciled. v1.17.0.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. UNDERWRITING CARRIERS — Who actually writes the insurance
--
--    One carrier market (e.g. Commonwealth) can produce multiple actual
--    carrier/coverage results (NICO → Auto Liability, Lloyd's → Cargo).
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.specialty_underwriting_results (
  id uuid primary key default gen_random_uuid(),
  carrier_market_id uuid not null references public.specialty_carrier_markets(id) on delete cascade,
  underwriting_carrier text not null check (char_length(btrim(underwriting_carrier)) > 0),
  coverage_type text not null check (char_length(btrim(coverage_type)) > 0),

  -- Pricing
  premium numeric(12, 2) check (premium is null or premium >= 0),
  fees numeric(12, 2) check (fees is null or fees >= 0),
  down_payment numeric(12, 2) check (down_payment is null or down_payment >= 0),
  installment_count integer check (installment_count is null or installment_count > 0),
  installment_amount numeric(12, 2) check (installment_amount is null or installment_amount >= 0),

  -- Coverage detail
  limits text,
  deductible text,
  quote_reference_number text,
  notes text,

  -- Proposal document (links to existing specialty_documents)
  proposal_document_id uuid references public.specialty_documents(id) on delete set null,

  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.specialty_underwriting_results is
  'Actual underwriting carrier and coverage component results under one carrier market submission. One Commonwealth submission may produce NICO Auto Liability + Lloyd''s Cargo + Lloyd''s Physical Damage. v1.17.0.';

create index if not exists specialty_underwriting_results_market_idx
  on public.specialty_underwriting_results (carrier_market_id);

drop trigger if exists specialty_underwriting_results_touch on public.specialty_underwriting_results;
create trigger specialty_underwriting_results_touch
  before update on public.specialty_underwriting_results
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. MARKET REQUIREMENTS — What a Market needs for submission
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.market_requirements (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.market_directory(id) on delete cascade,
  line_of_business text not null check (line_of_business in ('trucking', 'homeowners', 'commercial_gl')),
  requirement_type text not null check (requirement_type in ('data', 'document', 'application')),
  label text not null check (char_length(btrim(label)) > 0),
  description text,
  is_required boolean not null default true,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (market_id, line_of_business, label)
);

comment on table public.market_requirements is
  'Reusable submission requirements per Market per LOB: data fields, supporting documents, or generated applications. Evaluated against a specific carrier market for readiness. v1.17.0.';

create index if not exists market_requirements_market_lob_idx
  on public.market_requirements (market_id, line_of_business) where is_active;

drop trigger if exists market_requirements_touch on public.market_requirements;
create trigger market_requirements_touch
  before update on public.market_requirements
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. MARKET REQUIREMENT SATISFACTION — Per carrier-market tracking
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.market_requirement_satisfaction (
  id uuid primary key default gen_random_uuid(),
  carrier_market_id uuid not null references public.specialty_carrier_markets(id) on delete cascade,
  requirement_id uuid not null references public.market_requirements(id) on delete cascade,
  is_satisfied boolean not null default false,
  satisfied_by uuid references public.profiles(id),
  satisfied_at timestamptz,
  -- For document requirements: which existing document satisfies it
  document_id uuid references public.specialty_documents(id) on delete set null,
  -- For data requirements: the value or note
  data_value text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (carrier_market_id, requirement_id)
);

comment on table public.market_requirement_satisfaction is
  'Tracks whether each requirement has been met for a specific carrier market on a specific opportunity. Multiple markets may reference the same existing document. v1.17.0.';

create index if not exists market_requirement_satisfaction_market_idx
  on public.market_requirement_satisfaction (carrier_market_id);

drop trigger if exists market_requirement_satisfaction_touch on public.market_requirement_satisfaction;
create trigger market_requirement_satisfaction_touch
  before update on public.market_requirement_satisfaction
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. MARKET QUESTIONS — Configurable supplemental questions
--
--    No migration needed when a Market adds a question: it is a row insert.
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.market_questions (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.market_directory(id) on delete cascade,
  line_of_business text not null check (line_of_business in ('trucking', 'homeowners', 'commercial_gl')),
  question_text text not null check (char_length(btrim(question_text)) > 0),
  field_type text not null default 'text' check (field_type in (
    'text', 'long_text', 'number', 'currency', 'percentage', 'date', 'yes_no', 'select'
  )),
  -- For 'select' type: JSON array of option labels
  select_options jsonb,
  is_required boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  -- Data source hint: if this question can be pre-filled from intake/opportunity data
  auto_fill_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.market_questions is
  'Configurable supplemental questions per Market and LOB. Adding a question is a row insert, not a migration. Answers live on market_question_answers keyed to the carrier_market. v1.17.0.';

create index if not exists market_questions_market_lob_idx
  on public.market_questions (market_id, line_of_business) where is_active;

drop trigger if exists market_questions_touch on public.market_questions;
create trigger market_questions_touch
  before update on public.market_questions
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. MARKET QUESTION ANSWERS — Per carrier-market answers
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.market_question_answers (
  id uuid primary key default gen_random_uuid(),
  carrier_market_id uuid not null references public.specialty_carrier_markets(id) on delete cascade,
  question_id uuid not null references public.market_questions(id) on delete cascade,
  answer_value text,
  answered_by uuid references public.profiles(id),
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (carrier_market_id, question_id)
);

comment on table public.market_question_answers is
  'Answers to market-specific supplemental questions, stored per carrier_market (i.e. per quote submission). v1.17.0.';

create index if not exists market_question_answers_market_idx
  on public.market_question_answers (carrier_market_id);

drop trigger if exists market_question_answers_touch on public.market_question_answers;
create trigger market_question_answers_touch
  before update on public.market_question_answers
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. PDF TEMPLATE INFRASTRUCTURE
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.market_pdf_templates (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.market_directory(id) on delete cascade,
  line_of_business text not null check (line_of_business in ('trucking', 'homeowners', 'commercial_gl')),
  template_name text not null check (char_length(btrim(template_name)) > 0),
  version_label text not null default '1.0',
  is_active boolean not null default true,

  -- The blank PDF template file
  storage_bucket text not null default 'specialty-quote-documents',
  storage_path text,

  -- Field mapping configuration (JSON): maps data keys to PDF field names/positions
  field_mapping jsonb not null default '{}',

  -- Metadata about the PDF form
  total_pages integer,
  max_drivers integer,
  max_vehicles integer,
  max_trailers integer,

  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (market_id, line_of_business, template_name, version_label)
);

comment on table public.market_pdf_templates is
  'PDF template configuration per Market and LOB. The blank official PDF is stored in the bucket; field_mapping defines how Work Desk data maps to PDF form fields. v1.17.0.';

drop trigger if exists market_pdf_templates_touch on public.market_pdf_templates;
create trigger market_pdf_templates_touch
  before update on public.market_pdf_templates
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. GENERATED APPLICATIONS — Versioned PDF history
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.market_generated_applications (
  id uuid primary key default gen_random_uuid(),
  carrier_market_id uuid not null references public.specialty_carrier_markets(id) on delete cascade,
  template_id uuid not null references public.market_pdf_templates(id),
  opportunity_id uuid not null references public.specialty_opportunities(id) on delete cascade,

  -- The generated PDF file
  storage_bucket text not null default 'specialty-quote-documents',
  storage_path text not null,
  file_name text not null,
  file_size bigint,

  -- Generation metadata
  generated_by uuid not null references public.profiles(id),
  generated_at timestamptz not null default now(),
  generation_version integer not null default 1,

  -- Source data snapshot hash for stale detection
  source_data_hash text,

  -- Submission tracking
  is_submitted boolean not null default false,
  submitted_by uuid references public.profiles(id),
  submitted_at timestamptz,

  -- Status
  status text not null default 'review_required' check (status in (
    'review_required', 'approved', 'submitted', 'superseded'
  )),

  notes text,
  created_at timestamptz not null default now()
);

comment on table public.market_generated_applications is
  'Versioned history of generated PDF applications per carrier market. Never overwritten: each generation is a new row. Stale detection via source_data_hash. v1.17.0.';

create index if not exists market_generated_applications_market_idx
  on public.market_generated_applications (carrier_market_id, generated_at desc);
create index if not exists market_generated_applications_opportunity_idx
  on public.market_generated_applications (opportunity_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. EXTEND SPECIALTY_ACTIVITY EVENT TYPES
--
--    The existing CHECK constraint on event_type needs to include new events.
--    We drop and recreate the constraint (not the column).
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop existing constraint and recreate with extended vocabulary
do $$
begin
  -- The existing constraint is unnamed inline CHECK. Find and drop it.
  if exists (
    select 1 from information_schema.check_constraints
    where constraint_schema = 'public'
      and constraint_name like '%specialty_activity%event_type%'
  ) then
    execute (
      select 'alter table public.specialty_activity drop constraint ' || constraint_name
      from information_schema.check_constraints
      where constraint_schema = 'public'
        and constraint_name like '%specialty_activity%event_type%'
      limit 1
    );
  end if;
end $$;

alter table public.specialty_activity
  add constraint specialty_activity_event_type_check check (event_type in (
    -- Original 28 event types (preserved exactly)
    'opportunity_created', 'intake_received', 'legacy_adopted',
    'claimed', 'reassigned', 'unassigned',
    'stage_changed', 'field_updated', 'priority_changed', 'next_action_set',
    'note_added',
    'document_uploaded', 'document_deleted',
    'checklist_item_added', 'checklist_item_toggled',
    'information_requested', 'information_received', 'information_waived',
    'carrier_added', 'carrier_updated', 'carrier_submitted',
    'carrier_quote_received', 'carrier_declined', 'carrier_withdrawn', 'carrier_removed',
    'price_sent', 'result_recorded', 'result_cleared', 'team_changed',
    -- New v1.17.0 event types
    'market_directory_linked',
    'market_question_answered',
    'application_generated',
    'application_regenerated',
    'application_submitted',
    'underwriting_result_recorded'
  ));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 13. EXTEND SPECIALTY_DOCUMENTS CATEGORY
--
--    Add 'generated_application' category for generated PDFs.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop existing category constraint and recreate with extended vocabulary
do $$
begin
  if exists (
    select 1 from information_schema.check_constraints
    where constraint_schema = 'public'
      and constraint_name like '%specialty_documents%category%'
  ) then
    execute (
      select 'alter table public.specialty_documents drop constraint ' || constraint_name
      from information_schema.check_constraints
      where constraint_schema = 'public'
        and constraint_name like '%specialty_documents%category%'
      limit 1
    );
  end if;
end $$;

alter table public.specialty_documents
  add constraint specialty_documents_category_check check (category in (
    'loss_runs', 'declarations', 'registration', 'driver_license',
    'carrier_proposal', 'quote_pdf', 'photos', 'underwriting', 'other',
    -- New v1.17.0
    'generated_application'
  ));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 14. ROW LEVEL SECURITY — New tables
-- ═══════════════════════════════════════════════════════════════════════════════

-- Market Directory: readable by anyone in the specialty module, writable by managers
alter table public.market_directory enable row level security;
alter table public.market_directory_aliases enable row level security;
alter table public.market_directory_contacts enable row level security;
alter table public.market_requirements enable row level security;
alter table public.market_questions enable row level security;
alter table public.market_question_answers enable row level security;
alter table public.market_requirement_satisfaction enable row level security;
alter table public.specialty_underwriting_results enable row level security;
alter table public.market_pdf_templates enable row level security;
alter table public.market_generated_applications enable row level security;

-- ── Market Directory (master data): read by any specialty member, write by managers
create policy market_directory_v1170_select
  on public.market_directory for select to authenticated
  using (public.specialty_can_access());

create policy market_directory_v1170_insert
  on public.market_directory for insert to authenticated
  with check (public.specialty_is_manager());

create policy market_directory_v1170_update
  on public.market_directory for update to authenticated
  using (public.specialty_is_manager())
  with check (public.specialty_is_manager());

-- ── Aliases: same as directory
create policy market_directory_aliases_v1170_select
  on public.market_directory_aliases for select to authenticated
  using (public.specialty_can_access());

create policy market_directory_aliases_v1170_insert
  on public.market_directory_aliases for insert to authenticated
  with check (public.specialty_is_manager());

create policy market_directory_aliases_v1170_update
  on public.market_directory_aliases for update to authenticated
  using (public.specialty_is_manager());

create policy market_directory_aliases_v1170_delete
  on public.market_directory_aliases for delete to authenticated
  using (public.specialty_is_manager());

-- ── Contacts: same as directory
create policy market_directory_contacts_v1170_select
  on public.market_directory_contacts for select to authenticated
  using (public.specialty_can_access());

create policy market_directory_contacts_v1170_insert
  on public.market_directory_contacts for insert to authenticated
  with check (public.specialty_is_manager());

create policy market_directory_contacts_v1170_update
  on public.market_directory_contacts for update to authenticated
  using (public.specialty_is_manager());

create policy market_directory_contacts_v1170_delete
  on public.market_directory_contacts for delete to authenticated
  using (public.specialty_is_manager());

-- ── Requirements: readable by specialty members, writable by managers
create policy market_requirements_v1170_select
  on public.market_requirements for select to authenticated
  using (public.specialty_can_access());

create policy market_requirements_v1170_insert
  on public.market_requirements for insert to authenticated
  with check (public.specialty_is_manager());

create policy market_requirements_v1170_update
  on public.market_requirements for update to authenticated
  using (public.specialty_is_manager())
  with check (public.specialty_is_manager());

-- ── Questions: readable by specialty members, writable by managers
create policy market_questions_v1170_select
  on public.market_questions for select to authenticated
  using (public.specialty_can_access());

create policy market_questions_v1170_insert
  on public.market_questions for insert to authenticated
  with check (public.specialty_is_manager());

create policy market_questions_v1170_update
  on public.market_questions for update to authenticated
  using (public.specialty_is_manager())
  with check (public.specialty_is_manager());

-- ── Question Answers: inherit from carrier_market's opportunity
create policy market_question_answers_v1170_select
  on public.market_question_answers for select to authenticated
  using (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_view_opportunity(m.opportunity_id)
    )
  );

create policy market_question_answers_v1170_insert
  on public.market_question_answers for insert to authenticated
  with check (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_edit_opportunity(m.opportunity_id)
    )
  );

create policy market_question_answers_v1170_update
  on public.market_question_answers for update to authenticated
  using (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_edit_opportunity(m.opportunity_id)
    )
  );

-- ── Requirement Satisfaction: inherit from carrier_market's opportunity
create policy market_requirement_satisfaction_v1170_select
  on public.market_requirement_satisfaction for select to authenticated
  using (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_view_opportunity(m.opportunity_id)
    )
  );

create policy market_requirement_satisfaction_v1170_insert
  on public.market_requirement_satisfaction for insert to authenticated
  with check (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_edit_opportunity(m.opportunity_id)
    )
  );

create policy market_requirement_satisfaction_v1170_update
  on public.market_requirement_satisfaction for update to authenticated
  using (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_edit_opportunity(m.opportunity_id)
    )
  );

-- ── Underwriting Results: inherit from carrier_market's opportunity
create policy specialty_underwriting_results_v1170_select
  on public.specialty_underwriting_results for select to authenticated
  using (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_view_opportunity(m.opportunity_id)
    )
  );

create policy specialty_underwriting_results_v1170_insert
  on public.specialty_underwriting_results for insert to authenticated
  with check (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_edit_opportunity(m.opportunity_id)
    )
  );

create policy specialty_underwriting_results_v1170_update
  on public.specialty_underwriting_results for update to authenticated
  using (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_edit_opportunity(m.opportunity_id)
    )
  );

create policy specialty_underwriting_results_v1170_delete
  on public.specialty_underwriting_results for delete to authenticated
  using (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_edit_opportunity(m.opportunity_id)
    )
  );

-- ── PDF Templates: readable by specialty members, writable by managers
create policy market_pdf_templates_v1170_select
  on public.market_pdf_templates for select to authenticated
  using (public.specialty_can_access());

create policy market_pdf_templates_v1170_insert
  on public.market_pdf_templates for insert to authenticated
  with check (public.specialty_is_manager());

create policy market_pdf_templates_v1170_update
  on public.market_pdf_templates for update to authenticated
  using (public.specialty_is_manager())
  with check (public.specialty_is_manager());

-- ── Generated Applications: inherit from carrier_market's opportunity
create policy market_generated_applications_v1170_select
  on public.market_generated_applications for select to authenticated
  using (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_view_opportunity(m.opportunity_id)
    )
  );

create policy market_generated_applications_v1170_insert
  on public.market_generated_applications for insert to authenticated
  with check (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_edit_opportunity(m.opportunity_id)
    )
  );

create policy market_generated_applications_v1170_update
  on public.market_generated_applications for update to authenticated
  using (
    exists (
      select 1 from public.specialty_carrier_markets m
      where m.id = carrier_market_id
        and public.specialty_can_edit_opportunity(m.opportunity_id)
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 15. SEED — INITIAL TRUCKING MARKETS
--
--    Idempotent upsert. Aliases use ON CONFLICT DO NOTHING.
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.market_directory (name, market_type, lines_of_business, submission_instructions)
values
  ('National General', 'direct_carrier', '{trucking}', null),
  ('Progressive', 'direct_carrier', '{trucking,homeowners}', null),
  ('JSA', 'mga', '{trucking}', null),
  ('Strickland / SIB', 'mga', '{trucking}', null),
  ('All Star Underwriters', 'mga', '{trucking}', null),
  ('Commonwealth Underwriters', 'mga', '{trucking}', null),
  ('Eastern Underwriting Managers', 'mga', '{trucking}', null),
  ('Truckers Insurance Associates / TIA', 'mga', '{trucking}', null),
  ('Cover Badger', 'mga', '{trucking}', null),
  ('Amwins', 'wholesaler', '{trucking}', null)
on conflict (name) do nothing;

-- Aliases for historical spelling normalization
insert into public.market_directory_aliases (market_id, alias)
select m.id, a.alias
from public.market_directory m
cross join lateral (values (m.name)) as src(name)
cross join lateral (
  select unnest(aliases) as alias
  from (values
    ('National General', array['NatGen', 'Nat Gen', 'National Gen']),
    ('Progressive', array['Prog']),
    ('JSA', array['J.S.A.', 'JS&A']),
    ('Strickland / SIB', array['Strickland', 'SIB', 'S.I.B.']),
    ('All Star Underwriters', array['All Star', 'AllStar']),
    ('Commonwealth Underwriters', array['Commonwealth', 'Common Wealth', 'Common Underwriters', 'Commonwealth UW']),
    ('Eastern Underwriting Managers', array['Eastern', 'Eastern UW', 'Eastern Underwriting']),
    ('Truckers Insurance Associates / TIA', array['TIA', 'Truckers Insurance', 'Truckers Insurance Associates']),
    ('Cover Badger', array['CoverBadger']),
    ('Amwins', array['Am Wins', 'AmWins'])
  ) as t(mname, aliases)
  where t.mname = src.name
) a
on conflict (alias) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 16. RECONCILE EXISTING SPECIALTY_CARRIERS WITH MARKET DIRECTORY
--
--    Link existing specialty_carriers to the new Market Directory where names
--    match exactly or through aliases. Safe: only sets the FK, never drops data.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Direct name match
update public.specialty_carriers sc
set market_directory_id = md.id
from public.market_directory md
where lower(btrim(sc.name)) = lower(btrim(md.name))
  and sc.market_directory_id is null;

-- Alias match
update public.specialty_carriers sc
set market_directory_id = a.market_id
from public.market_directory_aliases a
where lower(btrim(sc.name)) = lower(btrim(a.alias))
  and sc.market_directory_id is null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 17. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_markets integer;
  v_aliases integer;
begin
  select count(*) into v_markets from public.market_directory;
  select count(*) into v_aliases from public.market_directory_aliases;
  raise notice 'v1.17.0 Market Directory: % markets, % aliases seeded', v_markets, v_aliases;

  if v_markets < 10 then
    raise exception 'Expected at least 10 markets, got %', v_markets;
  end if;
end $$;

commit;

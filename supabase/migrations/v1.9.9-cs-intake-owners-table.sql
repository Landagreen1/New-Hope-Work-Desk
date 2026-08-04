-- v1.9.9 - Add cs_intake_owners table for multiple business owners on commercial intakes
--
-- Commercial GL and Commercial Auto intakes can have multiple business owners.
-- This follows the same pattern as cs_intake_drivers (position-ordered child records,
-- delete-all-then-reinsert on save).

begin;

create table if not exists public.cs_intake_owners (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.cs_intake_submissions(id) on delete cascade,
  position integer not null default 1,
  first_name text not null default '',
  middle_name text null,
  last_name text not null default '',
  dob date null,
  phone text null,
  email text null,
  ownership_percentage numeric(5,2) null,
  created_at timestamptz not null default now()
);

create index if not exists cs_intake_owners_submission_idx
  on public.cs_intake_owners(submission_id);

alter table public.cs_intake_owners enable row level security;

-- RLS: same pattern as cs_intake_drivers — authenticated users can manage via the parent submission
create policy "Authenticated users can select owners"
  on public.cs_intake_owners for select to authenticated
  using (true);

create policy "Authenticated users can insert owners"
  on public.cs_intake_owners for insert to authenticated
  with check (true);

create policy "Authenticated users can update owners"
  on public.cs_intake_owners for update to authenticated
  using (true);

create policy "Authenticated users can delete owners"
  on public.cs_intake_owners for delete to authenticated
  using (true);

-- Update the desired_coverage constraint to allow 'both_prices'
-- (from v1.9.8 frontend change — this ensures the DB accepts it)
alter table public.cs_intake_submissions
  drop constraint if exists cs_intake_desired_coverage_check;

alter table public.cs_intake_submissions
  add constraint cs_intake_desired_coverage_check
    check (desired_coverage is null or desired_coverage in ('liability_only', 'full_coverage', 'both_prices', 'unsure'));

commit;

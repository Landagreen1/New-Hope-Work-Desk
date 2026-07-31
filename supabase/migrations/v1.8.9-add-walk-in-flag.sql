-- v1.8.9: Add walk-in office flag to cs_intake_submissions
-- Walk-in clients have specific priority and can only be handled by the US team.

alter table public.cs_intake_submissions
  add column if not exists is_walk_in boolean not null default false;

comment on column public.cs_intake_submissions.is_walk_in is
  'True when the customer is physically present at the office (walk-in). These intakes take priority and can only be accepted by US-based agents.';

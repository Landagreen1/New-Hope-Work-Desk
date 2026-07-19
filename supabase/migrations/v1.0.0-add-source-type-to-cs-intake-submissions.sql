-- New Hope Work Desk v1.0.0
-- Add source_type column to cs_intake_submissions
-- This allows the IntakeQueue UI to reliably identify RingCentral-sourced intakes
-- without depending on the work_item_id heuristic (which is only set after conversion).
--
-- Spec: rc-claim-duplicate-quote-fix
-- Requirements: 2.4

begin;

-- Add source_type column (nullable text, defaults to NULL for existing rows)
-- New intakes will populate this during creation based on the customer_intakes source_type.
alter table public.cs_intake_submissions
  add column if not exists source_type text null;

-- Backfill: sync source_type from customer_intakes where a matching record exists.
-- The cs_intake_submissions.id matches customer_intakes.id when both represent the same intake.
update public.cs_intake_submissions s
set source_type = ci.source_type
from public.customer_intakes ci
where ci.id = s.id
  and s.source_type is null;

commit;

select 'v1.0.0 source_type column added to cs_intake_submissions' as status;

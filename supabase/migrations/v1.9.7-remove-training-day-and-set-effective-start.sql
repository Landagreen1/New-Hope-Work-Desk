-- v1.9.7 Remove Training Day & Set Effective Start Date
--
-- Change A: Insert 2026-07-28 into attendance_closed_dates so it does not
--           appear in any attendance report or coverage ribbon.
--
-- Change B: Add effective_start_date to attendance_policy. Dates before this
--           value generate no exceptions and are not payroll-blocking. The clock
--           data still exists and is visible, but it produces no actionable items.
--           Set to 2026-08-04 (the first Monday after the tool rollout week).
--
-- Idempotent: safe to re-run.

BEGIN;

-- ─── Change A: Mark Jul 28 as a closed date ─────────────────────────────────
INSERT INTO public.attendance_closed_dates (closed_date, label, created_by)
VALUES ('2026-07-28', 'System setup day — excluded from reports', 'f900a291-6ba8-4adf-a334-131b9871398c')
ON CONFLICT (closed_date) DO NOTHING;

-- ─── Change B: Add effective_start_date column ───────────────────────────────
ALTER TABLE public.attendance_policy
  ADD COLUMN IF NOT EXISTS effective_start_date date DEFAULT NULL;

UPDATE public.attendance_policy
SET effective_start_date = '2026-08-04'
WHERE singleton_key = true;

COMMIT;

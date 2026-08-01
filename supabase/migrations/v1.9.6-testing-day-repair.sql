-- v1.9.6 Testing-Day Clock Data Repair
-- Repairs clock entries for Jul 29–31, 2026 (testing days) to match scheduled shifts.
--
-- Idempotent: safe to re-run. Uses adjustment_reason = 'v1.9.6 testing-day repair'
-- as a sentinel to detect prior runs.
--
-- Business timezone: America/New_York
-- Schedule times are stored as wall-clock TIME values.
--
-- Rollback: No automated rollback — restore from pre-repair snapshot if needed.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: For employees with MULTIPLE entries on a testing day, zero out the
-- duplicates by setting clock_out = clock_in (safest approach given unique
-- constraints). Keep only the entry with the earliest clock_in per profile/date.
-- ─────────────────────────────────────────────────────────────────────────────
WITH testing_dates AS (
  SELECT d::date AS repair_date
  FROM unnest(ARRAY['2026-07-29','2026-07-30','2026-07-31']::date[]) AS d
),
ranked_entries AS (
  SELECT
    tce.id,
    tce.profile_id,
    (tce.clock_in AT TIME ZONE 'America/New_York')::date AS entry_date,
    ROW_NUMBER() OVER (
      PARTITION BY tce.profile_id, (tce.clock_in AT TIME ZONE 'America/New_York')::date
      ORDER BY tce.clock_in ASC
    ) AS rn
  FROM public.time_clock_entries tce
  JOIN testing_dates td ON (tce.clock_in AT TIME ZONE 'America/New_York')::date = td.repair_date
),
duplicates AS (
  SELECT id FROM ranked_entries WHERE rn > 1
)
UPDATE public.time_clock_entries
SET
  clock_out = clock_in,
  total_hours = 0,
  break_minutes = 0,
  adjustment_reason = 'v1.9.6 testing-day repair (zeroed duplicate)',
  clock_status = 'available'
WHERE id IN (SELECT id FROM duplicates);

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Update the remaining (earliest) entry for each scheduled employee
-- to match their published schedule.
-- ─────────────────────────────────────────────────────────────────────────────
WITH testing_dates AS (
  SELECT d::date AS repair_date
  FROM unnest(ARRAY['2026-07-29','2026-07-30','2026-07-31']::date[]) AS d
),
scheduled AS (
  SELECT
    es.profile_id,
    es.schedule_date,
    es.shift_start,
    es.shift_end,
    -- Convert wall-clock shift_start to UTC instant
    ((es.schedule_date || ' ' || es.shift_start)::timestamp AT TIME ZONE 'America/New_York') AS clock_in_utc,
    -- Convert wall-clock shift_end to UTC instant (handle overnight)
    CASE
      WHEN es.shift_end <= es.shift_start THEN
        (((es.schedule_date + INTERVAL '1 day') || ' ' || es.shift_end)::timestamp AT TIME ZONE 'America/New_York')
      ELSE
        ((es.schedule_date || ' ' || es.shift_end)::timestamp AT TIME ZONE 'America/New_York')
    END AS clock_out_utc,
    -- Compute total hours
    CASE
      WHEN es.shift_end <= es.shift_start THEN
        EXTRACT(EPOCH FROM (
          (((es.schedule_date + INTERVAL '1 day') || ' ' || es.shift_end)::timestamp AT TIME ZONE 'America/New_York')
          - ((es.schedule_date || ' ' || es.shift_start)::timestamp AT TIME ZONE 'America/New_York')
        )) / 3600.0
      ELSE
        EXTRACT(EPOCH FROM (
          ((es.schedule_date || ' ' || es.shift_end)::timestamp AT TIME ZONE 'America/New_York')
          - ((es.schedule_date || ' ' || es.shift_start)::timestamp AT TIME ZONE 'America/New_York')
        )) / 3600.0
    END AS computed_hours
  FROM public.employee_schedules es
  JOIN testing_dates td ON es.schedule_date = td.repair_date
  WHERE es.status = 'published'
),
earliest_entries AS (
  SELECT
    tce.id AS entry_id,
    tce.profile_id,
    (tce.clock_in AT TIME ZONE 'America/New_York')::date AS entry_date,
    ROW_NUMBER() OVER (
      PARTITION BY tce.profile_id, (tce.clock_in AT TIME ZONE 'America/New_York')::date
      ORDER BY tce.clock_in ASC
    ) AS rn
  FROM public.time_clock_entries tce
  JOIN testing_dates td ON (tce.clock_in AT TIME ZONE 'America/New_York')::date = td.repair_date
)
UPDATE public.time_clock_entries tce
SET
  clock_in = s.clock_in_utc,
  clock_out = s.clock_out_utc,
  total_hours = ROUND(s.computed_hours::numeric, 2),
  break_minutes = 45,
  adjustment_reason = 'v1.9.6 testing-day repair',
  clock_status = 'available'
FROM earliest_entries ee
JOIN scheduled s ON s.profile_id = ee.profile_id AND s.schedule_date = ee.entry_date
WHERE tce.id = ee.entry_id
  AND ee.rn = 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: Insert missing entries for scheduled employees who had NO clock entry
-- on a testing day.
-- ─────────────────────────────────────────────────────────────────────────────
WITH testing_dates AS (
  SELECT d::date AS repair_date
  FROM unnest(ARRAY['2026-07-29','2026-07-30','2026-07-31']::date[]) AS d
),
scheduled AS (
  SELECT
    es.profile_id,
    es.schedule_date,
    es.shift_start,
    es.shift_end,
    ((es.schedule_date || ' ' || es.shift_start)::timestamp AT TIME ZONE 'America/New_York') AS clock_in_utc,
    CASE
      WHEN es.shift_end <= es.shift_start THEN
        (((es.schedule_date + INTERVAL '1 day') || ' ' || es.shift_end)::timestamp AT TIME ZONE 'America/New_York')
      ELSE
        ((es.schedule_date || ' ' || es.shift_end)::timestamp AT TIME ZONE 'America/New_York')
    END AS clock_out_utc,
    CASE
      WHEN es.shift_end <= es.shift_start THEN
        EXTRACT(EPOCH FROM (
          (((es.schedule_date + INTERVAL '1 day') || ' ' || es.shift_end)::timestamp AT TIME ZONE 'America/New_York')
          - ((es.schedule_date || ' ' || es.shift_start)::timestamp AT TIME ZONE 'America/New_York')
        )) / 3600.0
      ELSE
        EXTRACT(EPOCH FROM (
          ((es.schedule_date || ' ' || es.shift_end)::timestamp AT TIME ZONE 'America/New_York')
          - ((es.schedule_date || ' ' || es.shift_start)::timestamp AT TIME ZONE 'America/New_York')
        )) / 3600.0
    END AS computed_hours
  FROM public.employee_schedules es
  JOIN testing_dates td ON es.schedule_date = td.repair_date
  WHERE es.status = 'published'
),
existing AS (
  SELECT DISTINCT
    tce.profile_id,
    (tce.clock_in AT TIME ZONE 'America/New_York')::date AS entry_date
  FROM public.time_clock_entries tce
  JOIN testing_dates td ON (tce.clock_in AT TIME ZONE 'America/New_York')::date = td.repair_date
),
missing AS (
  SELECT s.*
  FROM scheduled s
  LEFT JOIN existing e ON e.profile_id = s.profile_id AND e.entry_date = s.schedule_date
  WHERE e.profile_id IS NULL
)
INSERT INTO public.time_clock_entries (
  profile_id,
  clock_in,
  clock_out,
  clock_status,
  break_minutes,
  total_hours,
  is_overtime,
  adjustment_reason
)
SELECT
  m.profile_id,
  m.clock_in_utc,
  m.clock_out_utc,
  'available',
  45,
  ROUND(m.computed_hours::numeric, 2),
  false,
  'v1.9.6 testing-day repair'
FROM missing m
-- Idempotent guard: don't re-insert if a prior run already inserted for this profile/date
WHERE NOT EXISTS (
  SELECT 1 FROM public.time_clock_entries tce2
  WHERE tce2.profile_id = m.profile_id
    AND (tce2.clock_in AT TIME ZONE 'America/New_York')::date = m.schedule_date
    AND tce2.adjustment_reason = 'v1.9.6 testing-day repair'
);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION: Count entries per date for the three testing days.
-- Every scheduled employee should have exactly one closed entry matching schedule.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  (tce.clock_in AT TIME ZONE 'America/New_York')::date AS entry_date,
  COUNT(*) AS total_entries,
  COUNT(*) FILTER (WHERE tce.clock_out IS NOT NULL AND tce.total_hours > 0) AS closed_entries,
  COUNT(*) FILTER (WHERE tce.adjustment_reason = 'v1.9.6 testing-day repair') AS repaired_entries,
  COUNT(*) FILTER (WHERE tce.adjustment_reason = 'v1.9.6 testing-day repair (zeroed duplicate)') AS zeroed_duplicates
FROM public.time_clock_entries tce
WHERE (tce.clock_in AT TIME ZONE 'America/New_York')::date IN ('2026-07-29','2026-07-30','2026-07-31')
GROUP BY entry_date
ORDER BY entry_date;

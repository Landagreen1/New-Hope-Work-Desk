-- Add insured_middle_name column to cs_intake_submissions
ALTER TABLE cs_intake_submissions
  ADD COLUMN IF NOT EXISTS insured_middle_name text;

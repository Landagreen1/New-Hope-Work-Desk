-- Fix: add 'commercial_gl' to the cs_intake_lob enum type if it exists
-- The column may use an enum type instead of a check constraint

DO $$
BEGIN
  -- Check if the enum type exists and add missing values
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cs_intake_lob') THEN
    BEGIN
      ALTER TYPE cs_intake_lob ADD VALUE IF NOT EXISTS 'commercial_gl';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER TYPE cs_intake_lob ADD VALUE IF NOT EXISTS 'homeowners';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER TYPE cs_intake_lob ADD VALUE IF NOT EXISTS 'non_owners';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER TYPE cs_intake_lob ADD VALUE IF NOT EXISTS 'trucking';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER TYPE cs_intake_lob ADD VALUE IF NOT EXISTS 'personal_auto';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER TYPE cs_intake_lob ADD VALUE IF NOT EXISTS 'commercial_auto';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

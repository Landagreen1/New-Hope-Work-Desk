-- Add ID/Passport fields for Non-Owners intake
ALTER TABLE cs_intake_submissions ADD COLUMN IF NOT EXISTS no_document_type text;
ALTER TABLE cs_intake_submissions ADD COLUMN IF NOT EXISTS no_document_number text;
ALTER TABLE cs_intake_submissions ADD COLUMN IF NOT EXISTS no_document_state text;
ALTER TABLE cs_intake_submissions ADD COLUMN IF NOT EXISTS no_document_expiration date;

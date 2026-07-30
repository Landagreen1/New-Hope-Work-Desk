-- v1.8.2 — Add motorcycle, boat, trailer, renters columns to cs_intake_submissions
-- These columns support the Other Personal LOB intake forms (motorcycle, boat, trailer, renters).

ALTER TABLE public.cs_intake_submissions
  -- Motorcycle
  ADD COLUMN IF NOT EXISTS moto_year text,
  ADD COLUMN IF NOT EXISTS moto_make text,
  ADD COLUMN IF NOT EXISTS moto_model text,
  ADD COLUMN IF NOT EXISTS moto_vin text,
  ADD COLUMN IF NOT EXISTS moto_cc text,
  ADD COLUMN IF NOT EXISTS moto_type text,
  -- Boat
  ADD COLUMN IF NOT EXISTS boat_year text,
  ADD COLUMN IF NOT EXISTS boat_make text,
  ADD COLUMN IF NOT EXISTS boat_model text,
  ADD COLUMN IF NOT EXISTS boat_hin text,
  ADD COLUMN IF NOT EXISTS boat_length text,
  ADD COLUMN IF NOT EXISTS boat_type text,
  ADD COLUMN IF NOT EXISTS boat_hp text,
  ADD COLUMN IF NOT EXISTS boat_value text,
  ADD COLUMN IF NOT EXISTS boat_trailer_included boolean DEFAULT false,
  -- Trailer / Mobile Home
  ADD COLUMN IF NOT EXISTS trailer_year text,
  ADD COLUMN IF NOT EXISTS trailer_make text,
  ADD COLUMN IF NOT EXISTS trailer_model text,
  ADD COLUMN IF NOT EXISTS trailer_vin text,
  ADD COLUMN IF NOT EXISTS trailer_length text,
  ADD COLUMN IF NOT EXISTS trailer_type text,
  ADD COLUMN IF NOT EXISTS trailer_value text,
  ADD COLUMN IF NOT EXISTS trailer_park_name text,
  ADD COLUMN IF NOT EXISTS trailer_lot_number text,
  -- Renters
  ADD COLUMN IF NOT EXISTS renters_property_address text,
  ADD COLUMN IF NOT EXISTS renters_city text,
  ADD COLUMN IF NOT EXISTS renters_state text,
  ADD COLUMN IF NOT EXISTS renters_zip text,
  ADD COLUMN IF NOT EXISTS renters_unit text,
  ADD COLUMN IF NOT EXISTS renters_landlord_name text,
  ADD COLUMN IF NOT EXISTS renters_personal_property_value text,
  ADD COLUMN IF NOT EXISTS renters_liability_limit text,
  ADD COLUMN IF NOT EXISTS renters_move_in_date text;

NOTIFY pgrst, 'reload schema';

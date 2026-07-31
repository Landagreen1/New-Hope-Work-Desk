-- v1.8.8: Allow 'passport' in cs_intake_drivers.document_type
-- The frontend has offered passport as an option since v0.9.7 but the DB
-- check constraint only permitted 'driver_license' and 'state_id', causing
-- a 400 error on intake submission when passport is selected.

alter table public.cs_intake_drivers
  drop constraint if exists cs_intake_driver_document_type_check;

alter table public.cs_intake_drivers
  add constraint cs_intake_driver_document_type_check
    check (document_type in ('driver_license', 'state_id', 'passport'));

-- Add quote_number field to specialty_carrier_markets
alter table public.specialty_carrier_markets
  add column if not exists quote_number varchar(100);

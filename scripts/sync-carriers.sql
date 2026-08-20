-- Sync specialty_carriers with market_directory
begin;

-- 1. Link Stricklland to Strickland / SIB in market directory and fix the name
update public.specialty_carriers
set market_directory_id = 'e488c12f-79ae-46bc-8c00-9cb6b608e6c7',
    name = 'Strickland / SIB'
where id = 'e0d246d9-6a1b-478c-b981-dabf9f7a24f9';

-- 2. Link National General (already done, but ensure)
update public.specialty_carriers
set market_directory_id = 'f1472bfa-e56d-4102-9d38-260653127d26'
where name = 'National General' and market_directory_id is null;

-- 3. Link Progressive (already done, but ensure)
update public.specialty_carriers
set market_directory_id = 'f9b2ed40-b913-4cf1-82b2-143096066de2'
where name = 'Progressive' and market_directory_id is null;

-- 4. Insert missing carriers from market_directory into specialty_carriers
insert into public.specialty_carriers (name, lines_of_business, is_active, market_directory_id, created_at, updated_at)
values
  ('All Star Underwriters', '{trucking}', true, 'b55a6dae-b67e-4631-b72a-c973df4286a0', now(), now()),
  ('Amwins', '{trucking}', true, '09b10589-da00-4feb-abe4-68b78e795718', now(), now()),
  ('Commonwealth Underwriters', '{trucking}', true, '9272819c-9d69-4c61-bfb7-96b01c89a695', now(), now()),
  ('Cover Badger', '{trucking}', true, '086b98d8-e39a-4f23-9153-20c50874771d', now(), now()),
  ('Eastern Underwriting Managers', '{trucking}', true, 'adbf47a1-35c2-4a16-9499-7edb7947da37', now(), now()),
  ('JSA', '{trucking}', true, '2572a6b0-d054-4c34-86d7-f1408ec3d6f3', now(), now()),
  ('Truckers Insurance Associates / TIA', '{trucking}', true, 'bbe15f60-f141-4159-96f4-781a22e08af2', now(), now())
on conflict (name) do nothing;

-- 5. Deactivate carriers that are NOT in the market directory and have never been used on a quote
-- Keep "Other / Direct" as a catch-all, and keep any that have been used historically
update public.specialty_carriers
set is_active = false
where market_directory_id is null
  and id not in (select distinct carrier_id from public.specialty_carrier_markets)
  and name not in ('Other / Direct');

commit;

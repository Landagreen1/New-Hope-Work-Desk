-- v1.7.2 Reactivate users and set correct roles
-- These users exist but were deactivated during testing.

begin;

-- Ricardo Chinlle → Customer Service (might be stored as "Ricky Chinlle")
update public.profiles
set is_active = true, role = 'customer_service'
where display_name in ('Ricardo Chinlle', 'Ricky Chinlle') and is_active = false;

-- Giovanny Gonzalez → Commercial Supervisor (commercial manager)
update public.profiles
set is_active = true, role = 'commercial_supervisor'
where display_name = 'Giovanny Gonzalez' and is_active = false;

-- Andrea Rueda → Commercial
update public.profiles
set is_active = true, role = 'commercial'
where display_name = 'Andrea Rueda' and is_active = false;

-- Daniela Garcia → Commercial
update public.profiles
set is_active = true, role = 'commercial'
where display_name = 'Daniela Garcia' and is_active = false;

-- John Parra → Customer Service
update public.profiles
set is_active = true, role = 'customer_service'
where display_name = 'John Parra' and is_active = false;

-- Thalita Revelo → Customer Service Supervisor
update public.profiles
set is_active = true, role = 'customer_service_supervisor'
where display_name = 'Thalita Revelo' and is_active = false;

commit;

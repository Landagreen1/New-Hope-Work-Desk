-- New Hope Work Desk v1.3.2 — Promote Oscar to super_admin
-- Must be applied AFTER v1.3.0-super-admin-role.sql (enum value committed).

update public.profiles
set role = 'super_admin'
where username = 'oscar';

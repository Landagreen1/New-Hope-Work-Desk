-- New Hope Work Desk v1.3.0 — Super Admin Role
-- Adds 'super_admin' to the app_role enum.
-- Super admins cannot be deleted by managers, handle payment rates/schedules,
-- and can assign schedules to all users including managers.
--
-- IMPORTANT: This must be run and committed BEFORE any migration that references
-- the 'super_admin' role value.

alter type public.app_role add value if not exists 'super_admin';

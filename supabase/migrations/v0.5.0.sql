-- New Hope Work Desk v0.5.0
-- No structural database migration is required when upgrading from v0.4.0.
--
-- v0.5.0 uses existing production structures:
--   profiles              user roles, availability, queue eligibility, rotation positions
--   turn_events           pass history and turn actions
--   audit_log             manager user-creation and password-reset audit entries
--   daily_agent_performance / existing reporting data
--
-- The new manager User Administration feature is implemented through the
-- server-only Next.js route /api/admin/users and Supabase Auth Admin APIs.
-- Keep SUPABASE_SECRET_KEY on the server only; never expose it as NEXT_PUBLIC_*.

select 'New Hope Work Desk v0.5.0: no structural migration required' as migration_status;

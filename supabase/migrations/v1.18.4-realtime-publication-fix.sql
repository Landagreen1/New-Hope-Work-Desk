-- v1.18.4 Fix missing realtime publications
--
-- Problem: The frontend subscribes to postgres_changes on several tables that
-- were never added to the supabase_realtime publication. Without publication
-- membership, Supabase Realtime never emits WAL events for these tables, so the
-- frontend channels are effectively dead — agents only see changes through the
-- 60-second polling fallback or manual page focus, not live.
--
-- Affected tables:
--   • cs_intake_submissions — the Sales Intake Queue never updates in realtime
--   • customer_intakes      — legacy intake path, same issue
--   • quote_take_timers     — timed quote deadlines don't propagate live
--   • work_desk_settings    — setting changes require manual refresh
--   • dealer_salespeople    — salesperson list additions don't propagate live
--
-- Fix: Add all five tables to the publication. The idempotent pattern with
-- exception handling ensures this is safe to run even if a table was already
-- added manually in live Supabase.

do $$ begin alter publication supabase_realtime add table public.cs_intake_submissions; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.customer_intakes; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.quote_take_timers; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.work_desk_settings; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.dealer_salespeople; exception when duplicate_object then null; end $$;

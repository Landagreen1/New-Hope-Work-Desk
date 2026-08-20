-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.21.0 DIAGNOSTIC — read-only, safe in any state.
--
-- ONE statement on purpose. The Supabase SQL editor returns only the LAST statement's
-- result set, so a diagnostic split across several statements silently discards all but
-- the final one. Everything below is a single SELECT.
--
-- Paste the whole file, run it, and send back the table.
-- ═══════════════════════════════════════════════════════════════════════════════

with checks(sort, section, check_name, result) as (
  values
    -- ── Did v1.21.0 land? All 'no' means the migration never committed. ──────────
    (1, 'v1.21.0 objects', 'table user_email_connections',
        case when to_regclass('public.user_email_connections') is not null then 'yes' else 'NO' end),
    (2, 'v1.21.0 objects', 'table carrier_submissions',
        case when to_regclass('public.carrier_submissions') is not null then 'yes' else 'NO' end),
    (3, 'v1.21.0 objects', 'table carrier_submission_documents',
        case when to_regclass('public.carrier_submission_documents') is not null then 'yes' else 'NO' end),
    (4, 'v1.21.0 objects', 'market_directory.email_submission_enabled',
        case when exists (select 1 from information_schema.columns
                           where table_schema='public' and table_name='market_directory'
                             and column_name='email_submission_enabled') then 'yes' else 'NO' end),
    (5, 'v1.21.0 objects', 'profiles.can_send_carrier_submissions',
        case when exists (select 1 from information_schema.columns
                           where table_schema='public' and table_name='profiles'
                             and column_name='can_send_carrier_submissions') then 'yes' else 'NO' end),
    (6, 'v1.21.0 objects', 'function can_send_carrier_submissions()',
        case when to_regprocedure('public.can_send_carrier_submissions()') is not null then 'yes' else 'NO' end),

    -- ── What the migration depends on. A single NO here is the cause. ────────────
    (10, 'dependencies', 'function touch_updated_at()',
        case when to_regprocedure('public.touch_updated_at()') is not null then 'yes' else 'NO — THIS IS THE CAUSE' end),
    (11, 'dependencies', 'function specialty_is_manager()',
        case when to_regprocedure('public.specialty_is_manager()') is not null then 'yes' else 'NO — THIS IS THE CAUSE' end),
    (12, 'dependencies', 'function specialty_can_view_opportunity(uuid)',
        case when to_regprocedure('public.specialty_can_view_opportunity(uuid)') is not null then 'yes' else 'NO — THIS IS THE CAUSE' end),
    (13, 'dependencies', 'table specialty_opportunities',
        case when to_regclass('public.specialty_opportunities') is not null then 'yes' else 'NO — THIS IS THE CAUSE' end),
    (14, 'dependencies', 'table specialty_carrier_markets',
        case when to_regclass('public.specialty_carrier_markets') is not null then 'yes' else 'NO — THIS IS THE CAUSE' end),
    (15, 'dependencies', 'table specialty_documents',
        case when to_regclass('public.specialty_documents') is not null then 'yes' else 'NO — THIS IS THE CAUSE' end),
    (16, 'dependencies', 'table market_directory',
        case when to_regclass('public.market_directory') is not null then 'yes' else 'NO — THIS IS THE CAUSE' end),
    (17, 'dependencies', 'table specialty_activity',
        case when to_regclass('public.specialty_activity') is not null then 'yes' else 'NO — THIS IS THE CAUSE' end),
    (18, 'dependencies', 'profiles.username column',
        case when exists (select 1 from information_schema.columns
                           where table_schema='public' and table_name='profiles'
                             and column_name='username') then 'yes' else 'NO — sender seed cannot match' end),
    (19, 'dependencies', 'role authenticated',
        case when exists (select 1 from pg_roles where rolname='authenticated') then 'yes' else 'NO — THIS IS THE CAUSE' end),
    (20, 'dependencies', 'role anon',
        case when exists (select 1 from pg_roles where rolname='anon') then 'yes' else 'NO — THIS IS THE CAUSE' end),

    -- ── Context ─────────────────────────────────────────────────────────────────
    (30, 'context', 'activity event_type constraint present',
        case when exists (select 1 from information_schema.check_constraints
                           where constraint_schema='public'
                             and constraint_name like '%specialty_activity%event_type%')
             then 'yes' else 'NO' end),
    (31, 'context', 'how many event_type constraints match',
        (select count(*)::text from information_schema.check_constraints
          where constraint_schema='public'
            and constraint_name like '%specialty_activity%event_type%')),
    (32, 'context', 'current_user',  current_user::text),
    (33, 'context', 'postgres version', (select substring(version() from 'PostgreSQL [0-9.]+'))),
    (34, 'context', 'active profiles',
        (select count(*)::text from public.profiles where is_active)),
    (35, 'context', 'usernames (this settles the sender seed)',
        (select coalesce(string_agg(username, ', ' order by username), '(none)')
           from public.profiles where is_active)),
    (36, 'context', 'a profile named oscar exists',
        case when exists (select 1 from public.profiles where username='oscar')
             then 'yes' else 'NO — the sender seed will match nothing' end)
)
select section, check_name, result
  from checks
 order by sort;

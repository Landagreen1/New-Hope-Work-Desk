-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.13.0 — Policy Follow-up shared ownership foundation
--
-- Spec: .kiro/specs/policy-follow-up-assignment-workflow
-- Requirements: 3.1, 3.2, 3.4, 4.2, 13.2, 14.2
-- Design: 4.1, 4.2, 5, 6.1, 13, 14
--
-- Forward-only and additive. This migration creates tables, helper functions, and
-- policies only; it alters no existing table, replaces no existing function, and
-- touches no existing row. Nothing here changes quote rotations, turn positions,
-- attendance-driven queue state, or any unrelated module.
--
-- What it establishes:
--
--   1. `policy_followup_policy_owners` — ownership at the (carrier, normalized policy)
--      level rather than per spreadsheet row (Requirement 3.1). `renewal_records.assigned_to`
--      and `cancellation_cases.assigned_to` remain and stay synchronized with it
--      (Requirement 3.2); this table is what makes one policy resolve to one owner
--      across both domains and across every reimport.
--
--   2. `policy_followup_agent_settings` — per-employee eligibility and mode
--      (Requirement 3.4). Deliberately unconnected to quote queue status, attendance
--      status, RingCentral turn, WhatsApp turn, and rotation positions (design 5).
--
--   3. `policy_followup_assignment_events` — an append-only audit of every ownership
--      decision, with the source and the actor (Requirement 13.2).
--
--   4. `policy_followup_workload_weights` — the Requirement 4.2 weights, seeded from
--      the same numbers `src/features/policy-follow-up/workload.ts` holds, so the SQL
--      assignment engine and the TypeScript display layer cannot drift (design 6.1).
--      The post-condition block below asserts every seeded value.
--
--   5. `policy_followup_carrier_aliases` plus two normalization functions, so the
--      carrier key and the normalized policy number have exactly one definition each
--      on the database side and it matches the TypeScript one character for character.
--
-- Rollback: dropping the four tables and the five functions created here removes the
-- feature and leaves every pre-existing renewal and cancellation row untouched.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 0. PRE-CONDITIONS
--    Fail before creating anything if the objects this migration builds on are absent,
--    so a half-applied state is impossible.
-- ═══════════════════════════════════════════════════════════════════════════════
do $pre$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'profiles') then
    raise exception 'v1.13.0 requires public.profiles' using hint = 'Nothing was created.';
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'renewal_records') then
    raise exception 'v1.13.0 requires public.renewal_records' using hint = 'Nothing was created.';
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'cancellation_cases') then
    raise exception 'v1.13.0 requires public.cancellation_cases (v1.10.0)' using hint = 'Nothing was created.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'touch_updated_at'
  ) then
    raise exception 'v1.13.0 requires public.touch_updated_at()' using hint = 'Nothing was created.';
  end if;
end;
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. ROLE HELPERS
--
--    Both mirror `src/lib/permissions.ts` exactly and are the only role rule the
--    policies below are built on, so the workspace gate has one definition per side.
--
--    security definer with `set search_path = public` so they read public.profiles
--    regardless of the caller's own read scope and cannot be steered at another schema.
--    Execute stays at the default grant to PUBLIC, matching public.is_manager() and
--    public.cancellation_is_manager(): a row level security policy is evaluated as the
--    session role, so revoking execute would break policy evaluation. Each reads one
--    row of public.profiles and returns a boolean, disclosing nothing the caller does
--    not already know about its own session.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('manager', 'super_admin') from public.profiles where id = auth.uid()),
    false);
$$;

comment on function public.policy_followup_is_manager() is
  'True for Manager_Role in the Policy Follow-up workspace: role manager or super_admin. Mirrors canManageRenewals / isBroadManagerRole in src/lib/permissions.ts. Requirement 14.2.';

create or replace function public.policy_followup_can_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('agent', 'customer_service', 'sales_supervisor', 'manager', 'super_admin')
       from public.profiles where id = auth.uid()),
    false);
$$;

comment on function public.policy_followup_can_access() is
  'True for a profile with any Policy Follow-up access. Mirrors canAccessRenewals in src/lib/permissions.ts. sales_supervisor reaches the workspace but holds Agent_Role privileges. Requirement 14.2.';

grant execute on function public.policy_followup_is_manager() to authenticated;
grant execute on function public.policy_followup_can_access() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. IDENTITY NORMALIZATION (Requirement 3.1, design 4.2)
--
--    Two functions, one definition each, matching
--    `src/features/policy-follow-up/normalization.ts` exactly. The TypeScript tests
--    pin the same expectations, so a change to either side that is not made to both
--    shows up as a failing test rather than as split ownership in production.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_normalize_policy_number(p_policy_number text)
returns text
language sql
immutable
as $$
  select nullif(upper(regexp_replace(coalesce(p_policy_number, ''), '\s', '', 'g')), '');
$$;

comment on function public.policy_followup_normalize_policy_number(text) is
  'upper(regexp_replace(value, ''\s'', '''', ''g'')), null at zero characters. Byte-for-byte the definition cancellation_cases.policy_number_normalized is generated with, so a policy stored as a cancellation case keys to the same owner row the renewals side computes. Requirement 3.1.';

-- Confirmed carrier display aliases. A row belongs here only when somebody has confirmed
-- the two spellings name the same carrier: design 4.2 forbids merging carriers on fuzzy
-- similarity, so there is no similarity step anywhere in the function below and an
-- unlisted spelling keys to itself. A visible duplicate a manager can correct is the
-- intended failure mode; a wrong shared owner is not.
create table if not exists public.policy_followup_carrier_aliases (
  folded_alias text primary key,
  carrier_key text not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);

comment on table public.policy_followup_carrier_aliases is
  'Confirmed carrier display aliases folded to one canonical carrier key. Consulted by policy_followup_normalize_carrier_key. Mirrors CARRIER_KEY_ALIASES in src/features/policy-follow-up/normalization.ts. Requirement 3.1, design 4.2.';

insert into public.policy_followup_carrier_aliases (folded_alias, carrier_key) values
  ('natgen', 'NATIONALGENERAL'),
  ('nationalgeneral', 'NATIONALGENERAL'),
  ('nationalgeneralinsurance', 'NATIONALGENERAL'),
  ('ngic', 'NATIONALGENERAL'),
  ('progressive', 'PROGRESSIVE'),
  ('progressiveinsurance', 'PROGRESSIVE'),
  ('progressiveamericaninsurance', 'PROGRESSIVE'),
  ('geico', 'GEICO'),
  ('statefarm', 'STATEFARM'),
  ('unitedauto', 'UNITEDAUTOMOBILE'),
  ('unitedautomobile', 'UNITEDAUTOMOBILE'),
  ('unitedautomobileinsurance', 'UNITEDAUTOMOBILE'),
  ('uaic', 'UNITEDAUTOMOBILE'),
  ('bristolwest', 'BRISTOLWEST'),
  ('infinity', 'INFINITY'),
  ('infinityinsurance', 'INFINITY'),
  ('mercury', 'MERCURY'),
  ('mercuryinsurance', 'MERCURY'),
  ('travelers', 'TRAVELERS'),
  ('thehartford', 'HARTFORD'),
  ('hartford', 'HARTFORD'),
  ('citizens', 'CITIZENS'),
  ('citizensproperty', 'CITIZENS')
on conflict (folded_alias) do nothing;

-- `unaccent` is a contrib extension that may not be installed, and enabling an extension
-- is a heavier change than this migration should make. This wrapper strips the Latin-1
-- accented characters a Spanish carrier name actually carries, which is every character
-- the TypeScript NFD-plus-combining-marks removal affects for these inputs. Declared
-- before the carrier normalizer because a SQL-language function body is validated at
-- creation time.
create or replace function public.policy_followup_unaccent(p_value text)
returns text
language sql
immutable
as $$
  select translate(
    coalesce(p_value, ''),
    'áàäâãÁÀÄÂÃéèëêÉÈËÊíìïîÍÌÏÎóòöôõÓÒÖÔÕúùüûÚÙÜÛñÑçÇ',
    'aaaaaAAAAAeeeeEEEEiiiiIIIIoooooOOOOOuuuuUUUUnNcC');
$$;

comment on function public.policy_followup_unaccent(text) is
  'Latin-1 accented characters folded to their unaccented form, without requiring the unaccent extension. Used by policy_followup_normalize_carrier_key so a Spanish carrier name keys the way the TypeScript normalizer keys it.';

create or replace function public.policy_followup_normalize_carrier_key(p_carrier text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with folded as (
    select nullif(
      regexp_replace(
        upper(public.policy_followup_unaccent(coalesce(p_carrier, ''))),
        '[^A-Z0-9]+', '', 'g'),
      '') as key
  )
  select coalesce(
    (select alias.carrier_key
       from public.policy_followup_carrier_aliases alias, folded
      where alias.folded_alias = lower(folded.key)),
    (select key from folded));
$$;

comment on function public.policy_followup_normalize_carrier_key(text) is
  'Accents removed, every non-alphanumeric character removed, upper-cased, then the confirmed alias table consulted. null where the value names no carrier, which callers must treat as review-required rather than as an ownership identity. No fuzzy matching: design 4.2.';

grant execute on function public.policy_followup_unaccent(text) to authenticated;
grant execute on function public.policy_followup_normalize_carrier_key(text) to authenticated;
grant execute on function public.policy_followup_normalize_policy_number(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. SHARED POLICY OWNERSHIP (Requirements 3.1, 3.2, 3.3, 3.5, design 4.1)
--
--    One row per (carrier_key, policy_number_normalized). `assigned_to` may be null:
--    an unowned policy and a bootstrap conflict are both legitimate states that must
--    stay visible rather than be guessed at (design 4.4).
--
--    `assignment_locked` is Requirement 3.5's protection. A manager assignment sets it,
--    and no import may clear it — only the explicit unlock action of Requirement 3.5.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.policy_followup_policy_owners (
  id uuid primary key default gen_random_uuid(),

  carrier_key text not null,
  policy_number_normalized text not null,

  assigned_to uuid references public.profiles(id),
  assignment_source text not null check (assignment_source in (
    'migration', 'existing_owner', 'producer_mapping', 'weighted_auto', 'manager')),
  assignment_locked boolean not null default false,
  assigned_by uuid references public.profiles(id),
  assigned_at timestamptz not null default now(),
  last_auto_assigned_at timestamptz,
  manager_note text,

  -- design 4.4: the bootstrap found the renewal and the cancellation for one policy
  -- assigned to different employees. `assigned_to` stays null and a manager chooses;
  -- workload balancing must never resolve a conflict.
  conflict boolean not null default false,
  conflict_detail jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint policy_followup_policy_owners_identity_key
    unique (carrier_key, policy_number_normalized),
  -- An unresolved conflict has no owner. Recording both at once would mean the row
  -- claims to be settled and unsettled at the same time.
  constraint policy_followup_policy_owners_conflict_unowned
    check (not conflict or assigned_to is null),
  -- A locked row is a manager decision, so it must name an owner and an actor.
  constraint policy_followup_policy_owners_locked_is_manager
    check (not assignment_locked or (assigned_to is not null and assignment_source = 'manager'))
);

comment on table public.policy_followup_policy_owners is
  'Shared policy ownership at the (normalized carrier key, normalized policy number) level. Stable across import runs and across the Renewal and Cancellation domains, which is what makes one policy resolve to one owner. renewal_records.assigned_to and cancellation_cases.assigned_to remain for compatibility and are kept synchronized with this row. Requirements 3.1, 3.2.';
comment on column public.policy_followup_policy_owners.assignment_locked is
  'True where a manager fixed this ownership. No import may reassign or clear a locked row; only the explicit unlock action of Requirement 3.5 releases it.';
comment on column public.policy_followup_policy_owners.last_auto_assigned_at is
  'When weighted balancing last chose this employee for this policy. The second key of the Requirement 4.3 tie break.';
comment on column public.policy_followup_policy_owners.conflict is
  'True where the bootstrap found different owners for the same policy in the two domains and refused to guess. assigned_to stays null until a manager chooses. Design 4.4.';

create index if not exists idx_policy_followup_owners_assigned
  on public.policy_followup_policy_owners (assigned_to);

create index if not exists idx_policy_followup_owners_policy
  on public.policy_followup_policy_owners (policy_number_normalized);

create index if not exists idx_policy_followup_owners_unowned
  on public.policy_followup_policy_owners (carrier_key, policy_number_normalized)
  where assigned_to is null;

create index if not exists idx_policy_followup_owners_conflict
  on public.policy_followup_policy_owners (updated_at desc)
  where conflict;

drop trigger if exists policy_followup_policy_owners_touch on public.policy_followup_policy_owners;
create trigger policy_followup_policy_owners_touch
  before update on public.policy_followup_policy_owners
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. AGENT ELIGIBILITY (Requirement 3.4, design 5)
--
--    These settings control *workload eligibility only*. Application roles remain
--    authoritative for access (Requirement 3.4), and nothing here is read by the quote
--    rotations, the attendance queue state, or the RingCentral/WhatsApp turn logic.
--
--    A profile with no row is treated as fully eligible by
--    `policy_followup_eligible_agents` below, so deploying this migration changes no
--    employee's eligibility until a manager configures one.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.policy_followup_agent_settings (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  renewals_enabled boolean not null default true,
  cancellations_enabled boolean not null default true,
  auto_assignment_enabled boolean not null default true,
  assignment_mode text not null default 'producer_preferred'
    check (assignment_mode in ('automatic', 'producer_preferred', 'manual_only')),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.policy_followup_agent_settings is
  'Per-employee Policy Follow-up workload eligibility. Controls automatic assignment only; application roles remain authoritative for access. Deliberately unrelated to quote queue status, attendance status, RingCentral turn, WhatsApp turn, and rotation positions. Requirement 3.4, design 5.';
comment on column public.policy_followup_agent_settings.assignment_mode is
  'manual_only receives no automatic balancing assignment. automatic and producer_preferred both do; producer_preferred is documentary in this phase because producer mapping already outranks balancing in the Requirement 3.3 precedence for everybody.';

drop trigger if exists policy_followup_agent_settings_touch on public.policy_followup_agent_settings;
create trigger policy_followup_agent_settings_touch
  before update on public.policy_followup_agent_settings
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. ASSIGNMENT AUDIT (Requirement 13.2)
--
--    Append-only, enforced by trigger so even a security definer path cannot rewrite
--    history, and by revokes so a client-role attempt fails at the privilege level
--    rather than quietly matching zero rows. Same pattern as cancellation_events
--    (v1.10.0) and attendance_audit_log (v1.9.0).
--
--    Domain audit events are still written to renewal_events and cancellation_events by
--    the functions in v1.13.2, so the existing drawers and timelines stay complete. This
--    table answers the cross-domain question those two cannot: who has owned this policy.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.policy_followup_assignment_events (
  id uuid primary key default gen_random_uuid(),
  carrier_key text not null,
  policy_number_normalized text not null,
  domain text check (domain in ('renewal', 'cancellation')),
  source_record_id uuid,
  event_type text not null check (event_type in (
    'bootstrap', 'producer_assignment', 'auto_assignment', 'manager_assignment', 'unlock', 'conflict')),
  previous_profile_id uuid references public.profiles(id),
  next_profile_id uuid references public.profiles(id),
  actor_profile_id uuid references public.profiles(id),
  detail jsonb,
  created_at timestamptz not null default now(),
  sequence bigserial not null
);

comment on table public.policy_followup_assignment_events is
  'Append-only audit of every Policy Follow-up ownership decision, with its source and its actor. Update and delete are refused by trigger for every role including a security definer path. Requirement 13.2.';

create index if not exists idx_policy_followup_assignment_events_policy
  on public.policy_followup_assignment_events
     (carrier_key, policy_number_normalized, created_at desc, sequence desc);

create index if not exists idx_policy_followup_assignment_events_type
  on public.policy_followup_assignment_events (event_type, created_at desc);

create index if not exists idx_policy_followup_assignment_events_actor
  on public.policy_followup_assignment_events (actor_profile_id, created_at desc);

create or replace function public.policy_followup_assignment_events_immutable()
returns trigger
language plpgsql
as $fn$
begin
  raise exception 'policy_followup_assignment_events is append-only: stored assignment history cannot be changed or deleted'
    using errcode = 'restrict_violation',
          detail  = format('attempted %s on policy_followup_assignment_events row %s',
                           lower(tg_op), coalesce(old.id::text, '(unknown)')),
          hint    = 'Requirement 13.2. Record a new assignment event instead.';
end;
$fn$;

drop trigger if exists policy_followup_assignment_events_no_update
  on public.policy_followup_assignment_events;
create trigger policy_followup_assignment_events_no_update
  before update or delete on public.policy_followup_assignment_events
  for each row execute function public.policy_followup_assignment_events_immutable();

revoke update, delete on public.policy_followup_assignment_events from authenticated;
revoke update, delete on public.policy_followup_assignment_events from anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. WORKLOAD WEIGHTS (Requirement 4.2, design 6.1)
--
--    One row per weight key, seeded from POLICY_WORKLOAD_WEIGHTS in
--    src/features/policy-follow-up/workload.ts. The assignment engine in v1.13.2 reads
--    this table, and the TypeScript display layer reads the constant, so the two agree
--    by construction. The post-condition block asserts every value.
--
--    Manager editing of weights is out of scope for this phase (design 6.1), so there is
--    no update policy: a change is a migration, which is also what makes it auditable.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.policy_followup_workload_weights (
  key text primary key,
  points integer not null check (points > 0),
  description text
);

comment on table public.policy_followup_workload_weights is
  'The Requirement 4.2 workload weights. Read by policy_followup_agent_workload; mirrored by POLICY_WORKLOAD_WEIGHTS in src/features/policy-follow-up/workload.ts. Not manager-editable in this phase.';

insert into public.policy_followup_workload_weights (key, points, description) values
  ('renewal_open',                      1,  'Open renewal more than 30 days out with no due follow-up'),
  ('renewal_due_30',                    2,  'Renewal due within 30 days'),
  ('renewal_due_15',                    3,  'Renewal due within 15 days'),
  ('renewal_due_7',                     4,  'Renewal due within 7 days'),
  ('renewal_due_3',                     5,  'Renewal due within 3 days, or already past'),
  ('renewal_nonrenewal',                7,  'Carrier Non-Renewal / Requote Required — a floor, not an addend'),
  ('renewal_overdue_followup',          5,  'Added where a required renewal follow-up is due or past'),
  ('cancellation_active',               2,  'Active cancellation more than 15 days out'),
  ('cancellation_due_15',               3,  'Cancellation due within 15 days'),
  ('cancellation_due_10',               4,  'Cancellation due within 10 days'),
  ('cancellation_due_5',                6,  'Cancellation due within 5 days'),
  ('cancellation_due_1',                10, 'Cancellation due within 1 day, today, or already past'),
  ('cancellation_payment_verification', 7,  'Payment reported / verification required — a floor, not an addend'),
  ('cancellation_communication_manual', 4,  'Added where a failed or suppressed message needs manual work'),
  ('cancellation_overdue_followup',     5,  'Added where a cancellation follow-up deadline is due or past')
on conflict (key) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. ELIGIBLE AGENTS (Requirement 3.4, design 5)
--
--    One definition of "who may receive Policy Follow-up work", used by the workload
--    query, the auto-assignment engine, and the manager settings surface.
--
--    A profile with no settings row is fully eligible, which is why the join is a left
--    join with column defaults: deploying this migration changes nobody's eligibility.
--
--    `commercial`, `commercial_supervisor`, and `customer_service_supervisor` are absent
--    because canAccessRenewals excludes them. `sales_supervisor` reaches the workspace but
--    is excluded from *automatic assignment* here: they hold Agent_Role privileges for
--    actions, and giving a supervisor a balanced book was not asked for. A manager may
--    still assign one a policy by hand, which goes through the manager path and not this
--    function.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.policy_followup_eligible_agents(p_domain text default null)
returns table (
  profile_id uuid,
  display_name text,
  username text,
  initials text,
  role text,
  renewals_enabled boolean,
  cancellations_enabled boolean,
  auto_assignment_enabled boolean,
  assignment_mode text
)
language sql
stable
security definer
set search_path = public
as $$
  select profile.id,
         profile.display_name,
         profile.username,
         profile.initials,
         profile.role::text,
         coalesce(setting.renewals_enabled, true),
         coalesce(setting.cancellations_enabled, true),
         coalesce(setting.auto_assignment_enabled, true),
         coalesce(setting.assignment_mode, 'producer_preferred')
    from public.profiles profile
    left join public.policy_followup_agent_settings setting on setting.profile_id = profile.id
   where profile.is_active
     and profile.role::text in ('agent', 'customer_service')
     and (p_domain is null
          or (p_domain = 'renewal' and coalesce(setting.renewals_enabled, true))
          or (p_domain = 'cancellation' and coalesce(setting.cancellations_enabled, true)))
   order by profile.display_name;
$$;

comment on function public.policy_followup_eligible_agents(text) is
  'Active employees who may hold Policy Follow-up work, with their eligibility settings folded in. A profile with no settings row is fully eligible. p_domain narrows to the employees enabled for that domain. Requirement 3.4.';

grant execute on function public.policy_followup_eligible_agents(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. ROW LEVEL SECURITY (Requirement 14.2, design 14)
--
--    Reads are open to the whole Policy Follow-up workspace: an agent has to be able to
--    see who owns a policy they are looking at. Writes are Manager_Role only, and the
--    v1.13.2 assignment functions are security definer so the engine still works for an
--    agent action that legitimately triggers it while an agent cannot reassign by hand.
--
--    No policy weakens any existing renewal or cancellation access rule.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.policy_followup_policy_owners enable row level security;
alter table public.policy_followup_agent_settings enable row level security;
alter table public.policy_followup_assignment_events enable row level security;
alter table public.policy_followup_workload_weights enable row level security;
alter table public.policy_followup_carrier_aliases enable row level security;

-- ── Shared owners: everyone in the workspace reads; only Manager_Role writes by hand.
drop policy if exists policy_followup_owners_v1130_select on public.policy_followup_policy_owners;
create policy policy_followup_owners_v1130_select
  on public.policy_followup_policy_owners for select
  using (public.policy_followup_can_access());

drop policy if exists policy_followup_owners_v1130_insert on public.policy_followup_policy_owners;
create policy policy_followup_owners_v1130_insert
  on public.policy_followup_policy_owners for insert
  with check (public.policy_followup_is_manager());

drop policy if exists policy_followup_owners_v1130_update on public.policy_followup_policy_owners;
create policy policy_followup_owners_v1130_update
  on public.policy_followup_policy_owners for update
  using (public.policy_followup_is_manager())
  with check (public.policy_followup_is_manager());

-- Deliberately no delete policy: ownership history is not deleted, it is reassigned.

-- ── Agent settings: the workspace reads them so a surface can show who is eligible;
--    only Manager_Role changes them.
drop policy if exists policy_followup_agent_settings_v1130_select on public.policy_followup_agent_settings;
create policy policy_followup_agent_settings_v1130_select
  on public.policy_followup_agent_settings for select
  using (public.policy_followup_can_access());

drop policy if exists policy_followup_agent_settings_v1130_insert on public.policy_followup_agent_settings;
create policy policy_followup_agent_settings_v1130_insert
  on public.policy_followup_agent_settings for insert
  with check (public.policy_followup_is_manager());

drop policy if exists policy_followup_agent_settings_v1130_update on public.policy_followup_agent_settings;
create policy policy_followup_agent_settings_v1130_update
  on public.policy_followup_agent_settings for update
  using (public.policy_followup_is_manager())
  with check (public.policy_followup_is_manager());

-- ── Assignment audit: Manager_Role reads. Inserts arrive only through the security
--    definer functions of v1.13.2, so there is no insert policy at all; and no update or
--    delete policy, matching the append-only trigger.
drop policy if exists policy_followup_assignment_events_v1130_select
  on public.policy_followup_assignment_events;
create policy policy_followup_assignment_events_v1130_select
  on public.policy_followup_assignment_events for select
  using (public.policy_followup_is_manager());

-- ── Weights and aliases: readable by the workspace, so a manager surface can show the
--    model. Aliases are manager-writable; weights are migration-only in this phase.
drop policy if exists policy_followup_weights_v1130_select on public.policy_followup_workload_weights;
create policy policy_followup_weights_v1130_select
  on public.policy_followup_workload_weights for select
  using (public.policy_followup_can_access());

drop policy if exists policy_followup_carrier_aliases_v1130_select on public.policy_followup_carrier_aliases;
create policy policy_followup_carrier_aliases_v1130_select
  on public.policy_followup_carrier_aliases for select
  using (public.policy_followup_can_access());

drop policy if exists policy_followup_carrier_aliases_v1130_insert on public.policy_followup_carrier_aliases;
create policy policy_followup_carrier_aliases_v1130_insert
  on public.policy_followup_carrier_aliases for insert
  with check (public.policy_followup_is_manager());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. POST-CONDITIONS
--    Any failure raises, which rolls the whole migration back rather than leaving a
--    half-built foundation for v1.13.1 and later to apply on top of.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing        text;
  v_weight_rows    integer;
  v_weight_mismatch text;
  v_carrier_key    text;
  v_policy_key     text;
  v_update_blocked boolean := false;
  v_delete_blocked boolean := false;
  v_event_id       uuid;
begin
  -- ── All five tables exist.
  select string_agg(t.name, ', ' order by t.name) into v_missing
    from (values ('policy_followup_policy_owners'), ('policy_followup_agent_settings'),
                 ('policy_followup_assignment_events'), ('policy_followup_workload_weights'),
                 ('policy_followup_carrier_aliases')) as t(name)
   where not exists (select 1 from pg_tables
                      where schemaname = 'public' and tablename = t.name);
  if v_missing is not null then
    raise exception 'v1.13.0 did not create: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── Row level security is on for all five.
  select string_agg(c.relname, ', ' order by c.relname) into v_missing
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('policy_followup_policy_owners', 'policy_followup_agent_settings',
                       'policy_followup_assignment_events', 'policy_followup_workload_weights',
                       'policy_followup_carrier_aliases')
     and not c.relrowsecurity;
  if v_missing is not null then
    raise exception 'v1.13.0 left row level security off on: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── The weight seed is exactly the Requirement 4.2 table. This is the guarantee that
  --    the SQL engine and src/features/policy-follow-up/workload.ts cannot drift.
  select count(*) into v_weight_rows from public.policy_followup_workload_weights;
  if v_weight_rows <> 15 then
    raise exception 'v1.13.0 expected 15 workload weights, found %', v_weight_rows
      using detail = 'Requirement 4.2.', hint = 'Rolling back.';
  end if;

  select string_agg(format('%s expected %s got %s', expected.key, expected.points, stored.points), ', ')
    into v_weight_mismatch
    from (values
      ('renewal_open', 1), ('renewal_due_30', 2), ('renewal_due_15', 3), ('renewal_due_7', 4),
      ('renewal_due_3', 5), ('renewal_nonrenewal', 7), ('renewal_overdue_followup', 5),
      ('cancellation_active', 2), ('cancellation_due_15', 3), ('cancellation_due_10', 4),
      ('cancellation_due_5', 6), ('cancellation_due_1', 10),
      ('cancellation_payment_verification', 7), ('cancellation_communication_manual', 4),
      ('cancellation_overdue_followup', 5)
    ) as expected(key, points)
    left join public.policy_followup_workload_weights stored on stored.key = expected.key
   where stored.points is distinct from expected.points;
  if v_weight_mismatch is not null then
    raise exception 'v1.13.0 seeded the wrong workload weights: %', v_weight_mismatch
      using detail = 'Requirement 4.2.', hint = 'Rolling back.';
  end if;

  -- ── The two normalizers behave exactly as the TypeScript ones do.
  if public.policy_followup_normalize_policy_number(' abc 123 ') is distinct from 'ABC123' then
    raise exception 'policy_followup_normalize_policy_number does not match the TypeScript definition'
      using hint = 'Rolling back.';
  end if;
  if public.policy_followup_normalize_policy_number('   ') is not null then
    raise exception 'policy_followup_normalize_policy_number must return null at zero characters'
      using hint = 'Rolling back.';
  end if;
  if public.policy_followup_normalize_policy_number('0012-AB') is distinct from '0012-AB' then
    raise exception 'policy_followup_normalize_policy_number must keep hyphens and leading zeros'
      using hint = 'Rolling back.';
  end if;

  -- It must agree with the generated column on cancellation_cases, which is the whole
  -- point of sharing the definition.
  if public.policy_followup_normalize_policy_number('pol 9 9')
     is distinct from upper(regexp_replace('pol 9 9', '\s', '', 'g')) then
    raise exception 'policy_followup_normalize_policy_number diverges from cancellation_cases.policy_number_normalized'
      using detail = 'Requirement 3.1.', hint = 'Rolling back.';
  end if;

  select public.policy_followup_normalize_carrier_key('PROGRESSIVE INSURANCE') into v_carrier_key;
  if v_carrier_key is distinct from 'PROGRESSIVE' then
    raise exception 'policy_followup_normalize_carrier_key did not resolve a confirmed alias (got %)',
                    coalesce(v_carrier_key, 'null')
      using hint = 'Rolling back.';
  end if;
  if public.policy_followup_normalize_carrier_key('NatGen') is distinct from 'NATIONALGENERAL' then
    raise exception 'policy_followup_normalize_carrier_key did not resolve NatGen'
      using hint = 'Rolling back.';
  end if;
  if public.policy_followup_normalize_carrier_key('Compañía Ejemplo') is distinct from 'COMPANIAEJEMPLO' then
    raise exception 'policy_followup_normalize_carrier_key did not fold accents (got %)',
                    coalesce(public.policy_followup_normalize_carrier_key('Compañía Ejemplo'), 'null')
      using hint = 'Rolling back.';
  end if;
  -- design 4.2: an unconfirmed spelling must NOT be merged onto a confirmed carrier.
  if public.policy_followup_normalize_carrier_key('Progresive')
     = public.policy_followup_normalize_carrier_key('Progressive') then
    raise exception 'policy_followup_normalize_carrier_key merged two carriers on similarity'
      using detail = 'Design 4.2 forbids fuzzy carrier merging.', hint = 'Rolling back.';
  end if;
  if public.policy_followup_normalize_carrier_key('   ') is not null then
    raise exception 'policy_followup_normalize_carrier_key must return null where no carrier is named'
      using hint = 'Rolling back.';
  end if;

  -- ── The assignment audit really is append-only, on this security definer path.
  --
  --    The probe row cannot be deleted afterwards — that is the property under test — so
  --    the whole probe runs inside a plpgsql subtransaction that is discarded on the way
  --    out. Nothing is left behind in an audit table.
  begin
    insert into public.policy_followup_assignment_events
      (carrier_key, policy_number_normalized, event_type, detail)
    values ('__V1130_PROBE__', '__V1130_PROBE__', 'bootstrap',
            jsonb_build_object('postcondition', true))
    returning id into v_event_id;

    begin
      update public.policy_followup_assignment_events set event_type = 'unlock' where id = v_event_id;
    exception when others then v_update_blocked := true;
    end;
    begin
      delete from public.policy_followup_assignment_events where id = v_event_id;
    exception when others then v_delete_blocked := true;
    end;

    -- Discard the inserted probe row by failing this subtransaction on purpose.
    raise exception '__v1130_probe_rollback__';
  exception
    when others then
      if sqlerrm is distinct from '__v1130_probe_rollback__' then raise; end if;
  end;

  if not v_update_blocked then
    raise exception 'policy_followup_assignment_events accepted an update'
      using detail = 'Requirement 13.2.', hint = 'Rolling back.';
  end if;
  if not v_delete_blocked then
    raise exception 'policy_followup_assignment_events accepted a delete'
      using detail = 'Requirement 13.2.', hint = 'Rolling back.';
  end if;

  -- ── The conflict and lock invariants are enforced.
  begin
    insert into public.policy_followup_policy_owners
      (carrier_key, policy_number_normalized, assigned_to, assignment_source, conflict)
    values ('__V1130_CHECK__', '__V1130_CHECK__',
            (select id from public.profiles limit 1), 'migration', true);
    raise exception 'policy_followup_policy_owners accepted a conflict row that also names an owner'
      using hint = 'Rolling back.';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.policy_followup_policy_owners
      (carrier_key, policy_number_normalized, assignment_source, assignment_locked)
    values ('__V1130_CHECK__', '__V1130_CHECK__', 'weighted_auto', true);
    raise exception 'policy_followup_policy_owners accepted a locked row with no manager owner'
      using hint = 'Rolling back.';
  exception
    when check_violation then null;
  end;

  delete from public.policy_followup_policy_owners where carrier_key = '__V1130_CHECK__';

  raise notice 'v1.13.0 applied: shared policy ownership foundation is in place.';
end;
$post$;

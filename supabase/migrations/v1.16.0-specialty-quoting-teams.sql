-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.16.0 — Specialty Quotes: the generic quoting-team layer
--
-- Spec: Specialty Quotes Engine (Trucking + Homeowners collaborative quoting),
-- sections 3-9, 18, 24, 36-38, 67-70, 87, 89.
--
-- WHAT THIS CHANGES
--   Adds a configuration-driven authorization axis that did not exist anywhere in
--   this database: quoting teams with per-member capabilities, and a line-of-
--   business routing table that says which team receives which kind of work.
--   Adds workflow templates (stages + seeded checklists) so a line of business is
--   configured rather than coded, and a carrier registry so carrier performance
--   can be reported on later.
--
--   Team membership — not application role — is what grants Specialty access.
--   `agent`, `customer_service`, `super_admin` and anything else can all be
--   members; no new app_role value is introduced and none is required.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
--   * No commercial table, policy, RPC or storage object is touched. Commercial
--     GL keeps its board, its routing and its reports.
--   * No intake routing changes here. That is v1.16.5.
--   * No employee name appears in any authorization predicate. The seed block at
--     the end resolves three known profiles to UUIDs by their unique `username`
--     and inserts membership rows; every access decision afterwards reads those
--     rows. Removing the seed changes who has access, not how access works.
--   * `commercial_gl` is permitted by the LOB check constraints so a Commercial
--     Team can be created later, but no route row is created for it, so nothing
--     reroutes today.
--
-- ROLLBACK
--   begin;
--     drop function if exists public.specialty_can_reassign_opportunity(uuid);
--     drop function if exists public.specialty_can_claim_opportunity(uuid);
--     drop function if exists public.specialty_can_edit_opportunity(uuid);
--     drop function if exists public.specialty_can_view_opportunity(uuid);
--     drop function if exists public.specialty_can_view_lob(text);
--     drop function if exists public.specialty_can_access();
--     drop function if exists public.specialty_member_capability(uuid, text);
--     drop function if exists public.specialty_is_manager();
--     drop table if exists public.quoting_team_events;
--     drop table if exists public.quoting_team_lob_routes;
--     drop table if exists public.quoting_team_members;
--     drop table if exists public.quoting_teams;
--     drop table if exists public.specialty_checklist_templates;
--     drop table if exists public.specialty_workflow_stages;
--     drop table if exists public.specialty_workflow_templates;
--     drop table if exists public.specialty_carriers;
--   commit;
--   (Safe only while v1.16.1 and later have not been applied.)
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. WORKFLOW TEMPLATES
--
--    A line of business is a row here, not a component. The nine stages are a
--    single shared vocabulary (spec 25) so stage counts and reports work across
--    lines without a union per line; what a template controls is which of those
--    stages it offers, in what order, under what label, and which checklist it
--    seeds.
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.specialty_workflow_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique,
  name text not null,
  description text,
  line_of_business text not null
    check (line_of_business in ('trucking', 'homeowners', 'commercial_gl')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint specialty_workflow_templates_key_not_empty
    check (char_length(btrim(template_key)) > 0)
);

comment on table public.specialty_workflow_templates is
  'One quoting workflow per line of business. Trucking and Homeowners ship first; commercial_gl is permitted so a Commercial template can be added later without a schema change. Spec section 24.';

drop trigger if exists specialty_workflow_templates_touch on public.specialty_workflow_templates;
create trigger specialty_workflow_templates_touch
  before update on public.specialty_workflow_templates
  for each row execute function public.touch_updated_at();

-- The canonical stage vocabulary. Every opportunity's `stage` is checked against
-- this same list (v1.16.1), so a template cannot invent a stage that reporting
-- does not understand.
create table if not exists public.specialty_workflow_stages (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.specialty_workflow_templates(id) on delete cascade,
  stage_key text not null check (stage_key in (
    'new', 'information_needed', 'ready_to_market', 'marketing',
    'options_ready', 'price_sent', 'follow_up', 'sold', 'not_sold'
  )),
  label text not null,
  position integer not null,
  -- Follow-Up must not become a place quotes sit without accountability (spec 32).
  requires_next_action boolean not null default false,
  is_terminal boolean not null default false,
  created_at timestamptz not null default now(),
  unique (template_id, stage_key)
);

comment on table public.specialty_workflow_stages is
  'Which stages a template offers, their order and their employee-facing labels. The stage_key vocabulary is fixed so cross-line reporting and stage counts have one meaning. Spec sections 24-34.';

create table if not exists public.specialty_checklist_templates (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.specialty_workflow_templates(id) on delete cascade,
  category text not null,
  label text not null,
  position integer not null,
  is_required boolean not null default false,
  created_at timestamptz not null default now(),
  unique (template_id, category, label)
);

comment on table public.specialty_checklist_templates is
  'The standard checklist a new opportunity is seeded with, so employees never hand-build the basic process. Spec sections 36-38. Deliberately holds only what the CS intake does not already collect.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CARRIER REGISTRY
--
--    Carrier markets reference a carrier row rather than free text, because spec
--    section 75 asks for per-carrier submission / quote / decline / bind rates and
--    that is not answerable over spellings.
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.specialty_carriers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  lines_of_business text[] not null default '{}',
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint specialty_carriers_name_not_empty check (char_length(btrim(name)) > 0)
);

comment on table public.specialty_carriers is
  'Carriers that specialty markets are placed with. lines_of_business is a hint for the picker, not a restriction: an employee may market any carrier when the real world calls for it.';

drop trigger if exists specialty_carriers_touch on public.specialty_carriers;
create trigger specialty_carriers_touch
  before update on public.specialty_carriers
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. QUOTING TEAMS
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.quoting_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  is_active boolean not null default true,
  -- Configurable for the future (spec 18). Only shared_claim is wired into the
  -- claim path today; the others are accepted and stored so a team can be set up
  -- ahead of the behaviour existing, and `specialty_claim_opportunity` refuses a
  -- self-claim on a manual_assignment team.
  assignment_method text not null default 'shared_claim'
    check (assignment_method in ('shared_claim', 'manual_assignment', 'automatic_balanced', 'round_robin')),
  -- The collaboration rule, as a setting rather than as code (spec 10).
  -- true  → any member with can_edit may work any of the team's opportunities.
  -- false → only the primary assignee (and management) may edit.
  collaborative_editing boolean not null default true,
  -- 'team'   → only members and management see the team's work.
  -- 'agency' → any Specialty member sees it read-only. Not used initially.
  team_visibility text not null default 'team'
    check (team_visibility in ('team', 'agency')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quoting_teams_name_not_empty check (char_length(btrim(name)) > 0)
);

comment on table public.quoting_teams is
  'A quoting team. Managers create and maintain these; changing who handles a line of insurance is configuration, not a migration. Spec sections 5-6, 67-70.';

drop trigger if exists quoting_teams_touch on public.quoting_teams;
create trigger quoting_teams_touch
  before update on public.quoting_teams
  for each row execute function public.touch_updated_at();

-- Membership is the access boundary. Application role is a separate concept:
-- Oscar and Jason are super_admin, Brenda is customer_service, and all three are
-- ordinary members here (spec section 4).
create table if not exists public.quoting_team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.quoting_teams(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  can_view boolean not null default true,
  can_claim boolean not null default true,
  can_edit boolean not null default true,
  can_be_assigned boolean not null default true,
  can_reassign boolean not null default true,
  can_view_reports boolean not null default true,
  is_active boolean not null default true,
  added_by uuid references public.profiles(id),
  added_at timestamptz not null default now(),
  -- Membership is retired, never deleted, so historical attribution survives
  -- (spec section 68).
  removed_at timestamptz,
  removed_by uuid references public.profiles(id),
  removed_reason text,
  updated_at timestamptz not null default now(),
  unique (team_id, profile_id)
);

comment on table public.quoting_team_members is
  'Per-member capabilities on a quoting team. Removing a member sets is_active false and stamps removed_at; the row stays so past work keeps its attribution. Spec sections 7, 68.';

drop trigger if exists quoting_team_members_touch on public.quoting_team_members;
create trigger quoting_team_members_touch
  before update on public.quoting_team_members
  for each row execute function public.touch_updated_at();

create index if not exists quoting_team_members_profile_idx
  on public.quoting_team_members (profile_id) where is_active;
create index if not exists quoting_team_members_team_idx
  on public.quoting_team_members (team_id) where is_active;

-- Which team receives which line of business. Exactly one active default per line.
create table if not exists public.quoting_team_lob_routes (
  id uuid primary key default gen_random_uuid(),
  line_of_business text not null
    check (line_of_business in ('trucking', 'homeowners', 'commercial_gl')),
  team_id uuid not null references public.quoting_teams(id) on delete restrict,
  workflow_template_id uuid not null references public.specialty_workflow_templates(id) on delete restrict,
  is_default boolean not null default true,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.quoting_team_lob_routes is
  'Where a submitted specialty intake goes. Customer Service never picks a person; the line of business picks the team. Spec sections 8, 9.';

drop trigger if exists quoting_team_lob_routes_touch on public.quoting_team_lob_routes;
create trigger quoting_team_lob_routes_touch
  before update on public.quoting_team_lob_routes
  for each row execute function public.touch_updated_at();

-- One active default destination per line of business, enforced by the database
-- rather than by whichever screen happens to be writing.
create unique index if not exists quoting_team_lob_routes_one_default
  on public.quoting_team_lob_routes (line_of_business)
  where is_default and is_active;

create table if not exists public.quoting_team_events (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.quoting_teams(id) on delete cascade,
  actor_profile_id uuid references public.profiles(id),
  event_type text not null check (event_type in (
    'team_created', 'team_updated', 'team_activated', 'team_deactivated',
    'member_added', 'member_updated', 'member_removed',
    'route_created', 'route_updated', 'route_deactivated'
  )),
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

comment on table public.quoting_team_events is
  'Append-only audit of team configuration. Written only from the security definer RPCs in v1.16.2, so there is no insert policy. Spec section 91.';

create index if not exists quoting_team_events_team_idx
  on public.quoting_team_events (team_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. AUTHORIZATION HELPERS
--
--    Each mirrors a named helper in src/features/specialty/permissions.ts. The
--    TypeScript decides what to render; these decide what is allowed.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role::text in ('manager', 'super_admin') and is_active
       from public.profiles where id = auth.uid()),
    false);
$$;

comment on function public.specialty_is_manager() is
  'Management oversight in Specialty Quotes: role manager or super_admin, active. Mirrors isBroadManagerRole in src/lib/permissions.ts. Note that Oscar and Jason are super_admin AND team members; this predicate is about oversight, membership is about the work.';

create or replace function public.specialty_member_capability(p_team_id uuid, p_capability text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.quoting_team_members m
    join public.quoting_teams t on t.id = m.team_id
    join public.profiles p on p.id = m.profile_id
    where m.team_id = p_team_id
      and m.profile_id = auth.uid()
      and m.is_active
      and t.is_active
      and p.is_active
      and case p_capability
            when 'view'     then m.can_view
            when 'claim'     then m.can_claim
            when 'edit'      then m.can_edit
            when 'assign'    then m.can_be_assigned
            when 'reassign'  then m.can_reassign
            when 'reports'   then m.can_view_reports
            else false
          end
  );
$$;

comment on function public.specialty_member_capability(uuid, text) is
  'Does the caller hold a capability on this team? Capabilities: view, claim, edit, assign, reassign, reports. Mirrors memberCapability in src/features/specialty/permissions.ts. Spec section 7.';

create or replace function public.specialty_can_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.specialty_is_manager()
     or exists (
       select 1
       from public.quoting_team_members m
       join public.quoting_teams t on t.id = m.team_id
       join public.profiles p on p.id = m.profile_id
       where m.profile_id = auth.uid()
         and m.is_active and m.can_view
         and t.is_active
         and p.is_active
     );
$$;

comment on function public.specialty_can_access() is
  'Can the caller open the Specialty Quotes module at all? Active membership on any active team, or management. A Sales agent with no membership is refused here, not merely in the sidebar. Spec section 85.';

-- Line-of-business visibility. Brenda is on the Homeowners team and not on the
-- Trucking team, so she must not gain Trucking visibility from having reached the
-- module at all (spec sections 55, 86).
create or replace function public.specialty_can_view_lob(p_line_of_business text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.specialty_is_manager()
     or exists (
       select 1
       from public.quoting_team_lob_routes r
       join public.quoting_team_members m on m.team_id = r.team_id
       join public.quoting_teams t on t.id = r.team_id
       join public.profiles p on p.id = m.profile_id
       where r.line_of_business = p_line_of_business
         and r.is_active
         and m.profile_id = auth.uid()
         and m.is_active and m.can_view
         and t.is_active
         and p.is_active
     );
$$;

comment on function public.specialty_can_view_lob(text) is
  'Can the caller see this line of business at all? Routed through team membership, so a Homeowners-only member is refused Trucking. Spec sections 55, 56, 86.';

grant execute on function public.specialty_is_manager() to authenticated;
grant execute on function public.specialty_member_capability(uuid, text) to authenticated;
grant execute on function public.specialty_can_access() to authenticated;
grant execute on function public.specialty_can_view_lob(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. ROW LEVEL SECURITY
--
--    Configuration is readable by anyone who can reach the module, so a member
--    surface can show teams, carriers and stage labels. Writes go through the
--    manager-gated RPCs in v1.16.2, which is why most tables here have no insert
--    or update policy at all.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.specialty_workflow_templates enable row level security;
alter table public.specialty_workflow_stages enable row level security;
alter table public.specialty_checklist_templates enable row level security;
alter table public.specialty_carriers enable row level security;
alter table public.quoting_teams enable row level security;
alter table public.quoting_team_members enable row level security;
alter table public.quoting_team_lob_routes enable row level security;
alter table public.quoting_team_events enable row level security;

drop policy if exists specialty_workflow_templates_v1160_select on public.specialty_workflow_templates;
create policy specialty_workflow_templates_v1160_select
  on public.specialty_workflow_templates for select to authenticated
  using (public.specialty_can_access());

drop policy if exists specialty_workflow_stages_v1160_select on public.specialty_workflow_stages;
create policy specialty_workflow_stages_v1160_select
  on public.specialty_workflow_stages for select to authenticated
  using (public.specialty_can_access());

drop policy if exists specialty_checklist_templates_v1160_select on public.specialty_checklist_templates;
create policy specialty_checklist_templates_v1160_select
  on public.specialty_checklist_templates for select to authenticated
  using (public.specialty_can_access());

drop policy if exists specialty_carriers_v1160_select on public.specialty_carriers;
create policy specialty_carriers_v1160_select
  on public.specialty_carriers for select to authenticated
  using (public.specialty_can_access());

-- Adding a carrier is ordinary quoting work: an employee on the phone with a new
-- market cannot wait for a manager. Renaming or retiring one is not, so there is
-- no update or delete policy.
drop policy if exists specialty_carriers_v1160_insert on public.specialty_carriers;
create policy specialty_carriers_v1160_insert
  on public.specialty_carriers for insert to authenticated
  with check (public.specialty_can_access() and created_by = auth.uid());

drop policy if exists quoting_teams_v1160_select on public.quoting_teams;
create policy quoting_teams_v1160_select
  on public.quoting_teams for select to authenticated
  using (public.specialty_can_access());

drop policy if exists quoting_team_members_v1160_select on public.quoting_team_members;
create policy quoting_team_members_v1160_select
  on public.quoting_team_members for select to authenticated
  using (public.specialty_can_access());

drop policy if exists quoting_team_lob_routes_v1160_select on public.quoting_team_lob_routes;
create policy quoting_team_lob_routes_v1160_select
  on public.quoting_team_lob_routes for select to authenticated
  using (public.specialty_can_access());

-- Configuration audit is management reading. No insert policy: the RPCs write it.
drop policy if exists quoting_team_events_v1160_select on public.quoting_team_events;
create policy quoting_team_events_v1160_select
  on public.quoting_team_events for select to authenticated
  using (public.specialty_is_manager());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. SEED — WORKFLOW TEMPLATES AND STAGES
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.specialty_workflow_templates (template_key, name, description, line_of_business)
values
  ('trucking', 'Trucking', 'Motor carrier quoting: DOT/MC verification, units, drivers, loss runs, carrier marketing.', 'trucking'),
  ('homeowners', 'Homeowners', 'Property quoting: dwelling and roof verification, prior insurance, mortgagee, carrier marketing.', 'homeowners')
on conflict (template_key) do update
  set name = excluded.name,
      description = excluded.description,
      line_of_business = excluded.line_of_business;

-- Both templates offer the full nine-stage workflow. Follow-Up requires a next
-- action; Sold and Not Sold are terminal.
insert into public.specialty_workflow_stages (template_id, stage_key, label, position, requires_next_action, is_terminal)
select t.id, s.stage_key, s.label, s.position, s.requires_next_action, s.is_terminal
from public.specialty_workflow_templates t
cross join (values
  ('new',                'New',                1, false, false),
  ('information_needed', 'Information Needed', 2, true,  false),
  ('ready_to_market',    'Ready to Market',    3, false, false),
  ('marketing',          'Marketing',          4, false, false),
  ('options_ready',      'Options Ready',      5, false, false),
  ('price_sent',         'Price Sent',         6, false, false),
  ('follow_up',          'Follow-Up',          7, true,  false),
  ('sold',               'Sold',               8, false, true),
  ('not_sold',           'Not Sold',           9, false, true)
) as s(stage_key, label, position, requires_next_action, is_terminal)
where t.template_key in ('trucking', 'homeowners')
on conflict (template_id, stage_key) do update
  set label = excluded.label,
      position = excluded.position,
      requires_next_action = excluded.requires_next_action,
      is_terminal = excluded.is_terminal;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. SEED — CHECKLIST TEMPLATES
--
--    Only what the CS intake does not already collect, plus the verification steps
--    a quoter actually performs. Business name, DOT, MC, MCS-150, cargo type,
--    power units, radius, property address, dwelling type, year built, square
--    footage, roof type and roof age all arrive on the intake and are therefore
--    absent here — spec section 20 forbids a second copy.
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.specialty_checklist_templates (template_id, category, label, position, is_required)
select t.id, c.category, c.label, c.position, c.is_required
from public.specialty_workflow_templates t
cross join (values
  ('Customer / Business', 'Confirm business details and contact with the insured',  1,  true),
  ('Customer / Business', 'Verify DOT / MC status on FMCSA',                        2,  true),
  ('Operations',          'Confirm type of operation and commodities hauled',       3,  true),
  ('Operations',          'Confirm radius of operation and states travelled',       4,  true),
  ('Operations',          'Confirm years in business / years of experience',        5,  false),
  ('Vehicles',            'Complete unit list with VINs and stated values',         6,  true),
  ('Vehicles',            'Confirm trailer / non-owned equipment',                  7,  false),
  ('Drivers',             'Complete driver list with licence numbers and DOB',      8,  true),
  ('Drivers',             'Confirm driver experience and CDL class',                9,  true),
  ('Drivers',             'MVR review',                                            10,  false),
  ('Insurance',           'Current carrier and expiring premium',                  11,  true),
  ('Insurance',           'Loss runs received (3-5 years)',                        12,  true),
  ('Insurance',           'Confirm desired coverages and limits',                  13,  true),
  ('Documents',           'Vehicle registrations',                                 14,  false),
  ('Documents',           'Driver licences',                                       15,  false),
  ('Documents',           'Current declarations page',                             16,  false)
) as c(category, label, position, is_required)
where t.template_key = 'trucking'
on conflict (template_id, category, label) do update
  set position = excluded.position, is_required = excluded.is_required;

insert into public.specialty_checklist_templates (template_id, category, label, position, is_required)
select t.id, c.category, c.label, c.position, c.is_required
from public.specialty_workflow_templates t
cross join (values
  ('Customer',  'Confirm contact information and best time to reach',      1,  true),
  ('Property',  'Verify property address and occupancy',                   2,  true),
  ('Property',  'Confirm construction type and square footage',            3,  true),
  ('Property',  'Confirm roof age, roof type and recent updates',          4,  true),
  ('Property',  'Confirm system updates (electrical, plumbing, HVAC)',     5,  false),
  ('Insurance', 'Current carrier and expiring premium',                    6,  true),
  ('Insurance', 'Prior claims history confirmed',                          7,  true),
  ('Insurance', 'Confirm coverage needs (Dwelling A, liability, wind/hail)', 8, true),
  ('Mortgage',  'Mortgagee name and loan number',                          9,  false),
  ('Documents', 'Current declarations page',                              10,  false),
  ('Documents', 'Inspection photos (roof, exterior, interior)',           11,  false),
  ('Documents', 'Other carrier documentation requested',                  12,  false)
) as c(category, label, position, is_required)
where t.template_key = 'homeowners'
on conflict (template_id, category, label) do update
  set position = excluded.position, is_required = excluded.is_required;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. SEED — CARRIERS
--    A starting list so the first quote does not begin with data entry. Employees
--    add more themselves through the insert policy above.
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.specialty_carriers (name, lines_of_business) values
  ('Progressive',        '{trucking,homeowners}'),
  ('Canal Insurance',    '{trucking}'),
  ('National General',   '{trucking,homeowners}'),
  ('Berkshire Hathaway GUARD', '{trucking}'),
  ('Travelers',          '{trucking,homeowners}'),
  ('Great West Casualty','{trucking}'),
  ('Baldwin & Lyons / Protective', '{trucking}'),
  ('Northland',          '{trucking}'),
  ('Sentry',             '{trucking}'),
  ('Citizens Property',  '{homeowners}'),
  ('Universal Property', '{homeowners}'),
  ('Tower Hill',         '{homeowners}'),
  ('American Integrity', '{homeowners}'),
  ('Openly',             '{homeowners}'),
  ('Kin',                '{homeowners}'),
  ('Foremost',           '{homeowners}'),
  ('Other / Direct',     '{trucking,homeowners}')
on conflict (name) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. SEED — THE TWO INITIAL TEAMS AND THEIR ROUTES
--
--    Data, not logic. Profiles are resolved by `username`, which is unique and
--    stable; `display_name` is neither ("Brenda Morales" exists twice, one
--    deactivated). If a username is absent the block raises a notice and skips
--    that member, leaving the manager to add them in Settings → Quoting Teams
--    rather than guessing.
-- ═══════════════════════════════════════════════════════════════════════════════

do $seed$
declare
  v_trucking_team uuid;
  v_home_team uuid;
  v_trucking_template uuid;
  v_home_template uuid;
  v_profile uuid;
  v_username text;
begin
  select id into v_trucking_template from public.specialty_workflow_templates where template_key = 'trucking';
  select id into v_home_template     from public.specialty_workflow_templates where template_key = 'homeowners';

  insert into public.quoting_teams (name, description, assignment_method, collaborative_editing)
  values ('Trucking Team', 'Motor carrier and trucking quoting.', 'shared_claim', true)
  on conflict (name) do update set description = excluded.description
  returning id into v_trucking_team;

  insert into public.quoting_teams (name, description, assignment_method, collaborative_editing)
  values ('Homeowners Team', 'Homeowners and property quoting.', 'shared_claim', true)
  on conflict (name) do update set description = excluded.description
  returning id into v_home_team;

  -- Routes: one active default per line of business.
  if not exists (select 1 from public.quoting_team_lob_routes
                 where line_of_business = 'trucking' and is_active and is_default) then
    insert into public.quoting_team_lob_routes (line_of_business, team_id, workflow_template_id)
    values ('trucking', v_trucking_team, v_trucking_template);
  end if;

  if not exists (select 1 from public.quoting_team_lob_routes
                 where line_of_business = 'homeowners' and is_active and is_default) then
    insert into public.quoting_team_lob_routes (line_of_business, team_id, workflow_template_id)
    values ('homeowners', v_home_team, v_home_template);
  end if;

  -- Trucking Team: Oscar, Jason.
  foreach v_username in array array['oscar', 'jason'] loop
    select id into v_profile from public.profiles where username = v_username and is_active;
    if v_profile is null then
      raise notice 'v1.16.0: no active profile with username %; add them to Trucking Team from Quoting Teams admin.', v_username;
    else
      insert into public.quoting_team_members (team_id, profile_id)
      values (v_trucking_team, v_profile)
      on conflict (team_id, profile_id) do update
        set is_active = true, removed_at = null, removed_by = null, removed_reason = null;
    end if;
  end loop;

  -- Homeowners Team: Oscar, Jason, Brenda.
  foreach v_username in array array['oscar', 'jason', 'brendam'] loop
    select id into v_profile from public.profiles where username = v_username and is_active;
    if v_profile is null then
      raise notice 'v1.16.0: no active profile with username %; add them to Homeowners Team from Quoting Teams admin.', v_username;
    else
      insert into public.quoting_team_members (team_id, profile_id)
      values (v_home_team, v_profile)
      on conflict (team_id, profile_id) do update
        set is_active = true, removed_at = null, removed_by = null, removed_reason = null;
    end if;
  end loop;
end
$seed$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════

do $post$
declare
  v_missing text;
  v_routes integer;
  v_stages integer;
  v_trucking_members integer;
  v_home_members integer;
begin
  select string_agg(t.name, ', ' order by t.name) into v_missing
    from (values ('specialty_workflow_templates'), ('specialty_workflow_stages'),
                 ('specialty_checklist_templates'), ('specialty_carriers'),
                 ('quoting_teams'), ('quoting_team_members'),
                 ('quoting_team_lob_routes'), ('quoting_team_events')) as t(name)
   where not exists (select 1 from pg_tables where schemaname = 'public' and tablename = t.name);
  if v_missing is not null then
    raise exception 'v1.16.0 did not create: %', v_missing using hint = 'Rolling back.';
  end if;

  select string_agg(f.name, ', ' order by f.name) into v_missing
    from (values ('specialty_is_manager'), ('specialty_member_capability'),
                 ('specialty_can_access'), ('specialty_can_view_lob')) as f(name)
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = f.name and p.prosecdef);
  if v_missing is not null then
    raise exception 'v1.16.0 missing security definer helper(s): %', v_missing using hint = 'Rolling back.';
  end if;

  select count(*) into v_routes from public.quoting_team_lob_routes
   where is_active and is_default and line_of_business in ('trucking', 'homeowners');
  if v_routes <> 2 then
    raise exception 'v1.16.0 expected exactly 2 active default routes, found %', v_routes using hint = 'Rolling back.';
  end if;

  -- commercial_gl must NOT be routed to a specialty team by this migration.
  if exists (select 1 from public.quoting_team_lob_routes where line_of_business = 'commercial_gl') then
    raise exception 'v1.16.0 created a commercial_gl route; commercial routing must stay unchanged'
      using hint = 'Rolling back.';
  end if;

  select count(*) into v_stages from public.specialty_workflow_stages;
  if v_stages <> 18 then
    raise exception 'v1.16.0 expected 18 template stage rows (2 templates x 9), found %', v_stages
      using hint = 'Rolling back.';
  end if;

  select count(*) into v_trucking_members
    from public.quoting_team_members m join public.quoting_teams t on t.id = m.team_id
   where t.name = 'Trucking Team' and m.is_active;
  select count(*) into v_home_members
    from public.quoting_team_members m join public.quoting_teams t on t.id = m.team_id
   where t.name = 'Homeowners Team' and m.is_active;

  raise notice 'v1.16.0 seeded: Trucking Team % member(s), Homeowners Team % member(s).',
    v_trucking_members, v_home_members;
end
$post$;

commit;

select
  (select count(*) from public.quoting_teams) as teams_expect_2,
  (select count(*) from public.quoting_team_lob_routes where is_active) as routes_expect_2,
  (select count(*) from public.specialty_workflow_templates) as templates_expect_2,
  (select count(*) from public.specialty_workflow_stages) as stages_expect_18,
  (select count(*) from public.specialty_checklist_templates) as checklist_templates_expect_28,
  (select count(*) from public.specialty_carriers) as carriers_expect_17;

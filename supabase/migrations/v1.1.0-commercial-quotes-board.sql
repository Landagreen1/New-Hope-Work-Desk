-- New Hope Work Desk v1.1.0 — Commercial Quotes Kanban Board
-- Implements a Trello-style Kanban board for commercial policies (GL, WC, UMB, etc.)
-- Columns: Quote Intake, Quoting, Price Sent, Sold, Not Sold,
--          Commission Approved, Commission Not Approved, To Do, Archive
--
-- Features:
--   - Cards with agent assignment, risk level, custom status, coverage type
--   - Comment threads per card (activity log)
--   - File attachments per card (stored in Supabase Storage)
--   - Checklists with items per card
--   - Time tracking (time in list, time on board)
--   - RLS: agents see only own cards, managers + commercial role see all (mirrored view)

-- ═══════════════════════════════════════════════════════════════════════════════
-- 0. Add 'commercial' role to app_role enum
-- ═══════════════════════════════════════════════════════════════════════════════
alter type public.app_role add value if not exists 'commercial';

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. COMMERCIAL QUOTES TABLE (the "cards")
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.commercial_quotes (
  id uuid primary key default gen_random_uuid(),

  -- Card identity
  business_name varchar(250) not null,
  description text,

  -- Board column (Kanban list)
  board_column text not null default 'quote_intake' check (board_column in (
    'quote_intake', 'quoting', 'price_sent', 'sold', 'not_sold',
    'commission_approved', 'commission_not_approved', 'to_do', 'archive'
  )),

  -- Position within column (for ordering / drag-drop)
  column_position integer not null default 0,

  -- Custom fields (matching Trello card)
  risk_level text not null default 'medium' check (risk_level in ('low', 'medium', 'high')),
  card_status text not null default 'in_progress' check (card_status in ('in_progress', 'done', 'blocked', 'waiting')),
  policy_number varchar(50),
  coverage_type text check (coverage_type is null or coverage_type in (
    'gl', 'wc', 'umb', 'gl_wc', 'gl_wc_umb', 'bop', 'commercial_auto', 'other'
  )),
  coverage_type_other varchar(100),

  -- Agent assignment (who owns this card)
  assigned_to uuid not null references public.profiles(id),

  -- Mirroring: when true, this card appears in the manager/commercial overview
  is_mirrored boolean not null default true,

  -- Time tracking
  column_entered_at timestamptz not null default now(),
  board_entered_at timestamptz not null default now(),

  -- Timestamps
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,

  -- Constraints
  constraint commercial_quotes_business_name_not_empty
    check (char_length(trim(business_name)) > 0)
);

-- Indexes
create index if not exists idx_commercial_quotes_assigned_to
  on public.commercial_quotes(assigned_to);

create index if not exists idx_commercial_quotes_board_column
  on public.commercial_quotes(board_column, column_position);

create index if not exists idx_commercial_quotes_active
  on public.commercial_quotes(assigned_to, board_column)
  where board_column != 'archive';

-- Updated_at trigger
drop trigger if exists commercial_quotes_touch_updated_at on public.commercial_quotes;
create trigger commercial_quotes_touch_updated_at
  before update on public.commercial_quotes
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. COMMERCIAL QUOTE COMMENTS (activity log / comment thread)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.commercial_quote_comments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.commercial_quotes(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  content text not null check (char_length(trim(content)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_commercial_quote_comments_quote
  on public.commercial_quote_comments(quote_id, created_at desc);

drop trigger if exists commercial_quote_comments_touch_updated_at on public.commercial_quote_comments;
create trigger commercial_quote_comments_touch_updated_at
  before update on public.commercial_quote_comments
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. COMMERCIAL QUOTE ATTACHMENTS (file references in Supabase Storage)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.commercial_quote_attachments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.commercial_quotes(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id),
  file_name varchar(255) not null,
  file_size bigint not null check (file_size > 0),
  mime_type varchar(100) not null,
  storage_path text not null,  -- path within Supabase Storage bucket
  created_at timestamptz not null default now()
);

create index if not exists idx_commercial_quote_attachments_quote
  on public.commercial_quote_attachments(quote_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. COMMERCIAL QUOTE CHECKLISTS
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.commercial_quote_checklists (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.commercial_quotes(id) on delete cascade,
  title varchar(200) not null default 'Checklist',
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_commercial_quote_checklists_quote
  on public.commercial_quote_checklists(quote_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. COMMERCIAL QUOTE CHECKLIST ITEMS
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.commercial_quote_checklist_items (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references public.commercial_quote_checklists(id) on delete cascade,
  label varchar(300) not null check (char_length(trim(label)) > 0),
  is_checked boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_commercial_checklist_items_checklist
  on public.commercial_quote_checklist_items(checklist_id, position);

drop trigger if exists commercial_checklist_items_touch_updated_at on public.commercial_quote_checklist_items;
create trigger commercial_checklist_items_touch_updated_at
  before update on public.commercial_quote_checklist_items
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. COLUMN MOVE HISTORY (for time-in-list tracking)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.commercial_quote_column_history (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.commercial_quotes(id) on delete cascade,
  from_column text,
  to_column text not null,
  moved_by uuid not null references public.profiles(id),
  moved_at timestamptz not null default now()
);

create index if not exists idx_commercial_column_history_quote
  on public.commercial_quote_column_history(quote_id, moved_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. SUPABASE STORAGE BUCKET for commercial attachments
-- ═══════════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public, file_size_limit)
values ('commercial-quote-attachments', 'commercial-quote-attachments', false, 104857600)
on conflict (id) do update
set public = false,
    file_size_limit = 104857600;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. ROW LEVEL SECURITY — Commercial Quotes
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.commercial_quotes enable row level security;

-- Commercial agents: can only see and update their own cards
create policy "commercial_agent_select" on public.commercial_quotes
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'commercial'
    and assigned_to = auth.uid()
  );

create policy "commercial_agent_insert" on public.commercial_quotes
  for insert to authenticated
  with check (
    (select role from public.profiles where id = auth.uid()) = 'commercial'
    and assigned_to = auth.uid()
  );

create policy "commercial_agent_update" on public.commercial_quotes
  for update to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'commercial'
    and assigned_to = auth.uid()
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'commercial'
    and assigned_to = auth.uid()
  );

-- Managers: full CRUD on all commercial quotes (mirrored view)
create policy "manager_commercial_all" on public.commercial_quotes
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. ROW LEVEL SECURITY — Comments
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.commercial_quote_comments enable row level security;

-- Commercial agents: can see comments on their own cards, insert comments on own cards
create policy "commercial_comments_select" on public.commercial_quote_comments
  for select to authenticated
  using (
    exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_comments.quote_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

create policy "commercial_comments_insert" on public.commercial_quote_comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_comments.quote_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

-- Managers can also update/delete any comment
create policy "manager_comments_all" on public.commercial_quote_comments
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. ROW LEVEL SECURITY — Attachments
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.commercial_quote_attachments enable row level security;

create policy "commercial_attachments_select" on public.commercial_quote_attachments
  for select to authenticated
  using (
    exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_attachments.quote_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

create policy "commercial_attachments_insert" on public.commercial_quote_attachments
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_attachments.quote_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

create policy "commercial_attachments_delete" on public.commercial_quote_attachments
  for delete to authenticated
  using (
    uploaded_by = auth.uid()
    or (select role from public.profiles where id = auth.uid()) = 'manager'
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. ROW LEVEL SECURITY — Checklists & Items
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.commercial_quote_checklists enable row level security;
alter table public.commercial_quote_checklist_items enable row level security;

create policy "commercial_checklists_select" on public.commercial_quote_checklists
  for select to authenticated
  using (
    exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_checklists.quote_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

create policy "commercial_checklists_insert" on public.commercial_quote_checklists
  for insert to authenticated
  with check (
    exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_checklists.quote_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

create policy "commercial_checklists_delete" on public.commercial_quote_checklists
  for delete to authenticated
  using (
    exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_checklists.quote_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

create policy "commercial_checklist_items_select" on public.commercial_quote_checklist_items
  for select to authenticated
  using (
    exists (
      select 1 from public.commercial_quote_checklists cl
      join public.commercial_quotes cq on cq.id = cl.quote_id
      where cl.id = commercial_quote_checklist_items.checklist_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

create policy "commercial_checklist_items_insert" on public.commercial_quote_checklist_items
  for insert to authenticated
  with check (
    exists (
      select 1 from public.commercial_quote_checklists cl
      join public.commercial_quotes cq on cq.id = cl.quote_id
      where cl.id = commercial_quote_checklist_items.checklist_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

create policy "commercial_checklist_items_update" on public.commercial_quote_checklist_items
  for update to authenticated
  using (
    exists (
      select 1 from public.commercial_quote_checklists cl
      join public.commercial_quotes cq on cq.id = cl.quote_id
      where cl.id = commercial_quote_checklist_items.checklist_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  )
  with check (
    exists (
      select 1 from public.commercial_quote_checklists cl
      join public.commercial_quotes cq on cq.id = cl.quote_id
      where cl.id = commercial_quote_checklist_items.checklist_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

create policy "commercial_checklist_items_delete" on public.commercial_quote_checklist_items
  for delete to authenticated
  using (
    exists (
      select 1 from public.commercial_quote_checklists cl
      join public.commercial_quotes cq on cq.id = cl.quote_id
      where cl.id = commercial_quote_checklist_items.checklist_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. ROW LEVEL SECURITY — Column History
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.commercial_quote_column_history enable row level security;

create policy "commercial_column_history_select" on public.commercial_quote_column_history
  for select to authenticated
  using (
    exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_column_history.quote_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

create policy "commercial_column_history_insert" on public.commercial_quote_column_history
  for insert to authenticated
  with check (
    moved_by = auth.uid()
    and exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_column_history.quote_id
        and (
          (cq.assigned_to = auth.uid() and (select role from public.profiles where id = auth.uid()) = 'commercial')
          or (select role from public.profiles where id = auth.uid()) = 'manager'
        )
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 13. STORAGE POLICIES for commercial-quote-attachments bucket
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "commercial_storage_select" on storage.objects;
create policy "commercial_storage_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'commercial-quote-attachments'
    and (
      (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager')
    )
  );

drop policy if exists "commercial_storage_insert" on storage.objects;
create policy "commercial_storage_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'commercial-quote-attachments'
    and (
      (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager')
    )
  );

drop policy if exists "commercial_storage_delete" on storage.objects;
create policy "commercial_storage_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'commercial-quote-attachments'
    and (
      (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager')
    )
  );

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
select 'commercial_quotes' as tbl, count(*) as policies
from pg_policies where tablename = 'commercial_quotes'
union all
select 'commercial_quote_comments', count(*)
from pg_policies where tablename = 'commercial_quote_comments'
union all
select 'commercial_quote_attachments', count(*)
from pg_policies where tablename = 'commercial_quote_attachments'
union all
select 'commercial_quote_checklists', count(*)
from pg_policies where tablename = 'commercial_quote_checklists'
union all
select 'commercial_quote_checklist_items', count(*)
from pg_policies where tablename = 'commercial_quote_checklist_items'
union all
select 'commercial_quote_column_history', count(*)
from pg_policies where tablename = 'commercial_quote_column_history';

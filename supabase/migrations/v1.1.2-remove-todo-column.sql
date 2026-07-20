-- New Hope Work Desk v1.1.2 — Remove 'to_do' column from commercial board
-- The To Do column has been removed from the workflow.
-- Any existing cards in 'to_do' are moved to 'quote_intake'.

begin;

-- Move any existing to_do cards to quote_intake
update public.commercial_quotes
set board_column = 'quote_intake',
    column_entered_at = now()
where board_column = 'to_do';

-- Drop the old CHECK constraint and create a new one without 'to_do'
alter table public.commercial_quotes
  drop constraint if exists commercial_quotes_board_column_check;

alter table public.commercial_quotes
  add constraint commercial_quotes_board_column_check
  check (board_column in (
    'quote_intake', 'quoting', 'price_sent', 'sold', 'not_sold',
    'commission_approved', 'commission_not_approved', 'archive'
  ));

commit;

select 'to_do column removed, constraint updated' as status;

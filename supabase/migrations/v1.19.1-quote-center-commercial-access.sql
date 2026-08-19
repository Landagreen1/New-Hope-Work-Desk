-- v1.19.1 — Grant Quote Center access to commercial roles
--
-- Commercial agents sometimes need to look up customer quote journeys to
-- support customers. This migration adds 'commercial' and
-- 'commercial_supervisor' to the can_view_quote_center() gate so the
-- quote_center_search and related RPCs allow them through.
--
-- Mirrors the client-side change in src/features/quote-center/permissions.ts
-- where QUOTE_ROLES now includes both commercial roles.

create or replace function public.can_view_quote_center()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_active
      and p.role::text in (
        'agent',
        'manager',
        'customer_service',
        'commercial',
        'commercial_supervisor',
        'super_admin',
        'sales_supervisor',
        'customer_service_supervisor'
      )
  );
$fn$;

comment on function public.can_view_quote_center() is
  'Mirrors viewQuoteCenter in src/features/quote-center/permissions.ts. This function is the enforcing check; the client helper only decides whether to render the screen.';

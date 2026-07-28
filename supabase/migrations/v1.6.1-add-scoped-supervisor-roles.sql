-- v1.6.1 — Scoped supervisor roles
-- Enum additions must commit before later migrations reference the new values.

alter type public.app_role add value if not exists 'commercial_supervisor';
alter type public.app_role add value if not exists 'customer_service_supervisor';
alter type public.app_role add value if not exists 'sales_supervisor';

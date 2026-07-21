-- v1.4.1 — Add HawkSoft-sourced fields to renewal_records
-- Additive: no existing columns are modified or dropped.

alter table public.renewal_records
  add column if not exists customer_state text,
  add column if not exists customer_zip text,
  add column if not exists client_since date,
  add column if not exists client_office text,
  add column if not exists client_source text,
  add column if not exists producer_name text,
  add column if not exists csr_name text,
  add column if not exists policy_status text,
  add column if not exists effective_date date,
  add column if not exists expiration_date date,
  add column if not exists inception_date date,
  add column if not exists sold_date date,
  add column if not exists application_type text,
  add column if not exists policy_office text,
  add column if not exists annual_premium numeric(12,2);

comment on column public.renewal_records.customer_state is 'Mailing state from HawkSoft export.';
comment on column public.renewal_records.customer_zip is 'Mailing zip from HawkSoft export.';
comment on column public.renewal_records.client_since is 'Client Since date — how long they have been a customer.';
comment on column public.renewal_records.client_office is 'Office the client belongs to (e.g., 1 - Gastonia).';
comment on column public.renewal_records.client_source is 'How the client was acquired (referral, walk-in, etc.).';
comment on column public.renewal_records.producer_name is 'Producer/agent who originally sold the policy.';
comment on column public.renewal_records.csr_name is 'CSR assigned to the client in HawkSoft.';
comment on column public.renewal_records.policy_status is 'HawkSoft policy status (Active, Renewal, Cancelled, etc.).';
comment on column public.renewal_records.effective_date is 'Current policy effective date.';
comment on column public.renewal_records.expiration_date is 'Policy expiration date (same as renewal_date in most cases).';
comment on column public.renewal_records.inception_date is 'Original policy inception date.';
comment on column public.renewal_records.sold_date is 'Date the policy was originally sold.';
comment on column public.renewal_records.application_type is 'Personal or Commercial.';
comment on column public.renewal_records.policy_office is 'Office the policy is managed under.';
comment on column public.renewal_records.annual_premium is 'Annual Premium + Fees from HawkSoft.';

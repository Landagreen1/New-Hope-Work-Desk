-- Read-only report of what v1.11.1 currently surfaces to a Manager.
-- Impersonates a manager via request.jwt.claims so auth.uid() resolves.
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (select id from public.profiles where username = 'danielp'),
    'role', 'authenticated'
  )::text,
  false
) as impersonating;

select
  alert_kind,
  count(*) as rows,
  min(elapsed_minutes) as min_minutes,
  max(elapsed_minutes) as max_minutes
from public.manager_sla_alerts()
group by alert_kind
order by alert_kind;

select alert_kind, customer_name, agent_name, detail, elapsed_minutes, occurred_at
from public.manager_sla_alerts()
order by occurred_at desc
limit 10;

CREATE OR REPLACE FUNCTION public.current_business_date()
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select (now() at time zone 'America/New_York')::date;
$function$


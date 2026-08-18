-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.17.4 — Add Medical Payments Limit question to JSA
--
-- Medical Payments is not collected on the standard CS intake, so it is asked
-- as a JSA-specific supplemental question.
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.market_questions (market_id, line_of_business, question_text, field_type, is_required, sort_order, auto_fill_source)
select md.id, 'trucking', q.question_text, q.field_type, q.is_required, q.sort_order, q.auto_fill_source
from public.market_directory md
cross join (values
  ('Medical Payments Limit', 'text', false, 18, null),
  ('General Liability Limit', 'text', false, 19, null),
  ('Trailer Interchange Limit', 'text', false, 20, null),
  ('UM/UIM Limit', 'text', false, 21, null)
) as q(question_text, field_type, is_required, sort_order, auto_fill_source)
where md.name = 'JSA'
on conflict do nothing;

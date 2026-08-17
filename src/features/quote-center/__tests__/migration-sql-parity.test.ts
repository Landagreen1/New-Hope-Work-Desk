/**
 * Structural guards on the Quote Center migrations.
 *
 * Several of this feature's guarantees live only in SQL — the journey collapse, the
 * concurrency check, the completion-attribution fallback, the append-only note
 * logs. A TypeScript test cannot prove their runtime behaviour; only a database
 * can, and those results are recorded in the change summary. What these assertions
 * do catch is the specific way such a guarantee gets lost: someone edits the
 * migration later and quietly drops the predicate that made it true.
 *
 * Written in the same style as
 * src/features/rotation/__tests__/migration-sql-parity.test.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const MIGRATIONS = path.resolve(__dirname, '../../../../supabase/migrations');

function read(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS, name), 'utf-8');
}

/** Strip `--` line comments so prose explaining a rule cannot satisfy a match. */
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function code(name: string): string {
  return stripComments(read(name)).replace(/\s+/g, ' ').trim().toLowerCase();
}

const sharedDrafts = code('v1.15.0-quote-center-shared-drafts.sql');
const sharedNotes = code('v1.15.1-quote-center-shared-notes.sql');
const search = code('v1.15.2-quote-center-search.sql');
const attribution = code('v1.15.3-intake-completion-attribution.sql');

const ALL = [
  ['v1.15.0', sharedDrafts],
  ['v1.15.1', sharedNotes],
  ['v1.15.2', search],
  ['v1.15.3', attribution],
] as const;

describe('migration safety', () => {
  it('never deletes production rows', () => {
    for (const [name, sql] of ALL) {
      // A migration in this feature is a read model and additive columns. Any
      // delete or truncate against a lifecycle table would be a data loss bug.
      expect(sql, name).not.toMatch(/truncate/);
      expect(sql, name).not.toMatch(/drop table/);
      expect(sql, name).not.toMatch(/delete from public\.cs_intake_submissions/);
      expect(sql, name).not.toMatch(/delete from public\.work_items/);
      expect(sql, name).not.toMatch(/delete from public\.quote_outcomes/);
      expect(sql, name).not.toMatch(/delete from public\.quote_notes/);
    }
  });

  it('adds every new column defensively so a re-run is safe', () => {
    const additions = sharedDrafts.match(/add column/g) ?? [];
    const guarded = sharedDrafts.match(/add column if not exists/g) ?? [];
    expect(additions.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(additions.length);
  });

  it('wraps each migration in a transaction', () => {
    for (const [name, sql] of ALL) {
      expect(sql.startsWith('begin;'), name).toBe(true);
      expect(sql.trimEnd().endsWith('commit;'), name).toBe(true);
    }
  });

  it('never casts a status literal to the intake enum in an index predicate without the enum type', () => {
    // public.cs_intake_status has no 'deleted' label, and an enum-to-text cast is
    // only STABLE so it cannot appear in an index predicate. The one partial index
    // on status must therefore name the enum type explicitly.
    const predicate = sharedDrafts.match(/where status in \([^)]*\)/);
    expect(predicate).not.toBeNull();
    expect(predicate![0]).toContain('::public.cs_intake_status');
  });
});

describe('the intake to quote link', () => {
  it('adds source_work_item_id with no foreign key', () => {
    // A foreign key is precisely what broke work_item_id: `on delete set null`
    // nulled it on every row as quotes advanced out of work_items. The comment in
    // the migration explains it; this asserts the code matches.
    expect(sharedDrafts).toMatch(/add column if not exists source_work_item_id uuid[,\s]/);
    expect(sharedDrafts).not.toMatch(
      /source_work_item_id uuid references public\.work_items/,
    );
  });

  it('backfills the link from the event log, only where it is still missing', () => {
    expect(sharedDrafts).toContain("e.event_type = 'converted'");
    expect(sharedDrafts).toContain("e.detail ->> 'work_item_id'");
    expect(sharedDrafts).toContain('s.source_work_item_id is null');
  });

  it('has cs_intake_convert write the durable link as well as the legacy column', () => {
    expect(sharedDrafts).toMatch(/set status = 'converted', work_item_id = v_work_item_id/);
    expect(sharedDrafts).toMatch(/source_work_item_id = v_work_item_id/);
  });
});

describe('concurrency-safe saves', () => {
  it('locks the row before testing the version', () => {
    const fn = sharedDrafts.slice(sharedDrafts.indexOf('function public.cs_intake_save_draft'));
    const lockAt = fn.indexOf('for update');
    const versionTestAt = fn.indexOf('p_expected_version <> v_row.version');
    expect(lockAt).toBeGreaterThan(-1);
    expect(versionTestAt).toBeGreaterThan(-1);
    // Testing the version before taking the lock would let two saves both pass.
    expect(lockAt).toBeLessThan(versionTestAt);
  });

  it('raises a serialization-failure code the client can recognise', () => {
    expect(sharedDrafts).toContain("using errcode = '40001'");
    expect(sharedDrafts).toContain('was updated by another employee');
  });

  it('bumps the version and records the editor on every save', () => {
    expect(sharedDrafts).toMatch(/set version = version \+ 1, last_edited_by = v_actor/);
  });

  it('writes an audit event carrying the changed fields', () => {
    // The timeline reads changed_fields, which is why a single mutable notes column
    // could never have served as the draft history.
    expect(sharedDrafts).toContain("'draft_updated'");
    expect(sharedDrafts).toContain("'changed_fields', v_changed");
  });

  it('refuses to rewrite an intake that already produced a quote', () => {
    expect(sharedDrafts).toMatch(
      /v_row\.source_work_item_id is not null and v_row\.status::text not in \('draft', 'returned'\)/,
    );
  });

  it('protects the columns the database owns from being set by a payload', () => {
    for (const column of [
      "'status'",
      "'created_by'",
      "'completed_by'",
      "'version'",
      "'source_work_item_id'",
      "'claimed_by'",
    ]) {
      expect(sharedDrafts, column).toContain(column);
    }
    expect(sharedDrafts).toContain('c_protected');
  });

  it('inserts child rows with explicit column lists', () => {
    // cs_intake_drivers, _vehicles and _owners all have NOT NULL columns with
    // defaults. Expanding a record populated from a null base would write NULL over
    // each default instead of letting it apply.
    expect(sharedDrafts).toMatch(/insert into public\.cs_intake_drivers \(\s*submission_id, position/);
    expect(sharedDrafts).toMatch(/insert into public\.cs_intake_vehicles \(\s*submission_id, position/);
    expect(sharedDrafts).toMatch(/insert into public\.cs_intake_owners \(\s*submission_id, position/);
  });
});

describe('completion attribution', () => {
  it('records completed_by in the same guarded update that sets the status', () => {
    const submit = sharedDrafts.slice(sharedDrafts.indexOf('function public.cs_intake_submit'));
    const update = submit.slice(submit.indexOf("set status = 'submitted'"));
    expect(update).toContain('completed_by = v_actor');
    expect(update).toContain('version = version + 1');
    // The status predicate is what makes a double submission fail closed rather
    // than award completion credit twice.
    expect(update).toContain("status::text in ('draft', 'returned')");
  });

  it('credits completion with a fallback to the starter for historical rows', () => {
    expect(attribution).toContain('coalesce(s.completed_by, s.created_by)');
  });

  it('never backfills completed_by, which would move historical totals', () => {
    expect(attribution).not.toMatch(/update public\.cs_intake_submissions\s+set completed_by/);
    expect(sharedDrafts).not.toMatch(/set completed_by = created_by/);
  });

  it('counts drafts started on created_by, separately from completions', () => {
    expect(attribution).toContain('s.created_by as profile_id');
    expect(attribution).toContain('drafts_started');
    expect(attribution).toContain('intakes_completed');
  });

  it('only counts a completion when the intake was actually submitted', () => {
    // An unfinished draft must never be reported as a completed intake.
    expect(attribution).toContain('s.submitted_at is not null');
  });
});

describe('shared notes', () => {
  it('adds no ownership test to add_quote_note', () => {
    const fn = sharedNotes.slice(sharedNotes.indexOf('function public.add_quote_note'));
    expect(fn).not.toContain('assigned_profile_id = auth.uid()');
  });

  it('includes super admin and both relevant supervisors in the note role list', () => {
    const fn = sharedNotes.slice(sharedNotes.indexOf('function public.add_quote_note'));
    for (const role of [
      "'agent'",
      "'manager'",
      "'customer_service'",
      "'super_admin'",
      "'sales_supervisor'",
      "'customer_service_supervisor'",
    ]) {
      expect(fn, role).toContain(role);
    }
  });

  it('gates intake notes on read access rather than ownership', () => {
    const fn = sharedNotes.slice(sharedNotes.indexOf('function public.cs_intake_add_note'));
    expect(fn).toContain('public.can_read_cs_intake');
    expect(fn).not.toContain('created_by = auth.uid()');
  });

  it('adds no update or delete policy to the append-only event log', () => {
    for (const [name, sql] of ALL) {
      expect(sql, name).not.toMatch(/create policy [^;]*on public\.cs_intake_events for update/);
      expect(sql, name).not.toMatch(/create policy [^;]*on public\.cs_intake_events for delete/);
    }
  });
});

describe('shared draft access', () => {
  it('lets quote-related roles read every stage', () => {
    const fn = search + sharedDrafts;
    const readFn = sharedDrafts.slice(sharedDrafts.indexOf('function public.can_read_cs_intake'));
    for (const role of [
      "'agent'",
      "'customer_service'",
      "'sales_supervisor'",
      "'customer_service_supervisor'",
    ]) {
      expect(readFn, role).toContain(role);
    }
    expect(fn).toBeTruthy();
  });

  it('keeps commercial roles limited to their own records', () => {
    const readFn = sharedDrafts.slice(sharedDrafts.indexOf('function public.can_read_cs_intake'));
    expect(readFn).toMatch(
      /p\.role::text in \('commercial', 'commercial_supervisor'\) and s\.created_by = auth\.uid\(\)/,
    );
  });

  it('limits the shared edit grant to unfinished statuses', () => {
    const editFn = sharedDrafts.slice(sharedDrafts.indexOf('function public.can_edit_cs_intake'));
    expect(editFn).toContain("s.status::text in ('draft', 'returned')");
  });

  it('replaces the wide-open owners policy rather than leaving it', () => {
    // v1.9.9 shipped `using (true)` on all four verbs, exposing business-owner PII
    // to any authenticated user.
    expect(sharedDrafts).toContain('drop policy if exists "authenticated users can select owners"');
    expect(sharedDrafts).toMatch(
      /create policy "cs_intake_owners_select"[^;]*using \(public\.can_read_cs_intake\(submission_id\)\)/,
    );
  });
});

describe('the journey read model', () => {
  it('collapses each quote identity to its furthest stage', () => {
    expect(search).toContain('select distinct on (t.source_work_item_id)');
    expect(search).toContain('order by t.source_work_item_id, t.stage_rank desc');
  });

  it('ranks the three lifecycle tables in lifecycle order', () => {
    // work_items = 1, pending_pricing_quotes = 2, quote_outcomes = 3, so the
    // furthest table a quote still appears in wins.
    expect(search).toMatch(/1 as stage_rank/);
    expect(search).toContain('from public.work_items w');
    expect(search).toContain('from public.pending_pricing_quotes p');
    expect(search).toContain('from public.quote_outcomes o');
  });

  it('excludes workload work types from the quote model', () => {
    // work_items also holds activations, changes, payments and WhatsApp updates.
    expect(search).toContain("w.work_type::text in ('new_quote', 'requote')");
  });

  it('suppresses the quote-only row for a journey that has an intake', () => {
    // This NOT EXISTS is the other half of the collapse: without it a converted
    // intake would appear once as an intake and again as its own quote.
    expect(search).toMatch(
      /where not exists \( select 1 from public\.cs_intake_submissions s2 where coalesce\(s2\.source_work_item_id, s2\.work_item_id\) = st\.source_work_item_id \)/,
    );
  });

  it('lowercases the decision so the stray capitalised enum label cannot slip through', () => {
    expect(search).toContain("lower(o.decision::text) = 'sold'");
  });

  it('normalises stages into the five the employee sees', () => {
    for (const stage of ["'intake'", "'working'", "'price_sent'", "'closed'"]) {
      expect(search, stage).toContain(stage);
    }
    expect(search).toContain('draft — needs information');
    expect(search).toContain('waiting to be taken');
  });
});

describe('search behaviour', () => {
  it('normalises phone numbers with an immutable function so an index can use it', () => {
    expect(search).toMatch(/function public\.nhwd_digits\(p_text text\) returns text language sql immutable/);
    // An index on a function expression only builds if the function is IMMUTABLE,
    // so this index existing is what proves the two must stay in step.
    expect(search).toContain(
      'on public.cs_intake_submissions (public.nhwd_digits(insured_phone_primary))',
    );
  });

  it('escapes user input before using it as a pattern', () => {
    // A customer whose name contains % must be searched literally.
    expect(search).toMatch(/function public\.nhwd_like_pattern/);
    expect(search).toContain("replace(replace(replace(coalesce(p_text, ''), '\\', '\\\\'), '%', '\\%'), '_', '\\_')");
    expect(search).toContain("escape '\\'");
  });

  it('refuses to treat a short digit string as a phone number', () => {
    // Fewer than seven digits is an address or a policy fragment; matching on it
    // would return most of the agency.
    expect(search).toContain('if length(v_digits) < 7 then');
  });

  it('pages on the server and caps the page size', () => {
    expect(search).toContain('least(greatest(coalesce(p_limit, 25), 1), 100)');
    expect(search).toContain('limit v_limit');
    expect(search).toContain('offset v_offset');
    expect(search).toContain('count(*) over () as total_count');
  });

  it('installs the trigram extension it depends on', () => {
    expect(search).toContain('create extension if not exists pg_trgm');
  });

  it('gates every entry point on the role check', () => {
    for (const fn of [
      'quote_center_search',
      'quote_center_stage_counts',
      'quote_center_journey',
      'quote_center_timeline',
      'quote_center_duplicate_check',
    ]) {
      const body = search.slice(search.indexOf(`function public.${fn}`));
      expect(body.slice(0, 4000), fn).toContain('public.can_view_quote_center()');
    }
  });

  it('keeps the underlying views out of reach of the client', () => {
    // The views bypass RLS by design, so access has to go through the
    // security-definer functions that apply the role gate.
    expect(search).toContain('revoke all on public.quote_center_journeys from authenticated, anon');
    expect(search).toContain('revoke all on public.quote_center_quote_stage from authenticated, anon');
  });

  it('excludes commercial roles from the Quote Center gate', () => {
    const gate = search.slice(search.indexOf('function public.can_view_quote_center'));
    const body = gate.slice(0, 1200);
    expect(body).toContain("'agent'");
    expect(body).toContain("'customer_service'");
    expect(body).not.toContain("'commercial'");
  });
});

describe('duplicate detection', () => {
  it('never matches on a first name alone', () => {
    const fn = search.slice(search.indexOf('function public.quote_center_duplicate_check'));
    // A name pair is allowed; a single name is not, because two people sharing a
    // name is common and is not a duplicate.
    expect(fn).toContain('v_first is not null and v_last is not null');
  });

  it('requires a full ten digits before treating a phone as an identity signal', () => {
    const fn = search.slice(search.indexOf('function public.quote_center_duplicate_check'));
    expect(fn).toContain('if length(v_phone_digits) < 10 then');
  });

  it('returns nothing when no identifying detail has been entered yet', () => {
    const fn = search.slice(search.indexOf('function public.quote_center_duplicate_check'));
    expect(fn).toMatch(/v_phone_digits is null and v_email is null/);
  });

  it('explains why each candidate was surfaced', () => {
    const fn = search.slice(search.indexOf('function public.quote_center_duplicate_check'));
    expect(fn).toContain('match_reason');
    expect(fn).toContain("'same phone number'");
  });

  it('never merges anything', () => {
    // Merging is a manager workflow with human review; the check only surfaces.
    for (const [name, sql] of ALL) {
      expect(sql, name).not.toContain('merge_quote_records');
    }
  });
});

describe('queue rules are untouched', () => {
  it('does not write rotation state or turn events', () => {
    // Quote Center is a lookup layer. Nothing in this feature may consume a turn.
    for (const [name, sql] of ALL) {
      expect(sql, name).not.toMatch(/update public\.rotation_state/);
      expect(sql, name).not.toMatch(/insert into public\.turn_events/);
      expect(sql, name).not.toContain('next_eligible_profile');
    }
  });

  it('leaves the claim and pass functions alone', () => {
    for (const [name, sql] of ALL) {
      for (const fn of [
        'claim_whatsapp_quote',
        'claim_ringcentral_quote',
        'cs_intake_claim_ringcentral',
        'pass_my_turn',
        'claim_linked_workload_turn',
        'claim_unlinked_workload_turn',
      ]) {
        expect(sql, `${name} redefines ${fn}`).not.toContain(`function public.${fn}`);
      }
    }
  });
});

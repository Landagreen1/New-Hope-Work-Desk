/**
 * Parity between the TypeScript vocabulary and the SQL that enforces it, plus the
 * structural guarantees the migrations claim to make.
 *
 * The vocabularies in `../status.ts` exist so a screen can render a stage or a carrier
 * status without a round trip. That only works while they match the CHECK constraints,
 * and nothing but a test will notice when they stop matching — a value the browser
 * offers but the database refuses is a runtime error in front of a customer.
 *
 * The structural assertions are the ones worth reading. Each names an architectural
 * commitment from the spec and checks that the migration actually made it, rather than
 * trusting a comment. They read the migration files as text on purpose: the same
 * conditions are asserted inside the migrations' own post-condition blocks, so this
 * suite is the second, independent statement of them.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CARRIER_STATUS_ORDER,
  DOCUMENT_CATEGORIES,
  LOST_REASONS,
  PRICE_METHODS,
  STAGE_ORDER,
  normalizedLifecycleStatus,
} from '../status';
import type { SpecialtyStage } from '../types';

const MIGRATIONS = path.join(process.cwd(), 'supabase', 'migrations');

function sql(file: string): string {
  return readFileSync(path.join(MIGRATIONS, file), 'utf8');
}

const TEAMS = sql('v1.16.0-specialty-quoting-teams.sql');
const CORE = sql('v1.16.1-specialty-opportunities.sql');
const MUTATIONS = sql('v1.16.2-specialty-mutations.sql');
const READS = sql('v1.16.3-specialty-reads.sql');
const REPORTS = sql('v1.16.4-specialty-reports.sql');
const ROUTING = sql('v1.16.5-specialty-intake-routing.sql');
const LEGACY = sql('v1.16.6-specialty-legacy-adoption.sql');

const ALL = [TEAMS, CORE, MUTATIONS, READS, REPORTS, ROUTING, LEGACY].join('\n');

/** Pulls the quoted values out of the first `check (col in (...))` list for a column. */
function checkValues(source: string, column: string): string[] {
  const pattern = new RegExp(`${column}[^;]*?check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`, 'is');
  const match = pattern.exec(source);
  if (!match) throw new Error(`No check constraint found for ${column}`);
  return Array.from(match[1].matchAll(/'([^']+)'/g)).map((entry) => entry[1]);
}

describe('stage vocabulary', () => {
  it('matches the opportunity stage CHECK constraint exactly', () => {
    expect([...STAGE_ORDER].sort()).toEqual([...checkValues(CORE, 'stage')].sort());
  });

  it('is seeded for both initial templates, nine stages each', () => {
    for (const stage of STAGE_ORDER) {
      expect(TEAMS).toContain(`('${stage}',`);
    }
    // The seed asserts its own stage count, so a partial seed rolls the migration back.
    expect(TEAMS).toContain('18 template stage rows');
  });

  it('marks Sold and Not Sold terminal, and nothing else', () => {
    // The seed's last column per row is is_terminal.
    expect(TEAMS).toMatch(/\('sold',\s*'Sold',\s*8,\s*false,\s*true\)/);
    expect(TEAMS).toMatch(/\('not_sold',\s*'Not Sold',\s*9,\s*false,\s*true\)/);
    expect(TEAMS).toMatch(/\('marketing',\s*'Marketing',\s*4,\s*false,\s*false\)/);
  });

  it('requires a next action on Follow-Up and Information Needed', () => {
    expect(TEAMS).toMatch(/\('follow_up',\s*'Follow-Up',\s*7,\s*true,/);
    expect(TEAMS).toMatch(/\('information_needed',\s*'Information Needed',\s*2,\s*true,/);
  });

  it('normalizes every stage onto the label the SQL emits for Quote Center', () => {
    // Both the view overlay and specialty_cs_status carry the same CASE; the TS mirror
    // must agree with both, or a customer's status would read differently depending on
    // which surface asked.
    const expected: Record<SpecialtyStage, string> = {
      new: 'Submitted to Specialty Team',
      information_needed: 'Information Needed',
      ready_to_market: 'Being Quoted',
      marketing: 'Being Quoted',
      options_ready: 'Options Ready',
      price_sent: 'Price Sent',
      follow_up: 'Customer Follow-Up',
      sold: 'Sold',
      not_sold: 'Not Sold',
    };
    for (const stage of STAGE_ORDER) {
      expect(normalizedLifecycleStatus(stage)).toBe(expected[stage]);
      expect(ROUTING).toContain(`'${expected[stage]}'`);
    }
  });

  it('maps the nine stages onto Quote Center\u2019s four buckets in the view', () => {
    expect(ROUTING).toMatch(
      /when o\.stage in \('new', 'information_needed', 'ready_to_market',\s*'marketing', 'options_ready'\) then 'working'/,
    );
    expect(ROUTING).toContain("when o.stage in ('price_sent', 'follow_up') then 'price_sent'");
    expect(ROUTING).toContain("else 'closed'");
  });
});

describe('other vocabularies match their CHECK constraints', () => {
  it('carrier market statuses', () => {
    expect([...CARRIER_STATUS_ORDER].sort()).toEqual([...checkValues(CORE, 'status')].sort());
  });

  it('lost reasons', () => {
    expect([...LOST_REASONS].sort()).toEqual([...checkValues(CORE, 'lost_reason')].sort());
  });

  it('document categories', () => {
    expect([...DOCUMENT_CATEGORIES].sort()).toEqual([...checkValues(CORE, 'category')].sort());
  });

  it('price delivery methods', () => {
    expect([...PRICE_METHODS].sort()).toEqual([...checkValues(CORE, 'method')].sort());
  });
});

describe('assignment is never the access boundary', () => {
  /**
   * The single most important structural guarantee. If any RLS policy on a specialty
   * table gates on the primary assignee, the engine has reverted to the model it was
   * built to replace, and Oscar can no longer help with Jason's quote.
   */
  it('no specialty policy gates on primary_assignee_id = auth.uid()', () => {
    const policyBlocks = CORE.match(/create policy specialty[\s\S]*?;/g) ?? [];
    expect(policyBlocks.length).toBeGreaterThan(15);
    for (const block of policyBlocks) {
      expect(block).not.toContain('primary_assignee_id = auth.uid()');
    }
  });

  it('the migration asserts that for itself, so a later change cannot slip past', () => {
    expect(CORE).toContain("like '%primary_assignee_id = auth.uid()%'");
    expect(CORE).toContain('wrote assignee-gated policy(ies)');
  });

  it('read and write access are decided by the team helpers', () => {
    expect(CORE).toContain('specialty_can_view_opportunity(id)');
    expect(CORE).toContain('specialty_can_edit_opportunity(id)');
    expect(CORE).toContain('public.specialty_member_capability(o.team_id');
  });

  it('consults the assignee only for a team that turned collaboration off', () => {
    // One place, and it is guarded by the setting.
    const editFn = /create or replace function public\.specialty_can_edit_opportunity[\s\S]*?\$\$;/.exec(CORE);
    expect(editFn).not.toBeNull();
    const body = editFn![0];
    expect(body).toContain('t.collaborative_editing');
    expect(body).toContain('or o.primary_assignee_id = auth.uid()');
    // Exactly one occurrence in executable SQL. Line comments, `comment on` prose and
    // the post-condition's own search string all mention it, so they are stripped first.
    const executable = CORE.replace(/comment on [\s\S]*?;\n/g, '')
      .split('\n')
      .filter(
        (line) => !line.trim().startsWith('--') && !line.includes("like '%primary_assignee_id"),
      )
      .join('\n');
    expect(executable.match(/primary_assignee_id = auth\.uid\(\)/g)?.length).toBe(1);
  });
});

describe('child tables are protected too', () => {
  const CHILD_TABLES = [
    'specialty_carrier_markets',
    'specialty_checklist_items',
    'specialty_information_requests',
    'specialty_notes',
    'specialty_documents',
    'specialty_price_presentations',
    'specialty_activity',
  ];

  it('enables RLS on the opportunity and on every child', () => {
    for (const table of ['specialty_opportunities', ...CHILD_TABLES]) {
      expect(CORE).toContain(`alter table public.${table} enable row level security`);
    }
  });

  it('gives every child a select policy scoped to the parent opportunity', () => {
    for (const table of CHILD_TABLES) {
      expect(CORE).toMatch(
        new RegExp(
          `create policy ${table}_v1161_select[\\s\\S]*?specialty_can_view_opportunity\\(opportunity_id\\)`,
        ),
      );
    }
  });

  it('asserts no specialty table is left policy-less', () => {
    expect(CORE).toContain('policy-less specialty table(s)');
  });
});

describe('history cannot be rewritten', () => {
  it('gives notes no update and no delete policy', () => {
    expect(CORE).toContain('create policy specialty_notes_v1161_insert');
    expect(CORE).not.toContain('create policy specialty_notes_v1161_update');
    expect(CORE).not.toContain('create policy specialty_notes_v1161_delete');
  });

  it('gives activity no insert, update or delete policy', () => {
    expect(CORE).toContain('create policy specialty_activity_v1161_select');
    expect(CORE).not.toContain('create policy specialty_activity_v1161_insert');
    expect(CORE).not.toContain('create policy specialty_activity_v1161_update');
    expect(CORE).not.toContain('create policy specialty_activity_v1161_delete');
  });

  it('gives price presentations select only', () => {
    expect(CORE).toContain('create policy specialty_price_presentations_v1161_select');
    expect(CORE).not.toContain('create policy specialty_price_presentations_v1161_insert');
  });

  it('never derives the actor from the assignee', () => {
    // specialty_log is the only writer of activity, and it always uses auth.uid().
    const logFn = /create or replace function public\.specialty_log[\s\S]*?\$\$;/.exec(MUTATIONS);
    expect(logFn).not.toBeNull();
    expect(logFn![0]).toContain('auth.uid(), p_event_type');
    expect(logFn![0]).not.toContain('primary_assignee_id');
  });

  it('keeps the activity writer out of client reach', () => {
    expect(MUTATIONS).toContain(
      'revoke all on function public.specialty_log(uuid, text, jsonb, uuid) from public, anon, authenticated',
    );
    expect(MUTATIONS).toContain('left an internal specialty helper executable by authenticated');
  });
});

describe('concurrency and atomicity', () => {
  it('locks the opportunity before reading the assignee, so a claim race has one winner', () => {
    const claim = /create or replace function public\.specialty_claim_opportunity[\s\S]*?\$\$;/.exec(
      MUTATIONS,
    );
    expect(claim).not.toBeNull();
    const body = claim![0];
    const lockIndex = body.indexOf('for update');
    const readIndex = body.indexOf('if v_row.primary_assignee_id is not null');
    expect(lockIndex).toBeGreaterThan(-1);
    expect(readIndex).toBeGreaterThan(lockIndex);
    expect(body).toContain('has already been claimed by');
  });

  it('raises the serialization-failure code for a stale save, matching the intake drafts', () => {
    expect(MUTATIONS).toContain("using errcode = '40001'");
    expect(MUTATIONS).toContain('updated by another employee while you were working on it');
  });

  it('guards the transition columns against a raw update', () => {
    expect(CORE).toContain('specialty_guard_protected_columns');
    for (const column of [
      'stage',
      'primary_assignee_id',
      'team_id',
      'result',
      'lost_reason',
      'sold_premium',
      'price_sent_at',
      'finalized_at',
    ]) {
      expect(CORE).toContain(`new.${column} is distinct from old.${column}`);
    }
  });
});

describe('outcome discipline', () => {
  it('refuses a blank Not Sold reason in the table and again in the RPC', () => {
    expect(CORE).toContain('specialty_opportunities_not_sold_needs_reason');
    expect(MUTATIONS).toContain('Choose a reason this quote was not sold.');
  });

  it('requires a carrier and a premium for Sold', () => {
    expect(MUTATIONS).toContain('Record which carrier the policy was bound with.');
    expect(MUTATIONS).toContain('Record the sold premium.');
  });

  it('keeps Sold and Not Sold out of the ordinary stage change', () => {
    expect(MUTATIONS).toContain(
      'Use Record Result to mark a quote Sold or Not Sold, so the carrier, premium or reason is captured.',
    );
  });

  it('treats a received carrier quote as a different event from a price sent', () => {
    // The presentation snapshot is frozen, and presented_at is set only there.
    expect(MUTATIONS).toContain('specialty_record_price_sent');
    // presented_at is stamped only by the price-sent action, never by recording a quote.
    expect(MUTATIONS).toContain('presented_at = coalesce(presented_at, now())');
    const carrierUpdate =
      /create or replace function public\.specialty_update_carrier_market[\s\S]*?\$\$;/.exec(
        MUTATIONS,
      );
    expect(carrierUpdate).not.toBeNull();
    expect(carrierUpdate![0]).not.toContain('presented_at =');
  });
});

describe('carrier markets belong to one opportunity', () => {
  it('is one row per carrier per opportunity, not one record per carrier', () => {
    expect(CORE).toContain('unique (opportunity_id, carrier_id)');
  });

  it('requires a premium for Quote Received and a reason for Declined', () => {
    expect(CORE).toContain('specialty_carrier_markets_quote_needs_premium');
    expect(CORE).toContain('specialty_carrier_markets_declined_needs_reason');
  });

  it('will not let a submitted market be deleted', () => {
    expect(CORE).toContain('and submitted_at is null');
    expect(MUTATIONS).toContain('Set it to Withdrawn instead so the marketing history is kept.');
  });
});

describe('intake routing', () => {
  it('creates the specialty submit path and leaves it non-consuming', () => {
    expect(ROUTING).toContain('create or replace function public.cs_intake_submit_specialty');
    const fn = /create or replace function public\.cs_intake_submit_specialty[\s\S]*?\$\$;/.exec(
      ROUTING,
    );
    expect(fn).not.toBeNull();
    expect(fn![0]).not.toContain('rotation_state');
    expect(fn![0]).not.toContain('turn_events');
  });

  it('is idempotent per intake', () => {
    expect(ROUTING).toContain('where source_intake_id = p_submission_id');
    expect(ROUTING).toContain('if v_existing is not null then');
    expect(CORE).toContain('specialty_opportunities_intake_unique');
  });

  it('leaves the intake unclaimed and notifies every eligible member', () => {
    expect(ROUTING).toContain('primary_assignee_id, stage, priority, created_by');
    expect(ROUTING).toContain('and m.is_active and m.can_claim and p.is_active');
  });

  it('seeds the workflow checklist so nobody rebuilds it by hand', () => {
    expect(ROUTING).toContain('from public.specialty_checklist_templates ct');
  });

  it('narrows the commercial path to commercial_gl and keeps its card intact', () => {
    expect(ROUTING).toContain("'NOT IN (''commercial_gl'')'");
    expect(ROUTING).toContain('drop function if exists public.cs_intake_submit_commercial(uuid)');
    expect(ROUTING).toContain('damaged the commercial card creation path');
  });

  it('adds a second, path-independent guard at the destination', () => {
    expect(ROUTING).toContain('specialty_block_legacy_specialty_cards');
    expect(ROUTING).toContain('before insert on public.commercial_quotes');
    expect(ROUTING).toContain("v_line not in ('trucking', 'homeowners')");
  });

  it('does not route commercial_gl to a specialty team', () => {
    expect(TEAMS).toContain('created a commercial_gl route; commercial routing must stay unchanged');
  });
});

describe('legacy adoption keeps everything', () => {
  it('never deletes a commercial row or a child of one', () => {
    expect(LEGACY).not.toMatch(/delete\s+from\s+public\.commercial_quote/i);
    expect(LEGACY).not.toMatch(/delete\s+from\s+public\.commercial_quotes/i);
  });

  it('preserves the original timestamps rather than restarting the clock', () => {
    expect(LEGACY).toContain('v_card.created_at');
    expect(LEGACY).toContain('Original timestamps, so aging and timing reports do not restart');
  });

  it('carries comments, attachments, checklist items and history forward', () => {
    expect(LEGACY).toContain('from public.commercial_quote_comments cc');
    expect(LEGACY).toContain('from public.commercial_quote_attachments ca');
    expect(LEGACY).toContain('join public.commercial_quote_checklist_items ci');
    expect(LEGACY).toContain('from public.commercial_quote_column_history ch');
    expect(LEGACY).toContain('from public.commercial_quote_activity_log al');
  });

  it('asserts nothing was lost, per card', () => {
    for (const claim of [
      'lost comments during adoption',
      'lost attachments during adoption',
      'lost checklist items during adoption',
    ]) {
      expect(LEGACY).toContain(claim);
    }
  });

  it('references legacy attachments in place rather than copying the bytes', () => {
    expect(LEGACY).toContain("'commercial-quote-attachments', ca.storage_path");
    expect(CORE).toContain(
      "storage_bucket text not null default 'specialty-quote-documents'",
    );
  });

  it('leaves soft-deleted cards alone rather than resurrecting them', () => {
    expect(LEGACY).toContain('coalesce(q.is_deleted, false) = false');
    expect(LEGACY).toContain('deliberately NOT adopted');
  });

  it('ends double visibility without ending the record', () => {
    expect(LEGACY).toContain('migrated_to_specialty_at');
    expect(LEGACY).toContain('left % adopted card(s) still live on the board');
  });

  it('does not touch a commercial_gl card', () => {
    expect(LEGACY).toContain("q.coverage_type in ('trucking', 'homeowners')");
    expect(LEGACY).toContain('stamped % non-specialty commercial card(s)');
  });
});

describe('reads and reports are gated', () => {
  it('revokes the row-shaping view from clients', () => {
    expect(READS).toContain('revoke all on public.specialty_opportunity_rows from authenticated, anon');
    expect(READS).toContain('left specialty_opportunity_rows readable by authenticated');
  });

  it('applies the team boundary inside the search itself', () => {
    expect(READS).toContain('where public.specialty_can_view_opportunity(r.id)');
  });

  it('gates every report and asserts it', () => {
    expect(REPORTS).toContain('left ungated report function(s)');
    const reportFns = REPORTS.match(/create or replace function public\.specialty_report_\w+/g) ?? [];
    expect(reportFns.length).toBe(7);
  });

  it('defaults the operational view to the whole team, not to the reader', () => {
    expect(READS).toContain("p_view text default 'team'");
    expect(READS).toContain('the team works together, so a member lands on');
  });

  it('derives contributors from recorded activity rather than from the assignment', () => {
    expect(READS).toContain('from public.specialty_activity a');
    expect(READS).toContain("'is_primary_assignee', a.actor_profile_id = v_row.primary_assignee_id");
    expect(REPORTS).toContain('Counted from public.specialty_activity');
  });
});

describe('nothing in the engine touches a queue rotation', () => {
  /**
   * Every function body the seven migrations define, with `--` comments stripped.
   *
   * Comments and post-condition search strings legitimately mention `rotation_state` —
   * one of them is the migration asserting this very rule — so the check has to look at
   * executable SQL rather than at the file as text.
   */
  const functionBodies = (ALL.match(/create or replace function[\s\S]*?\$[\w]*\$;/g) ?? []).map(
    (body) =>
      body
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n'),
  );

  it('found the function bodies to check', () => {
    expect(functionBodies.length).toBeGreaterThan(30);
  });

  it('never reads or writes rotation state or turn events', () => {
    // Specialty work is claimed from a shared team pool. It has no relationship to the
    // WhatsApp, RingCentral or Additional Workload rotations, and giving it one would
    // break invariants that live somewhere else entirely.
    for (const body of functionBodies) {
      expect(body).not.toContain('rotation_state');
      expect(body).not.toContain('turn_events');
      expect(body).not.toContain('next_eligible_profile');
    }
  });

  it('asserts the same rule inside the migration', () => {
    expect(MUTATIONS).toContain('gave a specialty function a rotation side effect');
    expect(ROUTING).toContain('gave the specialty submit path a rotation side effect');
  });
});

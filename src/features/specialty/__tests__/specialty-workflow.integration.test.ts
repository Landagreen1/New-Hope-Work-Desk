/**
 * Specialty Quotes against the real database.
 *
 * The unit suites pin the rules as TypeScript mirrors. This one proves the rules are
 * actually in the database: RLS as each employee, the claim guard, the concurrency
 * refusal, the carrier-market validations, the routing guards, the Quote Center
 * overlay, and that the Commercial Board still works.
 *
 * How the impersonation works: each statement runs through the Management API, and a
 * `set local request.jwt.claims` plus `set local role authenticated` is what makes
 * `auth.uid()` resolve and RLS apply. That is the only way to test policies without a
 * password for each employee, and it exercises the same predicates a real request
 * would.
 *
 * Cleanup is by marker. Everything this suite creates carries {@link MARKER} in its
 * name, and the marker rows are deleted before and after the run — so a failed run
 * leaves the next one a clean slate rather than requiring a manual tidy-up. Nothing
 * outside the marker is touched, and no commercial row is ever deleted.
 *
 * Run with: npm run test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MARKER = 'ZZ-ITEST-SPECIALTY';

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;

/**
 * Skipped rather than failed when the credentials are absent.
 *
 * `npm test` matches every `*.test.ts`, including this one, and does not load
 * `.env.local`. Throwing at import time would make the ordinary unit run fail on a
 * missing personal access token, which is not a defect. `npm run test:integration`
 * loads the env file and the suite runs for real.
 *
 * Same shape as the cancellation and attendance audit-immutability suites.
 */
const HAS_CREDENTIALS = Boolean(ACCESS_TOKEN && PROJECT_REF);
const describeAgainstProject = HAS_CREDENTIALS ? describe : describe.skip;

type Row = Record<string, unknown>;

/** The Management API throttles bursts, so requests are serialised end to end. */
let queue: Promise<unknown> = Promise.resolve();
const MIN_GAP_MS = 350;
const MAX_ATTEMPTS = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(sql: string): Promise<Row[]> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ACCESS_TOKEN}`,
        },
        body: JSON.stringify({ query: sql }),
      },
    );

    const text = await response.text();

    if (response.ok) return JSON.parse(text) as Row[];

    // A throttle is not a result. Backing off and retrying is the difference between a
    // suite that tests the database and one that tests the rate limiter — every
    // assertion below reads an error message, so a 429 would masquerade as a refusal.
    const throttled = response.status === 429 || /ThrottlerException|Too Many Requests/i.test(text);
    if (throttled && attempt < MAX_ATTEMPTS) {
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    throw new Error(text);
  }
  throw new Error('The Supabase Management API kept throttling. Try again in a minute.');
}

/**
 * Runs one statement batch, serialised behind every earlier call.
 *
 * Serialising also makes the ordering of the scenarios below meaningful: a claim has to
 * have committed before the next test checks who won it.
 */
function runSql(sql: string): Promise<Row[]> {
  const result = queue.then(async () => {
    await sleep(MIN_GAP_MS);
    return post(sql);
  });
  // The chain must not break on a rejection, or every later call inherits the failure.
  queue = result.catch(() => undefined);
  return result;
}

/** Runs SQL as one employee, with RLS applied. */
async function asUser(profileId: string, sql: string): Promise<Row[]> {
  return runSql(
    [
      'begin;',
      "set local role authenticated;",
      `set local request.jwt.claims = '${JSON.stringify({ sub: profileId, role: 'authenticated' })}';`,
      sql,
      'commit;',
    ].join('\n'),
  );
}

/**
 * Runs SQL as one employee and returns the last SELECT.
 *
 * The Management API returns the final result set, and `commit` produces none, so a
 * read has to end the script. Split from {@link asUser} to make that explicit at the
 * call site rather than a trap.
 */
async function readAsUser(profileId: string, selectSql: string): Promise<Row[]> {
  return runSql(
    [
      'begin;',
      "set local role authenticated;",
      `set local request.jwt.claims = '${JSON.stringify({ sub: profileId, role: 'authenticated' })}';`,
      selectSql,
      'rollback;',
    ].join('\n'),
  );
}

/** Asserts that a statement is refused, and returns the message so it can be checked. */
async function expectRefused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
  throw new Error('Expected the statement to be refused, but it succeeded.');
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function cleanup(): Promise<void> {
  // Order matters only for the intakes: opportunities cascade to their children, and the
  // intake is deleted last because the opportunity references it.
  await runSql(`
    delete from public.specialty_opportunities
     where display_name like ${quote(`%${MARKER}%`)};
    delete from public.cs_intake_submissions
     where insured_last_name like ${quote(`%${MARKER}%`)}
        or business_name like ${quote(`%${MARKER}%`)};
    delete from public.commercial_quotes
     where business_name like ${quote(`%${MARKER}%`)};
    delete from public.specialty_carriers
     where name like ${quote(`%${MARKER}%`)};
    delete from public.quoting_team_members
     where team_id in (select id from public.quoting_teams where name like ${quote(`%${MARKER}%`)});
    delete from public.quoting_teams
     where name like ${quote(`%${MARKER}%`)};
  `);
}

// ── People and fixtures, resolved from the live database ─────────────────────

interface People {
  oscar: string;
  jason: string;
  brenda: string;
  /** An active Sales agent on no quoting team at all. */
  outsider: string;
  truckingTeam: string;
  homeownersTeam: string;
  progressive: string;
  canal: string;
}

let people: People;
let truckingIntake: string;
let truckingOpportunity: string;

beforeAll(async () => {
  // Top-level hooks run even when every describe is skipped, so the guard is repeated
  // here rather than relying on the describe wrapper.
  if (!HAS_CREDENTIALS) return;

  await cleanup();

  const [ids] = await runSql(`
    select
      (select id from public.profiles where username = 'oscar' and is_active)::text as oscar,
      (select id from public.profiles where username = 'jason' and is_active)::text as jason,
      (select id from public.profiles where username = 'brendam' and is_active)::text as brenda,
      (select p.id from public.profiles p
        where p.is_active and p.role::text = 'agent'
          and not exists (select 1 from public.quoting_team_members m
                          where m.profile_id = p.id and m.is_active)
        order by p.display_name limit 1)::text as outsider,
      (select id from public.quoting_teams where name = 'Trucking Team')::text as trucking_team,
      (select id from public.quoting_teams where name = 'Homeowners Team')::text as homeowners_team,
      (select id from public.specialty_carriers where name = 'Progressive')::text as progressive,
      (select id from public.specialty_carriers where name = 'Canal Insurance')::text as canal;
  `);

  people = {
    oscar: String(ids.oscar),
    jason: String(ids.jason),
    brenda: String(ids.brenda),
    outsider: String(ids.outsider),
    truckingTeam: String(ids.trucking_team),
    homeownersTeam: String(ids.homeowners_team),
    progressive: String(ids.progressive),
    canal: String(ids.canal),
  };

  for (const [key, value] of Object.entries(people)) {
    expect(value, `fixture ${key} must resolve`).not.toBe('null');
  }

  // A Trucking intake, created by Brenda in her Customer Service capacity. She is not on
  // the Trucking team, which is exactly what several assertions below depend on.
  const [intake] = await runSql(`
    insert into public.cs_intake_submissions (
      status, priority, line_of_business, created_by,
      insured_first_name, insured_last_name, insured_phone_primary,
      business_name, dot_number, mc_number, cargo_type, power_unit_count,
      intake_channel
    ) values (
      'draft', 'normal', 'trucking', ${quote(people.brenda)},
      'ABC', ${quote(`Trucking ${MARKER}`)}, '7045550001',
      ${quote(`ABC Trucking ${MARKER}`)}, 'DOT-999001', 'MC-999001', 'General freight', 4,
      'manual'
    ) returning id::text;
  `);
  truckingIntake = String(intake.id);
}, 120_000);

afterAll(async () => {
  if (!HAS_CREDENTIALS) return;
  await cleanup();
}, 120_000);

// ═══════════════════════════════════════════════════════════════════════════════
// Intake routing
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('intake routing', () => {
  it('sends a submitted Trucking intake to the Trucking team, unclaimed', async () => {
    const [result] = await asUser(
      people.brenda,
      `select public.cs_intake_submit_specialty(${quote(truckingIntake)})::text as id;`,
    ).then(async () =>
      // The insert happened in the transaction above; read the result separately so the
      // assertion is against committed state rather than against the RPC's return value.
      runSql(`
        select o.id::text, o.stage, o.team_id::text as team_id, o.source,
               o.primary_assignee_id is null as unclaimed,
               o.reference,
               (select count(*) from public.specialty_checklist_items i
                 where i.opportunity_id = o.id) as checklist_items,
               (select count(*) from public.specialty_activity a
                 where a.opportunity_id = o.id) as activity_rows
        from public.specialty_opportunities o
        where o.source_intake_id = ${quote(truckingIntake)};
      `),
    );

    expect(result).toBeDefined();
    truckingOpportunity = String(result.id);

    expect(result.stage).toBe('new');
    expect(result.team_id).toBe(people.truckingTeam);
    expect(result.source).toBe('cs_intake');
    expect(result.unclaimed).toBe(true);
    expect(String(result.reference)).toMatch(/^SQ-[0-9A-F]{8}$/);
    // Seeded from the Trucking workflow template, not built by hand.
    expect(Number(result.checklist_items)).toBe(16);
    // opportunity_created and intake_received.
    expect(Number(result.activity_rows)).toBe(2);
  }, 60_000);

  it('marks the intake converted and links it both ways', async () => {
    const [row] = await runSql(`
      select s.status::text as status,
             s.converted_at is not null as converted,
             s.source_commercial_quote_id is null as no_commercial_card,
             s.completed_by::text as completed_by,
             (select count(*) from public.cs_intake_events e
               where e.submission_id = s.id and e.event_type = 'converted_specialty') as handoff_events
      from public.cs_intake_submissions s where s.id = ${quote(truckingIntake)};
    `);
    expect(row.status).toBe('converted');
    expect(row.converted).toBe(true);
    // No commercial card was created. This is the no-duplicate-destination guarantee.
    expect(row.no_commercial_card).toBe(true);
    expect(row.completed_by).toBe(people.brenda);
    expect(Number(row.handoff_events)).toBe(1);
  }, 60_000);

  it('creates no commercial card for the specialty intake', async () => {
    const [row] = await runSql(`
      select count(*) as n from public.commercial_quotes
       where business_name like ${quote(`%${MARKER}%`)};
    `);
    expect(Number(row.n)).toBe(0);
  }, 60_000);

  it('is idempotent: a retried submission returns the same opportunity', async () => {
    const [row] = await asUser(
      people.brenda,
      `select public.cs_intake_submit_specialty(${quote(truckingIntake)})::text as id;`,
    ).then(() =>
      runSql(`
        select count(*) as n from public.specialty_opportunities
         where source_intake_id = ${quote(truckingIntake)};
      `),
    );
    expect(Number(row.n)).toBe(1);
  }, 60_000);

  it('notified every eligible Trucking member, and nobody else', async () => {
    const rows = await runSql(`
      select n.recipient_profile_id::text as recipient
      from public.user_notifications n
      where n.entity_type = 'specialty_opportunity'
        and n.entity_id = ${quote(truckingOpportunity)};
    `);
    const recipients = rows.map((row) => String(row.recipient)).sort();
    expect(recipients).toEqual([people.oscar, people.jason].sort());
    expect(recipients).not.toContain(people.brenda);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Routing guards — no duplicate live destinations
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('the Commercial Board can no longer receive specialty work', () => {
  it('refuses a Trucking intake through the commercial submit path', async () => {
    const [fresh] = await runSql(`
      insert into public.cs_intake_submissions (
        status, line_of_business, created_by, insured_first_name, insured_last_name,
        insured_phone_primary, business_name, dot_number
      ) values (
        'draft', 'trucking', ${quote(people.brenda)}, 'Guard',
        ${quote(`One ${MARKER}`)}, '7045550002', ${quote(`Guard One ${MARKER}`)}, 'DOT-999002'
      ) returning id::text;
    `);

    const message = await expectRefused(
      asUser(
        people.brenda,
        `select public.cs_intake_submit_commercial(${quote(String(fresh.id))}, ${quote(people.brenda)});`,
      ),
    );
    expect(message).toMatch(/Specialty Quotes/i);
  }, 60_000);

  it('refuses a trucking or homeowners commercial card outright, whatever creates it', async () => {
    for (const coverage of ['trucking', 'homeowners']) {
      const message = await expectRefused(
        runSql(`
          insert into public.commercial_quotes (business_name, coverage_type, assigned_to)
          values (${quote(`Direct ${coverage} ${MARKER}`)}, ${quote(coverage)}, ${quote(people.jason)});
        `),
      );
      expect(message).toMatch(/moved to Specialty Quotes/i);
    }
  }, 60_000);

  it('has exactly one cs_intake_submit_commercial overload left', async () => {
    const [row] = await runSql(`
      select count(*) as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'cs_intake_submit_commercial';
    `);
    expect(Number(row.n)).toBe(1);
  }, 60_000);
});

describeAgainstProject('Commercial GL is unchanged', () => {
  it('still creates a commercial card with its checklist, history and activity', async () => {
    const [intake] = await runSql(`
      insert into public.cs_intake_submissions (
        status, line_of_business, created_by, insured_first_name, insured_last_name,
        insured_phone_primary, business_name
      ) values (
        'draft', 'commercial_gl', ${quote(people.brenda)}, 'GL',
        ${quote(`Regression ${MARKER}`)}, '7045550003', ${quote(`GL Regression ${MARKER}`)}
      ) returning id::text;
    `);

    await asUser(
      people.brenda,
      `select public.cs_intake_submit_commercial(${quote(String(intake.id))}, ${quote(people.jason)});`,
    );

    const [card] = await runSql(`
      select q.id::text, q.coverage_type, q.board_column,
             q.migrated_to_specialty_at is null as still_live,
             (select count(*) from public.commercial_quote_checklists c where c.quote_id = q.id) as checklists,
             (select count(*) from public.commercial_quote_column_history h where h.quote_id = q.id) as history,
             (select count(*) from public.commercial_quote_activity_log a where a.quote_id = q.id) as activity
      from public.commercial_quotes q
      where q.business_name = ${quote(`GL Regression ${MARKER}`)};
    `);

    expect(card).toBeDefined();
    expect(card.coverage_type).toBe('gl');
    expect(card.board_column).toBe('quote_intake');
    // A GL card is never stamped, so it stays on the board.
    expect(card.still_live).toBe(true);
    expect(Number(card.checklists)).toBe(1);
    expect(Number(card.history)).toBe(1);
    expect(Number(card.activity)).toBe(1);

    const [opportunity] = await runSql(`
      select count(*) as n from public.specialty_opportunities
       where source_intake_id = ${quote(String(intake.id))};
    `);
    // Commercial GL is not routed to a specialty team.
    expect(Number(opportunity.n)).toBe(0);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Visibility — the team boundary, per employee
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('who can see the Trucking quote', () => {
  it('shows it to Oscar and Jason', async () => {
    for (const person of ['oscar', 'jason'] as const) {
      const [row] = await readAsUser(
        people[person],
        `select public.specialty_can_view_opportunity(${quote(truckingOpportunity)}) as can_view,
                public.specialty_can_edit_opportunity(${quote(truckingOpportunity)}) as can_edit,
                (select count(*) from public.specialty_opportunities o
                  where o.id = ${quote(truckingOpportunity)}) as rls_rows;`,
      );
      expect(row.can_view, person).toBe(true);
      expect(row.can_edit, person).toBe(true);
      expect(Number(row.rls_rows), person).toBe(1);
    }
  }, 60_000);

  /** The scenario the spec names: Homeowners membership must not grant Trucking. */
  it('hides it from Brenda, who is on Homeowners and not on Trucking', async () => {
    const [row] = await readAsUser(
      people.brenda,
      `select public.specialty_can_access() as can_access,
              public.specialty_can_view_lob('homeowners') as sees_homeowners,
              public.specialty_can_view_lob('trucking') as sees_trucking,
              public.specialty_can_view_opportunity(${quote(truckingOpportunity)}) as can_view,
              (select count(*) from public.specialty_opportunities o
                where o.id = ${quote(truckingOpportunity)}) as rls_rows;`,
    );
    expect(row.can_access).toBe(true);
    expect(row.sees_homeowners).toBe(true);
    expect(row.sees_trucking).toBe(false);
    expect(row.can_view).toBe(false);
    // RLS, not merely a hidden menu item.
    expect(Number(row.rls_rows)).toBe(0);
  }, 60_000);

  it('refuses the whole module to a Sales agent on no team', async () => {
    const [row] = await readAsUser(
      people.outsider,
      `select public.specialty_can_access() as can_access,
              public.specialty_can_view_opportunity(${quote(truckingOpportunity)}) as can_view,
              (select count(*) from public.specialty_opportunities) as rls_rows;`,
    );
    expect(row.can_access).toBe(false);
    expect(row.can_view).toBe(false);
    expect(Number(row.rls_rows)).toBe(0);
  }, 60_000);

  it('refuses the search RPC to a non-member rather than returning an empty page', async () => {
    const message = await expectRefused(
      readAsUser(people.outsider, `select * from public.specialty_search_opportunities();`),
    );
    expect(message).toMatch(/not available for your account/i);
  }, 60_000);

  it('protects every child table, not only the opportunity', async () => {
    // Securing the parent while leaving the children readable would defeat the boundary.
    await runSql(`
      insert into public.specialty_notes (opportunity_id, author_id, content)
      values (${quote(truckingOpportunity)}, ${quote(people.jason)}, 'Seeded for the child-RLS check');
      insert into public.specialty_information_requests (opportunity_id, label, created_by)
      values (${quote(truckingOpportunity)}, 'Loss runs', ${quote(people.jason)});
    `);

    for (const [person, expected] of [
      ['oscar', 1],
      ['brenda', 0],
      ['outsider', 0],
    ] as const) {
      const [row] = await readAsUser(
        people[person],
        `select
           (select count(*) from public.specialty_checklist_items i
             where i.opportunity_id = ${quote(truckingOpportunity)}) > 0 as checklist,
           (select count(*) from public.specialty_notes n
             where n.opportunity_id = ${quote(truckingOpportunity)}) as notes,
           (select count(*) from public.specialty_information_requests r
             where r.opportunity_id = ${quote(truckingOpportunity)}) as info,
           (select count(*) from public.specialty_activity a
             where a.opportunity_id = ${quote(truckingOpportunity)}) > 0 as activity,
           (select count(*) from public.specialty_carrier_markets m
             where m.opportunity_id = ${quote(truckingOpportunity)}) as markets;`,
      );
      expect(row.checklist, `${person} checklist`).toBe(expected === 1);
      expect(Number(row.notes), `${person} notes`).toBe(expected);
      expect(Number(row.info), `${person} information`).toBe(expected);
      expect(row.activity, `${person} activity`).toBe(expected === 1);
      expect(Number(row.markets), `${person} carrier markets`).toBe(0);
    }

    // Remove the seeds. They were inserted directly, so they never went through the
    // RPCs that keep the stage in step with what is outstanding — leaving the
    // information request behind would hold the quote in Information Needed and make
    // the later stage assertions read as failures of the engine rather than of this
    // fixture.
    await runSql(`
      delete from public.specialty_notes
       where opportunity_id = ${quote(truckingOpportunity)}
         and content = 'Seeded for the child-RLS check';
      delete from public.specialty_information_requests
       where opportunity_id = ${quote(truckingOpportunity)} and label = 'Loss runs';
    `);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Claiming
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('shared claim', () => {
  it('lets Jason claim, and refuses the second claimant by name', async () => {
    await asUser(
      people.jason,
      `select public.specialty_claim_opportunity(${quote(truckingOpportunity)});`,
    );

    const [after] = await runSql(`
      select primary_assignee_id::text as assignee, claimed_at is not null as stamped, version
      from public.specialty_opportunities where id = ${quote(truckingOpportunity)};
    `);
    expect(after.assignee).toBe(people.jason);
    expect(after.stamped).toBe(true);

    // Oscar loses the race. The row was locked before the assignee was read, so there is
    // exactly one winner and the loser is told who it was.
    const message = await expectRefused(
      asUser(
        people.oscar,
        `select public.specialty_claim_opportunity(${quote(truckingOpportunity)});`,
      ),
    );
    expect(message).toMatch(/already been claimed by/i);
    expect(message).toMatch(/Jason/);

    // And the assignee did not change.
    const [unchanged] = await runSql(`
      select primary_assignee_id::text as assignee
      from public.specialty_opportunities where id = ${quote(truckingOpportunity)};
    `);
    expect(unchanged.assignee).toBe(people.jason);
  }, 60_000);

  it('treats a re-claim by the same person as a no-op rather than an error', async () => {
    const [row] = await runSql(
      [
        'begin;',
        'set local role authenticated;',
        `set local request.jwt.claims = '${JSON.stringify({ sub: people.jason, role: 'authenticated' })}';`,
        `select (public.specialty_claim_opportunity(${quote(truckingOpportunity)}) ->> 'already_mine') as already_mine;`,
        'rollback;',
      ].join('\n'),
    );
    expect(row.already_mine).toBe('true');
  }, 60_000);

  it('refuses a claim from a member of another team', async () => {
    const message = await expectRefused(
      asUser(
        people.brenda,
        `select public.specialty_claim_opportunity(${quote(truckingOpportunity)});`,
      ),
    );
    expect(message).toMatch(/not eligible to claim/i);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Collaboration — the rule the whole engine exists for
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('assignment does not prevent collaboration', () => {
  it('lets Oscar work a quote assigned to Jason, and records Oscar as the actor', async () => {
    await asUser(
      people.oscar,
      `select public.specialty_add_note(${quote(truckingOpportunity)}, 'Oscar added the driver information');`,
    );

    const [row] = await runSql(`
      select n.author_id::text as author, o.primary_assignee_id::text as assignee
      from public.specialty_notes n
      join public.specialty_opportunities o on o.id = n.opportunity_id
      where n.opportunity_id = ${quote(truckingOpportunity)}
        and n.content = 'Oscar added the driver information';
    `);
    expect(row.author).toBe(people.oscar);
    // The assignee is untouched by somebody else's work.
    expect(row.assignee).toBe(people.jason);

    const [activity] = await runSql(`
      select a.actor_profile_id::text as actor
      from public.specialty_activity a
      where a.opportunity_id = ${quote(truckingOpportunity)}
        and a.event_type = 'note_added'
      order by a.created_at desc limit 1;
    `);
    // Never derived from the assignee. This is the attribution mistake the engine is
    // built to avoid.
    expect(activity.actor).toBe(people.oscar);
    expect(activity.actor).not.toBe(people.jason);
  }, 60_000);

  it('refuses a stale save instead of overwriting a teammate', async () => {
    const [current] = await runSql(`
      select version from public.specialty_opportunities where id = ${quote(truckingOpportunity)};
    `);
    const staleVersion = Number(current.version) - 1;

    const message = await expectRefused(
      asUser(
        people.oscar,
        `select public.specialty_update_opportunity(
           ${quote(truckingOpportunity)},
           '{"priority":"high"}'::jsonb,
           ${staleVersion});`,
      ),
    );
    expect(message).toMatch(/updated by another employee/i);

    // Nothing changed.
    const [after] = await runSql(`
      select priority, version from public.specialty_opportunities
       where id = ${quote(truckingOpportunity)};
    `);
    expect(after.priority).toBe('normal');
    expect(Number(after.version)).toBe(Number(current.version));
  }, 60_000);

  it('accepts the same save at the current version', async () => {
    const [current] = await runSql(`
      select version from public.specialty_opportunities where id = ${quote(truckingOpportunity)};
    `);
    await asUser(
      people.oscar,
      `select public.specialty_update_opportunity(
         ${quote(truckingOpportunity)},
         '{"priority":"high","next_action":"Submit Progressive","next_action_due":"2026-12-31T17:00:00Z"}'::jsonb,
         ${Number(current.version)});`,
    );
    const [after] = await runSql(`
      select priority, next_action, next_action_set_by::text as set_by, version
      from public.specialty_opportunities where id = ${quote(truckingOpportunity)};
    `);
    expect(after.priority).toBe('high');
    expect(after.next_action).toBe('Submit Progressive');
    expect(after.set_by).toBe(people.oscar);
    expect(Number(after.version)).toBeGreaterThan(Number(current.version));
  }, 60_000);

  it('refuses a raw update that reaches a transition column', async () => {
    // Stage, assignment, pricing and result must go through the validated actions, or
    // the timestamps and the audit trail would be skipped.
    const message = await expectRefused(
      asUser(
        people.oscar,
        `update public.specialty_opportunities set stage = 'sold'
          where id = ${quote(truckingOpportunity)};`,
      ),
    );
    expect(message).toMatch(/must go through the Specialty Quotes actions/i);
  }, 60_000);

  it('refuses any write from a member of another team', async () => {
    const message = await expectRefused(
      asUser(
        people.brenda,
        `select public.specialty_add_note(${quote(truckingOpportunity)}, 'Brenda should not be here');`,
      ),
    );
    expect(message).toMatch(/cannot add notes/i);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Information Needed loop and the Customer Service callback
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('the information-needed loop reaches Customer Service and comes back', () => {
  let requestId: string;

  it('moves the quote to Information Needed when something is outstanding', async () => {
    const [row] = await asUser(
      people.jason,
      `select public.specialty_add_information_request(
         ${quote(truckingOpportunity)}, 'Loss runs (3-5 years)', 'Need 3 years from the prior carrier', true)::text as id;`,
    ).then(() =>
      runSql(`
        select o.stage,
               (select r.id::text from public.specialty_information_requests r
                 where r.opportunity_id = o.id and r.label = 'Loss runs (3-5 years)'
                 order by r.created_at desc limit 1) as request_id
        from public.specialty_opportunities o where o.id = ${quote(truckingOpportunity)};
      `),
    );
    expect(row.stage).toBe('information_needed');
    requestId = String(row.request_id);
    expect(requestId).not.toBe('null');
  }, 60_000);

  it('shows Customer Service the outstanding item without exposing carrier strategy', async () => {
    const [row] = await readAsUser(
      people.brenda,
      `select public.specialty_cs_status(${quote(truckingIntake)}) as payload;`,
    );
    const payload = row.payload as Record<string, unknown>;
    expect(payload.status).toBe('Information Needed');
    expect(payload.assignee_name).toMatch(/Jason/);
    const items = payload.information_needed as Record<string, unknown>[];
    expect(items.map((item) => item.label)).toContain('Loss runs (3-5 years)');
    // The CS payload has no carrier fields at all, by construction.
    expect(Object.keys(payload)).not.toContain('carrier_markets');
    expect(Object.keys(payload)).not.toContain('best_premium');
  }, 60_000);

  it('lets Customer Service supply it, and the quote moves on by itself', async () => {
    await asUser(
      people.brenda,
      `select public.specialty_cs_provide_information(
         ${quote(requestId)}, 'Customer emailed 3 years of loss runs to the office inbox');`,
    );

    const [row] = await runSql(`
      select o.stage,
             (select r.status from public.specialty_information_requests r where r.id = ${quote(requestId)}) as request_status,
             (select r.resolved_by::text from public.specialty_information_requests r where r.id = ${quote(requestId)}) as resolved_by,
             (select count(*) from public.specialty_activity a
               where a.opportunity_id = o.id and a.event_type = 'information_received'
                 and a.detail ->> 'via' = 'customer_service') as cs_events,
             (select count(*) from public.specialty_notes n
               where n.opportunity_id = o.id and n.is_cs_visible) as shared_notes
      from public.specialty_opportunities o where o.id = ${quote(truckingOpportunity)};
    `);
    // Nothing is outstanding, so the stage follows the fact rather than waiting.
    expect(row.stage).toBe('ready_to_market');
    expect(row.request_status).toBe('received');
    expect(row.resolved_by).toBe(people.brenda);
    expect(Number(row.cs_events)).toBe(1);
    expect(Number(row.shared_notes)).toBeGreaterThan(0);
  }, 60_000);

  it('does not let Customer Service touch an internal item', async () => {
    const [internal] = await runSql(`
      insert into public.specialty_information_requests
        (opportunity_id, label, visible_to_cs, created_by, status)
      values (${quote(truckingOpportunity)}, 'Internal underwriting note', false, ${quote(people.jason)}, 'requested')
      returning id::text;
    `);
    const message = await expectRefused(
      asUser(
        people.brenda,
        `select public.specialty_cs_provide_information(${quote(String(internal.id))}, 'trying anyway');`,
      ),
    );
    expect(message).toMatch(/not shared with Customer Service/i);

    await runSql(`delete from public.specialty_information_requests where id = ${quote(String(internal.id))};`);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Carrier markets
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('carrier markets', () => {
  let progressiveMarket: string;
  let canalMarket: string;

  it('lets different teammates each add and work a carrier on the same quote', async () => {
    // Jason submits Progressive; Oscar submits Canal. One opportunity, two markets.
    await asUser(
      people.jason,
      `select public.specialty_add_carrier_market(${quote(truckingOpportunity)}, ${quote(people.progressive)}, 'preparing');`,
    );
    await asUser(
      people.oscar,
      `select public.specialty_add_carrier_market(${quote(truckingOpportunity)}, ${quote(people.canal)}, 'preparing');`,
    );

    const rows = await runSql(`
      select m.id::text, c.name, m.created_by::text as created_by
      from public.specialty_carrier_markets m
      join public.specialty_carriers c on c.id = m.carrier_id
      where m.opportunity_id = ${quote(truckingOpportunity)}
      order by c.name;
    `);
    expect(rows.length).toBe(2);
    canalMarket = String(rows.find((row) => String(row.name).startsWith('Canal'))!.id);
    progressiveMarket = String(rows.find((row) => row.name === 'Progressive')!.id);
    expect(rows.find((row) => row.name === 'Progressive')!.created_by).toBe(people.jason);
    expect(rows.find((row) => String(row.name).startsWith('Canal'))!.created_by).toBe(people.oscar);
  }, 60_000);

  it('refuses the same carrier twice on one quote', async () => {
    const message = await expectRefused(
      asUser(
        people.jason,
        `select public.specialty_add_carrier_market(${quote(truckingOpportunity)}, ${quote(people.progressive)});`,
      ),
    );
    expect(message).toMatch(/already being marketed/i);
  }, 60_000);

  it('stamps the submission and moves the quote to Marketing', async () => {
    const [before] = await runSql(
      `select version from public.specialty_carrier_markets where id = ${quote(progressiveMarket)};`,
    );
    await asUser(
      people.jason,
      `select public.specialty_update_carrier_market(
         ${quote(progressiveMarket)}, '{"status":"submitted"}'::jsonb, ${Number(before.version)});`,
    );

    const [row] = await runSql(`
      select m.status, m.submitted_at is not null as submitted, m.submitted_by::text as submitted_by,
             o.stage, o.first_submission_at is not null as first_submission
      from public.specialty_carrier_markets m
      join public.specialty_opportunities o on o.id = m.opportunity_id
      where m.id = ${quote(progressiveMarket)};
    `);
    expect(row.status).toBe('submitted');
    expect(row.submitted).toBe(true);
    expect(row.submitted_by).toBe(people.jason);
    expect(row.stage).toBe('marketing');
    expect(row.first_submission).toBe(true);
  }, 60_000);

  it('will not accept Quote Received without a premium', async () => {
    const [before] = await runSql(
      `select version from public.specialty_carrier_markets where id = ${quote(progressiveMarket)};`,
    );
    const message = await expectRefused(
      asUser(
        people.oscar,
        `select public.specialty_update_carrier_market(
           ${quote(progressiveMarket)}, '{"status":"quote_received"}'::jsonb, ${Number(before.version)});`,
      ),
    );
    expect(message).toMatch(/quoted premium/i);
  }, 60_000);

  it('lets Oscar record the premium on the carrier Jason submitted', async () => {
    const [before] = await runSql(
      `select version from public.specialty_carrier_markets where id = ${quote(progressiveMarket)};`,
    );
    await asUser(
      people.oscar,
      `select public.specialty_update_carrier_market(
         ${quote(progressiveMarket)},
         '{"status":"quote_received","premium":18420,"down_payment":3684,"payment_terms":"20% down, 9 payments"}'::jsonb,
         ${Number(before.version)});`,
    );

    const [row] = await runSql(`
      select m.premium, m.quote_received_by::text as received_by, m.submitted_by::text as submitted_by,
             o.stage, o.first_quote_at is not null as first_quote
      from public.specialty_carrier_markets m
      join public.specialty_opportunities o on o.id = m.opportunity_id
      where m.id = ${quote(progressiveMarket)};
    `);
    expect(Number(row.premium)).toBe(18420);
    // Two different people, correctly attributed.
    expect(row.received_by).toBe(people.oscar);
    expect(row.submitted_by).toBe(people.jason);
    expect(row.stage).toBe('options_ready');
    expect(row.first_quote).toBe(true);
  }, 60_000);

  it('requires a reason to decline and a request to ask for more information', async () => {
    const [before] = await runSql(
      `select version from public.specialty_carrier_markets where id = ${quote(canalMarket)};`,
    );
    const declineMessage = await expectRefused(
      asUser(
        people.oscar,
        `select public.specialty_update_carrier_market(
           ${quote(canalMarket)}, '{"status":"declined"}'::jsonb, ${Number(before.version)});`,
      ),
    );
    expect(declineMessage).toMatch(/why .* declined/i);

    const infoMessage = await expectRefused(
      asUser(
        people.oscar,
        `select public.specialty_update_carrier_market(
           ${quote(canalMarket)}, '{"status":"more_info_needed"}'::jsonb, ${Number(before.version)});`,
      ),
    );
    expect(infoMessage).toMatch(/asking for/i);
  }, 60_000);

  it('keeps a submitted market as history rather than allowing a delete', async () => {
    const message = await expectRefused(
      asUser(
        people.oscar,
        `select public.specialty_remove_carrier_market(${quote(progressiveMarket)});`,
      ),
    );
    expect(message).toMatch(/Withdrawn/i);
  }, 60_000);

  it('allows removing a market nobody has approached', async () => {
    const [scratch] = await runSql(`
      insert into public.specialty_carriers (name, lines_of_business, created_by)
      values (${quote(`Scratch Carrier ${MARKER}`)}, '{trucking}', ${quote(people.oscar)})
      returning id::text;
    `);
    await asUser(
      people.oscar,
      `select public.specialty_add_carrier_market(${quote(truckingOpportunity)}, ${quote(String(scratch.id))});`,
    );
    const [market] = await runSql(`
      select id::text from public.specialty_carrier_markets
       where opportunity_id = ${quote(truckingOpportunity)} and carrier_id = ${quote(String(scratch.id))};
    `);
    await asUser(
      people.oscar,
      `select public.specialty_remove_carrier_market(${quote(String(market.id))});`,
    );
    const [after] = await runSql(`
      select count(*) as n from public.specialty_carrier_markets where id = ${quote(String(market.id))};
    `);
    expect(Number(after.n)).toBe(0);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Customer pricing and outcome
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('customer pricing is an explicit act', () => {
  it('records what was sent, freezes it, and moves the quote to Price Sent', async () => {
    const [market] = await runSql(`
      select m.id::text, m.presented_at is null as not_yet_sent, o.version
      from public.specialty_carrier_markets m
      join public.specialty_opportunities o on o.id = m.opportunity_id
      where m.opportunity_id = ${quote(truckingOpportunity)} and m.status = 'quote_received';
    `);
    // Receiving a quote did not mark it as sent.
    expect(market.not_yet_sent).toBe(true);

    await asUser(
      people.jason,
      `select public.specialty_record_price_sent(
         ${quote(truckingOpportunity)},
         array[${quote(String(market.id))}]::uuid[],
         'whatsapp', 'Sent the Progressive option', ${Number(market.version)});`,
    );

    const [row] = await runSql(`
      select o.stage, o.price_sent_at is not null as sent,
             p.presented_by::text as presented_by, p.method,
             p.options -> 0 ->> 'premium' as snapshot_premium,
             (select m2.presented_at is not null from public.specialty_carrier_markets m2
               where m2.id = ${quote(String(market.id))}) as market_marked
      from public.specialty_opportunities o
      join public.specialty_price_presentations p on p.opportunity_id = o.id
      where o.id = ${quote(truckingOpportunity)};
    `);
    expect(row.stage).toBe('price_sent');
    expect(row.sent).toBe(true);
    expect(row.presented_by).toBe(people.jason);
    expect(row.method).toBe('whatsapp');
    expect(Number(row.snapshot_premium)).toBe(18420);
    expect(row.market_marked).toBe(true);

    // Correcting the carrier premium afterwards must not rewrite what the customer was
    // told. That is why the presentation stores a snapshot.
    const [beforeEdit] = await runSql(
      `select version from public.specialty_carrier_markets where id = ${quote(String(market.id))};`,
    );
    await asUser(
      people.oscar,
      `select public.specialty_update_carrier_market(
         ${quote(String(market.id))}, '{"premium":19999}'::jsonb, ${Number(beforeEdit.version)});`,
    );
    const [frozen] = await runSql(`
      select p.options -> 0 ->> 'premium' as snapshot_premium, m.premium as live_premium
      from public.specialty_price_presentations p
      join public.specialty_carrier_markets m on m.id = ${quote(String(market.id))}
      where p.opportunity_id = ${quote(truckingOpportunity)};
    `);
    expect(Number(frozen.snapshot_premium)).toBe(18420);
    expect(Number(frozen.live_premium)).toBe(19999);
  }, 60_000);
});

describeAgainstProject('recording the result', () => {
  it('refuses Not Sold without a reason', async () => {
    const [current] = await runSql(
      `select version from public.specialty_opportunities where id = ${quote(truckingOpportunity)};`,
    );
    const message = await expectRefused(
      asUser(
        people.jason,
        `select public.specialty_record_result(
           ${quote(truckingOpportunity)}, 'not_sold', null, null, null, null, ${Number(current.version)});`,
      ),
    );
    expect(message).toMatch(/Choose a reason/i);
  }, 60_000);

  it('refuses Sold without a bound carrier', async () => {
    const [current] = await runSql(
      `select version from public.specialty_opportunities where id = ${quote(truckingOpportunity)};`,
    );
    const message = await expectRefused(
      asUser(
        people.jason,
        `select public.specialty_record_result(
           ${quote(truckingOpportunity)}, 'sold', null, 18420, null, null, ${Number(current.version)});`,
      ),
    );
    expect(message).toMatch(/which carrier/i);
  }, 60_000);

  it('records Sold with the carrier, the premium and both the actor and the assignee', async () => {
    const [state] = await runSql(`
      select o.version, m.id::text as market_id
      from public.specialty_opportunities o
      join public.specialty_carrier_markets m on m.opportunity_id = o.id and m.status = 'quote_received'
      where o.id = ${quote(truckingOpportunity)};
    `);

    // Oscar records the sale on Jason's quote. Both facts must survive.
    await asUser(
      people.oscar,
      `select public.specialty_record_result(
         ${quote(truckingOpportunity)}, 'sold', ${quote(String(state.market_id))}, 19999, null, null, ${Number(state.version)});`,
    );

    const [row] = await runSql(`
      select o.stage, o.result, o.sold_premium, o.finalized_at is not null as closed,
             o.result_recorded_by::text as recorded_by,
             o.primary_assignee_id::text as assignee,
             c.name as bound_carrier,
             (select a.detail ->> 'primary_assignee_id' from public.specialty_activity a
               where a.opportunity_id = o.id and a.event_type = 'result_recorded'
               order by a.created_at desc limit 1) as logged_assignee,
             (select a.actor_profile_id::text from public.specialty_activity a
               where a.opportunity_id = o.id and a.event_type = 'result_recorded'
               order by a.created_at desc limit 1) as logged_actor
      from public.specialty_opportunities o
      left join public.specialty_carriers c on c.id = o.bound_carrier_id
      where o.id = ${quote(truckingOpportunity)};
    `);
    expect(row.stage).toBe('sold');
    expect(row.result).toBe('sold');
    expect(Number(row.sold_premium)).toBe(19999);
    expect(row.closed).toBe(true);
    expect(row.bound_carrier).toBe('Progressive');
    expect(row.recorded_by).toBe(people.oscar);
    expect(row.assignee).toBe(people.jason);
    // The audit keeps the two apart rather than inferring one from the other.
    expect(row.logged_actor).toBe(people.oscar);
    expect(row.logged_assignee).toBe(people.jason);
  }, 60_000);

  it('only lets a manager reopen a closed quote', async () => {
    // Brenda is customer_service and not a manager, and not on this team.
    const refused = await expectRefused(
      asUser(people.brenda, `select public.specialty_clear_result(${quote(truckingOpportunity)});`),
    );
    expect(refused).toMatch(/Only a manager/i);

    // Oscar is super_admin, so management oversight applies.
    await asUser(
      people.oscar,
      `select public.specialty_clear_result(${quote(truckingOpportunity)}, 'follow_up', 'Reopened by the integration suite');`,
    );
    const [row] = await runSql(`
      select stage, result from public.specialty_opportunities where id = ${quote(truckingOpportunity)};
    `);
    expect(row.stage).toBe('follow_up');
    expect(row.result).toBeNull();
  }, 60_000);

  it('records Not Sold with a structured reason', async () => {
    const [current] = await runSql(
      `select version from public.specialty_opportunities where id = ${quote(truckingOpportunity)};`,
    );
    await asUser(
      people.jason,
      `select public.specialty_record_result(
         ${quote(truckingOpportunity)}, 'not_sold', null, null, 'price_too_high',
         'Customer stayed put', ${Number(current.version)});`,
    );
    const [row] = await runSql(`
      select stage, result, lost_reason, lost_reason_note
      from public.specialty_opportunities where id = ${quote(truckingOpportunity)};
    `);
    expect(row.stage).toBe('not_sold');
    expect(row.result).toBe('not_sold');
    expect(row.lost_reason).toBe('price_too_high');
    expect(row.lost_reason_note).toBe('Customer stayed put');
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Reassignment
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('reassignment is explicit and audited', () => {
  it('records the previous assignee, the new one, and who changed it', async () => {
    await asUser(
      people.oscar,
      `select public.specialty_reassign_opportunity(
         ${quote(truckingOpportunity)}, ${quote(people.oscar)}, 'Covering while Jason is out');`,
    );

    const [row] = await runSql(`
      select o.primary_assignee_id::text as assignee,
             a.actor_profile_id::text as actor,
             a.detail ->> 'previous_assignee_id' as previous,
             a.detail ->> 'new_assignee_id' as next,
             a.detail ->> 'reason' as reason,
             a.created_at is not null as stamped
      from public.specialty_opportunities o
      join public.specialty_activity a on a.opportunity_id = o.id and a.event_type = 'reassigned'
      where o.id = ${quote(truckingOpportunity)}
      order by a.created_at desc limit 1;
    `);
    expect(row.assignee).toBe(people.oscar);
    expect(row.actor).toBe(people.oscar);
    expect(row.previous).toBe(people.jason);
    expect(row.next).toBe(people.oscar);
    expect(row.reason).toBe('Covering while Jason is out');
    expect(row.stamped).toBe(true);
  }, 60_000);

  it('refuses to assign somebody who is not on the team', async () => {
    const message = await expectRefused(
      asUser(
        people.oscar,
        `select public.specialty_reassign_opportunity(${quote(truckingOpportunity)}, ${quote(people.brenda)});`,
      ),
    );
    expect(message).toMatch(/cannot be assigned work on this team/i);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Contribution reporting
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('contribution reporting credits the person who acted', () => {
  it('shows Oscar contributing to a quote Jason was assigned', async () => {
    const rows = await readAsUser(
      people.oscar,
      `select r.display_name, r.primary_count, r.contributed_count,
              r.carrier_submissions, r.carrier_quotes_recorded, r.total_actions
       from public.specialty_report_contributions() r
       where r.display_name in ('Oscar Landaverde', 'Jason Toro');`,
    );

    const oscar = rows.find((row) => String(row.display_name).startsWith('Oscar'));
    const jason = rows.find((row) => String(row.display_name).startsWith('Jason'));
    expect(oscar, 'Oscar should appear as a contributor').toBeDefined();
    expect(jason, 'Jason should appear as a contributor').toBeDefined();

    // Oscar recorded the Progressive premium and submitted Canal; the counts are his.
    expect(Number(oscar!.carrier_quotes_recorded)).toBeGreaterThan(0);
    expect(Number(oscar!.contributed_count)).toBeGreaterThan(0);
    // Jason submitted Progressive.
    expect(Number(jason!.carrier_submissions)).toBeGreaterThan(0);
  }, 60_000);

  it('lists both employees as contributors on the opportunity detail', async () => {
    const [row] = await readAsUser(
      people.jason,
      `select public.specialty_opportunity_detail(${quote(truckingOpportunity)}) as payload;`,
    );
    const payload = row.payload as Record<string, unknown>;
    const contributors = payload.contributors as Record<string, unknown>[];
    const ids = contributors.map((entry) => String(entry.profile_id));
    expect(ids).toContain(people.oscar);
    expect(ids).toContain(people.jason);
    // Brenda contributed too, through the Customer Service callback.
    expect(ids).toContain(people.brenda);
  }, 60_000);

  it('withholds reporting from a non-member', async () => {
    const message = await expectRefused(
      readAsUser(people.outsider, `select * from public.specialty_report_contributions();`),
    );
    expect(message).toMatch(/not available for your account/i);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Quote Center integration
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('Quote Center keeps the journey', () => {
  it('reports the specialty stage and reference instead of a commercial-board label', async () => {
    const [row] = await runSql(`
      select j.stage, j.stage_label, j.specialty_reference,
             j.specialty_opportunity_id::text as opportunity_id,
             j.assigned_agent_name, j.decision, j.finalized_at is not null as closed
      from public.quote_center_journeys j
      where j.intake_id = ${quote(truckingIntake)};
    `);
    expect(row.opportunity_id).toBe(truckingOpportunity);
    // Not Sold maps onto the Closed bucket, with the decision carried through so the
    // chip colours correctly.
    expect(row.stage).toBe('closed');
    expect(row.stage_label).toBe('Not Sold');
    expect(row.decision).toBe('not_sold');
    expect(row.closed).toBe(true);
    expect(String(row.specialty_reference)).toMatch(/^SQ-/);
    // The person accountable now, not the intake's claimer.
    expect(String(row.assigned_agent_name)).toMatch(/Oscar/);
  }, 60_000);

  it('finds the customer by the specialty reference through the search', async () => {
    const [reference] = await runSql(
      `select reference from public.specialty_opportunities where id = ${quote(truckingOpportunity)};`,
    );
    const rows = await readAsUser(
      people.brenda,
      `select intake_id::text, stage_label from public.quote_center_search(${quote(String(reference.reference))});`,
    );
    expect(rows.map((row) => String(row.intake_id))).toContain(truckingIntake);
  }, 60_000);

  it('keeps the journey visible to Customer Service even though the quote is not', async () => {
    // Brenda cannot read the opportunity, and can still answer "where is my customer".
    const [journey] = await readAsUser(
      people.brenda,
      `select count(*) as n from public.quote_center_search(${quote(`Trucking ${MARKER}`)});`,
    );
    expect(Number(journey.n)).toBeGreaterThan(0);

    const [blocked] = await readAsUser(
      people.brenda,
      `select public.specialty_can_view_opportunity(${quote(truckingOpportunity)}) as can_view;`,
    );
    expect(blocked.can_view).toBe(false);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Legacy migration
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('legacy migration', () => {
  it('adopted every routable live trucking or homeowners card', async () => {
    const [row] = await runSql(`
      select count(*) as unadopted
      from public.commercial_quotes q
      where q.coverage_type in ('trucking','homeowners')
        and coalesce(q.is_deleted, false) = false
        and q.migrated_to_specialty_at is null
        and exists (select 1 from public.quoting_team_lob_routes r
                    join public.quoting_teams t on t.id = r.team_id
                    where r.line_of_business = q.coverage_type and r.is_active and t.is_active);
    `);
    expect(Number(row.unadopted)).toBe(0);
  }, 60_000);

  it('kept the commercial rows and all of their children', async () => {
    const rows = await runSql(`
      select q.id::text,
             q.migrated_to_specialty_at is not null as stamped,
             q.migrated_to_specialty_id::text as opportunity_id,
             (select count(*) from public.commercial_quote_comments c where c.quote_id = q.id) as comments,
             (select count(*) from public.commercial_quote_attachments a where a.quote_id = q.id) as attachments,
             (select count(*) from public.commercial_quote_column_history h where h.quote_id = q.id) as history,
             o.id::text as adopted_id,
             o.created_at = q.created_at as timestamps_preserved,
             (select count(*) from public.specialty_notes n where n.opportunity_id = o.id) as notes,
             (select count(*) from public.specialty_documents d
               where d.opportunity_id = o.id and d.storage_bucket = 'commercial-quote-attachments') as legacy_docs
      from public.commercial_quotes q
      join public.specialty_opportunities o on o.legacy_commercial_quote_id = q.id;
    `);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.stamped).toBe(true);
      expect(row.opportunity_id).toBe(row.adopted_id);
      // Original created_at carried over, so aging does not restart.
      expect(row.timestamps_preserved).toBe(true);
      // Every comment is represented as a note (plus the preserved description).
      expect(Number(row.notes)).toBeGreaterThanOrEqual(Number(row.comments));
      expect(Number(row.legacy_docs)).toBe(Number(row.attachments));
    }
  }, 60_000);

  it('links the adopted opportunity to the intake that started it', async () => {
    const [row] = await runSql(`
      select count(*) as n
      from public.specialty_opportunities o
      join public.cs_intake_submissions s on s.id = o.source_intake_id
      where o.source = 'legacy_commercial'
        and s.source_commercial_quote_id = o.legacy_commercial_quote_id;
    `);
    // The customer's Quote Center journey stays continuous across the migration.
    expect(Number(row.n)).toBeGreaterThan(0);
  }, 60_000);

  it('leaves no adopted card live on the board', async () => {
    const [row] = await runSql(`
      select count(*) as n
      from public.commercial_quotes q
      join public.specialty_opportunities o on o.legacy_commercial_quote_id = q.id
      where q.migrated_to_specialty_at is null;
    `);
    expect(Number(row.n)).toBe(0);
  }, 60_000);

  it('never stamped a commercial_gl card', async () => {
    const [row] = await runSql(`
      select count(*) as n from public.commercial_quotes
       where migrated_to_specialty_at is not null
         and coverage_type not in ('trucking','homeowners');
    `);
    expect(Number(row.n)).toBe(0);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration-driven teams
// ═══════════════════════════════════════════════════════════════════════════════

describeAgainstProject('a new team works without a code change', () => {
  const TEST_TEAM = `Test Specialty Team ${MARKER}`;

  it('refuses team creation to anyone but a manager', async () => {
    // Including the database owner: the gate reads auth.uid(), so an unauthenticated
    // caller is refused rather than treated as privileged.
    const message = await expectRefused(
      asUser(
        people.outsider,
        `select public.specialty_team_save(null, ${quote(TEST_TEAM)}, null, 'shared_claim', true, 'team', true);`,
      ),
    );
    expect(message).toMatch(/Only a manager/i);
  }, 60_000);

  it('creates a team, adds a member, and that member immediately gains access', async () => {
    // Run as a manager, because team configuration is manager-gated.
    await asUser(
      people.oscar,
      `select public.specialty_team_save(null, ${quote(TEST_TEAM)},
         'Created by the integration suite', 'shared_claim', true, 'team', true);`,
    );
    const [created] = await runSql(`
      select id::text from public.quoting_teams where name = ${quote(TEST_TEAM)};
    `);
    const teamId = String(created?.id ?? 'null');
    expect(teamId).not.toBe('null');

    // Before membership: the outsider has no access at all.
    const [before] = await readAsUser(
      people.outsider,
      `select public.specialty_can_access() as can_access;`,
    );
    expect(before.can_access).toBe(false);

    await asUser(
      people.oscar,
      `select public.specialty_team_save_member(${quote(teamId)}, ${quote(people.outsider)},
         true, true, true, true, true, true);`,
    );

    // After membership: access, with no role change and no code change.
    const [after] = await readAsUser(
      people.outsider,
      `select public.specialty_can_access() as can_access;`,
    );
    expect(after.can_access).toBe(true);

    // Configuration is manager-only.
    const refused = await expectRefused(
      asUser(
        people.outsider,
        `select public.specialty_team_save_member(${quote(teamId)}, ${quote(people.outsider)});`,
      ),
    );
    expect(refused).toMatch(/Only a manager/i);

    await runSql(`
      delete from public.quoting_team_members where team_id = ${quote(teamId)};
      delete from public.quoting_teams where id = ${quote(teamId)};
    `);
  }, 120_000);

  it('will not deactivate the only destination for a routed line', async () => {
    const message = await expectRefused(
      asUser(
        people.oscar,
        `select public.specialty_team_save(${quote(people.truckingTeam)}, 'Trucking Team',
           null, 'shared_claim', true, 'team', false);`,
      ),
    );
    expect(message).toMatch(/only active destination/i);
  }, 60_000);

  it('will not remove a member who still holds active assignments without a transfer', async () => {
    // Give Oscar an active homeowners assignment to hold.
    const [intake] = await runSql(`
      insert into public.cs_intake_submissions (
        status, line_of_business, created_by, insured_first_name, insured_last_name,
        insured_phone_primary, property_address_street
      ) values ('draft', 'homeowners', ${quote(people.brenda)}, 'Held',
        ${quote(`Assignment ${MARKER}`)}, '7045550004', '1 Held Street')
      returning id::text;
    `);
    await asUser(
      people.brenda,
      `select public.cs_intake_submit_specialty(${quote(String(intake.id))});`,
    );
    const [opportunity] = await runSql(`
      select id::text from public.specialty_opportunities
       where source_intake_id = ${quote(String(intake.id))};
    `);
    await runSql(`
      update public.specialty_opportunities set display_name = display_name
       where id = ${quote(String(opportunity.id))};
    `);
    await asUser(
      people.oscar,
      `select public.specialty_claim_opportunity(${quote(String(opportunity.id))});`,
    );

    const message = await expectRefused(
      asUser(
        people.jason,
        `select public.specialty_team_remove_member(${quote(people.homeownersTeam)}, ${quote(people.oscar)}, 'testing');`,
      ),
    );
    expect(message).toMatch(/active assignment/i);

    // With a transfer target it succeeds, and the work moves rather than being stranded.
    const [result] = await asUser(
      people.jason,
      `select (public.specialty_team_remove_member(${quote(people.homeownersTeam)}, ${quote(people.oscar)},
         'testing', ${quote(people.brenda)}) ->> 'reassigned_count') as moved;`,
    ).then(() =>
      runSql(`
        select o.primary_assignee_id::text as assignee,
               (select count(*) from public.quoting_team_members m
                 where m.team_id = ${quote(people.homeownersTeam)}
                   and m.profile_id = ${quote(people.oscar)}) as membership_rows,
               (select m.is_active from public.quoting_team_members m
                 where m.team_id = ${quote(people.homeownersTeam)}
                   and m.profile_id = ${quote(people.oscar)}) as still_active
        from public.specialty_opportunities o where o.id = ${quote(String(opportunity.id))};
      `),
    );
    expect(result.assignee).toBe(people.brenda);
    // Retired, not deleted: the membership row survives so history keeps its meaning.
    expect(Number(result.membership_rows)).toBe(1);
    expect(result.still_active).toBe(false);

    // Restore the seeded configuration so the suite leaves nothing behind.
    await asUser(
      people.jason,
      `select public.specialty_team_save_member(${quote(people.homeownersTeam)}, ${quote(people.oscar)},
         true, true, true, true, true, true);`,
    );
    const [restored] = await runSql(`
      select is_active, removed_at is null as cleared from public.quoting_team_members
       where team_id = ${quote(people.homeownersTeam)} and profile_id = ${quote(people.oscar)};
    `);
    expect(restored.is_active).toBe(true);
    expect(restored.cleared).toBe(true);
  }, 180_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Every read surface actually returns rows
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The regression guard for the bug that reached production.
 *
 * `specialty_search_opportunities` was catalogued correctly, was `security definer`,
 * had the right signature, and raised 42804 — "structure of query does not match
 * function result type" — on every single call, because the view exposed `mc_number`
 * as `varchar(20)` while the function declared `text`. The Work screen showed nothing
 * but an error.
 *
 * v1.16.3's post-conditions only checked that these functions existed. A function
 * whose body has never run can be perfectly catalogued and still be incapable of
 * returning a row, so existence is not a useful assertion. Executing each one is.
 *
 * Two other classes of failure are caught here for free, both of which also happened:
 * PL/pgSQL variable/column ambiguity (42702) and Postgres's 100-argument call limit
 * (54023). All three are properties of the database rather than of the SQL text, so no
 * unit test can reach them.
 */
describeAgainstProject('every read and report function executes', () => {
  const READS = [
    'select count(*) as n from public.specialty_search_opportunities()',
    'select count(*) as n from public.specialty_stage_counts()',
    'select public.specialty_workspace_context() is not null as n',
    'select count(*) as n from public.specialty_report_pipeline()',
    'select count(*) as n from public.specialty_report_workload()',
    'select count(*) as n from public.specialty_report_contributions()',
    'select count(*) as n from public.specialty_report_timing()',
    'select count(*) as n from public.specialty_report_carrier_performance()',
    'select count(*) as n from public.specialty_report_lost_business()',
    'select count(*) as n from public.specialty_report_attention()',
  ];

  it.each(READS)('runs: %s', async (statement) => {
    // As a team member, so the access gate passes and the body is reached.
    const [row] = await readAsUser(people.jason, `${statement};`);
    expect(row).toBeDefined();
  }, 60_000);

  it('returns the full row shape from the search, including mc_number', async () => {
    const rows = await readAsUser(
      people.jason,
      `select id::text, reference, mc_number, dot_number, sold_premium, best_premium,
              markets_total, open_information_count, is_overdue, version, total_count
       from public.specialty_search_opportunities(null, 'all', 'all', null, 'team', null, 'all', 100, 0);`,
    );
    expect(rows.length).toBeGreaterThan(0);
    // The column that broke it. Present, and typed as text over the wire.
    expect(rows[0]).toHaveProperty('mc_number');
    expect(rows[0]).toHaveProperty('total_count');
  }, 60_000);

  it('opens the detail payload for every opportunity a member can see', async () => {
    const rows = await readAsUser(
      people.jason,
      `select id::text from public.specialty_search_opportunities(null, 'all', 'all', null, 'team', null, 'all', 100, 0);`,
    );
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const [detail] = await readAsUser(
        people.jason,
        `select public.specialty_opportunity_detail(${quote(String(row.id))}) as payload;`,
      );
      const payload = detail.payload as Record<string, unknown>;
      expect(payload.opportunity, String(row.id)).toBeDefined();
      expect(Array.isArray(payload.carrier_markets), String(row.id)).toBe(true);
      expect(Array.isArray(payload.contributors), String(row.id)).toBe(true);
    }
  }, 120_000);

  it('exposes no varchar column on the row view, because every reader declares text', async () => {
    // The root cause, asserted directly: a varchar on the view is a 42804 waiting for
    // whichever function names that column next.
    const rows = await runSql(`
      select a.attname
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'specialty_opportunity_rows'
        and a.attnum > 0 and not a.attisdropped
        and format_type(a.atttypid, a.atttypmod) like 'character varying%';
    `);
    expect(rows.map((row) => row.attname)).toEqual([]);
  }, 60_000);
});

/**
 * The Specialty Quote workspace's derived readings, tested as rules.
 *
 * `workflow.ts` is the one place that answers "where is this quote, and what do I need
 * to do next". Three surfaces ask it — the progress rail, the Overview and the list —
 * so if the priority order drifts, three screens disagree with each other and with the
 * quote. These tests state the order as executable claims.
 *
 * The claim worth defending hardest is the *ordering*, not any single answer: a carrier
 * that has asked a question outranks a missing loss run, because an underwriter who has
 * asked has already stopped work. That is a judgement, and a judgement is exactly the
 * kind of thing that gets quietly reversed by a later edit.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  parseListState,
  listStateToParams,
  defaultListState,
  safeBackHref,
  specialtyListHref,
  specialtyQuoteHref,
  type SpecialtyListState,
} from '../list-state';
import { documentGroup, formatLimit } from '../application';
import { parseTab } from '../workflow';
import {
  blockedCarriers,
  carrierGroup,
  deriveNextAction,
  listNextAction,
  nextActionSummary,
  phaseForStage,
  quoteHealth,
  quotedMarkets,
  tallyCarriers,
  workflowProgress,
  type CarrierFacts,
  type QuoteFacts,
  type QuoteState,
  type RowFacts,
} from '../workflow';
import { STAGE_ORDER, CARRIER_STATUS_ORDER } from '../status';
import type { CarrierMarketStatus, SpecialtyStage } from '../types';

// ── Builders ─────────────────────────────────────────────────────────────────

function facts(overrides: Partial<QuoteFacts> = {}): QuoteFacts {
  return {
    stage: 'ready_to_market',
    result: null,
    primary_assignee_id: 'profile-oscar',
    next_action: null,
    next_action_due: null,
    is_overdue: false,
    is_due_today: false,
    price_sent_at: null,
    bound_carrier_name: null,
    sold_premium: null,
    documents_count: 0,
    ...overrides,
  };
}

let carrierSeq = 0;
function carrier(
  status: CarrierMarketStatus,
  overrides: Partial<CarrierFacts> = {},
): CarrierFacts {
  carrierSeq += 1;
  const approached = !['not_started', 'preparing'].includes(status);
  return {
    id: `market-${carrierSeq}`,
    carrier_name: `Carrier ${carrierSeq}`,
    status,
    premium: status === 'quote_received' ? 14_820 : null,
    presented_at: null,
    info_requested: status === 'more_info_needed' ? 'Driver experience' : null,
    submitted_at: approached ? '2026-08-19T10:00:00Z' : null,
    ...overrides,
  };
}

function state(overrides: Partial<QuoteState> = {}): QuoteState {
  return {
    opportunity: facts(),
    carrier_markets: [],
    information_requests: [],
    has_intake: true,
    ...overrides,
  };
}

// ── Carrier grouping ─────────────────────────────────────────────────────────

describe('carrier grouping', () => {
  it('assigns every stored status to exactly one group', () => {
    // The nine values are the CHECK constraint on specialty_carrier_markets. A status
    // added to the database and not to this switch would be a silent gap in every
    // count on the Carriers tab.
    for (const status of CARRIER_STATUS_ORDER) {
      expect(carrierGroup(status)).toBeTypeOf('string');
    }
  });

  it('keeps declined, not competitive and withdrawn out of the working groups', () => {
    // They are closed answers. Counting them as "awaiting" would make a finished quote
    // read as still being marketed.
    expect(carrierGroup('declined')).toBe('closed');
    expect(carrierGroup('not_competitive')).toBe('closed');
    expect(carrierGroup('withdrawn')).toBe('closed');
  });

  it('counts submitted from the submission stamp, not from the current status', () => {
    // A carrier that was submitted and then declined is still part of the marketing
    // history. Deriving "submitted" from the status would lose it.
    const tally = tallyCarriers([
      carrier('declined'),
      carrier('quote_received'),
      carrier('not_started'),
    ]);
    expect(tally.total).toBe(3);
    expect(tally.submitted).toBe(2);
    expect(tally.pending).toBe(1);
    expect(tally.quoted).toBe(1);
    expect(tally.closed).toBe(1);
  });

  it('takes the best premium from quoted markets only', () => {
    const tally = tallyCarriers([
      carrier('quote_received', { premium: 18_000 }),
      carrier('quote_received', { premium: 14_820 }),
      // A premium recorded against a declined market must not win the comparison.
      carrier('declined', { premium: 1 }),
    ]);
    expect(tally.bestPremium).toBe(14_820);
  });

  it('sorts the viable options cheapest first and excludes the rest', () => {
    const options = quotedMarkets([
      carrier('quote_received', { premium: 18_000 }),
      carrier('waiting'),
      carrier('quote_received', { premium: 14_820 }),
      carrier('quote_received', { premium: null }),
    ]);
    expect(options.map((option) => option.premium)).toEqual([14_820, 18_000]);
  });
});

// ── The workflow rail ────────────────────────────────────────────────────────

describe('workflow progress', () => {
  it('places every stage in a phase', () => {
    for (const stage of STAGE_ORDER) {
      expect(phaseForStage(stage)).toBeTypeOf('string');
    }
  });

  it('marks earlier phases done and later ones upcoming', () => {
    const phases = workflowProgress(state({ opportunity: facts({ stage: 'options_ready' }) }));
    expect(phases.map((phase) => phase.state)).toEqual([
      'done',
      'done',
      'current',
      'upcoming',
      'upcoming',
    ]);
  });

  it('reads the caption from the carriers rather than repeating the stage', () => {
    const phases = workflowProgress(
      state({
        opportunity: facts({ stage: 'marketing' }),
        carrier_markets: [carrier('submitted'), carrier('waiting'), carrier('not_started')],
      }),
    );
    expect(phases[1].caption).toBe('2 of 3 submitted');
  });

  it('flags the current phase as blocked when a carrier is waiting on information', () => {
    const phases = workflowProgress(
      state({
        opportunity: facts({ stage: 'options_ready' }),
        carrier_markets: [carrier('more_info_needed')],
      }),
    );
    expect(phases[2].isBlocked).toBe(true);
  });

  it('never reports more than one current phase', () => {
    fc.assert(
      fc.property(fc.constantFrom(...STAGE_ORDER), (stage: SpecialtyStage) => {
        const phases = workflowProgress(state({ opportunity: facts({ stage }) }));
        return phases.filter((phase) => phase.state === 'current').length === 1;
      }),
    );
  });
});

// ── Quote health ─────────────────────────────────────────────────────────────

describe('quote health', () => {
  it('names what is missing instead of scoring it', () => {
    const health = quoteHealth(
      state({
        information_requests: [{ label: 'Loss runs', status: 'requested' }],
        carrier_markets: [
          carrier('more_info_needed', {
            carrier_name: 'Eastern',
            info_requested: 'driver experience',
          }),
        ],
      }),
    );
    expect(health.applicationComplete).toBe(false);
    expect(health.missing).toEqual([
      'Loss runs',
      'Eastern requested driver experience',
    ]);
  });

  it('treats a resolved request as resolved', () => {
    const health = quoteHealth(
      state({
        information_requests: [
          { label: 'Loss runs', status: 'received' },
          { label: 'MVRs', status: 'waived' },
        ],
      }),
    );
    expect(health.applicationComplete).toBe(true);
    expect(health.missing).toEqual([]);
  });

  it('says so when there is no linked intake at all', () => {
    const health = quoteHealth(state({ has_intake: false }));
    expect(health.applicationComplete).toBe(false);
    expect(health.missing.join(' ')).toMatch(/no linked intake/i);
  });
});

// ── The next action ──────────────────────────────────────────────────────────

describe('next action', () => {
  it('puts a carrier request ahead of a missing document', () => {
    // The judgement this whole ordering rests on: an underwriter who has asked a
    // question has already stopped that submission, so it outranks a document the
    // team is still chasing.
    const action = deriveNextAction(
      state({
        information_requests: [{ label: 'Loss runs', status: 'requested' }],
        carrier_markets: [
          carrier('more_info_needed', { carrier_name: 'Eastern', info_requested: 'Driver experience' }),
        ],
      }),
    );
    expect(action.key).toBe('carrier_needs_information');
    expect(action.tab).toBe('carriers');
    expect(action.headline).toContain('Eastern');
    expect(action.detail).toBe('Driver experience');
  });

  it('points at the one carrier when only one is asking, and at none when several are', () => {
    const one = deriveNextAction(
      state({ carrier_markets: [carrier('more_info_needed', { id: 'market-eastern' })] }),
    );
    expect(one.carrierMarketId).toBe('market-eastern');

    const many = deriveNextAction(
      state({ carrier_markets: [carrier('more_info_needed'), carrier('more_info_needed')] }),
    );
    expect(many.carrierMarketId).toBeNull();
  });

  it('falls to the outstanding information list when no carrier is asking', () => {
    const action = deriveNextAction(
      state({ information_requests: [{ label: 'Loss runs', status: 'needed' }] }),
    );
    expect(action.key).toBe('information_outstanding');
    expect(action.headline).toContain('Loss runs');
  });

  it('asks for a claim before asking for carriers', () => {
    const action = deriveNextAction(
      state({ opportunity: facts({ primary_assignee_id: null }) }),
    );
    expect(action.key).toBe('unclaimed');
  });

  it('asks for carriers when there are none', () => {
    expect(deriveNextAction(state()).key).toBe('no_carriers');
  });

  it('prefers sending a price in hand over chasing one more carrier', () => {
    // A quote the customer has not seen is worth more than another underwriter's
    // answer, so this outranks "waiting on carrier responses".
    const action = deriveNextAction(
      state({
        opportunity: facts({ stage: 'options_ready' }),
        carrier_markets: [carrier('quote_received'), carrier('waiting')],
      }),
    );
    expect(action.key).toBe('prices_ready_to_send');
  });

  it('stops asking to send once something has been presented', () => {
    const action = deriveNextAction(
      state({
        opportunity: facts({ stage: 'price_sent', price_sent_at: '2026-08-19T10:00:00Z' }),
        carrier_markets: [
          carrier('quote_received', { presented_at: '2026-08-19T10:00:00Z' }),
        ],
      }),
    );
    expect(action.key).toBe('awaiting_customer_decision');
  });

  it('raises an overdue customer follow-up above chasing carriers', () => {
    const action = deriveNextAction(
      state({
        opportunity: facts({
          stage: 'follow_up',
          price_sent_at: '2026-08-18T10:00:00Z',
          is_overdue: true,
          next_action: 'Call Miguel back',
        }),
        carrier_markets: [
          carrier('quote_received', { presented_at: '2026-08-18T10:00:00Z' }),
          carrier('waiting'),
        ],
      }),
    );
    expect(action.key).toBe('follow_up_due');
    expect(action.detail).toBe('Call Miguel back');
  });

  it('asks to work the submissions when nothing has gone out yet', () => {
    const action = deriveNextAction(
      state({ carrier_markets: [carrier('preparing'), carrier('not_started')] }),
    );
    expect(action.key).toBe('ready_to_submit');
  });

  it('waits on the carriers when everything is out and nothing is back', () => {
    const action = deriveNextAction(
      state({
        opportunity: facts({ stage: 'marketing' }),
        carrier_markets: [carrier('submitted'), carrier('waiting')],
      }),
    );
    expect(action.key).toBe('awaiting_carrier_responses');
  });

  it('asks for a result when every carrier has closed out', () => {
    const action = deriveNextAction(
      state({
        opportunity: facts({ stage: 'marketing' }),
        carrier_markets: [carrier('declined'), carrier('not_competitive')],
      }),
    );
    expect(action.key).toBe('record_result');
  });

  it('says nothing is needed on a recorded outcome, whatever the carriers say', () => {
    for (const result of ['sold', 'not_sold'] as const) {
      const action = deriveNextAction(
        state({
          opportunity: facts({
            stage: result,
            result,
            bound_carrier_name: 'All Star',
            sold_premium: 14_820,
          }),
          // Deliberately noisy: a closed quote must not ask for anything.
          carrier_markets: [carrier('more_info_needed')],
          information_requests: [{ label: 'Loss runs', status: 'needed' }],
        }),
      );
      expect(action.key).toBe('closed');
    }
  });

  it('always returns an action, for every combination of stage and carrier status', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STAGE_ORDER),
        fc.array(fc.constantFrom(...CARRIER_STATUS_ORDER), { maxLength: 5 }),
        fc.boolean(),
        (stage: SpecialtyStage, statuses: CarrierMarketStatus[], outstanding: boolean) => {
          const result: QuoteFacts['result'] =
            stage === 'sold' ? 'sold' : stage === 'not_sold' ? 'not_sold' : null;
          const action = deriveNextAction(
            state({
              opportunity: facts({ stage, result }),
              carrier_markets: statuses.map((status) => carrier(status)),
              information_requests: outstanding
                ? [{ label: 'Loss runs', status: 'needed' }]
                : [],
            }),
          );
          return (
            typeof action.headline === 'string' &&
            action.headline.length > 0 &&
            typeof action.actionLabel === 'string' &&
            action.actionLabel.length > 0
          );
        },
      ),
    );
  });
});

describe('next action summary', () => {
  it('prefers what a teammate wrote by hand', () => {
    // A list is scanned, and "Called underwriting, reviewing today" is more specific
    // than anything derivable from state.
    const summary = nextActionSummary(
      state({
        opportunity: facts({ next_action: 'Chase Commonwealth for the quote' }),
        carrier_markets: [carrier('more_info_needed')],
      }),
    );
    expect(summary).toBe('Chase Commonwealth for the quote');
  });

  it('falls back to the derived reading when nobody has written one', () => {
    const summary = nextActionSummary(
      state({ carrier_markets: [carrier('more_info_needed', { carrier_name: 'Eastern' })] }),
    );
    expect(summary).toContain('Eastern');
  });
});

describe('the list row reading', () => {
  function row(overrides: Partial<RowFacts> = {}): RowFacts {
    return {
      result: null,
      primary_assignee_id: 'profile-oscar',
      next_action: null,
      is_overdue: false,
      is_due_today: false,
      price_sent_at: null,
      markets_total: 0,
      markets_submitted: 0,
      markets_quoted: 0,
      markets_waiting: 0,
      markets_info_needed: 0,
      open_information_count: 0,
      open_information_labels: null,
      ...overrides,
    };
  }

  it('never leaves the column blank', () => {
    // The list is scanned. A blank Next Action is the one thing that makes an agent
    // open a quote to find out there was nothing to do.
    fc.assert(
      fc.property(
        fc.record({
          result: fc.constantFrom(null, 'sold', 'not_sold'),
          primary_assignee_id: fc.constantFrom(null, 'profile-oscar'),
          next_action: fc.constantFrom(null, '', '  ', 'Call the customer'),
          is_overdue: fc.boolean(),
          is_due_today: fc.boolean(),
          price_sent_at: fc.constantFrom(null, '2026-08-19T10:00:00Z'),
          markets_total: fc.integer({ min: 0, max: 6 }),
          markets_submitted: fc.integer({ min: 0, max: 6 }),
          markets_quoted: fc.integer({ min: 0, max: 6 }),
          markets_waiting: fc.integer({ min: 0, max: 6 }),
          markets_info_needed: fc.integer({ min: 0, max: 6 }),
          open_information_count: fc.integer({ min: 0, max: 6 }),
          open_information_labels: fc.constantFrom(null, 'Loss runs'),
        }),
        (raw) => listNextAction(raw as RowFacts).trim().length > 0,
      ),
    );
  });

  it('prefers what a teammate recorded', () => {
    expect(listNextAction(row({ next_action: 'Call Miguel Thursday', markets_info_needed: 2 }))).toBe(
      'Call Miguel Thursday',
    );
  });

  it('keeps the same priority order as the workspace', () => {
    // Carrier request first, then outstanding information, then the claim.
    expect(listNextAction(row({ markets_info_needed: 1, open_information_count: 3 }))).toMatch(
      /carrier needs information/i,
    );
    expect(
      listNextAction(row({ open_information_count: 1, open_information_labels: 'Loss runs' })),
    ).toBe('Waiting on Loss runs');
    expect(listNextAction(row({ primary_assignee_id: null }))).toBe('Unclaimed');
    expect(listNextAction(row({ markets_total: 0 }))).toBe('No carriers yet');
    expect(
      listNextAction(row({ markets_total: 3, markets_submitted: 3, markets_quoted: 1 })),
    ).toBe('Prices ready to send');
  });

  it('says the outcome on a closed quote instead of a next step', () => {
    expect(listNextAction(row({ result: 'sold' }))).toBe('Sold');
    expect(listNextAction(row({ result: 'not_sold' }))).toBe('Closed as not sold');
  });
});

describe('blocked carriers', () => {
  it('is exactly the markets asking for information', () => {
    const blocked = blockedCarriers([
      carrier('more_info_needed'),
      carrier('waiting'),
      carrier('declined'),
    ]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].status).toBe('more_info_needed');
  });
});

// ── Tabs ─────────────────────────────────────────────────────────────────────

describe('tab parsing', () => {
  it('accepts the five tabs and refuses anything else', () => {
    expect(parseTab('carriers')).toBe('carriers');
    expect(parseTab('activity')).toBe('activity');
    // A stale or crafted value opens the Overview rather than rendering nothing.
    expect(parseTab('nonsense')).toBe('overview');
    expect(parseTab(null)).toBe('overview');
  });
});

// ── List state in the URL ────────────────────────────────────────────────────

describe('list state serialisation', () => {
  it('round-trips any state through the query string', () => {
    fc.assert(
      fc.property(
        fc.record({
          query: fc.string({ maxLength: 40 }),
          view: fc.constantFrom('team', 'mine', 'unclaimed', 'due_today', 'overdue', 'stale', 'closed'),
          line: fc.constantFrom('all', 'trucking', 'homeowners', 'commercial_gl'),
          stage: fc.constantFrom('all', ...STAGE_ORDER),
          assignee: fc.constantFrom('all', 'profile-oscar', 'profile-jason'),
          carrierId: fc.constantFrom('all', 'carrier-progressive'),
          result: fc.constantFrom('all', 'open', 'sold', 'not_sold'),
          page: fc.integer({ min: 0, max: 40 }),
        }),
        fc.constantFrom('work', 'quotes'),
        (raw, mode) => {
          const original = raw as SpecialtyListState;
          const restored = parseListState(listStateToParams(original, mode), mode);
          // The query is trimmed on the way out, because a URL carrying trailing
          // whitespace is a URL nobody can retype.
          return (
            restored.query === original.query.trim() &&
            restored.view === original.view &&
            restored.line === original.line &&
            restored.stage === original.stage &&
            restored.assignee === original.assignee &&
            restored.carrierId === original.carrierId &&
            restored.result === original.result &&
            restored.page === original.page
          );
        },
      ),
    );
  });

  it('writes nothing for a default list', () => {
    // A clean URL is one somebody can look at, and one that does not grow a parameter
    // every time a default is renamed.
    expect(listStateToParams(defaultListState('work'), 'work').toString()).toBe('');
    expect(specialtyListHref(defaultListState('work'), 'work')).toBe('/specialty-quotes');
  });

  it('keeps the two destinations apart', () => {
    // Work opens on the team's active work; Quotes opens on everything, closed
    // included. Losing that distinction would silently hide closed quotes.
    expect(defaultListState('work').result).toBe('open');
    expect(defaultListState('quotes').result).toBe('all');
    expect(specialtyListHref(defaultListState('quotes'), 'quotes')).toContain('section=quotes');
  });

  it('ignores values it does not recognise', () => {
    const params = new URLSearchParams('sqView=hacked&sqStage=made_up&sqPage=-4&sqResult=maybe');
    const parsed = parseListState(params, 'work');
    expect(parsed.view).toBe('team');
    expect(parsed.stage).toBe('all');
    expect(parsed.result).toBe('open');
    expect(parsed.page).toBe(0);
  });
});

describe('quote href', () => {
  it('carries the tab, the carrier and where to come back to', () => {
    const href = specialtyQuoteHref('abc', {
      tab: 'carriers',
      carrierId: 'market-1',
      backTo: '/specialty-quotes?sqView=overdue',
    });
    expect(href).toContain('/specialty-quotes/abc?');
    expect(href).toContain('tab=carriers');
    expect(href).toContain('carrier=market-1');
    expect(href).toContain('back=');
  });

  it('is bare when there is nothing to carry', () => {
    expect(specialtyQuoteHref('abc')).toBe('/specialty-quotes/abc');
  });
});

describe('back link safety', () => {
  it('accepts a same-origin path', () => {
    expect(safeBackHref('/specialty-quotes?sqView=overdue')).toBe(
      '/specialty-quotes?sqView=overdue',
    );
    expect(safeBackHref('/?module=specialty_quotes&sub=specialty_work')).toBe(
      '/?module=specialty_quotes&sub=specialty_work',
    );
  });

  it('refuses anything that would leave the Work Desk', () => {
    // `back` is read from the URL, so it is untrusted input. Without this the back
    // button on a crafted link is an open redirect.
    for (const hostile of [
      'https://evil.example/steal',
      '//evil.example/steal',
      'javascript:alert(1)',
      '/\\evil.example',
      '',
      null,
      undefined,
    ]) {
      expect(safeBackHref(hostile)).toBe('/specialty-quotes');
    }
  });
});

// ── Application readings ─────────────────────────────────────────────────────

describe('limit formatting', () => {
  it('reads a bare number as money and leaves anything else alone', () => {
    // These columns are free text because Customer Service records what the customer
    // said. Rewriting "state minimum" would be guessing at what they meant.
    expect(formatLimit('1000000')).toBe('$1,000,000');
    expect(formatLimit('$1,000,000')).toBe('$1,000,000');
    expect(formatLimit(100_000)).toBe('$100,000');
    expect(formatLimit('CSL 1M')).toBe('CSL 1M');
    expect(formatLimit('Rejected')).toBe('Rejected');
    expect(formatLimit('')).toBeNull();
    expect(formatLimit(null)).toBeNull();
  });
});

describe('document grouping', () => {
  it('sorts every stored category onto a shelf', () => {
    expect(documentGroup('loss_runs')).toBe('customer');
    expect(documentGroup('driver_license')).toBe('customer');
    expect(documentGroup('generated_application')).toBe('carrier_applications');
    expect(documentGroup('carrier_proposal')).toBe('carrier_quotes');
    expect(documentGroup('quote_pdf')).toBe('carrier_quotes');
    expect(documentGroup('underwriting')).toBe('underwriting');
    // An unknown category lands on Other rather than disappearing from the tab.
    expect(documentGroup('something_new')).toBe('other');
  });
});

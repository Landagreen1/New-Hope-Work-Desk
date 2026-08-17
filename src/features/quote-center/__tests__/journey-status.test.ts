/**
 * The employee-facing status vocabulary, and the two rules that keep a journey
 * honest: it is never counted twice, and a note always lands somewhere that will
 * accept it.
 *
 * These are the parts of Quote Center that carry risk without touching the
 * database, so they are covered here rather than left to a manual click-through.
 */

import { describe, expect, it } from 'vitest';

import {
  acceptsQuoteNote,
  formatPhone,
  furthestStage,
  isContinuableDraft,
  journeyDifferentiators,
  journeyReference,
  lineOfBusinessLabel,
  noteTargetFor,
  notSoldReasonLabel,
  phoneDigits,
  stageFilterLabel,
  stageRank,
  stageTone,
  STAGE_FILTERS,
} from '../status';
import type { JourneyStage } from '../types';

const ALL_STAGES: readonly JourneyStage[] = ['intake', 'working', 'price_sent', 'closed'];

describe('stage vocabulary', () => {
  it('offers exactly the five filters an employee sees, in lifecycle order', () => {
    expect([...STAGE_FILTERS]).toEqual(['all', 'intake', 'working', 'price_sent', 'closed']);
  });

  it('labels every filter in plain language rather than a database status', () => {
    const labels = STAGE_FILTERS.map(stageFilterLabel);
    expect(labels).toEqual(['All', 'Intake', 'Working', 'Price Sent', 'Closed']);
    // No label should leak an underscore-cased enum value.
    for (const label of labels) expect(label).not.toMatch(/_/);
  });

  it('ranks stages so the furthest lifecycle state always wins', () => {
    // This is the ordering that stops one journey being reported as both an
    // intake and a sold quote. quote_center_quote_stage applies the same order in
    // SQL when it collapses the three lifecycle tables.
    const ranks = ALL_STAGES.map(stageRank);
    expect(ranks).toEqual([1, 2, 3, 4]);
    expect(new Set(ranks).size).toBe(ALL_STAGES.length);
  });

  it('resolves any pair of stages to the furthest one, in either argument order', () => {
    for (const a of ALL_STAGES) {
      for (const b of ALL_STAGES) {
        const expected = stageRank(a) >= stageRank(b) ? a : b;
        expect(furthestStage(a, b)).toBe(expected);
        // Symmetric: the answer cannot depend on which representation was read first.
        expect(stageRank(furthestStage(b, a))).toBe(stageRank(expected));
      }
    }
  });

  it('distinguishes sold from not sold, because those are the two an employee must not confuse', () => {
    expect(stageTone('closed', 'sold')).toBe('success');
    expect(stageTone('closed', 'not_sold')).toBe('danger');
    expect(stageTone('closed', 'sold')).not.toBe(stageTone('closed', 'not_sold'));
  });

  it('tolerates the stray capitalised Sold enum label the database still carries', () => {
    // public.quote_decision has a third label 'Sold' alongside 'sold'
    // (recorded in v1.12.7). It is writable, so the UI must not mis-colour it.
    expect(stageTone('closed', 'Sold')).toBe('success');
  });

  it('falls back to a neutral tone when a closed journey has no recorded decision', () => {
    expect(stageTone('closed', null)).toBe('neutral');
  });
});

describe('continuing an unfinished draft', () => {
  it('allows exactly draft and returned', () => {
    expect(isContinuableDraft('draft')).toBe(true);
    expect(isContinuableDraft('returned')).toBe(true);
  });

  it('refuses every status that has already been handed over', () => {
    // Once submitted, the intake belongs to the queue; editing it would change
    // work someone else has taken on. can_edit_cs_intake enforces the same pair.
    for (const status of ['submitted', 'claimed', 'converted', 'rejected', null, undefined]) {
      expect(isContinuableDraft(status)).toBe(false);
    }
  });
});

describe('where a note goes', () => {
  it('sends the note to the quote once one exists', () => {
    expect(
      noteTargetFor({ has_quote: true, work_item_id: 'wi-1', intake_id: 'in-1' }),
    ).toEqual({ kind: 'quote', workItemId: 'wi-1' });
  });

  it('sends the note to the intake before conversion', () => {
    expect(
      noteTargetFor({ has_quote: false, work_item_id: null, intake_id: 'in-1' }),
    ).toEqual({ kind: 'intake', intakeId: 'in-1' });
  });

  it('sends the note to the intake when the quote row was deleted, not to the dead quote id', () => {
    // Four live intakes carry a source_work_item_id whose quote a manager later
    // deleted. Keying on the id rather than has_quote would post the note to
    // add_quote_note, which verifies the quote exists in one of the three
    // lifecycle tables and would reject it as "Quote not found".
    expect(
      noteTargetFor({ has_quote: false, work_item_id: 'deleted-wi', intake_id: 'in-1' }),
    ).toEqual({ kind: 'intake', intakeId: 'in-1' });
  });

  it('reports no target when there is neither a live quote nor an intake', () => {
    expect(noteTargetFor({ has_quote: false, work_item_id: null, intake_id: null })).toBeNull();
  });

  it('agrees with acceptsQuoteNote about when the quote path is available', () => {
    for (const hasQuote of [true, false]) {
      const target = noteTargetFor({
        has_quote: hasQuote,
        work_item_id: 'wi-1',
        intake_id: 'in-1',
      });
      expect(target?.kind === 'quote').toBe(acceptsQuoteNote(hasQuote));
    }
  });
});

describe('phone handling', () => {
  it('reduces any stored format to the digits the server searches on', () => {
    // public.nhwd_digits does the same on the other side, which is what makes
    // searching 7045551212 find (704) 555-1212.
    for (const stored of ['(704) 555-1212', '704-555-1212', '704.555.1212', '7045551212']) {
      expect(phoneDigits(stored)).toBe('7045551212');
    }
  });

  it('formats ten digits, and eleven with a leading country code', () => {
    expect(formatPhone('7045551212')).toBe('(704) 555-1212');
    expect(formatPhone('17045551212')).toBe('(704) 555-1212');
  });

  it('shows an unexpected length exactly as stored rather than mangling it', () => {
    // An extension or an international number is more likely than a typo, and
    // silently reformatting it would lose information the employee needs to dial.
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(formatPhone('555-1212')).toBe('555-1212');
  });

  it('renders nothing for a missing number instead of a placeholder that looks real', () => {
    expect(formatPhone(null)).toBe('');
    expect(formatPhone(undefined)).toBe('');
    expect(phoneDigits(null)).toBe('');
  });
});

describe('telling same-name customers apart', () => {
  const base = {
    phone_primary: null as string | null,
    addr_city: null as string | null,
    addr_state: null as string | null,
    source_label: null as string | null,
    salesperson_name: null as string | null,
    assigned_agent_name: null as string | null,
  };

  it('leads with the phone number, then place, then source, then owner', () => {
    expect(
      journeyDifferentiators({
        ...base,
        phone_primary: '7045551822',
        addr_city: 'Gastonia',
        addr_state: 'NC',
        source_label: '1 Auto Sales',
        salesperson_name: 'Luis',
        assigned_agent_name: 'Mauricio',
      }),
    ).toEqual(['(704) 555-1822', 'Gastonia, NC', '1 Auto Sales / Luis', 'Mauricio']);
  });

  it('keeps two customers of the same name distinguishable when only the source differs', () => {
    // The requirement this covers: Maria Perez from 1 Auto Sales must not read
    // identically to Maria Perez from Walk-In.
    const dealership = journeyDifferentiators({
      ...base,
      phone_primary: '7045551822',
      source_label: '1 Auto Sales',
      salesperson_name: 'Luis',
    });
    const walkIn = journeyDifferentiators({
      ...base,
      phone_primary: '7045551822',
      source_label: 'Walk-In',
    });
    expect(dealership).not.toEqual(walkIn);
  });

  it('omits a source that was never recorded rather than printing the placeholder', () => {
    const parts = journeyDifferentiators({ ...base, source_label: 'Not recorded' });
    expect(parts).toEqual([]);
  });

  it('returns only the facts it has, without empty separators', () => {
    const parts = journeyDifferentiators({ ...base, addr_city: 'Charlotte', addr_state: 'NC' });
    expect(parts).toEqual(['Charlotte, NC']);
    for (const part of parts) expect(part.trim()).not.toBe('');
  });
});

describe('journey references employees read aloud', () => {
  it('prefixes a quote and an intake differently and never shows a full identifier', () => {
    const quote = journeyReference({
      intake_id: '73635104-b1b7-416f-bd8e-542f83355d58',
      work_item_id: 'aabbccdd-1111-2222-3333-444455556666',
      has_quote: true,
    });
    const intake = journeyReference({
      intake_id: '73635104-b1b7-416f-bd8e-542f83355d58',
      work_item_id: null,
      has_quote: false,
    });

    expect(quote).toBe('Q-AABBCCDD');
    expect(intake).toBe('INT-73635104');
    expect(quote.length).toBeLessThan(12);
    expect(intake).not.toContain('-b1b7-');
  });

  it('has an answer for a journey with no identifier at all', () => {
    expect(journeyReference({ intake_id: null, work_item_id: null, has_quote: false })).toBe('—');
  });
});

describe('line of business labels', () => {
  it('treats the legacy auto label and the current one as the same thing', () => {
    // Intakes store 'auto'; the form works in 'personal_auto'. Both are Auto.
    expect(lineOfBusinessLabel('auto')).toBe('Auto');
    expect(lineOfBusinessLabel('personal_auto')).toBe('Auto');
  });

  it('falls back to the work type for a quote created without an intake', () => {
    expect(lineOfBusinessLabel(null, 'requote')).toBe('Requote');
    expect(lineOfBusinessLabel(null, 'new_quote')).toBe('Quote');
  });

  it('never leaves an unmapped value looking like a database enum', () => {
    expect(lineOfBusinessLabel('some_new_line')).toBe('Some New Line');
  });
});

describe('not-sold reasons', () => {
  it('spells out each constrained reason', () => {
    expect(notSoldReasonLabel('price_too_high')).toBe('Price too high');
    expect(notSoldReasonLabel('chose_another_option')).toBe('Chose another option');
    expect(notSoldReasonLabel('no_response')).toBe('No response');
    expect(notSoldReasonLabel('no_longer_needed')).toBe('No longer needed');
    expect(notSoldReasonLabel('other')).toBe('Other');
  });

  it('reports no reason rather than an empty label', () => {
    expect(notSoldReasonLabel(null)).toBeNull();
  });
});

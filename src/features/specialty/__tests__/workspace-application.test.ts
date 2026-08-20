/**
 * Reading the master application, tested as rules.
 *
 * `application.ts` decides what every section of the Application tab reports as complete
 * and what it reports as missing. Those judgements drive the workflow rail, the quote
 * health panel and the next action, so a wrong reading here is a quote that looks ready
 * to market when it is not — or one that nags about a field the customer already answered.
 *
 * The cargo tests are the ones that matter most. The whole point of the redesign's cargo
 * work is that "Dry Freight" is not something a carrier can rate, and these state that
 * claim as behaviour rather than as a comment.
 */

import { describe, expect, it } from 'vitest';

import {
  applicationSections,
  cargoProfile,
  radiusBandLabel,
  requestedCoverage,
  yesNoUnsure,
  type SectionKey,
} from '../application';
import { groupTimelineByDay, timeOfDay } from '../timeline';
import type { LinkedIntake, TimelineEntry } from '../types';

// ── An intake with nothing in it ─────────────────────────────────────────────

/**
 * A blank intake.
 *
 * Every column null, which is the honest starting point: a Customer Service intake taken
 * in ninety seconds on a first call has most of this empty, and that is exactly the state
 * the specialty team has to be able to read.
 */
function blankIntake(overrides: Partial<LinkedIntake> = {}): LinkedIntake {
  const base = {
    id: 'intake-1',
    status: 'converted',
    line_of_business: 'trucking',
    version: 3,
    commodities: [],
    drivers: [],
    vehicles: [],
    trailers: [],
    owners: [],
    excluded_cargo: null,
    operation_types: null,
  } as unknown as LinkedIntake;
  return { ...base, ...overrides };
}

function section(intake: LinkedIntake, key: SectionKey, line: 'trucking' | 'homeowners') {
  const found = applicationSections(line, intake).find((entry) => entry.key === key);
  if (!found) throw new Error(`No ${key} section for ${line}`);
  return found;
}

// ── Coverage ─────────────────────────────────────────────────────────────────

describe('requested coverage', () => {
  it('offers the four trucking coverages the spec requires, even when unanswered', () => {
    // A blank core coverage is a gap worth showing, not a row to hide: an underwriter
    // cannot quote Auto Liability that nobody asked for.
    const lines = requestedCoverage('trucking', blankIntake());
    expect(lines.filter((line) => line.isCore).map((line) => line.label)).toEqual([
      'Auto Liability',
      'Cargo',
      'Physical Damage',
      'Trailer Interchange',
    ]);
    expect(lines.every((line) => line.value === null || line.value === 'Not requested')).toBe(true);
  });

  it('reads the Auto Liability key through the intake form\u2019s own table', () => {
    // The column stores `1000000`, not `$1,000,000`. Restating that table here is how the
    // two screens would come to disagree about what the key means.
    const lines = requestedCoverage(
      'trucking',
      blankIntake({ auto_liability_limit: '1000000' } as Partial<LinkedIntake>),
    );
    expect(lines.find((line) => line.key === 'auto_liability')?.value).toBe('$1,000,000');
  });

  it('shows the free-text answer when the limit is Other', () => {
    const lines = requestedCoverage(
      'trucking',
      blankIntake({
        auto_liability_limit: 'other',
        auto_liability_limit_other: '$2,000,000 CSL',
      } as Partial<LinkedIntake>),
    );
    expect(lines.find((line) => line.key === 'auto_liability')?.value).toBe('$2,000,000 CSL');
  });

  it('sums the stated values across the units for Physical Damage', () => {
    // Physical damage is carried per unit, so the requested figure is the sum rather
    // than a column of its own.
    const lines = requestedCoverage(
      'trucking',
      blankIntake({
        physical_damage_needed: true,
        vehicles: [
          { position: 1, physical_damage_value: 85_000 },
          { position: 2, physical_damage_value: 60_000 },
        ],
      } as unknown as Partial<LinkedIntake>),
    );
    const pd = lines.find((line) => line.key === 'physical_damage');
    expect(pd?.value).toBe('$145,000');
    expect(pd?.note).toContain('2 units');
  });

  it('says Not requested rather than Not recorded when the answer was No', () => {
    // "The customer declined it" and "nobody asked" are different facts, and only one of
    // them is a gap.
    const lines = requestedCoverage(
      'trucking',
      blankIntake({
        physical_damage_needed: false,
        cargo_coverage_desired: false,
        trailer_interchange_agreement: false,
      } as Partial<LinkedIntake>),
    );
    expect(lines.find((line) => line.key === 'physical_damage')?.value).toBe('Not requested');
    expect(lines.find((line) => line.key === 'cargo')?.note).toBe('Not requested');
    expect(lines.find((line) => line.key === 'trailer_interchange')?.value).toBe(
      'No interchange agreement',
    );
  });

  it('reads a different set for property', () => {
    const lines = requestedCoverage(
      'homeowners',
      blankIntake({ coverage_amount: 350_000, coverage_type: 'Landlord' } as Partial<LinkedIntake>),
    );
    expect(lines.map((line) => line.label)).toEqual(['Dwelling', 'Personal Liability']);
    expect(lines[0].value).toBe('$350,000');
    expect(lines[0].note).toBe('Landlord');
  });

  it('has nothing to read without a linked intake', () => {
    expect(requestedCoverage('trucking', null)).toEqual([]);
  });
});

// ── Cargo ────────────────────────────────────────────────────────────────────

describe('cargo profile', () => {
  it('names a one-word legacy description as too general to rate', () => {
    // The behaviour the redesign exists for. "Dry Freight" is what gets typed and it is
    // not an answer an underwriter can price.
    const cargo = cargoProfile(blankIntake({ cargo_type: 'Dry Freight' } as Partial<LinkedIntake>));
    expect(cargo?.primaryIsLegacy).toBe(true);
    expect(cargo?.gaps.join(' ')).toMatch(/too general/i);
    expect(cargo?.gaps).toContain('No primary commodity category');
  });

  it('stops complaining once a structured category is chosen', () => {
    const cargo = cargoProfile(
      blankIntake({
        cargo_type: 'Dry Freight',
        primary_commodity: 'general_consumer_goods',
      } as Partial<LinkedIntake>),
    );
    expect(cargo?.primaryIsLegacy).toBe(false);
    expect(cargo?.primaryCategory).toBe('General Consumer Goods');
    expect(cargo?.gaps.join(' ')).not.toMatch(/too general/i);
  });

  it('takes the maximum per load from the commodity rows when the rollup is empty', () => {
    const cargo = cargoProfile(
      blankIntake({
        commodities: [
          { category: 'food_grocery', frequency: 'mostly', is_primary: true, percent_hauled: 70, average_value: 30_000, maximum_value: 60_000 },
          { category: 'electronics', frequency: 'sometimes', is_primary: false, percent_hauled: 30, average_value: 50_000, maximum_value: 75_000 },
        ],
      } as unknown as Partial<LinkedIntake>),
    );
    expect(cargo?.maximumLoadValue).toBe(75_000);
    expect(cargo?.commodities[0].label).toBe('Food Grocery');
    expect(cargo?.commodities[0].isPrimary).toBe(true);
  });

  it('splits the prohibited-cargo answers into what they do and do not haul', () => {
    const cargo = cargoProfile(
      blankIntake({
        excluded_cargo: { hazardous_materials: 'no', alcohol: 'yes', tobacco: 'no' },
      } as unknown as Partial<LinkedIntake>),
    );
    expect(cargo?.excluded).toEqual(['Alcohol']);
    expect(cargo?.notHauled).toEqual(['Hazardous Materials', 'Tobacco']);
  });

  it('names an unanswered prohibited-cargo list as a gap', () => {
    expect(cargoProfile(blankIntake())?.gaps).toContain('Prohibited-cargo questions unanswered');
  });

  it('keeps Unsure as Unsure', () => {
    // A guessed No on hazmat is worse for an underwriter than an honest Unsure, so the
    // third answer has to survive into this screen.
    const cargo = cargoProfile(blankIntake({ hazmat: 'unsure' } as Partial<LinkedIntake>));
    expect(cargo?.handling).toEqual([{ label: 'Hazmat', value: 'Unsure' }]);
    expect(yesNoUnsure('unsure')).toBe('Unsure');
    expect(yesNoUnsure(null)).toBeNull();
  });

  it('has nothing to read without a linked intake', () => {
    expect(cargoProfile(null)).toBeNull();
  });
});

// ── Sections ─────────────────────────────────────────────────────────────────

describe('application sections', () => {
  it('offers the trucking sections in the order an agent works them', () => {
    expect(applicationSections('trucking', blankIntake()).map((entry) => entry.key)).toEqual([
      'customer',
      'business',
      'operations',
      'drivers',
      'vehicles',
      'cargo',
      'coverage',
      'prior_insurance',
      'loss_history',
    ]);
  });

  it('offers a property set for homeowners, without the trucking middle', () => {
    const keys = applicationSections('homeowners', blankIntake()).map((entry) => entry.key);
    expect(keys).toEqual(['customer', 'property', 'coverage', 'prior_insurance', 'loss_history']);
    expect(keys).not.toContain('cargo');
  });

  it('reports a section with nothing in it as empty, not as incomplete', () => {
    // "Nobody has started this" and "this is half done" are different states and read
    // differently on the tab.
    expect(section(blankIntake(), 'business', 'trucking').state).toBe('empty');
  });

  it('rolls per-row gaps into one line each', () => {
    // A twenty-driver fleet must not produce twenty identical lines. This is the
    // difference between a list somebody acts on and a wall.
    const intake = blankIntake({
      drivers: Array.from({ length: 17 }, (_, index) => ({
        position: index + 1,
        first_name: 'Driver',
        last_name: String(index),
        dob: '1980-01-01',
        cdl: false,
        license_number: null,
        cdl_years_experience: null,
      })),
    } as unknown as Partial<LinkedIntake>);

    const drivers = section(intake, 'drivers', 'trucking');
    expect(drivers.missing).toEqual(['17 drivers are missing a licence number']);
    expect(drivers.state).toBe('attention');
  });

  it('says one driver rather than 1 drivers', () => {
    const intake = blankIntake({
      drivers: [{ position: 1, first_name: 'Miguel', last_name: 'Silva', dob: '1980-01-01', cdl: true, license_number: 'A123', cdl_years_experience: null }],
    } as unknown as Partial<LinkedIntake>);
    expect(section(intake, 'drivers', 'trucking').missing).toEqual([
      'One CDL driver is missing years of commercial driving experience',
    ]);
  });

  it('reports a complete section as complete', () => {
    const intake = blankIntake({
      prior_insurance: true,
      current_carrier: 'Progressive',
      current_premium: 18_000,
      current_expiration: '2026-10-01',
      prior_lapse: false,
    } as Partial<LinkedIntake>);
    const prior = section(intake, 'prior_insurance', 'trucking');
    expect(prior.state).toBe('complete');
    expect(prior.missing).toEqual([]);
    expect(prior.summary).toContain('Progressive');
  });

  it('asks for an explanation when a lapse is recorded', () => {
    const intake = blankIntake({
      prior_insurance: true,
      current_carrier: 'Progressive',
      prior_lapse: true,
    } as Partial<LinkedIntake>);
    expect(section(intake, 'prior_insurance', 'trucking').missing).toContain(
      'Explanation for the lapse',
    );
  });

  it('flags a hand-typed property address', () => {
    // A verified address needs no remark; an unverified one is a reason to read it back to
    // the customer before it reaches a carrier.
    const intake = blankIntake({
      property_address_street: '12 Main St',
      property_addr_verified: false,
    } as Partial<LinkedIntake>);
    expect(section(intake, 'property', 'homeowners').missing).toContain(
      'Address was typed by hand and not verified',
    );
  });

  it('has nothing to offer without a linked intake', () => {
    expect(applicationSections('trucking', null)).toEqual([]);
  });
});

describe('radius band', () => {
  it('reads the stored key through the intake form\u2019s table', () => {
    expect(radiusBandLabel('51_100')).toBe('51 – 100 miles');
    expect(radiusBandLabel(null)).toBeNull();
  });
});

// ── Timeline grouping ────────────────────────────────────────────────────────

describe('timeline day grouping', () => {
  function entry(occurredAt: string): TimelineEntry {
    return {
      occurred_at: occurredAt,
      origin: 'specialty',
      event_type: 'note_added',
      actor_name: 'Oscar',
      actor_initials: 'OM',
      carrier_market_id: null,
      detail: null,
    };
  }

  it('keeps one local day in one group', () => {
    // The key and the heading must both be local. Deriving the key from the UTC date
    // split a US-timezone evening across two groups carrying the same heading, because
    // groups only merge with the one immediately before them.
    const morning = new Date(2026, 6, 14, 9, 15);
    const evening = new Date(2026, 6, 14, 21, 40);
    const days = groupTimelineByDay([
      entry(evening.toISOString()),
      entry(morning.toISOString()),
    ]);
    expect(days).toHaveLength(1);
    expect(days[0].entries).toHaveLength(2);
  });

  it('separates two local days', () => {
    const days = groupTimelineByDay([
      entry(new Date(2026, 6, 14, 21, 40).toISOString()),
      entry(new Date(2026, 6, 13, 21, 40).toISOString()),
    ]);
    expect(days).toHaveLength(2);
    expect(new Set(days.map((day) => day.label)).size).toBe(2);
  });

  it('names today and yesterday', () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const days = groupTimelineByDay([entry(now.toISOString()), entry(yesterday.toISOString())]);
    expect(days.map((day) => day.label)).toEqual(['Today', 'Yesterday']);
  });

  it('drops an unparseable timestamp rather than rendering an Invalid Date heading', () => {
    expect(groupTimelineByDay([entry('not a date')])).toEqual([]);
  });

  it('reads a clock time', () => {
    expect(timeOfDay(new Date(2026, 6, 14, 9, 5).toISOString())).toBe('09:05');
    expect(timeOfDay('not a date')).toBe('');
  });
});

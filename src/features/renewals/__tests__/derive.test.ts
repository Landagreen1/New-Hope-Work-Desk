// src/features/renewals/__tests__/derive.test.ts
// Unit tests for the pure renewal derived-value helpers in `../derive.ts`.
//
// Feature: policy-follow-up-renewals-cancellations, task 1.2
//
// Every case pins the business date as a literal so nothing here reads the real
// clock. `currentBusinessDate` is the one helper that may read a clock, so it is
// handed an explicit `Date` and an explicit time zone instead.
//
// The three status names Requirement 3.9 and 5.2 use — Waiting on customer,
// Requote requested, Customer decision pending — are not stored under those
// names. `derive.ts` bridges them from the stored status plus the stored
// `requote_requested` flag, and these tests assert that actual mapping:
//   requote_sent             -> Customer decision pending
//   requote_requested = true -> Requote requested
//   monitoring               -> Waiting on customer
//
// Requirements: 3.7, 3.8, 3.9, 4.2, 4.5, 4.7, 4.8, 5.2, 25.1

import { describe, expect, it } from 'vitest';
import {
  AGENCY_TIME_ZONE,
  MAX_SEARCH_LENGTH,
  RENEWAL_SUMMARY_FILTERS,
  compareRenewalRows,
  currentBusinessDate,
  daysRemaining,
  isOpenRenewal,
  matchesSearch,
  matchesSummaryFilter,
  premiumChange,
  recommendedNextAction,
  summaryCounts,
} from '../derive';
import type {
  RenewalContactIndex,
  RenewalDeriveContact,
  RenewalDeriveRecord,
  RenewalRequoteActivity,
  RenewalRow,
  RenewalSummaryFilterId,
} from '../derive';

// ---------------------------------------------------------------------------
// Pinned dates and fixtures
// ---------------------------------------------------------------------------

/** The business date every case below is evaluated against. February 2026 has 28 days. */
const TODAY = '2026-02-10';

/** Outside all four Due within N days windows measured from TODAY. */
const FAR_FUTURE = '2026-12-01';

const ALL_FILTER_IDS: readonly RenewalSummaryFilterId[] = RENEWAL_SUMMARY_FILTERS.map(
  (filter) => filter.id,
);

/**
 * `renewal_date` is typed non-null in `api.ts`; the helpers still have to
 * tolerate an absent value, so the override accepts `null` and the builder
 * carries it through unchanged.
 */
type RecordOverrides = Omit<Partial<RenewalDeriveRecord>, 'renewal_date'> & {
  renewal_date?: string | null;
};

function makeRecord(overrides: RecordOverrides = {}): RenewalDeriveRecord {
  const { renewal_date: renewalDate, ...rest } = overrides;
  return {
    id: 'record-1',
    status: 'assigned',
    customer_name: 'Acme Holdings',
    policy_number: 'POL-1000',
    renewal_date: (renewalDate === undefined ? FAR_FUTURE : renewalDate) as string,
    ...rest,
  };
}

function contactsAt(...times: readonly string[]): RenewalDeriveContact[] {
  return times.map((occurred_at) => ({ occurred_at }));
}

function requotesAt(...times: readonly string[]): RenewalRequoteActivity[] {
  return times.map((created_at) => ({ created_at }));
}

function makeRow(
  overrides: RecordOverrides,
  contacts: readonly RenewalDeriveContact[] = [],
): RenewalRow {
  return { record: makeRecord(overrides), contacts };
}

/** Every summary filter that counts the record, in the fixed Requirement 3.1 order. */
function countedFilters(
  record: RenewalDeriveRecord,
  contacts: readonly RenewalDeriveContact[] = [],
): RenewalSummaryFilterId[] {
  return ALL_FILTER_IDS.filter((id) => matchesSummaryFilter(record, contacts, id, TODAY));
}

function contactIndex(
  entries: readonly [string, readonly RenewalDeriveContact[]][],
): RenewalContactIndex {
  return new Map(entries);
}

function sortedIds(rows: readonly RenewalRow[]): string[] {
  return [...rows]
    .sort((a, b) => compareRenewalRows(a, b, TODAY))
    .map((row) => row.record.id);
}

// ---------------------------------------------------------------------------
// currentBusinessDate
// ---------------------------------------------------------------------------

describe('currentBusinessDate', () => {
  it('resolves the calendar date in the supplied time zone', () => {
    // 02:30 UTC on the 11th is 21:30 the previous evening in New York, so the
    // agency business date is still the 10th while UTC has already rolled over.
    const instant = new Date('2026-02-11T02:30:00Z');

    expect(currentBusinessDate(instant, AGENCY_TIME_ZONE)).toBe('2026-02-10');
    expect(currentBusinessDate(instant, 'UTC')).toBe('2026-02-11');
  });

  it('rolls at agency local midnight, not at UTC midnight', () => {
    expect(currentBusinessDate(new Date('2026-02-10T05:00:00Z'), AGENCY_TIME_ZONE)).toBe('2026-02-10');
    expect(currentBusinessDate(new Date('2026-02-10T04:59:59Z'), AGENCY_TIME_ZONE)).toBe('2026-02-09');
  });

  it('rejects an unusable instant', () => {
    expect(() => currentBusinessDate(new Date('not a date'), AGENCY_TIME_ZONE)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// daysRemaining (Requirement 4.7)
// ---------------------------------------------------------------------------

describe('daysRemaining', () => {
  it('is 0 on the business date', () => {
    expect(daysRemaining(TODAY, TODAY)).toBe(0);
  });

  it('is negative before the business date', () => {
    expect(daysRemaining('2026-02-09', TODAY)).toBe(-1);
    expect(daysRemaining('2026-01-10', TODAY)).toBe(-31);
  });

  it('is positive after the business date, across month and year rollover', () => {
    expect(daysRemaining('2026-02-11', TODAY)).toBe(1);
    expect(daysRemaining('2026-03-12', TODAY)).toBe(30);
    expect(daysRemaining('2027-02-10', TODAY)).toBe(365);
  });

  it('is null when the renewal date is absent or unreadable', () => {
    expect(daysRemaining(null, TODAY)).toBeNull();
    expect(daysRemaining(undefined, TODAY)).toBeNull();
    expect(daysRemaining('', TODAY)).toBeNull();
    expect(daysRemaining('   ', TODAY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// premiumChange (Requirements 4.4, 4.8)
// ---------------------------------------------------------------------------

describe('premiumChange', () => {
  it('reports a negative movement', () => {
    expect(premiumChange(1200, 1000)).toEqual({ amount: -200, percent: -16.67 });
  });

  it('reports a positive movement', () => {
    expect(premiumChange(1000, 1150)).toEqual({ amount: 150, percent: 15 });
  });

  it('reports an unchanged premium as exactly zero', () => {
    const change = premiumChange(1000, 1000);

    expect(change).toEqual({ amount: 0, percent: 0 });
    expect(Object.is(change?.amount, -0)).toBe(false);
  });

  it('rounds the amount and the percentage to two decimal places', () => {
    expect(premiumChange(1000, 1234.567)).toEqual({ amount: 234.57, percent: 23.46 });
    // A movement smaller than a cent rounds to zero, not to negative zero: the
    // sign character in the premium change cell is driven off this value.
    expect(Object.is(premiumChange(1000, 999.999)?.amount, -0)).toBe(false);
    expect(premiumChange(1000, 999.999)?.amount).toBe(0);
  });

  it('is null when the current premium is absent', () => {
    expect(premiumChange(null, 1000)).toBeNull();
    expect(premiumChange(undefined, 1000)).toBeNull();
  });

  it('is null when the renewal premium is absent', () => {
    expect(premiumChange(1000, null)).toBeNull();
    expect(premiumChange(1000, undefined)).toBeNull();
  });

  it('reports the amount with no percentage when the current premium is zero', () => {
    expect(premiumChange(0, 250)).toEqual({ amount: 250, percent: null });
  });
});

// ---------------------------------------------------------------------------
// isOpenRenewal (Requirement 3.5)
// ---------------------------------------------------------------------------

describe('isOpenRenewal', () => {
  it('treats a recorded outcome as closed and every other status as open', () => {
    expect(isOpenRenewal({ status: 'renewed' })).toBe(false);
    expect(isOpenRenewal({ status: 'lost' })).toBe(false);
    expect(isOpenRenewal({ status: 'cancelled' })).toBe(false);

    expect(isOpenRenewal({ status: 'imported' })).toBe(true);
    expect(isOpenRenewal({ status: 'assigned' })).toBe(true);
    expect(isOpenRenewal({ status: 'in_progress' })).toBe(true);
    expect(isOpenRenewal({ status: 'monitoring' })).toBe(true);
    expect(isOpenRenewal({ status: 'requote_sent' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchesSummaryFilter (Requirements 3.7, 3.8, 3.9)
// ---------------------------------------------------------------------------

/** One counted record and one excluded record per summary filter id. */
const FILTER_CASES: readonly {
  id: RenewalSummaryFilterId;
  counted: RenewalRow;
  excluded: RenewalRow;
}[] = [
  {
    id: 'overdue-follow-up',
    counted: makeRow({ next_follow_up_at: '2026-02-09' }, contactsAt('2026-02-01T15:00:00Z')),
    excluded: makeRow({ next_follow_up_at: TODAY }, contactsAt('2026-02-01T15:00:00Z')),
  },
  {
    id: 'follow-up-due-today',
    counted: makeRow({ next_follow_up_at: TODAY }, contactsAt('2026-02-01T15:00:00Z')),
    excluded: makeRow({ next_follow_up_at: '2026-02-11' }, contactsAt('2026-02-01T15:00:00Z')),
  },
  {
    id: 'due-within-3-days',
    counted: makeRow({ renewal_date: '2026-02-13' }),
    excluded: makeRow({ renewal_date: '2026-02-14' }),
  },
  {
    id: 'due-within-7-days',
    counted: makeRow({ renewal_date: '2026-02-17' }),
    excluded: makeRow({ renewal_date: '2026-02-18' }),
  },
  {
    id: 'due-within-15-days',
    counted: makeRow({ renewal_date: '2026-02-25' }),
    excluded: makeRow({ renewal_date: '2026-02-26' }),
  },
  {
    id: 'due-within-30-days',
    counted: makeRow({ renewal_date: '2026-03-12' }),
    excluded: makeRow({ renewal_date: '2026-03-13' }),
  },
  {
    id: 'no-contact-recorded',
    counted: makeRow({}),
    excluded: makeRow({}, contactsAt('2026-02-01T15:00:00Z')),
  },
  {
    id: 'waiting-on-customer',
    counted: makeRow({ status: 'monitoring' }),
    excluded: makeRow({ status: 'in_progress' }),
  },
  {
    id: 'requote-requested',
    counted: makeRow({ status: 'assigned', requote_requested: true }),
    excluded: makeRow({ status: 'assigned', requote_requested: false }),
  },
  {
    id: 'customer-decision-pending',
    counted: makeRow({ status: 'requote_sent' }),
    excluded: makeRow({ status: 'monitoring' }),
  },
];

describe('matchesSummaryFilter', () => {
  for (const { id, counted, excluded } of FILTER_CASES) {
    it(`counts a record satisfying ${id} and excludes one that does not`, () => {
      expect(matchesSummaryFilter(counted.record, counted.contacts, id, TODAY)).toBe(true);
      expect(matchesSummaryFilter(excluded.record, excluded.contacts, id, TODAY)).toBe(false);
    });
  }

  it('resolves a follow-up timestamp in the agency time zone', () => {
    // Late evening in New York is already the next calendar day in UTC. The
    // follow-up is still due today for the agency.
    const record = makeRecord({ next_follow_up_at: '2026-02-10T23:30:00-05:00' });

    expect(matchesSummaryFilter(record, [], 'follow-up-due-today', TODAY)).toBe(true);
    expect(matchesSummaryFilter(record, [], 'overdue-follow-up', TODAY)).toBe(false);
  });

  const WINDOWS: readonly {
    days: number;
    id: RenewalSummaryFilterId;
    atBound: string;
    pastBound: string;
  }[] = [
    { days: 3, id: 'due-within-3-days', atBound: '2026-02-13', pastBound: '2026-02-14' },
    { days: 7, id: 'due-within-7-days', atBound: '2026-02-17', pastBound: '2026-02-18' },
    { days: 15, id: 'due-within-15-days', atBound: '2026-02-25', pastBound: '2026-02-26' },
    { days: 30, id: 'due-within-30-days', atBound: '2026-03-12', pastBound: '2026-03-13' },
  ];

  for (const { days, id, atBound, pastBound } of WINDOWS) {
    it(`counts a renewal date exactly ${days} days out and excludes ${days + 1} days out`, () => {
      // Guards the literals: these two dates really are N and N+1 days out.
      expect(daysRemaining(atBound, TODAY)).toBe(days);
      expect(daysRemaining(pastBound, TODAY)).toBe(days + 1);

      expect(matchesSummaryFilter(makeRecord({ renewal_date: atBound }), [], id, TODAY)).toBe(true);
      expect(matchesSummaryFilter(makeRecord({ renewal_date: pastBound }), [], id, TODAY)).toBe(false);
    });
  }

  it('counts the business date itself in every window', () => {
    const record = makeRecord({ renewal_date: TODAY });

    expect(countedFilters(record)).toEqual([
      'due-within-3-days',
      'due-within-7-days',
      'due-within-15-days',
      'due-within-30-days',
      'no-contact-recorded',
    ]);
  });

  it('nests the four windows cumulatively', () => {
    const twoDaysOut = makeRecord({ id: 'near', renewal_date: '2026-02-12' });
    const twentyDaysOut = makeRecord({ id: 'far', renewal_date: '2026-03-02' });
    const contacts = contactsAt('2026-02-01T15:00:00Z');

    expect(daysRemaining('2026-02-12', TODAY)).toBe(2);
    expect(daysRemaining('2026-03-02', TODAY)).toBe(20);

    expect(countedFilters(twoDaysOut, contacts)).toEqual([
      'due-within-3-days',
      'due-within-7-days',
      'due-within-15-days',
      'due-within-30-days',
    ]);
    expect(countedFilters(twentyDaysOut, contacts)).toEqual(['due-within-30-days']);
  });

  it('excludes a renewal date before the business date from all four windows', () => {
    const record = makeRecord({ renewal_date: '2026-02-09' });
    const contacts = contactsAt('2026-02-01T15:00:00Z');

    expect(daysRemaining('2026-02-09', TODAY)).toBe(-1);
    expect(countedFilters(record, contacts)).toEqual([]);
  });

  it('excludes an absent renewal date from all four windows', () => {
    const contacts = contactsAt('2026-02-01T15:00:00Z');

    expect(countedFilters(makeRecord({ renewal_date: null }), contacts)).toEqual([]);
    expect(countedFilters(makeRecord({ renewal_date: '' }), contacts)).toEqual([]);
  });

  it('drops a record with no next follow-up date from both follow-up filters while keeping it eligible for the rest', () => {
    const record = makeRecord({ next_follow_up_at: null, renewal_date: '2026-02-12' });

    expect(matchesSummaryFilter(record, [], 'overdue-follow-up', TODAY)).toBe(false);
    expect(matchesSummaryFilter(record, [], 'follow-up-due-today', TODAY)).toBe(false);
    // Still eligible elsewhere: it is counted in the windows and in No contact recorded.
    expect(matchesSummaryFilter(record, [], 'due-within-3-days', TODAY)).toBe(true);
    expect(matchesSummaryFilter(record, [], 'no-contact-recorded', TODAY)).toBe(true);
  });

  for (const status of ['renewed', 'lost', 'cancelled'] as const) {
    it(`counts a ${status} record in zero filters`, () => {
      // Every rule would otherwise fire: overdue follow-up, all four windows,
      // no contact recorded, and a status-based filter.
      const record = makeRecord({
        status,
        next_follow_up_at: '2026-02-01',
        renewal_date: '2026-02-11',
        requote_requested: true,
      });

      expect(countedFilters(record)).toEqual([]);
    });
  }

  it('counts a record in exactly one status-based filter', () => {
    const statusFilters: readonly RenewalSummaryFilterId[] = [
      'waiting-on-customer',
      'requote-requested',
      'customer-decision-pending',
    ];
    const cases: readonly { record: RenewalDeriveRecord; expected: RenewalSummaryFilterId }[] = [
      { record: makeRecord({ status: 'monitoring' }), expected: 'waiting-on-customer' },
      {
        record: makeRecord({ status: 'in_progress', requote_requested: true }),
        expected: 'requote-requested',
      },
      { record: makeRecord({ status: 'requote_sent' }), expected: 'customer-decision-pending' },
    ];

    for (const { record, expected } of cases) {
      const matched = statusFilters.filter((id) => matchesSummaryFilter(record, [], id, TODAY));
      expect(matched).toEqual([expected]);
    }
  });

  it('resolves an overlapping status and requote flag to one filter in the documented precedence', () => {
    // requote_sent outranks the flag; the flag outranks monitoring.
    expect(
      countedFilters(makeRecord({ status: 'requote_sent', requote_requested: true })),
    ).toEqual(['no-contact-recorded', 'customer-decision-pending']);
    expect(
      countedFilters(makeRecord({ status: 'monitoring', requote_requested: true })),
    ).toEqual(['no-contact-recorded', 'requote-requested']);
  });

  it('counts a record in no status-based filter when the stored status carries none of the three', () => {
    for (const status of ['imported', 'assigned', 'in_progress'] as const) {
      expect(countedFilters(makeRecord({ status }))).toEqual(['no-contact-recorded']);
    }
  });
});

// ---------------------------------------------------------------------------
// matchesSearch (Requirement 4.5)
// ---------------------------------------------------------------------------

describe('matchesSearch', () => {
  const record = makeRecord({
    customer_name: 'María Guzmán',
    policy_number: 'POL-88-A',
    carrier: 'Progressive',
    customer_phone: '+1 (305) 555-0143',
    customer_email: 'Maria.Guzman@Example.COM',
  });

  it('removes leading and trailing whitespace from the entered text', () => {
    expect(matchesSearch(record, '   guzmán   ')).toBe(true);
    expect(matchesSearch(record, '\t\nPOL-88\n ')).toBe(true);
  });

  it('limits the effective text to its first 100 characters', () => {
    const hundred = 'x'.repeat(MAX_SEARCH_LENGTH);
    const longRecord = makeRecord({ customer_name: hundred });
    const entered = `  ${hundred}zzz  `;

    // Past the hundredth character the entered text diverges from the stored
    // name, so an untruncated search would not match.
    expect(longRecord.customer_name.toLowerCase().includes(entered.trim().toLowerCase())).toBe(false);
    expect(matchesSearch(longRecord, entered)).toBe(true);
  });

  it('matches every record on an empty or whitespace-only search', () => {
    const records = [record, makeRecord({ id: 'record-2', customer_name: 'Other Client' })];

    for (const candidate of records) {
      expect(matchesSearch(candidate, '')).toBe(true);
      expect(matchesSearch(candidate, '     ')).toBe(true);
      expect(matchesSearch(candidate, null)).toBe(true);
      expect(matchesSearch(candidate, undefined)).toBe(true);
    }
  });

  it('matches without case sensitivity across all five searched fields', () => {
    expect(matchesSearch(record, 'GUZMÁN')).toBe(true);
    expect(matchesSearch(record, 'pol-88-a')).toBe(true);
    expect(matchesSearch(record, 'PROGRESS')).toBe(true);
    expect(matchesSearch(record, '555-0143')).toBe(true);
    expect(matchesSearch(record, 'maria.guzman@example.com')).toBe(true);
  });

  it('rejects text that appears in none of the five fields', () => {
    expect(matchesSearch(record, 'no-such-value')).toBe(false);
    // Line of business and status are not searched fields.
    expect(matchesSearch(makeRecord({ status: 'monitoring' }), 'monitoring')).toBe(false);
  });

  it('treats an absent searched field as no match rather than an error', () => {
    const sparse = makeRecord({ carrier: null, customer_phone: null, customer_email: null });

    expect(matchesSearch(sparse, 'progressive')).toBe(false);
    expect(matchesSearch(sparse, 'acme')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compareRenewalRows (Requirement 4.2)
// ---------------------------------------------------------------------------

describe('compareRenewalRows', () => {
  const contact = contactsAt('2026-02-01T15:00:00Z');

  it('key 1: places rows counted in Overdue follow-up first', () => {
    // The overdue row loses on every later key and still sorts first.
    const overdue = makeRow(
      { id: 'a', next_follow_up_at: '2026-02-09', renewal_date: '2026-06-01', customer_name: 'Zed Ames', policy_number: 'ZZZ' },
      contact,
    );
    const other = makeRow(
      { id: 'b', next_follow_up_at: TODAY, renewal_date: '2026-02-11', customer_name: 'Abe Cole', policy_number: 'AAA' },
      contact,
    );

    expect(Math.sign(compareRenewalRows(overdue, other, TODAY))).toBe(-1);
    expect(Math.sign(compareRenewalRows(other, overdue, TODAY))).toBe(1);
  });

  it('key 2: orders renewal date ascending', () => {
    const earlier = makeRow({ id: 'a', renewal_date: '2026-02-11' }, contact);
    const later = makeRow({ id: 'b', renewal_date: '2026-02-12' }, contact);

    expect(Math.sign(compareRenewalRows(earlier, later, TODAY))).toBe(-1);
    expect(Math.sign(compareRenewalRows(later, earlier, TODAY))).toBe(1);
  });

  it('key 3: places rows counted in No contact recorded first', () => {
    const noContact = makeRow({ id: 'a', renewal_date: '2026-02-11' }, []);
    const contacted = makeRow({ id: 'b', renewal_date: '2026-02-11' }, contact);

    expect(Math.sign(compareRenewalRows(noContact, contacted, TODAY))).toBe(-1);
    expect(Math.sign(compareRenewalRows(contacted, noContact, TODAY))).toBe(1);
  });

  it('key 4: orders customer name ascending without case sensitivity', () => {
    // A case-sensitive comparison would put 'Beta Corp' first.
    const lowerA = makeRow({ id: 'a', renewal_date: '2026-02-11', customer_name: 'alpha corp' }, contact);
    const upperB = makeRow({ id: 'b', renewal_date: '2026-02-11', customer_name: 'Beta Corp' }, contact);

    expect(Math.sign(compareRenewalRows(lowerA, upperB, TODAY))).toBe(-1);
    expect(Math.sign(compareRenewalRows(upperB, lowerA, TODAY))).toBe(1);
  });

  it('key 5: orders policy number ascending without case sensitivity', () => {
    // A case-sensitive comparison would put 'POL-b' first.
    const upperB = makeRow(
      { id: 'a', renewal_date: '2026-02-11', customer_name: 'Same Client', policy_number: 'POL-b' },
      contact,
    );
    const lowerA = makeRow(
      { id: 'b', renewal_date: '2026-02-11', customer_name: 'Same Client', policy_number: 'pol-A' },
      contact,
    );

    expect(Math.sign(compareRenewalRows(lowerA, upperB, TODAY))).toBe(-1);
    expect(Math.sign(compareRenewalRows(upperB, lowerA, TODAY))).toBe(1);
  });

  it('breaks a tie on all five keys into a total order', () => {
    const tied = (id: string) =>
      makeRow(
        {
          id,
          next_follow_up_at: TODAY,
          renewal_date: '2026-02-11',
          customer_name: 'Bob Stone',
          policy_number: 'POL-7',
        },
        [],
      );
    const rows = [tied('t3'), tied('t1'), tied('t2')];

    expect(compareRenewalRows(rows[0], rows[0], TODAY)).toBe(0);
    expect(Math.sign(compareRenewalRows(tied('t1'), tied('t2'), TODAY))).toBe(-1);
    expect(sortedIds(rows)).toEqual(['t1', 't2', 't3']);
  });

  const SAMPLE: readonly RenewalRow[] = [
    makeRow({ id: 'r1', next_follow_up_at: '2026-02-08', renewal_date: '2026-02-20', customer_name: 'Nadia Cruz', policy_number: 'POL-3' }, contact),
    makeRow({ id: 'r2', next_follow_up_at: '2026-02-01', renewal_date: '2026-03-01', customer_name: 'abel ruiz', policy_number: 'POL-9' }, []),
    makeRow({ id: 'r3', next_follow_up_at: null, renewal_date: '2026-02-11', customer_name: 'Carmen Diaz', policy_number: 'pol-1' }, []),
    makeRow({ id: 'r4', next_follow_up_at: null, renewal_date: '2026-02-11', customer_name: 'carmen diaz', policy_number: 'POL-2' }, contact),
    makeRow({ id: 'r5', next_follow_up_at: TODAY, renewal_date: '2026-02-11', customer_name: 'Bob Stone', policy_number: 'POL-7' }, []),
    makeRow({ id: 'r6', next_follow_up_at: TODAY, renewal_date: '2026-02-11', customer_name: 'Bob Stone', policy_number: 'POL-7' }, []),
    makeRow({ id: 'r7', next_follow_up_at: '2026-02-12', renewal_date: '2026-06-01', customer_name: 'Zed Ames', policy_number: 'POL-5' }, contact),
    makeRow({ id: 'r8', next_follow_up_at: null, renewal_date: null, customer_name: 'Yara Bo', policy_number: 'POL-4' }, contact),
  ];

  it('is antisymmetric over every pair', () => {
    // Negating a sign of zero would produce -0, which is not the same value as 0.
    const negate = (value: number) => (value === 0 ? 0 : -value);

    for (const left of SAMPLE) {
      for (const right of SAMPLE) {
        const forward = Math.sign(compareRenewalRows(left, right, TODAY));
        const backward = Math.sign(compareRenewalRows(right, left, TODAY));

        expect(forward).toBe(negate(backward));
        if (left.record.id === right.record.id) expect(forward).toBe(0);
        else expect(forward).not.toBe(0);
      }
    }
  });

  it('sorts two different shuffles of the same rows into the same order', () => {
    const pick = (order: readonly number[]) => order.map((index) => SAMPLE[index]);
    const shuffleA = pick([4, 7, 1, 6, 0, 3, 5, 2]);
    const shuffleB = pick([2, 5, 3, 0, 6, 1, 7, 4]);

    expect(sortedIds(shuffleA)).toEqual(sortedIds(shuffleB));
    // Key 1 lifts the two overdue rows out first, ordered by renewal date: r1
    // (02-20) then r2 (03-01). The rest go by renewal date, so the four rows on
    // 02-11 come next: no-contact first drops r4 behind r3, r5, r6, and name
    // ascending puts 'Bob Stone' (r5, r6, split by id) ahead of 'Carmen Diaz'
    // (r3). Then r7 on 06-01, and r8 with no renewal date last.
    expect(sortedIds(shuffleA)).toEqual(['r1', 'r2', 'r5', 'r6', 'r3', 'r4', 'r7', 'r8']);
  });
});

// ---------------------------------------------------------------------------
// recommendedNextAction (Requirement 5.2)
// ---------------------------------------------------------------------------

describe('recommendedNextAction', () => {
  it('rule 1: Close renewal for a recorded outcome', () => {
    for (const status of ['renewed', 'lost', 'cancelled'] as const) {
      expect(recommendedNextAction(makeRecord({ status }))).toBe('Close renewal');
    }
  });

  it('rule 2: Record customer decision while the requote sits with the customer', () => {
    expect(recommendedNextAction(makeRecord({ status: 'requote_sent' }))).toBe(
      'Record customer decision',
    );
  });

  it('rule 3: Review requote when no contact follows the latest requote activity', () => {
    const record = makeRecord({ status: 'in_progress' });
    const requotes = requotesAt('2026-02-05T14:00:00Z', '2026-02-07T09:00:00Z');
    const contacts = contactsAt('2026-02-06T10:00:00Z');

    expect(recommendedNextAction(record, contacts, requotes)).toBe('Review requote');
  });

  it('rule 3: requote activity stored on the record itself also counts', () => {
    expect(
      recommendedNextAction(makeRecord({ status: 'in_progress', requote_work_item_id: 'wi-1' })),
    ).toBe('Review requote');
    expect(
      recommendedNextAction(makeRecord({ status: 'in_progress', requote_sent_at: '2026-02-05T14:00:00Z' })),
    ).toBe('Review requote');
  });

  it('rule 3 outranks rule 4 when the requote flag is set and requote activity exists', () => {
    const record = makeRecord({ status: 'in_progress', requote_requested: true });

    expect(recommendedNextAction(record, [], requotesAt('2026-02-05T14:00:00Z'))).toBe('Review requote');
  });

  it('rule 4: Prepare requote for a flagged record with no requote activity', () => {
    const record = makeRecord({ status: 'in_progress', requote_requested: true });

    expect(recommendedNextAction(record, contactsAt('2026-02-01T15:00:00Z'), [])).toBe('Prepare requote');
    // Rule 4 also outranks rule 5: no contact has been recorded here either.
    expect(recommendedNextAction(record, [], [])).toBe('Prepare requote');
  });

  it('rule 5: Make first contact when no contact has been recorded', () => {
    expect(recommendedNextAction(makeRecord({ status: 'assigned' }), [], [])).toBe('Make first contact');
  });

  it('rule 6: Complete follow-up when no earlier rule holds', () => {
    const record = makeRecord({ status: 'monitoring', requote_requested: false });

    expect(recommendedNextAction(record, contactsAt('2026-02-01T15:00:00Z'), [])).toBe('Complete follow-up');
  });

  it('rule 1 outranks every later rule', () => {
    // Closed, plus the conditions of rules 2 through 5 all satisfied.
    const record = makeRecord({
      status: 'renewed',
      requote_requested: true,
      requote_sent_at: '2026-02-05T14:00:00Z',
    });

    expect(recommendedNextAction(record, [], requotesAt('2026-02-05T14:00:00Z'))).toBe('Close renewal');
  });

  it('a contact recorded after the latest requote activity turns rule 3 off', () => {
    const record = makeRecord({ status: 'in_progress' });
    const requotes = requotesAt('2026-02-05T14:00:00Z');
    const laterContact = contactsAt('2026-02-06T10:00:00Z');

    expect(recommendedNextAction(record, laterContact, requotes)).toBe('Complete follow-up');
    // Without that later contact the same record is back on rule 3.
    expect(recommendedNextAction(record, contactsAt('2026-02-04T10:00:00Z'), requotes)).toBe(
      'Review requote',
    );
  });
});

// ---------------------------------------------------------------------------
// summaryCounts (Requirement 3.3)
// ---------------------------------------------------------------------------

describe('summaryCounts', () => {
  it('returns all ten counts', () => {
    const counts = summaryCounts([], contactIndex([]), '', TODAY);

    expect(Object.keys(counts).sort()).toEqual([...ALL_FILTER_IDS].sort());
    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
  });

  it('counts one record in every filter whose rule it satisfies', () => {
    const record = makeRecord({
      id: 'multi',
      status: 'monitoring',
      next_follow_up_at: '2026-02-08',
      renewal_date: '2026-02-12',
    });
    const counts = summaryCounts([record], contactIndex([]), '', TODAY);

    expect(counts).toEqual({
      'overdue-follow-up': 1,
      'follow-up-due-today': 0,
      'due-within-3-days': 1,
      'due-within-7-days': 1,
      'due-within-15-days': 1,
      'due-within-30-days': 1,
      'no-contact-recorded': 1,
      'waiting-on-customer': 1,
      'requote-requested': 0,
      'customer-decision-pending': 0,
    });
  });

  it('restricts every count to records matching the active search text', () => {
    const records = [
      makeRecord({ id: 'a', customer_name: 'Acme Holdings', renewal_date: '2026-02-12' }),
      makeRecord({ id: 'b', customer_name: 'Brightline LLC', renewal_date: '2026-02-12' }),
    ];
    const index = contactIndex([]);

    expect(summaryCounts(records, index, '', TODAY)['due-within-3-days']).toBe(2);
    expect(summaryCounts(records, index, '  ACME  ', TODAY)['due-within-3-days']).toBe(1);
    expect(summaryCounts(records, index, 'no-such-client', TODAY)['due-within-3-days']).toBe(0);
  });

  it('excludes closed records from every count', () => {
    const records = [
      makeRecord({ id: 'open', renewal_date: '2026-02-12', next_follow_up_at: '2026-02-08' }),
      makeRecord({ id: 'renewed', status: 'renewed', renewal_date: '2026-02-12', next_follow_up_at: '2026-02-08' }),
      makeRecord({ id: 'lost', status: 'lost', renewal_date: '2026-02-12', next_follow_up_at: '2026-02-08' }),
      makeRecord({ id: 'cancelled', status: 'cancelled', renewal_date: '2026-02-12', next_follow_up_at: '2026-02-08' }),
    ];
    const counts = summaryCounts(records, contactIndex([]), '', TODAY);

    expect(counts['overdue-follow-up']).toBe(1);
    expect(counts['due-within-30-days']).toBe(1);
    expect(counts['no-contact-recorded']).toBe(1);
  });

  it('reads contact entries per record id, defaulting to none', () => {
    const records = [
      makeRecord({ id: 'with-contact', renewal_date: '2026-02-12' }),
      makeRecord({ id: 'without-contact', renewal_date: '2026-02-12' }),
    ];
    const index = contactIndex([['with-contact', contactsAt('2026-02-01T15:00:00Z')]]);

    expect(summaryCounts(records, index, '', TODAY)['no-contact-recorded']).toBe(1);
  });

  it('computes every count over the whole record set, not the set a filter would show', () => {
    const records = [
      makeRecord({ id: 'overdue', next_follow_up_at: '2026-02-08', renewal_date: '2026-02-12' }),
      makeRecord({ id: 'due-later', next_follow_up_at: '2026-02-20', renewal_date: '2026-03-10' }),
      makeRecord({ id: 'decision', status: 'requote_sent', next_follow_up_at: TODAY, renewal_date: '2026-02-25' }),
    ];
    const index = contactIndex([]);
    const counts = summaryCounts(records, index, '', TODAY);

    // Selecting Overdue follow-up would show one row; the other counts stay whole.
    expect(counts['overdue-follow-up']).toBe(1);
    expect(counts['follow-up-due-today']).toBe(1);
    expect(counts['due-within-30-days']).toBe(3);
    expect(counts['customer-decision-pending']).toBe(1);

    // Each count equals the tally of the filter's own rule across every record.
    for (const id of ALL_FILTER_IDS) {
      const tally = records.filter((record) =>
        matchesSummaryFilter(record, index.get(record.id) ?? [], id, TODAY),
      ).length;

      expect(counts[id]).toBe(tally);
    }
  });
});

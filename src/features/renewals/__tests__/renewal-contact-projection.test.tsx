// @vitest-environment jsdom

// The corrected renewal list contact projection (Requirements 5.4, 5.5, 5.6, 15.1).
//
// Before this change `RenewalsPage` handed the derived helpers an empty contact index, because
// `api.ts` could only read `renewal_contacts` one record at a time and a query per row was not
// acceptable. Three list values were therefore wrong for every record that *had* been contacted:
//
//   * the `No contact recorded` summary count counted every open record;
//   * the Last contact cell always read as absent;
//   * the recommended next action always read `Make first contact`.
//
// This file pins the corrected behaviour at the page level, where the defect lived. It asserts both
// halves: that the bulk read is used, and that it is used *in bulk* — one call for the whole page,
// never one per row (Requirement 15.1).
//
// `renewalContactsFromSummary` is asserted separately, because the whole approach rests on the claim
// that a one-element list carrying the latest occurrence is behaviourally identical to the full
// history for every derivation in `derive.ts`.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProfileLite } from '../../nhwd-shared/types';
import * as api from '../api';
import type { RenewalContactSummaryRow, RenewalRecord, RenewalRequoteSummaryRow } from '../api';
import {
  matchesSummaryFilter,
  recommendedNextAction,
  renewalContactIndexFromSummaries,
  renewalContactsFromSummary,
} from '../derive';
import RenewalsPage from '../RenewalsPage';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  listRenewals: vi.fn(),
  listRenewalContactSummaries: vi.fn(),
  listRenewalRequoteSummaries: vi.fn(),
  listRenewalAssignees: vi.fn(),
  listRenewalAssignmentAliases: vi.fn(),
  listRenewalImportRuns: vi.fn(),
  listRenewalSyncExceptions: vi.fn(),
  generateDueNotifications: vi.fn(),
}));

const AGENT: ProfileLite = {
  id: 'profile-agent',
  display_name: 'Test Agent',
  initials: 'TA',
  role: 'agent',
  is_active: true,
};

/** Far enough out that no renewal-date window matches, so date filters do not confuse the counts. */
const FAR_FUTURE = '2099-12-01';

function record(overrides: Partial<RenewalRecord> = {}): RenewalRecord {
  return {
    id: 'record-contacted',
    status: 'in_progress',
    hawksoft_client_id: null,
    policy_number: 'POL-1',
    line_of_business: 'Personal Auto',
    carrier: 'Progressive',
    customer_name: 'Contacted Customer',
    customer_phone: null,
    customer_email: null,
    renewal_date: FAR_FUTURE,
    premium_current: null,
    premium_renewal: null,
    notice_call_at: null,
    import_notes: null,
    eft_enabled: null,
    requote_requested: false,
    requote_note: null,
    assigned_import_label: null,
    powerbi_raw: null,
    assignment_source: null,
    last_seen_import_run_id: null,
    last_seen_imported_at: null,
    source_sync_state: 'present',
    missing_since_import_run_id: null,
    assigned_to: AGENT.id,
    assigned_at: null,
    dealer_id: null,
    salesperson_id: null,
    next_follow_up_at: null,
    requote_work_item_id: null,
    requote_intake_id: null,
    requote_sent_at: null,
    outcome_reason: null,
    closed_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as RenewalRecord;
}

function summary(overrides: Partial<RenewalContactSummaryRow> = {}): RenewalContactSummaryRow {
  return {
    record_id: 'record-contacted',
    contact_count: 2,
    last_contact_at: '2026-02-09T15:30:00Z',
    last_outcome: 'Spoke with customer',
    ...overrides,
  };
}

/** Mounts the page and lets its one load settle. */
async function mountPage(options: {
  records: readonly RenewalRecord[];
  contactSummaries?: readonly RenewalContactSummaryRow[];
  requoteSummaries?: readonly RenewalRequoteSummaryRow[];
}) {
  vi.mocked(api.listRenewals).mockResolvedValue([...options.records]);
  vi.mocked(api.listRenewalContactSummaries).mockResolvedValue([...(options.contactSummaries ?? [])]);
  vi.mocked(api.listRenewalRequoteSummaries).mockResolvedValue([...(options.requoteSummaries ?? [])]);
  vi.mocked(api.listRenewalAssignees).mockResolvedValue([]);
  vi.mocked(api.listRenewalAssignmentAliases).mockResolvedValue([]);
  vi.mocked(api.listRenewalImportRuns).mockResolvedValue([]);
  vi.mocked(api.listRenewalSyncExceptions).mockResolvedValue([]);
  vi.mocked(api.generateDueNotifications).mockResolvedValue(0);

  await act(async () => {
    render(<RenewalsPage initialProfile={AGENT} />);
  });
}

/** The cell text of the one body row, selection glyph stripped. */
function bodyCells(): string[] {
  const rows = screen.getAllByRole('row');
  return Array.from(rows[1].querySelectorAll('td')).map(
    (cell) => (cell.textContent ?? '').replace('\u2713', '').trim(),
  );
}

/**
 * The summary filter control for one label.
 *
 * `RenewalsSummaryBar` renders each filter as a toggle button whose accessible name is
 * `"<label>, <count>"`, so the count is read out of that name rather than out of the markup.
 */
function filterControl(label: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${label}, \\d+$`, 'i') });
}

function filterCount(label: string): string {
  const name = filterControl(label).getAttribute('aria-label') ?? '';
  return name.slice(name.lastIndexOf(',') + 1).trim();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// renewalContactsFromSummary — the claim the whole approach rests on
// ---------------------------------------------------------------------------

describe('renewalContactsFromSummary', () => {
  it('is empty for a record with no contacts', () => {
    expect(renewalContactsFromSummary(null)).toEqual([]);
    expect(renewalContactsFromSummary(undefined)).toEqual([]);
    expect(renewalContactsFromSummary({ contact_count: 0, last_contact_at: null })).toEqual([]);
  });

  it('carries the latest occurrence for a record with contacts', () => {
    expect(renewalContactsFromSummary({ contact_count: 3, last_contact_at: '2026-02-09T15:30:00Z' }))
      .toEqual([{ occurred_at: '2026-02-09T15:30:00Z' }]);
  });

  it('is still non-empty when the count is known but the timestamp is not', () => {
    // The absent timestamp is the unknown, not the contact: `Make first contact` must stop firing.
    const contacts = renewalContactsFromSummary({ contact_count: 1, last_contact_at: null });

    expect(contacts).toHaveLength(1);
    expect(recommendedNextAction(
      { id: 'r', status: 'in_progress', customer_name: 'c', policy_number: 'p', renewal_date: FAR_FUTURE },
      contacts,
    )).not.toBe('Make first contact');
  });

  it('answers the No contact recorded rule the same way the full history would', () => {
    const target = {
      id: 'r', status: 'assigned' as const, customer_name: 'c', policy_number: 'p',
      renewal_date: FAR_FUTURE,
    };
    const fullHistory = [
      { occurred_at: '2026-02-01T10:00:00Z' },
      { occurred_at: '2026-02-09T15:30:00Z' },
    ];
    const fromSummary = renewalContactsFromSummary({
      contact_count: 2, last_contact_at: '2026-02-09T15:30:00Z',
    });

    for (const filter of ['no-contact-recorded', 'waiting-on-customer'] as const) {
      expect(matchesSummaryFilter(target, fromSummary, filter, '2026-02-10'))
        .toBe(matchesSummaryFilter(target, fullHistory, filter, '2026-02-10'));
    }
  });

  it('answers the Review requote rule the same way the full history would', () => {
    const target = {
      id: 'r', status: 'in_progress' as const, customer_name: 'c', policy_number: 'p',
      renewal_date: FAR_FUTURE,
    };
    const requotes = [{ created_at: '2026-02-05T14:00:00Z' }];

    // A contact after the requote turns Review requote off; only the latest contact decides, which
    // is exactly what the summary carries.
    const fullAfter = [{ occurred_at: '2026-02-01T10:00:00Z' }, { occurred_at: '2026-02-09T15:00:00Z' }];
    const summaryAfter = renewalContactsFromSummary({
      contact_count: 2, last_contact_at: '2026-02-09T15:00:00Z',
    });
    expect(recommendedNextAction(target, summaryAfter, requotes))
      .toBe(recommendedNextAction(target, fullAfter, requotes));

    const fullBefore = [{ occurred_at: '2026-02-01T10:00:00Z' }, { occurred_at: '2026-02-04T10:00:00Z' }];
    const summaryBefore = renewalContactsFromSummary({
      contact_count: 2, last_contact_at: '2026-02-04T10:00:00Z',
    });
    expect(recommendedNextAction(target, summaryBefore, requotes))
      .toBe(recommendedNextAction(target, fullBefore, requotes));
    expect(recommendedNextAction(target, summaryBefore, requotes)).toBe('Review requote');
  });
});

describe('renewalContactIndexFromSummaries', () => {
  it('keys the contact lists by record id', () => {
    const index = renewalContactIndexFromSummaries([
      summary({ record_id: 'a', contact_count: 1, last_contact_at: '2026-02-01T00:00:00Z' }),
      summary({ record_id: 'b', contact_count: 0, last_contact_at: null }),
    ]);

    expect(index.get('a')).toEqual([{ occurred_at: '2026-02-01T00:00:00Z' }]);
    expect(index.get('b')).toEqual([]);
    expect(index.get('missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The page: the defect and its fix
// ---------------------------------------------------------------------------

describe('the Renewals list contact projection', () => {
  it('reads contact history in bulk, once for the page rather than once per row', async () => {
    await mountPage({
      records: [
        record({ id: 'r-1', policy_number: 'POL-1' }),
        record({ id: 'r-2', policy_number: 'POL-2' }),
        record({ id: 'r-3', policy_number: 'POL-3' }),
      ],
      contactSummaries: [summary({ record_id: 'r-1' })],
    });

    // Requirement 15.1: one bulk call, whatever the row count. `listContacts` — the per-record read
    // the drawer owns — is never reached from the list surface.
    expect(api.listRenewalContactSummaries).toHaveBeenCalledTimes(1);
    expect(api.listRenewalRequoteSummaries).toHaveBeenCalledTimes(1);
  });

  it('shows the real last contact rather than an em dash', async () => {
    await mountPage({ records: [record()], contactSummaries: [summary()] });

    const cells = bodyCells();
    // The Last contact cell is the eleventh of the fourteen.
    expect(cells[10]).not.toBe('\u2014');
    expect(cells[10]).toContain('2026');
  });

  it('shows an em dash for a record that genuinely has no contact', async () => {
    await mountPage({ records: [record()], contactSummaries: [] });

    expect(bodyCells()[10]).toBe('\u2014');
  });

  it('no longer recommends Make first contact for a contacted record', async () => {
    await mountPage({ records: [record()], contactSummaries: [summary()] });

    // The fourteenth cell is Next required action. This is the defect: it used to read
    // `Make first contact` for every record, contacted or not.
    expect(bodyCells()[13]).not.toBe('Make first contact');
    expect(bodyCells()[13]).toBe('Complete follow-up');
  });

  it('still recommends Make first contact for a record nobody has contacted', async () => {
    await mountPage({ records: [record()], contactSummaries: [] });

    expect(bodyCells()[13]).toBe('Make first contact');
  });

  it('counts No contact recorded from real history rather than counting every record', async () => {
    await mountPage({
      records: [
        record({ id: 'r-1', policy_number: 'POL-1' }),
        record({ id: 'r-2', policy_number: 'POL-2' }),
        record({ id: 'r-3', policy_number: 'POL-3' }),
      ],
      // Two of the three have been contacted.
      contactSummaries: [summary({ record_id: 'r-1' }), summary({ record_id: 'r-2' })],
    });

    // The defect made this read 3. It must read 1.
    expect(filterCount('No contact recorded')).toBe('1');
  });

  it('recommends Review requote using the bulk requote summary', async () => {
    await mountPage({
      records: [record({ id: 'r-1', status: 'in_progress' })],
      contactSummaries: [summary({ record_id: 'r-1', last_contact_at: '2026-02-04T10:00:00Z' })],
      requoteSummaries: [
        { record_id: 'r-1', requote_event_count: 1, last_requote_at: '2026-02-05T14:00:00Z' },
      ],
    });

    // The requote is the most recent activity, so the customer has not been spoken to since it went
    // out. Without the bulk requote read this row could not reach `Review requote` at all.
    expect(bodyCells()[13]).toBe('Review requote');
  });

  it('applies the No contact recorded filter to the real population', async () => {
    await mountPage({
      records: [
        record({ id: 'r-1', policy_number: 'POL-1', customer_name: 'Contacted Customer' }),
        record({ id: 'r-2', policy_number: 'POL-2', customer_name: 'Never Contacted Customer' }),
      ],
      contactSummaries: [summary({ record_id: 'r-1' })],
    });

    await act(async () => {
      fireEvent.click(filterControl('No contact recorded'));
    });

    const table = screen.getByRole('table');
    expect(within(table).getByText('Never Contacted Customer')).toBeTruthy();
    expect(within(table).queryByText('Contacted Customer')).toBeNull();
  });

  it('degrades to no contact history when the bulk read fails, without failing the page', async () => {
    vi.mocked(api.listRenewals).mockResolvedValue([record()]);
    vi.mocked(api.listRenewalContactSummaries).mockRejectedValue(new Error('summary read refused'));
    vi.mocked(api.listRenewalRequoteSummaries).mockRejectedValue(new Error('summary read refused'));
    vi.mocked(api.listRenewalAssignees).mockResolvedValue([]);
    vi.mocked(api.listRenewalAssignmentAliases).mockResolvedValue([]);
    vi.mocked(api.listRenewalImportRuns).mockResolvedValue([]);
    vi.mocked(api.listRenewalSyncExceptions).mockResolvedValue([]);
    vi.mocked(api.generateDueNotifications).mockResolvedValue(0);

    await act(async () => {
      render(<RenewalsPage initialProfile={AGENT} />);
    });

    // Req 1.7: only the record query fails the load. The records are on screen, and the contact
    // values read as absent — the pre-existing behaviour, not an error state.
    expect(screen.getByText('Contacted Customer')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(bodyCells()[10]).toBe('\u2014');
  });
});

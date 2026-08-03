// @vitest-environment jsdom

// Contract of the cancellations page container (task 16.12).
//
// Two parts, and neither of them re-tests a child: the note submission limits of Requirements 17.8
// and 17.9, which the container decides before anything is uploaded, and the load, failure, retry,
// and clearing behavior of Requirements 1.5, 1.6, 1.7, and 1.10, which is the only behavior this
// file owns that the summary bar, the table, and the drawer do not.
//
// Only the container's read functions are replaced; every constant, type, and derivation still
// comes from the real `api.ts` and `derive.ts`, so a rename there breaks this file rather than
// silently passing.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    listCancellationCases: vi.fn(),
    listContactsForCases: vi.fn(),
    listCommunicationsForCases: vi.fn(),
    listCustomerResponsesForCases: vi.fn(),
    listEscalationsForCases: vi.fn(),
    listSuppressions: vi.fn(),
    listCancellationAssignees: vi.fn(),
    listCancellationImportRuns: vi.fn(),
    listCancellationTemplates: vi.fn(),
    getCancellationSettings: vi.fn(),
    getCancellationActor: vi.fn(),
  };
});

import type { ProfileLite } from '../../nhwd-shared/types';
import * as api from '../api';
import {
  MAX_EVIDENCE_FILES,
  MAX_EVIDENCE_SIZE_BYTES,
  MAX_NOTE_LENGTH,
  type CancellationCase,
} from '../api';
import CancellationsPage, { noteRejection } from '../CancellationsPage';

afterEach(cleanup);

const PROFILE: ProfileLite = {
  id: 'profile-1',
  display_name: 'Ada Byron',
  initials: 'AB',
  role: 'agent',
  is_active: true,
};

/**
 * An unassigned open case with no contact row, which an agent may read (Requirement 22.1) and which
 * the default Needs Action filter matches on its missing contact detail alone (Requirement 16.8), so
 * the row is on screen without the test having to name a business date.
 */
function caseRow(overrides: Partial<CancellationCase> = {}): CancellationCase {
  return {
    id: 'case-1',
    policy_number: 'POL-1001',
    policy_number_normalized: 'POL1001',
    cancellation_effective_date: '2099-04-15',
    customer_name: 'Grace Hopper',
    client_identifier: null,
    customer_match_key: null,
    carrier: 'Progressive',
    cancellation_reason: 'Non-payment',
    amount_due: '412.55',
    case_status: 'Open',
    communication_status: 'Not Scheduled',
    next_required_action: null,
    assigned_to: null,
    assignment_source: 'import',
    producer_label: null,
    follow_up_deadline: null,
    assistance_requested: false,
    import_run_id: null,
    source_row_number: 2,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function casePage(rows: readonly CancellationCase[]): api.CancellationCasePage {
  return { rows: [...rows], page: 0, pageSize: 50, hasMore: false, total: rows.length };
}

/** A file of a stated size without allocating one: only the size is under test. */
function sizedFile(name: string, size: number): File {
  const file = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

beforeEach(() => {
  vi.mocked(api.listCancellationCases).mockResolvedValue(casePage([caseRow()]));
  vi.mocked(api.listContactsForCases).mockResolvedValue([]);
  vi.mocked(api.listCommunicationsForCases).mockResolvedValue([]);
  vi.mocked(api.listCustomerResponsesForCases).mockResolvedValue([]);
  vi.mocked(api.listEscalationsForCases).mockResolvedValue([]);
  vi.mocked(api.listSuppressions).mockResolvedValue([]);
  vi.mocked(api.listCancellationAssignees).mockResolvedValue([]);
  vi.mocked(api.listCancellationImportRuns).mockResolvedValue([]);
  vi.mocked(api.listCancellationTemplates).mockResolvedValue([]);
  vi.mocked(api.getCancellationSettings).mockResolvedValue(null);
  vi.mocked(api.getCancellationActor).mockResolvedValue({
    id: PROFILE.id,
    display_name: PROFILE.display_name,
    role: PROFILE.role,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('noteRejection (Requirements 17.8, 17.9)', () => {
  it('refuses text of zero trimmed characters and states the required range', () => {
    const rejection = noteRejection('   \n  ', []);
    expect(rejection).toContain(`1 to ${MAX_NOTE_LENGTH.toLocaleString('en-US')} characters`);
    expect(rejection).toContain('Nothing was saved.');
  });

  it('measures the length after trimming, so padding neither saves nor sinks a note', () => {
    expect(noteRejection(`  ${'a'.repeat(MAX_NOTE_LENGTH)}  `, [])).toBeNull();
    expect(noteRejection('a'.repeat(MAX_NOTE_LENGTH + 1), [])).toContain(
      (MAX_NOTE_LENGTH + 1).toLocaleString('en-US'),
    );
  });

  it('refuses more than ten evidence files and stores none of them', () => {
    const files = Array.from({ length: MAX_EVIDENCE_FILES + 1 }, (_, index) =>
      sizedFile(`proof-${index}.pdf`, 1_024),
    );
    const rejection = noteRejection('Customer called back.', files);
    expect(rejection).toContain(`At most ${MAX_EVIDENCE_FILES} evidence files`);
    expect(rejection).toContain('No evidence file was stored and the note was not saved.');
    expect(noteRejection('Customer called back.', files.slice(0, MAX_EVIDENCE_FILES))).toBeNull();
  });

  it('refuses a file over the 100 MB limit, naming the file and the limit', () => {
    const rejection = noteRejection('Customer called back.', [
      sizedFile('small.pdf', 2_048),
      sizedFile('scan.pdf', MAX_EVIDENCE_SIZE_BYTES + 1),
    ]);
    expect(rejection).toContain('"scan.pdf"');
    expect(rejection).toContain('100.0 MB evidence limit');
    expect(noteRejection('Customer called back.', [sizedFile('scan.pdf', MAX_EVIDENCE_SIZE_BYTES)])).toBeNull();
  });
});

describe('CancellationsPage', () => {
  it('shows a loading indicator until the first page returns, then the row (Req 1.5)', async () => {
    render(<CancellationsPage initialProfile={PROFILE} embedded />);

    expect(screen.getByRole('status').textContent).toContain('Loading cancellations');

    await waitFor(() => expect(screen.getByRole('button', { name: /Grace Hopper/ })).toBeTruthy());
    expect(screen.queryByText(/Loading cancellations/)).toBeNull();
  });

  it('names the failed query, keeps the loaded rows, and re-runs it on retry (Req 1.7, 1.10)', async () => {
    render(<CancellationsPage initialProfile={PROFILE} embedded />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Grace Hopper/ })).toBeTruthy());

    vi.mocked(api.listCancellationCases).mockRejectedValueOnce(new Error('Connection lost.'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('The cancellation record query failed.'),
    );
    // Requirement 1.7: the rows loaded before the failed query are still on screen.
    expect(screen.getByRole('button', { name: /Grace Hopper/ })).toBeTruthy();

    const callsBeforeRetry = vi.mocked(api.listCancellationCases).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(vi.mocked(api.listCancellationCases).mock.calls.length).toBe(callsBeforeRetry + 1);
    expect(screen.getByRole('button', { name: /Grace Hopper/ })).toBeTruthy();
  });

  it('clears the saved filter to All and the search text together (Req 1.6)', async () => {
    render(<CancellationsPage initialProfile={PROFILE} embedded />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Grace Hopper/ })).toBeTruthy());

    const search = screen.getByRole('searchbox', { name: 'Search cancellations' }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'nobody by this name' } });

    const clear = await screen.findByRole('button', { name: 'Clear the filter and the search text' });
    fireEvent.click(clear);

    await waitFor(() => expect(screen.getByRole('button', { name: /Grace Hopper/ })).toBeTruthy());
    expect((screen.getByRole('searchbox', { name: 'Search cancellations' }) as HTMLInputElement).value).toBe('');
    // Reading 5: the clearing control selects All, not Needs Action, so the list is not narrowed.
    expect((screen.getByRole('radio', { name: 'All, 1' }) as HTMLInputElement).checked).toBe(true);
  });
});

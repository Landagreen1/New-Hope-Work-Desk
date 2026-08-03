// @vitest-environment jsdom

// Manager action contract of the renewals workspace (task 4.2).
//
// Covers the renewal import reporting the four counts reported by `renewal_import_batch` (6.5),
// counts the function omits reading as zero (6.5), an import error reporting four zeros while
// leaving every record write untouched (6.6), assignment mapping alias upsert and delete, employee
// assignment through `assignRenewal`, the unmatched assignment review listing every label with its
// unassigned row count (6.7), and a profile outside Manager_Role rendering zero nodes and reaching
// zero renewal writes (6.2, 6.8). `manager` and `super_admin` run the same assertions (6.4).
//
// Only the six network calls of `../api` are replaced. The pure helpers — `parseCsv`,
// `guessMapping`, `buildNormalizedRows`, `extractDistinctAssignmentLabels`,
// `normalizeAssignmentLabel`, `normalizeDate` — run for real, so the arguments asserted on
// `importBatch` are the values those helpers actually produce.
//
// Validates: Requirements 6.5, 6.6, 6.7, 6.8, 25.1

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppRole } from '@/lib/types';
import * as api from '../api';
import type {
  ImportBatchResult, RenewalAssignee, RenewalAssignmentAlias, RenewalImportRun, RenewalRecord,
} from '../api';
import RenewalManagerActions, { MANAGER_ACTION_LABELS } from '../RenewalManagerActions';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  importBatch: vi.fn(),
  assignRenewal: vi.fn(),
  managerUpdateRecord: vi.fn(),
  upsertRenewalAssignmentAlias: vi.fn(),
  deleteRenewalAssignmentAlias: vi.fn(),
  listRenewalAssignees: vi.fn(),
}));

/** Every role that holds Manager_Role. `super_admin` runs the same assertions (Req 6.4). */
const MANAGER_ROLES: readonly AppRole[] = ['manager', 'super_admin'];

/** Roles outside Manager_Role that reach the renewals workspace. */
const NON_MANAGER_ROLES: readonly AppRole[] = ['agent', 'customer_service', 'sales_supervisor'];

const CSV_TEXT = [
  'Named Insured,Company,LOB,Policy#,Renewal Date,Asignacion TXT,Phone,Email',
  'Ada Byron,Progressive,Personal Auto,POL-1,03/04/2026,Maria G,7865550101,ada@example.com',
  'Alan Turing,Bristol West,Personal Auto,POL-2,2026-03-11,Maria G,7865550102,alan@example.com',
].join('\n');

const ASSIGNEES: readonly RenewalAssignee[] = [
  { id: 'p-1', username: 'maria', display_name: 'Maria Gomez', initials: 'MG', role: 'agent', is_active: true },
  { id: 'p-2', username: 'jose', display_name: 'Jose Lopez', initials: 'JL', role: 'customer_service', is_active: true },
];

const ALIAS: RenewalAssignmentAlias = {
  id: 'alias-1', import_label: 'Maria G', normalized_label: 'maria g', profile_id: 'p-1',
  created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
};

function record(overrides: Partial<RenewalRecord> = {}): RenewalRecord {
  return {
    id: 'rec-1', status: 'imported', hawksoft_client_id: null, policy_number: 'POL-1',
    line_of_business: 'Personal Auto', carrier: 'Progressive', customer_name: 'Ada Byron',
    customer_phone: null, customer_email: null, renewal_date: '2026-03-04',
    premium_current: null, premium_renewal: null, notice_call_at: null, import_notes: null,
    eft_enabled: null, requote_requested: false, requote_note: null, assigned_import_label: null,
    powerbi_raw: null, assignment_source: null, last_seen_import_run_id: null,
    last_seen_imported_at: null, source_sync_state: 'present', missing_since_import_run_id: null,
    assigned_to: null, assigned_at: null, dealer_id: null, salesperson_id: null,
    next_follow_up_at: null, requote_work_item_id: null, requote_intake_id: null,
    requote_sent_at: null, outcome_reason: null, closed_at: null,
    created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

function importRun(unmatched: string[]): RenewalImportRun {
  return {
    id: 'run-1', file_name: 'renewals.csv', imported_by: 'p-9', column_mapping: {}, rows_total: 4,
    rows_inserted: 4, rows_updated: 0, rows_skipped: 0, rows_closed_preserved: 0, rows_assigned: 1,
    rows_requote_flagged: 0, rows_missing_in_window: 0, rows_restored_present: 0,
    distinct_assignee_labels: unmatched.length, unmatched_assignees: unmatched,
    file_date_min: null, file_date_max: null, created_at: '2026-02-02T00:00:00Z',
  };
}

/** The four counts reported by a completed import, plus the labels it could not match. */
function importResult(overrides: Partial<ImportBatchResult> = {}): ImportBatchResult {
  return {
    id: 'run-1', rows_total: 6, rows_inserted: 3, rows_updated: 2, rows_skipped: 1,
    rows_assigned: 4, unmatched_assignees: ['Maria G'], ...overrides,
  };
}

/** Every write that changes a Renewal_Record row or a renewal assignment mapping. */
const WRITE_CALLS = () => [
  api.importBatch, api.assignRenewal, api.managerUpdateRecord,
  api.upsertRenewalAssignmentAlias, api.deleteRenewalAssignmentAlias,
];

beforeEach(() => {
  vi.mocked(api.listRenewalAssignees).mockResolvedValue([...ASSIGNEES]);
  vi.mocked(api.importBatch).mockResolvedValue(importResult());
  vi.mocked(api.assignRenewal).mockResolvedValue(undefined);
  vi.mocked(api.managerUpdateRecord).mockResolvedValue(undefined);
  vi.mocked(api.deleteRenewalAssignmentAlias).mockResolvedValue(undefined);
  vi.mocked(api.upsertRenewalAssignmentAlias).mockResolvedValue({ alias: ALIAS, rows_assigned: 3 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Reveal the collapsed manager menu and open one of its six controls. */
function openAction(label: string) {
  fireEvent.click(screen.getByRole('button', { name: /Manager actions/ }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Manager actions' })).getByText(label));
}

/** Load the renewal CSV in the import panel and wait for the mapping step. */
async function loadCsv(text = CSV_TEXT) {
  openAction('Import renewals');
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([text], 'renewals.csv', { type: 'text/csv' });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
}

/** Run the import and let the reported summary settle. */
async function commitImport() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Import and assign 2 renewals/ }));
  });
}

/** Every reported count in the held import summary, keyed by its label. */
function reportedCounts(): Record<string, string> {
  const entries = Array.from(document.querySelectorAll('dl > div'), (item) => [
    (item.querySelector('dt')?.textContent ?? '').trim(),
    (item.querySelector('dd')?.textContent ?? '').trim(),
  ] as const);
  return Object.fromEntries(entries);
}

/** The exact values the real helpers derive from the CSV, as passed to `importBatch`. */
function expectedImportArguments() {
  const parsed = api.parseCsv(CSV_TEXT);
  const mapping = api.guessMapping(parsed.headers);
  return { mapping, rows: api.buildNormalizedRows(parsed.headers, parsed.rows, mapping) };
}

describe('RenewalManagerActions manager menu', () => {
  it.each(MANAGER_ROLES)('reveals exactly the six manager controls for %s', (role) => {
    render(<RenewalManagerActions role={role} assignees={ASSIGNEES} />);
    expect(screen.queryByRole('group', { name: 'Manager actions' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Manager actions/ }));
    const group = screen.getByRole('group', { name: 'Manager actions' });
    const controls = within(group).getAllByRole('button');

    // The label is the first nested span of each control; the second span carries the hint.
    const labels = controls.map((control) => (control.querySelector('span > span')?.textContent ?? '').trim());
    expect(controls).toHaveLength(6);
    expect(labels).toEqual([...MANAGER_ACTION_LABELS]);
  });

  it.each(NON_MANAGER_ROLES)('renders zero nodes and reaches zero renewal writes for %s', (role) => {
    const { container } = render(
      <RenewalManagerActions role={role} records={[record()]} aliases={[ALIAS]} importRuns={[importRun(['Maria G'])]} />,
    );

    // Requirement 6.2: absent from the interface, not disabled. Requirement 6.8: nothing changes.
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
    for (const label of MANAGER_ACTION_LABELS) expect(screen.queryByText(label)).toBeNull();
    for (const call of WRITE_CALLS()) expect(call).not.toHaveBeenCalled();
    expect(api.listRenewalAssignees).not.toHaveBeenCalled();
  });
});

describe('RenewalManagerActions renewal import', () => {
  it.each(MANAGER_ROLES)('imports through importBatch and reports the four counts for %s', async (role) => {
    const onChanged = vi.fn();
    render(<RenewalManagerActions role={role} assignees={ASSIGNEES} onChanged={onChanged} />);

    await loadCsv();
    await commitImport();

    const { mapping, rows } = expectedImportArguments();
    expect(vi.mocked(api.importBatch).mock.calls).toEqual([['renewals.csv', mapping, rows]]);
    expect(reportedCounts()).toEqual({
      'Rows inserted': '3', 'Rows updated': '2', 'Rows skipped': '1', 'Rows assigned': '4',
    });

    const summary = screen.getByRole('status');
    expect(summary.textContent).toContain('Renewal import completed');
    expect(summary.textContent).toContain('Unmatched assignment labels: 1');
    expect(within(summary).getByRole('listitem').textContent).toBe('Maria G');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('reports zero for every count the import function reports as zero or absent', async () => {
    // `renewal_import_batch` omits the optional counts when it assigned nothing.
    vi.mocked(api.importBatch).mockResolvedValue({
      id: 'run-2', rows_total: 2, rows_inserted: 2, rows_updated: 0, rows_skipped: 0,
    });
    render(<RenewalManagerActions role="manager" assignees={ASSIGNEES} />);

    await loadCsv();
    await commitImport();

    expect(reportedCounts()).toEqual({
      'Rows inserted': '2', 'Rows updated': '0', 'Rows skipped': '0', 'Rows assigned': '0',
    });
    expect(screen.getByRole('status').textContent).toContain('Unmatched assignment labels: 0');
  });

  it('reports four zeros and changes no record when importBatch returns an error', async () => {
    vi.mocked(api.importBatch).mockRejectedValue(new Error('renewal_import_batch rejected row 2.'));
    const onChanged = vi.fn();
    render(<RenewalManagerActions role="manager" records={[record()]} assignees={ASSIGNEES} onChanged={onChanged} />);

    await loadCsv();
    await commitImport();

    const failure = screen.getByRole('alert');
    expect(failure.textContent).toContain('Renewal import failed: renewal_import_batch rejected row 2.');
    expect(reportedCounts()).toEqual({
      'Rows inserted': '0', 'Rows updated': '0', 'Rows skipped': '0', 'Rows assigned': '0',
    });

    // Requirement 6.6: no Renewal_Record row and no assignment mapping was written.
    expect(api.assignRenewal).not.toHaveBeenCalled();
    expect(api.managerUpdateRecord).not.toHaveBeenCalled();
    expect(api.upsertRenewalAssignmentAlias).not.toHaveBeenCalled();
    expect(api.deleteRenewalAssignmentAlias).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('RenewalManagerActions assignment mapping', () => {
  it('saves an assignment mapping link through upsertRenewalAssignmentAlias', async () => {
    const onChanged = vi.fn();
    render(<RenewalManagerActions role="manager" aliases={[ALIAS]} assignees={ASSIGNEES} onChanged={onChanged} />);
    openAction('Assignment mapping');

    const select = screen.getByLabelText('Work Desk username for Maria G') as HTMLSelectElement;
    expect(select.value).toBe('p-1');
    fireEvent.change(select, { target: { value: 'p-2' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save link/ }));
    });

    expect(vi.mocked(api.upsertRenewalAssignmentAlias).mock.calls).toEqual([['Maria G', 'p-2']]);
    expect(screen.getByRole('status').textContent)
      .toContain('Maria G is linked to @jose. 3 open renewals were assigned or synchronized.');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.deleteRenewalAssignmentAlias).not.toHaveBeenCalled();
  });

  it('removes a saved assignment mapping link through deleteRenewalAssignmentAlias', async () => {
    const onChanged = vi.fn();
    render(<RenewalManagerActions role="manager" aliases={[ALIAS]} assignees={ASSIGNEES} onChanged={onChanged} />);
    openAction('Assignment mapping');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove link/ }));
    });

    expect(vi.mocked(api.deleteRenewalAssignmentAlias).mock.calls).toEqual([['alias-1']]);
    expect(screen.getByRole('status').textContent)
      .toContain('Maria G is no longer linked automatically. Historical assignments were preserved.');
    expect(screen.queryByLabelText('Work Desk username for Maria G')).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.upsertRenewalAssignmentAlias).not.toHaveBeenCalled();
  });
});

describe('RenewalManagerActions employee assignment', () => {
  it.each(MANAGER_ROLES)('assigns one renewal to an employee through assignRenewal for %s', async (role) => {
    const onChanged = vi.fn();
    render(
      <RenewalManagerActions
        role={role} records={[record()]} assignees={ASSIGNEES} selectedRecordId="rec-1" onChanged={onChanged}
      />,
    );
    openAction('Reassign renewal');

    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: 'p-2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save assignment/ }));
    });

    expect(vi.mocked(api.assignRenewal).mock.calls).toEqual([['rec-1', 'p-2']]);
    expect(screen.getByRole('status').textContent).toContain('POL-1 is assigned to Jose Lopez.');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.managerUpdateRecord).not.toHaveBeenCalled();
  });
});

describe('RenewalManagerActions unmatched assignment review', () => {
  it('lists every unmatched label of the most recent import with its unassigned row count', () => {
    const records = [
      record({ id: 'rec-1', assigned_import_label: 'Maria G', assigned_to: null }),
      record({ id: 'rec-2', assigned_import_label: 'maria  g', assigned_to: null }),
      record({ id: 'rec-3', assigned_import_label: 'Maria G', assigned_to: 'p-1' }),
      record({ id: 'rec-4', assigned_import_label: 'Jose L', assigned_to: 'p-2' }),
    ];
    render(
      <RenewalManagerActions
        role="manager" records={records} assignees={ASSIGNEES}
        importRuns={[importRun(['Maria G', ' MARIA  G ', 'Jose L'])]}
      />,
    );
    openAction('Review unmatched assignments');

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Unmatched assignment labels in the most recent completed import: 2');
    const listed = within(dialog).getAllByRole('listitem').map(
      (item) => Array.from(item.querySelectorAll('span'), (span) => (span.textContent ?? '').trim()),
    );
    expect(listed).toEqual([
      ['Maria G', '2 renewals left unassigned'],
      ['Jose L', '0 renewals left unassigned'],
    ]);
  });
});

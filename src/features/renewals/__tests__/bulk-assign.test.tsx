// @vitest-environment jsdom
// Bulk renewal assignment, and the collector export the import wizard must not ask to map (v1.14.0).
//
// Two changes are covered, and they exist for the same reason. The consolidated renewals collector
// export carries no agent column, so:
//
//   * the import wizard must recognize it and route it to the importer that needs no mapping,
//     instead of presenting twenty-six dropdowns for a header the product already knows by name; and
//   * the rows the ownership engine cannot place stay unassigned on purpose, so a manager needs to
//     clear that bucket without opening one record at a time.
//
// The pure helpers run for real — `assignRenewalBulk`'s de-duplication and bound, and
// `describeBulkAssign`'s wording — so the assertions here are about the behaviour the surface
// actually gets, not about a stub. Only the network call is replaced.
//
// The RPC's own behaviour (provenance stamp, closed-outcome guard, role refusals, de-duplication at
// the database) was proven against live Supabase by the v1.14.0 deploy probe and is not restated
// here; this file covers the client contract and the interface.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppRole } from '@/lib/types';
import * as api from '../api';
import type { BulkAssignResult, RenewalAssignee, RenewalRecord, RenewalStatus } from '../api';
import RenewalManagerActions from '../RenewalManagerActions';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  assignRenewalBulk: vi.fn(),
  assignRenewal: vi.fn(),
  listRenewalAssignees: vi.fn(),
  importBatch: vi.fn(),
  managerUpdateRecord: vi.fn(),
  upsertRenewalAssignmentAlias: vi.fn(),
  deleteRenewalAssignmentAlias: vi.fn(),
}));

const MANAGER_ROLES: readonly AppRole[] = ['manager', 'super_admin'];

const ASSIGNEES: readonly RenewalAssignee[] = [
  { id: 'p-1', username: 'maria', display_name: 'Maria Gomez', initials: 'MG', role: 'agent', is_active: true },
  { id: 'p-2', username: 'jose', display_name: 'Jose Lopez', initials: 'JL', role: 'customer_service', is_active: true },
];

/** The 26-column consolidated Spanish renewals collector export, header verbatim. */
const COLLECTOR_CSV = [
  'Compania,Poliza,PolizaNormalizada,Asegurado,LOB,TerminoMeses,FechaRenovacion,FechaVencimiento,'
  + 'FechaProcesada,PrimaRenovacion,PrimaAnterior,TipoRegistro,EstadoEnReporte,ClienteID,Titular,'
  + 'Telefonos,Emails,EstadoHawkSoft,ActivaEnHawkSoft,PrimaHawkSoft,Productor,Cruce,MetodoCruce,'
  + 'ArchivoOrigen,FilaOrigen,AvisosImportacion',
  'Progressive,ZZTEST-R-001,ZZTEST-R-001,ZZ TEST ALPHA,Personal Auto,12,2026-08-16,2026-08-16,'
  + '2026-08-14,1450.00,1200.00,Renovacion,Renewal Offered,ZZR001,ZZ TEST ALPHA,9158083304,'
  + 'a@b.com,Active,Si,1200.00,ZZ TEST PRODUCER ONE,Exacto,ClienteID,zz.csv,2,note',
].join('\n');

/** The older Power BI shape, which does vary column by column and still needs the mapping step. */
const POWERBI_CSV = [
  'Named Insured,Company,LOB,Policy#,Renewal Date,Asignacion TXT',
  'Ada Byron,Progressive,Personal Auto,POL-1,03/04/2026,Maria G',
].join('\n');

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

function bulkResult(overrides: Partial<BulkAssignResult> = {}): BulkAssignResult {
  return {
    requested: 2, assigned: 2, confirmed: 0, closed_skipped: 0, not_found: 0,
    assigned_to: 'p-1', assigned_name: 'Maria Gomez', ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(api.listRenewalAssignees).mockResolvedValue([...ASSIGNEES]);
  vi.mocked(api.assignRenewalBulk).mockResolvedValue(bulkResult());
  vi.mocked(api.assignRenewal).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openAction(label: string) {
  fireEvent.click(screen.getByRole('button', { name: /Manager actions/ }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Manager actions' })).getByText(label));
}

/** Open Reassign renewal and switch it to the bulk list. */
function openBulkAssign() {
  openAction('Reassign renewal');
  fireEvent.click(screen.getByLabelText('Several renewals'));
}

/** Choose a file in the already-open import panel. */
async function chooseFile(text: string, name: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([text], name, { type: 'text/csv' })] } });
  });
}

async function uploadCsv(text: string, name: string) {
  openAction('Import renewals');
  await chooseFile(text, name);
}

// ---------------------------------------------------------------------------
// assignRenewalBulk: the client contract
// ---------------------------------------------------------------------------

describe('assignRenewalBulk', () => {
  // The real implementation, not the mock, for the pure guards it applies before the round trip.
  const real = (async () => (await vi.importActual<typeof import('../api')>('../api')))();

  it('refuses an empty selection without calling the database', async () => {
    const { assignRenewalBulk } = await real;
    await expect(assignRenewalBulk([], 'p-1')).rejects.toThrow(/at least one renewal/i);
  });

  it('refuses a selection of only blank ids', async () => {
    const { assignRenewalBulk } = await real;
    await expect(assignRenewalBulk(['', '  '], 'p-1')).rejects.toThrow(/at least one renewal/i);
  });

  it('refuses more than the bound and names the number selected', async () => {
    const { assignRenewalBulk, MAX_BULK_ASSIGN_RECORDS } = await real;
    const tooMany = Array.from({ length: MAX_BULK_ASSIGN_RECORDS + 1 }, (_, index) => `rec-${index}`);
    await expect(assignRenewalBulk(tooMany, 'p-1')).rejects.toThrow(
      new RegExp(`${MAX_BULK_ASSIGN_RECORDS + 1} are selected`),
    );
  });

  it('bounds at 500, matching what the function enforces server-side', async () => {
    const { MAX_BULK_ASSIGN_RECORDS } = await real;
    expect(MAX_BULK_ASSIGN_RECORDS).toBe(500);
  });
});

describe('describeBulkAssign', () => {
  let describeBulkAssign: typeof api.describeBulkAssign;

  beforeEach(async () => {
    ({ describeBulkAssign } = await vi.importActual<typeof import('../api')>('../api'));
  });

  it('names only the outcome that happened on a clean run', () => {
    const sentence = describeBulkAssign(bulkResult({ requested: 3, assigned: 3 }));
    expect(sentence).toBe('3 renewals assigned to Maria Gomez.');
  });

  it('singularizes one renewal', () => {
    expect(describeBulkAssign(bulkResult({ requested: 1, assigned: 1 })))
      .toBe('1 renewal assigned to Maria Gomez.');
  });

  it('says so when rows were left alone for a recorded outcome', () => {
    const sentence = describeBulkAssign(bulkResult({ requested: 12, assigned: 3, closed_skipped: 9 }));
    expect(sentence).toContain('3 renewals assigned to Maria Gomez');
    expect(sentence).toContain('9 renewals left alone because the outcome is already recorded');
  });

  it('reports rows the employee already owned as locked rather than assigned', () => {
    const sentence = describeBulkAssign(bulkResult({ requested: 5, assigned: 2, confirmed: 3 }));
    expect(sentence).toContain('2 renewals assigned');
    expect(sentence).toContain('3 renewals already owned by them, now locked to your decision');
  });

  it('reports selections that no longer resolve', () => {
    expect(describeBulkAssign(bulkResult({ requested: 2, assigned: 1, not_found: 1 })))
      .toContain('1 selection no longer available');
  });

  it('does not mention an outcome that did not occur', () => {
    const sentence = describeBulkAssign(bulkResult({ requested: 2, assigned: 2 }));
    expect(sentence).not.toContain('already owned');
    expect(sentence).not.toContain('outcome is already recorded');
    expect(sentence).not.toContain('no longer available');
  });
});

// ---------------------------------------------------------------------------
// The bulk assign panel
// ---------------------------------------------------------------------------

describe('bulk assign panel', () => {
  const records = [
    record({ id: 'rec-1', policy_number: 'POL-1', customer_name: 'Ada Byron', assigned_to: null }),
    record({ id: 'rec-2', policy_number: 'POL-2', customer_name: 'Alan Turing', assigned_to: null }),
    record({ id: 'rec-3', policy_number: 'POL-3', customer_name: 'Grace Hopper', assigned_to: 'p-2' }),
    record({ id: 'rec-4', policy_number: 'POL-4', customer_name: 'Closed Carol', status: 'renewed' as RenewalStatus }),
  ];

  it.each(MANAGER_ROLES)('assigns the selected renewals through assignRenewalBulk for %s', async (role) => {
    const onChanged = vi.fn();
    render(<RenewalManagerActions role={role} records={records} assignees={ASSIGNEES} onChanged={onChanged} />);
    openBulkAssign();

    fireEvent.click(screen.getByRole('checkbox', { name: /Ada Byron/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Alan Turing/ }));
    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: 'p-1' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Assign 2 renewals/ }));
    });

    expect(vi.mocked(api.assignRenewalBulk).mock.calls).toEqual([[['rec-1', 'rec-2'], 'p-1']]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.assignRenewal).not.toHaveBeenCalled();
  });

  it('reports the counts the function returned rather than the number clicked', async () => {
    vi.mocked(api.assignRenewalBulk).mockResolvedValue(
      bulkResult({ requested: 2, assigned: 1, closed_skipped: 1 }),
    );
    render(<RenewalManagerActions role="manager" records={records} assignees={ASSIGNEES} />);
    openBulkAssign();

    fireEvent.click(screen.getByRole('checkbox', { name: /Ada Byron/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Alan Turing/ }));
    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: 'p-1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Assign 2 renewals/ }));
    });

    const status = screen.getByRole('status').textContent ?? '';
    expect(status).toContain('1 renewal assigned to Maria Gomez');
    expect(status).toContain('1 renewal left alone because the outcome is already recorded');
  });

  it('offers no renewal whose outcome is already recorded', () => {
    render(<RenewalManagerActions role="manager" records={records} assignees={ASSIGNEES} />);
    openBulkAssign();
    // `renewal_assign_bulk` refuses a closed row, so offering one would invite a no-op click.
    expect(screen.queryByRole('checkbox', { name: /Closed Carol/ })).toBeNull();
  });

  it('defaults to unassigned only, which is the bucket the collector import leaves behind', () => {
    render(<RenewalManagerActions role="manager" records={records} assignees={ASSIGNEES} />);
    openBulkAssign();

    expect((screen.getByLabelText('Unassigned only') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: /Ada Byron/ })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Grace Hopper/ })).toBeNull();
  });

  it('reveals the already-owned renewals when the filter is cleared', () => {
    render(<RenewalManagerActions role="manager" records={records} assignees={ASSIGNEES} />);
    openBulkAssign();

    fireEvent.click(screen.getByLabelText('Unassigned only'));
    expect(screen.getByRole('checkbox', { name: /Grace Hopper/ })).toBeTruthy();
    expect(screen.getByText(/Owned by Jose Lopez/)).toBeTruthy();
  });

  it('selects and clears exactly the rows currently visible', () => {
    render(<RenewalManagerActions role="manager" records={records} assignees={ASSIGNEES} />);
    openBulkAssign();

    fireEvent.click(screen.getByRole('button', { name: /Select these 2/ }));
    expect(screen.getByRole('button', { name: /Assign 2 renewals/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Clear these 2/ }));
    expect(screen.getByRole('button', { name: /Assign 0 renewals/ })).toBeTruthy();
  });

  it('narrows the list by the filter, and select-all then follows the filter', () => {
    render(<RenewalManagerActions role="manager" records={records} assignees={ASSIGNEES} />);
    openBulkAssign();

    fireEvent.change(screen.getByLabelText('Filter renewals'), { target: { value: 'Turing' } });
    expect(screen.queryByRole('checkbox', { name: /Ada Byron/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Select these 1/ }));
    expect(screen.getByRole('button', { name: /Assign 1 renewal/ })).toBeTruthy();
  });

  it('cannot be submitted without a selection or without an employee', () => {
    render(<RenewalManagerActions role="manager" records={records} assignees={ASSIGNEES} />);
    openBulkAssign();

    expect((screen.getByRole('button', { name: /Assign 0 renewals/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: /Ada Byron/ }));
    // Selected, but no employee chosen yet.
    expect((screen.getByRole('button', { name: /Assign 1 renewal/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: 'p-1' } });
    expect((screen.getByRole('button', { name: /Assign 1 renewal/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens on the single-renewal mode, so the existing action is unchanged', () => {
    render(<RenewalManagerActions role="manager" records={records} assignees={ASSIGNEES} />);
    openAction('Reassign renewal');

    expect((screen.getByLabelText('One renewal') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: /Save assignment/ })).toBeTruthy();
    expect(screen.queryByLabelText('Unassigned only')).toBeNull();
  });

  it('renders nothing at all outside Manager_Role', () => {
    const { container } = render(
      <RenewalManagerActions role="agent" records={records} assignees={ASSIGNEES} />,
    );
    expect(container.innerHTML).toBe('');
    expect(api.assignRenewalBulk).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The import wizard and the collector export
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A carrier file with no agent column, and repeated policies
// ---------------------------------------------------------------------------

/**
 * A carrier export: the identifying columns, no agent, and the same policy listed twice. Both
 * properties used to block the import outright.
 */
const CARRIER_CSV = [
  'Compania,Poliza,Asegurado,LOB,FechaRenovacion',
  'Progressive,POL-1,Ada Byron,Personal Auto,2026-08-16',
  'Progressive,POL-2,Alan Turing,Personal Auto,2026-08-20',
  'Progressive,POL-1,Ada Byron,Personal Auto,2026-08-16',
].join('\n');

describe('a carrier export with no agent column', () => {
  it('is importable, because the agent column is no longer required', async () => {
    render(<RenewalManagerActions role="manager" assignees={ASSIGNEES} />);
    await uploadCsv(CARRIER_CSV, 'carrier-renewals.csv');

    // The old behaviour blocked on "Map the required columns: Asignacion TXT".
    expect(screen.queryByText(/Import blocked/)).toBeNull();
    expect(screen.getByRole('button', { name: /Import and assign/ })).toBeTruthy();
  });

  it('does not refuse the file for a repeated Policy# and Renewal Date', async () => {
    render(<RenewalManagerActions role="manager" assignees={ASSIGNEES} />);
    await uploadCsv(CARRIER_CSV, 'carrier-renewals.csv');

    // `renewal_import_batch` resolves each row by (policy number, renewal date) and updates the row
    // it finds, so a repeat is one record, not two. Refusing the file was over-strict.
    expect(screen.queryByText(/Remove duplicate/)).toBeNull();
    expect(screen.getByText(/appears more than once/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Import and assign/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says the rows will import unassigned and where to own them', async () => {
    render(<RenewalManagerActions role="manager" assignees={ASSIGNEES} />);
    await uploadCsv(CARRIER_CSV, 'carrier-renewals.csv');

    expect(screen.getByText(/imports unassigned/)).toBeTruthy();
    expect(screen.getByText(/Several renewals/)).toBeTruthy();
  });

  it('sends no assignment label to the importer when the file names none', async () => {
    vi.mocked(api.importBatch).mockResolvedValue({
      id: 'run-1', rows_total: 3, rows_inserted: 2, rows_updated: 1, rows_skipped: 0,
      rows_assigned: 0, unmatched_assignees: [],
    });
    render(<RenewalManagerActions role="manager" assignees={ASSIGNEES} />);
    await uploadCsv(CARRIER_CSV, 'carrier-renewals.csv');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Import and assign/ }));
    });

    const [, mapping, rows] = vi.mocked(api.importBatch).mock.calls[0];
    expect(mapping.assigned_name).toBeUndefined();
    for (const row of rows) expect(row.assigned_name).toBe('');
  });

  it('still requires the columns a record cannot exist without', async () => {
    render(<RenewalManagerActions role="manager" assignees={ASSIGNEES} />);
    // No policy number and no renewal date: the importer identifies a record by those two.
    await uploadCsv('Compania,Asegurado,LOB\nProgressive,Ada Byron,Personal Auto', 'broken.csv');

    expect(screen.getByText(/Import blocked/)).toBeTruthy();
  });

  it('still maps the agent column when a file does carry one', async () => {
    render(<RenewalManagerActions role="manager" assignees={ASSIGNEES} />);
    await uploadCsv(POWERBI_CSV, 'renewals.csv');

    expect(screen.queryByText(/imports unassigned/)).toBeNull();
  });
});

describe('import wizard collector recognition', () => {
  it('asks for no mapping when the file is a collector export', async () => {
    render(<RenewalManagerActions role="manager" assignees={ASSIGNEES} />);
    await uploadCsv(COLLECTOR_CSV, 'consolidado_renovaciones.csv');

    expect(screen.getByRole('status').textContent)
      .toContain('consolidado_renovaciones.csv is a consolidated collector export');
    // Not one of the twenty-six dropdowns, and no import button for this file.
    expect(screen.queryByLabelText('Policy#')).toBeNull();
    expect(screen.queryByLabelText('Renewal Date')).toBeNull();
    expect(screen.queryByRole('button', { name: /Import and assign/ })).toBeNull();
    expect(api.importBatch).not.toHaveBeenCalled();
  });

  it('says where the file goes and how to clear what it leaves unassigned', async () => {
    render(<RenewalManagerActions role="manager" assignees={ASSIGNEES} />);
    await uploadCsv(COLLECTOR_CSV, 'consolidado_renovaciones.csv');

    const panel = screen.getByRole('status').textContent ?? '';
    expect(panel).toContain('Policy follow-up → Imports');
    expect(panel).toContain('Several renewals');
  });

  it('still shows the mapping step for the older Power BI export', async () => {
    render(<RenewalManagerActions role="manager" assignees={ASSIGNEES} />);
    await uploadCsv(POWERBI_CSV, 'renewals.csv');

    expect(screen.getByLabelText('Policy#')).toBeTruthy();
    expect(screen.getByLabelText('Renewal Date')).toBeTruthy();
    expect(screen.queryByText(/consolidated collector export/)).toBeNull();
  });

  it('clears the collector notice when a mappable file is chosen next', async () => {
    render(<RenewalManagerActions role="manager" assignees={ASSIGNEES} />);
    await uploadCsv(COLLECTOR_CSV, 'consolidado_renovaciones.csv');
    expect(screen.queryByText(/consolidated collector export/)).toBeTruthy();

    await chooseFile(POWERBI_CSV, 'renewals.csv');
    expect(screen.queryByText(/consolidated collector export/)).toBeNull();
    expect(screen.getByLabelText('Policy#')).toBeTruthy();
  });
});

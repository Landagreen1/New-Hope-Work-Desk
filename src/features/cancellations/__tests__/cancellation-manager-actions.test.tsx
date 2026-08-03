// @vitest-environment jsdom

// Render contract of the cancellation manager actions surface (task 16.11).
//
// Covers what this component decides rather than what `api.ts`, `manager-api.ts`, or the import
// pipeline decide:
//
//   * Requirements 22.3, 22.5, 26.4 — Agent_Role renders zero nodes, not a disabled control, and
//     `super_admin` sees everything `manager` sees;
//   * Requirement 8.5 — no write is attempted before the confirmation at the end of the preview;
//   * Requirement 14.17 — the save button names the version it will write, which is the highest
//     stored version plus one, and a blank required field is refused with every entered value left
//     on screen and nothing written;
//   * Requirement 26.4 — the kill switch renders the stored profile and the stored change time, and
//     a change stores what the returned row says rather than what the button asked for.
//
// The five writes are replaced; every constant and type still comes from the real modules, so a
// rename there breaks this file rather than silently passing.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    listCancellationAssignees: vi.fn(),
    listCancellationImportRuns: vi.fn(),
    listCancellationTemplates: vi.fn(),
    listTemplateVersions: vi.fn(),
    getCancellationSettings: vi.fn(),
    assignCancellationCase: vi.fn(),
    setAutomaticSendingEnabled: vi.fn(),
  };
});

vi.mock('../manager-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../manager-api')>();
  return {
    ...actual,
    saveTemplateVersion: vi.fn(),
    correctImportedCaseData: vi.fn(),
  };
});

vi.mock('../import/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../import/loader')>();
  return {
    ...actual,
    loadImportBatch: vi.fn(),
    fetchExistingCaseState: vi.fn(),
    fetchProducerAssignmentMapping: vi.fn(),
  };
});

import * as api from '../api';
import type {
  CancellationAssignee,
  CancellationCase,
  CancellationImportRun,
  CancellationSettings,
  CancellationTemplateVersion,
  CancellationTemplateWithVersions,
} from '../api';
import CancellationManagerActions, {
  CANCELLATION_MANAGER_ACTION_LABELS,
  formatInstant,
  importWizardStageIndex,
  type CancellationManagerActionsProps,
} from '../CancellationManagerActions';
import * as managerApi from '../manager-api';

const CASE_ID = 'case-1';
const RUN_ID = 'run-1';

function storedCase(overrides: Partial<CancellationCase> = {}): CancellationCase {
  return {
    id: CASE_ID,
    policy_number: 'ABC-001',
    policy_number_normalized: 'ABC-001',
    cancellation_effective_date: '2026-07-31',
    customer_name: 'Ana Diaz',
    client_identifier: '00412',
    customer_match_key: '00412',
    carrier: 'Progressive',
    cancellation_reason: null,
    amount_due: '182.40',
    case_status: 'Open',
    communication_status: 'Not Scheduled',
    next_required_action: null,
    assigned_to: null,
    assignment_source: null,
    producer_label: 'MARIA L',
    follow_up_deadline: null,
    assistance_requested: false,
    import_run_id: RUN_ID,
    source_row_number: 7,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function assignee(overrides: Partial<CancellationAssignee> = {}): CancellationAssignee {
  return {
    id: 'profile-agent',
    display_name: 'Luis Mora',
    initials: 'LM',
    role: 'agent',
    is_active: true,
    ...overrides,
  };
}

function settings(overrides: Partial<CancellationSettings> = {}): CancellationSettings {
  return {
    automatic_sending_enabled: true,
    office_phone: '+15550001111',
    agency_name: 'New Hope Insurance',
    bilingual_separator: '\n---\n',
    holidays: [],
    updated_by: 'profile-manager',
    updated_at: '2026-02-03T14:05:00.000Z',
    ...overrides,
  };
}

function templateVersion(
  overrides: Partial<CancellationTemplateVersion> = {},
): CancellationTemplateVersion {
  return {
    id: 'version-3-en',
    template_id: 'template-1',
    version: 3,
    language: 'English',
    subject: 'Your policy is scheduled for cancellation',
    body: 'Policy {{policy_number}} cancels on {{cancellation_effective_date}}.',
    cancellation_statement: 'This policy is scheduled for cancellation.',
    contact_request: 'Please contact our office.',
    fallback_text: { amount_due: 'the amount due' },
    created_by: 'profile-manager',
    created_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function template(
  overrides: Partial<CancellationTemplateWithVersions> = {},
): CancellationTemplateWithVersions {
  return {
    id: 'template-1',
    touchpoint: 5,
    name: 'Five days before cancellation',
    created_at: '2026-01-01T00:00:00.000Z',
    versions: [templateVersion()],
    ...overrides,
  };
}

function importRun(overrides: Partial<CancellationImportRun> = {}): CancellationImportRun {
  return {
    id: RUN_ID,
    file_name: 'eficacia-2026-07.csv',
    column_set: 'eficacia',
    imported_by: 'profile-manager',
    confirmed_mapping: {},
    rows_total: 12,
    rows_created: 8,
    rows_updated: 2,
    rows_rejected: 1,
    rows_duplicate: 1,
    rejected_rows: [{ row_number: 4, reason: 'policy number is empty' }],
    duplicate_rows: [{ row_number: 9, duplicate_of_row_number: 3 }],
    unmatched_producer_labels: [
      { label: 'MARIA L', row_number: 5 },
      { label: 'maria l', row_number: 6 },
    ],
    unmatched_customer_rows: [{ row_number: 7 }],
    invalid_contact_count: 0,
    contact_overflow_count: 0,
    amount_due_absent_rows: [],
    completed_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

function renderActions(overrides: Partial<CancellationManagerActionsProps> = {}) {
  const props: CancellationManagerActionsProps = {
    role: 'manager',
    cases: [storedCase()],
    assignees: [assignee()],
    importRuns: [importRun()],
    templates: [template()],
    settings: settings(),
    assignments: [],
    onChanged: vi.fn(),
    ...overrides,
  };
  const view = render(<CancellationManagerActions {...props} />);
  return { props, view };
}

/** Opens the collapsed control, then the named action panel. */
function openPanel(label: string) {
  fireEvent.click(screen.getByRole('button', { name: /Show manager actions/ }));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('CancellationManagerActions', () => {
  it('renders nothing at all for Agent_Role rather than a disabled control', () => {
    for (const role of ['agent', 'customer_service', 'sales_supervisor'] as const) {
      const { view } = renderActions({ role });
      // Zero nodes: no control, no wrapper, no disabled button.
      expect(view.container.innerHTML).toBe('');
      expect(screen.queryByRole('button')).toBeNull();
      for (const label of CANCELLATION_MANAGER_ACTION_LABELS) {
        expect(screen.queryByText(label)).toBeNull();
      }
      cleanup();
    }
  });

  it('shows every manager action to manager and to super_admin alike', () => {
    for (const role of ['manager', 'super_admin'] as const) {
      renderActions({ role });
      const toggle = screen.getByRole('button', { name: /Show manager actions/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(toggle);
      expect(screen.getByRole('button', { name: /Hide manager actions/ }).getAttribute('aria-expanded')).toBe(
        'true',
      );
      const group = screen.getByRole('group', { name: 'Manager actions' });
      for (const label of CANCELLATION_MANAGER_ACTION_LABELS) {
        expect(within(group).getByText(label)).toBeTruthy();
      }
      cleanup();
    }
  });

  it('starts the import wizard at the upload stage and writes nothing before confirmation', () => {
    const { props } = renderActions();
    openPanel('Import cancellation report');

    // The file input is labelled and states the Requirement 8.1 limits.
    expect(screen.getByLabelText('Cancellation report CSV file')).toBeTruthy();
    expect(screen.getByText(/25 MB/)).toBeTruthy();
    expect(screen.getByText(/20,000 data rows/)).toBeTruthy();

    // Stage 1 of 5 is current, and no later stage control exists yet.
    expect(screen.getByText(/1\. Choose file/).getAttribute('aria-current')).toBe('step');
    expect(screen.queryByRole('button', { name: /Continue to column mapping/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Confirm mapping and preview/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Confirm and import/ })).toBeNull();
    expect(props.onChanged).not.toHaveBeenCalled();

    expect(importWizardStageIndex('upload')).toBe(0);
    expect(importWizardStageIndex('complete')).toBe(4);
  });

  it('names the version a template save will write and refuses a blank required field', async () => {
    const { props } = renderActions();
    openPanel('Message templates');

    // Requirement 14.17: the highest stored version is 3, so a save writes 4.
    expect(screen.getByText(/Editing from version 3/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save as version 4' });

    const subject = screen.getByLabelText('Subject (required)') as HTMLTextAreaElement;
    fireEvent.change(subject, { target: { value: '   ' } });
    fireEvent.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('English subject');
    expect(alert.textContent).toContain('at least one character that is not a space');
    // Nothing was written and the entered value is still on screen.
    expect(managerApi.saveTemplateVersion).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Subject (required)') as HTMLTextAreaElement).value).toBe('   ');
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('saves a template change as a new version and reports the version written', async () => {
    const { props } = renderActions();
    vi.mocked(managerApi.saveTemplateVersion).mockResolvedValue({
      version: 4,
      previousVersion: 3,
      rows: [templateVersion({ id: 'version-4-en', version: 4 })],
    });
    vi.mocked(api.listTemplateVersions).mockResolvedValue([
      templateVersion({ id: 'version-4-en', version: 4 }),
    ]);

    openPanel('Message templates');
    fireEvent.change(screen.getByLabelText('Subject (required)'), { target: { value: 'New subject' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as version 4' }));

    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(managerApi.saveTemplateVersion).toHaveBeenCalledWith({
      templateId: 'template-1',
      segments: [
        expect.objectContaining({
          language: 'English',
          subject: 'New subject',
          fallbackText: { amount_due: 'the amount due' },
        }),
      ],
    });
    expect(vi.mocked(props.onChanged!).mock.calls[0][0]).toEqual({
      kind: 'template_version_saved',
      caseIds: [],
      importRunId: null,
      templateVersion: 4,
      automaticSendingEnabled: null,
      escalationReevaluationDue: false,
    });
  });

  it('renders the stored kill-switch profile and change time, and stores what the row returns', async () => {
    const { props } = renderActions({
      resolveProfileName: (id) => (id === 'profile-manager' ? 'Byron R' : null),
    });
    openPanel('Automatic sending');

    // Requirement 26.4: the stored profile and the stored change time are both on screen, and the
    // state is stated in words rather than by colour alone.
    expect(screen.getByText('Enabled')).toBeTruthy();
    expect(screen.getByText(/Last changed by Byron R at 2026-02-03 14:05 UTC/)).toBeTruthy();

    vi.mocked(api.setAutomaticSendingEnabled).mockResolvedValue(
      settings({
        automatic_sending_enabled: false,
        updated_by: 'profile-agent',
        updated_at: '2026-02-04T09:30:00.000Z',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Disable automatic sending/ }));

    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(api.setAutomaticSendingEnabled).toHaveBeenCalledWith(false);
    // The notice reads back the returned row, not the value the button asked for. It appears twice:
    // once in the always-mounted live region and once as the visible success message.
    const notices = await screen.findAllByText(/Automatic touchpoint sending is disabled/);
    expect(notices.length).toBe(2);
    for (const notice of notices) {
      expect(notice.textContent).toContain('Luis Mora');
      expect(notice.textContent).toContain('2026-02-04 09:30 UTC');
      expect(notice.textContent).toContain('Send Reminder Now and Retry Failed Communication keep working');
    }
    expect(vi.mocked(props.onChanged!).mock.calls[0][0]).toEqual(
      expect.objectContaining({ kind: 'automatic_sending_changed', automaticSendingEnabled: false }),
    );
  });

  it('reviews the most recent recorded run with its counts, rejected, duplicate, and unmatched lists', () => {
    renderActions();
    openPanel('Review unmatched rows');

    expect(screen.getByText(/eficacia-2026-07\.csv/)).toBeTruthy();
    expect(screen.getByText('Rejected rows: 1')).toBeTruthy();
    expect(screen.getByText(/Row 4: policy number is empty/)).toBeTruthy();
    expect(screen.getByText('Duplicate rows: 1')).toBeTruthy();
    expect(screen.getByText(/Row 9 repeats row 3/)).toBeTruthy();
    // Two rows carried the same label under different casing: one line, two rows.
    expect(screen.getByText('Unmatched producer labels: 1')).toBeTruthy();
    expect(screen.getByText(/MARIA L — 2 rows, first at row 5/)).toBeTruthy();
    expect(screen.getByText('Unmatched customers: 1')).toBeTruthy();
    // The unmatched customer row is resolved back to the loaded case by run id and row number.
    expect(screen.getByText(/Row 7 — ABC-001, Ana Diaz/)).toBeTruthy();
  });

  it('refuses a correction with no target and forwards every typed value unchanged when one is chosen', async () => {
    const { props } = renderActions();
    openPanel('Correct imported data');

    // No target: the save control is unavailable rather than writing against nothing.
    expect((screen.getByRole('button', { name: 'Save corrections' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.change(screen.getByLabelText('Cancellation to correct'), { target: { value: CASE_ID } });
    expect((screen.getByLabelText('Policy number (required)') as HTMLInputElement).value).toBe('ABC-001');
    expect((screen.getByLabelText('Amount due') as HTMLInputElement).value).toBe('182.40');

    vi.mocked(managerApi.correctImportedCaseData).mockResolvedValue({
      values: {
        policy_number: 'ABC-002',
        cancellation_effective_date: '2026-07-31',
        customer_name: 'Ana Diaz',
        client_identifier: '00412',
        customer_match_key: '00412',
        carrier: 'Progressive',
        cancellation_reason: null,
        amount_due: '182.40',
        producer_label: 'MARIA L',
      },
      changedColumns: ['policy_number'],
    });

    fireEvent.change(screen.getByLabelText('Policy number (required)'), { target: { value: 'ABC-002' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save corrections' }));

    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(managerApi.correctImportedCaseData).toHaveBeenCalledWith(
      CASE_ID,
      expect.objectContaining({ policyNumber: 'ABC-002', amountDue: '182.40' }),
    );
    expect(vi.mocked(props.onChanged!).mock.calls[0][0]).toEqual(
      expect.objectContaining({ kind: 'imported_data_corrected', caseIds: [CASE_ID] }),
    );
  });

  it('keeps a rejected reassignment on screen with nothing written', async () => {
    const { props } = renderActions();
    vi.mocked(api.assignCancellationCase).mockRejectedValue(
      new Error('Reassigning a cancellation requires a manager or super admin. Nothing was changed.'),
    );
    openPanel('Reassign cancellation');

    // No cancellation chosen: refused before any round trip.
    fireEvent.click(screen.getByRole('button', { name: 'Save assignment' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Choose the cancellation to reassign');
    expect(api.assignCancellationCase).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('formats a stored instant without depending on the reader time zone', () => {
    expect(formatInstant('2026-02-03T14:05:00.000Z')).toBe('2026-02-03 14:05 UTC');
    expect(formatInstant(null)).toBe('an unrecorded time');
    expect(formatInstant('not a time')).toBe('not a time');
  });
});

// @vitest-environment jsdom

// Drawer and composer write actions (task 3.3).
//
// Covers contact logging storing the channel, notes, contact time, recording profile, and
// evidence references (Req 5.5), the notes rejections of Requirement 5.4, the channel
// rejections of Requirement 5.9 and 2.3, the next follow-up range of Requirement 5.10,
// requote creation through `sendToRequote`, each final outcome of Requirement 5.11 and 2.2,
// and an `api.ts` error path leaving the record unchanged (Req 2.7). Requirement 25.1 names
// each of these as required coverage.
//
// The task names `renewal-actions.test.ts`; this file is `.tsx` because rendering the drawer
// and the composer requires JSX.
//
// Two layers, because two different guarantees are being checked:
//
//   1. `../api` is mocked, so every write the components attempt is observable by its exact
//      arguments and no Supabase client, storage bucket, or network call is reached. This is
//      the layer that proves a rejection writes nothing and keeps the draft.
//   2. The real `../api` is loaded with `vi.importActual` over a fake Supabase client, so the
//      stored `renewal_contacts` row and the `renewal_update_workflow` parameter list are
//      asserted directly. The recording profile and the outcome time are attached at that
//      layer — the composer never sends a profile id — so nothing below infers them.
//
// Evidence size and count limits, the 120-second upload bound, and the retry that follows an
// upload failure are covered by `renewal-evidence.test.tsx` (task 3.4) and are not repeated.

import type { SupabaseClient } from '@supabase/supabase-js';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addContact, listContacts, listRenewalEvents, listSmsLogs, sendToRequote, updateWorkflow,
} from '../api';
import type { RenewalContact, RenewalRecord } from '../api';
import RenewalContactComposer, { RENEWAL_CONTACT_CHANNELS, isPermittedChannel } from '../RenewalContactComposer';
import RenewalDrawer from '../RenewalDrawer';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

/** Captures of the fake Supabase client, shared with the layer-2 tests below. */
const supabase = vi.hoisted(() => ({
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  uploads: [] as { bucket: string; path: string; name: string }[],
  removals: [] as { bucket: string; paths: string[] }[],
  rpcCalls: [] as { name: string; params: Record<string, unknown> }[],
  /** Set by a test to make the `renewal_contacts` insert fail. */
  insertError: null as { message: string } | null,
  userId: 'profile-77',
}));

vi.mock('../../nhwd-shared/client', () => ({
  getSupabase: () =>
    ({
      auth: {
        getUser: async () => ({ data: { user: { id: supabase.userId } }, error: null }),
      },
      from: (table: string) => ({
        insert: async (row: Record<string, unknown>) => {
          supabase.inserts.push({ table, row });
          return { error: supabase.insertError };
        },
      }),
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string, file: File) => {
            supabase.uploads.push({ bucket, path, name: file.name });
            return { error: null };
          },
          remove: async (paths: string[]) => {
            supabase.removals.push({ bucket, paths });
            return { error: null };
          },
        }),
      },
      rpc: async (name: string, params: Record<string, unknown>) => {
        supabase.rpcCalls.push({ name, params });
        return { data: 'intake-from-rpc', error: null };
      },
    }) as unknown as SupabaseClient,
}));

vi.mock('../api', () => ({
  addContact: vi.fn(),
  downloadEvidenceFile: vi.fn(),
  getEvidenceUrl: vi.fn(),
  listContacts: vi.fn(),
  listRenewalEvents: vi.fn(),
  listSmsLogs: vi.fn(),
  sendRenewalSms: vi.fn(),
  sendToRequote: vi.fn(),
  updateRenewalContactInfo: vi.fn(),
  updateWorkflow: vi.fn(),
}));

const addContactMock = vi.mocked(addContact);
const listContactsMock = vi.mocked(listContacts);
const listRenewalEventsMock = vi.mocked(listRenewalEvents);
const listSmsLogsMock = vi.mocked(listSmsLogs);
const sendToRequoteMock = vi.mocked(sendToRequote);
const updateWorkflowMock = vi.mocked(updateWorkflow);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The business date every drawer case is evaluated against. */
const TODAY = '2026-02-10';
/** `TODAY` plus 365 calendar days: the last permitted next follow-up date (Req 5.10). */
const LATEST_FOLLOW_UP = '2027-02-10';

const STORED_FOLLOW_UP = '2026-03-15T18:30:00.000Z';
const NOTES_TEXT = 'Reached the insured and reviewed the renewal premium.';

function makeRecord(overrides: Partial<RenewalRecord> = {}): RenewalRecord {
  return {
    id: 'record-1',
    status: 'monitoring',
    hawksoft_client_id: 'HS-4001',
    policy_number: 'POL-1000',
    line_of_business: 'Personal Auto',
    carrier: 'Progressive',
    customer_name: 'Acme Holdings',
    customer_phone: '+15615550100',
    customer_email: 'owner@acme.test',
    renewal_date: '2026-03-20',
    premium_current: 1200,
    premium_renewal: 1320,
    notice_call_at: null,
    import_notes: null,
    eft_enabled: null,
    requote_requested: false,
    requote_note: null,
    assigned_import_label: null,
    powerbi_raw: null,
    assignment_source: 'manager',
    last_seen_import_run_id: null,
    last_seen_imported_at: null,
    source_sync_state: 'present',
    missing_since_import_run_id: null,
    assigned_to: 'profile-77',
    assigned_at: '2026-01-05T12:00:00.000Z',
    dealer_id: null,
    salesperson_id: null,
    next_follow_up_at: STORED_FOLLOW_UP,
    requote_work_item_id: null,
    requote_intake_id: null,
    requote_sent_at: null,
    outcome_reason: null,
    closed_at: null,
    created_at: '2026-01-02T12:00:00.000Z',
    updated_at: '2026-02-01T12:00:00.000Z',
    ...overrides,
  };
}

function makeContact(overrides: Partial<RenewalContact> = {}): RenewalContact {
  return {
    id: 'contact-1',
    record_id: 'record-1',
    contacted_by: 'profile-77',
    channel: 'call',
    direction: 'outbound',
    outcome: 'Customer reached',
    notes: NOTES_TEXT,
    occurred_at: '2026-02-09T16:00:00.000Z',
    entry_source: 'manual',
    rc_call_id: null,
    rc_session_id: null,
    rc_recording_content_uri: null,
    evidence_path: null,
    evidence_name: null,
    evidence_reference: null,
    evidence_mime_type: null,
    evidence_size_bytes: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Render and interaction helpers
// ---------------------------------------------------------------------------

function renderComposer(recordId = 'record-1') {
  const onContactAdded = vi.fn();
  render(<RenewalContactComposer recordId={recordId} onContactAdded={onContactAdded} />);
  return { onContactAdded };
}

/**
 * Mounts the drawer and flushes its three detail queries, so no assertion runs against a
 * half-loaded panel.
 */
async function renderDrawer(record: RenewalRecord, overrides: { canManage?: boolean } = {}) {
  const onClose = vi.fn();
  const onRecordChanged = vi.fn();
  await act(async () => {
    render(
      <RenewalDrawer
        record={record}
        businessDate={TODAY}
        assignees={[{
          id: 'profile-77', username: 'ghopper', display_name: 'Grace Hopper',
          initials: 'GH', role: 'agent', is_active: true,
        }]}
        onClose={onClose}
        onRecordChanged={onRecordChanged}
        canManage={overrides.canManage ?? false}
      />,
    );
  });
  return { onClose, onRecordChanged };
}

const channelSelect = () => screen.getByLabelText('Contact method') as HTMLSelectElement;
const notesField = () => screen.getByLabelText('Notes (required)') as HTMLTextAreaElement;
const referenceField = () => screen.getByLabelText('Or a contact reference record') as HTMLInputElement;
const followUpField = () => screen.getByLabelText('Next follow-up date and time') as HTMLInputElement;
const outcomeSelect = () => screen.getByLabelText('Outcome') as HTMLSelectElement;
const outcomeNote = () => screen.getByLabelText('Outcome note (required)') as HTMLTextAreaElement;

function attach(...files: File[]) {
  fireEvent.change(screen.getByLabelText('Attach evidence or a call recording'), { target: { files } });
}

async function click(name: RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

/** Text of every displayed rejection or failure message. */
function alerts(): string[] {
  return screen.queryAllByRole('alert').map((node) => (node.textContent ?? '').trim());
}

/** The single displayed rejection or failure message. */
function alertText(): string {
  const shown = alerts();
  expect(shown).toHaveLength(1);
  return shown[0];
}

/**
 * jsdom refuses to navigate, so `window.location` is replaced for the requote case. The probe
 * that this environment permits the replacement is the assertion on `assign` below.
 */
function captureNavigation(): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const original = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: (url: string) => { urls.push(url); } },
  });
  return {
    urls,
    restore: () => {
      if (original) Object.defineProperty(window, 'location', original);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  supabase.inserts.length = 0;
  supabase.uploads.length = 0;
  supabase.removals.length = 0;
  supabase.rpcCalls.length = 0;
  supabase.insertError = null;
  addContactMock.mockResolvedValue(undefined);
  updateWorkflowMock.mockResolvedValue(undefined);
  sendToRequoteMock.mockResolvedValue('intake-99');
  listContactsMock.mockResolvedValue([]);
  listRenewalEventsMock.mockResolvedValue([]);
  listSmsLogsMock.mockResolvedValue([]);
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Contact logging (Req 5.5, 5.4, 5.9, 2.3)
// ---------------------------------------------------------------------------

describe('renewal contact logging (Req 5.5)', () => {
  it('stores the selected channel, notes text, contact time, and evidence references', async () => {
    const { onContactAdded } = renderComposer();
    const file = new File(['proof'], 'call-recording.pdf', { type: 'application/pdf' });

    fireEvent.change(channelSelect(), { target: { value: 'whatsapp' } });
    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'inbound' } });
    fireEvent.change(screen.getByLabelText('Contact result — does not close the renewal'), {
      target: { value: 'Customer reached' },
    });
    fireEvent.change(notesField(), { target: { value: `  ${NOTES_TEXT}  ` } });
    fireEvent.change(referenceField(), { target: { value: '  RC-8891  ' } });
    attach(file);

    const before = Date.now();
    await click(/Save contact entry/);
    const after = Date.now();

    expect(addContactMock).toHaveBeenCalledTimes(1);
    const [entry] = addContactMock.mock.calls[0];
    expect(entry).toMatchObject({
      recordId: 'record-1',
      channel: 'whatsapp',
      direction: 'inbound',
      outcome: 'Customer reached',
      // Leading and trailing whitespace is removed; the notes body is stored unchanged.
      notes: NOTES_TEXT,
      evidenceFile: file,
      evidenceReference: 'RC-8891',
    });
    // The contact time is the moment of submission, recorded as an ISO 8601 instant.
    expect(entry.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(entry.occurredAt as string)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(entry.occurredAt as string)).toBeLessThanOrEqual(after);
    expect(onContactAdded).toHaveBeenCalledTimes(1);
    expect(alerts()).toEqual([]);
  });

  it('stores one entry with no evidence when the composer carries no attachment and no reference', async () => {
    renderComposer();

    fireEvent.change(channelSelect(), { target: { value: 'call' } });
    fireEvent.change(notesField(), { target: { value: NOTES_TEXT } });
    await click(/Save contact entry/);

    expect(addContactMock).toHaveBeenCalledTimes(1);
    expect(addContactMock.mock.calls[0][0]).toMatchObject({
      channel: 'call',
      direction: 'outbound',
      outcome: 'No answer',
      notes: NOTES_TEXT,
      evidenceFile: null,
      evidenceReference: null,
    });
  });

  it('displays the stored entry as the most recent timeline entry without closing the drawer', async () => {
    // Zero contacts, so the recommended action is Make first contact and the composer is open.
    const stored = makeContact({ notes: 'First contact completed with the insured.' });
    const { onClose, onRecordChanged } = await renderDrawer(makeRecord({ next_follow_up_at: null }));

    expect(screen.getByText('No customer contacts, evidence, or renewal activity has been recorded yet.'))
      .toBeTruthy();

    listContactsMock.mockResolvedValue([stored]);
    fireEvent.change(channelSelect(), { target: { value: 'call' } });
    fireEvent.change(notesField(), { target: { value: stored.notes as string } });
    await click(/Save contact entry/);

    const timeline = screen.getByRole('list', { name: /Renewal activity timeline/ });
    const entries = within(timeline).getAllByRole('listitem');
    expect(entries).toHaveLength(1);
    expect(entries[0].textContent).toContain('Customer contact');
    expect(entries[0].textContent).toContain('First contact completed with the insured.');
    // The drawer refreshed in place: the container was told, and nothing closed it.
    expect(onRecordChanged).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('renewal contact notes rejections (Req 5.4)', () => {
  it('rejects notes containing zero non-whitespace characters and retains the composer state', async () => {
    const { onContactAdded } = renderComposer();
    const file = new File(['proof'], 'proof.pdf', { type: 'application/pdf' });

    fireEvent.change(channelSelect(), { target: { value: 'sms' } });
    fireEvent.change(notesField(), { target: { value: '   \n\t  ' } });
    attach(file);
    await click(/Save contact entry/);

    expect(alertText()).toBe('Contact notes are required. Enter at least one character that is not a space.');
    // Nothing was written, so the timeline is unchanged and the parent is never asked to refresh.
    expect(addContactMock).not.toHaveBeenCalled();
    expect(onContactAdded).not.toHaveBeenCalled();
    expect(channelSelect().value).toBe('sms');
    expect(notesField().value).toBe('   \n\t  ');
    expect(screen.getByText(/evidence files attached/).textContent).toContain('1 of 10');
  });

  it('rejects notes over 5,000 characters and retains the composer state', async () => {
    const overLimit = 'a'.repeat(5_001);
    const { onContactAdded } = renderComposer();

    fireEvent.change(channelSelect(), { target: { value: 'email' } });
    fireEvent.change(notesField(), { target: { value: overLimit } });
    await click(/Save contact entry/);

    const message = alertText();
    expect(message).toContain('Contact notes are limited to 5,000 characters.');
    expect(message).toContain('Remove 1 characters.');
    expect(addContactMock).not.toHaveBeenCalled();
    expect(onContactAdded).not.toHaveBeenCalled();
    expect(channelSelect().value).toBe('email');
    expect(notesField().value).toBe(overLimit);
  });

  it('accepts notes of exactly 5,000 characters, so only a longer body is rejected', async () => {
    const atLimit = 'a'.repeat(5_000);
    renderComposer();

    fireEvent.change(channelSelect(), { target: { value: 'email' } });
    fireEvent.change(notesField(), { target: { value: atLimit } });
    await click(/Save contact entry/);

    expect(alerts()).toEqual([]);
    expect(addContactMock).toHaveBeenCalledTimes(1);
    expect(addContactMock.mock.calls[0][0].notes).toBe(atLimit);
  });
});

describe('renewal contact channel rejections (Req 5.9, 2.3)', () => {
  it('offers exactly the six permitted channels', () => {
    renderComposer();

    const values = Array.from(channelSelect().options).map((option) => option.value);
    expect(values).toEqual(['', 'call', 'sms', 'whatsapp', 'email', 'in_person', 'other']);
    expect(RENEWAL_CONTACT_CHANNELS.map((channel) => channel.value))
      .toEqual(['call', 'sms', 'whatsapp', 'email', 'in_person', 'other']);
  });

  it('rejects an absent channel and retains the entered notes and attached evidence', async () => {
    const { onContactAdded } = renderComposer();

    fireEvent.change(notesField(), { target: { value: NOTES_TEXT } });
    attach(new File(['proof'], 'proof.pdf', { type: 'application/pdf' }));
    await click(/Save contact entry/);

    expect(alertText()).toBe(
      'Select a contact method. The permitted methods are Call, SMS, WhatsApp, Email, In Person, and Other.',
    );
    expect(addContactMock).not.toHaveBeenCalled();
    expect(onContactAdded).not.toHaveBeenCalled();
    expect(notesField().value).toBe(NOTES_TEXT);
    expect(screen.getByText(/evidence files attached/).textContent).toContain('1 of 10');
  });

  it('rejects a channel value outside the permitted set', async () => {
    const { onContactAdded } = renderComposer();

    fireEvent.change(notesField(), { target: { value: NOTES_TEXT } });
    // A submitted value outside the set never becomes the entry's channel.
    fireEvent.change(channelSelect(), { target: { value: 'carrier_pigeon' } });
    expect(channelSelect().value).toBe('');
    await click(/Save contact entry/);

    expect(alertText()).toContain('The permitted methods are Call, SMS, WhatsApp, Email, In Person, and Other.');
    expect(addContactMock).not.toHaveBeenCalled();
    expect(onContactAdded).not.toHaveBeenCalled();
    expect(notesField().value).toBe(NOTES_TEXT);
  });

  it('narrows only the six permitted channel values', () => {
    for (const channel of RENEWAL_CONTACT_CHANNELS) {
      expect(isPermittedChannel(channel.value)).toBe(true);
    }
    for (const rejected of ['', ' call', 'CALL', 'in person', 'fax', 'carrier_pigeon', null, undefined]) {
      expect(isPermittedChannel(rejected)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Next follow-up date (Req 5.10)
// ---------------------------------------------------------------------------

describe('renewal next follow-up date range (Req 5.10)', () => {
  /** Status `requote_sent` recommends Record customer decision, so the composer stays collapsed. */
  const record = () => makeRecord({ status: 'requote_sent' });

  it('rejects a date earlier than the business date and retains the stored date', async () => {
    const { onRecordChanged } = await renderDrawer(record());

    fireEvent.change(followUpField(), { target: { value: '2026-02-09T09:00' } });
    await click(/Schedule follow-up/);

    const message = alertText();
    expect(message).toContain(`Choose a date from ${TODAY} through ${LATEST_FOLLOW_UP}.`);
    expect(message).toContain('The stored follow-up date is unchanged');
    // Nothing was written, so the stored next follow-up date is retained (Req 5.10).
    expect(updateWorkflowMock).not.toHaveBeenCalled();
    expect(onRecordChanged).not.toHaveBeenCalled();
  });

  it('rejects a date later than 365 days after the business date and retains the stored date', async () => {
    const { onRecordChanged } = await renderDrawer(record());

    fireEvent.change(followUpField(), { target: { value: '2027-02-11T09:00' } });
    await click(/Schedule follow-up/);

    expect(alertText()).toContain(`Choose a date from ${TODAY} through ${LATEST_FOLLOW_UP}.`);
    expect(updateWorkflowMock).not.toHaveBeenCalled();
    expect(onRecordChanged).not.toHaveBeenCalled();
  });

  it('rejects an empty date and retains the stored date', async () => {
    const { onRecordChanged } = await renderDrawer(record());

    fireEvent.change(followUpField(), { target: { value: '' } });
    await click(/Schedule follow-up/);

    expect(alertText()).toContain('Enter the next follow-up date and time.');
    expect(updateWorkflowMock).not.toHaveBeenCalled();
    expect(onRecordChanged).not.toHaveBeenCalled();
  });

  it('stores a date inside the permitted range, including both bounds, through updateWorkflow', async () => {
    const { onRecordChanged } = await renderDrawer(record());

    for (const entered of [`${TODAY}T00:00`, '2026-06-01T14:30', `${LATEST_FOLLOW_UP}T23:59`]) {
      fireEvent.change(followUpField(), { target: { value: entered } });
      await click(/Schedule follow-up/);
    }

    expect(updateWorkflowMock.mock.calls).toEqual([
      ['record-1', { status: 'monitoring', nextFollowUpAt: new Date(`${TODAY}T00:00`).toISOString() }],
      ['record-1', { status: 'monitoring', nextFollowUpAt: new Date('2026-06-01T14:30').toISOString() }],
      ['record-1', { status: 'monitoring', nextFollowUpAt: new Date(`${LATEST_FOLLOW_UP}T23:59`).toISOString() }],
    ]);
    expect(onRecordChanged).toHaveBeenCalledTimes(3);
    expect(alerts()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requote creation
// ---------------------------------------------------------------------------

describe('renewal requote creation (Req 5.2 Rule 4, 2.1)', () => {
  it('creates the requote intake through sendToRequote and opens it', async () => {
    const navigation = captureNavigation();
    try {
      // Requote requested with zero requote activity recommends Prepare requote.
      await renderDrawer(makeRecord({ status: 'assigned', requote_requested: true }));

      await click(/Prepare requote intake/);

      expect(sendToRequoteMock.mock.calls).toEqual([['record-1']]);
      expect(navigation.urls).toEqual(['/tools/cs-intake?edit=intake-99&from=renewal']);
      expect(alerts()).toEqual([]);
    } finally {
      navigation.restore();
    }
  });

  it('reuses an existing requote intake instead of creating a second one', async () => {
    const navigation = captureNavigation();
    try {
      await renderDrawer(makeRecord({ status: 'assigned', requote_requested: true, requote_intake_id: 'intake-42' }));

      await click(/requote intake/);

      expect(sendToRequoteMock).not.toHaveBeenCalled();
      expect(navigation.urls).toEqual(['/tools/cs-intake?edit=intake-42&from=renewal']);
    } finally {
      navigation.restore();
    }
  });

  it('reports a sendToRequote failure and leaves the record unchanged', async () => {
    const navigation = captureNavigation();
    try {
      sendToRequoteMock.mockRejectedValue(new Error('The intake could not be created.'));
      const { onRecordChanged } = await renderDrawer(makeRecord({ status: 'assigned', requote_requested: true }));

      await click(/Prepare requote intake/);

      const message = alertText();
      expect(message).toContain('Could not prepare the requote intake.');
      expect(message).toContain('The intake could not be created.');
      expect(navigation.urls).toEqual([]);
      expect(onRecordChanged).not.toHaveBeenCalled();
    } finally {
      navigation.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Final outcome (Req 5.11, 2.2)
// ---------------------------------------------------------------------------

describe('renewal final outcome (Req 5.11, 2.2)', () => {
  const record = () => makeRecord({ status: 'requote_sent' });

  it('offers exactly Renewed, Lost, and Cancelled', async () => {
    await renderDrawer(record());

    expect(Array.from(outcomeSelect().options).map((option) => option.value))
      .toEqual(['', 'renewed', 'lost', 'cancelled']);
    expect(Array.from(outcomeSelect().options).map((option) => option.textContent))
      .toEqual(['Select an outcome…', 'Renewed', 'Lost', 'Cancelled']);
  });

  it.each([
    ['renewed', 'Customer accepted the renewal premium.'],
    ['lost', 'Customer moved the policy to another agency.'],
    ['cancelled', 'Customer cancelled the policy outright.'],
  ])('stores the %s outcome with its note through updateWorkflow', async (outcome, note) => {
    const { onClose, onRecordChanged } = await renderDrawer(record());

    fireEvent.change(outcomeSelect(), { target: { value: outcome } });
    fireEvent.change(outcomeNote(), { target: { value: `  ${note}  ` } });
    await click(/Record outcome/);

    // `renewal_update_workflow` attaches the recording profile and the outcome time; the
    // parameter list it receives is asserted in the storage-contract tests below.
    expect(updateWorkflowMock.mock.calls).toEqual([['record-1', { status: outcome, outcomeReason: note }]]);
    expect(onRecordChanged).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(alerts()).toEqual([]);
  });

  it('rejects a submission with no outcome selected', async () => {
    const { onRecordChanged } = await renderDrawer(record());

    fireEvent.change(outcomeNote(), { target: { value: 'Customer accepted the renewal premium.' } });
    await click(/Record outcome/);

    expect(alertText()).toBe('Select exactly one outcome: Renewed, Lost, or Cancelled.');
    expect(updateWorkflowMock).not.toHaveBeenCalled();
    expect(onRecordChanged).not.toHaveBeenCalled();
    expect(outcomeNote().value).toBe('Customer accepted the renewal premium.');
  });

  it('rejects an outcome value outside Renewed, Lost, and Cancelled', async () => {
    const { onRecordChanged } = await renderDrawer(record());

    fireEvent.change(outcomeNote(), { target: { value: 'Policy expired without contact.' } });
    fireEvent.change(outcomeSelect(), { target: { value: 'expired' } });
    expect(outcomeSelect().value).toBe('');
    await click(/Record outcome/);

    expect(alertText()).toBe('Select exactly one outcome: Renewed, Lost, or Cancelled.');
    expect(updateWorkflowMock).not.toHaveBeenCalled();
    expect(onRecordChanged).not.toHaveBeenCalled();
  });

  it('rejects note text containing zero non-whitespace characters', async () => {
    const { onRecordChanged } = await renderDrawer(record());

    fireEvent.change(outcomeSelect(), { target: { value: 'lost' } });
    fireEvent.change(outcomeNote(), { target: { value: '   \t ' } });
    await click(/Record outcome/);

    expect(alertText()).toBe('Enter an outcome note containing at least one character that is not a space.');
    expect(updateWorkflowMock).not.toHaveBeenCalled();
    expect(onRecordChanged).not.toHaveBeenCalled();
    expect(outcomeSelect().value).toBe('lost');
  });
});

// ---------------------------------------------------------------------------
// api.ts failure path (Req 2.7)
// ---------------------------------------------------------------------------

describe('renewal api.ts error path (Req 2.7)', () => {
  it('names the attempted operation, retains the entered values, and leaves the record unchanged', async () => {
    updateWorkflowMock.mockRejectedValue(new Error('Only a manager may record this outcome.'));
    const { onClose, onRecordChanged } = await renderDrawer(makeRecord({ status: 'requote_sent' }));
    const detailReadsBefore = listContactsMock.mock.calls.length;

    fireEvent.change(outcomeSelect(), { target: { value: 'renewed' } });
    fireEvent.change(outcomeNote(), { target: { value: 'Customer accepted the renewal premium.' } });
    await click(/Record outcome/);

    const message = alertText();
    expect(message).toContain('Could not record the renewal outcome.');
    expect(message).toContain('Only a manager may record this outcome.');
    // The entered values stand, the record was never refreshed, and the drawer stays open.
    expect(outcomeSelect().value).toBe('renewed');
    expect(outcomeNote().value).toBe('Customer accepted the renewal premium.');
    expect(onRecordChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(listContactsMock.mock.calls.length).toBe(detailReadsBefore);
    expect(screen.getByText('No customer contacts, evidence, or renewal activity has been recorded yet.'))
      .toBeTruthy();
  });

  it('keeps the follow-up date entry when the follow-up write fails', async () => {
    updateWorkflowMock.mockRejectedValue(new Error('The renewal is locked.'));
    const { onRecordChanged } = await renderDrawer(makeRecord({ status: 'requote_sent' }));

    fireEvent.change(followUpField(), { target: { value: '2026-06-01T14:30' } });
    await click(/Schedule follow-up/);

    const message = alertText();
    expect(message).toContain('Could not schedule the next renewal follow-up.');
    expect(message).toContain('The renewal is locked.');
    expect(followUpField().value).toBe('2026-06-01T14:30');
    expect(onRecordChanged).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Storage contract: the real api.ts over a fake Supabase client
// ---------------------------------------------------------------------------

/** The real module, loaded past the `../api` mock so the stored row can be inspected. */
async function realApi() {
  return vi.importActual<typeof import('../api')>('../api');
}

describe('renewal storage contract (Req 5.5, 5.11, 2.1)', () => {
  it('stores the channel, notes, contact time, recording profile, and evidence references', async () => {
    const api = await realApi();
    const file = new File(['proof'], 'call-recording.pdf', { type: 'application/pdf' });

    await api.addContact({
      recordId: 'record-1',
      channel: 'whatsapp',
      direction: 'inbound',
      outcome: 'Customer reached',
      notes: NOTES_TEXT,
      occurredAt: '2026-02-10T15:04:05.000Z',
      evidenceFile: file,
      evidenceReference: 'RC-8891',
    });

    expect(supabase.inserts).toHaveLength(1);
    expect(supabase.inserts[0].table).toBe('renewal_contacts');
    expect(supabase.inserts[0].row).toMatchObject({
      record_id: 'record-1',
      // The recording profile is the signed-in user, attached here and never sent by the composer.
      contacted_by: 'profile-77',
      channel: 'whatsapp',
      direction: 'inbound',
      outcome: 'Customer reached',
      notes: NOTES_TEXT,
      occurred_at: '2026-02-10T15:04:05.000Z',
      entry_source: 'manual',
      evidence_name: 'call-recording.pdf',
      evidence_reference: 'RC-8891',
      evidence_mime_type: 'application/pdf',
      evidence_size_bytes: file.size,
    });
    expect(supabase.inserts[0].row.evidence_path).toMatch(/^record-1\/[\w-]+\.pdf$/);
    expect(supabase.uploads).toEqual([{
      bucket: 'renewal-contact-evidence',
      path: supabase.inserts[0].row.evidence_path,
      name: 'call-recording.pdf',
    }]);
    expect(supabase.removals).toEqual([]);
  });

  it('leaves no stored contact row and no orphan upload when the insert fails', async () => {
    const api = await realApi();
    supabase.insertError = { message: 'row level security denied the insert' };

    await expect(api.addContact({
      recordId: 'record-1',
      channel: 'call',
      direction: 'outbound',
      outcome: 'No answer',
      notes: NOTES_TEXT,
      evidenceFile: new File(['proof'], 'proof.pdf', { type: 'application/pdf' }),
    })).rejects.toThrow(/row level security denied the insert/);

    // The uploaded object is removed, so a failed entry leaves nothing behind (Req 2.7).
    expect(supabase.removals).toEqual([{
      bucket: 'renewal-contact-evidence',
      paths: [supabase.uploads[0].path],
    }]);
  });

  it.each(['renewed', 'lost', 'cancelled'] as const)(
    'sends the %s outcome and its note to renewal_update_workflow unchanged',
    async (status) => {
      const api = await realApi();

      await api.updateWorkflow('record-1', { status, outcomeReason: 'Customer decision recorded.' });

      // The recording profile and the outcome time are stored by this function (Req 5.11, 2.1),
      // which is called with its existing name and parameter list.
      expect(supabase.rpcCalls).toEqual([{
        name: 'renewal_update_workflow',
        params: {
          p_record_id: 'record-1',
          p_status: status,
          p_next_follow_up_at: null,
          p_outcome_reason: 'Customer decision recorded.',
        },
      }]);
    },
  );

  it('sends the next follow-up date to renewal_update_workflow unchanged', async () => {
    const api = await realApi();

    await api.updateWorkflow('record-1', { status: 'monitoring', nextFollowUpAt: '2026-06-01T18:30:00.000Z' });

    expect(supabase.rpcCalls).toEqual([{
      name: 'renewal_update_workflow',
      params: {
        p_record_id: 'record-1',
        p_status: 'monitoring',
        p_next_follow_up_at: '2026-06-01T18:30:00.000Z',
        p_outcome_reason: null,
      },
    }]);
  });

  it('creates the requote through renewal_send_to_requote', async () => {
    const api = await realApi();

    const intakeId = await api.sendToRequote('record-1');

    expect(supabase.rpcCalls).toEqual([{
      name: 'renewal_send_to_requote',
      params: { p_record_id: 'record-1' },
    }]);
    expect(intakeId).toBe('intake-from-rpc');
  });
});

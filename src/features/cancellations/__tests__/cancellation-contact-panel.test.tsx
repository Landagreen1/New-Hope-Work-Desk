// @vitest-environment jsdom

// Render contract of the cancellation contact panel (task 16.8).
//
// Covers what the panel itself decides, which is the part `api.ts` cannot: a preferred language
// outside the three values rejected with the three named and the STORED value back on screen with
// no write attempted (Requirement 11.1), the note text Requirement 21.5 requires for
// `Assistance requested`, the assistance flag path of Requirements 20.4 and 21.7 reported to the
// container, the pending-send count reaching the writes rather than a guessed zero, and the
// Requirement 21.9 clear control reserved to `manager` and `super_admin`.
//
// The five writes and the recompute are replaced; every constant and type still comes from the real
// `api.ts`, so a rename there breaks this file rather than silently passing.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    addCancellationContact: vi.fn(),
    updateContactPreferredLanguage: vi.fn(),
    updateContactAuthorization: vi.fn(),
    recordContactOptOut: vi.fn(),
    clearContactOptOut: vi.fn(),
    recordCustomerResponse: vi.fn(),
    recomputeCommunicationStatus: vi.fn(),
  };
});

import * as api from '../api';
import type { CancellationContact, CancellationCustomerResponse } from '../api';
import CancellationContactPanel, {
  PREFERRED_LANGUAGE_REJECTION,
  type CancellationContactChange,
  type CancellationContactPanelProps,
} from '../CancellationContactPanel';

const CASE_ID = 'case-1';

function contact(overrides: Partial<CancellationContact> = {}): CancellationContact {
  return {
    id: 'contact-1',
    case_id: CASE_ID,
    channel: 'phone',
    normalized_value: '+15551234567',
    raw_segment: '555-123-4567',
    validation_status: 'valid',
    authorization_status: 'Unknown',
    sms_suppressed: false,
    email_suppressed: false,
    is_primary: true,
    preferred_language: 'Spanish',
    preferred_channel: null,
    contact_name: null,
    contact_role: null,
    segment_index: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function storedResponse(
  overrides: Partial<CancellationCustomerResponse> = {},
): CancellationCustomerResponse {
  return {
    id: 'response-1',
    case_id: CASE_ID,
    response_type: 'No assistance needed',
    response_channel: null,
    response_time: '2026-01-02T00:00:00.000Z',
    note: null,
    created_by: 'profile-1',
    created_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function renderPanel(overrides: Partial<CancellationContactPanelProps> = {}) {
  const props: CancellationContactPanelProps = {
    caseId: CASE_ID,
    contacts: [contact()],
    role: 'agent',
    pendingSendsForCase: () => 2,
    onChanged: vi.fn(),
    ...overrides,
  };
  render(<CancellationContactPanel {...props} />);
  return props;
}

/** The change record the panel reported on its most recent successful write. */
function reportedChange(onChanged: unknown): CancellationContactChange {
  return vi.mocked(onChanged as (change: CancellationContactChange) => void).mock.calls.at(-1)![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.recomputeCommunicationStatus).mockResolvedValue('Not Scheduled');
});

afterEach(cleanup);

describe('CancellationContactPanel', () => {
  it('rejects a preferred language outside the three values, names them, and keeps the stored value', async () => {
    const props = renderPanel();
    const row = screen.getAllByRole('listitem')[0];
    const select = within(row).getByRole('combobox', { name: 'Preferred language' }) as HTMLSelectElement;
    expect(select.value).toBe('Spanish');

    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(within(row).getByRole('button', { name: /Save preferred language/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(PREFERRED_LANGUAGE_REJECTION);
    expect(alert.textContent).toContain('English');
    expect(alert.textContent).toContain('Spanish');
    expect(alert.textContent).toContain('Bilingual');
    // Nothing was written, and the control shows the stored value again.
    expect(api.updateContactPreferredLanguage).not.toHaveBeenCalled();
    expect((within(row).getByRole('combobox', { name: 'Preferred language' }) as HTMLSelectElement).value).toBe(
      'Spanish',
    );
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('stores a permitted preferred language and recomputes with the supplied count', async () => {
    const props = renderPanel({ contacts: [contact({ preferred_language: null })] });
    const row = screen.getAllByRole('listitem')[0];
    vi.mocked(api.updateContactPreferredLanguage).mockResolvedValue(
      contact({ preferred_language: 'Bilingual' }),
    );

    fireEvent.change(within(row).getByRole('combobox', { name: 'Preferred language' }), {
      target: { value: 'Bilingual' },
    });
    fireEvent.click(within(row).getByRole('button', { name: /Save preferred language/ }));

    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(api.updateContactPreferredLanguage).toHaveBeenCalledWith('contact-1', 'Bilingual');
    expect(api.recomputeCommunicationStatus).toHaveBeenCalledWith(CASE_ID, 2);
    expect(reportedChange(props.onChanged)).toEqual({
      kind: 'preferred_language_changed',
      affectedCaseIds: [CASE_ID],
      escalationReevaluationDue: true,
      recomputedCaseIds: [CASE_ID],
    });
  });

  it('requires non-blank note text for Assistance requested and stores nothing', async () => {
    const props = renderPanel();

    fireEvent.change(screen.getByRole('combobox', { name: 'Response type' }), {
      target: { value: 'Assistance requested' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Response note/ }), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record customer response' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Assistance requested');
    expect(alert.textContent).toContain('at least one character that is not a space');
    expect(api.recordCustomerResponse).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('records an assistance response with the pending-send count and reports the escalation as due', async () => {
    const props = renderPanel();
    vi.mocked(api.recordCustomerResponse).mockResolvedValue(
      storedResponse({ response_type: 'Callback requested' }),
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Response type' }), {
      target: { value: 'Callback requested' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record customer response' }));

    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(api.recordCustomerResponse).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: CASE_ID, responseType: 'Callback requested', pendingSends: 2 }),
    );
    expect(reportedChange(props.onChanged)).toEqual({
      kind: 'customer_response_recorded',
      affectedCaseIds: [CASE_ID],
      escalationReevaluationDue: true,
      recomputedCaseIds: [CASE_ID],
    });
  });

  it('leaves a case whose pending-send count is unknown out of the recompute', async () => {
    const props = renderPanel({ pendingSendsForCase: (id) => (id === 'case-2' ? 1 : undefined) });
    vi.mocked(api.recordContactOptOut).mockResolvedValue({
      channel: 'sms',
      normalizedValue: '+15551234567',
      affectedCaseIds: [CASE_ID, 'case-2'],
      alreadyInState: false,
    });

    const row = screen.getAllByRole('listitem')[0];
    fireEvent.click(within(row).getByRole('button', { name: 'Record SMS opt-out' }));

    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(api.recordContactOptOut).toHaveBeenCalledWith({
      channel: 'sms',
      normalizedValue: '+15551234567',
      reason: null,
    });
    // Only the case the container could answer for; `case-1` is left alone rather than set from a
    // guessed zero.
    expect(api.recomputeCommunicationStatus).toHaveBeenCalledTimes(1);
    expect(api.recomputeCommunicationStatus).toHaveBeenCalledWith('case-2', 1);
    expect(reportedChange(props.onChanged).recomputedCaseIds).toEqual(['case-2']);
  });

  it('reserves clearing an opt-out to manager and super_admin', () => {
    const suppressed = [contact({ sms_suppressed: true })];

    renderPanel({ contacts: suppressed, role: 'agent' });
    expect(screen.queryByRole('button', { name: /Clear the SMS opt-out/ })).toBeNull();
    expect(screen.getByText('Only a manager or super admin can clear an opt-out.')).toBeTruthy();
    cleanup();

    renderPanel({ contacts: suppressed, role: 'manager' });
    expect(screen.getByRole('button', { name: /Clear the SMS opt-out/ })).toBeTruthy();
    cleanup();

    renderPanel({ contacts: suppressed, role: 'super_admin' });
    expect(screen.getByRole('button', { name: /Clear the SMS opt-out/ })).toBeTruthy();
  });

  it('refuses to clear an opt-out with blank reason text and writes nothing', async () => {
    const props = renderPanel({ contacts: [contact({ sms_suppressed: true })], role: 'super_admin' });

    fireEvent.click(screen.getByRole('button', { name: /Clear the SMS opt-out/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('at least one character that is not a space');
    expect(api.clearContactOptOut).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('previews the stored contact value with the importer normalization', () => {
    renderPanel({ contacts: [] });

    fireEvent.change(screen.getByRole('textbox', { name: 'Phone number' }), {
      target: { value: '(555) 987-6543' },
    });
    expect(screen.getByText('Stored as +15559876543')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Phone number' }), { target: { value: '12345' } });
    expect(screen.getByText(/marked invalid/)).toBeTruthy();
  });
});

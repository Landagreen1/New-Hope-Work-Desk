// @vitest-environment jsdom

// Render contract of the cancellation payment report (task 16.9).
//
// Covers what the panel itself decides, which is the part `api.ts` deliberately does not: the
// Requirement 18.4 deadline — the end of the second business day counting Monday through Friday,
// excluding weekends and agency-configured holidays, clamped to the cancellation effective date —
// and every rejection of Requirements 18.7, 18.8, and 18.10 naming its field with nothing written
// and the entered values retained.
//
// `recordPaymentReport` is the only replaced function; every constant and type still comes from the
// real `api.ts`, so a rename there breaks this file rather than silently passing.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, recordPaymentReport: vi.fn() };
});

import * as api from '../api';
import { MAX_CONFIRMATION_REFERENCE_LENGTH, type CancellationPaymentReport as StoredReport } from '../api';
import CancellationPaymentReport, {
  isBusinessDay,
  normalizeHolidays,
  nthBusinessDayAfter,
  paymentReportFollowUpDeadline,
  readReportedAmount,
  type CancellationPaymentReportChange,
  type CancellationPaymentReportProps,
  type PaymentReportCase,
} from '../CancellationPaymentReport';

const CASE_ID = 'case-1';
/** A Friday, so the two-business-day walk crosses a weekend. */
const REPORT_DATE = '2026-07-17';
/** Far enough out that it never clamps unless a case asks for it. */
const EFFECTIVE_DATE = '2026-08-31';

function caseRow(overrides: Partial<PaymentReportCase> = {}): PaymentReportCase {
  return {
    case_status: 'Open',
    cancellation_effective_date: EFFECTIVE_DATE,
    amount_due: '412.55',
    ...overrides,
  };
}

function storedReport(overrides: Partial<StoredReport> = {}): StoredReport {
  return {
    id: 'report-1',
    case_id: CASE_ID,
    reported_by: 'profile-1',
    reported_at: '2026-07-17T15:00:00.000Z',
    reported_amount: '412.55',
    confirmation_reference: null,
    note: 'Customer paid by card.',
    evidence: [],
    ...overrides,
  };
}

function renderPanel(overrides: Partial<CancellationPaymentReportProps> = {}) {
  const props: CancellationPaymentReportProps = {
    caseId: CASE_ID,
    caseRow: caseRow(),
    settings: { holidays: [] },
    businessDate: REPORT_DATE,
    pendingSends: 3,
    onChanged: vi.fn(),
    ...overrides,
  };
  render(<CancellationPaymentReport {...props} />);
  return props;
}

function noteField(): HTMLElement {
  return screen.getByRole('textbox', { name: /What the customer reported/ });
}

function submitButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Record payment report' });
}

/** A file whose reported size is set without allocating it. */
function evidenceFile(name: string, size: number): File {
  const file = new File(['receipt'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function reportedChange(onChanged: unknown): CancellationPaymentReportChange {
  return vi.mocked(onChanged as (change: CancellationPaymentReportChange) => void).mock.calls.at(-1)![0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('paymentReportFollowUpDeadline (Requirement 18.4)', () => {
  const none = new Set<string>();

  it('counts Monday through Friday and excludes Saturday and Sunday', () => {
    expect(isBusinessDay('2026-07-17', none)).toBe(true); // Friday
    expect(isBusinessDay('2026-07-18', none)).toBe(false); // Saturday
    expect(isBusinessDay('2026-07-19', none)).toBe(false); // Sunday
    expect(isBusinessDay('2026-07-20', none)).toBe(true); // Monday

    // Wednesday + 2 business days is Friday; Friday + 2 skips the weekend to Tuesday.
    expect(nthBusinessDayAfter('2026-07-15', 2, none)).toBe('2026-07-17');
    expect(nthBusinessDayAfter('2026-07-17', 2, none)).toBe('2026-07-21');
  });

  it('excludes agency-configured holidays, reading both stored date formats', () => {
    const holidays = normalizeHolidays(['2026-07-20', '7/21/2026', 'not a date']);
    expect(holidays.has('2026-07-20')).toBe(true);
    expect(holidays.has('2026-07-21')).toBe(true);
    expect(holidays.size).toBe(2);

    // Friday: Monday and Tuesday are holidays, so the two business days are Wednesday and Thursday.
    expect(nthBusinessDayAfter('2026-07-17', 2, holidays)).toBe('2026-07-23');
  });

  it('sets the deadline to the end of the second business day', () => {
    const result = paymentReportFollowUpDeadline({
      reportDate: REPORT_DATE,
      cancellationEffectiveDate: EFFECTIVE_DATE,
    });
    expect(result).toEqual({
      deadline: '2026-07-21T23:59:59.999Z',
      deadlineDate: '2026-07-21',
      secondBusinessDay: '2026-07-21',
      clampedToEffectiveDate: false,
    });
  });

  it('clamps to the cancellation effective date where that date is earlier', () => {
    const result = paymentReportFollowUpDeadline({
      reportDate: REPORT_DATE,
      cancellationEffectiveDate: '2026-07-20',
    });
    expect(result).toEqual({
      deadline: '2026-07-20T00:00:00.000Z',
      deadlineDate: '2026-07-20',
      secondBusinessDay: '2026-07-21',
      clampedToEffectiveDate: true,
    });
  });

  it('does not clamp where the effective date equals the second business day, and not at all where it is unreadable', () => {
    expect(
      paymentReportFollowUpDeadline({ reportDate: REPORT_DATE, cancellationEffectiveDate: '2026-07-21' }),
    ).toMatchObject({ deadlineDate: '2026-07-21', clampedToEffectiveDate: false });
    expect(
      paymentReportFollowUpDeadline({ reportDate: REPORT_DATE, cancellationEffectiveDate: 'July 21, 2026' }),
    ).toMatchObject({ deadlineDate: '2026-07-21', clampedToEffectiveDate: false });
  });

  it('reads an amount in whole cents and refuses one that names no storable value in range', () => {
    expect(readReportedAmount('')).toEqual({ state: 'absent' });
    expect(readReportedAmount('   ')).toEqual({ state: 'absent' });
    expect(readReportedAmount('$1,234.5')).toEqual({
      state: 'accepted',
      amount: 1234.5,
      cents: 123450,
      display: '1,234.50',
    });
    // The two range endpoints, checked in cents so neither depends on binary floating point.
    expect(readReportedAmount('0.01')).toMatchObject({ amount: 0.01, cents: 1 });
    expect(readReportedAmount('999999999.99')).toMatchObject({ amount: 999999999.99, cents: 99999999999 });

    // Out of range, and values that name no storable amount at all.
    expect(readReportedAmount('0').state).toBe('rejected');
    expect(readReportedAmount('0.00').state).toBe('rejected');
    expect(readReportedAmount('1000000000').state).toBe('rejected');
    expect(readReportedAmount('-5').state).toBe('rejected');
    expect(readReportedAmount('abc').state).toBe('rejected');
    // A third decimal place cannot be held by `numeric(12,2)`, so it is refused rather than rounded.
    expect(readReportedAmount('1.005').state).toBe('rejected');
    expect(readReportedAmount('1,23,456').state).toBe('rejected');
  });
});

describe('CancellationPaymentReport', () => {
  it('records a payment report with the derived deadline and the supplied pending-send count', async () => {
    const props = renderPanel();
    vi.mocked(api.recordPaymentReport).mockResolvedValue(storedReport());

    fireEvent.change(noteField(), { target: { value: '  Customer paid by card.  ' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Amount the customer reported/ }), {
      target: { value: '412.55' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Confirmation reference/ }), {
      target: { value: 'CONF-9912' },
    });
    fireEvent.click(submitButton());

    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(api.recordPaymentReport).toHaveBeenCalledWith({
      caseId: CASE_ID,
      note: 'Customer paid by card.',
      reportedAmount: 412.55,
      confirmationReference: 'CONF-9912',
      followUpDeadline: '2026-07-21T23:59:59.999Z',
      files: [],
      pendingSends: 3,
    });

    const change = reportedChange(props.onChanged);
    expect(change.caseStatus).toBe('Payment Reported');
    expect(change.nextRequiredAction).toBe('Verify Payment');
    expect(change.followUpDeadline.deadlineDate).toBe('2026-07-21');
    expect(change.escalationReevaluationDue).toBe(true);
    expect(change.communicationStatusRecomputed).toBe(true);
    // The draft is cleared only on success.
    expect((noteField() as HTMLTextAreaElement).value).toBe('');
  });

  it('leaves the recompute to the container when no pending-send count is supplied', async () => {
    const props = renderPanel({ pendingSends: undefined });
    vi.mocked(api.recordPaymentReport).mockResolvedValue(storedReport());

    fireEvent.change(noteField(), { target: { value: 'Reported by phone.' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(api.recordPaymentReport).toHaveBeenCalledWith(
      expect.objectContaining({ pendingSends: undefined }),
    );
    expect(reportedChange(props.onChanged).communicationStatusRecomputed).toBe(false);
  });

  it('rejects empty note text naming the field, stores nothing, and keeps the entered values', async () => {
    const props = renderPanel();

    fireEvent.change(noteField(), { target: { value: '    ' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Amount the customer reported/ }), {
      target: { value: '75.00' },
    });
    fireEvent.click(submitButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('at least one character that is not a space');
    expect(noteField().getAttribute('aria-invalid')).toBe('true');
    expect(api.recordPaymentReport).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
    // Nothing typed is discarded by a rejection.
    expect((noteField() as HTMLTextAreaElement).value).toBe('    ');
    expect(
      (screen.getByRole('textbox', { name: /Amount the customer reported/ }) as HTMLInputElement).value,
    ).toBe('75.00');
  });

  it('rejects an amount outside 0.01 to 999,999,999.99 naming the field', async () => {
    const props = renderPanel();

    fireEvent.change(noteField(), { target: { value: 'Customer paid.' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Amount the customer reported/ }), {
      target: { value: '1000000000' },
    });
    fireEvent.click(submitButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Reported amount');
    expect(alert.textContent).toContain('0.01');
    expect(alert.textContent).toContain('999,999,999.99');
    expect(api.recordPaymentReport).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('rejects a confirmation reference longer than 100 characters naming the field', async () => {
    const props = renderPanel();

    fireEvent.change(noteField(), { target: { value: 'Customer paid.' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Confirmation reference/ }), {
      target: { value: 'C'.repeat(MAX_CONFIRMATION_REFERENCE_LENGTH + 1) },
    });
    fireEvent.click(submitButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Confirmation reference');
    expect(alert.textContent).toContain('101');
    expect(api.recordPaymentReport).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('refuses an oversized evidence file before any upload and names the limit', async () => {
    const props = renderPanel();

    fireEvent.change(screen.getByLabelText(/Attach payment evidence/), {
      target: { files: [evidenceFile('huge-receipt.pdf', 200 * 1024 * 1024)] },
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('huge-receipt.pdf');
    expect(alert.textContent).toContain('100 MB');
    expect(screen.getByText(/0 of 10 evidence files attached/)).toBeTruthy();
    expect(api.recordPaymentReport).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('stages a file within the limit and sends it with the report', async () => {
    const props = renderPanel();
    vi.mocked(api.recordPaymentReport).mockResolvedValue(storedReport());
    const file = evidenceFile('receipt.pdf', 2 * 1024 * 1024);

    fireEvent.change(screen.getByLabelText(/Attach payment evidence/), { target: { files: [file] } });
    expect(screen.getByText(/1 of 10 evidence files attached/)).toBeTruthy();

    fireEvent.change(noteField(), { target: { value: 'Receipt attached.' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(api.recordPaymentReport).toHaveBeenCalledWith(expect.objectContaining({ files: [file] }));
  });

  it('refuses a closed case naming the reason and writes nothing', () => {
    for (const status of ['Reinstated', 'Cancelled', 'Resolved', 'Invalid', 'Duplicate'] as const) {
      const props = renderPanel({ caseRow: caseRow({ case_status: status }) });
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain(`already ${status}`);
      expect(alert.textContent).toContain('closed case');
      expect((submitButton() as HTMLButtonElement).disabled).toBe(true);

      // An implicit form submission is refused here too, with nothing written.
      fireEvent.submit(submitButton().closest('form')!);
      expect(api.recordPaymentReport).not.toHaveBeenCalled();
      expect(props.onChanged).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('surfaces an upload failure from the write on the evidence field', async () => {
    const props = renderPanel();
    vi.mocked(api.recordPaymentReport).mockRejectedValue(
      new Error('"receipt.pdf" could not be uploaded: network error. Nothing was saved.'),
    );

    fireEvent.change(noteField(), { target: { value: 'Receipt attached.' } });
    fireEvent.click(submitButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('could not be uploaded');
    expect(props.onChanged).not.toHaveBeenCalled();
    // The note text survives the failure so the submission can be retried.
    expect((noteField() as HTMLTextAreaElement).value).toBe('Receipt attached.');
  });

  it('states the deadline the write will set before it is submitted', () => {
    renderPanel({ caseRow: caseRow({ cancellation_effective_date: '2026-07-20' }) });
    const notice = screen.getByText(/the follow-up deadline becomes/);
    expect(notice.textContent).toContain('2026-07-20');
    expect(notice.textContent).toContain('cancellation effective date');
  });
});

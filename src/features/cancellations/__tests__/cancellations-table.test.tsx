// @vitest-environment jsdom

// Render contract of the cancellations list surface (task 16.5).
//
// Covers the thirteen cells per row in the Requirement 16.1 order, the em dash and `Unassigned`
// markers passing through from `derive.ts` untouched, one page of at most 50 rows (16.5), row
// selection raising `onRowClick` for exactly one case (16.6), and the loading indicator standing
// in place of the list surface while the first page loads (1.5).

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { calendarText } from '../../renewals/format';
import CancellationsTable, { cancellationsTableRow } from '../CancellationsTable';
import type { CancellationsTableRow } from '../CancellationsTable';
import {
  CANCELLATION_PAGE_SIZE,
  EM_DASH,
  type CancellationRowCells,
  type CancellationRowState,
} from '../derive';

afterEach(cleanup);

/** The thirteen column labels in the Requirement 16.1 order. */
const EXPECTED_HEADERS = [
  'Customer name',
  'Policy number',
  'Carrier',
  'Cancellation effective date',
  'Days remaining',
  'Cancellation reason',
  'Amount due',
  'Assigned employee',
  'SMS status',
  'Email status',
  'Last contact',
  'Case status',
  'Next required action',
];

const LAST_CONTACT = '2026-02-27T15:04:00.000Z';

/** Cells whose every value is present, so an absent value is opt-in per test. */
function fullCells(overrides: Partial<CancellationRowCells> = {}): CancellationRowCells {
  return {
    customerName: 'Ada Byron',
    policyNumber: 'POL-9',
    carrier: 'Progressive',
    cancellationEffectiveDate: '2026-03-04',
    daysRemaining: '3',
    cancellationReason: 'Non-payment',
    amountDue: '$250.00',
    assignedEmployee: 'Grace Hopper',
    smsStatus: 'Scheduled',
    emailStatus: 'Delivered',
    lastContact: LAST_CONTACT,
    caseStatus: 'Open',
    nextRequiredAction: 'Send Reminder Now',
    ...overrides,
  };
}

function row(id: string, overrides: Partial<CancellationRowCells> = {}): CancellationsTableRow {
  return { id, cells: fullCells(overrides) };
}

/** Cell text of one body row. The selection glyph is stripped so cells compare cleanly. */
function bodyCells(index = 1): string[] {
  const bodyRow = screen.getAllByRole('row')[index];
  return Array.from(bodyRow.querySelectorAll('td')).map(
    (cell) => (cell.textContent ?? '').replace('\u2713', '').trim(),
  );
}

describe('CancellationsTable', () => {
  it('renders the thirteen column headers in the Requirement 16.1 order', () => {
    render(<CancellationsTable rows={[row('c-1')]} selectedCaseId={null} onRowClick={() => {}} />);
    const headers = screen.getAllByRole('columnheader').map((cell) => (cell.textContent ?? '').trim());
    expect(headers).toEqual(EXPECTED_HEADERS);
  });

  it('renders the thirteen cells of a row from props in that same order', () => {
    render(<CancellationsTable rows={[row('c-1')]} selectedCaseId={null} onRowClick={() => {}} />);
    expect(bodyCells()).toEqual([
      'Ada Byron',
      'POL-9',
      'Progressive',
      'Mar 4, 2026',
      '3',
      'Non-payment',
      '$250.00',
      'Grace Hopper',
      'Scheduled',
      'Delivered',
      calendarText(LAST_CONTACT, true),
      'Open',
      'Send Reminder Now',
    ]);
  });

  it('passes the em dash and Unassigned markers of derive.ts through unchanged', () => {
    render(
      <CancellationsTable
        rows={[
          row('c-1', {
            cancellationReason: EM_DASH,
            amountDue: EM_DASH,
            assignedEmployee: 'Unassigned',
            lastContact: EM_DASH,
            nextRequiredAction: EM_DASH,
          }),
        ]}
        selectedCaseId={null}
        onRowClick={() => {}}
      />,
    );
    const cells = bodyCells();
    expect(cells).toHaveLength(13);
    expect(cells[5]).toBe(EM_DASH);
    expect(cells[6]).toBe(EM_DASH);
    expect(cells[7]).toBe('Unassigned');
    expect(cells[10]).toBe(EM_DASH);
    expect(cells[12]).toBe(EM_DASH);
  });

  it('renders the cells derive.ts produces for a state bundle', () => {
    const state: CancellationRowState = {
      case: {
        id: 'c-7',
        customer_name: 'Ada Byron',
        policy_number: 'POL-9',
        carrier: 'Progressive',
        cancellation_effective_date: '2026-03-04',
        cancellation_reason: null,
        amount_due: '250.00',
        case_status: 'Open',
      },
      businessDate: '2026-03-01',
    };
    const tableRow = cancellationsTableRow(state);
    expect(tableRow.id).toBe('c-7');

    render(<CancellationsTable rows={[tableRow]} selectedCaseId={null} onRowClick={() => {}} />);
    const cells = bodyCells();
    expect(cells[4]).toBe('3');
    expect(cells[5]).toBe(EM_DASH);
    expect(cells[6]).toBe('$250.00');
    expect(cells[7]).toBe('Unassigned');
    expect(cells[11]).toBe('Open');
  });

  it('raises onRowClick with the case id and marks only the selected row', () => {
    const onRowClick = vi.fn();
    render(
      <CancellationsTable
        rows={[row('c-1'), row('c-2')]}
        selectedCaseId="c-2"
        onRowClick={onRowClick}
      />,
    );

    fireEvent.click(screen.getAllByRole('row')[1]);
    expect(onRowClick.mock.calls).toEqual([['c-1']]);

    onRowClick.mockClear();
    fireEvent.click(screen.getAllByRole('button')[1]);
    expect(onRowClick.mock.calls).toEqual([['c-2']]);

    const pressed = screen.getAllByRole('button').map((button) => button.getAttribute('aria-pressed'));
    expect(pressed).toEqual(['false', 'true']);
  });

  it('renders at most one page of 50 rows', () => {
    const rows = Array.from({ length: CANCELLATION_PAGE_SIZE + 7 }, (_, index) => row(`c-${index}`));
    render(<CancellationsTable rows={rows} selectedCaseId={null} onRowClick={() => {}} />);
    // One header row plus the body rows.
    expect(screen.getAllByRole('row')).toHaveLength(CANCELLATION_PAGE_SIZE + 1);
  });

  it('replaces the list surface with a loading indicator while the first page loads', () => {
    render(
      <CancellationsTable rows={[row('c-1')]} selectedCaseId={null} onRowClick={() => {}} loading />,
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Loading cancellations');
  });

  it('keeps the loaded rows on screen while a later page loads', () => {
    render(
      <CancellationsTable
        rows={[row('c-1')]}
        page={1}
        selectedCaseId={null}
        onRowClick={() => {}}
        loading
      />,
    );
    expect(screen.getByRole('table')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Loading more cancellations');
  });
});

// @vitest-environment jsdom

// Render contract of the renewals list surface (task 2.2).
//
// Covers the fourteen cells per row in the Requirement 4.1 order, `Unassigned` for an absent
// assigned employee (4.3), an em dash for an absent premium change (4.4) and for every other
// absent value (4.9), row selection raising `onSelect` (4.6), and the loading indicator standing
// in place of the list surface while the first page loads (1.5).

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import RenewalsTable from '../RenewalsTable';
import type { RenewalTableRow } from '../RenewalsTable';

afterEach(cleanup);

/** The fourteen column labels in the Requirement 4.1 order. */
const EXPECTED_HEADERS = [
  'Customer name',
  'Policy number',
  'Carrier',
  'Line of business',
  'Renewal date',
  'Days remaining',
  'Assigned employee',
  'Current premium',
  'Renewal premium',
  'Premium change',
  'Last contact',
  'Next follow-up',
  'Status',
  'Next required action',
];

/** A row whose every value is present, so absent-value behavior is opt-in per test. */
function fullRow(overrides: Partial<RenewalTableRow> = {}): RenewalTableRow {
  return {
    id: 'r-1',
    customerName: 'Ada Byron',
    policyNumber: 'POL-1',
    carrier: 'Progressive',
    lineOfBusiness: 'Personal Auto',
    renewalDate: '2026-03-04',
    daysRemaining: -3,
    assignedEmployee: 'Grace Hopper',
    currentPremium: 1000,
    renewalPremium: 974.5,
    premiumChange: { amount: -25.5, percent: -2.55 },
    lastContact: '2026-02-01',
    nextFollowUp: '2026-02-20',
    status: 'monitoring',
    nextRequiredAction: 'Complete follow-up',
    ...overrides,
  };
}

/** Cell text of the first body row. The selection glyph is stripped so cells compare cleanly. */
function bodyCells(): string[] {
  const row = screen.getAllByRole('row')[1];
  return Array.from(row.querySelectorAll('td')).map(
    (cell) => (cell.textContent ?? '').replace('\u2713', '').trim(),
  );
}

describe('RenewalsTable', () => {
  it('renders the fourteen column headers in the Requirement 4.1 order', () => {
    render(<RenewalsTable rows={[fullRow()]} selectedId={null} onSelect={() => {}} />);
    const headers = screen.getAllByRole('columnheader').map((cell) => (cell.textContent ?? '').trim());
    expect(headers).toEqual(EXPECTED_HEADERS);
  });

  it('renders the fourteen cells of a row from props in that same order', () => {
    render(<RenewalsTable rows={[fullRow()]} selectedId={null} onSelect={() => {}} />);
    expect(bodyCells()).toEqual([
      'Ada Byron',
      'POL-1',
      'Progressive',
      'Personal Auto',
      'Mar 4, 2026',
      '-3',
      'Grace Hopper',
      '$1,000.00',
      '$974.50',
      '-$25.50',
      'Feb 1, 2026',
      'Feb 20, 2026',
      'Monitoring',
      'Complete follow-up',
    ]);
  });

  it('reads Unassigned when the record names no assigned employee', () => {
    render(
      <RenewalsTable rows={[fullRow({ assignedEmployee: null })]} selectedId={null} onSelect={() => {}} />,
    );
    expect(bodyCells()[6]).toBe('Unassigned');
  });

  it('shows an em dash in the premium change cell when a premium is absent', () => {
    render(
      <RenewalsTable
        rows={[fullRow({ renewalPremium: null, premiumChange: null })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    const cells = bodyCells();
    expect(cells[8]).toBe('—');
    expect(cells[9]).toBe('—');
  });

  it('shows an em dash in every other absent cell and Unassigned in the assigned employee cell', () => {
    const absent: RenewalTableRow = {
      id: 'r-2',
      customerName: null,
      policyNumber: null,
      carrier: null,
      lineOfBusiness: null,
      renewalDate: null,
      daysRemaining: null,
      assignedEmployee: null,
      currentPremium: null,
      renewalPremium: null,
      premiumChange: null,
      lastContact: null,
      nextFollowUp: null,
      status: null,
      nextRequiredAction: null,
    };
    render(<RenewalsTable rows={[absent]} selectedId={null} onSelect={() => {}} />);
    const cells = bodyCells();
    expect(cells).toHaveLength(14);
    expect(cells[6]).toBe('Unassigned');
    expect(cells.filter((_, index) => index !== 6)).toEqual(Array(13).fill('—'));
  });

  it('raises onSelect once with the record id when the row is selected', () => {
    const onSelect = vi.fn();
    render(<RenewalsTable rows={[fullRow()]} selectedId={null} onSelect={onSelect} />);

    fireEvent.click(screen.getAllByRole('row')[1]);
    expect(onSelect.mock.calls).toEqual([['r-1']]);

    onSelect.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Ada Byron/ }));
    expect(onSelect.mock.calls).toEqual([['r-1']]);
  });

  it('renders the loading indicator in place of the list surface while the first page loads', () => {
    render(<RenewalsTable rows={[fullRow()]} selectedId={null} onSelect={() => {}} loading />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Loading renewals');
  });
});

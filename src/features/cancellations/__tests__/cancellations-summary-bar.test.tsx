// @vitest-environment jsdom

// Render contract of the cancellations summary filter bar (task 16.4).
//
// Covers the fourteen saved filters with their counts and exactly one selected, Needs Action
// selected until the user picks another (Requirement 16.2), the search field capped at 100
// characters (16.4), and the two empty-state variants: the narrowed one naming the filter and the
// search text and offering the control that clears both (1.6), and the un-narrowed one that omits
// that control (1.9).

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CancellationsSummaryBar from '../CancellationsSummaryBar';
import type { CancellationsSummaryBarProps } from '../CancellationsSummaryBar';
import { STANDARD_CANCELLATION_SAVED_FILTERS as CANCELLATION_SAVED_FILTERS, MAX_SEARCH_LENGTH } from '../derive';
import type { CancellationFilterCounts } from '../derive';

afterEach(cleanup);

/** Every filter carries a distinct count, so a mislabeled pill is visible in the assertion. */
function counts(): CancellationFilterCounts {
  const value = {} as CancellationFilterCounts;
  CANCELLATION_SAVED_FILTERS.forEach((filter, index) => {
    value[filter.id] = index;
  });
  return value;
}

function renderBar(overrides: Partial<CancellationsSummaryBarProps> = {}) {
  const props: CancellationsSummaryBarProps = {
    counts: counts(),
    activeFilter: null,
    onFilterChange: vi.fn(),
    searchText: '',
    onSearchTextChange: vi.fn(),
    rowCount: 12,
    onClearFilterAndSearch: vi.fn(),
    ...overrides,
  };
  render(<CancellationsSummaryBar {...props} />);
  return props;
}

describe('CancellationsSummaryBar', () => {
  it('renders the fourteen saved filters in order with their counts, exactly one selected', () => {
    renderBar();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(14);
    expect(radios.map((radio) => radio.getAttribute('aria-label'))).toEqual(
      CANCELLATION_SAVED_FILTERS.map((filter, index) => `${filter.label}, ${index}`),
    );
    expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(1);
  });

  it('selects Needs Action while the user has not picked a filter, and reports the pick', () => {
    const props = renderBar();

    expect(screen.getByRole('radio', { name: 'Needs Action, 0' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Needs Action, 0' }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: 'Next 7 Days, 3' }));
    expect(props.onFilterChange).toHaveBeenCalledWith('next-7-days');
  });

  it('caps the search field at 100 characters and reports what was entered', () => {
    const props = renderBar();

    const input = screen.getByRole('searchbox', { name: 'Search cancellations' }) as HTMLInputElement;
    expect(input.maxLength).toBe(MAX_SEARCH_LENGTH);

    fireEvent.change(input, { target: { value: 'Ada' } });
    expect(props.onSearchTextChange).toHaveBeenCalledWith('Ada');
  });

  it('names the filter and the search text and clears both when the list is narrowed', () => {
    const props = renderBar({ activeFilter: 'contact-missing', searchText: '  Ada Byron  ', rowCount: 0 });

    expect(screen.getByText(/No cancellation records match the Contact Missing filter and/)).toBeTruthy();
    expect(screen.getByText(/\u201CAda Byron\u201D/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear the filter and the search text' }));
    expect(props.onClearFilterAndSearch).toHaveBeenCalledTimes(1);
  });

  it('omits the clearing control while no filter narrows and no search text is present', () => {
    renderBar({ activeFilter: 'all', searchText: '   ', rowCount: 0 });

    expect(screen.getByText('This tab contains zero cancellation records.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear the filter and the search text' })).toBeNull();
  });

  it('shows no empty state while the first page is still loading', () => {
    renderBar({ rowCount: 0, loading: true });

    expect(screen.queryByText('This tab contains zero cancellation records.')).toBeNull();
    expect(screen.queryByText(/No cancellation records match/)).toBeNull();
  });
});

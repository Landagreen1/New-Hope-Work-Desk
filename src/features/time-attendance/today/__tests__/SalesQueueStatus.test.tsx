// @vitest-environment jsdom

// src/features/time-attendance/today/__tests__/SalesQueueStatus.test.tsx
// What the panel actually renders.
//
// Spec: .kiro/specs/attendance-queue-status-separation, task 9.4
// Requirements: 2.14, 2.15, 2.16, 2.17
//
// The rule is checked in `domain/__tests__/queue-status.test.ts`; this checks that
// the rule reaches the screen. Two things are worth asserting on the DOM rather
// than on the domain function. That no rendered string is the bare word
// `Available` — a label and a value rendered as two text nodes would satisfy the
// domain test and still put `Available` on the screen on its own. And that the
// sales-queue line is absent for a non-agent, for whom queue status governs
// nothing.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QUEUE_STATUS_MESSAGES } from '../../domain/queue-status';
import { SalesQueueStatus, type SalesQueueStatusProps } from '../SalesQueueStatus';

afterEach(cleanup);

function renderPanel(overrides: Partial<SalesQueueStatusProps> = {}) {
  const props: SalesQueueStatusProps = {
    attendanceStatus: 'working',
    queueStatus: 'available',
    queueStatusMode: 'attendance_assisted',
    isAgent: true,
    onAction: vi.fn(),
    ...overrides,
  };
  render(<SalesQueueStatus {...props} />);
  return props;
}

/** Every string the panel put on the screen, as its own element's text. */
function renderedTexts(): string[] {
  return [...document.querySelectorAll('[data-testid^="status-line-"]')].map(
    (node) => node.textContent ?? '',
  );
}

describe('SalesQueueStatus (2.14)', () => {
  it('renders both statuses, each under its own label', () => {
    renderPanel({ attendanceStatus: 'on_break', queueStatus: 'break' });

    expect(renderedTexts()).toEqual(['Attendance: On Break', 'Sales Queues: Break']);
  });

  it('never renders the bare word Available', () => {
    for (const queueStatus of ['available', 'break', 'unavailable'] as const) {
      for (const attendanceStatus of ['clocked_out', 'working', 'on_break'] as const) {
        cleanup();
        renderPanel({ queueStatus, attendanceStatus });
        for (const text of renderedTexts()) {
          expect(text).not.toBe('Available');
          expect(text.includes(': ')).toBe(true);
        }
      }
    }
  });

  it('omits the sales-queue line for a non-agent', () => {
    renderPanel({ isAgent: false, attendanceStatus: 'working', queueStatus: 'available' });

    expect(renderedTexts()).toEqual(['Attendance: Working']);
    expect(screen.queryByTestId('status-line-queue')).toBeNull();
    expect(screen.queryByTestId('queue-status-notice')).toBeNull();
  });
});

describe('SalesQueueStatus notices (2.15, 2.16, 2.17)', () => {
  it('offers Join Sales Queues to an employee at work who is not receiving sales work', () => {
    const props = renderPanel({ attendanceStatus: 'working', queueStatus: 'unavailable' });

    expect(screen.getByTestId('queue-status-notice').textContent).toContain(
      QUEUE_STATUS_MESSAGES.notReceivingSalesWork,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Join Sales Queues' }));
    expect(props.onAction).toHaveBeenCalledWith('join_sales_queues');
  });

  it('reports the removal from the queues after a clock-out in assisted mode, with no action', () => {
    renderPanel({
      attendanceStatus: 'clocked_out',
      queueStatus: 'unavailable',
      queueStatusMode: 'attendance_assisted',
    });

    expect(screen.getByTestId('queue-status-notice').textContent).toContain(
      QUEUE_STATUS_MESSAGES.clockedOutAndRemoved,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Set Unavailable to a manual-mode employee clocked out but still Available', () => {
    const props = renderPanel({
      attendanceStatus: 'clocked_out',
      queueStatus: 'available',
      queueStatusMode: 'manual',
    });

    expect(screen.getByTestId('queue-status-notice').textContent).toContain(
      QUEUE_STATUS_MESSAGES.clockedOutStillAvailable,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set Unavailable' }));
    expect(props.onAction).toHaveBeenCalledWith('set_unavailable');
  });

  it('says nothing to an agent at work and receiving sales work', () => {
    renderPanel({ attendanceStatus: 'working', queueStatus: 'available' });

    expect(screen.queryByTestId('queue-status-notice')).toBeNull();
  });

  it('disables the action while a change is in flight', () => {
    renderPanel({ attendanceStatus: 'working', queueStatus: 'unavailable', busy: true });

    const button = screen.getByRole('button');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain('Join Sales Queues');
  });

  it('displays a refused change beside the unchanged statuses', () => {
    renderPanel({
      attendanceStatus: 'working',
      queueStatus: 'unavailable',
      failure: 'Agent permission required',
    });

    expect(screen.getByTestId('queue-status-failure').textContent).toContain(
      'Agent permission required',
    );
    // 3.14, in spirit: the figures beside it do not move because of a failure.
    expect(renderedTexts()).toEqual(['Attendance: Working', 'Sales Queues: Unavailable']);
  });
});

// @vitest-environment jsdom

// Evidence limits and upload failure handling in the renewal contact composer (task 3.4).
//
// Covers Requirement 5.6 — a file over 100 MB rejected with the exceeded limit displayed, an
// eleventh attachment rejected, and every previously accepted attachment plus the entered
// channel and notes text retained — and Requirement 5.7 — an upload failure and the 120-second
// bound leaving the contact entry unsaved, naming the failure reason, keeping the draft, and
// offering a retry control, with the timeline unchanged (Requirement 25.1).
//
// The task names `renewal-evidence.test.ts`; the file is `.tsx` because rendering the composer
// requires JSX.
//
// `../api` is mocked so the composer's only write path is observable and no Supabase client,
// storage bucket, or network call is reached. The 120-second bound is driven with fake timers
// rather than waited out, and oversized files are constructed by overriding `File.size` so no
// test allocates 100 MB.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addContact } from '../api';
import RenewalContactComposer, {
  EVIDENCE_UPLOAD_TIMEOUT_MS,
  MAX_EVIDENCE_BYTES,
  MAX_EVIDENCE_FILES,
} from '../RenewalContactComposer';

vi.mock('../api', () => ({
  addContact: vi.fn(),
  getEvidenceUrl: vi.fn(),
  downloadEvidenceFile: vi.fn(),
}));

const addContactMock = vi.mocked(addContact);

const NOTES_TEXT = 'Reached the insured and reviewed the renewal premium.';

/** A file of an arbitrary reported size; the body stays empty so nothing large is allocated. */
function makeFile(name: string, size: number): File {
  const file = new File([], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: size, configurable: true });
  return file;
}

function renderComposer() {
  const onContactAdded = vi.fn();
  render(<RenewalContactComposer recordId="record-1" onContactAdded={onContactAdded} />);
  return { onContactAdded };
}

function channelSelect(): HTMLSelectElement {
  return screen.getByLabelText('Contact method') as HTMLSelectElement;
}

function notesField(): HTMLTextAreaElement {
  return screen.getByLabelText('Notes (required)') as HTMLTextAreaElement;
}

/** Enters a channel and notes text that both pass validation, so only evidence can fail. */
function fillDraft() {
  fireEvent.change(channelSelect(), { target: { value: 'call' } });
  fireEvent.change(notesField(), { target: { value: NOTES_TEXT } });
}

/** One file-selection event carrying `files`, matching the composer's `multiple` input. */
function attach(...files: File[]) {
  fireEvent.change(screen.getByLabelText('Attach evidence or a call recording'), { target: { files } });
}

/** Text of every staged attachment row. With no `evidenceContacts` this is the only list. */
function stagedRows(): string[] {
  return screen.queryAllByRole('listitem').map((row) => (row.textContent ?? '').trim());
}

function attachedCountText(): string {
  return (screen.getByText(/evidence files attached/).textContent ?? '').trim();
}

/** The single displayed rejection or failure message. */
function alertText(): string {
  const alerts = screen.queryAllByRole('alert').map((node) => (node.textContent ?? '').trim());
  expect(alerts).toHaveLength(1);
  return alerts[0];
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /Save contact entry/ }));
}

function retryButton(): HTMLButtonElement | null {
  return screen.queryByRole('button', { name: /^Retry/ }) as HTMLButtonElement | null;
}

beforeEach(() => {
  addContactMock.mockReset();
  addContactMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('renewal evidence attachment limits (Req 5.6)', () => {
  it('rejects a file over 100 MB, displays the limit, and attaches nothing', () => {
    renderComposer();

    attach(makeFile('recording.pdf', 150 * 1024 * 1024));

    const message = alertText();
    expect(message).toContain('recording.pdf');
    expect(message).toContain('150.0 MB');
    expect(message).toContain('The limit is 100 MB per file');
    expect(stagedRows()).toEqual([]);
    expect(attachedCountText()).toBe('0 of 10 evidence files attached');
  });

  it('accepts a file at exactly 100 MB, so only a size above the limit is rejected', () => {
    renderComposer();

    attach(makeFile('exactly-at-limit.pdf', MAX_EVIDENCE_BYTES));

    expect(screen.queryAllByRole('alert')).toEqual([]);
    expect(stagedRows()).toHaveLength(1);
    expect(stagedRows()[0]).toContain('exactly-at-limit.pdf');
  });

  it('retains the previously accepted attachment, channel, and notes when a later file is oversized', () => {
    renderComposer();
    fillDraft();

    attach(makeFile('accepted.pdf', 2 * 1024 * 1024));
    attach(makeFile('too-big.pdf', MAX_EVIDENCE_BYTES + 1));

    expect(alertText()).toContain('The limit is 100 MB per file');
    expect(stagedRows()).toHaveLength(1);
    expect(stagedRows()[0]).toContain('accepted.pdf');
    expect(channelSelect().value).toBe('call');
    expect(notesField().value).toBe(NOTES_TEXT);
    expect(addContactMock).not.toHaveBeenCalled();
  });

  it('rejects an eleventh attachment and keeps the ten accepted files, channel, and notes', () => {
    renderComposer();
    fillDraft();

    for (let index = 1; index <= MAX_EVIDENCE_FILES; index += 1) {
      attach(makeFile(`evidence-${index}.pdf`, 1024));
    }
    expect(stagedRows()).toHaveLength(MAX_EVIDENCE_FILES);
    expect(screen.queryAllByRole('alert')).toEqual([]);

    attach(makeFile('eleventh.pdf', 1024));

    const message = alertText();
    expect(message).toContain('eleventh.pdf');
    expect(message).toContain('at most 10 evidence files');
    expect(stagedRows()).toHaveLength(MAX_EVIDENCE_FILES);
    expect(stagedRows().some((row) => row.includes('eleventh.pdf'))).toBe(false);
    expect(stagedRows()[0]).toContain('evidence-1.pdf');
    expect(stagedRows()[MAX_EVIDENCE_FILES - 1]).toContain('evidence-10.pdf');
    expect(attachedCountText()).toContain('10 of 10 evidence files attached');
    expect(attachedCountText()).toContain('limit reached');
    expect(channelSelect().value).toBe('call');
    expect(notesField().value).toBe(NOTES_TEXT);
    expect(addContactMock).not.toHaveBeenCalled();
  });
});

describe('renewal evidence upload failure (Req 5.7)', () => {
  it('leaves the entry unsaved, names the reason, keeps the draft, and offers retry on an upload failure', async () => {
    addContactMock.mockRejectedValue(new Error('The storage service rejected the upload.'));
    const { onContactAdded } = renderComposer();
    fillDraft();
    attach(makeFile('proof.pdf', 1024));

    await act(async () => {
      submit();
    });

    const message = alertText();
    expect(message).toContain('The storage service rejected the upload.');
    expect(message).toContain('The contact entry was not saved.');
    expect(retryButton()).not.toBeNull();
    expect(retryButton()?.disabled).toBe(false);
    // Nothing was stored, so the parent is never asked to refresh: the timeline is unchanged.
    expect(onContactAdded).not.toHaveBeenCalled();
    expect(addContactMock).toHaveBeenCalledTimes(1);
    expect(channelSelect().value).toBe('call');
    expect(notesField().value).toBe(NOTES_TEXT);
    expect(stagedRows()).toHaveLength(1);
    expect(stagedRows()[0]).toContain('proof.pdf');
    expect(stagedRows()[0]).not.toContain('Saved');
  });

  it('fails an upload that does not finish within 120 seconds and leaves the entry unsaved', async () => {
    vi.useFakeTimers();
    // Never settles: only the composer's own 120-second bound can end this call.
    addContactMock.mockImplementation(() => new Promise<void>(() => {}));
    const { onContactAdded } = renderComposer();
    fillDraft();
    attach(makeFile('slow-upload.pdf', 1024));

    await act(async () => {
      submit();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EVIDENCE_UPLOAD_TIMEOUT_MS - 1);
    });
    expect(screen.queryAllByRole('alert')).toEqual([]);
    expect(retryButton()).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    const message = alertText();
    expect(message).toContain('The evidence upload did not finish within 120 seconds.');
    expect(message).toContain('The contact entry was not saved.');
    expect(retryButton()).not.toBeNull();
    expect(onContactAdded).not.toHaveBeenCalled();
    expect(channelSelect().value).toBe('call');
    expect(notesField().value).toBe(NOTES_TEXT);
    expect(stagedRows()).toHaveLength(1);
    expect(stagedRows()[0]).toContain('slow-upload.pdf');
  });

  it('stores the entry when the offered retry succeeds', async () => {
    addContactMock.mockRejectedValueOnce(new Error('The storage service rejected the upload.'));
    const { onContactAdded } = renderComposer();
    fillDraft();
    attach(makeFile('proof.pdf', 1024));

    await act(async () => {
      submit();
    });
    expect(onContactAdded).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(retryButton() as HTMLButtonElement);
    });

    expect(addContactMock).toHaveBeenCalledTimes(2);
    expect(addContactMock.mock.calls[1][0]).toMatchObject({
      recordId: 'record-1',
      channel: 'call',
      notes: NOTES_TEXT,
    });
    expect(addContactMock.mock.calls[1][0].evidenceFile?.name).toBe('proof.pdf');
    expect(onContactAdded).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByRole('alert')).toEqual([]);
    expect(stagedRows()).toEqual([]);
  });
});

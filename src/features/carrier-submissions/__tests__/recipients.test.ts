import { describe, expect, it } from 'vitest';

import { formatRecipientList, isValidEmailAddress, parseRecipientList } from '../recipients';

describe('isValidEmailAddress', () => {
  it.each([
    'submissions@allstarunderwriters.com',
    'olanda@nhpfs.com',
    'first.last+tag@sub.domain.co.uk',
  ])('accepts %s', (address) => {
    expect(isValidEmailAddress(address)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['not-an-address', 'no @'],
    ['two@@at.com', 'double @'],
    ['no@domain', 'domain without a dot'],
    ['@nodomain.com', 'no local part'],
    ['spaced address@x.com', 'internal space'],
  ])('rejects %s (%s)', (address) => {
    expect(isValidEmailAddress(address)).toBe(false);
  });

  it('rejects anything that could inject a mail header', () => {
    // A recipient carrying CRLF is how an attacker adds their own Bcc.
    expect(isValidEmailAddress('a@b.com\r\nBcc: attacker@evil.com')).toBe(false);
    expect(isValidEmailAddress('Name <a@b.com>')).toBe(false);
    expect(isValidEmailAddress('a@b.com;c@d.com')).toBe(false);
  });

  it('rejects an absurdly long address', () => {
    expect(isValidEmailAddress(`${'a'.repeat(320)}@b.com`)).toBe(false);
  });
});

describe('parseRecipientList', () => {
  it('splits on commas, semicolons and whitespace alike', () => {
    // Outlook pastes semicolons; spreadsheets paste commas or newlines.
    expect(parseRecipientList('a@x.com, b@x.com; c@x.com\nd@x.com').valid)
      .toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
  });

  it('lower-cases and de-duplicates while keeping first-seen order', () => {
    expect(parseRecipientList('B@x.com, a@x.com, b@X.COM').valid).toEqual(['b@x.com', 'a@x.com']);
  });

  it('separates the bad ones instead of silently dropping them', () => {
    const result = parseRecipientList('good@x.com, oops, also-bad@');
    expect(result.valid).toEqual(['good@x.com']);
    expect(result.invalid).toEqual(['oops', 'also-bad@']);
  });

  it('ignores a trailing separator rather than reporting an empty address', () => {
    expect(parseRecipientList('a@x.com,').invalid).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(parseRecipientList('')).toEqual({ valid: [], invalid: [] });
  });

  it('round-trips through formatRecipientList', () => {
    const stored = parseRecipientList('a@x.com; b@y.com').valid;
    expect(formatRecipientList(stored)).toBe('a@x.com, b@y.com');
    expect(parseRecipientList(formatRecipientList(stored)).valid).toEqual(stored);
  });

  it('formats null and undefined as an empty string', () => {
    expect(formatRecipientList(null)).toBe('');
    expect(formatRecipientList(undefined)).toBe('');
  });
});

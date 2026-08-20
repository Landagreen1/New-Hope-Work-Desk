/**
 * Spec: .kiro/specs/carrier-email-submission, Requirement 12.
 *
 * The assertions that matter are the negative ones. A cipher that decrypts happily is
 * easy; one that refuses to decrypt tampered input, and that never names the key in an
 * error, is the point.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isEncryptionConfigured, open, seal, secretsMatch } from '../crypto/secret-box';

const KEY_ENV = 'EMAIL_TOKEN_ENCRYPTION_KEY';
// Fixed test key. 32 bytes of 0x01..0x20, base64. Never used anywhere real.
const TEST_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const OTHER_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i)).toString('base64');

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[KEY_ENV];
  process.env[KEY_ENV] = TEST_KEY;
});

afterEach(() => {
  if (saved === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = saved;
});

describe('round trip', () => {
  it('returns exactly what it was given', () => {
    const secret = JSON.stringify({ access_token: 'ey.abc', refresh_token: '0.AY', obtained_at: 1 });
    expect(open(seal(secret))).toBe(secret);
  });

  it('handles an empty string, unicode, and a long value', () => {
    for (const value of ['', 'Ünïcödé — ✉️', 'x'.repeat(50_000)]) {
      expect(open(seal(value))).toBe(value);
    }
  });

  it('produces the documented envelope shape', () => {
    const [version, iv, tag, ciphertext] = seal('hello').split('.');
    expect(version).toBe('v1');
    expect(Buffer.from(iv, 'base64url')).toHaveLength(12);
    expect(Buffer.from(tag, 'base64url')).toHaveLength(16);
    expect(ciphertext.length).toBeGreaterThan(0);
  });

  it('never produces the same envelope twice for the same plaintext', () => {
    // A repeated IV under one key is a total break of GCM, not a weakness. This is the
    // test that catches someone "optimising" the IV to a constant.
    const envelopes = new Set(Array.from({ length: 50 }, () => seal('same input')));
    expect(envelopes.size).toBe(50);
  });

  it('does not leak the plaintext into the envelope', () => {
    expect(seal('SUPER-SECRET-TOKEN')).not.toContain('SUPER-SECRET-TOKEN');
  });
});

describe('refuses anything it cannot authenticate', () => {
  it('rejects a flipped bit in the ciphertext', () => {
    const [v, iv, tag, ct] = seal('hello').split('.');
    const bytes = Buffer.from(ct, 'base64url');
    bytes[0] ^= 0x01;
    expect(() => open([v, iv, tag, bytes.toString('base64url')].join('.')))
      .toThrow('Could not decrypt the stored credentials.');
  });

  it('rejects a tampered authentication tag', () => {
    const [v, iv, tag, ct] = seal('hello').split('.');
    const bytes = Buffer.from(tag, 'base64url');
    bytes[0] ^= 0x01;
    expect(() => open([v, iv, bytes.toString('base64url'), ct].join('.')))
      .toThrow('Could not decrypt the stored credentials.');
  });

  it('rejects a swapped IV', () => {
    const [v, , tag, ct] = seal('hello').split('.');
    const otherIv = seal('other').split('.')[1];
    expect(() => open([v, otherIv, tag, ct].join('.'))).toThrow();
  });

  it('rejects a different key', () => {
    const envelope = seal('hello');
    process.env[KEY_ENV] = OTHER_KEY;
    expect(() => open(envelope)).toThrow('Could not decrypt the stored credentials.');
  });

  it('gives the SAME message for a wrong key and for tampering', () => {
    // Distinguishing them would be an oracle.
    const envelope = seal('hello');
    const [v, iv, tag, ct] = envelope.split('.');
    const bytes = Buffer.from(ct, 'base64url');
    bytes[0] ^= 0x01;
    const tampered = (() => {
      try { open([v, iv, tag, bytes.toString('base64url')].join('.')); return ''; }
      catch (e) { return (e as Error).message; }
    })();
    process.env[KEY_ENV] = OTHER_KEY;
    const wrongKey = (() => {
      try { open(envelope); return ''; } catch (e) { return (e as Error).message; }
    })();
    expect(tampered).toBe(wrongKey);
  });

  it.each([
    ['not-an-envelope', 'Malformed credential envelope.'],
    ['v1.a.b', 'Malformed credential envelope.'],
    ['v1.a.b.c.d', 'Malformed credential envelope.'],
  ])('rejects %s', (envelope, message) => {
    expect(() => open(envelope)).toThrow(message);
  });

  it('rejects an unknown version rather than guessing', () => {
    const envelope = seal('hello').replace(/^v1\./, 'v2.');
    expect(() => open(envelope)).toThrow('Unsupported credential envelope version: v2');
  });

  it('rejects an IV of the wrong length', () => {
    const [v, , tag, ct] = seal('hello').split('.');
    expect(() => open([v, Buffer.alloc(8).toString('base64url'), tag, ct].join('.')))
      .toThrow('Malformed credential envelope.');
  });
});

describe('key configuration', () => {
  it('reports configured only when the key is usable', () => {
    expect(isEncryptionConfigured()).toBe(true);
    delete process.env[KEY_ENV];
    expect(isEncryptionConfigured()).toBe(false);
    process.env[KEY_ENV] = '   ';
    expect(isEncryptionConfigured()).toBe(false);
    process.env[KEY_ENV] = Buffer.alloc(16).toString('base64');
    expect(isEncryptionConfigured()).toBe(false);
  });

  it('names the problem without ever quoting the key', () => {
    process.env[KEY_ENV] = Buffer.alloc(16).toString('base64');
    try {
      seal('x');
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('must decode to 32 bytes');
      expect(message).toContain('decoded to 16');
      expect(message).not.toContain(process.env[KEY_ENV] as string);
    }
  });

  it('tells an operator how to generate one when it is missing', () => {
    delete process.env[KEY_ENV];
    expect(() => seal('x')).toThrow(/randomBytes\(32\)/);
  });

  it('is read at call time, not at import time', () => {
    // A module-level throw would take down every route that merely imports something in
    // this file's dependency graph, including ones that never encrypt.
    delete process.env[KEY_ENV];
    expect(() => isEncryptionConfigured()).not.toThrow();
    expect(isEncryptionConfigured()).toBe(false);
  });
});

describe('secretsMatch', () => {
  it('matches equal strings and rejects everything else', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
    expect(secretsMatch('', '')).toBe(true);
    expect(secretsMatch('abc', '')).toBe(false);
  });
});

/**
 * Authenticated symmetric encryption for credentials held at rest.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirement 12.
 *
 * The repository had no encryption-at-rest before this. `pgcrypto` is installed but is
 * used only for `gen_random_uuid()`, and there is no Supabase Vault usage anywhere. So
 * this is deliberately small and self-contained: AES-256-GCM from `node:crypto`, a key
 * from a server-only environment variable, and nothing else.
 *
 * WHY IN THE APPLICATION RATHER THAN IN POSTGRES
 *   The key never reaches the database. A stolen backup, a leaked service-role key, or a
 *   mis-scoped RLS policy therefore yields ciphertext and nothing more. Encrypting inside
 *   Postgres would put the key where the data is, which defeats the purpose.
 *
 * WHY GCM RATHER THAN CBC
 *   GCM authenticates. `open()` verifies the tag before returning, so a tampered
 *   ciphertext raises instead of decrypting to plausible rubbish that later code trusts.
 *
 * OPERATIONAL CONSEQUENCE, STATED PLAINLY
 *   Lose EMAIL_TOKEN_ENCRYPTION_KEY and every stored connection becomes undecryptable;
 *   each sender reconnects. That is the property that makes a database dump inert, not a
 *   flaw. Submission history is unaffected — it holds no ciphertext. The envelope carries
 *   a version prefix so a future key rotation can read v1 and write v2.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_ENV = 'EMAIL_TOKEN_ENCRYPTION_KEY';
const KEY_BYTES = 32;
const IV_BYTES = 12;   // 96 bits, the size GCM is specified for
const TAG_BYTES = 16;
const VERSION = 'v1';

/** Trims, and treats blank as absent — the same discipline as `src/lib/email.ts`. */
function readEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isEncryptionConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * The key, or a thrown error naming the problem without ever quoting the value.
 *
 * Read at call time rather than at module load: a module-level throw would take down
 * every route that merely imports something in this file's dependency graph, including
 * ones that never encrypt anything.
 */
function loadKey(): Buffer {
  const raw = readEnv(KEY_ENV);
  if (raw === null) {
    throw new Error(
      `${KEY_ENV} is not set. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new Error(`${KEY_ENV} is not valid base64.`);
  }

  if (key.length !== KEY_BYTES) {
    // Length is safe to report; it tells an operator exactly what is wrong and reveals
    // nothing about the key itself.
    throw new Error(
      `${KEY_ENV} must decode to ${KEY_BYTES} bytes, but decoded to ${key.length}.`,
    );
  }
  return key;
}

/**
 * Encrypts, returning `v1.<iv>.<tag>.<ciphertext>` with each part base64url.
 *
 * A fresh random IV per call, which is what makes two seals of the same plaintext differ
 * and is required for GCM to be safe at all — a repeated IV under the same key is a total
 * break, not a weakness.
 */
export function seal(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Decrypts, verifying the authentication tag. Throws on tampering or a wrong key. */
export function open(envelope: string): string {
  const key = loadKey();

  const parts = envelope.split('.');
  if (parts.length !== 4) {
    throw new Error('Malformed credential envelope.');
  }

  const [version, ivPart, tagPart, ciphertextPart] = parts;
  if (version !== VERSION) {
    throw new Error(`Unsupported credential envelope version: ${version}`);
  }

  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const ciphertext = Buffer.from(ciphertextPart, 'base64url');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Malformed credential envelope.');
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately opaque and identical for every failure mode. Distinguishing "wrong
    // key" from "tampered ciphertext" would be an oracle.
    throw new Error('Could not decrypt the stored credentials.');
  }
}

/** Constant-time comparison, for secrets compared outside the cipher. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak length. Compare
  // a fixed-size digest-free proxy: equal length is checked first, then the bytes.
  if (left.length !== right.length) {
    // Still burn a comparison so the early return is not the fast path.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

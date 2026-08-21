/**
 * The Microsoft integration must stay inside one module.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirement 12.7.
 *
 * Mirrors `src/features/cancellations/__tests__/provider-isolation.test.ts`, which exists
 * because the readiness check for SMS was silently false for months: it had hand-copied
 * the environment variable names and got them wrong (`RINGCENTRAL_*` where the product
 * uses `RC_*`). Nothing failed. It simply reported "not configured" forever.
 *
 * A credential name scattered across a codebase is a credential nobody can rotate with
 * confidence, and a provider hostname in a second file is a second place to update when
 * it changes. This test makes both a build failure rather than a discovery.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** The only files permitted to name the provider or its credentials. */
const ALLOWED = new Set([
  path.join('src', 'lib', 'microsoft-mail.ts'),
  // The readiness module is the one place allowed to ASK the provider whether it is
  // configured, so that routes never need to know a credential name to find out.
  path.join('src', 'features', 'carrier-submissions', 'server', 'readiness.ts'),
  path.join('src', 'lib', '__tests__', 'microsoft-mail.test.ts'),
  path.join('src', 'features', 'carrier-submissions', '__tests__', 'provider-isolation.test.ts'),
  '.env.example',
]);

const FORBIDDEN_OUTSIDE_MODULE = [
  'login.microsoftonline.com',
  'graph.microsoft.com',
  'MS_OAUTH_CLIENT_ID',
  'MS_OAUTH_CLIENT_SECRET',
  'MS_OAUTH_TENANT_ID',
  'MS_OAUTH_REDIRECT_URI',
];

/**
 * The encryption key name is allowed in the crypto module too — that module owns it the
 * way `microsoft-mail.ts` owns the OAuth names.
 */
const KEY_NAME = 'EMAIL_TOKEN_ENCRYPTION_KEY';
const KEY_ALLOWED = new Set([
  path.join('src', 'lib', 'crypto', 'secret-box.ts'),
  path.join('src', 'features', 'carrier-submissions', 'server', 'readiness.ts'),
  path.join('src', 'lib', '__tests__', 'secret-box.test.ts'),
  path.join('src', 'features', 'carrier-submissions', '__tests__', 'provider-isolation.test.ts'),
  '.env.example',
]);

const SCAN_DIRS = ['src', 'scripts'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.kiro']);

function collectFiles(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) collectFiles(full, found);
    else if (SCAN_EXTENSIONS.has(path.extname(entry))) found.push(full);
  }
  return found;
}

/**
 * Strips comments before scanning.
 *
 * A comment explaining *why* the provider lives in one module is documentation, not a
 * dependency on it — and a test that punished such comments would train people to delete
 * the explanation rather than fix the coupling. String literals are deliberately NOT
 * stripped: those are the actual coupling.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

const FILES = SCAN_DIRS.flatMap((dir) => collectFiles(path.join(ROOT, dir)));

describe('the Microsoft provider stays in one module', () => {
  it('scans a plausible number of files', () => {
    // Guards against the walker silently finding nothing and the suite passing vacuously.
    expect(FILES.length).toBeGreaterThan(100);
  });

  it.each(FORBIDDEN_OUTSIDE_MODULE)('%s appears nowhere else', (needle) => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const relative = path.relative(ROOT, file);
      if (ALLOWED.has(relative)) continue;
      if (stripComments(readFileSync(file, 'utf8')).includes(needle)) offenders.push(relative);
    }
    expect(offenders, `${needle} must stay inside src/lib/microsoft-mail.ts`).toEqual([]);
  });

  it('the encryption key name stays in the crypto module', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const relative = path.relative(ROOT, file);
      if (KEY_ALLOWED.has(relative)) continue;
      if (stripComments(readFileSync(file, 'utf8')).includes(KEY_NAME)) offenders.push(relative);
    }
    expect(offenders, `${KEY_NAME} must stay inside src/lib/crypto/secret-box.ts`).toEqual([]);
  });

  it('no API route imports the provider module directly', () => {
    // Routes stay thin; the send sequence lives in the feature module. A route that
    // reaches for the provider itself is a route that will grow a second, divergent copy
    // of the reserve-send-record ordering.
    const offenders: string[] = [];
    for (const file of FILES) {
      const relative = path.relative(ROOT, file);
      if (!relative.startsWith(path.join('src', 'app', 'api'))) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      if (/from\s+['"]@\/lib\/microsoft-mail['"]/.test(source)) offenders.push(relative);
    }
    // The OAuth routes are the deliberate exception: authorization is not sending, and
    // there is no sequence for them to duplicate.
    const unexpected = offenders.filter(
      (file) => !file.includes(path.join('email-connections', 'microsoft')),
    );
    expect(unexpected).toEqual([]);
  });

  it('no mail-read scope is requested anywhere', () => {
    // Requirement 1.4 and the Out of Scope list. The permission set is the enforcement of
    // "this application cannot read your inbox"; a widened scope should fail a build.
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${path.relative(ROOT, file)} requests a mail-read scope`).not.toMatch(
        /Mail\.Read(Write|Basic)?\b/,
      );
    }
  });
});

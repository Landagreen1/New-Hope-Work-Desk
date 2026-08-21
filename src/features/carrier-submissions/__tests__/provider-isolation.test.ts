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

import { REQUIRED_SCOPES } from '@/lib/microsoft-mail';

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

/**
 * Everything scanned, minus this file.
 *
 * A test that forbids a set of literals must name those literals, so scanning itself is
 * guaranteed self-indictment. Excluding it is not a loophole: this file contains no
 * runtime code, and the allowlists above already state which real modules may name what.
 */
const SELF = path.join('src', 'features', 'carrier-submissions', '__tests__', 'provider-isolation.test.ts');
const FILES = SCAN_DIRS.flatMap((dir) => collectFiles(path.join(ROOT, dir))).filter(
  (file) => path.relative(ROOT, file) !== SELF,
);

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

  it('requests exactly the four scopes it needs and no others', () => {
    // This test replaces an earlier one that forbade every `Mail.Read*` scope outright.
    // That assertion encoded a promise the product could not keep: `POST /me/messages`
    // requires delegated `Mail.ReadWrite`, so the draft path — chosen because
    // `/me/sendMail` returns no message identifier — cannot work without it. The original
    // scope set produced 403 ErrorAccessDenied on every send.
    //
    // The boundary is therefore redrawn rather than deleted. `Mail.ReadWrite` is admitted
    // because a specific call needs it; everything wider still fails the build, including
    // the `.Shared` variants that would reach OTHER people's mailboxes, and the
    // MailboxSettings scopes that have nothing to do with sending.
    expect([...REQUIRED_SCOPES].sort()).toEqual(
      ['Mail.ReadWrite', 'Mail.Send', 'User.Read', 'offline_access'].sort(),
    );

    const FORBIDDEN = [
      'Mail.Read.Shared',
      'Mail.ReadWrite.Shared',
      'Mail.Send.Shared',
      'Mail.ReadBasic.All',
      'MailboxSettings.Read',
      'MailboxSettings.ReadWrite',
      'Mail.ReadWrite.All',
      'Mail.Read.All',
      'Directory.Read.All',
      'User.ReadWrite',
    ];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      for (const scope of FORBIDDEN) {
        expect(source, `${path.relative(ROOT, file)} names ${scope}`).not.toContain(scope);
      }
    }
  });

  it('never requests application permissions', () => {
    // This is delegated OAuth: Oscar signs in and the Work Desk sends as Oscar. An
    // application permission would let the server send as ANY mailbox in the tenant with
    // no user present, which is a categorically different — and much larger — grant.
    for (const file of FILES) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(source, `${path.relative(ROOT, file)} uses the client_credentials grant`)
        .not.toContain('client_credentials');
      expect(source, `${path.relative(ROOT, file)} requests the .default scope`)
        .not.toContain('/.default');
    }
  });
});

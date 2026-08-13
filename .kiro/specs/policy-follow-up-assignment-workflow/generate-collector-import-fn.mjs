/**
 * Generates the forward-only replacement of `public.cancellation_import_batch` that accepts the
 * consolidated collector column set, by transforming the v1.10.10 definition rather than
 * re-typing 20,000 characters of merge logic by hand.
 *
 * Run: node .kiro/specs/policy-follow-up-assignment-workflow/generate-collector-import-fn.mjs
 * Output: the same directory, `_generated-cancellation-import-batch.sql`, which
 * `supabase/migrations/v1.13.6-policy-followup-collector-import.sql` embeds.
 *
 * Every transformation is asserted, so a change to v1.10.10 that moves one of these anchors makes
 * this script fail loudly instead of silently producing a function with a branch left un-widened.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// `fileURLToPath` rather than `new URL(...).pathname`: the repository path contains spaces, which
// the URL form percent-encodes.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const source = join(repoRoot, 'supabase', 'migrations', 'v1.10.10-cancellation-source-aware-merge.sql');

const text = readFileSync(source, 'utf8');
const start = text.indexOf('create or replace function public.cancellation_import_batch');
const end = text.indexOf('$fn$;', start);
if (start < 0 || end < 0) throw new Error('could not find the v1.10.10 cancellation_import_batch body');

let fn = text.slice(start, end + 5);
const nl = fn.includes('\r\n') ? '\r\n' : '\n';

const before = {
  eficacia: (fn.match(/p_column_set = 'eficacia'/g) ?? []).length,
  avisos: (fn.match(/p_column_set = 'avisos'/g) ?? []).length,
};
if (before.eficacia !== 13 || before.avisos !== 5) {
  throw new Error(`unexpected branch counts in v1.10.10: ${JSON.stringify(before)}`);
}

// ── 1. The case_status branch, widened for the collector's paid and review signals.
//
// The eficacia rule only advances a case that is still `Imported`, so that a later import cannot
// undo a manager's work. A collector paid signal has to be able to reach an `Open` case too —
// Requirement 8.4 makes it stop future reminders and hand the case to verification — so the
// collector gets one extra clause, still bounded to Imported/Open and still unable to resolve.
const oldStatus = [
  "       case_status = case",
  "         when p_column_set = 'eficacia' and v_case_status is not null",
  "              and cancellation_cases.case_status = 'Imported'",
  "           then v_case_status",
  "         else cancellation_cases.case_status",
  "       end,",
].join(nl);

if (!fn.includes(oldStatus)) throw new Error('the case_status branch did not match verbatim');

const newStatus = [
  "       case_status = case",
  "         when p_column_set in ('eficacia', 'collector') and v_case_status is not null",
  "              and cancellation_cases.case_status = 'Imported'",
  "           then v_case_status",
  "         -- v1.13.6: a collector paid or review signal may also move a case that is already",
  "         -- Open, which is what stops future reminders (Requirement 8.4). It is bounded to",
  "         -- Imported and Open, so it can never undo a manager's advance and can never resolve",
  "         -- a case: `Cancelled` is not in the list, and the collector only proposes it when the",
  "         -- identity is unambiguous, which the importer resolves before it gets here.",
  "         when p_column_set = 'collector'",
  "              and v_case_status in ('Payment Reported', 'Import Review Required')",
  "              and cancellation_cases.case_status in ('Imported', 'Open')",
  "           then v_case_status",
  "         else cancellation_cases.case_status",
  "       end,",
].join(nl);

fn = fn.replace(oldStatus, newStatus);

// ── 2. Every remaining ownership branch. A consolidated collector export carries both halves of
//      the legacy pair, so it owns both.
fn = fn.split("p_column_set = 'eficacia'").join("p_column_set in ('eficacia', 'collector')");
fn = fn.split("p_column_set = 'avisos'").join("p_column_set in ('avisos', 'collector')");

// ── 3. Accept the third column set, and name it in the refusal.
const oldGuard = "p_column_set not in ('eficacia', 'avisos')";
if (!fn.includes(oldGuard)) throw new Error('the column set guard did not match');
fn = fn.split(oldGuard).join("p_column_set not in ('eficacia', 'avisos', 'collector')");
fn = fn
  .split('needs a column set of eficacia or avisos (got %)')
  .join('needs a column set of eficacia, avisos, or collector (got %)');

const after = {
  eficacia: (fn.match(/p_column_set in \('eficacia', 'collector'\)/g) ?? []).length,
  avisos: (fn.match(/p_column_set in \('avisos', 'collector'\)/g) ?? []).length,
  narrow: (fn.match(/p_column_set = '(eficacia|avisos)'/g) ?? []).length,
};
// The 13 original eficacia branches are all collector-inclusive afterwards. The extra clause the
// new case_status rule adds is collector-*only*, so it is asserted separately below rather than
// counted here.
if (after.eficacia !== 13 || after.avisos !== 5 || after.narrow !== 0) {
  throw new Error(`transformation left branches unwidened: ${JSON.stringify(after)}`);
}
if (!fn.includes("p_column_set = 'collector'")) {
  throw new Error('the collector-only case_status clause is missing');
}

writeFileSync(join(here, '_generated-cancellation-import-batch.sql'), fn, 'utf8');
console.log(
  `generated _generated-cancellation-import-batch.sql (${fn.length} chars, `
  + `${after.eficacia} collector-inclusive eficacia branches, ${after.avisos} avisos branches)`,
);

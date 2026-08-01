/**
 * Payroll parity harness for the Time & Attendance redesign.
 *
 * Spec: .kiro/specs/time-attendance-ui-redesign
 * Requirement 2, criterion 4: the Payroll_Service produces the same regular
 * hours, overtime hours, break hours, total hours, PTO days, gross pay,
 * deductions total, and net pay for a period and data set as the pre-redesign
 * implementation produced.
 * Requirement 23, criterion 5: that equality is verified against every already
 * processed payroll period before migration stage 5 (`v1.9.4`) is applied.
 * Correctness Property 37 (output equality) states the same claim.
 *
 * What it does: reads every `payroll_periods` row with status `processed` or
 * `paid`, recalculates the period through `payrollInputs(period,
 * 'legacy_parity')`, and compares the result field by field against the stored
 * `payroll_summaries` rows. Any differing field, any stored row the
 * recalculation did not produce, and any recalculated row the stored set does
 * not carry is reported, and the run exits non-zero.
 *
 * This script is read-only. It issues one listing read, five reads per period
 * (the stored summaries plus the four `legacy_parity` sources), and one name
 * lookup for the profiles a report mentions. It never inserts, updates, or
 * deletes anything.
 *
 * A project with no `processed` or `paid` period reports parity vacuously and
 * exits 0, and says so: no stored figure contradicts the transcription because
 * no stored figure exists. That satisfies the stage-5 gate and is not evidence
 * the transcription is right. Property 47 (task 13.4) is that evidence, and the
 * comparison this script performs is checked in
 * `src/features/time-attendance/server/__tests__/payroll-parity-harness.test.ts`
 * so a clean report cannot come from a comparison that never compares.
 *
 * Usage (same env handling as scripts/verify-attendance-row-retention.mjs):
 *
 *   node --env-file=.env.local scripts/verify-payroll-parity.mjs
 *   node --env-file=.env.local scripts/verify-payroll-parity.mjs --period <uuid>
 *   node --env-file=.env.local scripts/verify-payroll-parity.mjs --json
 *
 * Flags:
 *   --period <uuid>   verify one period instead of every processed and paid one
 *                     (repeatable)
 *   --status <list>   comma-separated period statuses to verify
 *                     (default: processed,paid)
 *   --json            emit the report as JSON on stdout instead of the
 *                     human-readable table
 *   --quiet           print only differing periods and the verdict
 *
 * Exit codes: 0 when every period reproduces every compared field, 1 on any
 * difference or any read failure.
 *
 * ## Why the figures can legitimately differ
 *
 * A difference is not automatically a transcription bug. The recalculation reads
 * today's source rows, so anything that changed since the period was processed
 * moves the recomputed figure without `legacy_parity` being wrong:
 *
 * - A pay rate, overtime multiplier, or deduction edited in
 *   `employee_payment_settings` after processing. That table holds one current
 *   row per employee and keeps no history, so a period processed at an older
 *   rate can never be reproduced at that rate.
 * - A clock entry corrected, added, or deleted after processing.
 * - A time-off request approved, amended, or cancelled after processing.
 * - An employee deactivated since processing. `payrollInputs` reports active
 *   employees only, so their stored row has no counterpart. Reported as
 *   `stored row absent from the recalculation`, with the employee's current
 *   inactivity stated, so the case reads plainly rather than as a lost row.
 *
 * The report names each differing field and the size of the difference;
 * establishing which of the above produced it is the reader's job. What the
 * harness asserts is narrower, and is exactly what gates stage 5: on unchanged
 * source data, the transcription reproduces the stored figure.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

// ─── Loading the service module ──────────────────────────────────────────────
//
// The harness must recalculate *through* `legacy_parity`, not through a second
// copy of the formula: a transcription checked against another transcription
// proves nothing. `payrollInputs` is TypeScript and this is a plain Node script,
// and the repository has no TypeScript script runner, so the two are bridged by
// Node's own type stripping (on by default since Node 23.6) plus a resolve hook
// for the two things stripping does not cover:
//
//   - the `@/` path alias from `tsconfig.json`, which Node does not read
//   - extensionless module specifiers, which TypeScript allows and Node does not
//
// Every module in `payrollInputs`'s import graph is erasable TypeScript — no
// enum, no namespace, no parameter properties — so stripping is sufficient and
// no transform step is needed.
//
// Property 47 (task 13.4) checks the same function against an independent
// transcription of the Appendix A.5 formula on generated data; this harness
// checks it against production figures. Neither substitutes for the other.

const repoRoot = new URL('../', import.meta.url);
const SERVICE_MODULE = 'src/features/time-attendance/server/attendance-service.ts';
const TS_EXTENSIONS = ['.ts', '.tsx'];
const RESOLVE_EXTENSIONS = [...TS_EXTENSIONS, '.mjs', '.js'];

/** The first of `<base><ext>` and `<base>/index<ext>` that exists on disk. */
function firstExistingModule(baseHref) {
  for (const base of [baseHref, `${baseHref}/index`]) {
    for (const extension of RESOLVE_EXTENSIONS) {
      const candidate = new URL(base + extension);
      if (existsSync(fileURLToPath(candidate))) return candidate.href;
    }
  }
  return null;
}

const isTypeScript = (url) => TS_EXTENSIONS.some((extension) => url.endsWith(extension));

/**
 * `payrollInputs` and `AttendanceServiceError`, with the resolve hook installed
 * for the duration of the import.
 *
 * Registering inside a function rather than at module scope keeps this file free
 * of import-time side effects, so the comparison below can be unit tested
 * without a module hook landing in the test runner's own resolution.
 */
async function loadPayrollService() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // `@/x` is `src/x`, per the `paths` entry in tsconfig.json and the alias
      // in vitest.config.ts. Resolved against the repository root, not the
      // importer.
      const extensionless =
        specifier.startsWith('@/')
          ? new URL(`src/${specifier.slice(2)}`, repoRoot).href
          : specifier.startsWith('./') || specifier.startsWith('../')
            ? new URL(specifier, context.parentURL ?? repoRoot).href
            : null;

      if (extensionless !== null && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        const resolved = firstExistingModule(extensionless);
        if (resolved !== null) {
          return {
            url: resolved,
            shortCircuit: true,
            format: isTypeScript(resolved) ? 'module-typescript' : undefined,
          };
        }
      }

      const resolved = nextResolve(specifier, context);
      // Naming the format keeps Node from parsing the file as CommonJS first.
      return isTypeScript(resolved.url) ? { ...resolved, format: 'module-typescript' } : resolved;
    },
  });

  return import(new URL(SERVICE_MODULE, repoRoot).href);
}

// ─── The comparison ──────────────────────────────────────────────────────────

/**
 * The fields both sides hold, with the stored column's scale.
 *
 * `scale` is the decimal places of the `payroll_summaries` column, from
 * `v1.2.0-time-attendance.sql`. Comparison quantises the recomputed figure to
 * that scale and compares integers, which is the only well-defined comparison
 * available: `pto_days_used` is `numeric(4,1)`, so a computed 2.75 was stored as
 * 2.8 and an exact comparison would report a difference the arithmetic never
 * made. Integer units also sidestep binary floating point, so a value that
 * accumulated through 0.1 + 0.2 never reads as a one-cent difference.
 *
 * `named` marks the eight figures Requirement 2, criterion 4 names; those are
 * the criterion's subject. The other five are compared as well because
 * Requirement 2, criterion 6 reserves *any* payroll output change for a
 * separately approved rule change, and because a moved `regular_pay` under an
 * unmoved `gross_pay` is worth seeing.
 */
export const COMPARED_FIELDS = [
  { stored: 'regular_hours', computed: 'regularHours', scale: 2, named: true },
  { stored: 'overtime_hours', computed: 'overtimeHours', scale: 2, named: true },
  { stored: 'break_hours', computed: 'breakHours', scale: 2, named: true },
  { stored: 'total_hours', computed: 'totalHours', scale: 2, named: true },
  { stored: 'pto_days_used', computed: 'ptoDaysUsed', scale: 1, named: true },
  { stored: 'gross_pay', computed: 'grossPay', scale: 2, named: true },
  { stored: 'deductions_total', computed: 'deductionsTotal', scale: 2, named: true },
  { stored: 'net_pay', computed: 'netPay', scale: 2, named: true },
  { stored: 'pto_hours_paid', computed: 'ptoHoursPaid', scale: 2, named: false },
  { stored: 'regular_pay', computed: 'regularPay', scale: 2, named: false },
  { stored: 'overtime_pay', computed: 'overtimePay', scale: 2, named: false },
  { stored: 'pto_pay', computed: 'ptoPay', scale: 2, named: false },
  { stored: 'days_worked', computed: 'daysWorked', scale: 0, named: false },
];

const NAMED_FIELD_COUNT = COMPARED_FIELDS.filter((field) => field.named).length;
const DEFAULT_STATUSES = ['processed', 'paid'];

/** A figure at its stored scale, as an integer. Null for anything unreadable. */
export function quantise(value, scale) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 10 ** scale);
}

function formatAtScale(value, scale) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toFixed(scale) : String(value);
}

/** Every compared field of one employee's row that differs between the two sides. */
export function differingFields(stored, computed) {
  const differences = [];
  for (const field of COMPARED_FIELDS) {
    const storedValue = quantise(stored[field.stored], field.scale);
    const computedValue = quantise(computed[field.computed], field.scale);
    if (storedValue === computedValue) continue;
    differences.push({
      field: field.stored,
      named: field.named,
      scale: field.scale,
      stored: stored[field.stored] ?? null,
      computed: computed[field.computed] ?? null,
      delta:
        storedValue === null || computedValue === null
          ? null
          : (computedValue - storedValue) / 10 ** field.scale,
    });
  }
  return differences;
}

// ─── Arguments ───────────────────────────────────────────────────────────────

const USAGE = [
  'Usage:',
  '  node --env-file=.env.local scripts/verify-payroll-parity.mjs [--period <uuid>] [--status <list>] [--json] [--quiet]',
  '',
  'Verifies that payrollInputs(period, "legacy_parity") reproduces the stored',
  'payroll_summaries rows of every processed and paid payroll period.',
].join('\n');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv) {
  const flags = { json: false, quiet: false, help: false };
  const periodIds = [];
  let statuses = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const splitAt = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = splitAt === -1 ? arg : arg.slice(0, splitAt);
    const inlineValue = splitAt === -1 ? null : arg.slice(splitAt + 1);
    const readValue = () => {
      if (inlineValue !== null) return inlineValue;
      index += 1;
      return argv[index];
    };

    switch (name) {
      case '--json':
        flags.json = true;
        break;
      case '--quiet':
        flags.quiet = true;
        break;
      case '--help':
      case '-h':
        flags.help = true;
        break;
      case '--period': {
        const value = readValue();
        if (!value || !UUID.test(value)) {
          throw new Error(`--period needs a payroll_periods UUID. Received: ${String(value)}`);
        }
        periodIds.push(value);
        break;
      }
      case '--status': {
        const value = readValue();
        if (!value || value.startsWith('-')) throw new Error('--status needs a comma-separated list.');
        statuses = value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        if (statuses.length === 0) throw new Error('--status needs at least one status.');
        break;
      }
      default:
        throw new Error(`Unrecognised argument: ${arg}\n\n${USAGE}`);
    }
  }

  return { ...flags, periodIds, statuses: statuses ?? DEFAULT_STATUSES };
}

// ─── Run ─────────────────────────────────────────────────────────────────────
//
// Every path returns an exit code rather than calling `process.exit`. On Windows
// under Node 24, `process.exit` from a script that both registered a module hook
// and issued a `fetch` trips a libuv teardown assertion and aborts with
// 0xC0000409, which a CI gate would read as a crash rather than as a verdict.
// Draining the loop and setting `process.exitCode` reports the same verdict and
// exits cleanly.

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !secret) {
    console.error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY in .env.local.',
    );
    return 1;
  }

  // Identifies which project produced the report without disclosing a credential.
  const projectHost = new URL(url).host;

  // A service client, because `payrollInputs` performs no authorisation and
  // takes no Actor: payroll is calculated over the whole active roster and the
  // figures are reserved to an Attendance_Administrator (Requirement 21,
  // criterion 6). A script running outside a request has no session to bind to,
  // so it supplies the privileged client itself, as the function's contract
  // requires.
  const supabase = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const log = (line = '') => {
    if (!args.json) console.log(line);
  };

  /** Rows, or a thrown failure: a silently empty read would report false parity. */
  const readRows = async (label, query) => {
    const { data, error } = await query;
    if (error) throw new Error(`${label}: ${error.message}`);
    return data ?? [];
  };

  const readStoredSummaries = (periodId) =>
    readRows(
      `payroll_summaries for period ${periodId}`,
      supabase
        .from('payroll_summaries')
        .select(COMPARED_FIELDS.map((field) => field.stored).concat('profile_id').join(', '))
        .eq('payroll_period_id', periodId),
    );

  /**
   * Names and current activity for the profiles a report mentions, so a
   * difference reads without a second query by hand. One query for the whole
   * set, never one per profile (Requirement 20, criterion 1).
   */
  const readProfileLabels = async (profileIds) => {
    if (profileIds.length === 0) return new Map();
    const rows = await readRows(
      'profiles',
      supabase.from('profiles').select('id, display_name, initials, is_active').in('id', profileIds),
    );
    return new Map(rows.map((row) => [row.id, row]));
  };

  const { AttendanceServiceError, payrollInputs } = await loadPayrollService();

  /**
   * One period's comparison.
   *
   * The recalculation runs in `legacy_parity` mode with neither a policy nor an
   * evaluation instant supplied, because that mode reads neither. That is what
   * makes a period processed months ago replayable at all.
   */
  const verifyPeriod = async (period) => {
    const [stored, computed] = await Promise.all([
      readStoredSummaries(period.id),
      payrollInputs({ from: period.period_start, to: period.period_end }, 'legacy_parity', {
        client: supabase,
      }),
    ]);

    const storedByProfile = new Map(stored.map((row) => [row.profile_id, row]));
    const computedByProfile = new Map(computed.map((row) => [row.profileId, row]));

    const mismatchedRows = [];
    const missingFromRecalculation = [];
    const absentFromStored = [];

    for (const [profileId, storedRow] of storedByProfile) {
      const computedRow = computedByProfile.get(profileId);
      if (computedRow === undefined) {
        missingFromRecalculation.push(profileId);
        continue;
      }
      const differences = differingFields(storedRow, computedRow);
      if (differences.length > 0) mismatchedRows.push({ profileId, differences });
    }

    for (const profileId of computedByProfile.keys()) {
      if (!storedByProfile.has(profileId)) absentFromStored.push(profileId);
    }

    return {
      period,
      storedRowCount: storedByProfile.size,
      computedRowCount: computedByProfile.size,
      mismatchedRows,
      missingFromRecalculation,
      absentFromStored,
      clean:
        mismatchedRows.length === 0 &&
        missingFromRecalculation.length === 0 &&
        absentFromStored.length === 0,
    };
  };

  const describeProfile = (profileId, labels) => {
    const profile = labels.get(profileId);
    if (profile === undefined) return `${profileId} (no profile row)`;
    const name = profile.display_name || profile.initials || profileId;
    return profile.is_active ? name : `${name} (inactive)`;
  };

  const reportPeriod = (result, labels) => {
    const { period } = result;
    const heading = `${period.period_start} to ${period.period_end}  [${period.status}]  ${period.id}`;

    if (result.clean) {
      if (args.quiet) return;
      log(`  MATCH   ${heading}`);
      log(`          ${result.storedRowCount} row(s), ${COMPARED_FIELDS.length} field(s) each`);
      return;
    }

    log(`  DIFFERS ${heading}`);
    log(`          stored ${result.storedRowCount} row(s), recalculated ${result.computedRowCount}`);

    for (const row of result.mismatchedRows) {
      log(`          ${describeProfile(row.profileId, labels)}`);
      for (const difference of row.differences) {
        const storedText = formatAtScale(difference.stored, difference.scale);
        const computedText = formatAtScale(difference.computed, difference.scale);
        const deltaText =
          difference.delta === null
            ? 'unreadable'
            : `${difference.delta > 0 ? '+' : ''}${formatAtScale(difference.delta, difference.scale)}`;
        log(
          `            ${difference.named ? '*' : ' '} ${difference.field.padEnd(16)} stored ${storedText.padStart(10)}   recalculated ${computedText.padStart(10)}   delta ${deltaText.padStart(10)}`,
        );
      }
    }

    for (const profileId of result.missingFromRecalculation) {
      log(`          ${describeProfile(profileId, labels)}: stored row absent from the recalculation`);
    }

    for (const profileId of result.absentFromStored) {
      log(`          ${describeProfile(profileId, labels)}: recalculated row absent from the stored set`);
    }
  };

  let periods;
  try {
    const listing = supabase
      .from('payroll_periods')
      .select('id, period_start, period_end, pay_date, status, processed_at')
      .order('period_start', { ascending: true });
    periods = await readRows(
      'payroll_periods',
      args.periodIds.length > 0 ? listing.in('id', args.periodIds) : listing.in('status', args.statuses),
    );
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (args.periodIds.length > 0) {
    const found = new Set(periods.map((period) => period.id));
    const unknown = args.periodIds.filter((id) => !found.has(id));
    if (unknown.length > 0) {
      console.error(`No payroll_periods row for: ${unknown.join(', ')}`);
      return 1;
    }
  }

  const selection = args.periodIds.length > 0 ? 'selected by id' : args.statuses.join(' or ');
  log(`Project: ${projectHost}`);
  log(`Payroll parity: ${periods.length} period(s) with status ${selection}`);
  log(
    `Comparing ${COMPARED_FIELDS.length} field(s) per employee row, ${NAMED_FIELD_COUNT} of them named by Requirement 2, criterion 4 (marked *)`,
  );
  log();

  const results = [];
  const failedPeriods = [];

  for (const period of periods) {
    try {
      results.push(await verifyPeriod(period));
    } catch (error) {
      const reason =
        error instanceof AttendanceServiceError ? `${error.code}: ${error.message}` : error.message;
      failedPeriods.push({ period, reason });
      log(`  FAILED  ${period.period_start} to ${period.period_end}  [${period.status}]  ${period.id}`);
      log(`          ${reason}`);
    }
  }

  let labels = new Map();
  try {
    labels = await readProfileLabels([
      ...new Set(
        results.flatMap((result) => [
          ...result.mismatchedRows.map((row) => row.profileId),
          ...result.missingFromRecalculation,
          ...result.absentFromStored,
        ]),
      ),
    ]);
  } catch (error) {
    // A missing label costs the report a name, not its verdict.
    log(`  (could not read profile names: ${error.message})`);
  }

  for (const result of results) reportPeriod(result, labels);

  const differing = results.filter((result) => !result.clean);
  const clean = differing.length === 0 && failedPeriods.length === 0;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          project: projectHost,
          verifiedAt: new Date().toISOString(),
          statuses: args.periodIds.length > 0 ? null : args.statuses,
          comparedFields: COMPARED_FIELDS.map((field) => ({
            field: field.stored,
            named: field.named,
          })),
          periods: results.map((result) => ({
            id: result.period.id,
            periodStart: result.period.period_start,
            periodEnd: result.period.period_end,
            status: result.period.status,
            storedRowCount: result.storedRowCount,
            computedRowCount: result.computedRowCount,
            clean: result.clean,
            mismatchedRows: result.mismatchedRows,
            missingFromRecalculation: result.missingFromRecalculation,
            absentFromStored: result.absentFromStored,
          })),
          failedPeriods: failedPeriods.map((entry) => ({ id: entry.period.id, reason: entry.reason })),
          clean,
        },
        null,
        2,
      ),
    );
  } else {
    log();
  }

  if (failedPeriods.length > 0) {
    console.error(
      `PARITY UNVERIFIED: ${failedPeriods.length} of ${periods.length} period(s) could not be recalculated.`,
    );
    console.error('Migration stage 5 (v1.9.4) stays blocked until every period reports a verdict.');
    return 1;
  }

  if (differing.length > 0) {
    console.error(
      `PARITY FAILED (Requirement 2, criterion 4): ${differing.length} of ${periods.length} period(s) differ from the stored payroll_summaries rows.`,
    );
    console.error('');
    console.error(
      'Migration stage 5 (v1.9.4) is blocked. For each difference, establish whether the source rows',
    );
    console.error(
      'changed since the period was processed — a pay rate, a corrected clock entry, an amended',
    );
    console.error(
      'time-off request, a deactivated employee — or whether the legacy_parity transcription is wrong.',
    );
    console.error('Only the second is a defect in this redesign, and only a clean report unblocks the stage.');
    return 1;
  }

  if (periods.length === 0) {
    log('No period carries a stored figure to contradict, so parity holds vacuously.');
    log('That is not evidence the transcription is right: Property 47 (task 13.4) is.');
    log('PARITY HOLDS: nothing to verify.');
    return 0;
  }

  log(
    `PARITY HOLDS: all ${results.length} period(s) reproduced every compared field of every stored payroll_summaries row.`,
  );
  return 0;
}

// Run only when invoked as a script. Importing this file — which the harness's
// own unit test does — must not open a client or read a database.
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));

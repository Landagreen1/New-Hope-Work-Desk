// The audit vocabulary and its database CHECK constraint must not drift apart again.
//
// This test exists because they already did. `cancellation_events.event_type` is guarded by
// `cancellation_events_event_type_check`, last set by v1.10.10 with 17 coarse values. The
// application writes a finer vocabulary from `CANCELLATION_EVENT_TYPES` in `api.ts` plus one
// exported constant per domain module, and eleven of those values were absent from the
// constraint. Every affected path writes its primary row first and appends the audit entry
// second, so the operation succeeded, the timeline entry was refused, and the agent was shown a
// failure for work that had actually been done.
//
// Nothing caught it, because the two lists live in different languages in different files and
// no test compared them. This test compares them: it reads the constraint out of the migration
// SQL and asserts it admits every event type the TypeScript writes.
//
// It reads the migration text rather than the live database on purpose, following
// `rls-role-enforcement.test.ts`, which parses the RLS migration the same way. That keeps it in
// the normal `npm test` run with no credentials and no network. The live database is proven
// separately by the post-condition block inside the migration, which inserts one row per event
// type and rolls the probe back — a text comparison cannot prove what Postgres accepts, and the
// post-condition cannot run in CI, so both are needed.

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CANCELLATION_EVENT_TYPES } from '../api';
import { IMPORTED_DATA_CORRECTED_EVENT } from '../manager-api';
import { OPT_OUT_EVENT_TYPE, SUPPRESSION_CLEARED_EVENT_TYPE } from '../domain/suppression';
import { ESCALATION_CLEARED_EVENT_TYPE, ESCALATION_RAISED_EVENT_TYPE } from '../domain/escalation';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  'v1.13.7-cancellation-event-type-vocabulary.sql',
);

/**
 * Every `event_type` the application writes.
 *
 * Imported from the modules that own them rather than restated, so a renamed constant moves
 * this list with it instead of leaving a stale copy that agrees with nothing.
 *
 * `send_blocked` and `communication_retry` come from the scheduler modules
 * (`scheduler/run.ts`, `scheduler/manual-send.ts`). They are named literally here because those
 * modules pull in the server-side send stack, and this test is a pure text comparison that
 * should not need it. Both are asserted below to be in the constraint regardless.
 */
const WRITTEN_EVENT_TYPES: readonly string[] = [
  ...Object.values(CANCELLATION_EVENT_TYPES),
  IMPORTED_DATA_CORRECTED_EVENT,
  OPT_OUT_EVENT_TYPE,
  SUPPRESSION_CLEARED_EVENT_TYPE,
  ESCALATION_RAISED_EVENT_TYPE,
  ESCALATION_CLEARED_EVENT_TYPE,
  'send_blocked',
  'communication_retry',
  'follow_up',
];

/** The values written by the server-side functions, which must never be dropped. */
const SERVER_WRITTEN_EVENT_TYPES: readonly string[] = [
  'imported',
  'import_updated',
  'assignment',
  'status_change',
  'correction',
  'communication_sent',
  'communication_failed',
  'suppression_set',
  'suppression_cleared',
  'verification',
];

/** The `event_type in (...)` list of the migration's CHECK constraint. */
function admittedEventTypes(): string[] {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const withoutComments = sql.replace(/--[^\n]*/g, '');
  const match = withoutComments.match(
    /add\s+constraint\s+cancellation_events_event_type_check\s+check\s*\(\s*event_type\s+in\s*\(([\s\S]*?)\)\s*\)/i,
  );
  if (match === null) {
    throw new Error(
      `Could not find the event_type CHECK constraint in ${path.basename(MIGRATION)}. ` +
        'If the constraint moved to a later migration, point MIGRATION at it.',
    );
  }
  return Array.from(match[1].matchAll(/'([^']+)'/g), (found) => found[1]);
}

describe('cancellation_events.event_type vocabulary', () => {
  const admitted = admittedEventTypes();

  it('reads a non-trivial constraint out of the migration', () => {
    // Guards the parser itself: a regex that silently matched nothing would make every
    // assertion below vacuous.
    expect(admitted.length).toBeGreaterThanOrEqual(28);
    expect(admitted).toContain('imported');
  });

  it('admits every event type the application writes', () => {
    const missing = WRITTEN_EVENT_TYPES.filter((type) => !admitted.includes(type)).sort();
    expect(missing).toEqual([]);
  });

  it('admits every event type the server-side functions write', () => {
    const missing = SERVER_WRITTEN_EVENT_TYPES.filter((type) => !admitted.includes(type)).sort();
    expect(missing).toEqual([]);
  });

  it('lists each admitted value once', () => {
    const duplicates = admitted.filter((type, index) => admitted.indexOf(type) !== index);
    expect(duplicates).toEqual([]);
  });

  it('admits nothing the codebase does not write', () => {
    // The reverse direction: a value in the constraint that nothing writes is either a typo or
    // a leftover, and both are worth knowing about. Update this test with the write path when
    // adding an event type.
    const known = new Set([...WRITTEN_EVENT_TYPES, ...SERVER_WRITTEN_EVENT_TYPES]);
    const unexplained = admitted.filter((type) => !known.has(type)).sort();
    expect(unexplained).toEqual([]);
  });

  it('keeps the eleven values whose absence broke the audit write', () => {
    // Named explicitly so a future narrowing of the constraint fails here with the reason
    // rather than as an anonymous count mismatch.
    for (const type of [
      'contact_added',
      'contact_preferred_language_changed',
      'contact_authorization_changed',
      'customer_response_recorded',
      'verification_outcome_recorded',
      'case_status_overridden',
      'case_assigned',
      'automatic_sending_changed',
      'imported_data_corrected',
      'contact_opt_out_recorded',
      'contact_suppression_cleared',
    ]) {
      expect(admitted, type).toContain(type);
    }
  });
});

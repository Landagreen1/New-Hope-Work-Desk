// src/features/time-attendance/server/attendance-rpc.ts
// The route-side half of the attendance / queue-status separation.
//
// Spec: .kiro/specs/attendance-queue-status-separation, tasks 6.1, 6.2, 6.3
// Requirements: 2.7, 2.8, 2.14, 2.18
//
// The four clock routes used to perform three to five independent Supabase calls
// each, and to discard the result of the availability write with a bare
// `await supabase.rpc(...)`. `supabase-js` returns `{ data, error }` and never
// throws, so `Agent permission required`, `Active profile not found` and every
// lock failure were invisible and the route answered HTTP 200 for a state it had
// never verified (defect 1.5).
//
// Each route is now one RPC into a `security definer` function that owns the
// whole transaction, and this module holds the two things the route still has to
// decide:
//
//   * `resolveFailedPortion` — which half of the operation the raised error
//     belongs to, so a failure names the portion that failed rather than being
//     reported as an unqualified success (2.7).
//   * `readStatusSnapshot` — both statuses, read back from the database, which is
//     the read `/api/time-clock/active` answers with and the read a failure
//     response re-reads with. Nothing in a response is assumed (2.18).
//
// Because the SQL function is one transaction, an error means nothing committed:
// there is no half-applied outcome to describe, only a portion to name.

import type { SupabaseClient } from '@supabase/supabase-js';

/** Attendance status: the three values 2.14 labels `Attendance:`. */
export type AttendanceStatusValue = 'clocked_out' | 'working' | 'on_break';

/** Sales-queue status: `public.availability_status`, labelled `Sales Queues:`. */
export type QueueStatusValue = 'available' | 'break' | 'unavailable';

/** The per-agent opt-in gate: `public.queue_status_mode`. */
export type QueueStatusMode = 'manual' | 'attendance_assisted';

/** Which half of an attendance transition failed (2.7). */
export type FailedPortion = 'attendance' | 'queue_status';

/**
 * The SQLSTATE the four attendance functions re-raise a queue-portion failure
 * under. The wrapper around every `apply_queue_status` call in
 * `v1.12.13-attendance-queue-status-separation.sql` raises
 * `queue_status: <original message>` with this code, so the portion is carried
 * explicitly rather than guessed from prose.
 */
export const QUEUE_PORTION_SQLSTATE = 'QS001';

/** The prefix that SQLSTATE puts on the message, kept as a second signal. */
const QUEUE_PORTION_PREFIX = 'queue_status:';

/**
 * Messages that belong to the queue portion even when the SQLSTATE does not say
 * so — a queue function reached other than through the wrapper, most obviously
 * `set_my_queue_status` called directly. `Agent permission required` and
 * `Active profile not found` are `set_my_availability`'s own raises.
 */
const QUEUE_PORTION_PATTERNS: readonly RegExp[] = [
  /agent permission required/i,
  /rotation/i,
  /availability/i,
  /queue/i,
];

/**
 * SQLSTATEs a lock or serialization failure arrives under. Inside these four
 * functions the only `for update` walk that contends across sessions is
 * `set_my_availability`'s pass over all three `rotation_state` rows: the
 * attendance rows are locked per employee, and a second request from the same
 * employee is answered with `already_applied` rather than by raising. So a lock
 * failure here is the queue portion.
 */
const LOCK_SQLSTATES: readonly string[] = ['55P03', '40001', '40P01'];

/** The shape `supabase-js` reports a Postgres error in. */
export interface PostgresErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/**
 * Which portion of the transition the error belongs to.
 *
 * The unmapped fallback is `'attendance'`: the attendance change is applied
 * first and is the only portion every one of the four functions performs, so an
 * error carrying nothing that identifies it is reported against the portion that
 * was certainly attempted. Naming `queue_status` instead would tell the reader
 * their punch was recorded when it may not have been.
 */
export function resolveFailedPortion(error: PostgresErrorLike | null | undefined): FailedPortion {
  if (!error) return 'attendance';

  const code = typeof error.code === 'string' ? error.code : '';
  if (code === QUEUE_PORTION_SQLSTATE) return 'queue_status';
  if (LOCK_SQLSTATES.includes(code)) return 'queue_status';

  const message = typeof error.message === 'string' ? error.message : '';
  if (message.trim().toLowerCase().startsWith(QUEUE_PORTION_PREFIX)) return 'queue_status';
  if (QUEUE_PORTION_PATTERNS.some((pattern) => pattern.test(message))) return 'queue_status';

  return 'attendance';
}

/** The open clock entry, as both statuses are read alongside it. */
export interface OpenEntry {
  id: string;
  clock_in: string;
  clock_status: string;
  break_minutes: number;
}

/** The open break on that entry, when there is one. */
export interface OpenBreak {
  id: string;
  break_start: string;
  break_type: string;
  pre_break_queue_status?: QueueStatusValue | null;
}

/**
 * Both statuses and the attendance rows behind them, read from the database.
 *
 * This is the payload `/api/time-clock/active` answers with, and the state a
 * failed clock action is answered with, so a panel renders two labelled values
 * from one read rather than from an assumption (2.14, 2.18).
 */
export interface StatusSnapshot {
  clocked_in: boolean;
  attendance_status: AttendanceStatusValue;
  queue_status: QueueStatusValue | null;
  queue_status_mode: QueueStatusMode | null;
  is_agent: boolean;
  entry: OpenEntry | null;
  active_break: OpenBreak | null;
}

/**
 * Whether an employee is at work, on a break, or gone, from the two rows that
 * decide it. Derived in one place so the routes cannot disagree.
 */
export function attendanceStatusOf(
  entry: OpenEntry | null,
  activeBreak: OpenBreak | null,
): AttendanceStatusValue {
  if (entry === null) return 'clocked_out';
  return activeBreak === null ? 'working' : 'on_break';
}

/**
 * Read both statuses for one employee.
 *
 * Three reads, all under the caller's own RLS posture: the open clock entry, the
 * open break on it, and the profile fields that carry the queue status, the mode
 * and whether queue status means anything for this employee at all.
 */
export async function readStatusSnapshot(
  supabase: SupabaseClient,
  profileId: string,
): Promise<StatusSnapshot> {
  const { data: entry } = await supabase
    .from('time_clock_entries')
    .select('id, clock_in, clock_status, break_minutes')
    .eq('profile_id', profileId)
    .is('clock_out', null)
    .order('clock_in', { ascending: false })
    .limit(1)
    .maybeSingle();

  const openEntry = (entry as OpenEntry | null) ?? null;

  let openBreak: OpenBreak | null = null;
  if (openEntry !== null) {
    const { data: breakRow } = await supabase
      .from('time_clock_breaks')
      .select('id, break_start, break_type, pre_break_queue_status')
      .eq('clock_entry_id', openEntry.id)
      .is('break_end', null)
      .order('break_start', { ascending: false })
      .limit(1)
      .maybeSingle();
    openBreak = (breakRow as OpenBreak | null) ?? null;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, availability, queue_status_mode')
    .eq('id', profileId)
    .maybeSingle();

  const role = (profile?.role as string | undefined) ?? null;

  return {
    clocked_in: openEntry !== null,
    attendance_status: attendanceStatusOf(openEntry, openBreak),
    queue_status: (profile?.availability as QueueStatusValue | undefined) ?? null,
    queue_status_mode: (profile?.queue_status_mode as QueueStatusMode | undefined) ?? null,
    is_agent: role === 'agent',
    entry: openEntry,
    active_break: openBreak,
  };
}

/**
 * The body a failed attendance RPC is answered with (2.7).
 *
 * Names the portion that failed and carries both statuses as they stand in the
 * database, so the client can render the truth rather than the request it hoped
 * for. Never an unqualified success: the caller sends this with a 4xx.
 */
export interface AttendanceFailureBody {
  error: string;
  failed_portion: FailedPortion;
  attendance_status: AttendanceStatusValue;
  queue_status: QueueStatusValue | null;
  queue_status_mode: QueueStatusMode | null;
  is_agent: boolean;
}

/**
 * Build that body, re-reading both statuses from the database.
 *
 * The re-read is deliberately not skipped on the assumption that a failed
 * transaction changed nothing: the point of 2.7 is that the response describes
 * observed state.
 */
export async function attendanceFailureBody(
  supabase: SupabaseClient,
  profileId: string,
  error: PostgresErrorLike,
): Promise<AttendanceFailureBody> {
  const snapshot = await readStatusSnapshot(supabase, profileId);
  return {
    error: typeof error.message === 'string' && error.message !== ''
      ? error.message
      : 'The clock action could not be completed.',
    failed_portion: resolveFailedPortion(error),
    attendance_status: snapshot.attendance_status,
    queue_status: snapshot.queue_status,
    queue_status_mode: snapshot.queue_status_mode,
    is_agent: snapshot.is_agent,
  };
}

/**
 * The jsonb the four attendance functions return.
 *
 * Every field is read from the database inside the same transaction that applied
 * the change, by `public.attendance_status_payload` (2.18).
 */
export interface AttendanceRpcPayload {
  attendance_status: AttendanceStatusValue;
  queue_status: QueueStatusValue | null;
  queue_status_mode: QueueStatusMode | null;
  is_agent: boolean;
  entry: (OpenEntry & { clock_out: string | null; total_hours: number | null }) | null;
  break: OpenBreak | null;
  total_hours: number | null;
  already_applied: boolean;
  already_open: boolean;
  changed_queue: boolean;
  offers_join_sales_queues: boolean;
  duration_minutes?: number;
}

/** The payload as an object, whatever `supabase-js` handed back. */
export function asAttendancePayload(data: unknown): AttendanceRpcPayload | null {
  return typeof data === 'object' && data !== null ? (data as AttendanceRpcPayload) : null;
}

/** An HTTP answer as its two parts, so the mapping can be read and tested. */
export interface HttpAnswer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The status fields every clock response carries.
 *
 * Both statuses, whether the queue portion moved anything, and whether this
 * request was the one that applied the change — all read from the database inside
 * the transaction (2.18).
 */
export function attendanceStatusFields(payload: AttendanceRpcPayload): Record<string, unknown> {
  return {
    attendance_status: payload.attendance_status,
    queue_status: payload.queue_status,
    queue_status_mode: payload.queue_status_mode,
    is_agent: payload.is_agent,
    changed_queue: payload.changed_queue,
    already_applied: payload.already_applied,
    offers_join_sales_queues: payload.offers_join_sales_queues,
  };
}

/**
 * The answer for the two actions that open something: clock-in and break-start.
 *
 * The loser of a genuine race is answered 200 with the open row it lost to and
 * `already_open: true`, because its caller's intent — to be clocked in, or to be
 * on a break — is satisfied. That contract predates this fix and is unchanged
 * (Requirement 3.13); the fix adds the status fields beside it.
 */
export function openedActionAnswer(
  payload: AttendanceRpcPayload,
  row: 'entry' | 'break',
): HttpAnswer {
  return {
    status: payload.already_open ? 200 : 201,
    body: {
      [row]: row === 'entry' ? payload.entry : payload.break,
      already_open: payload.already_open === true,
      ...attendanceStatusFields(payload),
    },
  };
}

/**
 * The answer for the two actions that close something: clock-out and break-end.
 *
 * Always 200, and never an `error`. A retried or concurrent request is answered
 * with the committed state and `already_applied: true` rather than the HTTP 400
 * (`Not clocked in.`, `No active break to end.`) these routes used to produce for
 * an action that had in fact happened — which is what made retry semantics differ
 * per action and left a client unable to tell "already applied" from "failed"
 * (Requirements 2.10, 1.11).
 */
export function closedActionAnswer(
  payload: AttendanceRpcPayload,
  extra: Record<string, unknown> = {},
): HttpAnswer {
  return {
    status: 200,
    body: { success: true, ...extra, ...attendanceStatusFields(payload) },
  };
}

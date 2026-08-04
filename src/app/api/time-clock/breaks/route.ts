import {
  asAttendancePayload,
  attendanceFailureBody,
  closedActionAnswer,
  openedActionAnswer,
} from "@/features/time-attendance/server/attendance-rpc";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/time-clock/breaks
 * Start a break. Body: { break_type?: 'lunch' | 'short' | 'personal' }
 *
 * One RPC into `public.attendance_break_start`, which owns the whole transaction:
 * the break insert, the `clock_status` update and the permitted queue change.
 *
 * The one-open-break rule is still enforced by `uniq_time_clock_open_break`, and
 * the loser of the race is still answered with the open break it lost to as a
 * success with `already_open: true` (Requirement 3.13). The winner owns the
 * `clock_status` update and the queue portion, exactly as before.
 *
 * Two things changed in the queue portion. A break start records the pre-break
 * queue status on the break row, and it moves the agent to Break ONLY from
 * Available — so an agent who is deliberately Unavailable is no longer laundered
 * into queue-eligible by taking a break (Requirements 2.3, 2.4). And for a
 * non-agent, no queue call is made at all: `set_my_availability` requires
 * `is_agent()`, so every non-agent break used to raise inside Postgres while this
 * route answered 201 (Requirements 2.7, 2.8).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* ok */ }

  const breakType = String(body.break_type ?? "lunch");
  if (!["lunch", "short", "personal"].includes(breakType)) {
    return Response.json({ error: "Invalid break type." }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("attendance_break_start", {
    p_break_type: breakType,
  });

  // Requirement 2.7: the result is inspected, and a failure names the portion.
  if (error) {
    return Response.json(await attendanceFailureBody(supabase, user.id, error), { status: 400 });
  }

  const payload = asAttendancePayload(data);
  if (!payload) {
    return Response.json({ error: "The break did not report a state." }, { status: 500 });
  }

  const answer = openedActionAnswer(payload, "break");
  return Response.json(answer.body, { status: answer.status });
}

/**
 * PATCH /api/time-clock/breaks
 * End the current break.
 *
 * One RPC into `public.attendance_break_end`. The `break_minutes` arithmetic —
 * lunch is deducted from paid time, short and personal are not — and the
 * `clock_status` update moved into SQL unchanged (Requirement 3.12).
 *
 * The unconditional `set_my_availability('available')` is gone. Break end now
 * restores exactly the status recorded when the break started: Available restores
 * Available, Unavailable restores Unavailable, and a break with nothing recorded
 * falls back to Unavailable with `Join Sales Queues` offered (Requirements 2.5,
 * 2.6).
 *
 * A retried or concurrent break end is answered with the committed state and
 * `already_applied: true` rather than HTTP 400 (Requirements 2.10, 1.11).
 */
export async function PATCH() {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data, error } = await supabase.rpc("attendance_break_end");

  if (error) {
    return Response.json(await attendanceFailureBody(supabase, user.id, error), { status: 400 });
  }

  const payload = asAttendancePayload(data);
  if (!payload) {
    return Response.json({ error: "The break did not report a state." }, { status: 500 });
  }

  const answer = closedActionAnswer(payload, {
    duration_minutes: payload.duration_minutes ?? null,
    break: payload.break,
  });
  return Response.json(answer.body, { status: answer.status });
}

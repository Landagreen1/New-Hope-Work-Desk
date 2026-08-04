import {
  asAttendancePayload,
  attendanceFailureBody,
  closedActionAnswer,
  openedActionAnswer,
} from "@/features/time-attendance/server/attendance-rpc";
import { canAdministerAttendance } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/time-clock
 * Get current user's clock entries (or all for managers).
 * Query params: ?profile_id=...&date=YYYY-MM-DD&range=week|month
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  const canAdminister = canAdministerAttendance(profile?.role);

  const { searchParams } = new URL(request.url);
  const requestedProfileId = searchParams.get("profile_id");
  const profileId = canAdminister ? requestedProfileId : user.id;
  const date = searchParams.get("date");
  const range = searchParams.get("range") || "week";

  // Determine date range
  const now = new Date();
  let startDate: string;
  let endDate: string;

  if (date) {
    const d = new Date(date + "T00:00:00");
    if (range === "month") {
      startDate = new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
      endDate = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).toISOString();
    } else {
      // Week: go back to Monday
      const day = d.getDay();
      const diff = day === 0 ? 6 : day - 1;
      const monday = new Date(d);
      monday.setDate(d.getDate() - diff);
      startDate = monday.toISOString();
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      sunday.setHours(23, 59, 59);
      endDate = sunday.toISOString();
    }
  } else {
    // Default: current week
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - diff);
    monday.setHours(0, 0, 0, 0);
    startDate = monday.toISOString();
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59);
    endDate = sunday.toISOString();
  }

  let query = supabase
    .from("time_clock_entries")
    .select("*, profiles!time_clock_entries_profile_id_fkey(display_name, initials, role)")
    .gte("clock_in", startDate)
    .lte("clock_in", endDate)
    .order("clock_in", { ascending: false });

  if (profileId) {
    query = query.eq("profile_id", profileId);
  }

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 400 });

  return Response.json({ entries: data ?? [] });
}

/**
 * POST /api/time-clock
 * Clock in. Body: { status?: 'available' | 'lunch' | 'unavailable' }
 *
 * One RPC into `public.attendance_clock_in`, which owns the whole transaction.
 * The one-open-entry rule is still enforced by `uniq_time_clock_open_entry`
 * rather than by a select-then-insert check; the unique-violation branch moved
 * into SQL, and the loser of the race is still answered with the open entry it
 * lost to as a success with `already_open: true` (Requirement 3.13).
 *
 * Clock-in never changes sales-queue status, in either mode. What changes here is
 * disclosure: the response carries the queue status read back from the database
 * and offers the explicit `Join Sales Queues` action when the employee is at work
 * but not receiving sales work (Requirements 2.1, 2.18).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* empty body ok */ }

  const status = String(body.status ?? "available");
  if (!["available", "lunch", "unavailable"].includes(status)) {
    return Response.json({ error: "Invalid status." }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("attendance_clock_in", { p_status: status });

  // Requirement 2.7: every RPC result is inspected, and a failure names the
  // portion that failed with both statuses as the database holds them.
  if (error) {
    return Response.json(await attendanceFailureBody(supabase, user.id, error), { status: 400 });
  }

  const payload = asAttendancePayload(data);
  if (!payload) {
    return Response.json(
      { error: "The clock-in did not report a state." },
      { status: 500 },
    );
  }

  const answer = openedActionAnswer(payload, "entry");
  return Response.json(answer.body, { status: answer.status });
}

/**
 * PATCH /api/time-clock
 * Clock out or edit an entry. Body: { action: 'clock_out' | 'edit', ... }
 *
 * `clock_out` is one RPC into `public.attendance_clock_out`. The manual
 * break-closing update, the `total_hours` arithmetic and the availability call
 * all moved into SQL, and the `if (onBreak)` condition that used to gate the
 * availability write is gone: clock-out removes an `attendance_assisted` agent
 * from the sales queues whether or not a break was open (Requirement 2.2).
 *
 * A retried or concurrent clock-out is answered with the committed state and
 * `already_applied: true` rather than the HTTP 400 it used to produce
 * (Requirements 2.10, 1.11).
 *
 * `action: 'edit'` is untouched. It writes no availability today and must not
 * start (Requirement 3.11).
 */
export async function PATCH(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const action = String(body.action ?? "");

  // Admin edit: adjust any clock entry by ID — handle before active entry check
  if (action === "edit") {
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (!canAdministerAttendance(profile?.role)) {
      return Response.json({ error: "Only super admins can edit clock entries." }, { status: 403 });
    }

    const entryId = String(body.entry_id ?? "");
    if (!entryId) return Response.json({ error: "entry_id is required." }, { status: 400 });

    const adjustmentReason = String(body.adjustment_reason ?? "").trim();
    if (!adjustmentReason) return Response.json({ error: "adjustment_reason is required." }, { status: 400 });

    const updates: Record<string, unknown> = {
      adjusted_by: user.id,
      adjustment_reason: adjustmentReason,
    };

    if (body.clock_in) updates.clock_in = body.clock_in;
    if (body.clock_out) updates.clock_out = body.clock_out;
    if (body.break_minutes !== undefined) updates.break_minutes = Number(body.break_minutes);

    // Recalculate total_hours if clock_in and clock_out are both known
    const { data: entry } = await supabase
      .from("time_clock_entries")
      .select("clock_in, clock_out, break_minutes")
      .eq("id", entryId)
      .single();

    if (!entry) return Response.json({ error: "Entry not found." }, { status: 404 });

    const finalClockIn = (updates.clock_in ?? entry.clock_in) as string;
    const finalClockOut = (updates.clock_out ?? entry.clock_out) as string | null;
    const finalBreakMin = (updates.break_minutes ?? entry.break_minutes ?? 0) as number;

    if (finalClockIn && finalClockOut) {
      const totalMinutes = (new Date(finalClockOut).getTime() - new Date(finalClockIn).getTime()) / 60000;
      const workMinutes = totalMinutes - finalBreakMin;
      updates.total_hours = Math.round((workMinutes / 60) * 100) / 100;
    }

    const { error } = await supabase
      .from("time_clock_entries")
      .update(updates)
      .eq("id", entryId);

    if (error) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ success: true });
  }

  if (action === "clock_out") {
    const { data, error } = await supabase.rpc("attendance_clock_out");

    if (error) {
      return Response.json(await attendanceFailureBody(supabase, user.id, error), { status: 400 });
    }

    const payload = asAttendancePayload(data);
    if (!payload) {
      return Response.json({ error: "The clock-out did not report a state." }, { status: 500 });
    }

    const answer = closedActionAnswer(payload, {
      total_hours: payload.total_hours,
      entry: payload.entry,
    });
    return Response.json(answer.body, { status: answer.status });
  }

  return Response.json({ error: "Invalid action. Use 'clock_out' or 'edit'." }, { status: 400 });
}

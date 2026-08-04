import { readStatusSnapshot } from "@/features/time-attendance/server/attendance-rpc";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/time-clock/active
 * The current user's active clock entry (if clocked in), active break, and both
 * statuses.
 *
 * Attendance status and sales-queue status are two different facts, so this read
 * answers both: `attendance_status` for the `Attendance:` label and
 * `queue_status`, `queue_status_mode` and `is_agent` for the `Sales Queues:`
 * label. Every panel then renders two labelled values from a database read rather
 * than from an assumption, and the bare word `Available` never has to stand alone
 * (Requirements 2.14, 2.18).
 *
 * `clocked_in`, `entry` and `active_break` keep their existing shape.
 */
export async function GET() {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const snapshot = await readStatusSnapshot(supabase, user.id);

  return Response.json({
    clocked_in: snapshot.clocked_in,
    entry: snapshot.entry,
    active_break: snapshot.active_break,
    attendance_status: snapshot.attendance_status,
    queue_status: snapshot.queue_status,
    queue_status_mode: snapshot.queue_status_mode,
    is_agent: snapshot.is_agent,
  });
}

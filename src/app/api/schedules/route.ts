import { canAdministerAttendance } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/schedules
 * Get schedules. Query params: ?profile_id=...&week=YYYY-MM-DD
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
  const week = searchParams.get("week"); // Monday of the week
  const monthStart = searchParams.get("month_start");
  const monthEnd = searchParams.get("month_end");

  let query = supabase
    .from("employee_schedules")
    .select("*, profiles!employee_schedules_profile_id_fkey(display_name, initials, role, timezone)")
    .order("schedule_date", { ascending: true })
    .order("shift_start", { ascending: true });

  if (profileId) {
    query = query.eq("profile_id", profileId);
  }

  if (monthStart && monthEnd) {
    // Monthly calendar range
    query = query.gte("schedule_date", monthStart);
    query = query.lte("schedule_date", monthEnd);
  } else if (week) {
    const start = new Date(week + "T00:00:00");
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    query = query.gte("schedule_date", start.toISOString().split("T")[0]);
    query = query.lte("schedule_date", end.toISOString().split("T")[0]);
  }

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 400 });

  return Response.json({ schedules: data ?? [] });
}

/** The most shifts one POST may carry: a full roster on a seven-day template. */
const MAX_BATCH_ROWS = 500;

/** A row as `employee_schedules` stores it. */
interface ScheduleRow {
  profile_id: string;
  schedule_date: string;
  shift_start: string;
  shift_end: string;
  shift_type: unknown;
  status: string;
  notes: unknown;
  created_by: string;
}

/**
 * One body entry as a row, or the reason it cannot be one.
 *
 * `label` names which entry of a batch this is, so a refusal points at the shift
 * that caused it rather than at the request as a whole. It is null for a
 * single-object body, where there is only one shift to point at and the message
 * stays the one that route has always returned.
 */
function readScheduleRow(
  entry: unknown,
  label: string | null,
  createdBy: string,
): { row: ScheduleRow } | { error: string } {
  const prefix = label === null ? "" : `${label}: `;

  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { error: `${label ?? "The request body"} must be an object naming one shift.` };
  }

  const body = entry as Record<string, unknown>;
  const profileId = String(body.profile_id ?? "");
  const scheduleDate = String(body.schedule_date ?? "");
  const shiftStart = String(body.shift_start ?? "");
  const shiftEnd = String(body.shift_end ?? "");

  if (!profileId || !scheduleDate || !shiftStart || !shiftEnd) {
    return {
      error: `${prefix}profile_id, schedule_date, shift_start, and shift_end are required.`,
    };
  }

  return {
    row: {
      profile_id: profileId,
      schedule_date: scheduleDate,
      shift_start: shiftStart,
      shift_end: shiftEnd,
      shift_type: body.shift_type ?? "regular",
      status: "published",
      notes: body.notes ?? null,
      created_by: createdBy,
    },
  };
}

/**
 * POST /api/schedules
 * Create or replace schedule entries (super admin only).
 *
 * Body: one object, or an array of them — the one route in the module that accepts
 * an array body (Requirement 20, criterion 7). Applying a schedule template writes
 * one row per employee per shift, and sending those as N requests made a partial
 * application the normal result of any interruption. An array is one upsert, so
 * every row lands or none does, and the reply carries the ids of the rows written.
 *
 * Object: { profile_id, schedule_date, shift_start, shift_end, shift_type?, notes? }
 * Reply for an object: { id }. For an array: { ids, created }.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!canAdministerAttendance(profile?.role)) {
    return Response.json({ error: "Only super admins can create schedules." }, { status: 403 });
  }

  let parsed: unknown;
  try { parsed = await request.json(); } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const batch = Array.isArray(parsed);
  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  if (entries.length === 0) {
    return Response.json({ error: "The request body must name at least one shift." }, { status: 400 });
  }
  if (entries.length > MAX_BATCH_ROWS) {
    return Response.json(
      { error: `A single request carries at most ${MAX_BATCH_ROWS} shifts; this one carried ${entries.length}.` },
      { status: 400 },
    );
  }

  const rows: ScheduleRow[] = [];
  for (const [index, entry] of entries.entries()) {
    const read = readScheduleRow(entry, batch ? `Shift ${index + 1}` : null, user.id);
    // Reported, never dropped: an administrator who submitted forty shifts and
    // silently got thirty-nine would have no way to tell which one is missing.
    if ("error" in read) return Response.json({ error: read.error }, { status: 400 });
    rows.push(read.row);
  }

  // One employee and date can appear only once in the statement: Postgres refuses
  // an upsert that would touch the same conflict target twice. The last entry wins,
  // which is what a second entry for the same cell means.
  const byCell = new Map<string, ScheduleRow>();
  for (const row of rows) byCell.set(`${row.profile_id}|${row.schedule_date}`, row);

  const { data, error } = await supabase
    .from("employee_schedules")
    .upsert(Array.from(byCell.values()), { onConflict: "profile_id,schedule_date" })
    .select("id");

  if (error) return Response.json({ error: error.message }, { status: 400 });

  const ids = (data ?? []).map((row) => row.id as string);
  if (batch) return Response.json({ ids, created: ids.length }, { status: 201 });

  const id = ids[0];
  if (id === undefined) return Response.json({ error: "The shift could not be saved." }, { status: 400 });
  return Response.json({ id }, { status: 201 });
}

/**
 * DELETE /api/schedules
 * Delete a schedule entry (super admin only).
 * Body: { schedule_id }
 */
export async function DELETE(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!canAdministerAttendance(profile?.role)) {
    return Response.json({ error: "Only super admins can delete schedules." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const scheduleId = String(body.schedule_id ?? "");
  if (!scheduleId) return Response.json({ error: "schedule_id is required." }, { status: 400 });

  const { error } = await supabase
    .from("employee_schedules")
    .delete()
    .eq("id", scheduleId);

  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ success: true });
}
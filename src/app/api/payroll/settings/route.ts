// src/app/api/payroll/settings/route.ts
// GET  /api/payroll/settings?profile_id=...  read one employee's pay settings
// POST /api/payroll/settings                 write them, super_admin only
//
// ## What GET used to answer, and why it was wrong
//
// Two behaviours, recorded in Appendix A.2 of the requirements, made this read
// dishonest. It silently rewrote the request — a non-administrator asking about a
// colleague had `profile_id` replaced with their own id — and then, when no row
// came back, it substituted a hardcoded object: `biweekly`, `hourly`, a null
// rate, a 1.5 multiplier, a 40-hour threshold. Together those answered
// `?profile_id=<somebody-else>` with plausible-looking empty settings, at 200.
// The caller could not tell that from "that employee is paid nothing yet", and
// neither reading was true.
//
// ## What it answers now
//
// | Request                                       | Answer                              |
// | --------------------------------------------- | ----------------------------------- |
// | No Supabase configuration                     | 503                                 |
// | No session                                    | 401                                 |
// | A role the module cannot name                 | 403 `not_authorised`                |
// | `profile_id` that is not an identifier        | 400 `invalid_parameter`             |
// | Somebody else, without administration         | 403 `not_visible`                   |
// | Self, or anybody as an administrator, row     | 200 `{ settings: <row> }`           |
// | Self, or anybody as an administrator, no row  | 200 `{ settings: null }`            |
// | The read itself failed                        | 500 `read_failed`                   |
//
// The authorisation failure Requirement 21, criterion 15 asks for lands on the
// row that used to be answered with a fabricated default: naming an employee you
// may not see. That is the only one of the two ambiguous cases that is an
// authorisation question at all.
//
// ## Why an unconfigured employee is a 200 with an explicit null
//
// `v1.9.2-attendance-reads.sql` added `payment_settings_own_select`, so an
// employee can now genuinely read their own `employee_payment_settings` row.
// That changes what an empty result means: it is no longer "row level security
// refused you", it is "no row exists yet". A request for your own settings is
// inside your permitted set, the module performed it, and the complete and
// truthful answer is that nothing is configured. Requirement 21, criterion 15
// governs requests *outside* the permitted set; answering this one with a 403
// would report a permitted read as a refusal and send the employee to ask for
// access they already hold.
//
// A 404 is the other defensible answer and is not taken, for two reasons. The
// shared failure contract in `server/api-response.ts` has six shapes and none of
// them is not-found; inventing a seventh for one route is what the single
// contract exists to prevent. And an employee whose pay has not been set up yet
// is an ordinary, expected state — a new hire before an administrator opens the
// Workforce screen — not an error every consumer has to special-case. An explicit
// `null` says the same thing inside the contract that already exists, and
// `PayrollDashboard` already branches on it: a null `settings` renders "Payment
// settings not configured. Contact your manager." in place of the rate card.
//
// One residual ambiguity is worth recording rather than discovering later. If
// `v1.9.2` is ever rolled back, a self-read returns no rows again, and this route
// cannot distinguish that from an absent row — a policy hides rows by returning
// none, not by raising. It would then report `{ settings: null }` where the
// honest answer is a refusal. Nothing in the request tells the two apart without
// elevated credentials, which a per-caller read must not hold, so the rollback
// note in the migration header is where that link is kept.
//
// ## POST is untouched
//
// Writing pay settings stays `super_admin`-only through
// `canAdministerAttendance`, per Requirement 21, criteria 6 and 12. It keeps its
// own preamble and its own response bodies deliberately: this task changes what a
// read answers, and moving the write onto the shared contract at the same time
// would put an unrelated status change in the same commit.
//
// Requirements: 21.6, 21.12, 21.13, 21.15, 22.16

import { canAdministerAttendance } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import {
  refuseInvisibleProfiles,
  resolveActor,
} from "@/features/time-attendance/server/api-actor";
import {
  apiOk,
  failed,
  serviceFailure,
} from "@/features/time-attendance/server/api-response";
import { optionalProfileId } from "@/features/time-attendance/server/request-query";

export const runtime = "nodejs";

/**
 * Stated when the pay-settings read itself failed.
 *
 * Not the driver's message: an invalid-uuid or connection message is written for
 * a maintainer, and the exception goes to the server log where one can read it.
 * Names no employee, so a failure cannot confirm who exists.
 */
const SETTINGS_UNREADABLE_MESSAGE =
  "Those pay settings could not be read. Retrying may succeed.";

/**
 * GET /api/payroll/settings?profile_id=...
 *
 * `profile_id` is optional and defaults to the signed-in user. An employee may
 * name only themselves; an administrator may name anybody.
 *
 * Requirements: 21.13, 21.15, 22.16
 */
export async function GET(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const { searchParams } = new URL(request.url);
    const requested = optionalProfileId(searchParams, "profile_id");

    // Refused, not silently rewritten to the caller's own id. Rewriting answers
    // a question the caller did not ask, and answers it at 200.
    const refusal = await refuseInvisibleProfiles(
      resolved.actor,
      requested === undefined ? undefined : [requested],
    );
    if (refusal !== null) return refusal;

    const profileId = requested ?? resolved.actor.id;

    const { data, error } = await resolved.client
      .from("employee_payment_settings")
      .select("*")
      .eq("profile_id", profileId)
      .maybeSingle();

    // A failed read is not an empty result. Row level security answers an
    // unpermitted read with no rows rather than with an error, so this branch is
    // a genuine fault the caller may retry.
    if (error) {
      console.error("[time-attendance] pay settings read failed", error);
      return failed("read_failed", SETTINGS_UNREADABLE_MESSAGE);
    }

    // `null` states that no row is configured. Nothing is invented in its place.
    return apiOk({ settings: data ?? null });
  } catch (error) {
    return serviceFailure(error);
  }
}

/**
 * POST /api/payroll/settings
 * Create or update payment settings (super admin only).
 * Body: { profile_id, payment_template, hourly_rate, salary_amount, pay_type, ... }
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!canAdministerAttendance(profile?.role)) {
    return Response.json({ error: "Only super admins can update payment settings." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const profileId = String(body.profile_id ?? "");
  if (!profileId) return Response.json({ error: "profile_id is required." }, { status: 400 });

  const { data, error } = await supabase
    .from("employee_payment_settings")
    .upsert({
      profile_id: profileId,
      payment_template: body.payment_template ?? "biweekly",
      hourly_rate: body.hourly_rate ?? null,
      salary_amount: body.salary_amount ?? null,
      pay_type: body.pay_type ?? "hourly",
      overtime_multiplier: body.overtime_multiplier ?? 1.5,
      weekly_overtime_threshold: body.weekly_overtime_threshold ?? 40,
      daily_overtime_threshold: body.daily_overtime_threshold ?? null,
      deductions: body.deductions ?? [],
    }, { onConflict: "profile_id" })
    .select("id")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ id: data.id });
}

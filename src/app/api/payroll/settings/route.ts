import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/payroll/settings
 * Get payment settings for a user. Query: ?profile_id=...
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const profileId = searchParams.get("profile_id") || user.id;

  const { data, error } = await supabase
    .from("employee_payment_settings")
    .select("*")
    .eq("profile_id", profileId)
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 400 });

  // Return defaults if no settings exist
  const settings = data ?? {
    profile_id: profileId,
    payment_template: "biweekly",
    hourly_rate: null,
    salary_amount: null,
    pay_type: "hourly",
    overtime_multiplier: 1.5,
    weekly_overtime_threshold: 40,
    daily_overtime_threshold: null,
    deductions: [],
  };

  return Response.json({ settings });
}

/**
 * POST /api/payroll/settings
 * Create or update payment settings (manager only).
 * Body: { profile_id, payment_template, hourly_rate, salary_amount, pay_type, ... }
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "manager" && profile?.role !== "super_admin") {
    return Response.json({ error: "Only managers and super admins can update payment settings." }, { status: 403 });
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
